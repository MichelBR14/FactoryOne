import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { openReadSession } from "./ggf-sap-session.mjs";

// Configuration stays local: no account or policy is selected by this command.
const requestPath = process.argv[2];
await mkdir(".local/ggf", { recursive: true, mode: 0o700 });
for (const name of [
  "calculation-result.json",
  "calculation-memory.csv",
  "calculation-blocked.json"
])
  await rm(`.local/ggf/${name}`, { force: true });
if (!requestPath || !resolve(requestPath).startsWith(resolve(".local/ggf") + sep))
  throw new Error("Usage: npm run ggf:sap:calculate -- .local/ggf/calculation-request.json");
let request;
try {
  request = JSON.parse(await readFile(requestPath, "utf8"));
} catch {
  throw new Error("Local calculation request is missing or invalid JSON (contents withheld)");
}
if (request.company !== "SBODEMOBR2") throw new Error("Authorized test company required");
const runtime = ".local/ggf/calculation-runtime.mjs";
await build({
  stdin: {
    contents: `
  export { SapGgfCalculationSource } from "./webapp/modules/ggf/repository/SapGgfCalculationSource";
  export { ClosingSession } from "./webapp/modules/ggf/service/ClosingSession";
  export { exportCsv } from "./webapp/modules/ggf/service/export";
  export { validateConfiguration, validatePeriod } from "./webapp/modules/ggf/engine/allocation";
`,
    resolveDir: process.cwd(),
    loader: "ts"
  },
  outfile: runtime,
  platform: "node",
  format: "esm",
  bundle: true
});
const {
  SapGgfCalculationSource,
  ClosingSession,
  exportCsv,
  validateConfiguration,
  validatePeriod
} = await import(pathToFileURL(resolve(runtime)).href);
validateConfiguration(request.configuration);
validatePeriod(request.filter);
const connection = await openReadSession();
try {
  const client = {
    async get(path) {
      const response = await connection.get(path, { Prefer: "odata.maxpagesize=20" });
      if (!response.ok) throw new Error(`SAP calculation read rejected: HTTP ${response.status}`);
      return response.data;
    }
  };
  const session = new ClosingSession(new SapGgfCalculationSource(client, request.selection));
  const result = await session.calculate(request.configuration, request.filter);
  const report = {
    company: connection.info.company,
    postingBlocked: true,
    validationOnly: true,
    result
  };
  await writeFile(
    ".local/ggf/calculation-result.json",
    JSON.stringify(report, (_, v) => (typeof v === "bigint" ? String(v) : v), 2),
    { mode: 0o600 }
  );
  await writeFile(".local/ggf/calculation-memory.csv", exportCsv(result), { mode: 0o600 });
  console.log(
    JSON.stringify(
      {
        company: connection.info.company,
        postingBlocked: true,
        snapshot: result.snapshot.id,
        accounts: result.accounts,
        orders: result.orders.map((o) => ({ order: o.order.number, allocated: o.allocated })),
        difference: result.difference
      },
      (_, v) => (typeof v === "bigint" ? String(v) : v),
      2
    )
  );
} catch (error) {
  const blocked = {
    company: connection.info.company,
    postingBlocked: true,
    message: "Base de rateio indisponível para o período.",
    code: error.code ?? "sourceRead",
    details: error.details ?? ["Read interrupted; no partial allocation published"]
  };
  await writeFile(".local/ggf/calculation-blocked.json", JSON.stringify(blocked, null, 2), {
    mode: 0o600
  });
  console.error(JSON.stringify(blocked, null, 2));
  process.exitCode = 1;
} finally {
  await connection.close();
}
