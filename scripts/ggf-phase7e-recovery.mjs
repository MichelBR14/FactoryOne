import { build } from "esbuild";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openHomologationSession } from "./ggf-homologation-session.mjs";

const CLOSING = "TECH7E-20261001-6D12027067";
const EXECUTION = "F1EXdc6e237a44fcd6861b7ac8d0b510e376b9b83f62";
const PLAN_HASH = "8a29c39ba0a42e0bdcefb364756de6a320bcab4df783af6097f98c2f0d60a2c3";
const OUT = resolve(".local/ggf"), RUN = resolve(OUT, "phase7e-run.json"), INTENT = resolve(OUT, "phase7e-financial-intent.json");
const LOCK = resolve(OUT, "phase7e-recovery.lock");
const ACCOUNTS = ["1.01.02.01.01", "5.03.01.01.04", "5.01.01.01.01", "5.04.01.01.05", "5.04.01.01.03", "5.04.01.01.04"];
const EXPECTED_BALANCES = [436567550, -41128, 100, 0, -60, -40];
const DOC_TYPES = ["MaterialRevaluation", "JournalEntry.CPV", "JournalEntry.Closing"];
const ORDER_IDS = {
  MaterialRevaluation: "7E-MR-01-AD57E09C1AD7ABC9",
  "JournalEntry.CPV": "7E-CPV-02-2F34420DA76666C0",
  "JournalEntry.Closing": "7E-CLS-03-AEA8BE3BB6BE7807"
};
const CENTS = value => {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n * 100 - Math.round(n * 100)) > 1e-7) throw new Error("SAP balance is not exact to cents");
  return Math.round(n * 100);
};
const must = (condition, message) => { if (!condition) throw new Error(message); };

async function saveJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
}

async function loadRuntime() {
  const outfile = resolve(OUT, "phase7e-recovery-runtime.mjs");
  await build({ stdin: { resolveDir: process.cwd(), contents: `
export { SapGgfClosingRepository } from "./webapp/modules/ggf/repository/SapGgfClosingRepository.ts";
export { SapGgfPostingPlanRepository } from "./webapp/modules/ggf/repository/SapGgfPostingPlanRepository.ts";
export { SapGgfPostingClaimRepository, SapGgfPostingExecutionRepository } from "./webapp/modules/ggf/repository/SapGgfPostingExecutionRepository.ts";
export { SapGgfPostingOrchestrationStore } from "./webapp/modules/ggf/repository/SapGgfPostingOrchestrationStore.ts";
export { GgfPostingOrchestrator } from "./webapp/modules/ggf/service/GgfPostingOrchestrator.ts";
export { buildPhase7EEconomicScenario } from "./webapp/modules/ggf/service/GgfPhase7EEconomicScenario.ts";
export { buildPhase7EOrderIds } from "./webapp/modules/ggf/service/GgfPhase7EOrderId.ts";
export { calculateGgfPostingPlanHash } from "./webapp/modules/ggf/service/GgfPostingPlan.ts";
export { postingHash } from "./webapp/modules/ggf/service/GgfClosing.ts";
export { calculateGgfRequestHash } from "./webapp/modules/ggf/service/GgfPostingExecution.ts";
export { ServiceLayerError } from "./webapp/core/service/errors.ts";
` }, outfile, platform: "node", format: "esm", bundle: true });
  return import(pathToFileURL(outfile).href + `?v=${Date.now()}`);
}

function client(session, lib) {
  const value = response => {
    if (!response.ok) throw new lib.ServiceLayerError("SAP request rejected", response.status,
      response.errorCode, response.errorMessage);
    return response.data;
  };
  return {
    async get(path) { return value(await session.get(path, { Prefer: "odata.maxpagesize=100" })); },
    async post(path, body) { return value(await session.postTechnicalPhase7ERecord(path, body)); },
    async patch(path, body) { return value(await session.patchTechnicalPhase7ERecord(path, body)); }
  };
}

async function count(session, entity, filter) {
  const response = await session.get(`${entity}/$count?$filter=${encodeURIComponent(filter)}`);
  must(response.ok && Number.isSafeInteger(Number(response.data)), `${entity} evidence query incomplete`);
  return Number(response.data);
}

async function externalDocumentEvidence(session) {
  const filters = [
    ["MaterialRevaluation", "Comments", `TECH7E-20261001-6D12027067`],
    ["MaterialRevaluation", "Reference1", CLOSING],
    ["JournalEntries", "Memo", CLOSING],
    ["JournalEntries", "Reference", CLOSING]
  ];
  const evidence = [];
  for (const [entity, field, token] of filters) {
    const filter = entity === "MaterialRevaluation" && field === "Comments"
      ? `contains(${field},'${token}')` : entity === "JournalEntries" && field === "Memo"
        ? `contains(${field},'${token}')` : `${field} eq '${token}'`;
    evidence.push({ entity, field, count: await count(session, entity, filter) });
  }
  must(evidence.every(row => row.count === 0), "Financial document evidence exists for the technical scenario");
  return evidence;
}

async function verifyTechnicalState(session, lib, scenario, hashes) {
  const api = client(session, lib);
  const closingRepo = new lib.SapGgfClosingRepository(api);
  const plans = new lib.SapGgfPostingPlanRepository(api);
  const claims = new lib.SapGgfPostingClaimRepository(api);
  const executions = new lib.SapGgfPostingExecutionRepository(api);
  const [closing, plan, allPlans, claim, execution, pdocCount, lineCount, rawPdocs, rawLines,
    entityClaimCount, entityExecutionCount] = await Promise.all([
    closingRepo.get(CLOSING), plans.get(CLOSING, 1), plans.list(CLOSING), claims.get(EXECUTION), executions.get(EXECUTION),
    count(session, "FBO_GGF_PDOC", `U_ExecutionId eq '${EXECUTION}'`),
    count(session, "FBO_GGF_CLINE", `U_ClosingId eq '${CLOSING}'`),
    api.get(`FBO_GGF_PDOC?$filter=${encodeURIComponent(`U_ExecutionId eq '${EXECUTION}'`)}&$orderby=U_Sequence&$top=10`),
    api.get(`FBO_GGF_CLINE?$filter=${encodeURIComponent(`U_ClosingId eq '${CLOSING}'`)}&$orderby=Code&$top=10`),
    count(session, "FBO_GGF_CLAIM", `U_ExecutionId eq '${EXECUTION}'`),
    count(session, "FBO_GGF_PEXEC", `Code eq '${EXECUTION}'`)
  ]);
  must(closing && plan && allPlans.length === 1 && claim && execution, "A required SAP ledger record is missing or duplicated");
  const recoveryEvent = (() => { try { return JSON.parse(execution.lastError ?? "null"); } catch { return null; } })();
  const phase = closing.status === "FAILED" && claim.status === "FAILED" && execution.status === "FAILED" &&
    execution.lastError === "PRE_POST_CHECK_FAILED" ? "FAILED" :
    closing.status === "READY_TO_POST" && closing.version === 7 && claim.status === "CLAIMED" &&
      execution.status === "FAILED" ? "RECOVERY_PARTIAL" :
    closing.status === "READY_TO_POST" && closing.version === 7 && claim.status === "CLAIMED" &&
      execution.status === "READY" ? "READY" : "INVALID";
  must(phase !== "INVALID", "Closing/Claim/Execution do not match an approved recovery checkpoint");
  if (phase !== "FAILED") must(recoveryEvent?.failureCategory === "PRE_POST_CHECKPOINT_SERIALIZATION_ERROR" &&
    recoveryEvent.failureDetail === "NULL_VS_EMPTY_REQUEST_NORMALIZATION" &&
    recoveryEvent.originalError === "PRE_POST_CHECK_FAILED" && recoveryEvent.RecoveryFromStatus === "FAILED" &&
    recoveryEvent.RecoveryCount === 1 && recoveryEvent.RecoveryReason ===
      "Manually authorized after canonical empty-request checkpoint fix" && recoveryEvent.RecoveryAuthorizedAt,
    "Partial recovery has no exact matching authorization event");
  must(closing.status === (phase === "FAILED" ? "FAILED" : "READY_TO_POST") && closing.version === (phase === "FAILED" ? 6 : 7) &&
    closing.sapMaterialRevaluationDocEntry === null &&
    closing.sapMaterialRevaluationDocNum === null && closing.sapJournalEntryDocEntry === null &&
    closing.sapJournalEntryDocNum === null && closing.sapJournalTransId === null && closing.lines.length === 2,
    "Closing no longer matches the exact unposted FAILED checkpoint");
  must(await lib.postingHash(closing.postingBasis) === closing.postingHash,
    "Closing functional hash does not recalculate from its persisted basis");
  must(plan.version === 1 && plan.closingVersion === 4 && plan.postingHash === PLAN_HASH &&
    await lib.calculateGgfPostingPlanHash(plan) === PLAN_HASH && plan.technicalRequestHashes &&
    DOC_TYPES.every(type => plan.technicalRequestHashes[type] === hashes[type]) &&
    JSON.stringify(plan.technicalRequestHashes) === JSON.stringify(scenario.documents.reduce((result, row) => {
      result[row.type] = row.requestHash; return result;
    }, {})), "PostingPlan v1 or its RequestHashes are not intact");
  must(claim.status === (phase === "FAILED" ? "FAILED" : "CLAIMED") && claim.closingId === CLOSING && claim.closingVersion === 4 &&
    claim.postingPlanVersion === 1 && claim.postingHash === PLAN_HASH &&
    execution.status === (phase === "READY" ? "READY" : "FAILED") &&
    (phase === "FAILED" ? execution.lastError === "PRE_POST_CHECK_FAILED" :
      execution.lastError.includes("PRE_POST_CHECKPOINT_SERIALIZATION_ERROR")) &&
    execution.identity.closingId === CLOSING &&
    execution.identity.closingVersion === 4 && execution.identity.postingPlanVersion === 1 && execution.identity.postingHash === PLAN_HASH &&
    claim.executionId === EXECUTION && execution.executionId === EXECUTION,
    "Claim/Execution identity or pre-POST FAILED states differ");
  must(entityClaimCount === 1 && entityExecutionCount === 1 && pdocCount === 3 && rawPdocs.value?.length === 3 &&
    lineCount === 2 && rawLines.value?.length === 2 && execution.documents.length === 3,
    "Independent ledger counts differ from persisted rows");
  must(execution.documents.every((doc, index) => doc.sequence === index + 1 && doc.documentType === DOC_TYPES[index] &&
    doc.status === "PENDING" && doc.attemptCount === 0 && doc.attemptStartedAt === null &&
    doc.responseReceivedAt === null && doc.requestHash === null && doc.request === null && doc.response === null &&
    doc.sapDocEntry === null && doc.sapDocNum === null && doc.sapTransId === null && doc.attempts.length === 0),
    "At least one PDOC contains a sent, attempted or ambiguous state");
  const expectedOrderIds = await lib.buildPhase7EOrderIds(CLOSING);
  must(JSON.stringify(expectedOrderIds) === JSON.stringify(ORDER_IDS) && Object.values(ORDER_IDS).every(id => id.length <= 30) &&
    closing.lines[0]?.orderId === ORDER_IDS.MaterialRevaluation && closing.lines[1]?.orderId === ORDER_IDS["JournalEntry.CPV"] &&
    closing.lines[0]?.allocated === "1.20" && closing.lines[0]?.revaluation === "0.60" &&
    closing.lines[1]?.allocated === "0.80" && closing.lines[1]?.revaluation === "0.40" &&
    rawLines.value.every(row => row.U_Version === "2" && Number(row.U_OrderId?.length) <= 30),
    "Persisted CLINE rows or deterministic OrderIds differ from the approved scenario");
  const balances = {};
  for (let index = 0; index < ACCOUNTS.length; index++) {
    const account = await api.get(`ChartOfAccounts('${ACCOUNTS[index]}')`);
    balances[ACCOUNTS[index]] = CENTS(account.Balance);
    must(balances[ACCOUNTS[index]] === EXPECTED_BALANCES[index], `SAP balance changed for ${ACCOUNTS[index]}`);
  }
  const [item, fifo] = await Promise.all([
    api.get("Items('F1GGF26F01')?$select=ItemCode,CostAccountingMethod,InventoryUOM,QuantityOnStock,ItemWarehouseInfoCollection"),
    session.readAction("MaterialRevaluationFIFOService_GetMaterialRevaluationFIFO", { MaterialRevaluationFIFOParams:
      { ItemCode: "F1GGF26F01", LocationCode: "01", LocationType: "64", ShowIssuedLayers: "tNO" } })
  ]);
  const layers = fifo.data?.Layers?.filter(row => row.TransactionSequenceNum === 2790 && row.LayerID === 0) ?? [];
  must(item.ItemCode === "F1GGF26F01" && item.CostAccountingMethod === "bis_FIFO" && item.InventoryUOM === "UN" &&
    item.ItemWarehouseInfoCollection?.find(row => row.WarehouseCode === "01")?.InStock === 10 && fifo.ok && layers.length === 1 &&
    layers[0].OpenQty === 5 && layers[0].CurrentCost === 12 && String(layers[0].DocNumber) === "76" &&
    layers[0].DocType === "ttGeneralReceiptToStock", "Authorized FIFO layer changed from 5 UN at R$ 12.00");
  const financialEvidence = await externalDocumentEvidence(session);
  return { closing, plan, claim, execution, rawPdocs: rawPdocs.value, rawLines: rawLines.value,
    balances, item, fifoLayer: layers[0], financialEvidence, phase };
}

let writer, reader, lock;
try {
  await mkdir(OUT, { recursive: true, mode: 0o700 });
  lock = await open(LOCK, "wx", 0o600);
  const lib = await loadRuntime();
  const localRun = JSON.parse(await readFile(RUN, "utf8"));
  const localIntent = JSON.parse(await readFile(INTENT, "utf8"));
  must(localRun.closingId === CLOSING && localRun.actualFinancialPosts === 0 &&
    Array.isArray(localIntent.attempts) && localIntent.attempts.length === 0,
    "Local write-ahead records show a financial attempt; SAP reconciliation is required instead of recovery");
  const scenario = await lib.buildPhase7EEconomicScenario({ closingId: CLOSING });
  const requestHashes = Object.fromEntries(scenario.documents.map(document => [document.type, document.requestHash]));
  const requests = Object.fromEntries(scenario.documents.map(document => [document.type, document.request]));
  writer = await openHomologationSession();
  writer.bindTechnicalPhase7EContext(CLOSING, EXECUTION, PLAN_HASH, requests, requestHashes, ORDER_IDS);
  const before = await verifyTechnicalState(writer, lib, scenario, requestHashes);
  const api = client(writer, lib);
  const store = new lib.SapGgfPostingOrchestrationStore(api, ["bis_FIFO"]);
  let realFinancialPosts = 0;
  const readOnlyGateway = {
    async prepare(document) {
      const source = scenario.documents.find(row => row.type === document.type);
      must(source && source.amountCents === document.totalCents && source.requestHash === requestHashes[document.type],
        "Scenario request does not match the existing PostingPlan");
      return { payload: source.request, expectedCents: source.amountCents };
    },
    async post() { realFinancialPosts++; throw new Error("Recovery gateway prohibits financial POST"); },
    async reconcile(input) {
      const matches = [];
      const filters = input.documentType === "MaterialRevaluation"
        ? [["MaterialRevaluation", `contains(Comments,'${CLOSING}')`], ["MaterialRevaluation", `Reference1 eq '${CLOSING}'`]]
        : [["JournalEntries", `contains(Memo,'${CLOSING}')`], ["JournalEntries", `Reference eq '${CLOSING}'`]];
      for (const [entity, filter] of filters) {
        const amount = await count(writer, entity, filter);
        if (amount !== 0) matches.push({ evidenceCount: amount });
      }
      return { complete: true, matches };
    }
  };
  const orchestrator = new lib.GgfPostingOrchestrator(store, readOnlyGateway);
  const recovered = await orchestrator.recoverPrePostFailedExecution(CLOSING, 1,
    "Manually authorized after canonical empty-request checkpoint fix");
  must(recovered.status === "READY_TO_POST" && recovered.documents.length === 3 &&
    recovered.documents.every(document => document.status === "PENDING" && document.attemptCount === 0) &&
    recovered.error.includes("PRE_POST_CHECKPOINT_SERIALIZATION_ERROR") && realFinancialPosts === 0,
    "Explicit recovery did not stop in the zero-attempt READY state");
  await writer.close(); writer = null;

  reader = await openHomologationSession();
  reader.bindTechnicalPhase7EContext(CLOSING, EXECUTION, PLAN_HASH, requests, requestHashes, ORDER_IDS);
  const after = await verifyTechnicalState(reader, lib, scenario, requestHashes);
  must(after.closing.status === "READY_TO_POST" && after.closing.version === 7 &&
    after.claim.status === "CLAIMED" && after.execution.status === "READY" &&
    after.execution.lastError.includes("PRE_POST_CHECKPOINT_SERIALIZATION_ERROR") &&
    after.execution.lastError.includes("PRE_POST_CHECK_FAILED") &&
    after.execution.documents.every(document => document.status === "PENDING" && document.attemptCount === 0) &&
    realFinancialPosts === 0, "Fresh-session recovery readback differs or a financial POST was attempted");
  const parsedAudit = JSON.parse(after.execution.lastError);
  must(parsedAudit.failureCategory === "PRE_POST_CHECKPOINT_SERIALIZATION_ERROR" &&
    parsedAudit.failureDetail === "NULL_VS_EMPTY_REQUEST_NORMALIZATION" &&
    parsedAudit.originalError === "PRE_POST_CHECK_FAILED" && parsedAudit.failedAt &&
    parsedAudit.RecoveryAuthorizedAt && parsedAudit.RecoveryReason && parsedAudit.RecoveryFromStatus === "FAILED" &&
    parsedAudit.RecoveryCount === 1, "Persisted recovery audit is incomplete");
  const result = { closingId: CLOSING, executionId: EXECUTION, postingPlanVersion: 1,
    postingHash: PLAN_HASH, claimBefore: "FAILED", executionBefore: "FAILED", closingBefore: "FAILED",
    preconditions: { pplanRecalculated: true, exactPdocs: 3, allPending: true, allAttemptCountsZero: true,
      noSapDocumentReferences: true, cLineCount: before.rawLines.length, claimCount: 1, executionCount: 1,
      fifoLayer: { sequence: 2790, layerId: 0, openQuantity: 5, unitCost: 12, unit: "UN", receiptDocNum: "76" },
      accountBalancesCents: before.balances, financialEvidence: before.financialEvidence },
    failureAudit: parsedAudit, recovered: { closingStatus: after.closing.status, closingLifecycleVersion: after.closing.version,
      claimStatus: after.claim.status, executionStatus: "READY_TO_POST",
      documents: after.execution.documents.map(document => ({ type: document.documentType,
        status: document.status, attemptCount: document.attemptCount })), requestHashes },
    freshSession: { node: reader.routeNode ?? null, verified: true, postingHash: after.plan.postingHash,
      claim: after.claim.status, execution: after.execution.status, pdocCount: after.rawPdocs.length,
      fifoLayerUnchanged: true, balancesUnchanged: true, financialDocumentEvidence: after.financialEvidence },
    canonicalizationTests: "see npm test results", actualFinancialPosts: realFinancialPosts };
  await saveJson(RUN, { ...localRun, status: "RECOVERED_PRE_POST_FAILED", recoveryCompletedAt: new Date().toISOString(),
    recovery: result, actualFinancialPosts: 0 });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ recovery: "STOPPED", error: error instanceof Error ? error.message : "unknown error",
    financialPosts: 0 }));
  process.exitCode = 1;
} finally {
  await writer?.close().catch(() => {});
  await reader?.close().catch(() => {});
  await lock?.close().catch(() => {});
  if (lock) await unlink(LOCK).catch(() => {});
}
