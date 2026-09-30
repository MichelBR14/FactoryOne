import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openReadSession } from "./ggf-sap-session.mjs";

const inputPath = process.argv[2] ?? ".local/ggf/v2-absorption-technical.json";
const reportPath = process.argv[3] ?? ".local/ggf/v2-absorption-technical-result.json";
const request = JSON.parse(await readFile(inputPath, "utf8"));
if (request.company !== "SBODEMOBR2" || request.mapping?.technicalHomologation !== true)
  throw new Error("Explicit SBODEMOBR2 technical homologation configuration required");

await mkdir(".local/ggf", { recursive: true, mode: 0o700 });
const runtimePath = ".local/ggf/v2-absorption-live-runtime.mjs";
await build({ stdin: { contents: `
export { readGgfV2Absorption } from "./webapp/modules/ggf/absorption/SapGgfAbsorptionSource.ts";
export { reconcileAbsorption } from "./webapp/modules/ggf/absorption/reconciliation.ts";
`, resolveDir: process.cwd() }, outfile: runtimePath, platform: "node", format: "esm", bundle: true });
const { readGgfV2Absorption, reconcileAbsorption } = await import(pathToFileURL(resolve(runtimePath)).href);

const session = await openReadSession();
let source;
let report;
try {
  const client = {
    async get(path) {
      const response = await session.get(path, { Prefer: "odata.maxpagesize=100" });
      if (!response.ok) throw new Error(`SAP GET rejected: HTTP ${response.status}`);
      return response.data;
    }
  };
  source = await readGgfV2Absorption(client, session.info.company, request.filter, request.mapping);
  report = reconcileAbsorption(source, request.mapping);
} finally { await session.close(); }

// Independent arithmetic, intentionally not implemented through the engine/report function.
const independent = ["MOD", "GGF"].map((category) => {
  const ledgerRows = source.journals.filter((line) => request.mapping.accounts.some((map) => map.account === line.account && map.category === category));
  const real = ledgerRows.reduce((sum, line) => sum + line.debitCents - line.creditCents, 0n);
  let absorbed = 0n;
  const detail = [];
  for (const movement of source.movements) {
    const resource = source.resources.find((row) => row.resource === movement.resource);
    const configRows = request.mapping.resources.filter((row) => row.resource === movement.resource && row.category === category);
    for (const config of configRows) {
      const unit = resource?.components.find((row) => row.component === config.component)?.unitCostCents;
      if (unit === undefined || !resource?.unit || resource.unit !== movement.unit) continue;
      const q = movement.direction === "RETURN" ? -movement.quantityMicros : movement.quantityMicros;
      const numerator = q * unit;
      const sign = numerator < 0n ? -1n : 1n;
      const absolute = numerator * sign;
      const rounded = (absolute / 1_000_000n) + ((absolute % 1_000_000n) * 2n >= 1_000_000n ? 1n : 0n);
      const amount = rounded * sign;
      absorbed += amount;
      detail.push({ resource: movement.resource, order: movement.order, component: config.component, amountCents: amount.toString() });
    }
  }
  const difference = real - absorbed;
  return { category, realCents: real.toString(), absorbedCents: absorbed.toString(), differenceCents: difference.toString(), detail };
});
const comparison = independent.map((row) => {
  const engine = report.reconciliation.find((item) => item.category === row.category);
  return {
    category: row.category,
    realMatches: engine?.realCents.toString() === row.realCents,
    absorbedMatches: engine?.absorbedCents.toString() === row.absorbedCents,
    differenceMatches: engine?.differenceCents.toString() === row.differenceCents,
    engine: engine && { realCents: engine.realCents.toString(), absorbedCents: engine.absorbedCents.toString(), differenceCents: engine.differenceCents.toString() },
    independent: row
  };
});
const result = {
  label: "HOMOLOGACAO TECNICA - classificacoes nao funcionais aprovadas",
  readOnly: true,
  company: session.info.company,
  connection: { version: session.info.version, basePath: session.info.basePath, tlsVerified: session.info.tlsVerified },
  source,
  report: { ...report, reconciliation: report.reconciliation.map((row) => ({ ...row, realCents: row.realCents.toString(), absorbedCents: row.absorbedCents.toString(), differenceCents: row.differenceCents.toString() })), accounts: report.accounts.map((row) => ({ ...row, debitCents: row.debitCents.toString(), creditCents: row.creditCents.toString(), realCents: row.realCents.toString(), entries: row.entries.map((line) => ({ ...line, debitCents: line.debitCents.toString(), creditCents: line.creditCents.toString() })) })), resources: report.resources.map((row) => ({ ...row, quantityMicros: row.quantityMicros.toString(), unitCostCents: row.unitCostCents.toString(), amountCents: row.amountCents.toString() })) },
  independent,
  comparison,
  mathPassed: comparison.every((row) => row.realMatches && row.absorbedMatches && row.differenceMatches)
};
await writeFile(reportPath, JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2), { mode: 0o600 });
const csv = [
  "category,kind,account,transId,document,date,resource,order,component,unit,base,real_cents,absorbed_cents,difference_cents",
  ...report.accounts.flatMap((account) => account.entries.map((line) => [account.category, "LEDGER", account.account, line.transId, line.document, line.date, "", "", "", "", "", line.debitCents - line.creditCents, "", ""].map(csvCell).join(","))),
  ...report.resources.map((row) => [row.category, "STANDARD_ABSORBED", "", "", row.document, row.date, row.resource, row.order, row.component, row.unit, row.quantityMicros, "", row.amountCents, ""].map(csvCell).join(",")),
  ...report.reconciliation.map((row) => [row.category, "RECONCILIATION", "", "", "", "", "", "", "", "", "", row.realCents, row.absorbedCents, row.differenceCents].map(csvCell).join(","))
].join("\n");
await writeFile(reportPath.replace(/\.json$/i, ".csv"), csv, { mode: 0o600 });
console.log(JSON.stringify({ company: result.company, period: request.filter, mathPassed: result.mathPassed, reconciliation: report.reconciliation.map((row) => ({ category: row.category, realCents: row.realCents.toString(), absorbedCents: row.absorbedCents.toString(), differenceCents: row.differenceCents.toString(), status: row.status })), blockers: report.blockers, files: [reportPath, reportPath.replace(/\.json$/i, ".csv")] }, null, 2));
if (!result.mathPassed) process.exitCode = 1;

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}
