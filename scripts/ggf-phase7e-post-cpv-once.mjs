import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openHomologationSession } from "./ggf-homologation-session.mjs";

const CLOSING_ID = "TECH7E-20261001-C2B8A14D73";
const EXECUTION_ID = "F1EX8e69095772d441b85577de5508f7070f1e4db4d2";
const POSTING_HASH = "5e19b21753be8646083218d08ceed32cc706cf347fb61833ad8542b613b9a649";
const DOC_TYPE = "JournalEntry.CPV";
const CPV = "5.01.01.01.01";
const TRANSIT = "5.04.01.01.05";
const BRANCH = 1;
const CURRENCY = "R$";
const MEMO = `FactoryOne PHASE7E_TECHNICAL ${CLOSING_ID}`;
const OUT = resolve(".local/ggf");
const INTENT = resolve(OUT, "phase7e-cpv-once-C2B8A14D73-intent.json");
const RESULT = resolve(OUT, "phase7e-cpv-once-C2B8A14D73-result.json");
const LOCK = resolve(OUT, "phase7e-cpv-once-C2B8A14D73.lock");
const DIMENSIONS = ["ProjectCode", "CostingCode", "CostingCode2", "CostingCode3", "CostingCode4", "CostingCode5"];
const DIMENSION_FLAGS = ["ProjectRelevant", "CostAccountingOnly", "DistributionRuleRelevant",
  "DistributionRule2Relevant", "DistributionRule3Relevant", "DistributionRule4Relevant", "DistributionRule5Relevant"];
const must = (condition, message) => { if (!condition) throw new Error(message); };
const cents = value => {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n * 100 - Math.round(n * 100)) > 1e-7) throw new Error("SAP amount is not exact to cents");
  return Math.round(n * 100);
};

async function loadRuntime() {
  const outfile = resolve(OUT, "phase7e-cpv-once-runtime.mjs");
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
      !Array.isArray(row.JournalEntryLines) || row.JournalEntryLines.length !== 2) return false;
  const expected = payload.JournalEntryLines;
  const actual = row.JournalEntryLines;
  return expected.every(want => actual.some(line => line.AccountCode === want.AccountCode &&
    cents(line.Debit) === cents(want.Debit) && cents(line.Credit) === cents(want.Credit) && line.BPLID === BRANCH &&
    !line.FCCurrency && cents(line.FCDebit ?? 0) === 0 && cents(line.FCCredit ?? 0) === 0 &&
    DIMENSIONS.every(key => line[key] === null || line[key] === undefined || line[key] === ""))) &&
    actual.reduce((sum, line) => sum + cents(line.Debit), 0) === 100 &&
    actual.reduce((sum, line) => sum + cents(line.Credit), 0) === 100;
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

async function preflight(session, runtime, expectedRequest) {
  const metadata = await session.get("$metadata", "application/xml");
  must(metadata.ok && ["FBO_GGF_CLOSE", "FBO_GGF_CLINE", "FBO_GGF_CLAIM", "FBO_GGF_PPLAN",
    "FBO_GGF_PEXEC", "FBO_GGF_PDOC"].every(name => metadata.data.includes(`Name=\"${name}\"`)),
  "Service Layer metadata is incomplete on the active node");
  const [cpvResponse, transitResponse, branchResponse, adminResponse, currencyResponse, periodResponse] = await Promise.all([
    session.get(`ChartOfAccounts('${CPV}')`), session.get(`ChartOfAccounts('${TRANSIT}')`),
    session.get("BusinessPlaces?$filter=BPLID eq 1&$select=BPLID,BPLName,Disabled"),
    session.get("CompanyService_GetAdminInfo"), session.get(`Currencies('${CURRENCY}')`),
    session.readAction("CompanyService_GetFinancePeriod", { FinancePeriodParams: { AbsoluteEntry: 180, PeriodIndicator: "Padrão" } })
  ]);
  must(cpvResponse.ok && transitResponse.ok && branchResponse.ok && adminResponse.ok && currencyResponse.ok && periodResponse.ok,
    "CPV account, transit account, branch, currency or period could not be revalidated");
  const accounts = [cpvResponse.data, transitResponse.data];
  for (const account of accounts) must(account.ActiveAccount === "tYES" && account.BlockManualPosting === "tNO" &&
    account.FrozenFor !== "tYES" && DIMENSION_FLAGS.every(flag => account[flag] === "tNO"),
  `Account ${account.Code} is blocked or requires an unprovided dimension`);
  must(branchResponse.data.value?.length === 1 && branchResponse.data.value[0].BPLID === BRANCH &&
    branchResponse.data.value[0].Disabled === "tNO", "Branch 1 is unavailable");
  must(adminResponse.data.LocalCurrency === CURRENCY && adminResponse.data.Country === "BR" &&
    currencyResponse.data.Code === CURRENCY && currencyResponse.data.Name === "Real", "Local BRL currency differs");
  const period = periodResponse.data;
  must(period.AbsoluteEntry === 180 && period.PeriodCode === "2026-10" && period.Locked === "tNO" &&
    period.PeriodStatus === "ltUnlocked" && "2026-10-01" >= period.PostingDateFrom.slice(0, 10) &&
    "2026-10-01" <= period.PostingDateTo.slice(0, 10), "Posting period 2026-10 is not open");
  const totals = expectedRequest.JournalEntryLines.reduce((sum, line) => ({
    debit: sum.debit + cents(line.Debit), credit: sum.credit + cents(line.Credit)
  }), { debit: 0, credit: 0 });
  must(totals.debit === 100 && totals.credit === 100 &&
    expectedRequest.JournalEntryLines.some(line => line.AccountCode === CPV && cents(line.Debit) === 100) &&
    expectedRequest.JournalEntryLines.some(line => line.AccountCode === TRANSIT && cents(line.Credit) === 100) &&
    expectedRequest.JournalEntryLines.every(line => line.BPLID === BRANCH && !line.FCCurrency &&
      DIMENSIONS.every(key => !(key in line))), "CPV payload differs from the authorized balanced R$ 1.00 scope");
  return { node: session.routeNode ?? null, metadataHash: createHash("sha256").update(metadata.data).digest("hex"),
    accounts: accounts.map(row => ({ code: row.Code, name: row.Name, active: row.ActiveAccount,
      manualPosting: row.BlockManualPosting, frozen: row.FrozenFor, dimensions: Object.fromEntries(
        DIMENSION_FLAGS.map(flag => [flag, row[flag]])) })),
    branch: { id: BRANCH, name: branchResponse.data.value[0].BPLName }, currency: CURRENCY,
    period: { code: period.PeriodCode, status: period.PeriodStatus, from: period.PostingDateFrom, to: period.PostingDateTo } };
}

async function assertNoExistingJournal(session) {
  const filters = [`Reference eq '${CLOSING_ID}'`, `Memo eq '${MEMO}'`];
  const [referenceCount, memoResponse] = await Promise.all([
    session.get(`JournalEntries/$count?$filter=${encodeURIComponent(filters[0])}`),
    session.get(`JournalEntries?$filter=${encodeURIComponent(filters[1])}`)
  ]);
  must(referenceCount.ok && Number(referenceCount.data) === 0 && memoResponse.ok &&
    Array.isArray(memoResponse.data.value), "Journal Entry duplicate check is incomplete");
  const rows = memoResponse.data.value;
  const knownRevaluation = rows.length === 1 ? rows[0] : null;
  const lines = knownRevaluation?.JournalEntryLines ?? [];
  const stockDebit = lines.find(line => line.AccountCode === "1.01.02.01.01" && cents(line.Debit) === 100 && cents(line.Credit) === 0);
  const revaluationCredit = lines.find(line => line.AccountCode === "5.03.01.01.04" && cents(line.Credit) === 100 && cents(line.Debit) === 0);
  must(knownRevaluation && Number(knownRevaluation.JdtNum) === 2311 &&
    Number(knownRevaluation.Number) === 1931 && lines.length === 2 && stockDebit && revaluationCredit &&
    lines.every(line => Number(line.BPLID) === BRANCH && line.LineMemo === MEMO) &&
    cents(lines.reduce((sum, line) => sum + Number(line.Debit), 0)) === 100 &&
    cents(lines.reduce((sum, line) => sum + Number(line.Credit), 0)) === 100,
  "Existing scenario Journal Entry is not exactly the reconciled MaterialRevaluation posting");
}

async function finalReadback(runtime, payload, expectedRequestHash, docEntry, docNum, transId) {
  const session = await openHomologationSession();
  try {
    const client = clientFor(session, runtime);
    const closingRepo = new runtime.SapGgfClosingRepository(client);
    const plans = new runtime.SapGgfPostingPlanRepository(client);
    const claims = new runtime.SapGgfPostingClaimRepository(client);
    const executions = new runtime.SapGgfPostingExecutionRepository(client);
    const [closing, plan, claim, execution, journalResponse] = await Promise.all([
      closingRepo.get(CLOSING_ID), plans.get(CLOSING_ID, 1), claims.get(EXECUTION_ID),
      executions.get(EXECUTION_ID), session.get(`JournalEntries(${docEntry})`)
    ]);
    must(closing?.status === "POSTING_PARTIAL" && plan?.postingHash === POSTING_HASH &&
      plan.version === 1 && claim?.status === "POSTING_PARTIAL" && claim.postingHash === POSTING_HASH &&
      execution?.status === "POSTING_PARTIAL" && execution.identity.postingHash === POSTING_HASH &&
      execution.totalExpected === "400" && execution.totalPosted === "200" &&
      execution.totalReconciled === "200" &&
      execution.documents.length === 3, "New-session closing or execution identity readback differs");
    const [material, cpv, close] = execution.documents;
    must(material?.status === "RECONCILED" && material.sapDocEntry === 44 && material.sapDocNum === 7 &&
      material.sapTransId === 2311 && cpv?.status === "RECONCILED" && cpv.attemptCount === 1 &&
      cpv.requestHash === expectedRequestHash && cpv.sapDocEntry === docEntry && cpv.sapDocNum === docNum &&
      cpv.sapTransId === transId && close?.status === "PENDING" && close.attemptCount === 0 &&
      close.requestHash === null && close.sapDocEntry === null && close.sapDocNum === null && close.sapTransId === null,
    "New-session PDOC state or document links differ from the approved one-document execution");
    must(journalResponse.ok && Number(journalResponse.data.JdtNum) === transId &&
      Number(journalResponse.data.Number) === docNum && verifyJournal(journalResponse.data, payload),
    "Journal Entry does not reconcile from a new Service Layer session");
    return { node: session.routeNode ?? null, executionStatus: execution.status,
      pdocs: execution.documents.map(document => ({ type: document.documentType, status: document.status,
        attemptCount: document.attemptCount, requestHash: document.requestHash,
        docEntry: document.sapDocEntry, docNum: document.sapDocNum, transId: document.sapTransId })),
      journalEntry: journalSummary(journalResponse.data), closingVersion: closing.version,
      postingPlanVersion: plan.version, postingHash: plan.postingHash };
  } finally { await session.close(); }
}

let lock;
let writer;
let financialPostCalls = 0;
let postInvoked = false;
let intent;
try {
  must(process.argv[2] === "execute", "Usage: node scripts/ggf-phase7e-post-cpv-once.mjs execute");
  await mkdir(OUT, { recursive: true, mode: 0o700 });
  lock = await open(LOCK, "wx", 0o600);
  must(!(await readFile(INTENT).then(() => true).catch(error => error?.code === "ENOENT" ? false : Promise.reject(error))) &&
    !(await readFile(RESULT).then(() => true).catch(error => error?.code === "ENOENT" ? false : Promise.reject(error))),
  "A CPV attempt/result already exists locally; do not rerun or retry");
  const runtime = await loadRuntime();
  const scenario = await runtime.buildPhase7EEconomicScenario({ closingId: CLOSING_ID });
  const cpvScenario = scenario.documents.find(document => document.type === DOC_TYPE);
  must(cpvScenario && cpvScenario.order === 2 && cpvScenario.amountCents === "100" &&
    cpvScenario.effects.reduce((sums, line) => ({ debit: sums.debit + BigInt(line.debitCents),
      credit: sums.credit + BigInt(line.creditCents) }), { debit: 0n, credit: 0n }).debit === 100n &&
    cpvScenario.requestHash === "d352c0739212e83a781740962ea5a8e0385e733f54010144a297985abdd0efbd",
  "Locally rebuilt CPV request differs from the approved technical scenario");
  const requests = Object.fromEntries(scenario.documents.map(document => [document.type, document.request]));
  const requestHashes = Object.fromEntries(scenario.documents.map(document => [document.type, document.requestHash]));
  const orderIds = { MaterialRevaluation: "7E-MR-01-663E5024DDB34256",
    "JournalEntry.CPV": "7E-CPV-02-A7E132FC60F76B8D", "JournalEntry.Closing": "7E-CLS-03-BCCC828A905EA75D" };
  writer = await openHomologationSession();
  writer.bindTechnicalPhase7EContext(CLOSING_ID, EXECUTION_ID, POSTING_HASH, requests, requestHashes, orderIds,
    ["MaterialRevaluation"], [DOC_TYPE]);
  const client = clientFor(writer, runtime);
  const closingRepo = new runtime.SapGgfClosingRepository(client);
  const plans = new runtime.SapGgfPostingPlanRepository(client);
  const claims = new runtime.SapGgfPostingClaimRepository(client);
  const executions = new runtime.SapGgfPostingExecutionRepository(client);
  const store = new runtime.SapGgfPostingOrchestrationStore(client, ["bis_FIFO"]);
  const [closing, plan, claim, execution, metadataResponse] = await Promise.all([
    closingRepo.get(CLOSING_ID), plans.get(CLOSING_ID, 1), claims.get(EXECUTION_ID), executions.get(EXECUTION_ID),
    writer.get("$metadata", "application/xml")
  ]);
  must(metadataResponse.ok && ["FBO_GGF_CLOSE", "FBO_GGF_CLINE", "FBO_GGF_CLAIM", "FBO_GGF_PPLAN",
    "FBO_GGF_PEXEC", "FBO_GGF_PDOC"].every(name => metadataResponse.data.includes(`Name=\"${name}\"`)),
  "SAP metadata is unavailable for the posting checkpoint");
  must(closing?.status === "POSTING_PARTIAL" && closing.version === 7 && closing.integrityStatus !== "INTEGRITY_VIOLATION" &&
    closing.postingBasis?.postingPlanHash === POSTING_HASH && closing.postingBasis.postingClosingVersion === 4 &&
    closing.postingBasis.postingPlanVersion === 1 && plan?.version === 1 && plan.closingVersion === 4 &&
    plan.status === "VALIDATED" && plan.postingHash === POSTING_HASH && plan.technicalRequestHashes?.[DOC_TYPE] === cpvScenario.requestHash &&
    claim?.status === "POSTING_PARTIAL" && claim.closingId === CLOSING_ID && claim.closingVersion === 4 &&
    claim.postingPlanVersion === 1 && claim.postingHash === POSTING_HASH &&
    execution?.status === "POSTING_PARTIAL" && execution.identity.closingId === CLOSING_ID &&
    execution.identity.closingVersion === 4 && execution.identity.postingPlanVersion === 1 &&
    execution.identity.postingHash === POSTING_HASH && execution.totalExpected === "400" &&
    execution.totalPosted === "100" && execution.totalReconciled === "100" && execution.documents.length === 3,
  "Fresh SAP Closing/Plan/Claim/Execution checkpoint differs from approval");
  const [material, cpv, close] = execution.documents;
  must(material?.documentType === "MaterialRevaluation" && material.status === "RECONCILED" &&
    material.attemptCount === 1 && material.sapDocEntry === 44 && material.sapDocNum === 7 && material.sapTransId === 2311 &&
    material.requestHash === requestHashes.MaterialRevaluation && cpv?.documentType === DOC_TYPE && cpv.status === "PENDING" &&
    cpv.attemptCount === 0 && cpv.requestHash === null && cpv.sapDocEntry === null &&
    cpv.sapDocNum === null && cpv.sapTransId === null && close?.documentType === "JournalEntry.Closing" &&
    close.status === "PENDING" && close.attemptCount === 0 && close.requestHash === null &&
    close.sapDocEntry === null && close.sapDocNum === null && close.sapTransId === null,
  "PDOC sequence, history, or links differ from the authorized checkpoint");
  const cpvPlan = plan.documents.find(document => document.type === DOC_TYPE && document.order === 2);
  must(cpvPlan?.status === "VALIDATED" && cpvPlan.totalCents === "100" && cpvPlan.currency === CURRENCY &&
    cpvPlan.blockers.length === 0 && cpvPlan.lines.length === 2 &&
    cpvPlan.lines.reduce((sum, line) => sum + BigInt(line.amountCents), 0n) === 100n &&
    cpvPlan.lines.every(line => line.debitAccount === CPV && line.creditAccount === TRANSIT && line.dimensions.length === 0),
  "Persisted CPV plan is not exactly D CPV / C transit for R$ 1.00");
  const preflightResult = await preflight(writer, runtime, cpvScenario.request);
  await assertNoExistingJournal(writer);

  let orchestrationResult;
  const gateway = {
    async prepare(document, identity) {
      must(document.type === DOC_TYPE && document.order === 2 && identity.closingId === CLOSING_ID &&
        identity.postingPlanVersion === 1 && identity.postingHash === POSTING_HASH &&
        document.totalCents === "100" && document.currency === CURRENCY && document.lines.length === 2 &&
        document.lines.reduce((sum, line) => sum + BigInt(line.amountCents), 0n) === 100n &&
        document.lines.every(line => line.debitAccount === CPV && line.creditAccount === TRANSIT && line.dimensions.length === 0),
      "Orchestrator selected a document outside the one-document CPV plan");
      return { expectedCents: "100", payload: cpvScenario.request };
    },
    async reconcile(input) {
      if (input.documentType !== DOC_TYPE || input.expectedCents !== "100" ||
          await runtime.calculateGgfRequestHash(input.payload) !== cpvScenario.requestHash)
        return { complete: false, matches: [] };
      if (input.knownDocEntry !== null) {
        const response = await writer.get(`JournalEntries(${input.knownDocEntry})`);
        if (!response.ok) return { complete: false, matches: [] };
        const row = response.data;
        return verifyJournal(row, cpvScenario.request) ? { complete: true, matches: [{
          docEntry: Number(row.JdtNum), docNum: Number(row.Number), transId: Number(row.JdtNum),
          response: journalSummary(row)
        }] } : { complete: true, matches: [] };
      }
      const filter = encodeURIComponent(`Reference eq '${CLOSING_ID}' and Memo eq '${MEMO}'`);
      const [countResponse, pageResponse] = await Promise.all([
        writer.get(`JournalEntries/$count?$filter=${filter}`), writer.get(`JournalEntries?$filter=${filter}&$top=100`)
      ]);
      if (!countResponse.ok || !pageResponse.ok || !Array.isArray(pageResponse.data?.value) ||
          pageResponse.data["odata.nextLink"] || Number(countResponse.data) !== pageResponse.data.value.length)
        return { complete: false, matches: [] };
      if (pageResponse.data.value.length !== 0) return { complete: true, matches: pageResponse.data.value.map(row => ({
        docEntry: Number(row.JdtNum), docNum: Number(row.Number), transId: Number(row.JdtNum), response: journalSummary(row)
      })) };
      return { complete: true, matches: [] };
    },
    async post(documentType, payload) {
      must(documentType === DOC_TYPE && financialPostCalls === 0 && JSON.stringify(payload) === JSON.stringify(cpvScenario.request),
        "Only the exact authorized CPV payload may be sent once");
      const [stored, storedClaim, storedClosing] = await Promise.all([
        executions.get(EXECUTION_ID), claims.get(EXECUTION_ID), closingRepo.get(CLOSING_ID)
      ]);
      const sending = stored?.documents[1];
      const payloadHash = await runtime.calculateGgfRequestHash(payload);
      must(stored?.status === "POSTING_PARTIAL" && storedClaim?.status === "POSTING_PARTIAL" &&
        storedClosing?.status === "POSTING_PARTIAL" && sending?.status === "SENDING" && sending.attemptCount === 1 &&
        sending.requestHash === payloadHash && sending.requestHash === cpvScenario.requestHash &&
        JSON.stringify(sending.request) === JSON.stringify(payload) && stored.documents[2]?.status === "PENDING" &&
        stored.documents[2]?.attemptCount === 0,
      "SAP did not read back the one-document SENDING checkpoint before POST");
      intent = { closingId: CLOSING_ID, executionId: EXECUTION_ID, postingHash: POSTING_HASH,
        documentType: DOC_TYPE, order: 2, amountCents: "100", requestHash: payloadHash,
        attemptCount: 1, attemptStartedAt: sending.attemptStartedAt, status: "SENDING",
        payload, financialPostCalls: 1, tlsMode: "LOCAL_TEST_CERTIFICATE_EXCEPTION" };
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
        throw new Error("Journal Entry response is uncertain; automatic retry is prohibited");
      }
      const row = response.data;
      const docEntry = Number(row?.JdtNum), docNum = Number(row?.Number);
      if (!Number.isSafeInteger(docEntry) || docEntry <= 0 || !Number.isSafeInteger(docNum) || docNum <= 0) {
        intent = { ...intent, status: "RESPONSE_INCOMPLETE" };
        await saveJson(INTENT, intent);
        throw new Error("Journal Entry response omitted JdtNum or Number; do not retry");
      }
      intent = { ...intent, status: "RESPONSE_RECEIVED", response: journalSummary(row),
        docEntry, docNum, transId: docEntry };
      await saveJson(INTENT, intent);
      return { docEntry, docNum, transId: docEntry, response: journalSummary(row) };
    }
  };

  const orchestrator = new runtime.GgfPostingOrchestrator(store, gateway);
  orchestrationResult = await orchestrator.postNextDocument(EXECUTION_ID, DOC_TYPE);
  must(financialPostCalls === 1 && orchestrationResult.status === "POSTING_PARTIAL" &&
    orchestrationResult.documents[0]?.status === "RECONCILED" &&
    orchestrationResult.documents[1]?.status === "RECONCILED" &&
    orchestrationResult.documents[1]?.requestHash === cpvScenario.requestHash &&
    orchestrationResult.documents[2]?.status === "PENDING" && orchestrationResult.documents[2]?.attemptCount === 0,
  "Orchestrator result differs from the one-document CPV scope");
  const cpvDocument = orchestrationResult.documents[1];
  const docEntry = Number(cpvDocument?.docEntry), docNum = Number(cpvDocument?.docNum), transId = Number(cpvDocument?.transId);
  must(Number.isSafeInteger(docEntry) && docEntry > 0 && Number.isSafeInteger(docNum) && docNum > 0 &&
    Number.isSafeInteger(transId) && transId > 0, "Reconciled CPV document identifiers are incomplete");
  await writer.close(); writer = null;
  const readback = await finalReadback(runtime, cpvScenario.request, cpvScenario.requestHash, docEntry, docNum, transId);
  intent = { ...intent, status: "RECONCILED", reconciledAt: new Date().toISOString(),
    docEntry, docNum, transId, readback };
  await saveJson(INTENT, intent);
  const result = { closingId: CLOSING_ID, executionId: EXECUTION_ID, postingHash: POSTING_HASH,
    preflight: preflightResult, cpv: { amount: "R$ 1,00", debit: CPV, credit: TRANSIT, branch: BRANCH,
      currency: CURRENCY, dimensions: "none required", requestHash: cpvScenario.requestHash,
      docEntry: intent.docEntry, docNum: intent.docNum, transId: intent.transId },
    finalStatus: { closing: "POSTING_PARTIAL", claim: "POSTING_PARTIAL", execution: "POSTING_PARTIAL",
      pdoc1: "RECONCILED", pdoc2: "RECONCILED", pdoc3: "PENDING" },
    newSessionReadback: readback, financialPostCalls };
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
