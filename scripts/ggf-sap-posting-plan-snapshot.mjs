import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const COMPANY = "SBODEMOBR2";
const OUTPUT = ".local/ggf/v2-posting-plan-technical-snapshot.json";
const persist = process.argv.includes("--persist");
const unknown = process.argv.slice(2).filter(arg => arg !== "--persist");
if (unknown.length) throw new Error("Only optional flag --persist is supported");

await mkdir(".local/ggf", { recursive: true, mode: 0o700 });
const request = JSON.parse(await readFile(".local/ggf/v2-absorption-distribution-request.json", "utf8"));
if (request.company !== COMPANY || request.filter?.start !== "2026-09-01" ||
    request.filter?.end !== "2026-09-30" || request.mapping?.technicalHomologation !== true)
  throw new Error("Saved request is not the approved September 2026 technical scope");

const { readV2AbsorptionDistribution, buildTechnicalPostingPlan, persistBlockedPostingPlan } =
  await import(pathToFileURL(resolve("scripts/ggf-sap-runtime.mjs")).href + `?t=${Date.now()}`);

const result = await readV2AbsorptionDistribution({ filter: request.filter, mapping: request.mapping });
if (result.source.company !== COMPANY || result.source.filter.start !== request.filter.start ||
    result.source.filter.end !== request.filter.end)
  throw new Error("Live SAP source company or period differs from the approved scope");

const accountingConfig = {
  transitoryGgfAccount: "", transitoryModAccount: "", closingGgfAccount: "", closingModAccount: "",
  cpvAccount: "", inventoryAccounts: {}, dimensionsByLine: {}, cpvEligibleOperationKeys: [], requireDimensions: true
};
const { accounting, draft } = buildTechnicalPostingPlan(result, request.mapping, accountingConfig);
const expected = { totalMod: "-300000", totalGgf: "-616600", totalStock: "0", totalCpv: "0", totalBlocked: "-916600" };
if (draft.status !== "BLOCKED" || draft.postingBlocked !== true || draft.companyDB !== COMPANY ||
    draft.closingId !== "TECH-SBODEMOBR2-202609" || draft.periodStart !== "2026-09-01" ||
    draft.periodEnd !== "2026-09-30" || draft.totalDifference !== "0" || draft.documents.some(doc => doc.payload !== null) ||
    Object.entries(expected).some(([key, value]) => draft[key] !== value))
  throw new Error("Live SAP posting plan differs from the approved blocked technical snapshot; no write performed");
if (JSON.stringify(draft).length > 50000) throw new Error("Technical snapshot exceeds the local SAP memo limit");

let persisted = false;
let saved;
if (persist) {
  saved = await persistBlockedPostingPlan(draft);
  const version = saved.latest?.version;
  if (!saved.integrityVerified || saved.latest?.status !== "BLOCKED" || saved.latest?.postingHash !== saved.versions
      .find(plan => plan.version === version)?.postingHash)
    throw new Error("SAP reread did not verify the blocked technical snapshot");
  persisted = true;
}

const audit = {
  createdAt: new Date().toISOString(), company: COMPANY, period: request.filter,
  source: "LIVE_SAP_READ_ONLY", technicalOnly: true, persisted,
  status: draft.status, version: saved?.latest?.version ?? null,
  postingHash: saved?.latest?.postingHash ?? null, totals: {
    totalMod: draft.totalMod, totalGgf: draft.totalGgf, totalStock: draft.totalStock,
    totalCpv: draft.totalCpv, totalBlocked: draft.totalBlocked, totalDifference: draft.totalDifference,
    accountingDifference: draft.accountingDifference
  },
  accountingTotals: accounting.totals,
  orderLines: draft.lines.map(line => ({ orderNumber: line.orderNumber, item: line.item,
    category: line.category, accountOriginal: line.accountOriginal, criterion: line.criterion,
    amountCents: line.amountCents, stockCents: line.stockCents, consumedCents: line.consumedCents,
    valuationMethod: line.valuationMethod, status: line.status, blockers: line.blockers, sourceRefs: line.sourceRefs })),
  blockers: draft.blockers, documents: draft.documents.map(doc => ({ type: doc.type, status: doc.status,
    totalCents: doc.totalCents, lineCount: doc.lines.length, payload: null, blockers: doc.blockers })),
  postingBlocked: true, financialPost: false, claimCreated: false
};
await writeFile(OUTPUT, JSON.stringify({ audit, draft }, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ output: OUTPUT, company: COMPANY, period: `${draft.periodStart}/${draft.periodEnd}`,
  status: draft.status, closingId: draft.closingId, version: audit.version, persisted,
  totals: audit.totals, lineCount: draft.lines.length, documentPayloadsNull: draft.documents.every(doc => doc.payload === null),
  integrityVerified: saved?.integrityVerified ?? null, hashPrefix: audit.postingHash?.slice(0, 16) ?? null,
  financialPost: false, claimCreated: false }, null, 2));
