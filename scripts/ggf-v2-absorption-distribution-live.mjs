import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openReadSession } from "./ggf-sap-session.mjs";

const inputPath = process.argv[2] ?? ".local/ggf/v2-absorption-distribution-request.json";
const outputPath = process.argv[3] ?? ".local/ggf/v2-absorption-distribution-result.json";
const request = JSON.parse(await readFile(inputPath, "utf8"));
if (request.company !== "SBODEMOBR2" || request.mapping?.technicalHomologation !== true ||
    request.filter?.start !== "2026-09-01" || request.filter?.end !== "2026-09-30")
  throw new Error("Explicit SBODEMOBR2 September 2026 technical read configuration required");
await mkdir(".local/ggf", { recursive: true, mode: 0o700 });
const runtimePath = ".local/ggf/v2-absorption-distribution-runtime.mjs";
await build({ stdin: { contents: `
export { readGgfV2Absorption } from "./webapp/modules/ggf/absorption/SapGgfAbsorptionSource.ts";
export { reconcileAbsorption } from "./webapp/modules/ggf/absorption/reconciliation.ts";
export { calculateAbsorptionDistribution } from "./webapp/modules/ggf/absorption/distribution.ts";
`, resolveDir: process.cwd() }, outfile: runtimePath, platform: "node", format: "esm", bundle: true });
const runtime = await import(pathToFileURL(resolve(runtimePath)).href);
const session = await openReadSession();
let source, report, distribution;
try {
  const client = {
    async get(path) {
      const response = await session.get(path, { Prefer: "odata.maxpagesize=100" });
      if (!response.ok) throw new Error(`SAP GET rejected: HTTP ${response.status}`);
      return response.data;
    }
  };
  source = await runtime.readGgfV2Absorption(client, session.info.company, request.filter, request.mapping);
  report = runtime.reconcileAbsorption(source, request.mapping);
  distribution = await runtime.calculateAbsorptionDistribution(client, source, report, request.filter, request.mapping);
} finally { await session.close(); }

const cents = (value) => {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new Error(`Invalid decimal in independent calculation: ${value}`);
  return (match[1] === "-" ? -1n : 1n) * (BigInt(match[2]) * 100n + BigInt((match[3] ?? "").padEnd(2, "0")));
};
const independentlyRounded = (numerator, denominator) => {
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator * sign;
  return sign * (absolute / denominator + ((absolute % denominator) * 2n >= denominator ? 1n : 0n));
};
function independentlyApportion(amount, rows) {
  const total = rows.reduce((sum, row) => sum + row.weight, 0n);
  if (total <= 0n) throw new Error("Independent check found a zero denominator");
  const sign = amount < 0n ? -1n : 1n, absolute = amount * sign;
  const portions = rows.map((row) => ({ ...row, cents: absolute * row.weight / total, remainder: absolute * row.weight % total }));
  let residual = absolute - portions.reduce((sum, row) => sum + row.cents, 0n);
  [...portions].sort((a, b) => a.remainder === b.remainder ? a.id.localeCompare(b.id) : a.remainder > b.remainder ? -1 : 1)
    .slice(0, Number(residual)).forEach((row) => { row.cents += 1n; });
  return portions.map((row) => ({ id: row.id, cents: row.cents * sign, remainderAdjusted: row.cents * sign - (absolute * row.weight / total) * sign }));
}
const independent = [];
for (const category of ["MOD", "GGF"]) {
  const mappedAccounts = request.mapping.accounts.filter((row) => row.category === category);
  const ledger = source.journals.filter((row) => mappedAccounts.some((account) => account.account === row.account));
  const real = ledger.reduce((sum, row) => sum + row.debitCents - row.creditCents, 0n);
  const absorbed = source.movements.reduce((sum, move) => {
    const resource = source.resources.find((row) => row.resource === move.resource);
    const selected = request.mapping.resources.filter((row) => row.category === category && row.resource === move.resource);
    return sum + selected.reduce((inner, map) => {
      const component = resource?.components.find((row) => row.component === map.component);
      if (!component || !resource?.unit || resource.unit !== move.unit) throw new Error(`Independent absorption basis incomplete: ${move.resource}`);
      const quantity = move.direction === "RETURN" ? -move.quantityMicros : move.quantityMicros;
      return inner + independentlyRounded(quantity * component.unitCostCents, 1_000_000n);
    }, 0n);
  }, 0n);
  const difference = real - absorbed;
  const configured = request.mapping.distribution?.[category];
  const motorCategory = distribution.categories.find((row) => row.category === category);
  let rows = [];
  if (mappedAccounts.length && configured && motorCategory?.snapshot && motorCategory.status.startsWith("CALCULATED")) {
    const bases = motorCategory.snapshot.orders.map((order) => ({ id: order.number, weight: cents(order.directCost) }));
    rows = independentlyApportion(difference, bases);
  }
  independent.push({ category, realCents: real.toString(), absorbedCents: absorbed.toString(), differenceCents: difference.toString(), orders: rows.map((row) => ({ ...row, cents: row.cents.toString(), remainderAdjusted: row.remainderAdjusted.toString() })) });
}
const comparisons = ["MOD", "GGF"].map((category) => {
  const expected = independent.find((row) => row.category === category);
  const actual = distribution.categories.find((row) => row.category === category);
  const actualLines = new Map((actual?.allocation?.orders ?? []).map((row) => [row.order.number, row.allocated.toString()]));
  const lineComparisons = (expected?.orders ?? []).map((row) => ({ order: row.id, independentCents: row.cents, engineCents: actualLines.get(row.id) ?? null, matches: actualLines.get(row.id) === row.cents }));
  const diffMatches = actual?.differenceCents.toString() === expected?.differenceCents;
  return { category, differenceMatches: diffMatches, lines: lineComparisons, allLinesMatch: lineComparisons.every((row) => row.matches), status: actual?.status ?? "MISSING" };
});
const result = {
  label: "HOMOLOGAÇÃO TÉCNICA V2 — cálculo de absorção, sem regra funcional aprovada",
  readOnly: true,
  company: session.info.company,
  connection: { version: session.info.version, basePath: session.info.basePath, tlsVerified: session.info.tlsVerified },
  period: request.filter,
  selectedOrders: Object.fromEntries(["MOD", "GGF"].map((category) => [category, request.mapping.distribution?.[category]?.orderNumbers ?? []])),
  technicalAccountMappings: request.mapping.accounts,
  report,
  distribution,
  independent,
  comparisons,
  mathCompared: comparisons.every((row) => row.differenceMatches && row.allLinesMatch),
  limitations: [...new Set([...report.blockers, ...distribution.warnings, ...distribution.categories.filter((row) => row.blocker).map((row) => `${row.category}: ${row.blocker}`)])]
};
await writeFile(outputPath, JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2), { mode: 0o600 });
const csvRows = ["categoria,status,conta,criterio,op,item,base,total_base,participacao_percentual,valor_cents,ajuste_arredondamento_cents,resultado_independente_cents,referencias"];
for (const category of distribution.categories) {
  const independentRows = new Map(independent.find((row) => row.category === category.category)?.orders.map((row) => [row.id, row.cents]) ?? []);
  for (const order of category.allocation?.orders ?? []) {
    const traces = category.allocation.traces.filter((row) => row.orderId === order.order.id);
    for (const trace of traces) csvRows.push([
      category.category, category.status, request.mapping.accounts.find((row) => row.category === category.category)?.account ?? "", trace.criterion,
      order.order.number, order.order.item, trace.basis, trace.totalBasis, trace.participationPercent, order.allocated,
      trace.roundingMinor, independentRows.get(order.order.number) ?? "", order.order.sourceRefs.join("|")
    ].map(csvCell).join(","));
  }
}
for (const category of distribution.categories.filter((row) => !row.allocation)) csvRows.push([category.category, category.status, request.mapping.accounts.find((row) => row.category === category.category)?.account ?? "", category.criterion ?? "", "", "", "", "", "", "", "", "", category.blocker].map(csvCell).join(","));
const csvPath = outputPath.replace(/\.json$/i, ".csv");
await writeFile(csvPath, csvRows.join("\n"), { mode: 0o600 });
console.log(JSON.stringify({ company: result.company, period: result.period, mathCompared: result.mathCompared, categories: distribution.categories.map((row) => ({ category: row.category, status: row.status, differenceCents: row.differenceCents.toString(), allocatedCents: row.allocatedCents.toString(), residualCents: row.residualCents.toString(), blocker: row.blocker })), comparisons, files: [outputPath, csvPath] }, null, 2));

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}
