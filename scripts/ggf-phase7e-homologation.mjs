import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openHomologationSession } from "./ggf-homologation-session.mjs";

const COMPANY = "SBODEMOBR2", DATE = "2026-10-01", BRANCH = 1, CURRENCY = "R$";
const FRESH_CLOSING = "TECH7E-20261001-C2B8A14D73";
const ITEM = "F1GGF26F01", WAREHOUSE = "01", LAYER = { transactionSequenceNum: 2790, layerId: 0 };
const ACCOUNT = { inventory: "1.01.02.01.01", revaluation: "5.03.01.01.04", cpv: "5.01.01.01.01",
  transit: "5.04.01.01.05", ggf: "5.04.01.01.03", mod: "5.04.01.01.04" };
const AMOUNT = { inventory: 100, revaluation: 100, cpv: 100, transit: 100, ggf: 120, mod: 80 };
const DIMENSION_FLAGS = ["ProjectRelevant", "CostAccountingOnly", "DistributionRuleRelevant",
  "DistributionRule2Relevant", "DistributionRule3Relevant", "DistributionRule4Relevant", "DistributionRule5Relevant"];
const OUT = resolve(".local/ggf"), FRESH_MODE = process.argv[2] === "create-new",
  RUN = resolve(OUT, FRESH_MODE ? "phase7e-fresh-C2B8A14D73-run.json" : "phase7e-run.json"),
  INTENT = resolve(OUT, FRESH_MODE ? "phase7e-fresh-C2B8A14D73-intent.json" : "phase7e-financial-intent.json"),
  RESULT = resolve(OUT, FRESH_MODE ? "phase7e-fresh-C2B8A14D73-result.json" : "phase7e-result.json"),
  LOCK = resolve(OUT, "phase7e.lock");
const cents = value => { const n = Number(value); if (!Number.isFinite(n) || Math.abs(n * 100 - Math.round(n * 100)) > 1e-7)
  throw new Error("SAP amount is not exact to cents"); return Math.round(n * 100); };
const must = (condition, message) => { if (!condition) throw new Error(message); };
const redact = value => Array.isArray(value) ? value.map(redact) : !value || typeof value !== "object" ? value :
  Object.fromEntries(Object.entries(value).map(([key, item]) => [/password|cookie|token|session|authorization/i.test(key) ? key : key,
    /password|cookie|token|session|authorization/i.test(key) ? "[REDACTED]" : redact(item)]));

async function saveJson(path, value, exclusive = false) {
  const data = `${JSON.stringify(redact(value), null, 2)}\n`;
  if (exclusive) { const file = await open(path, "wx", 0o600); try { await file.writeFile(data); await file.sync(); }
    finally { await file.close(); } return; }
  const temp = `${path}.${process.pid}.tmp`, file = await open(temp, "wx", 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  await rename(temp, path);
}

async function runtime() {
  const outfile = resolve(OUT, "phase7e-runtime.mjs");
  await build({ stdin: { resolveDir: process.cwd(), contents: `
export { SapGgfClosingRepository } from "./webapp/modules/ggf/repository/SapGgfClosingRepository.ts";
export { SapGgfPostingPlanRepository } from "./webapp/modules/ggf/repository/SapGgfPostingPlanRepository.ts";
export { SapGgfPostingClaimRepository, SapGgfPostingExecutionRepository } from "./webapp/modules/ggf/repository/SapGgfPostingExecutionRepository.ts";
export { SapGgfPostingOrchestrationStore } from "./webapp/modules/ggf/repository/SapGgfPostingOrchestrationStore.ts";
export { GgfPostingOrchestrator, DefiniteGgfDocumentRejection } from "./webapp/modules/ggf/service/GgfPostingOrchestrator.ts";
export { buildPhase7EEconomicScenario, assertPhase7EGatewayContract } from "./webapp/modules/ggf/service/GgfPhase7EEconomicScenario.ts";
export { buildPhase7EOrderIds } from "./webapp/modules/ggf/service/GgfPhase7EOrderId.ts";
export { calculateGgfPostingPlanHash } from "./webapp/modules/ggf/service/GgfPostingPlan.ts";
export { postingHash, transitionClosing } from "./webapp/modules/ggf/service/GgfClosing.ts";
export { calculateGgfRequestHash, calculateGgfExecutionId } from "./webapp/modules/ggf/service/GgfPostingExecution.ts";
export { sameCanonicalCheckpointRequest } from "./webapp/modules/ggf/service/GgfPostingExecution.ts";
export { ServiceLayerError } from "./webapp/core/service/errors.ts";
` }, outfile, platform: "node", format: "esm", bundle: true });
  return import(pathToFileURL(outfile).href + `?v=${Date.now()}`);
}

function makeClient(session, lib) {
  const value = r => { if (!r.ok) throw new lib.ServiceLayerError("SAP request rejected", r.status, r.errorCode, r.errorMessage); return r.data; };
  return {
    async get(path) { return value(await session.get(path, { Prefer: "odata.maxpagesize=100" })); },
    async post(path, body) { return value(await session.postTechnicalPhase7ERecord(path, body)); },
    async patch(path, body) { return value(await session.patchTechnicalPhase7ERecord(path, body)); }
  };
}

function lineSummary(row) { return { AccountCode: row.AccountCode, Debit: row.Debit, Credit: row.Credit,
  BPLID: row.BPLID, FCCurrency: row.FCCurrency ?? null,
  dimensions: [row.ProjectCode, row.CostingCode, row.CostingCode2, row.CostingCode3, row.CostingCode4, row.CostingCode5] }; }

function validJournal(row, request, expectedType) {
  if (!row || row.Reference !== request.Reference || row.Memo !== request.Memo ||
      String(row.ReferenceDate).slice(0, 10) !== DATE || String(row.DueDate).slice(0, 10) !== DATE ||
      String(row.TaxDate).slice(0, 10) !== DATE || !Array.isArray(row.JournalEntryLines)) return false;
  const actual = row.JournalEntryLines.filter(line => Number(line.Debit) !== 0 || Number(line.Credit) !== 0);
  const expected = request.JournalEntryLines;
  return actual.length === expected.length && expected.every(want => actual.some(got => got.AccountCode === want.AccountCode &&
    cents(got.Debit) === cents(want.Debit) && cents(got.Credit) === cents(want.Credit) && got.BPLID === BRANCH &&
    (!got.FCCurrency || got.FCCurrency === CURRENCY) && DIMENSION_FLAGS.every((_, i) =>
      [got.ProjectCode, got.CostingCode, got.CostingCode2, got.CostingCode3, got.CostingCode4, got.CostingCode5][i] == null ||
      [got.ProjectCode, got.CostingCode, got.CostingCode2, got.CostingCode3, got.CostingCode4, got.CostingCode5][i] === "")));
}

function validRevaluation(doc, request) {
  if (!doc || doc.RevalType !== "P" || doc.Comments !== request.Comments ||
      doc.JournalMemo !== request.JournalMemo || doc.Series !== 25 || String(doc.DocDate).slice(0, 10) !== DATE ||
      !Array.isArray(doc.MaterialRevaluationLines) || doc.MaterialRevaluationLines.length !== 1) return false;
  const line = doc.MaterialRevaluationLines[0], layer = line.FIFOLayers?.[0];
  return line.ItemCode === ITEM && line.WarehouseCode === WAREHOUSE &&
    line.RevaluationIncrementAccount === ACCOUNT.revaluation && line.FIFOLayers?.length === 1 &&
    layer.TransactionSequenceNum === LAYER.transactionSequenceNum && layer.LayerID === LAYER.layerId &&
    Number(layer.Price) === 12.2;
}

async function queryCount(session, entity, filter = "") {
  const path = `${entity}/$count${filter ? `?$filter=${encodeURIComponent(filter)}` : ""}`;
  const row = await session.get(path);
  must(row.ok && Number.isSafeInteger(Number(row.data)), `${entity} count unavailable`);
  return Number(row.data);
}

async function assertOrderIdFieldSize(session) {
  const filter = encodeURIComponent("TableName eq '@FBO_GGF_CLINE' and Name eq 'OrderId'");
  const response = await session.get(`UserFieldsMD?$filter=${filter}&$select=TableName,Name,Size`);
  const rows = response.data?.value;
  must(response.ok && Array.isArray(rows) && rows.length === 1 &&
    rows[0].TableName === "@FBO_GGF_CLINE" && rows[0].Name === "OrderId" && Number(rows[0].Size) === 30,
    "SAP U_OrderId metadata is not the expected 30-character field");
  return Number(rows[0].Size);
}

async function preflight(session, closingId, expectedBalances = null, options = {}) {
  const [metadata, accountRows, wh, branch, admin, currency, period, series, item, fifo, markerReval, markerJe,
    inventoryDetermination, revaluationDetermination, closeUdo, claimUdo, planUdo, execUdo, docUdo,
    historicalRevaluationCount, historicalRevaluationRows] = await Promise.all([
    session.get("$metadata", "application/xml"), Promise.all(Object.values(ACCOUNT).map(code => session.get(`ChartOfAccounts('${code}')`))),
    session.get(`Warehouses('${WAREHOUSE}')?$select=WarehouseCode,BusinessPlaceID,Inactive,DropShip`),
    session.get(`BusinessPlaces?$filter=BPLID eq ${BRANCH}&$select=BPLID,BPLName,Disabled`),
    session.get("CompanyService_GetAdminInfo"), session.get(`Currencies('${CURRENCY}')`),
    session.readAction("CompanyService_GetFinancePeriod", { FinancePeriodParams: { AbsoluteEntry: 180, PeriodIndicator: "Padrão" } }),
    session.readAction("SeriesService_GetDefaultSeries", { DocumentTypeParams: { Document: "162" } }),
    session.get(`Items('${ITEM}')?$select=ItemCode,ItemName,InventoryItem,InventoryUOM,CostAccountingMethod,ManageSerialNumbers,ManageBatchNumbers,QuantityOnStock,ItemWarehouseInfoCollection`),
    session.readAction("MaterialRevaluationFIFOService_GetMaterialRevaluationFIFO", { MaterialRevaluationFIFOParams:
      { ItemCode: ITEM, LocationCode: WAREHOUSE, LocationType: "64", ShowIssuedLayers: "tNO" } }),
    session.get(`MaterialRevaluation/$count?$filter=${encodeURIComponent(`Comments eq 'FactoryOne PHASE7E_TECHNICAL ${closingId}'`)}`),
    session.get(`JournalEntries/$count?$filter=${encodeURIComponent(`Reference eq '${closingId}'`)}`),
    session.readAction("CompanyService_GetAdvancedGLAccount", { AdvancedGLAccountParams: {
      ItemCode: ITEM, Warehouse: WAREHOUSE, PostingDate: `${DATE}T00:00:00Z`, AccountType: "iatInventory" } }),
    session.readAction("CompanyService_GetAdvancedGLAccount", { AdvancedGLAccountParams: {
      ItemCode: ITEM, Warehouse: WAREHOUSE, PostingDate: `${DATE}T00:00:00Z`, AccountType: "iatGLIncrease" } }),
    session.get("UserObjectsMD('FBO_GGF_CLOSE')"), session.get("UserObjectsMD('FBO_GGF_CLAIM')"),
    session.get("UserObjectsMD('FBO_GGF_PPLAN')"),
    session.get("UserObjectsMD('FBO_GGF_PEXEC')"), session.get("UserObjectsMD('FBO_GGF_PDOC')"),
    session.get(`MaterialRevaluation/$count?$filter=${encodeURIComponent("DocDate ge '2026-09-28'")}`),
    session.get(`MaterialRevaluation?$filter=${encodeURIComponent("DocDate ge '2026-09-28'")}&$select=DocEntry,DocNum,DocDate,MaterialRevaluationLines&$top=100`)
  ]);
  must(metadata.ok && ["FBO_GGF_CLOSE", "FBO_GGF_CLINE", "FBO_GGF_CLAIM", "FBO_GGF_PPLAN", "FBO_GGF_PEXEC", "FBO_GGF_PDOC"]
    .every(name => metadata.data.includes(`Name="${name}"`)), "SAP metadata is incomplete on the active node");
  must([closeUdo, claimUdo, planUdo, execUdo, docUdo].every(r => r.ok && r.data?.Code) &&
    inventoryDetermination.ok && inventoryDetermination.data.AccountCode === ACCOUNT.inventory &&
    revaluationDetermination.ok && revaluationDetermination.data.AccountCode === ACCOUNT.revaluation,
    "UDO metadata or effective inventory/revaluation account determination differs");
  const historyRows = historicalRevaluationRows.data?.value;
  must(historicalRevaluationCount.ok && historicalRevaluationRows.ok && Array.isArray(historyRows) &&
    Number(historicalRevaluationCount.data) === historyRows.length && !historicalRevaluationRows.data["odata.nextLink"] &&
    !historyRows.some(doc => doc.MaterialRevaluationLines?.some(line => line.ItemCode === ITEM &&
      line.FIFOLayers?.some(layer => layer.TransactionSequenceNum === LAYER.transactionSequenceNum &&
        layer.LayerID === LAYER.layerId))), "A later equivalent FIFO-layer revaluation exists or history pagination is incomplete");
  const entityCounts = {};
  for (const entity of ["FBO_GGF_CLOSE", "FBO_GGF_CLINE", "FBO_GGF_CLAIM", "FBO_GGF_PPLAN", "FBO_GGF_PEXEC", "FBO_GGF_PDOC"])
    entityCounts[entity] = await queryCount(session, entity);
  must(accountRows.every(r => r.ok), "One or more required accounts could not be read");
  const accounts = Object.fromEntries(accountRows.map(r => [r.data.Code, r.data]));
  for (const code of Object.values(ACCOUNT)) {
    const a = accounts[code];
    must(a?.ActiveAccount === "tYES" && a.BlockManualPosting === "tNO" && a.FrozenFor !== "tYES" &&
      DIMENSION_FLAGS.every(flag => a[flag] === "tNO"), `Account ${code} is blocked or requires an unprovided dimension`);
  }
  must(wh.ok && wh.data.WarehouseCode === WAREHOUSE && wh.data.BusinessPlaceID === BRANCH && wh.data.Inactive === "tNO" &&
    branch.ok && branch.data.value?.length === 1 && branch.data.value[0].Disabled === "tNO", "Branch/warehouse changed");
  must(admin.ok && admin.data.LocalCurrency === CURRENCY && admin.data.Country === "BR" &&
    currency.ok && currency.data.Code === CURRENCY && currency.data.Name === "Real", "Local BRL currency not verified");
  must(period.ok && period.data.AbsoluteEntry === 180 && period.data.PeriodCode === "2026-10" &&
    period.data.Locked === "tNO" && period.data.PeriodStatus === "ltUnlocked" &&
    DATE >= period.data.PostingDateFrom.slice(0, 10) && DATE <= period.data.PostingDateTo.slice(0, 10), "Posting period is closed");
  must(series.ok && series.data.Series === 25 && series.data.Locked === "tNO" && series.data.PeriodIndicator === "Padrão",
    "MaterialRevaluation series 25 is not available for the current period");
  const warehouseItem = item.data?.ItemWarehouseInfoCollection?.find(row => row.WarehouseCode === WAREHOUSE);
  const target = fifo.data?.Layers?.filter(row => row.TransactionSequenceNum === LAYER.transactionSequenceNum && row.LayerID === LAYER.layerId) ?? [];
  const expectedRevalCount = options.expectedRevaluationMarkers ?? 0;
  const expectedJeCount = options.expectedJournalMarkers ?? 0;
  const layerEvidence = options.afterRevaluation
    ? fifo.data?.Layers?.filter(row => String(row.DocNumber) === String(options.revaluationDocNum) &&
      row.DocType === "ttInventoryValuation" && row.OpenQty === 5 && row.CurrentCost === 12.2) ?? []
    : target;
  must(item.ok && item.data.ItemCode === ITEM && item.data.InventoryItem === "tYES" && item.data.CostAccountingMethod === "bis_FIFO" &&
    item.data.InventoryUOM === "UN" && item.data.ManageSerialNumbers === "tNO" && item.data.ManageBatchNumbers === "tNO" &&
    warehouseItem?.Locked === "tNO" && warehouseItem?.Committed === 0 && warehouseItem?.InStock === 10 &&
    fifo.ok && Array.isArray(fifo.data?.Layers) && layerEvidence.length === 1 && layerEvidence[0].OpenQty === 5 &&
    layerEvidence[0].CurrentCost === (options.afterRevaluation ? 12.2 : 12) &&
    (options.afterRevaluation ? target.length === 0 : String(target[0].DocNumber) === "76" &&
      target[0].DocType === "ttGeneralReceiptToStock"), "FIFO layer or item stock is not the authorized state");
  must(markerReval.ok && Number(markerReval.data) === expectedRevalCount &&
    markerJe.ok && Number(markerJe.data) === expectedJeCount,
    "Technical document marker already exists or could not be checked");
  if (expectedBalances) for (const [code, amount] of Object.entries(expectedBalances))
    must(cents(accounts[code].Balance) === amount, `Account balance changed before posting: ${code}`);
  return { node: session.routeNode ?? null, metadataHash: createHash("sha256").update(metadata.data).digest("hex"),
    entityCounts, accountBalances: Object.fromEntries(Object.values(ACCOUNT).map(code => [code, cents(accounts[code].Balance)])),
    accounts: Object.values(ACCOUNT).map(code => ({ code, name: accounts[code].Name,
      active: accounts[code].ActiveAccount, manualPosting: accounts[code].BlockManualPosting,
      dimensions: Object.fromEntries(DIMENSION_FLAGS.map(flag => [flag, accounts[code][flag]])) })),
    branch: { id: BRANCH, warehouse: WAREHOUSE, warehouseBranch: wh.data.BusinessPlaceID, name: branch.data.value[0].BPLName },
    currency: CURRENCY, period: period.data.PeriodCode, series: series.data.Series,
    item: { code: ITEM, method: item.data.CostAccountingMethod, unit: item.data.InventoryUOM,
      warehouseQuantity: warehouseItem.InStock },
    historicalRevaluationDocumentsChecked: historyRows.length,
    fifoLayer: { sequence: layerEvidence[0].TransactionSequenceNum, layerId: layerEvidence[0].LayerID,
      openQuantity: layerEvidence[0].OpenQty, currentUnitPrice: layerEvidence[0].CurrentCost, receiptDocNum: layerEvidence[0].DocNumber } };
}

function buildPlan(scenario, requestHashes, at) {
  const rowIds = ["TECH7E-FIFO-2790-0-GGF", "TECH7E-FIFO-2790-0-MOD"];
  const base = { orderNumber: "TECHNICAL_FIFO_LAYER_2790_0", item: ITEM, warehouse: WAREHOUSE,
    criterion: "Cenário técnico 7E", quantity: "5", unit: "UN", dimensions: [], status: "VALIDATED", blockers: [], payload: null };
  const docLine = (amountCents, category, debitAccount, creditAccount, sourceId, quantity) => ({
    orderNumber: base.orderNumber, item: ITEM, warehouse: WAREHOUSE, category,
    accountOriginal: category === "GGF" ? ACCOUNT.ggf : ACCOUNT.mod, criterion: base.criterion,
    quantity, unit: "UN", amountCents: String(amountCents), debitAccount, creditAccount,
    dimensions: [], sourceOrderRefs: [sourceId], status: "VALIDATED", blockers: [], dependencies: [], payload: null });
  const sourceLines = [
    { ...base, status: "READY", id: rowIds[0], accountOriginal: ACCOUNT.ggf, category: "GGF", amountCents: "120", stockCents: "60",
      consumedCents: "60", valuationMethod: "bis_FIFO", futureDocumentTypes: ["MaterialRevaluation", "JournalEntry.CPV"],
      effects: [{ documentType: "MaterialRevaluation", amountCents: "60", debitAccount: ACCOUNT.inventory, creditAccount: ACCOUNT.revaluation },
        { documentType: "JournalEntry.CPV", amountCents: "60", debitAccount: ACCOUNT.cpv, creditAccount: ACCOUNT.transit }],
      debitAccounts: [ACCOUNT.cpv, ACCOUNT.inventory], creditAccounts: [ACCOUNT.revaluation, ACCOUNT.transit],
      sourceRefs: ["FIFO:2790/0:receipt-DocNum-76"] },
    { ...base, status: "READY", id: rowIds[1], accountOriginal: ACCOUNT.mod, category: "MOD", amountCents: "80", stockCents: "40",
      consumedCents: "40", valuationMethod: "bis_FIFO", futureDocumentTypes: ["MaterialRevaluation", "JournalEntry.CPV"],
      effects: [{ documentType: "MaterialRevaluation", amountCents: "40", debitAccount: ACCOUNT.inventory, creditAccount: ACCOUNT.revaluation },
        { documentType: "JournalEntry.CPV", amountCents: "40", debitAccount: ACCOUNT.cpv, creditAccount: ACCOUNT.transit }],
      debitAccounts: [ACCOUNT.cpv, ACCOUNT.inventory], creditAccounts: [ACCOUNT.revaluation, ACCOUNT.transit],
      sourceRefs: ["FIFO:2790/0:receipt-DocNum-76"] }
  ];
  const docs = [
    { type: "MaterialRevaluation", order: 1, totalCents: "100", lines: [docLine(60, "GGF", ACCOUNT.inventory, ACCOUNT.revaluation, rowIds[0], "2.5"),
      docLine(40, "MOD", ACCOUNT.inventory, ACCOUNT.revaluation, rowIds[1], "2.5")], dependencies: ["FIFO_LAYER_TRACE", "ADVANCED_GL_ACCOUNT"] },
    { type: "JournalEntry.CPV", order: 2, totalCents: "100", lines: [docLine(60, "GGF", ACCOUNT.cpv, ACCOUNT.transit, rowIds[0], null),
      docLine(40, "MOD", ACCOUNT.cpv, ACCOUNT.transit, rowIds[1], null)], dependencies: ["CONSUMED_ADJUSTMENT", "CPV_ACCOUNT"] },
    { type: "JournalEntry.Closing", order: 3, totalCents: "200", lines: [
      docLine(60, "GGF", ACCOUNT.revaluation, ACCOUNT.ggf, rowIds[0], "2.5"),
      docLine(60, "GGF", ACCOUNT.transit, ACCOUNT.ggf, rowIds[0], "2.5"),
      docLine(40, "MOD", ACCOUNT.revaluation, ACCOUNT.mod, rowIds[1], "2.5"),
      docLine(40, "MOD", ACCOUNT.transit, ACCOUNT.mod, rowIds[1], "2.5")],
      dependencies: ["MATERIAL_REVALUATION_AND_CPV_PLANS", "TRANSITORY_ACCOUNT", "CATEGORY_ACCOUNTS"] }
  ].map(doc => ({ ...doc, currency: CURRENCY, dimensions: [], status: "VALIDATED", blockers: [], payload: null }));
  return { scenarioId: "PHASE7E_TECHNICAL", closingId: scenario.closingId, version: 1, closingVersion: 4, postingHash: "", createdAt: at,
    createdBy: "FACTORYONE_PHASE7E_TECHNICAL", status: "VALIDATED", companyDB: COMPANY,
    periodStart: DATE, periodEnd: DATE, branch: String(BRANCH), dimensions: [], currency: CURRENCY,
    currencySource: "SAP_LOCAL_CURRENCY", totalMod: "80", totalGgf: "120", totalStock: "100", totalCpv: "100",
    totalBlocked: "0", totalDifference: "0", accountingDifference: "0", lines: sourceLines, documents: docs,
    blockers: [], sourceMode: "SAP_READ_ONLY", sourceCapturedAt: at, postingBlocked: true,
    technicalRequestHashes: requestHashes };
}

function closingLines(orderIds) {
  return [
    { account: ACCOUNT.ggf, criterion: "Cenário técnico 7E", orderId: orderIds.MaterialRevaluation, item: ITEM, warehouse: WAREHOUSE,
      basis: "FIFO 2790/0, 5 UN", percent: "60.00", allocated: "1.20", costBefore: "12.00", costAfter: "12.20", revaluation: "0.60", status: "READY" },
    { account: ACCOUNT.mod, criterion: "Cenário técnico 7E", orderId: orderIds["JournalEntry.CPV"], item: ITEM, warehouse: WAREHOUSE,
      basis: "FIFO 2790/0, 5 UN", percent: "40.00", allocated: "0.80", costBefore: "12.00", costAfter: "12.20", revaluation: "0.40", status: "READY" }
  ];
}

function makeBasis(closingId, plan, scenario, lines) {
  return { documentType: "MaterialRevaluation", postingPlanHash: plan.postingHash, postingClosingVersion: 4,
    postingPlanVersion: 1, companyDB: COMPANY, periodStart: DATE, periodEnd: DATE, branch: String(BRANCH), dimensions: {},
    totals: { ggf: "2.00", allocated: "2.00", revalued: "1.00" },
    accounts: [{ account: ACCOUNT.ggf, amount: "1.20", percent: "60.00", criterion: "Cenário técnico 7E" },
      { account: ACCOUNT.mod, amount: "0.80", percent: "40.00", criterion: "Cenário técnico 7E" }], lines,
    inventoryAccounts: { [ITEM]: ACCOUNT.inventory, RevaluationIncrementAccount: ACCOUNT.revaluation },
    fifoLineage: [], payload: scenario.documents[0].request };
}

let writer, reader, checkpointSession, lock, posts = 0;
try {
  must(["validate-existing", "resume-existing", "create-new"].includes(process.argv[2]),
    "Usage: FBO_SL_ALLOW_INVALID_CERTIFICATE=1 node scripts/ggf-phase7e-homologation.mjs validate-existing|resume-existing|create-new");
  await mkdir(OUT, { recursive: true, mode: 0o700 });
  lock = await open(LOCK, "wx", 0o600);
  must(FRESH_MODE ? !(await readFile(RUN).then(() => true).catch(() => false)) &&
    !(await readFile(INTENT).then(() => true).catch(() => false)) &&
    !(await readFile(RESULT).then(() => true).catch(() => false)) :
    (await readFile(RUN).then(() => true).catch(() => false)) &&
    !(await readFile(INTENT).then(() => true).catch(() => false)) &&
    !(await readFile(RESULT).then(() => true).catch(() => false)),
    "Phase 7E already has a financial intent/result; do not retry without SAP reconciliation");
  const lib = await runtime(), closingId = FRESH_MODE ? FRESH_CLOSING : "TECH7E-20261001-6D12027067";
  const priorRun = FRESH_MODE ? null : JSON.parse(await readFile(RUN, "utf8"));
  if (!FRESH_MODE) must(priorRun.closingId === closingId && priorRun.status === "STOPPED_PRE_FINANCIAL_POST" &&
    priorRun.actualFinancialPosts === 0 && priorRun.claimCreated === false && priorRun.executionCreated === false &&
    priorRun.sapTechnicalWrites?.postingPlanVersion1 === "persisted" && priorRun.sapTechnicalWrites?.closing === "DRAFT",
    "Existing local checkpoint does not match the approved resumable DRAFT");
  const at = new Date().toISOString();
  writer = await openHomologationSession();
  const orderIds = await lib.buildPhase7EOrderIds(closingId);
  must(Object.values(orderIds).every(id => id.length <= 30) && new Set(Object.values(orderIds)).size === 3,
    "Phase 7E OrderIds exceed the SAP field limit or collide");
  const orderIdFieldSize = await assertOrderIdFieldSize(writer);
  const approvedOpeningBalances = { [ACCOUNT.inventory]: 436567550, [ACCOUNT.revaluation]: -41128,
    [ACCOUNT.cpv]: 100, [ACCOUNT.transit]: 0, [ACCOUNT.ggf]: -60, [ACCOUNT.mod]: -40 };
  const before = await preflight(writer, closingId, FRESH_MODE ? approvedOpeningBalances : priorRun.preflight.accountBalances);
  must(before.fifoLayer.openQuantity === 5 && before.fifoLayer.currentUnitPrice === 12 &&
    before.fifoLayer.sequence === 2790 && before.fifoLayer.layerId === 0 && before.fifoLayer.receiptDocNum === "76",
    "Authorized FIFO layer no longer matches the approved 5 UN at R$12.00 receipt");
  const scenario = await lib.buildPhase7EEconomicScenario({ closingId });
  await lib.assertPhase7EGatewayContract(scenario);
  const requests = Object.fromEntries(scenario.documents.map(doc => [doc.type, doc.request]));
  const requestHashes = Object.fromEntries(scenario.documents.map(doc => [doc.type, doc.requestHash]));
  const planRepoForCreate = new lib.SapGgfPostingPlanRepository(makeClient(writer, lib), () => at);
  let plan = await planRepoForCreate.get(closingId, 1);
  if (FRESH_MODE) {
    const existingPlans = await planRepoForCreate.list(closingId);
    must(!plan && existingPlans.length === 0, "Fresh technical Closing already has a PostingPlan; stop for reconciliation");
    const draftPlan = buildPlan(scenario, requestHashes, at);
    const planCandidate = { ...draftPlan, version: 1, postingHash: "" };
    const plannedHash = await lib.calculateGgfPostingPlanHash(planCandidate);
    const candidateExecutionId = await lib.calculateGgfExecutionId({ closingId, closingVersion: draftPlan.closingVersion,
      postingPlanVersion: 1, postingHash: plannedHash });
    writer.bindTechnicalPhase7EContext(closingId, candidateExecutionId, plannedHash, requests, requestHashes, orderIds);
    draftPlan.postingHash = plannedHash;
    plan = await planRepoForCreate.append(draftPlan);
  }
  must(plan !== null && plan.closingId === closingId && plan.version === 1 && plan.closingVersion === 4 &&
    plan.scenarioId === "PHASE7E_TECHNICAL" && plan.status === "VALIDATED" && plan.companyDB === COMPANY &&
    (FRESH_MODE || plan.postingHash === priorRun.postingHash) && await lib.calculateGgfPostingPlanHash(plan) === plan.postingHash &&
    Object.keys(requestHashes).length === 3 && Object.keys(requestHashes).every(type =>
      plan.technicalRequestHashes?.[type] === requestHashes[type]) &&
    plan.totalGgf === "120" && plan.totalMod === "80" && plan.totalStock === "100" && plan.totalCpv === "100" &&
    plan.totalBlocked === "0" && plan.documents.length === 3 &&
    plan.documents.map(doc => doc.type).join("|") === "MaterialRevaluation|JournalEntry.CPV|JournalEntry.Closing" &&
    scenario.documents.length === 3 && scenario.documents.every((doc, i) => doc.requestHash ===
      plan.technicalRequestHashes[doc.type]) &&
    scenario.documents.reduce((n, doc) => n + BigInt(doc.amountCents), 0n) === 400n,
    "Persisted PostingPlan v1 is missing, altered, or no longer matches the approved scenario");
  const [allPlans] = await Promise.all([new lib.SapGgfPostingPlanRepository(makeClient(writer, lib)).list(closingId)]);
  must(allPlans.length === 1 && allPlans[0]?.postingHash === plan.postingHash,
    "Existing PostingPlan set is not exactly version 1");
  let client = makeClient(writer, lib), closingRepo = new lib.SapGgfClosingRepository(client),
    planRepo = new lib.SapGgfPostingPlanRepository(client, () => at);
  let draft = await closingRepo.get(closingId);
  if (FRESH_MODE && !draft) {
    const initial = { closingId, companyDB: COMPANY, periodStart: DATE, periodEnd: DATE, branch: String(BRANCH),
      dimensions: {}, status: "DRAFT", version: 1, lineVersion: 1, createdAt: at,
      createdBy: "FACTORYONE_PHASE7E_TECHNICAL", calculatedAt: null, postedAt: null,
      totalGgf: "0.00", totalAllocated: "0.00", totalRevalued: "0.00",
      sapMaterialRevaluationDocEntry: null, sapMaterialRevaluationDocNum: null,
      sapJournalEntryDocEntry: null, sapJournalEntryDocNum: null, sapJournalTransId: null,
      postingHash: null, reopenedFrom: null, cancelledAt: null,
      notes: "PHASE7E_TECHNICAL; homologacao isolada; valores fixos aprovados", lastError: null,
      postingBasis: null, proposedPayload: null, lines: [] };
    await closingRepo.create(initial);
    draft = await closingRepo.get(closingId);
  }
  must(draft?.status === "DRAFT" && draft.version === 1 && draft.lineVersion === 1 && draft.lines.length === 0 &&
    draft.postingHash === null && draft.postingBasis === null && draft.proposedPayload === null && draft.postedAt === null &&
    draft.sapMaterialRevaluationDocEntry === null && draft.sapMaterialRevaluationDocNum === null &&
    draft.sapJournalEntryDocEntry === null && draft.sapJournalEntryDocNum === null && draft.sapJournalTransId === null &&
    cents(draft.totalGgf) === 0 && cents(draft.totalAllocated) === 0 && cents(draft.totalRevalued) === 0,
    "Existing Closing is not the approved empty DRAFT state");
  const closingLineCount = await writer.get(`FBO_GGF_CLINE/$count?$filter=${encodeURIComponent(`U_ClosingId eq '${closingId}'`)}`);
  must(closingLineCount.ok && Number(closingLineCount.data) === 0,
    "Closing already has CLINE rows; stop for manual reconciliation");
  const executionId = await lib.calculateGgfExecutionId({ closingId, closingVersion: plan.closingVersion,
    postingPlanVersion: plan.version, postingHash: plan.postingHash });
  let executionRepo = new lib.SapGgfPostingExecutionRepository(client),
    claimRepo = new lib.SapGgfPostingClaimRepository(client);
  const [claimBefore, executionBefore, executionCount, documentCount] = await Promise.all([
    claimRepo.get(executionId), executionRepo.get(executionId),
    queryCount(writer, "FBO_GGF_PEXEC", `Code eq '${executionId}'`),
    queryCount(writer, "FBO_GGF_PDOC", `U_ExecutionId eq '${executionId}'`)
  ]);
  must(claimBefore === null && executionBefore === null && executionCount === 0 && documentCount === 0,
    "A Claim or Execution already exists for this exact identity");
  const lineRows = closingLines(orderIds), basis = makeBasis(closingId, plan, scenario, lineRows),
    closeHash = await lib.postingHash(basis);
  const preflightBundle = { closingId, closingVersion: plan.closingVersion, lifecycleVersion: 4, closingStatus: "READY_TO_POST",
    closingPostingHash: closeHash, closingBoundPlanHash: plan.postingHash, closingIntegrity: "NOT_APPLICABLE",
    plan, planReadbackHash: plan.postingHash, metadataAvailable: true,
    homologatedValuationMethods: ["bis_FIFO"], companyDB: COMPANY, user: "FACTORYONE_PHASE7E_TECHNICAL" };
  const offlineStore = { async load() { return preflightBundle; }, async getClaim() { return null; },
    async latest() { return null; }, async append() {} };
  const offlineExecution = await new lib.GgfPostingOrchestrator(offlineStore, {}).prepare(closingId, 1);
  must(offlineExecution.status === "READY_TO_POST" && offlineExecution.documents.length === 3 &&
    offlineExecution.documents.every((row, index) => row.documentType ===
      ["MaterialRevaluation", "JournalEntry.CPV", "JournalEntry.Closing"][index]),
    "Offline orchestrator validation rejected the exact Phase 7E document set");
  if (process.argv[2] === "validate-existing") {
    console.log(JSON.stringify({ preflightOnly: true, sapWrites: 0, financialPosts: 0, closingId,
      closingStatus: draft.status, closingVersion: draft.version, postingPlanVersion: plan.version,
      postingHash: plan.postingHash, requestHashes, orderIds, orderIdLengths: Object.fromEntries(
        Object.entries(orderIds).map(([type, id]) => [type, id.length])), sapOrderIdFieldSize: orderIdFieldSize,
      CLINE: 0, claim: false, execution: false, PDOCs: 0, before }));
    throw new Error("PHASE7E_READ_ONLY_VALIDATION_COMPLETE");
  }
  await saveJson(RUN, { ...(priorRun ?? {}), closingId, companyDB: COMPANY, resumedAt: at,
    status: FRESH_MODE ? "CREATING_NEW_CLOSING" : "RESUMING_EXISTING_CLOSING",
    orderIds, orderIdFieldSize, preflight: before, postingHash: plan.postingHash, requestHashes }, false);
  writer.bindTechnicalPhase7EContext(closingId, executionId, plan.postingHash, requests, requestHashes, orderIds);
  let closing = { ...lib.transitionClosing(draft, "CALCULATED"), calculatedAt: at, totalGgf: "2.00",
    totalAllocated: "2.00", totalRevalued: "1.00", postingBasis: basis,
    proposedPayload: scenario.documents[0].request, postingHash: closeHash, lines: lineRows };
  await closingRepo.replace(draft, closing);
  await writer.close(); writer = null;
  reader = await openHomologationSession();
  const lineReadClient = makeClient(reader, lib), lineReadClose = new lib.SapGgfClosingRepository(lineReadClient),
    lineReadPlans = new lib.SapGgfPostingPlanRepository(lineReadClient, () => at);
  reader.bindTechnicalPhase7EContext(closingId, executionId, plan.postingHash, requests, requestHashes, orderIds);
  const calculated = await lineReadClose.get(closingId), rereadPlan = await lineReadPlans.get(closingId, 1);
  must(calculated?.status === "CALCULATED" && calculated.version === 2 && calculated.lineVersion === 2 &&
    JSON.stringify(calculated.lines) === JSON.stringify(lineRows) && calculated.postingHash === closeHash &&
    calculated.postingBasis?.postingPlanHash === plan.postingHash && rereadPlan?.postingHash === plan.postingHash &&
    JSON.stringify(rereadPlan.technicalRequestHashes) === JSON.stringify(requestHashes),
    "Closing CLINE round-trip or existing PostingPlan v1 differs in the fresh Service Layer session");
  await reader.close(); reader = null;
  writer = await openHomologationSession();
  writer.bindTechnicalPhase7EContext(closingId, executionId, plan.postingHash, requests, requestHashes, orderIds);
  client = makeClient(writer, lib);
  closingRepo = new lib.SapGgfClosingRepository(client);
  planRepo = new lib.SapGgfPostingPlanRepository(client, () => at);
  executionRepo = new lib.SapGgfPostingExecutionRepository(client);
  claimRepo = new lib.SapGgfPostingClaimRepository(client);
  let currentClosing = await closingRepo.get(closingId);
  must(currentClosing?.status === "CALCULATED" && currentClosing.version === 2 &&
    JSON.stringify(currentClosing.lines) === JSON.stringify(lineRows), "Closing changed after the CLINE fresh-session check");
  closing = lib.transitionClosing(currentClosing, "VALIDATED"); await closingRepo.replace(currentClosing, closing);
  const validated = closing;
  closing = lib.transitionClosing(validated, "READY_TO_POST"); await closingRepo.replace(validated, closing);
  must(closing.version === 4 && closing.postingHash === closeHash, "Closing is not ready at its bound existing PostingPlan v1");

  const store = new lib.SapGgfPostingOrchestrationStore(client, ["bis_FIFO"], () => new Date().toISOString());
  const gateway = {
    async prepare(document) {
      const request = requests[document.type];
      must(request && document.totalCents === (document.type === "JournalEntry.Closing" ? "200" : "100") &&
        plan.technicalRequestHashes[document.type] === requestHashes[document.type], "Document request not bound to existing plan");
      return { expectedCents: document.totalCents, payload: request };
    },
    async post(documentType, body) {
      const execution = await executionRepo.get(executionId), claim = await claimRepo.get(executionId), current = await closingRepo.get(closingId);
      const sequence = { MaterialRevaluation: 1, "JournalEntry.CPV": 2, "JournalEntry.Closing": 3 }[documentType];
      const pdoc = execution?.documents[sequence - 1];
      must(execution?.status === "POSTING" && claim?.status === "POSTING" && current?.status === "POSTING" &&
        execution.documents.length === 3 && pdoc?.status === "SENDING" && pdoc.attemptCount === 1 &&
        pdoc.requestHash === requestHashes[documentType] && JSON.stringify(pdoc.request) === JSON.stringify(body),
        "PostingPlan, claim, execution and SENDING PDOC must be persisted before each financial POST");
      const afterRevaluation = documentType !== "MaterialRevaluation";
      const expectedBalances = documentType === "MaterialRevaluation" ? before.accountBalances :
        documentType === "JournalEntry.CPV" ? { ...before.accountBalances,
          [ACCOUNT.inventory]: before.accountBalances[ACCOUNT.inventory] + 100,
          [ACCOUNT.revaluation]: before.accountBalances[ACCOUNT.revaluation] - 100 } :
          { ...before.accountBalances, [ACCOUNT.inventory]: before.accountBalances[ACCOUNT.inventory] + 100,
            [ACCOUNT.revaluation]: before.accountBalances[ACCOUNT.revaluation] - 100,
            [ACCOUNT.cpv]: before.accountBalances[ACCOUNT.cpv] + 100, [ACCOUNT.transit]: before.accountBalances[ACCOUNT.transit] - 100 };
      const fresh = await preflight(writer, closingId, expectedBalances, {
        afterRevaluation, revaluationDocNum: afterRevaluation ? execution.documents[0]?.docNum : null,
        expectedRevaluationMarkers: afterRevaluation ? 1 : 0,
        expectedJournalMarkers: documentType === "JournalEntry.Closing" ? 1 : 0
      });
      const intent = JSON.parse(await readFile(INTENT, "utf8"));
      intent.attempts.push({ documentType, requestHash: pdoc.requestHash, attemptCount: pdoc.attemptCount,
        attemptStartedAt: pdoc.attemptStartedAt, payload: body, immediatePreflight: fresh,
        actualFinancialPostsSoFar: posts });
      await saveJson(INTENT, intent);
      const dispatch = writer.postTechnicalPhase7EDocument(documentType, body);
      posts++;
      const response = await dispatch;
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) throw new lib.DefiniteGgfDocumentRejection(response.status, Number(response.errorCode));
        throw new Error("SAP response uncertain; no retry permitted");
      }
      const row = response.data;
      const docEntry = Number(documentType === "MaterialRevaluation" ? row.DocEntry : row.JdtNum);
      const docNum = Number(documentType === "MaterialRevaluation" ? row.DocNum : row.Number);
      const transId = Number(documentType === "MaterialRevaluation" ? row.TransNum : row.JdtNum);
      must([docEntry, docNum, transId].every(n => Number.isSafeInteger(n) && n > 0), "SAP response lacks document IDs");
      return { docEntry, docNum, transId, response: documentType === "MaterialRevaluation" ?
        { DocEntry: docEntry, DocNum: docNum, TransNum: transId, Reference1: row.Reference1, Comments: row.Comments } :
        { JdtNum: docEntry, Number: docNum, Memo: row.Memo, Reference: row.Reference } };
    },
    async reconcile(input) {
      const req = requests[input.documentType];
      if (!req) return { complete: false, matches: [] };
      let docs = [];
      if (input.knownDocEntry !== null) {
        const response = await writer.get(`${input.documentType === "MaterialRevaluation" ? "MaterialRevaluation" : "JournalEntries"}(${input.knownDocEntry})`);
        if (!response.ok) return { complete: false, matches: [] };
        docs = [response.data];
      } else if (input.documentType === "MaterialRevaluation") {
        const filter = encodeURIComponent(`Comments eq '${req.Comments}'`), count = await writer.get(`MaterialRevaluation/$count?$filter=${filter}`),
          page = await writer.get(`MaterialRevaluation?$filter=${filter}&$top=100`);
        if (!count.ok || !page.ok || !Array.isArray(page.data.value) || page.data["odata.nextLink"] ||
            Number(count.data) !== page.data.value.length) return { complete: false, matches: [] };
        docs = page.data.value;
      } else {
        const filter = encodeURIComponent(`Reference eq '${req.Reference}' and Memo eq '${req.Memo}'`), count = await writer.get(`JournalEntries/$count?$filter=${filter}`),
          page = await writer.get(`JournalEntries?$filter=${filter}&$top=100`);
        if (!count.ok || !page.ok || !Array.isArray(page.data.value) || page.data["odata.nextLink"] ||
            Number(count.data) !== page.data.value.length) return { complete: false, matches: [] };
        docs = page.data.value;
      }
      const good = [];
      for (const doc of docs) {
        if (input.documentType === "MaterialRevaluation") {
          if (!validRevaluation(doc, req)) continue;
          const journal = await writer.get(`JournalEntries(${doc.TransNum})`);
          if (!journal.ok) return { complete: false, matches: [] };
          const jr = { Reference: req.Reference1, Memo: req.JournalMemo, ReferenceDate: DATE, DueDate: DATE, TaxDate: DATE,
            JournalEntryLines: [{ AccountCode: ACCOUNT.inventory, Debit: 1, Credit: 0, BPLID: BRANCH },
              { AccountCode: ACCOUNT.revaluation, Debit: 0, Credit: 1, BPLID: BRANCH }] };
          if (!validJournal(journal.data, jr, input.documentType)) continue;
        } else if (!validJournal(doc, req, input.documentType)) continue;
        good.push({ docEntry: Number(input.documentType === "MaterialRevaluation" ? doc.DocEntry : doc.JdtNum),
          docNum: Number(input.documentType === "MaterialRevaluation" ? doc.DocNum : doc.Number),
          transId: Number(input.documentType === "MaterialRevaluation" ? doc.TransNum : doc.JdtNum),
          response: input.documentType === "MaterialRevaluation" ?
            { DocEntry: doc.DocEntry, DocNum: doc.DocNum, TransNum: doc.TransNum } :
            { JdtNum: doc.JdtNum, Number: doc.Number, Memo: doc.Memo, Reference: doc.Reference,
              lines: doc.JournalEntryLines.map(lineSummary) } });
      }
      if (good.length === 1 && input.documentType === "MaterialRevaluation") {
        const fifo = await writer.readAction("MaterialRevaluationFIFOService_GetMaterialRevaluationFIFO", { MaterialRevaluationFIFOParams:
          { ItemCode: ITEM, LocationCode: WAREHOUSE, LocationType: "64", ShowIssuedLayers: "tNO" } });
        const target = fifo.data?.Layers?.filter(row => row.TransactionSequenceNum === LAYER.transactionSequenceNum && row.LayerID === LAYER.layerId) ?? [];
        const freshItem = await writer.get(`Items('${ITEM}')?$select=ItemCode,QuantityOnStock,ItemWarehouseInfoCollection`);
        const wh = freshItem.data?.ItemWarehouseInfoCollection?.find(row => row.WarehouseCode === WAREHOUSE);
        if (!fifo.ok || !freshItem.ok || target.length !== 0 || wh?.InStock !== 10) return { complete: false, matches: [] };
        const nextLayer = fifo.data.Layers.filter(row => String(row.DocNumber) === String(good[0].docNum) &&
          row.DocType === "ttInventoryValuation" && row.OpenQty === 5 && row.CurrentCost === 12.2);
        if (nextLayer.length !== 1) return { complete: true, matches: [] };
      }
      return { complete: true, matches: good };
    }
  };
  const orchestrator = new lib.GgfPostingOrchestrator(store, gateway);
  const prepared = await orchestrator.prepare(closingId, 1);
  must(prepared.status === "READY_TO_POST" && prepared.documents.length === 3 && prepared.documents.every(doc => doc.status === "PENDING"),
    "Execution ledger is not a three-document pending execution");
  const beforeClaim = await preflight(writer, closingId, before.accountBalances);
  must(beforeClaim.metadataHash === before.metadataHash && beforeClaim.fifoLayer.currentUnitPrice === 12,
    "SAP changed after plan persistence and before claim");
  await saveJson(INTENT, { closingId, executionId: prepared.executionId, postingHash: plan.postingHash,
    requestHashes, attempts: [] }, true);
  await saveJson(RUN, { closingId, executionId: prepared.executionId, postingHash: plan.postingHash,
    requestHashes, orderIds, status: "LEDGER_READY", before, preClaim: beforeClaim });
  const posted = await orchestrator.post(closingId, 1, async () => {
    checkpointSession = await openHomologationSession();
    checkpointSession.bindTechnicalPhase7EContext(closingId, prepared.executionId, plan.postingHash,
      requests, requestHashes, orderIds);
    const checkClient = makeClient(checkpointSession, lib), checkClosingRepo = new lib.SapGgfClosingRepository(checkClient),
      checkPlanRepo = new lib.SapGgfPostingPlanRepository(checkClient),
      checkStore = new lib.SapGgfPostingOrchestrationStore(checkClient, ["bis_FIFO"]),
      checkExecutionRepo = new lib.SapGgfPostingExecutionRepository(checkClient),
      checkClaimRepo = new lib.SapGgfPostingClaimRepository(checkClient);
    const [checkClose, checkPlan, checkExecution, checkClaim] = await Promise.all([
      checkClosingRepo.get(closingId), checkPlanRepo.get(closingId, 1), checkStore.findExecution(prepared.executionId),
      checkClaimRepo.get(prepared.executionId)
    ]);
    const checkPreflight = await preflight(checkpointSession, closingId, before.accountBalances);
    const checkLineCount = await checkpointSession.get(`FBO_GGF_CLINE/$count?$filter=${encodeURIComponent(`U_ClosingId eq '${closingId}'`)}`);
    must(checkClose?.status === "POSTING" && checkClose.version === 5 && checkClose.lines.length === 2 &&
      JSON.stringify(checkClose.lines) === JSON.stringify(lineRows) && checkClose.postingHash === closeHash &&
      checkClose.postingBasis?.postingPlanHash === plan.postingHash && checkClose.sapMaterialRevaluationDocEntry === null &&
      checkPlan?.postingHash === plan.postingHash && Object.keys(requestHashes).every(type =>
        checkPlan.technicalRequestHashes?.[type] === requestHashes[type]) &&
      checkExecution?.executionId === prepared.executionId && checkExecution.status === "POSTING" &&
      checkExecution.postingHash === plan.postingHash && checkExecution.closingVersion === 4 &&
      checkExecution.postingPlanVersion === 1 && checkExecution.documents.length === 3 &&
      checkExecution.documents.every((doc, i) => doc.status === "PENDING" && doc.attemptCount === 0 &&
        doc.requestHash === null && lib.sameCanonicalCheckpointRequest(doc.request, null) && doc.order === i + 1 && doc.documentType ===
          ["MaterialRevaluation", "JournalEntry.CPV", "JournalEntry.Closing"][i]) &&
      checkClaim?.executionId === prepared.executionId && checkClaim.status === "POSTING" &&
      checkClaim.postingHash === plan.postingHash && checkClaim.closingVersion === 4 && checkClaim.postingPlanVersion === 1 &&
      checkLineCount.ok && Number(checkLineCount.data) === 2 && checkPreflight.fifoLayer.currentUnitPrice === 12,
      "Fresh-session pre-POST checkpoint differs; no financial document may be sent");
    await saveJson(RUN, { closingId, executionId: prepared.executionId, postingHash: plan.postingHash,
      requestHashes, orderIds, status: "PRE_POST_CHECKPOINT_PASSED", prePostCheckpoint: checkPreflight,
      persisted: { closing: checkClose.status, planVersion: checkPlan.version, claim: checkClaim.status,
        execution: checkExecution.status, documents: checkExecution.documents.map(doc => doc.status) } });
    await checkpointSession.close(); checkpointSession = null;
  });
  must(posts === 3 && posted.status === "POSTED" && posted.documents.length === 3 &&
    posted.documents.every((doc, i) => doc.status === "RECONCILED" && doc.requestHash ===
      requestHashes[["MaterialRevaluation", "JournalEntry.CPV", "JournalEntry.Closing"][i]]),
    "The exact three-document scenario did not reconcile completely");
  await writer.close(); writer = null;
  reader = await openHomologationSession();
  const readClient = makeClient(reader, lib), readClose = new lib.SapGgfClosingRepository(readClient),
    readPlans = new lib.SapGgfPostingPlanRepository(readClient), readStore = new lib.SapGgfPostingOrchestrationStore(readClient, ["bis_FIFO"]),
    readExecRepo = new lib.SapGgfPostingExecutionRepository(readClient), readClaimRepo = new lib.SapGgfPostingClaimRepository(readClient);
  reader.bindTechnicalPhase7EContext(closingId, prepared.executionId, plan.postingHash, requests, requestHashes, orderIds);
  const [freshClose, freshPlan, freshExec, freshClaim, freshRevaluation, freshCpv, freshClosing] = await Promise.all([
    readClose.get(closingId), readPlans.get(closingId, 1), readExecRepo.get(prepared.executionId), readClaimRepo.get(prepared.executionId),
    reader.get(`MaterialRevaluation(${posted.documents[0].docEntry})`), reader.get(`JournalEntries(${posted.documents[1].docEntry})`),
    reader.get(`JournalEntries(${posted.documents[2].docEntry})`)
  ]);
  must(freshClose?.status === "POSTED" && freshClose.integrityStatus === "VALID" &&
    freshClose.sapMaterialRevaluationDocEntry === posted.documents[0].docEntry && freshPlan?.postingHash === plan.postingHash &&
    JSON.stringify(freshPlan.technicalRequestHashes) === JSON.stringify(requestHashes) &&
    freshExec?.status === "POSTED" && freshClaim?.status === "POSTED" && freshExec.documents.length === 3 &&
    freshExec.documents.every((doc, i) => doc.status === "RECONCILED" && doc.requestHash === requestHashes[
      ["MaterialRevaluation", "JournalEntry.CPV", "JournalEntry.Closing"][i]]) &&
    freshRevaluation.ok && validRevaluation(freshRevaluation.data, requests.MaterialRevaluation) &&
    freshCpv.ok && validJournal(freshCpv.data, requests["JournalEntry.CPV"], "JournalEntry.CPV") &&
    freshClosing.ok && validJournal(freshClosing.data, requests["JournalEntry.Closing"], "JournalEntry.Closing"),
    "Fresh-session Closing/plan/claim/execution/PDOC/documents failed integrity readback");
  const resumeGateway = { posts: 0, async prepare(doc) { return { expectedCents: doc.totalCents, payload: requests[doc.type] }; },
    async post() { resumeGateway.posts++; throw new Error("resume must never POST"); }, async reconcile() { return { complete: false, matches: [] }; } };
  const resumed = await new lib.GgfPostingOrchestrator(readStore, resumeGateway).resumeExecution(prepared.executionId);
  must(resumed.status === "POSTED" && resumed.documents.every(doc => doc.status === "RECONCILED") && resumeGateway.posts === 0,
    "resumeExecution changed posted state or attempted a new POST");
  const finalBalances = await preflight(reader, closingId, {
    [ACCOUNT.inventory]: before.accountBalances[ACCOUNT.inventory] + 100,
    [ACCOUNT.revaluation]: before.accountBalances[ACCOUNT.revaluation], [ACCOUNT.cpv]: before.accountBalances[ACCOUNT.cpv] + 100,
    [ACCOUNT.transit]: before.accountBalances[ACCOUNT.transit], [ACCOUNT.ggf]: before.accountBalances[ACCOUNT.ggf] - 120,
    [ACCOUNT.mod]: before.accountBalances[ACCOUNT.mod] - 80
  }, { afterRevaluation: true, revaluationDocNum: posted.documents[0].docNum,
    expectedRevaluationMarkers: 1, expectedJournalMarkers: 2 });
  must(posts === 3, "Unexpected financial POST count");
  const result = { scenario: "PHASE7E_TECHNICAL", companyDB: COMPANY, closingId, orderIds, executionId: prepared.executionId,
    closingVersion: freshClose.version, postingPlanVersion: freshPlan.version, postingHash: plan.postingHash,
    requestHashes, tlsVerified: false, preflight: before, finalBalances,
    documents: posted.documents.map(doc => ({ type: doc.documentType, status: doc.status, docEntry: doc.docEntry,
      docNum: doc.docNum, transId: doc.transId, requestHash: doc.requestHash, response: doc.response,
      payload: requests[doc.documentType] })),
    economicProof: { totalAdjustmentCents: "200", stockAdjustmentCents: "100", consumedAdjustmentCents: "100",
      ggfCents: "120", modCents: "80", materialRevaluationCents: "100", cpvJournalDebitCents: "100",
      cpvJournalCreditCents: "100", closingJournalDebitCents: "200", closingJournalCreditCents: "200",
      finalTransitCents: finalBalances.accountBalances[ACCOUNT.transit],
      finalRevaluationOffsetCents: finalBalances.accountBalances[ACCOUNT.revaluation],
      stockPlusConsumedEqualsTotal: 100 + 100 === 200, closingIsReclassificationNotAdditionalCost: true },
    closing: { status: freshClose.status, integrity: freshClose.integrityStatus,
      revaluationDocEntry: freshClose.sapMaterialRevaluationDocEntry }, execution: freshExec.status, claim: freshClaim.status,
    resumeExecution: { status: resumed.status, additionalPosts: resumeGateway.posts }, actualFinancialPosts: posts };
  await saveJson(RESULT, result, true);
  await saveJson(RUN, { closingId, executionId: prepared.executionId, status: "COMPLETED", completedAt: new Date().toISOString(),
    actualFinancialPosts: posts });
  console.log(JSON.stringify(result));
} catch (error) {
  if (error instanceof Error && error.message === "PHASE7E_READ_ONLY_VALIDATION_COMPLETE") {
    process.exitCode = 0;
  } else {
    try {
      const existing = JSON.parse(await readFile(RUN, "utf8"));
      await saveJson(RUN, { ...existing,
        status: posts === 0 ? "STOPPED_PRE_FINANCIAL_POST" : "STOPPED_AFTER_FINANCIAL_ATTEMPT",
        stoppedAt: new Date().toISOString(), actualFinancialPosts: posts,
        stopReason: error instanceof Error ? error.message.slice(0, 240) : "Phase 7E failed" });
    } catch { /* Keep the SAP ledger authoritative if the local journal cannot be updated. */ }
  console.error(JSON.stringify({ scenario: "PHASE7E_TECHNICAL", stopped: true,
    error: error instanceof Error ? error.message.slice(0, 400) : "Phase 7E failed", actualFinancialPosts: posts,
    intentExists: await readFile(INTENT).then(() => true).catch(() => false) }));
  process.exitCode = 1;
  }
} finally {
  await writer?.close().catch(() => {}); await reader?.close().catch(() => {});
  await checkpointSession?.close().catch(() => {}); await lock?.close().catch(() => {});
  await unlink(LOCK).catch(() => {});
}
