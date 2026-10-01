import { build } from "esbuild";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openHomologationSession } from "./ggf-homologation-session.mjs";

const COMPANY = "SBODEMOBR2";
const DATE = "2026-10-01";
const DEBIT = "5.01.01.01.01";
const CREDIT = "5.04.01.01.05";
const MEMO = "HOMOLOGAÇÃO TÉCNICA FACTORYONE GGF";
const CURRENCY = "R$";
const SCHEMA_COUNT_ENTITIES = ["FBO_GGF_CLOSE", "FBO_GGF_CLINE", "FBO_GGF_CLAIM", "FBO_GGF_PPLAN",
  "FBO_GGF_PEXEC", "FBO_GGF_PDOC"];
const DIMENSION_FLAGS = ["ProjectRelevant", "DistributionRuleRelevant", "DistributionRule2Relevant",
  "DistributionRule3Relevant", "DistributionRule4Relevant", "DistributionRule5Relevant",
  "CostAccountingOnly", "CostElementRelevant"];
const OUT = resolve(".local/ggf");
const RUN_FILE = resolve(OUT, "phase7c-run.json");
const INTENT_FILE = resolve(OUT, "phase7c-financial-intent.json");
const RESULT_FILE = resolve(OUT, "phase7c-result.json");
const LOCK_FILE = resolve(OUT, "phase7c.lock");

const clean = value => {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /password|cookie|token|session|authorization/i.test(key) ? "[REDACTED]" : clean(item)]));
};
const cents = value => {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n * 100 - Math.round(n * 100)) > 1e-7) throw new Error("SAP amount is not exact to cents");
  return Math.round(n * 100);
};
const must = (condition, message) => { if (!condition) throw new Error(message); };

async function saveJson(path, value, exclusive = false) {
  const data = `${JSON.stringify(clean(value), null, 2)}\n`;
  if (exclusive) {
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    return;
  }
  const temp = `${path}.${process.pid}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  await rename(temp, path);
}

async function loadRuntime() {
  const output = resolve(OUT, "phase7c-runtime.mjs");
  await build({ stdin: { contents: `
export { SapGgfClosingRepository } from "./webapp/modules/ggf/repository/SapGgfClosingRepository.ts";
export { SapGgfPostingPlanRepository } from "./webapp/modules/ggf/repository/SapGgfPostingPlanRepository.ts";
export { SapGgfPostingClaimRepository, SapGgfPostingExecutionRepository } from "./webapp/modules/ggf/repository/SapGgfPostingExecutionRepository.ts";
export { SapGgfPostingOrchestrationStore } from "./webapp/modules/ggf/repository/SapGgfPostingOrchestrationStore.ts";
export { GgfPostingOrchestrator, DefiniteGgfDocumentRejection } from "./webapp/modules/ggf/service/GgfPostingOrchestrator.ts";
export { buildGgfPhase7CJournalEntry, buildGgfPhase7CPostingPlan, buildGgfPhase7CClosingBasis } from "./webapp/modules/ggf/service/GgfPhase7CTechnicalScenario.ts";
export { postingHash, transitionClosing } from "./webapp/modules/ggf/service/GgfClosing.ts";
export { calculateGgfRequestHash } from "./webapp/modules/ggf/service/GgfPostingExecution.ts";
export { calculateGgfExecutionId } from "./webapp/modules/ggf/service/GgfPostingExecution.ts";
export { ServiceLayerError } from "./webapp/core/service/errors.ts";
`, resolveDir: process.cwd() }, outfile: output, platform: "node", format: "esm", bundle: true });
  return import(pathToFileURL(output).href);
}

function slClient(session, runtime) {
  const unwrap = response => {
    if (!response.ok) {
      throw new runtime.ServiceLayerError(`SAP HTTP ${response.status}`, response.status,
        response.errorCode, response.errorMessage);
    }
    return response.data;
  };
  return {
    async get(path) { return unwrap(await session.get(path)); },
    async post(path, body) { return unwrap(await session.postTechnicalCpvRecord(path, body)); },
    async patch(path, body) { return unwrap(await session.patchTechnicalCpvRecord(path, body)); }
  };
}

async function checkPreflight(session) {
  const [debit, credit, branchResult, currencyResult, adminResult, periodResult] = await Promise.all([
    session.get(`ChartOfAccounts('${DEBIT}')`), session.get(`ChartOfAccounts('${CREDIT}')`),
    session.get("BusinessPlaces?$filter=BPLID eq 1"), session.get(`Currencies('${CURRENCY}')`),
    session.get("CompanyService_GetAdminInfo"),
    session.readAction("CompanyService_GetFinancePeriod", { FinancePeriodParams: { AbsoluteEntry: 180, PeriodIndicator: "Padrão" } })
  ]);
  must(debit.ok && credit.ok, "Could not revalidate both accounts from SAP");
  must(debit.data.Code === DEBIT &&
    debit.data.ActiveAccount === "tYES" && debit.data.BlockManualPosting === "tNO", "Debit account differs or is not manually postable");
  must(credit.data.Code === CREDIT &&
    credit.data.ActiveAccount === "tYES" && credit.data.BlockManualPosting === "tNO", "Credit account differs or is not manually postable");
  for (const [label, account] of [["debit", debit.data], ["credit", credit.data]]) {
    for (const flag of DIMENSION_FLAGS)
      must(account[flag] === "tNO", `${label} account has unknown or required cost-accounting field ${flag}`);
  }
  must(branchResult.ok && Array.isArray(branchResult.data.value), "Branch 1 could not be read");
  const branches = branchResult.data.value.filter(row => row.BPLID === 1);
  must(branches.length === 1 && branches[0].Disabled === "tNO", "Branch 1 is missing, duplicated, or disabled");
  must(currencyResult.ok && currencyResult.data.Code === CURRENCY && currencyResult.data.Name === "Real",
    "SAP local currency code R$ was not verified");
  must(adminResult.ok && adminResult.data.LocalCurrency === CURRENCY && adminResult.data.Country === "BR",
    "BRL local currency could not be established from SAP company settings");
  const period = periodResult.data;
  must(periodResult.ok && period.AbsoluteEntry === 180 && period.PeriodCode === "2026-10" &&
    String(period.PostingDateFrom).startsWith(DATE) && period.Locked === "tNO" && period.PeriodStatus === "ltUnlocked",
  "Posting period 2026-10-01 is not open");
  return {
    companyDB: COMPANY, tlsVerified: process.env.FBO_SL_ALLOW_INVALID_CERTIFICATE !== "1",
    accounts: [{ code: debit.data.Code, requestedName: "Custo dos Produtos Acabados Vendidos",
      sapName: debit.data.Name, active: debit.data.ActiveAccount,
      blockManualPosting: debit.data.BlockManualPosting, dimensionFlags: Object.fromEntries(DIMENSION_FLAGS.map(flag => [flag, debit.data[flag]])) },
    { code: credit.data.Code, requestedName: "(-) Transitória Fechamento Mensal",
      sapName: credit.data.Name, active: credit.data.ActiveAccount,
      blockManualPosting: credit.data.BlockManualPosting, dimensionFlags: Object.fromEntries(DIMENSION_FLAGS.map(flag => [flag, credit.data[flag]])) }],
    branch: { id: branches[0].BPLID, disabled: branches[0].Disabled },
    dimensions: { required: false, reason: "All account dimension/project/cost flags are tNO; no dimension supplied." },
    currency: { requested: "BRL", sapLocalCode: adminResult.data.LocalCurrency,
      description: currencyResult.data.Name, systemCurrency: adminResult.data.SystemCurrency },
    period: { code: period.PeriodCode, start: String(period.PostingDateFrom).slice(0, 10),
      end: String(period.PostingDateTo).slice(0, 10), locked: period.Locked, status: period.PeriodStatus }
  };
}

async function verifyMetadata(session) {
  const metadata = await session.get("$metadata", "application/xml");
  must(metadata.ok && typeof metadata.data === "string" &&
    /<EntitySet\b(?=[^>]*\bName=\"JournalEntries\")(?=[^>]*\bEntityType=\"SAPB1\.JournalEntry\")[^>]*>/.test(metadata.data),
    "JournalEntries is not exposed in Service Layer metadata");
  const counts = {};
  for (const entity of SCHEMA_COUNT_ENTITIES) {
    const response = await session.get(`${entity}/$count`);
    must(response.ok && Number.isSafeInteger(Number(response.data)) && Number(response.data) >= 0,
      `${entity}/$count is unavailable`);
    counts[entity] = Number(response.data);
  }
  return { journalEntries: "metadata-present", entities: counts };
}

function validateJournal(document, closingId) {
  if (!document || document.Reference !== closingId || document.Memo !== MEMO ||
      String(document.ReferenceDate).slice(0, 10) !== DATE || String(document.DueDate).slice(0, 10) !== DATE ||
      String(document.TaxDate).slice(0, 10) !== DATE || !Array.isArray(document.JournalEntryLines) ||
      document.JournalEntryLines.length !== 2) return false;
  const lines = document.JournalEntryLines;
  const debit = lines.find(line => line.AccountCode === DEBIT);
  const credit = lines.find(line => line.AccountCode === CREDIT);
  if (!debit || !credit || cents(debit.Debit) !== 100 || cents(debit.Credit) !== 0 ||
      cents(credit.Debit) !== 0 || cents(credit.Credit) !== 100 ||
      lines.some(line => line.BPLID !== 1 || line.FCCurrency || cents(line.FCDebit ?? 0) !== 0 ||
        cents(line.FCCredit ?? 0) !== 0 || ["CostingCode", "CostingCode2", "CostingCode3", "CostingCode4",
          "CostingCode5", "ProjectCode"].some(key => line[key] !== null && line[key] !== undefined && line[key] !== ""))) return false;
  return true;
}

function journalSummary(document) {
  if (!document || typeof document !== "object") return null;
  return {
    JdtNum: Number(document.JdtNum), Number: Number(document.Number),
    ReferenceDate: document.ReferenceDate, Memo: document.Memo, Reference: document.Reference,
    JournalEntryLines: (Array.isArray(document.JournalEntryLines) ? document.JournalEntryLines : []).map(line => ({
      Line_ID: line.Line_ID, AccountCode: line.AccountCode, Debit: line.Debit, Credit: line.Credit,
      BPLID: line.BPLID, FCCurrency: line.FCCurrency ?? null, FCDebit: line.FCDebit ?? 0,
      FCCredit: line.FCCredit ?? 0, ProjectCode: line.ProjectCode ?? null,
      CostingCode: line.CostingCode ?? null, CostingCode2: line.CostingCode2 ?? null,
      CostingCode3: line.CostingCode3 ?? null, CostingCode4: line.CostingCode4 ?? null,
      CostingCode5: line.CostingCode5 ?? null
    }))
  };
}

function makeGateway({ session, closingId, executionId, executionRepository, claimRepository,
  closingRepository, runtime, readOnly = false, onSending, onFinancialPost }) {
  let posts = 0;
  return {
    get posts() { return posts; },
    async prepare(document, identity) {
      if (document.type !== "JournalEntry.CPV" || document.totalCents !== "100" ||
          document.currency !== CURRENCY ||
          document.lines.length !== 1 || document.lines[0].debitAccount !== DEBIT ||
          document.lines[0].creditAccount !== CREDIT || document.lines[0].amountCents !== "100" ||
          document.lines[0].dimensions.length !== 0 || identity.closingId !== closingId)
        throw new Error("Persisted CPV plan differs from the approved technical test");
      return { expectedCents: "100", payload: runtime.buildGgfPhase7CJournalEntry(closingId) };
    },
    async post(documentType, payload) {
      if (readOnly) throw new Error("resumeExecution gateway cannot send financial documents");
      if (documentType !== "JournalEntry.CPV" || posts !== 0) throw new Error("Only one CPV Journal Entry attempt is permitted");
      const saved = await executionRepository.get(executionId);
      const claim = await claimRepository.get(executionId);
      const closing = await closingRepository.get(closingId);
      const doc = saved?.documents[0];
      const payloadHash = await runtime.calculateGgfRequestHash(payload);
      must(saved?.status === "POSTING" && claim?.status === "POSTING" && closing?.status === "POSTING" &&
        saved.documents.length === 1 && doc?.status === "SENDING" && doc.attemptCount === 1 &&
        doc.requestHash === payloadHash && JSON.stringify(doc.request) === JSON.stringify(payload),
      "SAP Claim/Execution/PDOC SENDING did not read back before financial POST");
      await onSending({ closingId, executionId, postingHash: saved.identity.postingHash,
        requestHash: doc.requestHash, attemptCount: doc.attemptCount, attemptStartedAt: doc.attemptStartedAt,
        payload: clean(payload), status: "SENDING" });
      posts++;
      await onFinancialPost();
      const response = await session.postTechnicalCpvJournalEntry(payload);
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500)
          throw new runtime.DefiniteGgfDocumentRejection(response.status, Number(response.errorCode));
        throw new Error("Journal Entry response is uncertain; no retry will be attempted");
      }
      const row = response.data;
      const docEntry = Number(row.JdtNum);
      const docNum = Number(row.Number);
      if (!Number.isSafeInteger(docEntry) || docEntry <= 0 || !Number.isSafeInteger(docNum) || docNum <= 0)
        throw new Error("Journal Entry response did not include JdtNum and Number");
      return { docEntry, docNum, transId: docEntry, response: journalSummary(row) };
    },
    async reconcile(input) {
      if (input.documentType !== "JournalEntry.CPV" || input.expectedCents !== "100")
        return { complete: false, matches: [] };
      if (input.knownDocEntry !== null) {
        const response = await session.get(`JournalEntries(${input.knownDocEntry})`);
        if (!response.ok) return { complete: false, matches: [] };
        const row = response.data;
        if (!validateJournal(row, closingId)) return { complete: true, matches: [] };
        return { complete: true, matches: [{ docEntry: Number(row.JdtNum), docNum: Number(row.Number),
          transId: Number(row.JdtNum), response: journalSummary(row) }] };
      }
      const filter = encodeURIComponent(`Reference eq '${closingId}' and Memo eq '${MEMO}'`);
      const countResult = await session.get(`JournalEntries/$count?$filter=${filter}`);
      const pageResult = await session.get(`JournalEntries?$filter=${filter}&$top=100`);
      if (!countResult.ok || !pageResult.ok || !Array.isArray(pageResult.data.value) || pageResult.data["@odata.nextLink"])
        return { complete: false, matches: [] };
      const count = Number(countResult.data);
      if (!Number.isSafeInteger(count) || count !== pageResult.data.value.length)
        return { complete: false, matches: [] };
      const matches = pageResult.data.value.filter(row => validateJournal(row, closingId)).map(row => ({
        docEntry: Number(row.JdtNum), docNum: Number(row.Number), transId: Number(row.JdtNum), response: journalSummary(row)
      }));
      return { complete: true, matches };
    }
  };
}

let lock;
let writer;
let reader;
try {
  must(process.argv[2] === "execute", "Usage: node scripts/ggf-phase7c-homologation.mjs execute");
  await mkdir(OUT, { recursive: true, mode: 0o700 });
  lock = await open(LOCK_FILE, "wx", 0o600);
  must(!(await readFile(INTENT_FILE).then(() => true).catch(() => false)) &&
    !(await readFile(RESULT_FILE).then(() => true).catch(() => false)),
    "A financial intent/result already exists; reconcile it manually and never rerun");
  const runtime = await loadRuntime();
  globalThis.runtime = runtime;
  const existingRun = await readFile(RUN_FILE, "utf8").then(JSON.parse).catch(error => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existingRun) must(["INITIALIZING", "TECHNICAL_SETUP_READY"].includes(existingRun.status) && existingRun.companyDB === COMPANY &&
    /^TECH7C-[A-Z0-9-]{8,22}$/.test(existingRun.closingId),
  "Existing Phase 7C run is past a safely resumable checkpoint; reconcile it manually");
  const runId = existingRun?.closingId ??
    `TECH7C-${DATE.replaceAll("-", "")}-${randomBytes(5).toString("hex").toUpperCase()}`;
  const at = existingRun?.startedAt ?? new Date().toISOString();
  if (!existingRun) await saveJson(RUN_FILE,
    { closingId: runId, startedAt: at, status: "INITIALIZING", companyDB: COMPANY }, true);
  writer = await openHomologationSession();
  const preflight = await checkPreflight(writer);
  const metadata = await verifyMetadata(writer);
  const markerFilter = encodeURIComponent(`Reference eq '${runId}' and Memo eq '${MEMO}'`);
  const markerCount = await writer.get(`JournalEntries/$count?$filter=${markerFilter}`);
  must(markerCount.ok && Number(markerCount.data) === 0, "An existing Journal Entry already has this technical marker");
  const client = slClient(writer, runtime);
  const plan = await runtime.buildGgfPhase7CPostingPlan({ closingId: runId, at, createdBy: "FACTORYONE_PHASE7C_TEST" });
  must(cents(1) === Number(plan.totalCpv), "Debit and credit do not reconcile to 100 cents");
  const planRepository = new runtime.SapGgfPostingPlanRepository(client, () => at);
  const savedPlan = await planRepository.get(runId, 1) ?? await planRepository.append(plan);
  must(savedPlan.technicalOnly === true && savedPlan.postingHash === plan.postingHash && savedPlan.version === 1,
    "Existing technical PostingPlan differs; no new version will be appended");
  must(savedPlan.postingHash === plan.postingHash && savedPlan.version === 1, "PostingPlan SAP readback differs");

  const payload = runtime.buildGgfPhase7CJournalEntry(runId);
  const basis = runtime.buildGgfPhase7CClosingBasis({ closingId: runId, plan: savedPlan, payload });
  const close = {
    closingId: runId, companyDB: COMPANY, periodStart: DATE, periodEnd: DATE, branch: "1", dimensions: {},
    status: "DRAFT", version: 1, lineVersion: 1, createdAt: at, createdBy: "FACTORYONE_PHASE7C_TEST",
    calculatedAt: null, postedAt: null, totalGgf: "0.00", totalAllocated: "0.00", totalRevalued: "0.00",
    sapMaterialRevaluationDocEntry: null, sapMaterialRevaluationDocNum: null, sapJournalEntryDocEntry: null,
    sapJournalEntryDocNum: null, sapJournalTransId: null, postingHash: null, reopenedFrom: null,
    cancelledAt: null, notes: MEMO, lastError: null, postingBasis: null, proposedPayload: null, lines: []
  };
  const closingRepository = new runtime.SapGgfClosingRepository(client, { now: () => at });
  let ready = await closingRepository.get(runId);
  if (!ready) {
    await closingRepository.create(close);
    const calculated = { ...runtime.transitionClosing(close, "CALCULATED"), calculatedAt: at,
      totalGgf: "1.00", totalAllocated: "1.00", totalRevalued: "0.00", postingBasis: basis,
      proposedPayload: payload, postingHash: await runtime.postingHash(basis), lines: structuredClone(basis.lines) };
    await closingRepository.replace(close, calculated);
    const validated = runtime.transitionClosing(calculated, "VALIDATED");
    await closingRepository.replace(calculated, validated);
    ready = runtime.transitionClosing(validated, "READY_TO_POST");
    await closingRepository.replace(validated, ready);
  } else {
    must(ready.status === "READY_TO_POST" && ready.version === 4 && ready.postingBasis?.postingPlanHash === savedPlan.postingHash &&
      ready.postingBasis?.postingPlanVersion === 1 && ready.postingHash === await runtime.postingHash(basis) &&
      JSON.stringify(ready.proposedPayload) === JSON.stringify(payload) &&
      JSON.stringify(ready.lines) === JSON.stringify(basis.lines),
    "Existing Closing does not match the exact ready technical scenario; no financial action will continue");
  }
  await saveJson(RUN_FILE, { closingId: runId, startedAt: at, status: "TECHNICAL_SETUP_READY",
    companyDB: COMPANY }, false);

  const store = new runtime.SapGgfPostingOrchestrationStore(client, [], () => at);
  const claimRepository = new runtime.SapGgfPostingClaimRepository(client);
  const executionRepository = new runtime.SapGgfPostingExecutionRepository(client);
  const expectedExecutionId = await runtime.calculateGgfExecutionId({ closingId: runId,
    closingVersion: savedPlan.closingVersion, postingPlanVersion: savedPlan.version, postingHash: savedPlan.postingHash });
  writer.bindTechnicalCpvContext(runId, expectedExecutionId, savedPlan.postingHash);
  const existingExecutionResponse = await writer.get(`FBO_GGF_PEXEC('${expectedExecutionId}')`);
  const existingExecution = existingExecutionResponse.ok ? existingExecutionResponse.data : null;
  if (existingExecution) {
    must(existingExecution.Code === expectedExecutionId && existingExecution.U_ClosingId === runId &&
      existingExecution.U_ClosingVersion === "4" && existingExecution.U_PostingPlanVersion === "1" &&
      existingExecution.U_PostingHash === savedPlan.postingHash && existingExecution.U_Status === "READY" &&
      existingExecution.U_TotalExpected === "100" && existingExecution.U_TotalPosted === "0" &&
      existingExecution.U_TotalReconciled === "0" && existingExecution.U_DocumentCount === "1" &&
      typeof existingExecution.U_StartedAt === "string" &&
      !((await writer.get(`FBO_GGF_PDOC/$count?$filter=${encodeURIComponent(`U_ClosingId eq '${runId}'`)}`)).data > 0) &&
      !((await writer.get(`FBO_GGF_CLAIM/$count?$filter=${encodeURIComponent(`U_ClosingId eq '${runId}'`)}`)).data > 0),
    "Existing incomplete PEXEC is not an undispatched one-document READY snapshot");
  }
  let financialPostCount = 0;
  const gateway = makeGateway({ session: writer, closingId: runId, executionId: "",
    executionRepository, claimRepository, closingRepository, runtime,
    async onSending() {}, async onFinancialPost() {} });
  const orchestrator = new runtime.GgfPostingOrchestrator(store, gateway,
    () => existingExecution?.U_StartedAt ? String(existingExecution.U_StartedAt) : new Date().toISOString());
  const prepared = await orchestrator.prepare(runId, 1);
  const executionId = prepared.executionId;
  must(executionId === expectedExecutionId, "ExecutionId differs from the bound technical scenario identity");
  must(prepared.status === "READY_TO_POST" && prepared.documents.length === 1 &&
    prepared.documents[0].documentType === "JournalEntry.CPV", "Execution is not a single CPV document");

  const writerGateway = makeGateway({ session: writer, closingId: runId, executionId,
    executionRepository, claimRepository, closingRepository, runtime,
    async onSending(record) { await saveJson(INTENT_FILE, record, true); },
    async onFinancialPost() { financialPostCount++; } });
  const postingOrchestrator = new runtime.GgfPostingOrchestrator(store, writerGateway);
  const posted = await postingOrchestrator.post(runId, 1);
  must(financialPostCount === 1 && writerGateway.posts === 1, "Financial POST count is not exactly one");
  must(posted.status === "POSTED" && posted.documents.length === 1 && posted.documents[0].status === "RECONCILED" &&
    posted.documents[0].reconciliation === "MATCHED", "SAP Journal Entry did not reconcile through the orchestrator");
  const closingPosted = await closingRepository.get(runId);
  must(closingPosted?.status === "POSTED" && closingPosted.integrityStatus === "VALID" &&
    closingPosted.sapJournalEntryDocEntry === posted.documents[0].docEntry &&
    closingPosted.sapJournalEntryDocNum === posted.documents[0].docNum &&
    closingPosted.sapJournalTransId === posted.documents[0].transId, "Technical closing link or integrity differs");
  const writerExecution = await executionRepository.get(executionId);
  must(writerExecution?.documents[0]?.status === "RECONCILED" && writerExecution.documents[0].attemptCount === 1 &&
    writerExecution.documents[0].requestHash === await runtime.calculateGgfRequestHash(payload),
  "PDOC does not show one reconciled and hashed attempt");
  const writerClaim = await claimRepository.get(executionId);
  must(writerClaim?.status === "POSTED", "Financial claim is not POSTED");
  const link = { docEntry: posted.documents[0].docEntry, docNum: posted.documents[0].docNum,
    transId: posted.documents[0].transId };
  await writer.close();
  writer = null;

  reader = await openHomologationSession();
  const readerClient = slClient(reader, runtime);
  const readerStore = new runtime.SapGgfPostingOrchestrationStore(readerClient, [], () => new Date().toISOString());
  const readerClaimRepository = new runtime.SapGgfPostingClaimRepository(readerClient);
  const readerExecutionRepository = new runtime.SapGgfPostingExecutionRepository(readerClient);
  const readerClosingRepository = new runtime.SapGgfClosingRepository(readerClient);
  const roundTrip = await readerExecutionRepository.get(executionId);
  const roundTripClaim = await readerClaimRepository.get(executionId);
  const roundTripClosing = await readerClosingRepository.get(runId);
  const roundTripPlan = await new runtime.SapGgfPostingPlanRepository(readerClient).get(runId, 1);
  must(roundTrip?.status === "POSTED" && roundTrip.documents[0]?.status === "RECONCILED" &&
    roundTripClaim?.status === "POSTED" && roundTripClosing?.status === "POSTED" &&
    roundTripClosing.integrityStatus === "VALID" && roundTripPlan?.postingHash === savedPlan.postingHash &&
    roundTrip.documents[0].sapDocEntry === link.docEntry && roundTrip.documents[0].sapDocNum === link.docNum &&
    roundTrip.documents[0].sapTransId === link.transId, "Fresh-session ledger round-trip differs");
  const readbackJournal = await reader.get(`JournalEntries(${link.docEntry})`);
  must(readbackJournal.ok && validateJournal(readbackJournal.data, runId), "Fresh-session Journal Entry differs");
  reader.bindTechnicalCpvContext(runId, executionId, savedPlan.postingHash);
  const recoveryGateway = makeGateway({ session: reader, closingId: runId, executionId,
    executionRepository: readerExecutionRepository, claimRepository: readerClaimRepository,
    closingRepository: readerClosingRepository, runtime, readOnly: true,
    async onSending() { throw new Error("resume must not send"); },
    async onFinancialPost() { throw new Error("resume must not send"); } });
  const recovery = new runtime.GgfPostingOrchestrator(readerStore, recoveryGateway);
  const resumed = await recovery.resumeExecution(executionId);
  must(resumed.status === "POSTED" && resumed.documents[0]?.status === "RECONCILED" &&
    recoveryGateway.posts === 0 && financialPostCount === 1, "resumeExecution attempted or changed a financial POST");
  const finalJournal = await reader.get(`JournalEntries(${link.docEntry})`);
  must(finalJournal.ok && validateJournal(finalJournal.data, runId), "Final Journal Entry readback differs");

  const result = {
    scenario: "FACTORYONE GGF Phase 7C isolated technical CPV Journal Entry",
    companyDB: COMPANY, closingId: runId, closingVersion: roundTripClosing.version,
    postingPlanVersion: roundTripPlan.version, postingHash: roundTripPlan.postingHash,
    executionId, requestHash: roundTrip.documents[0].requestHash, preflight, metadata,
    payload: clean(payload), response: journalSummary(roundTrip.documents[0].response),
    document: { docEntry: link.docEntry, docNum: link.docNum, transId: link.transId,
      memo: finalJournal.data.Memo, reference: finalJournal.data.Reference,
      date: String(finalJournal.data.ReferenceDate).slice(0, 10) },
    reconciliation: { debitCents: 100, creditCents: 100, differenceCents: 0,
      accounts: [{ code: DEBIT, debitCents: 100, creditCents: 0 },
        { code: CREDIT, debitCents: 0, creditCents: 100 }], branch: 1, dimensions: [], currency: CURRENCY },
    ledger: { claim: roundTripClaim.status, execution: roundTrip.status, document: roundTrip.documents[0].status,
      closing: roundTripClosing.status, integrity: roundTripClosing.integrityStatus },
    resumeExecution: { status: resumed.status, additionalFinancialPosts: recoveryGateway.posts },
    actualFinancialPostCount: financialPostCount
  };
  await saveJson(RESULT_FILE, result);
  await saveJson(RUN_FILE, { closingId: runId, startedAt: at, completedAt: new Date().toISOString(),
    status: "COMPLETED", companyDB: COMPANY, financialPostCount });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const safeError = error instanceof Error ? error.message.slice(0, 500) : "Phase 7C failed";
  process.stderr.write(`${JSON.stringify({ phase: "7C", stopped: true, error: safeError, intentExists:
    await readFile(INTENT_FILE).then(() => true).catch(() => false) })}\n`);
  process.exitCode = 1;
} finally {
  await writer?.close().catch(() => {});
  await reader?.close().catch(() => {});
  await lock?.close().catch(() => {});
  await import("node:fs/promises").then(fs => fs.unlink(LOCK_FILE).catch(() => {}));
}
