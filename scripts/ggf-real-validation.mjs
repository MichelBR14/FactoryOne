import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, sep, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { build } from "esbuild";
import { openReadSession } from "./ggf-sap-session.mjs";

const replay = process.argv[2] === "--replay";
const input = process.argv[replay ? 3 : 2];
if (!input || !resolve(input).startsWith(resolve(".local/ggf") + sep))
  throw new Error(
    "Use a local .local/ggf request JSON, or --replay source JSON",
  );
const inputText = await readFile(input, "utf8");
let saved;
try {
  saved = JSON.parse(inputText);
} catch {
  throw new Error("Invalid local JSON (contents withheld)");
}
const request = replay ? saved.request : saved;
if (
  request.company !== "SBODEMOBR2" ||
  request.purpose !== "CONTA DE VALIDACAO TECNICA - NAO GGF FUNCIONAL" ||
  request.account === "4.01.01.04.07" ||
  !request.percent ||
  !request.scenarios?.length ||
  request.scenarios.some(
    (s) =>
      !["DIRECT_COST", "QUANTITY"].includes(s.criterion) ||
      !/^[a-z-]+$/.test(s.id),
  ) ||
  new Set(request.scenarios.map((s) => s.id)).size !== request.scenarios.length
)
  throw new Error(
    "Explicit technical-only scope required; resource absorption account excluded",
  );
const directory = join(
  ".local/ggf",
  `real-rateio-${new Date().toISOString().replaceAll(/[:.]/g, "-")}${replay ? "-replay" : ""}`,
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const json = (value) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? String(v) : v), 2);
const save = (name, value) =>
  writeFile(join(directory, name), json(value), { mode: 0o600 });
await save("request.json", request);
const runtime = join(directory, "runtime.mjs");
await build({
  stdin: {
    contents: `
export { SapGgfCalculationSource } from "./webapp/modules/ggf/repository/SapGgfCalculationSource";
export { ClosingSession } from "./webapp/modules/ggf/service/ClosingSession";
export { exportCsv } from "./webapp/modules/ggf/service/export";
`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  outfile: runtime,
  platform: "node",
  format: "esm",
  bundle: true,
});
const { SapGgfCalculationSource, ClosingSession, exportCsv } = await import(
  pathToFileURL(resolve(runtime)).href
);
const codeHashes = {};
for (const file of [
  "scripts/ggf-real-validation.mjs",
  "scripts/ggf-independent-check.py",
  "webapp/modules/ggf/engine/allocation.ts",
  "webapp/modules/ggf/engine/sourceEvidence.ts",
  "webapp/core/util/money.ts",
  "webapp/modules/ggf/repository/SapGgfCalculationSource.ts",
  "webapp/modules/ggf/service/ClosingSession.ts",
])
  codeHashes[file] = createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
await save("code-hashes.json", codeHashes);
const connection = replay ? null : await openReadSession();
const scenarios = replay
  ? request.scenarios.filter((s) => s.id === saved.scenario.id)
  : request.scenarios;
if (replay && scenarios.length !== 1)
  throw new Error("Replay scenario must belong to the original request");
const summaries = [];
try {
  for (const scenario of scenarios) {
    const reads = [];
    const capture = {
      request,
      scenario,
      sourceMode: replay ? "replay" : "live",
      capturedAt: replay ? saved.capturedAt : new Date().toISOString(),
      ...(replay
        ? {
            replayedSourceHash: createHash("sha256")
              .update(inputText)
              .digest("hex"),
            replayedAt: new Date().toISOString(),
          }
        : {}),
      connection: replay ? saved.connection : connection.info,
      postingBlocked: true,
      functionalGgfApproved: false,
      reads,
    };
    let cursor = 0;
    const client = {
      async get(path) {
        let data,
          readAt = new Date().toISOString();
        if (replay) {
          const record = saved.reads[cursor++];
          if (!record || record.path !== path)
            throw new Error("Replay query sequence differs");
          data = structuredClone(record.data);
          readAt = record.readAt;
        } else {
          const response = await connection.get(path, {
            Prefer: "odata.maxpagesize=20",
          });
          if (!response.ok)
            throw new Error(`SAP read rejected HTTP ${response.status}`);
          data = response.data;
        }
        reads.push({ method: "GET", path, readAt, data });
        return data;
      },
    };
    try {
      const configuration = {
        classifications: [{ id: "TECHNICAL-ONLY", name: request.purpose }],
        accounts: [
          {
            account: request.account,
            name: request.description,
            percent: request.percent,
            classificationId: "TECHNICAL-ONLY",
            criterion: scenario.criterion,
            active: true,
          },
        ],
        groupShares: [],
      };
      const selection = {
        orderEntries: scenario.orderEntries,
        directCostPolicy: "DOCUMENTED_MATERIALS_AND_RESOURCES",
      };
      const session = new ClosingSession(
        new SapGgfCalculationSource(client, selection),
      );
      const result = await session.calculate(configuration, request.filter);
      if (!result) throw new Error("Calculation invalidated");
      // Re-read only documents contributing to the chosen balance/bases, with the same projection.
      const primary = [...reads];
      const points = [];
      for (const [entity, key] of [
        ["ChartOfAccounts", "Code"],
        ["JournalEntries", "JdtNum"],
        ["ProductionOrders", "AbsoluteEntry"],
        ["InventoryGenEntries", "DocEntry"],
        ["InventoryGenExits", "DocEntry"],
      ]) {
        const pages = primary.filter(
          (r) => r.path.startsWith(entity + "?") && Array.isArray(r.data.value),
        );
        const select = new URL(
          pages[0].path,
          "https://read.invalid/",
        ).searchParams.get("$select");
        for (const row of pages.flatMap((r) => r.data.value)) {
          const selected =
            entity === "ChartOfAccounts" ||
            entity === "ProductionOrders" ||
            (entity === "JournalEntries"
              ? row.JournalEntryLines.some(
                  (l) => l.AccountCode === request.account,
                )
              : row.DocumentLines.some(
                  (l) =>
                    l.BaseType === 202 &&
                    scenario.orderEntries.includes(l.BaseEntry),
                ));
          if (!selected) continue;
          const literal =
            typeof row[key] === "string"
              ? `'${row[key].replaceAll("'", "''")}'`
              : row[key];
          const path = `${entity}(${literal})?$select=${select}`;
          const detail = await client.get(path);
          const fields = select.split(",");
          if (
            !isDeepStrictEqual(
              fields.map((f) => row[f]),
              fields.map((f) => detail[f]),
            )
          )
            throw new Error(
              `Source changed during calculation: ${entity}(${literal})`,
            );
          points.push(path);
        }
      }
      if (replay && cursor !== saved.reads.length)
        throw new Error("Unused replay responses");
      capture.pointReads = points;
      capture.finishedAt = replay ? saved.finishedAt : new Date().toISOString();
      const sourceText = json(capture);
      const sourceHash = createHash("sha256").update(sourceText).digest("hex");
      await writeFile(
        join(directory, `${scenario.id}-source.json`),
        sourceText,
        { mode: 0o600 },
      );
      await save(`${scenario.id}-engine.json`, {
        company: request.company,
        purpose: request.purpose,
        sourceMode: capture.sourceMode,
        postingBlocked: true,
        functionalGgfApproved: false,
        sourceHash,
        result,
      });
      await writeFile(
        join(directory, `${scenario.id}-engine.csv`),
        exportCsv(result),
        { mode: 0o600 },
      );
      execFileSync(
        "python3",
        [
          "scripts/ggf-independent-check.py",
          join(directory, `${scenario.id}-source.json`),
          join(directory, `${scenario.id}-engine.json`),
          join(directory, `${scenario.id}-independent.json`),
          join(directory, `${scenario.id}-comparison.csv`),
        ],
        { stdio: "pipe" },
      );
      const check = JSON.parse(
        await readFile(
          join(directory, `${scenario.id}-independent.json`),
          "utf8",
        ),
      );
      summaries.push({
        scenario: scenario.id,
        passed: check.passed,
        ledgerMinor: check.ledger.netMinor,
        applicableMinor: check.applicableMinor,
        rows: check.comparison,
        differenceMinor: check.differenceMinor,
      });
      await save("summary.json", {
        directory,
        request,
        sourceMode: capture.sourceMode,
        postingBlocked: true,
        scenarios: summaries,
      });
      console.log(json({ directory, ...summaries.at(-1) }));
      if (!check.passed)
        throw new Error("Independent comparison found differences");
    } catch (error) {
      await save(`${scenario.id}-interrupted-source.json`, capture);
      await save(`${scenario.id}-blocked.json`, {
        postingBlocked: true,
        passed: false,
        code: error.code ?? "validationInterrupted",
        details: error.details ?? [],
        message:
          "Read/calculation/independent verification interrupted; no validated result. Inspect local evidence.",
      });
      throw error;
    }
  }
} finally {
  if (connection) await connection.close();
}
