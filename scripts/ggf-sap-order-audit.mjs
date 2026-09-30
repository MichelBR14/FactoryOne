import { build } from "esbuild";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openReadSession } from "./ggf-sap-session.mjs";

const [start, end] = process.argv.slice(2);
if (!start || !end) throw new Error("Usage: npm run ggf:sap:orders -- YYYY-MM-DD YYYY-MM-DD");
await mkdir(".local/ggf", { recursive: true, mode: 0o700 });
await rm(".local/ggf/order-audit-source.json", { force: true });
await rm(".local/ggf/order-audit-report.json", { force: true });
const output = ".local/ggf/order-audit-runtime.mjs";
await build({
  entryPoints: ["webapp/modules/ggf/repository/SapB1OrderAudit.ts"],
  outfile: output,
  platform: "node",
  format: "esm",
  bundle: true
});
const { readOrderAuditData, analyzeOrderAudit } = await import(pathToFileURL(resolve(output)).href);
const session = await openReadSession();
try {
  const result = await readOrderAuditData(
    {
      async get(path) {
        const response = await session.get(path, { Prefer: "odata.maxpagesize=20" });
        if (!response.ok) throw new Error(`Read rejected: HTTP ${response.status}`);
        return response.data;
      }
    },
    { start, end, branch: "", costCenter: "" }
  );
  await writeFile(
    ".local/ggf/order-audit-source.json",
    JSON.stringify({ ...result, company: session.info.company }, null, 2),
    { mode: 0o600 }
  );
  const report = { ...analyzeOrderAudit(result), company: session.info.company };
  await writeFile(".local/ggf/order-audit-report.json", JSON.stringify(report, null, 2), {
    mode: 0o600
  });
  console.log(
    JSON.stringify(
      {
        company: report.company,
        orders: report.orders.map((o) => ({
          entry: o.entry,
          number: o.number,
          quantity: o.receiptQuantityInPeriod,
          materials: o.issuedItemLineTotals,
          resources: o.issuedResourceLineTotals,
          receipts: o.receivedLineTotals,
          difference: o.issuesMinusReceipts,
          findings: o.findings
        })),
        timeSheets: report.timeSheets,
        differences: report.structuralDifferences
      },
      null,
      2
    )
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Order audit failed");
  process.exitCode = 1;
} finally {
  await session.close();
}
