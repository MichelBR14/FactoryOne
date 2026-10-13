import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openHomologationSession } from "./ggf-homologation-session.mjs";

const CLOSING_ID = "TECH7E-20261001-C2B8A14D73";
const EXECUTION_ID = "F1EX8e69095772d441b85577de5508f7070f1e4db4d2";
const POSTING_HASH = "5e19b21753be8646083218d08ceed32cc706cf347fb61833ad8542b613b9a649";
const REQUEST_HASHES = {
  MaterialRevaluation: "5552d6b211fe230f2123abd61c839277d38da6a7d2313f60a7550abdc4836939",
  "JournalEntry.CPV": "d352c0739212e83a781740962ea5a8e0385e733f54010144a297985abdd0efbd",
  "JournalEntry.Closing": "47a059b4f67598d749e98a0d8ccd953658de1b503ca32964cf4c54a72d908157"
};
const EXPECTED = { docEntry: 44, docNum: 7, transId: 2311, itemCode: "F1GGF26F01", warehouseCode: "01",
  sourceSequence: 2790, sourceLayerId: 0, quantity: 5, unitCostBefore: 12, unitCostAfter: 12.2,
  branch: 1, currency: "R$", revaluationAccount: "5.03.01.01.04", debitAccount: "1.01.02.01.01",
  creditAccount: "5.03.01.01.04", amountCents: 100 };
const OUTPUT = resolve(".local/ggf/phase7e-reconciliation-C2B8A14D73.json");
const required = (value, message) => { if (!value) throw new Error(message); };

async function loadRuntime() {
  const output = resolve(".local/ggf/phase7e-reconcile-runtime.mjs");
  await build({ stdin: { resolveDir: process.cwd(), contents: `
    export { SapGgfClosingRepository } from "./webapp/modules/ggf/repository/SapGgfClosingRepository.ts";
    export { SapGgfPostingPlanRepository } from "./webapp/modules/ggf/repository/SapGgfPostingPlanRepository.ts";
    export { SapGgfPostingClaimRepository, SapGgfPostingExecutionRepository } from "./webapp/modules/ggf/repository/SapGgfPostingExecutionRepository.ts";
    export { SapGgfPostingOrchestrationStore } from "./webapp/modules/ggf/repository/SapGgfPostingOrchestrationStore.ts";
    export { buildPhase7EEconomicScenario } from "./webapp/modules/ggf/service/GgfPhase7EEconomicScenario.ts";
    export { buildPhase7EOrderIds } from "./webapp/modules/ggf/service/GgfPhase7EOrderId.ts";
    export { reconcileFifoMaterialRevaluation } from "./webapp/modules/ggf/service/FifoRevaluationEvidence.ts";
    export { ServiceLayerError } from "./webapp/core/service/errors.ts";
  ` }, outfile: output, platform: "node", format: "esm", bundle: true });
  return import(pathToFileURL(output).href + `?v=${Date.now()}`);
}

function clientFor(session, lib) {
  const unwrap = response => {
    if (!response.ok) throw new lib.ServiceLayerError("SAP request rejected", response.status,
      response.errorCode, response.errorMessage);
    return response.data;
  };
  return {
    async get(path) { return unwrap(await session.get(path, { Prefer: "odata.maxpagesize=100" })); },
    async post() { throw new Error("Financial or technical POST is disabled in reconciliation flow"); },
    async patch(path, body) { return unwrap(await session.patchTechnicalPhase7ERecord(path, body)); }
  };
}

function layerSummary(row) {
  return { sequence: Number(row.TransactionSequenceNum), layerId: Number(row.LayerID), openQty: Number(row.OpenQty),
    currentCost: Number(row.CurrentCost), docNumber: String(row.DocNumber), docType: row.DocType };
}

async function readEvidence(lib) {
  const session = await openHomologationSession();
  try {
    const client = clientFor(session, lib);
    const closingRepo = new lib.SapGgfClosingRepository(client);
    const plans = new lib.SapGgfPostingPlanRepository(client);
    const executions = new lib.SapGgfPostingExecutionRepository(client);
    const claims = new lib.SapGgfPostingClaimRepository(client);
    const scenario = await lib.buildPhase7EEconomicScenario({ closingId: CLOSING_ID });
    const requests = Object.fromEntries(scenario.documents.map(document => [document.type, document.request]));
    const requestHashes = Object.fromEntries(scenario.documents.map(document => [document.type, document.requestHash]));
    const orderIds = await lib.buildPhase7EOrderIds(CLOSING_ID);
    const metadata = await session.get("$metadata", "application/xml");
    required(metadata.ok && ["FBO_GGF_CLOSE", "FBO_GGF_CLINE", "FBO_GGF_CLAIM", "FBO_GGF_PPLAN",
      "FBO_GGF_PEXEC", "FBO_GGF_PDOC"].every(name => metadata.data.includes(`Name=\"${name}\"`)),
    "SAP metadata does not expose all closing ledger entities");
    session.bindTechnicalPhase7EContext(CLOSING_ID, EXECUTION_ID, POSTING_HASH, requests, requestHashes, orderIds);

    const [closing, plan, claim, executionHeaderResponse, executionDocsResponse, revaluationResponse, journalResponse, fifo, linesCount, linesResponse] = await Promise.all([
      closingRepo.get(CLOSING_ID), plans.get(CLOSING_ID, 1), claims.get(EXECUTION_ID),
      session.get(`FBO_GGF_PEXEC('${EXECUTION_ID}')`),
      session.get(`FBO_GGF_PDOC?$filter=${encodeURIComponent(`U_ExecutionId eq '${EXECUTION_ID}'`)}&$orderby=U_Sequence&$top=10`),
      session.get("MaterialRevaluation(44)"), session.get("JournalEntries(2311)"),
      session.readAction("MaterialRevaluationFIFOService_GetMaterialRevaluationFIFO", {
        MaterialRevaluationFIFOParams: { ItemCode: "F1GGF26F01", LocationCode: "01", LocationType: "64", ShowIssuedLayers: "tNO" }
      }),
      client.get(`FBO_GGF_CLINE/$count?$filter=${encodeURIComponent(`U_ClosingId eq '${CLOSING_ID}'`)}`),
      client.get(`FBO_GGF_CLINE?$filter=${encodeURIComponent(`U_ClosingId eq '${CLOSING_ID}'`)}&$orderby=Code&$top=100`)
    ]);
    const revaluation = revaluationResponse.data;
    const journal = journalResponse.data;
    const rawHeader = executionHeaderResponse.data;
    const rawDocs = executionDocsResponse.data?.value;
    required(closing && plan && claim && executionHeaderResponse.ok && rawHeader &&
      executionDocsResponse.ok && Array.isArray(rawDocs) && rawDocs.length === 3,
    "Closing, PostingPlan, Claim, or Execution ledger is missing");
    const execution = { executionId: rawHeader.Code, status: rawHeader.U_Status,
      identity: { closingId: rawHeader.U_ClosingId, closingVersion: Number(rawHeader.U_ClosingVersion),
        postingPlanVersion: Number(rawHeader.U_PostingPlanVersion), postingHash: rawHeader.U_PostingHash },
      lastError: rawHeader.U_LastError, totalExpected: rawHeader.U_TotalExpected,
      totalPosted: rawHeader.U_TotalPosted, totalReconciled: rawHeader.U_TotalReconciled,
      documents: rawDocs.map(row => ({ sequence: Number(row.U_Sequence), documentType: row.U_DocumentType,
        status: row.U_Status, attemptCount: Number(row.U_AttemptCount), requestHash: row.U_RequestHash || null,
        request: row.U_Request ? JSON.parse(row.U_Request) : null,
        response: row.U_Response ? JSON.parse(row.U_Response) : null,
        dependencies: JSON.parse(row.U_Dependencies || "[]"), sapDocEntry: row.U_SapDocEntry ? Number(row.U_SapDocEntry) : null,
        sapDocNum: row.U_SapDocNum ? Number(row.U_SapDocNum) : null, sapTransId: row.U_SapTransId ? Number(row.U_SapTransId) : null,
        reconciledAt: row.U_ReconciledAt || null, reconciliationStatus: row.U_ReconStatus,
        attempts: JSON.parse(row.U_AttemptHistory || "[]") })) };
    required(["POSTING_UNCERTAIN", "POSTING_PARTIAL"].includes(closing.status) &&
      closing.integrityStatus !== "INTEGRITY_VIOLATION" &&
      closing.postingBasis?.postingPlanHash === POSTING_HASH, "Closing state or plan binding differs");
    required(plan.version === 1 && plan.status === "VALIDATED" && plan.postingHash === POSTING_HASH &&
      plan.technicalRequestHashes && JSON.stringify(plan.technicalRequestHashes) === JSON.stringify(REQUEST_HASHES),
    "PostingPlan v1 hash or request hashes differ");
    required(["POSTING_UNCERTAIN", "POSTING_PARTIAL"].includes(claim.status) && claim.executionId === EXECUTION_ID &&
      claim.closingId === CLOSING_ID && claim.closingVersion === 4 && claim.postingPlanVersion === 1 &&
      claim.postingHash === POSTING_HASH, `Claim identity/status differs: ${JSON.stringify(claim)}`);
    required(["POSTING_UNCERTAIN", "POSTING_PARTIAL"].includes(execution.status) && execution.executionId === EXECUTION_ID &&
      execution.identity.closingId === CLOSING_ID && execution.identity.closingVersion === 4 &&
      execution.identity.postingPlanVersion === 1 && execution.identity.postingHash === POSTING_HASH &&
      execution.documents.length === 3, "Execution identity/status/document count differs");
    const [first, second, third] = execution.documents;
    required(first?.documentType === "MaterialRevaluation" && ["UNCERTAIN", "RECONCILED"].includes(first.status) && first.attemptCount === 1 &&
      first.requestHash === REQUEST_HASHES.MaterialRevaluation && first.sapDocEntry === 44 && first.sapDocNum === 7 &&
      first.sapTransId === 2311 && second?.documentType === "JournalEntry.CPV" && second.status === "PENDING" &&
      second.attemptCount === 0 && second.sapDocEntry === null && second.sapDocNum === null && second.sapTransId === null &&
      second.requestHash === null && third?.documentType === "JournalEntry.Closing" &&
      third.status === "PENDING" && third.attemptCount === 0 && third.sapDocEntry === null && third.sapDocNum === null &&
      third.sapTransId === null && third.requestHash === null,
    `PDOC statuses, attempts, IDs, or RequestHashes differ from approved state: ${JSON.stringify(execution.documents.map(doc => ({
      type: doc.documentType, status: doc.status, attemptCount: doc.attemptCount, requestHash: doc.requestHash,
      docEntry: doc.sapDocEntry, docNum: doc.sapDocNum, transId: doc.sapTransId, dependencies: doc.dependencies
    })))}`);
    required(Number(linesCount) === 2 && Array.isArray(linesResponse.value) && linesResponse.value.length === 2,
      `Closing line count is not exactly two (count=${linesCount}, rows=${linesResponse.value?.length ?? "invalid"})`);
    required(revaluationResponse.ok && journalResponse.ok && Number(revaluation?.DocEntry) === 44 &&
      Number(revaluation?.DocNum) === 7 && Number(journal?.JdtNum) === 2311,
      `SAP document identities differ: ${JSON.stringify({ revaluation: revaluation && { DocEntry: revaluation.DocEntry,
        DocNum: revaluation.DocNum, TransNum: revaluation.TransNum, TransId: revaluation.TransId },
        journal: journal && { JdtNum: journal.JdtNum, Number: journal.Number } })}`);
    required(fifo.ok && Array.isArray(fifo.data?.Layers), "FIFO layer read failed");
    const sourceCheckpoint = JSON.parse(await readFile(".local/ggf/phase7e-fresh-C2B8A14D73-run.json", "utf8"))
      .prePostCheckpoint?.fifoLayer;
    required(sourceCheckpoint && sourceCheckpoint.sequence === EXPECTED.sourceSequence &&
      sourceCheckpoint.layerId === EXPECTED.sourceLayerId && sourceCheckpoint.openQuantity === EXPECTED.quantity &&
      sourceCheckpoint.currentUnitPrice === EXPECTED.unitCostBefore && sourceCheckpoint.receiptDocNum === "76",
    "Pre-POST SAP layer evidence does not match the approved source layer");
    const sourceLayer = { TransactionSequenceNum: sourceCheckpoint.sequence, LayerID: sourceCheckpoint.layerId,
      OpenQty: sourceCheckpoint.openQuantity, CurrentCost: sourceCheckpoint.currentUnitPrice,
      DocNumber: sourceCheckpoint.receiptDocNum, DocType: "ttGeneralReceiptToStock", ItemCode: "F1GGF26F01", WarehouseCode: "01" };
    const matches = fifo.data.Layers.filter(row => String(row.DocNumber) === String(EXPECTED.docNum) &&
      row.DocType === "ttInventoryValuation");
    required(matches.length === 1, "Expected exactly one resulting FIFO valuation layer");
    const resultingLayer = matches[0];
    const proof = lib.reconcileFifoMaterialRevaluation({ document: revaluation, journalEntry: journal,
      sourceLayer, resultingLayer, expected: EXPECTED });
    required(proof.matched, `FIFO evidence mismatch: ${proof.reasons.join(",")}`);
    required(revaluation.Comments === `FactoryOne PHASE7E_TECHNICAL ${CLOSING_ID}` &&
      revaluation.JournalMemo === `FactoryOne PHASE7E_TECHNICAL ${CLOSING_ID}` &&
      journal.Memo === `FactoryOne PHASE7E_TECHNICAL ${CLOSING_ID}`,
    "Document human-audit markers do not identify the existing closing");
    const journalLines = journal.JournalEntryLines.map(row => ({ account: row.AccountCode,
      debitCents: Math.round(Number(row.Debit) * 100), creditCents: Math.round(Number(row.Credit) * 100),
      branch: Number(row.BPLID), currency: row.FCCurrency ?? null,
      dimensions: [row.ProjectCode, row.CostingCode, row.CostingCode2, row.CostingCode3,
        row.CostingCode4, row.CostingCode5].map(value => value ?? null) }));
    const beforeBalances = { inventoryCents: 436567550, revaluationCents: -41128 };
    const accountRows = await Promise.all(["1.01.02.01.01", "5.03.01.01.04"].map(code => client.get(`ChartOfAccounts('${code}')`)));
    const afterBalances = { inventoryCents: Math.round(Number(accountRows[0].Balance) * 100),
      revaluationCents: Math.round(Number(accountRows[1].Balance) * 100) };
    required(afterBalances.inventoryCents - beforeBalances.inventoryCents === 100 &&
      afterBalances.revaluationCents - beforeBalances.revaluationCents === -100,
    "Account balance effects do not match the one-real balance snapshot and linked Journal Entry");
    const lineAudit = linesResponse.value.map(row => ({ code: row.Code, orderId: row.U_OrderId,
      account: row.U_Account, allocated: row.U_Allocated, revaluation: row.U_Revaluation,
      costBefore: row.U_CostBefore, costAfter: row.U_CostAfter, item: row.U_Item, warehouse: row.U_Warehouse,
      status: row.U_Status }));
    required(lineAudit.every(row => row.item === EXPECTED.itemCode && row.warehouse === EXPECTED.warehouseCode &&
      Number(row.costBefore) === EXPECTED.unitCostBefore && Number(row.costAfter) === EXPECTED.unitCostAfter),
    "Persisted closing lines do not show the expected FIFO item, warehouse, and costs");
    return { node: session.routeNode ?? null, metadataHash: createHash("sha256").update(metadata.data).digest("hex"),
      closing, plan, claim, execution, requestHashes, lineAudit,
      materialRevaluation: { docEntry: revaluation.DocEntry, docNum: revaluation.DocNum, transId: revaluation.TransNum,
        reference1: revaluation.Reference1 ?? null, revalAmountToStock: revaluation.MaterialRevaluationLines[0].RevalAmountToStock ?? null,
        item: revaluation.MaterialRevaluationLines[0].ItemCode, warehouse: revaluation.MaterialRevaluationLines[0].WarehouseCode,
        revalType: revaluation.RevalType, comments: revaluation.Comments, journalMemo: revaluation.JournalMemo,
        fifoLayer: revaluation.MaterialRevaluationLines[0].FIFOLayers[0] },
      sourceLayer: layerSummary(sourceLayer), resultingLayer: layerSummary(resultingLayer),
      journalEntry: { jdtNum: journal.JdtNum, number: journal.Number, memo: journal.Memo, lines: journalLines },
      accountBalances: { before: beforeBalances, after: afterBalances }, proof, requests, orderIds };
  } finally { await session.close(); }
}

let writeSession;
try {
  const lib = await loadRuntime();
  const evidence = await readEvidence(lib);
  const at = new Date().toISOString();
  const requestHashes = evidence.requestHashes;
  writeSession = await openHomologationSession();
  const client = clientFor(writeSession, lib);
  writeSession.bindTechnicalPhase7EContext(CLOSING_ID, EXECUTION_ID, POSTING_HASH,
    evidence.requests, requestHashes, evidence.orderIds);
  const closingRepo = new lib.SapGgfClosingRepository(client);
  const plans = new lib.SapGgfPostingPlanRepository(client);
  const claims = new lib.SapGgfPostingClaimRepository(client);
  const executions = new lib.SapGgfPostingExecutionRepository(client);
  const [closing, plan, claim, rawHeaderResponse, rawDocsResponse] = await Promise.all([
    closingRepo.get(CLOSING_ID), plans.get(CLOSING_ID, 1), claims.get(EXECUTION_ID),
    writeSession.get(`FBO_GGF_PEXEC('${EXECUTION_ID}')`),
    writeSession.get(`FBO_GGF_PDOC?$filter=${encodeURIComponent(`U_ExecutionId eq '${EXECUTION_ID}'`)}&$orderby=U_Sequence&$top=10`)
  ]);
  const rawHeader = rawHeaderResponse.data, rawDocs = rawDocsResponse.data?.value;
  required(["POSTING_UNCERTAIN", "POSTING_PARTIAL"].includes(closing?.status ?? "") &&
    plan?.postingHash === POSTING_HASH && ["POSTING_UNCERTAIN", "POSTING_PARTIAL"].includes(claim?.status ?? "") &&
    rawHeaderResponse.ok && rawHeader?.Code === EXECUTION_ID && rawHeader.U_ClosingId === CLOSING_ID &&
    rawHeader.U_PostingHash === POSTING_HASH && rawDocsResponse.ok && Array.isArray(rawDocs) && rawDocs.length === 3 &&
    rawDocs[0].U_Status === "RECONCILED" && rawDocs[0].U_AttemptCount === "1" &&
    rawDocs[0].U_RequestHash === REQUEST_HASHES.MaterialRevaluation && rawDocs[0].U_SapDocEntry === "44" &&
    rawDocs[0].U_SapDocNum === "7" && rawDocs[0].U_SapTransId === "2311" &&
    rawDocs.slice(1).every(row => row.U_Status === "PENDING" && row.U_AttemptCount === "0" &&
      !row.U_SapDocEntry && !row.U_SapDocNum && !row.U_SapTransId),
  "Ledger changed between fresh evidence validation and reconciliation write session");
  if (rawHeader.U_TotalExpected !== "400" || rawHeader.U_TotalPosted !== "100" || rawHeader.U_TotalReconciled !== "100" ||
      rawHeader.U_Status !== "POSTING_PARTIAL") {
    const repair = { U_ClosingId: CLOSING_ID, U_PostingHash: POSTING_HASH, U_Status: "POSTING_PARTIAL",
      U_TotalExpected: "400", U_TotalPosted: "100", U_TotalReconciled: "100" };
    const response = await writeSession.patchTechnicalPhase7ERecord(`FBO_GGF_PEXEC('${EXECUTION_ID}')`, repair);
    required(response.ok, "Could not align execution summary totals with its already-reconciled first PDOC");
  }
  const execution = await executions.get(EXECUTION_ID);
  required(execution?.status === "POSTING_PARTIAL" && execution.documents[0]?.status === "RECONCILED" &&
    execution.documents[0].attemptCount === 1 && execution.documents.slice(1).every(doc =>
      doc.status === "PENDING" && doc.attemptCount === 0), "Execution ledger failed readback after summary repair");
  const first = execution.documents[0];
  const responseEvidence = { reconciliationMethod: "FIFO_LAYER_AND_LINKED_JOURNAL_ENTRY",
    verifiedAt: at, evidence: evidence.proof.evidence, materialRevaluation: evidence.materialRevaluation,
    sourceLayer: evidence.sourceLayer, resultingLayer: evidence.resultingLayer,
    journalEntry: evidence.journalEntry, accountBalances: evidence.accountBalances };
  const documents = execution.documents.map((document, index) => index !== 0 ? document : ({ ...document,
    status: "RECONCILED", response: responseEvidence, sapDocEntry: 44, sapDocNum: 7, sapTransId: 2311,
    reconciledAt: at, reconciliationStatus: "MATCHED" }));
  const updated = { ...execution, status: "POSTING_PARTIAL", finishedAt: null, documents };
  const savedExecution = await executions.save(updated);
  required(savedExecution.status === "POSTING_PARTIAL" && savedExecution.documents[0]?.status === "RECONCILED" &&
    savedExecution.documents[0].sapDocEntry === 44 && savedExecution.documents.slice(1).every(doc =>
      doc.status === "PENDING" && doc.attemptCount === 0), "Execution/PDOC reconciliation readback failed");
  if (claim.status !== "POSTING_PARTIAL") await claims.updateStatus(EXECUTION_ID, "POSTING_PARTIAL", at);
  const store = new lib.SapGgfPostingOrchestrationStore(client, ["bis_FIFO"], () => at);
  if (closing.status !== "POSTING_PARTIAL") await store.transitionClosing({ closingId: CLOSING_ID,
    expectedVersion: closing.version, expectedStatus: "POSTING_UNCERTAIN", status: "POSTING_PARTIAL",
    postingHash: POSTING_HASH, postingPlanVersion: 1, error: closing.lastError,
    documentLink: { documentType: "MaterialRevaluation", docEntry: 44, docNum: 7, transId: 2311, postedAt: at } });
  await writeSession.close(); writeSession = null;

  const verification = await readEvidence(lib);
  required(verification.closing.status === "POSTING_PARTIAL" && verification.closing.sapMaterialRevaluationDocEntry === 44 &&
    verification.closing.sapMaterialRevaluationDocNum === 7 && verification.closing.sapJournalTransId === 2311 &&
    verification.claim.status === "POSTING_PARTIAL" && verification.execution.status === "POSTING_PARTIAL" &&
    verification.execution.documents[0]?.status === "RECONCILED" &&
    verification.execution.documents[0]?.reconciliationStatus === "MATCHED" &&
    verification.execution.documents[0]?.sapDocEntry === 44 && verification.execution.documents[0]?.sapDocNum === 7 &&
    verification.execution.documents[0]?.sapTransId === 2311 &&
    verification.execution.documents[0]?.requestHash === REQUEST_HASHES.MaterialRevaluation &&
    verification.execution.documents.slice(1).every(doc => doc.status === "PENDING" && doc.attemptCount === 0 &&
      doc.sapDocEntry === null && doc.sapDocNum === null && doc.sapTransId === null),
  "Final new-session ledger round-trip differs after FIFO reconciliation");
  await mkdir(resolve(".local/ggf"), { recursive: true, mode: 0o700 });
  const report = { closingId: CLOSING_ID, executionId: EXECUTION_ID, postingHash: POSTING_HASH,
    priorState: { claim: "POSTING_UNCERTAIN", execution: "POSTING_UNCERTAIN", pdoc1: "UNCERTAIN", pdoc2: "PENDING", pdoc3: "PENDING" },
    reconciliation: { status: "RECONCILED", docEntry: 44, docNum: 7, transId: 2311,
      reconciledAt: at, evidence: evidence.proof.evidence, source: evidence },
    finalState: { closing: verification.closing.status, closingVersion: verification.closing.version,
      claim: verification.claim.status, execution: verification.execution.status,
      pdocs: verification.execution.documents.map(doc => ({ type: doc.documentType, status: doc.status,
        attempts: doc.attemptCount, docEntry: doc.sapDocEntry, docNum: doc.sapDocNum, transId: doc.sapTransId,
        requestHash: doc.requestHash, reconciliationStatus: doc.reconciliationStatus })) },
    financialPostsAdditional: 0 };
  await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ closingId: CLOSING_ID, executionId: EXECUTION_ID, metadataHash: verification.metadataHash,
    node: verification.node, fifo: { before: verification.sourceLayer, after: verification.resultingLayer },
    document: verification.materialRevaluation, journalEntry: verification.journalEntry,
    accountBalances: verification.accountBalances, proof: verification.proof,
    state: report.finalState, financialPostsAdditional: 0, report: OUTPUT }));
} finally { if (writeSession) await writeSession.close(); }
