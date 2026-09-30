import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openReadSession, AUTHORIZED_COMPANY } from "./ggf-sap-session.mjs";
import {
  readScope,
  rejectContinuation,
  summarizeJournals
} from "./ggf-functional-diagnostic-lib.mjs";

// Fixed approved scope. This supplements, and never reruns, the completed order audit.
const baselineFile = ".local/ggf/order-audit-source.json";
const baselineBytes = await readFile(baselineFile);
const baseline = JSON.parse(baselineBytes);
if (
  baseline.company !== AUTHORIZED_COMPANY ||
  baseline.filter.start !== "2026-09-01" ||
  baseline.filter.end !== "2026-09-30" ||
  baseline.filter.branch ||
  baseline.filter.costCenter ||
  baseline.orders
    .map((o) => `${o.AbsoluteEntry}/${o.DocumentNumber}`)
    .sort()
    .join(",") !== "203/76,204/77,206/79"
)
  throw new Error("Approved September order evidence required");
const runtime = ".local/ggf/functional-runtime.mjs";
await mkdir(".local/ggf", { recursive: true, mode: 0o700 });
for (const name of ["functional-source", "functional-report"])
  await rm(`.local/ggf/${name}.json`, { force: true });
await build({
  stdin: {
    contents:
      'export { MappedGgfSource } from "./webapp/modules/ggf/repository/MappedGgfSource"; export { defineSapRead } from "./webapp/modules/ggf/repository/SapB1ReadMapping";',
    resolveDir: process.cwd(),
    loader: "ts"
  },
  outfile: runtime,
  platform: "node",
  format: "esm",
  bundle: true
});
const { MappedGgfSource, defineSapRead } = await import(pathToFileURL(resolve(runtime)).href);
const session = await openReadSession();
try {
  const queries = [];
  const client = {
    async get(path) {
      queries.push(path);
      const response = await session.get(path, { Prefer: "odata.maxpagesize=20" });
      if (!response.ok) throw new Error(`Supplementary read rejected: HTTP ${response.status}`);
      return response.data;
    }
  };
  const definitions = [
    defineSapRead(
      "JournalEntries",
      "JdtNum",
      "balances",
      "JdtNum,ReferenceDate,OriginalJournal,Original,BaseReference,JournalEntryLines",
      "ReferenceDate ge '2026-09-01' and ReferenceDate le '2026-09-30'"
    ),
    defineSapRead(
      "ChartOfAccounts",
      "Code",
      "balances",
      "Code,Name,AccountType,AcctCurrency,ActiveAccount,FatherAccountKey,CostElementCode,LoadingFactorCode,LoadingFactorCode2,LoadingFactorCode3,LoadingFactorCode4,LoadingFactorCode5"
    ),
    defineSapRead(
      "Dimensions",
      "DimensionCode",
      "balances",
      "DimensionCode,DimensionName,IsActive"
    ),
    defineSapRead(
      "ProfitCenters",
      "CenterCode",
      "balances",
      "CenterCode,CenterName,InWhichDimension,Active"
    ),
    defineSapRead(
      "DistributionRules",
      "FactorCode",
      "balances",
      "FactorCode,FactorDescription,TotalFactor,Direct,InWhichDimension,Active,DistributionRuleLines"
    ),
    defineSapRead("BusinessPlaces", "BPLID", "balances", "BPLID,BPLName"),
    defineSapRead(
      "WeightMeasures",
      "UnitCode",
      "production",
      "UnitCode,UnitDisplay,UnitName,UnitWeightinmg"
    )
  ];
  const source = new MappedGgfSource(client, {
    reads: () => definitions,
    normalize() {
      throw new Error("Diagnostic only");
    }
  });
  const { rows, evidence } = await source.inspectSources(baseline.filter, definitions);
  for (const values of rows.values()) values.forEach(rejectContinuation);
  const pointReads = [];
  const point = async (path, key, expected) => {
    const record = await client.get(path);
    rejectContinuation(record);
    if (record?.[key] !== expected) throw new Error("Supplementary identity mismatch");
    pointReads.push({ path, key, expected });
    return record;
  };
  const literal = (value) => `'${encodeURIComponent(value.replace(/'/g, "''"))}'`;
  const codes = [
    ...new Set(
      baseline.movements
        .flatMap((m) => m.document.DocumentLines)
        .filter((l) => l.ItemType === "dit_Resource")
        .map((l) => l.ItemCode)
    )
  ].sort();
  const resources = [];
  for (const code of codes)
    resources.push(
      await point(
        `Resources(${literal(code)})?$select=Code,Name,Type,Group,UnitOfMeasure,IssueMethod,Cost1,Cost2,Cost3,Cost4,Cost5,Cost6,Cost7,Cost8,Cost9,Cost10,DefaultWarehouse,Remarks,UnitsPerTime,TimePerUnits,Allocation,LinkedItem,ResourceFixedAssets,ResourceEmployees,ResourceWarehouses`,
        "Code",
        code
      )
    );
  const groups = [];
  for (const code of new Set(resources.map((r) => r.Group)))
    groups.push(await point(`ResourceGroups(${code})`, "Code", code));
  const items = [];
  for (const code of new Set(baseline.orders.map((o) => o.ItemNo)))
    items.push(
      await point(
        `Items(${literal(code)})?$select=ItemCode,ItemName,InventoryUOM,InventoryWeight,InventoryWeightUnit,InventoryWeight1,InventoryWeightUnit1,SalesUnitWeight,SalesWeightUnit,PurchaseUnitWeight,PurchaseWeightUnit`,
        "ItemCode",
        code
      )
    );
  // Stability check of the supplementary ledger, not a repeat of the order audit.
  const canonical = (value) =>
    JSON.stringify(value, function (key, child) {
      if (key.startsWith("@odata.")) return undefined;
      if (child && typeof child === "object" && !Array.isArray(child))
        return Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b)));
      return child;
    });
  for (const journal of rows.get("JournalEntries")) {
    const detail = await point(
      `JournalEntries(${journal.JdtNum})?$select=JdtNum,ReferenceDate,OriginalJournal,Original,BaseReference,JournalEntryLines`,
      "JdtNum",
      journal.JdtNum
    );
    if (canonical(detail) !== canonical(journal))
      throw new Error("Supplementary ledger changed during read");
  }
  for (const definition of definitions) {
    const control = definition.decodeControl(await client.get(definition.controlPath));
    if (control.expectedRows !== rows.get(definition.id).length)
      throw new Error("Supplementary count changed");
  }
  const data = {
    company: session.info.company,
    connection: session.info,
    capturedAt: new Date().toISOString(),
    filter: baseline.filter,
    baseline: {
      file: baselineFile,
      capturedAt: baseline.capturedAt,
      sha256: createHash("sha256").update(baselineBytes).digest("hex")
    },
    allocationReady: false,
    postingBlocked: true,
    queries,
    pointReads,
    reads: evidence.map(({ filter, ...read }) => ({ ...read, scope: readScope(read) })),
    collections: Object.fromEntries(rows),
    resources,
    groups,
    items
  };
  const report = {
    company: data.company,
    capturedAt: data.capturedAt,
    baseline: data.baseline,
    ...summarizeJournals(
      rows.get("JournalEntries"),
      rows.get("ChartOfAccounts"),
      baseline.filter.start,
      baseline.filter.end
    )
  };
  await writeFile(".local/ggf/functional-source.json", JSON.stringify(data, null, 2), {
    mode: 0o600
  });
  await writeFile(".local/ggf/functional-report.json", JSON.stringify(report, null, 2), {
    mode: 0o600
  });
  console.log(
    JSON.stringify(
      {
        company: data.company,
        journals: report.journalCount,
        lines: report.lineCount,
        debit: report.debit,
        credit: report.credit,
        accountScopes: report.accounts.length,
        resources: codes,
        baselineReused: true,
        postingBlocked: true
      },
      null,
      2
    )
  );
} finally {
  await session.close();
}
