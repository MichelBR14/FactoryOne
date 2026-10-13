import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openHomologationSession } from "./ggf-homologation-session.mjs";

const CLOSING_ID = "TECH7E-20261001-C2B8A14D73";
const EXECUTION_ID = "F1EX8e69095772d441b85577de5508f7070f1e4db4d2";
const POSTING_HASH = "5e19b21753be8646083218d08ceed32cc706cf347fb61833ad8542b613b9a649";
const DOC_TYPE = "JournalEntry.Closing";
const MEMO = `FactoryOne PHASE7E_TECHNICAL ${CLOSING_ID}`;
const ACCOUNTS = {
  transit: "5.04.01.01.05", revaluation: "5.03.01.01.04",
  ggf: "5.04.01.01.03", mod: "5.04.01.01.04"
};
const BRANCH = 1;
const CURRENCY = "R$";
const OUT = resolve(".local/ggf");
const INTENT = resolve(OUT, "phase7e-closing-once-C2B8A14D73-intent.json");
const RESULT = resolve(OUT, "phase7e-closing-once-C2B8A14D73-result.json");
const LOCK = resolve(OUT, "phase7e-closing-once-C2B8A14D73.lock");
const DIMENSIONS = ["ProjectCode", "CostingCode", "CostingCode2", "CostingCode3", "CostingCode4", "CostingCode5"];
const DIMENSION_FLAGS = ["ProjectRelevant", "CostAccountingOnly", "DistributionRuleRelevant",
  "DistributionRule2Relevant", "DistributionRule3Relevant", "DistributionRule4Relevant", "DistributionRule5Relevant"];
const must = (condition, message) => { if (!condition) throw new Error(message); };
const cents = value => {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number * 100 - Math.round(number * 100)) > 1e-7)
    throw new Error("SAP amount is not exact to cents");
  return Math.round(number * 100);
};

async function loadRuntime() {
  const outfile = resolve(OUT, "phase7e-closing-once-runtime.mjs");
  await build({ stdin: { resolveDir: process.cwd(), contents: `
export { SapGgfClosingRepository } from "./webapp/modules/ggf/repository/SapGgfClosingRepository.ts";
export { SapGgfPostingPlanRepository } from "./webapp/modules/ggf/repository/SapGgfPostingPlanRepository.ts";
export { SapGgfPostingClaimRepository, SapGgfPostingExecutionRepository } from "./webapp/modules/ggf/repository/SapGgfPostingExecutionRepository.ts";
export { SapGgfPostingOrchestrationStore } from "./webapp/modules/ggf/repository/SapGgfPostingOrchestrationStore.ts";
export { GgfPostingOrchestrator, DefiniteGgfDocumentRejection } from "./webapp/modules/ggf/service/GgfPostingOrchestrator.ts";
export { buildPhase7EEconomicScenario } from "./webapp/modules/ggf/service/GgfPhase7EEconomicScenario.ts";
export { calculateGgfRequestHash } from "./webapp/modules/ggf/service/GgfPostingExecution.ts";
export { ServiceLayerError } from "./webapp/core/service/errors.ts";
` }, outfile, platform: "node", format: "esm", bundle: true });
  return import(pathToFileURL(outfile).href + `?v=${Date.now()}`);
}

function clientFor(session, runtime) {
  const unwrap = response => {
    if (!response.ok) throw new runtime.ServiceLayerError("SAP request rejected", response.status,
      response.errorCode, response.errorMessage);
    return response.data;
  };
  return {
    async get(path) { return unwrap(await session.get(path, { Prefer: "odata.maxpagesize=100" })); },
    async post(path, body) { return unwrap(await session.postTechnicalPhase7ERecord(path, body)); },
    async patch(path, body) { return unwrap(await session.patchTechnicalPhase7ERecord(path, body)); }
  };
}

function verifyJournal(row, payload) {
  if (!row || row.Reference !== payload.Reference || row.Memo !== payload.Memo ||
      String(row.ReferenceDate).slice(0, 10) !== payload.ReferenceDate ||
      String(row.DueDate).slice(0, 10) !== payload.DueDate || String(row.TaxDate).slice(0, 10) !== payload.TaxDate ||
      !Array.isArray(row.JournalEntryLines) || row.JournalEntryLines.length !== payload.JournalEntryLines.length) return false;
  const expected = payload.JournalEntryLines;
  const expectedDebit = expected.reduce((sum, line) => sum + cents(line.Debit), 0);
  const expectedCredit = expected.reduce((sum, line) => sum + cents(line.Credit), 0);
  return expected.every(want => row.JournalEntryLines.some(line => line.AccountCode === want.AccountCode &&
    cents(line.Debit) === cents(want.Debit) && cents(line.Credit) === cents(want.Credit) &&
    Number(line.BPLID) === BRANCH && !line.FCCurrency && cents(line.FCDebit ?? 0) === 0 &&
    cents(line.FCCredit ?? 0) === 0 && DIMENSIONS.every(key => line[key] == null || line[key] === ""))) &&
    expectedDebit === expectedCredit && row.JournalEntryLines.reduce((sum, line) => sum + cents(line.Debit), 0) === expectedDebit &&
    row.JournalEntryLines.reduce((sum, line) => sum + cents(line.Credit), 0) === expectedCredit;
}

function journalSummary(row) {
  return { JdtNum: Number(row.JdtNum), Number: Number(row.Number), Reference: row.Reference, Memo: row.Memo,
    ReferenceDate: row.ReferenceDate, DueDate: row.DueDate, TaxDate: row.TaxDate,
    JournalEntryLines: row.JournalEntryLines.map(line => ({ Line_ID: line.Line_ID, AccountCode: line.AccountCode,
      Debit: line.Debit, Credit: line.Credit, BPLID: line.BPLID, FCCurrency: line.FCCurrency ?? null,
      FCDebit: line.FCDebit ?? 0, FCCredit: line.FCCredit ?? 0,
      ...Object.fromEntries(DIMENSIONS.map(key => [key, line[key] ?? null])) })) };
}

async function saveExclusive(path, value) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
}

async function saveJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
}

function assertExistingJournals(rows, cpvPayload) {
  must(rows.length === 2, "Unexpected Journal Entry count for the technical scenario");
  const revaluation = rows.find(row => Number(row.JdtNum) === 2311);
  const cpv = rows.find(row => Number(row.JdtNum) === 2326);
  const revaluationLines = revaluation?.JournalEntryLines ?? [];
  must(revaluation && Number(revaluation.Number) === 1931 && revaluationLines.length === 2 &&
    revaluationLines.some(line => line.AccountCode === "1.01.02.01.01" && cents(line.Debit) === 100 && cents(line.Credit) === 0) &&
    revaluationLines.some(line => line.AccountCode === ACCOUNTS.revaluation && cents(line.Debit) === 0 && cents(line.Credit) === 100) &&
    revaluationLines.every(line => Number(line.BPLID) === BRANCH && line.LineMemo === MEMO) &&
    verifyJournal(cpv, cpvPayload) && Number(cpv.JdtNum) === 2326 && Number(cpv.Number) === 1941,
  "Existing scenario Journal Entries differ from the reconciled MaterialRevaluation and CPV documents");
}

async function preflight(session, runtime, payload, cpvPayload) {
  const metadata = await session.get("$metadata", "application/xml");
  must(metadata.ok && ["FBO_GGF_CLOSE", "FBO_GGF_CLINE", "FBO_GGF_CLAIM", "FBO_GGF_PPLAN",
    "FBO_GGF_PEXEC", "FBO_GGF_PDOC"].every(name => metadata.data.includes(`Name=\"${name}\"`)),
  "Service Layer metadata is incomplete on the active node");
  const accountCodes = Object.values(ACCOUNTS);
  const [accountResponses, branchResponse, adminResponse, currencyResponse, periodResponse, closingCount,
    journalRows, mrResponse, cpvResponse, fifoResponse, revaluationResponse] = await Promise.all([
    Promise.all(accountCodes.map(code => session.get(`ChartOfAccounts('${code}')`))),
    session.get("BusinessPlaces?$filter=BPLID eq 1&$select=BPLID,BPLName,Disabled"),
    session.readAction("CompanyService_GetAdminInfo"), session.get(`Currencies('${CURRENCY}')`),
    session.readAction("CompanyService_GetFinancePeriod", { FinancePeriodParams: { AbsoluteEntry: 180, PeriodIndicator: "Padrão" } }),
    session.get(`JournalEntries/$count?$filter=${encodeURIComponent(`Reference eq '${CLOSING_ID}'`)}`),
    session.get(`JournalEntries?$filter=${encodeURIComponent(`Memo eq '${MEMO}'`)}&$top=20`),
    session.get("MaterialRevaluation(44)"), session.get("JournalEntries(2326)"),
    session.readAction("MaterialRevaluationFIFOService_GetMaterialRevaluationFIFO", {
      MaterialRevaluationFIFOParams: { ItemCode: "F1GGF26F01", LocationCode: "01", LocationType: "64", ShowIssuedLayers: "tNO" }
    }),
    session.get("MaterialRevaluation?$filter=" + encodeURIComponent(`Comments eq '${MEMO}'`) + "&$top=20")
  ]);
  must(accountResponses.every(response => response.ok) && branchResponse.ok && adminResponse.ok && currencyResponse.ok &&
    periodResponse.ok && closingCount.ok && journalRows.ok && mrResponse.ok && cpvResponse.ok &&
    revaluationResponse.ok && fifoResponse.ok, "SAP source, account, branch, currency or period read is incomplete");
  const accounts = accountResponses.map(response => response.data);
  for (const account of accounts) must(account.ActiveAccount === "tYES" && account.BlockManualPosting === "tNO" &&
    account.FrozenFor !== "tYES" && DIMENSION_FLAGS.every(flag => account[flag] === "tNO") &&
    Number.isFinite(Number(account.Balance)), `Account ${account.Code} is blocked, missing balance, or requires an unprovided dimension`);
  must(branchResponse.data.value?.length === 1 && Number(branchResponse.data.value[0].BPLID) === BRANCH &&
    branchResponse.data.value[0].Disabled === "tNO", "Branch 1 is unavailable");
  must(adminResponse.data.LocalCurrency === CURRENCY && adminResponse.data.Country === "BR" &&
    currencyResponse.data.Code === CURRENCY && currencyResponse.data.Name === "Real", "Local currency differs from R$");
  const period = periodResponse.data;
  must(period.AbsoluteEntry === 180 && period.PeriodCode === "2026-10" && period.Locked === "tNO" &&
    period.PeriodStatus === "ltUnlocked" && payload.ReferenceDate >= period.PostingDateFrom.slice(0, 10) &&
    payload.ReferenceDate <= period.PostingDateTo.slice(0, 10), "Posting period 2026-10 is not open");
  const [transit, revaluation, ggf, mod] = accounts;
  const closingRows = revaluationResponse.data?.value;
  must(Array.isArray(closingRows) && closingRows.length === 1 && Number(closingRows[0].DocEntry) === 44 &&
    Number(mrResponse.data.DocNum) === 7 && mrResponse.data.RevalType === "P" &&
    mrResponse.data.MaterialRevaluationLines?.length === 1 &&
    mrResponse.data.MaterialRevaluationLines[0].ItemCode === "F1GGF26F01" &&
    mrResponse.data.MaterialRevaluationLines[0].WarehouseCode === "01" &&
    mrResponse.data.MaterialRevaluationLines[0].FIFOLayers?.some(layer =>
      Number(layer.TransactionSequenceNum) === 2790 && Number(layer.LayerID) === 0 && Number(layer.Price) === 12.2),
  "Existing MaterialRevaluation 44 or its FIFO layer differs from the reconciled evidence");
  must(Number(cpvResponse.data.JdtNum) === 2326 && Number(cpvResponse.data.Number) === 1941 &&
    verifyJournal(cpvResponse.data, cpvPayload), "Existing CPV Journal Entry 2326 differs from the reconciled evidence");
  must(Array.isArray(fifoResponse.data?.Layers) && fifoResponse.data.Layers.some(layer =>
    layer.DocType === "ttInventoryValuation" && String(layer.DocNumber) === "7" &&
    Number(layer.TransactionSequenceNum) === 2800 && Number(layer.LayerID) === 0 &&
    Number(layer.OpenQty) === 5 && Number(layer.CurrentCost) === 12.2),
  "FIFO valuation evidence for the existing MaterialRevaluation is unavailable");
  assertExistingJournals(journalRows.data.value, cpvPayload);
  must(Number(closingCount.data) === 1 && revaluation.Code === ACCOUNTS.revaluation &&
    transit.Code === ACCOUNTS.transit && ggf.Code === ACCOUNTS.ggf && mod.Code === ACCOUNTS.mod,
  "Scenario document markers or account identity differ from the existing plan");
  const centsBalances = Object.fromEntries(accounts.map(row => [row.Code, cents(row.Balance)]));
  return { node: session.routeNode ?? null, metadataHash: createHash("sha256").update(metadata.data).digest("hex"),
    branch: { id: BRANCH, name: branchResponse.data.value[0].BPLName }, currency: CURRENCY,
    period: { code: period.PeriodCode, status: period.PeriodStatus, locked: period.Locked },
    accounts: accounts.map(row => ({ code: row.Code, name: row.Name, active: row.ActiveAccount,
      manualPosting: row.BlockManualPosting, frozen: row.FrozenFor,
      dimensions: Object.fromEntries(DIMENSION_FLAGS.map(flag => [flag, row[flag]])), balance: row.Balance })),
    balancesCents: centsBalances, existingJournals: journalRows.data.value.map(row => journalSummary(row)),
    materialRevaluation: { docEntry: mrResponse.data.DocEntry, docNum: mrResponse.data.DocNum,
      fifoLayer: mrResponse.data.MaterialRevaluationLines[0].FIFOLayers[0] },
    cpv: journalSummary(cpvResponse.data) };
}

async function readPack(session, runtime, payload, scenario, expectedStatuses) {
  const client = clientFor(session, runtime);
  const closingRepo = new runtime.SapGgfClosingRepository(client);
  const plans = new runtime.SapGgfPostingPlanRepository(client);
  const claims = new runtime.SapGgfPostingClaimRepository(client);
  const executions = new runtime.SapGgfPostingExecutionRepository(client);
  const [closing, plan, claim, execution, revaluation, mrJournal, cpvJournal, closeCount, memoRows] = await Promise.all([
    closingRepo.get(CLOSING_ID), plans.get(CLOSING_ID, 1), claims.get(EXECUTION_ID), executions.get(EXECUTION_ID),
    session.get("MaterialRevaluation(44)"), session.get("JournalEntries(2311)"), session.get("JournalEntries(2326)"),
    session.get(`JournalEntries/$count?$filter=${encodeURIComponent(`Reference eq '${CLOSING_ID}'`)}`),
    session.get(`JournalEntries?$filter=${encodeURIComponent(`Memo eq '${MEMO}'`)}&$top=20`)
  ]);
  must(closing && plan && claim && execution && revaluation.ok && mrJournal.ok && cpvJournal.ok &&
    closeCount.ok && memoRows.ok, "Ledger/document readback is incomplete");
  return { closing, plan, claim, execution, revaluation: revaluation.data, mrJournal: mrJournal.data,
    cpvJournal: cpvJournal.data, closeCount: Number(closeCount.data), memoRows: memoRows.data.value,
    client, closingRepo, plans, claims, executions };
}

function assertLedger(pack, scenario, expectedStatuses, final = false) {
  const { closing, plan, claim, execution } = pack;
  const allDocumentsReconciled = expectedStatuses[2] === "RECONCILED";
  must(closing.status === (final ? "POSTED" : "POSTING_PARTIAL") && closing.version >= 7 &&
    closing.integrityStatus === (final ? "VALID" : "NOT_APPLICABLE") &&
    closing.postingBasis?.postingPlanHash === POSTING_HASH &&
    plan.status === "VALIDATED" && plan.version === 1 && plan.closingVersion === 4 &&
    plan.postingHash === POSTING_HASH && plan.technicalRequestHashes?.[DOC_TYPE] === scenario.documents[2].requestHash &&
    claim.status === (final ? "POSTED" : "POSTING_PARTIAL") && claim.closingId === CLOSING_ID &&
    claim.closingVersion === 4 && claim.postingPlanVersion === 1 && claim.postingHash === POSTING_HASH &&
    execution.status === (final ? "POSTED" : "POSTING_PARTIAL") && execution.identity.closingId === CLOSING_ID &&
    execution.identity.closingVersion === 4 && execution.identity.postingPlanVersion === 1 &&
    execution.identity.postingHash === POSTING_HASH && execution.totalExpected === "400" &&
    execution.totalPosted === (allDocumentsReconciled ? "400" : "200") &&
    execution.totalReconciled === (allDocumentsReconciled ? "400" : "200") &&
    execution.documents.length === 3 && execution.documents.every((document, index) =>
      document.documentType === scenario.documents[index].type && document.status === expectedStatuses[index]),
  "Closing, plan, claim, execution or PDOC state differs from the expected checkpoint");
  const [mr, cpv, close] = execution.documents;
  must(mr.attemptCount === 1 && mr.sapDocEntry === 44 && mr.sapDocNum === 7 && mr.sapTransId === 2311 &&
    mr.requestHash === scenario.documents[0].requestHash && cpv.attemptCount === 1 &&
    cpv.sapDocEntry === 2326 && cpv.sapDocNum === 1941 && cpv.sapTransId === 2326 &&
    cpv.requestHash === scenario.documents[1].requestHash && close.attemptCount === (final || expectedStatuses[2] === "RECONCILED" ? 1 : 0) &&
    close.requestHash === (expectedStatuses[2] === "RECONCILED" ? scenario.documents[2].requestHash : null) &&
    close.sapDocEntry === (expectedStatuses[2] === "RECONCILED" ? close.sapDocEntry : null) &&
    (expectedStatuses[2] !== "PENDING" || close.sapDocNum === null && close.sapTransId === null),
  "PDOC attempts, request hashes or document links differ from the authorized chain");
  must(pack.closeCount === (expectedStatuses[2] === "PENDING" ? 1 : 2) &&
    pack.memoRows.length === (expectedStatuses[2] === "PENDING" ? 2 : 3),
    "Scenario marker count includes missing or unexpected Journal Entries");
  assertExistingJournals(pack.memoRows.filter(row => Number(row.JdtNum) !== Number(close.sapDocEntry)), scenario.documents[1].request);
  must(Number(pack.revaluation.DocEntry) === 44 && Number(pack.revaluation.DocNum) === 7 &&
    Number(pack.mrJournal.JdtNum) === 2311 && Number(pack.cpvJournal.JdtNum) === 2326 &&
    verifyJournal(pack.cpvJournal, scenario.documents[1].request), "Previously reconciled documents changed");
  if (expectedStatuses[2] === "RECONCILED") {
    const closeJournal = pack.memoRows.find(row => Number(row.JdtNum) === Number(close.sapTransId));
    must(close.sapDocEntry === close.sapTransId && close.sapDocNum === Number(closeJournal?.Number) &&
      verifyJournal(closeJournal, scenario.documents[2].request), "Closing JE differs from the reconciled payload");
  }
}

let lock;
let writer;
let financialPostCalls = 0;
let postInvoked = false;
let intent;
try {
  must(process.argv[2] === "execute", "Usage: node scripts/ggf-phase7e-post-closing-once.mjs execute");
  await mkdir(OUT, { recursive: true, mode: 0o700 });
  lock = await open(LOCK, "wx", 0o600);
  must(!(await readFile(INTENT).then(() => true).catch(error => error?.code === "ENOENT" ? false : Promise.reject(error))) &&
    !(await readFile(RESULT).then(() => true).catch(error => error?.code === "ENOENT" ? false : Promise.reject(error))),
  "A closing JE attempt/result already exists locally; do not rerun or retry");
  const runtime = await loadRuntime();
  const scenario = await runtime.buildPhase7EEconomicScenario({ closingId: CLOSING_ID });
  const plannedDocument = scenario.documents[2];
  must(plannedDocument.type === DOC_TYPE && plannedDocument.order === 3 && plannedDocument.amountCents === "200" &&
    plannedDocument.requestHash === "47a059b4f67598d749e98a0d8ccd953658de1b503ca32964cf4c54a72d908157" &&
    JSON.stringify(plannedDocument.request.JournalEntryLines.map(line => [line.AccountCode, cents(line.Debit), cents(line.Credit)])) ===
      JSON.stringify([[ACCOUNTS.transit, 100, 0], [ACCOUNTS.revaluation, 100, 0], [ACCOUNTS.ggf, 0, 120], [ACCOUNTS.mod, 0, 80]]),
  "Locally rebuilt closing request differs from the authorized four-line scenario");
  const requests = Object.fromEntries(scenario.documents.map(document => [document.type, document.request]));
  const requestHashes = Object.fromEntries(scenario.documents.map(document => [document.type, document.requestHash]));
  const orderIds = { MaterialRevaluation: "7E-MR-01-663E5024DDB34256",
    "JournalEntry.CPV": "7E-CPV-02-A7E132FC60F76B8D", "JournalEntry.Closing": "7E-CLS-03-BCCC828A905EA75D" };
  writer = await openHomologationSession();
  writer.bindTechnicalPhase7EContext(CLOSING_ID, EXECUTION_ID, POSTING_HASH, requests, requestHashes, orderIds,
    ["MaterialRevaluation", "JournalEntry.CPV"], [DOC_TYPE]);
  const client = clientFor(writer, runtime);
  const closingRepo = new runtime.SapGgfClosingRepository(client);
  const plans = new runtime.SapGgfPostingPlanRepository(client);
  const claims = new runtime.SapGgfPostingClaimRepository(client);
  const executions = new runtime.SapGgfPostingExecutionRepository(client);
  const store = new runtime.SapGgfPostingOrchestrationStore(client, ["bis_FIFO"]);
  const pack = await readPack(writer, runtime, plannedDocument.request, scenario, ["RECONCILED", "RECONCILED", "PENDING"]);
  assertLedger(pack, scenario, ["RECONCILED", "RECONCILED", "PENDING"]);
  const preflightResult = await preflight(writer, runtime, plannedDocument.request, scenario.documents[1].request);
  must(pack.plan.documents.find(document => document.type === DOC_TYPE && document.order === 3)?.status === "VALIDATED" &&
    pack.plan.documents.find(document => document.type === DOC_TYPE && document.order === 3)?.totalCents === "200" &&
    pack.plan.documents.find(document => document.type === DOC_TYPE && document.order === 3)?.blockers.length === 0 &&
    pack.plan.technicalRequestHashes[DOC_TYPE] === plannedDocument.requestHash,
  "Persisted PostingPlan closing document is blocked or has a different RequestHash");
  const beforeBalances = preflightResult.balancesCents;

  const gateway = {
    async prepare(document, identity) {
      must(document.type === DOC_TYPE && document.order === 3 && identity.closingId === CLOSING_ID &&
        identity.postingPlanVersion === 1 && identity.postingHash === POSTING_HASH &&
        document.totalCents === "200" && document.currency === CURRENCY && document.lines.length === 4 &&
        document.lines.reduce((sum, line) => sum + BigInt(line.amountCents), 0n) === 200n &&
        document.lines.every(line => line.dimensions.length === 0), "Orchestrator selected a document outside the CPV-finished closing plan");
      return { expectedCents: "200", payload: plannedDocument.request };
    },
    async reconcile(input) {
      if (input.documentType !== DOC_TYPE || input.expectedCents !== "200" ||
          await runtime.calculateGgfRequestHash(input.payload) !== plannedDocument.requestHash)
        return { complete: false, matches: [] };
      if (input.knownDocEntry !== null) {
        const response = await writer.get(`JournalEntries(${input.knownDocEntry})`);
        if (!response.ok) return { complete: false, matches: [] };
        const row = response.data;
        return verifyJournal(row, plannedDocument.request) ? { complete: true, matches: [{
          docEntry: Number(row.JdtNum), docNum: Number(row.Number), transId: Number(row.JdtNum), response: journalSummary(row)
        }] } : { complete: true, matches: [] };
      }
      const filter = encodeURIComponent(`Reference eq '${CLOSING_ID}' and Memo eq '${MEMO}'`);
      const [count, page] = await Promise.all([writer.get(`JournalEntries/$count?$filter=${filter}`),
        writer.get(`JournalEntries?$filter=${filter}&$top=20`)]);
      if (!count.ok || !page.ok || !Array.isArray(page.data?.value) || page.data["odata.nextLink"] ||
          Number(count.data) !== page.data.value.length) return { complete: false, matches: [] };
      const matches = page.data.value.filter(row => verifyJournal(row, plannedDocument.request));
      return { complete: true, matches: matches.map(row => ({ docEntry: Number(row.JdtNum), docNum: Number(row.Number),
        transId: Number(row.JdtNum), response: journalSummary(row) })) };
    },
    async post(documentType, payload) {
      must(documentType === DOC_TYPE && financialPostCalls === 0 && JSON.stringify(payload) === JSON.stringify(plannedDocument.request),
        "Only the exact authorized closing Journal Entry may be posted once");
      const [stored, storedClaim, storedClosing] = await Promise.all([
        executions.get(EXECUTION_ID), claims.get(EXECUTION_ID), closingRepo.get(CLOSING_ID)
      ]);
      const sending = stored?.documents[2];
      const payloadHash = await runtime.calculateGgfRequestHash(payload);
      must(stored?.status === "POSTING_PARTIAL" && storedClaim?.status === "POSTING_PARTIAL" &&
        storedClosing?.status === "POSTING_PARTIAL" && sending?.status === "SENDING" && sending.attemptCount === 1 &&
        sending.requestHash === payloadHash && sending.requestHash === plannedDocument.requestHash &&
        JSON.stringify(sending.request) === JSON.stringify(payload) &&
        stored.documents[0]?.status === "RECONCILED" && stored.documents[1]?.status === "RECONCILED",
      "SAP did not read back the PDOC 3 SENDING checkpoint before the financial POST");
      intent = { closingId: CLOSING_ID, executionId: EXECUTION_ID, postingHash: POSTING_HASH,
        documentType: DOC_TYPE, order: 3, amountCents: "200", requestHash: payloadHash,
        attemptCount: 1, attemptStartedAt: sending.attemptStartedAt, status: "SENDING", payload,
        beforeBalances, financialPostCalls: 1, tlsMode: "LOCAL_TEST_CERTIFICATE_EXCEPTION" };
      await saveExclusive(INTENT, intent);
      financialPostCalls = 1;
      postInvoked = true;
      let response;
      try { response = await writer.postTechnicalPhase7EDocument(DOC_TYPE, payload); }
      catch (error) {
        intent = { ...intent, status: "POST_RESPONSE_UNKNOWN", sanitizedError: error instanceof runtime.ServiceLayerError
          ? `HTTP_${error.status}_CODE_${error.code ?? "UNKNOWN"}` : "NETWORK_OR_RESPONSE_UNKNOWN" };
        await saveJson(INTENT, intent);
        throw error;
      }
      if (!response.ok) {
        intent = { ...intent, status: response.status >= 400 && response.status < 500 ? "REJECTED" : "POST_RESPONSE_UNKNOWN",
          sanitizedError: `HTTP_${response.status}_CODE_${response.errorCode ?? "UNKNOWN"}` };
        await saveJson(INTENT, intent);
        if (response.status >= 400 && response.status < 500)
          throw new runtime.DefiniteGgfDocumentRejection(response.status, Number(response.errorCode));
        throw new Error("Closing Journal Entry response is uncertain; automatic retry is prohibited");
      }
      const row = response.data;
      const docEntry = Number(row?.JdtNum), docNum = Number(row?.Number);
      if (!Number.isSafeInteger(docEntry) || docEntry <= 0 || !Number.isSafeInteger(docNum) || docNum <= 0) {
        intent = { ...intent, status: "RESPONSE_INCOMPLETE" };
        await saveJson(INTENT, intent);
        throw new Error("Closing Journal Entry response omitted JdtNum or Number; do not retry");
      }
      intent = { ...intent, status: "RESPONSE_RECEIVED", response: journalSummary(row), docEntry, docNum, transId: docEntry };
      await saveJson(INTENT, intent);
      return { docEntry, docNum, transId: docEntry, response: journalSummary(row) };
    }
  };

  const orchestrator = new runtime.GgfPostingOrchestrator(store, gateway);
  const posting = await orchestrator.postNextDocument(EXECUTION_ID, DOC_TYPE);
  must(financialPostCalls === 1 && posting.status === "POSTING_PARTIAL" &&
    posting.documents[0]?.status === "RECONCILED" && posting.documents[1]?.status === "RECONCILED" &&
    posting.documents[2]?.status === "RECONCILED" && posting.documents[2]?.attemptCount === 1 &&
    posting.documents[2]?.requestHash === plannedDocument.requestHash,
  "Orchestrator did not reconcile exactly PDOC 3 after the single POST");
  const postedDoc = posting.documents[2];
  const docEntry = Number(postedDoc.docEntry), docNum = Number(postedDoc.docNum), transId = Number(postedDoc.transId);
  must(Number.isSafeInteger(docEntry) && Number.isSafeInteger(docNum) && Number.isSafeInteger(transId),
    "Reconciled closing Journal Entry identifiers are incomplete");
  await writer.close(); writer = null;

  const afterPostSession = await openHomologationSession();
  afterPostSession.bindTechnicalPhase7EContext(CLOSING_ID, EXECUTION_ID, POSTING_HASH, requests, requestHashes,
    orderIds, ["MaterialRevaluation", "JournalEntry.CPV"], [DOC_TYPE]);
  const afterPostPack = await readPack(afterPostSession, runtime, plannedDocument.request, scenario,
    ["RECONCILED", "RECONCILED", "RECONCILED"]);
  assertLedger(afterPostPack, scenario, ["RECONCILED", "RECONCILED", "RECONCILED"]);
  const closeRow = afterPostPack.memoRows.find(row => Number(row.JdtNum) === transId);
  must(closeRow && Number(closeRow.Number) === docNum && verifyJournal(closeRow, plannedDocument.request) &&
    afterPostPack.closeCount === 2, "Closing JE is not independently reconciled from the new SAP session");
  const afterAccounts = await Promise.all(Object.values(ACCOUNTS).map(code => afterPostSession.get(`ChartOfAccounts('${code}')`)));
  must(afterAccounts.every(response => response.ok), "Post-closing account balance readback is incomplete");
  const afterBalances = Object.fromEntries(afterAccounts.map(response => [response.data.Code, cents(response.data.Balance)]));
  const expectedDeltas = { [ACCOUNTS.transit]: 100, [ACCOUNTS.revaluation]: 100,
    [ACCOUNTS.ggf]: -120, [ACCOUNTS.mod]: -80 };
  must(Object.entries(expectedDeltas).every(([code, delta]) => afterBalances[code] - beforeBalances[code] === delta),
    "Four account balances do not show the approved closing JE effects");

  const afterClient = clientFor(afterPostSession, runtime);
  const afterStore = new runtime.SapGgfPostingOrchestrationStore(afterClient, ["bis_FIFO"]);
  let resumeFinancialPosts = 0;
  const noPostGateway = { async prepare() { throw new Error("No payload preparation is expected for reconciled documents"); },
    async reconcile() { throw new Error("No external reconciliation is expected for already reconciled documents"); },
    async post() { resumeFinancialPosts++; throw new Error("Unexpected financial POST during resumeExecution"); } };
  const finalized = await new runtime.GgfPostingOrchestrator(afterStore, noPostGateway).resumeExecution(EXECUTION_ID);
  must(finalized.status === "POSTED" && finalized.documents.every(document => document.status === "RECONCILED") &&
    resumeFinancialPosts === 0 && finalized.totalExpected === "400" && finalized.totalPosted === "400" &&
    finalized.totalReconciled === "400", "resumeExecution did not safely finalize the reconciled ledger without POST");
  await afterPostSession.close();

  const finalSession = await openHomologationSession();
  finalSession.bindTechnicalPhase7EContext(CLOSING_ID, EXECUTION_ID, POSTING_HASH, requests, requestHashes,
    orderIds, ["MaterialRevaluation", "JournalEntry.CPV", DOC_TYPE], []);
  const finalPack = await readPack(finalSession, runtime, plannedDocument.request, scenario,
    ["RECONCILED", "RECONCILED", "RECONCILED"]);
  assertLedger(finalPack, scenario, ["RECONCILED", "RECONCILED", "RECONCILED"], true);
  const postedClosing = finalPack.memoRows.find(row => Number(row.JdtNum) === transId);
  must(postedClosing && Number(postedClosing.Number) === docNum && verifyJournal(postedClosing, plannedDocument.request),
    "Final new-session closing document readback differs");
  const finalBalancesRows = await Promise.all(Object.values(ACCOUNTS).map(code => finalSession.get(`ChartOfAccounts('${code}')`)));
  must(finalBalancesRows.every(response => response.ok), "Final account balance reread is incomplete");
  const finalBalances = Object.fromEntries(finalBalancesRows.map(response => [response.data.Code, {
    value: Number(response.data.Balance).toFixed(2), cents: cents(response.data.Balance)
  }]));
  const finalClient = clientFor(finalSession, runtime);
  const finalStore = new runtime.SapGgfPostingOrchestrationStore(finalClient, ["bis_FIFO"]);
  let idempotentResumePosts = 0;
  const finalResume = await new runtime.GgfPostingOrchestrator(finalStore, { ...noPostGateway,
    async post() { idempotentResumePosts++; throw new Error("Unexpected POST in final resumeExecution"); }
  }).resumeExecution(EXECUTION_ID);
  must(finalResume.status === "POSTED" && idempotentResumePosts === 0,
    "Final resumeExecution did not remain idempotent");
  await finalSession.close();

  intent = { ...intent, status: "RECONCILED", reconciledAt: new Date().toISOString(), docEntry, docNum, transId,
    finalBalances, resumeExecutionFinancialPosts: resumeFinancialPosts + idempotentResumePosts };
  await saveJson(INTENT, intent);
  const result = { closingId: CLOSING_ID, executionId: EXECUTION_ID, postingHash: POSTING_HASH,
    closingJournalEntry: { JdtNum: transId, Number: docNum, TransId: transId, requestHash: plannedDocument.requestHash,
      lines: journalSummary(postedClosing).JournalEntryLines }, preflight: preflightResult, beforeBalances, finalBalances,
    accountDeltas: expectedDeltas, finalStatus: { closing: "POSTED", claim: "POSTED", execution: "POSTED",
      integrity: "VALID", pdoc1: "RECONCILED", pdoc2: "RECONCILED", pdoc3: "RECONCILED" },
    resumeExecution: { firstCallFinalizedLedgerWithoutPost: resumeFinancialPosts === 0,
      finalIdempotencyCallWithoutPost: idempotentResumePosts === 0 },
    financialPostCalls };
  await saveExclusive(RESULT, result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  if (postInvoked && intent) {
    intent = { ...intent, status: intent.status === "SENDING" ? "POST_OUTCOME_UNKNOWN" : intent.status,
      sanitizedError: intent.sanitizedError ?? (error instanceof Error ? error.message.slice(0, 300) : "UNKNOWN") };
    await saveJson(INTENT, intent).catch(() => {});
  }
  process.stderr.write(`${JSON.stringify({ stopped: true, postInvoked, financialPostCalls,
    status: intent?.status ?? "PRE_POST_BLOCKED", error: error instanceof Error ? error.message : "Unknown error" })}\n`);
  process.exitCode = 1;
} finally {
  if (writer) await writer.close().catch(() => {});
  if (lock) await lock.close().catch(() => {});
  if (!postInvoked) await unlink(LOCK).catch(() => {});
}
