import { build } from "esbuild";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openHomologationSession } from "./ggf-homologation-session.mjs";

const COMPANY = "SBODEMOBR2";
const DATE = "2026-10-01";
const MEMO = "HOMOLOGAÇÃO TÉCNICA FACTORYONE GGF FASE 7D";
const TRANSIT = "5.04.01.01.05";
const GGF = "5.04.01.01.03";
const MOD = "5.04.01.01.04";
const AMOUNT_CENTS = 100;
const DIMENSION_FLAGS = ["ProjectRelevant", "CostAccountingOnly", "DistributionRuleRelevant",
  "DistributionRule2Relevant", "DistributionRule3Relevant", "DistributionRule4Relevant", "DistributionRule5Relevant"];
const OUT = resolve(".local/ggf");
const RUN = resolve(OUT, "phase7d-run.json");
const INTENT = resolve(OUT, "phase7d-financial-intent.json");
const RESULT = resolve(OUT, "phase7d-result.json");
const LOCK = resolve(OUT, "phase7d.lock");

const redact = value => {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /password|cookie|token|session|authorization/i.test(key) ? "[REDACTED]" : redact(item)]));
};
const cents = value => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7)
    throw new Error("SAP amount is not exact to cents");
  return Math.round(amount * 100);
};
const must = (condition, message) => { if (!condition) throw new Error(message); };

async function saveJson(path, value, exclusive = false) {
  const data = `${JSON.stringify(redact(value), null, 2)}\n`;
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
  const output = resolve(OUT, "phase7d-runtime.mjs");
  await build({ stdin: { contents: `
export { SapGgfClosingRepository } from "./webapp/modules/ggf/repository/SapGgfClosingRepository.ts";
export { SapGgfPostingPlanRepository } from "./webapp/modules/ggf/repository/SapGgfPostingPlanRepository.ts";
export { SapGgfPostingClaimRepository, SapGgfPostingExecutionRepository } from "./webapp/modules/ggf/repository/SapGgfPostingExecutionRepository.ts";
export { SapGgfPostingOrchestrationStore } from "./webapp/modules/ggf/repository/SapGgfPostingOrchestrationStore.ts";
export { GgfPostingOrchestrator, DefiniteGgfDocumentRejection } from "./webapp/modules/ggf/service/GgfPostingOrchestrator.ts";
export { buildGgfPhase7DJournalEntry, buildGgfPhase7DPostingPlan, buildGgfPhase7DClosingBasis } from "./webapp/modules/ggf/service/GgfPhase7DTechnicalScenario.ts";
export { postingHash, transitionClosing } from "./webapp/modules/ggf/service/GgfClosing.ts";
export { calculateGgfRequestHash, calculateGgfExecutionId } from "./webapp/modules/ggf/service/GgfPostingExecution.ts";
export { ServiceLayerError } from "./webapp/core/service/errors.ts";
`, resolveDir: process.cwd() }, outfile: output, platform: "node", format: "esm", bundle: true });
  return import(pathToFileURL(output).href);
}

function clientFor(session, runtime) {
  const unwrap = response => {
    if (!response.ok) throw new runtime.ServiceLayerError("SAP request rejected", response.status,
      response.errorCode, response.errorMessage);
    return response.data;
  };
  return {
    async get(path) { return unwrap(await session.get(path, { Prefer: "odata.maxpagesize=100" })); },
    async post(path, body) { return unwrap(await session.postTechnicalPhase7DRecord(path, body)); },
    async patch(path, body) { return unwrap(await session.patchTechnicalPhase7DRecord(path, body)); }
  };
}

function journalSummary(document) {
  return { JdtNum: Number(document.JdtNum), Number: Number(document.Number), Reference: document.Reference,
    Memo: document.Memo, ReferenceDate: document.ReferenceDate,
    JournalEntryLines: document.JournalEntryLines.map(line => ({ Line_ID: line.Line_ID,
      AccountCode: line.AccountCode, Debit: line.Debit, Credit: line.Credit, BPLID: line.BPLID,
      FCCurrency: line.FCCurrency ?? null, FCDebit: line.FCDebit ?? 0, FCCredit: line.FCCredit ?? 0,
      ProjectCode: line.ProjectCode ?? null, CostingCode: line.CostingCode ?? null,
      CostingCode2: line.CostingCode2 ?? null, CostingCode3: line.CostingCode3 ?? null,
      CostingCode4: line.CostingCode4 ?? null, CostingCode5: line.CostingCode5 ?? null })) };
}

function validateJournal(document, closingId) {
  if (!document || document.Reference !== closingId || document.Memo !== MEMO ||
      String(document.ReferenceDate).slice(0, 10) !== DATE || String(document.DueDate).slice(0, 10) !== DATE ||
      String(document.TaxDate).slice(0, 10) !== DATE || !Array.isArray(document.JournalEntryLines) ||
      document.JournalEntryLines.length !== 3) return false;
  const [transit, ggf, mod] = document.JournalEntryLines;
  return transit.AccountCode === TRANSIT && cents(transit.Debit) === 100 && cents(transit.Credit) === 0 &&
    ggf.AccountCode === GGF && cents(ggf.Debit) === 0 && cents(ggf.Credit) === 60 &&
    mod.AccountCode === MOD && cents(mod.Debit) === 0 && cents(mod.Credit) === 40 &&
    document.JournalEntryLines.every(line => line.BPLID === 1 && !line.FCCurrency &&
      cents(line.FCDebit ?? 0) === 0 && cents(line.FCCredit ?? 0) === 0 &&
      ["ProjectCode","CostingCode","CostingCode2","CostingCode3","CostingCode4","CostingCode5"]
        .every(key => line[key] === null || line[key] === undefined || line[key] === ""));
}

async function preflight(session) {
  const accountCodes = [TRANSIT, GGF, MOD];
  const [accounts, branch, admin, currency, period, source, todayCount, todayRows, markerCount] = await Promise.all([
    Promise.all(accountCodes.map(code => session.get(`ChartOfAccounts('${code}')`))),
    session.get("BusinessPlaces?$filter=BPLID eq 1&$select=BPLID,BPLName,Disabled"),
    session.get("CompanyService_GetAdminInfo"), session.get("Currencies('R$')"),
    session.readAction("CompanyService_GetFinancePeriod", { FinancePeriodParams: { AbsoluteEntry: 180, PeriodIndicator: "Padrão" } }),
    session.get("JournalEntries(2307)"),
    session.get(`JournalEntries/$count?$filter=${encodeURIComponent(`ReferenceDate eq '${DATE}'`)}`),
    session.get(`JournalEntries?$filter=${encodeURIComponent(`ReferenceDate eq '${DATE}'`)}&$select=JdtNum,ReferenceDate,Reference,Memo,JournalEntryLines&$top=100`),
    session.get(`JournalEntries/$count?$filter=${encodeURIComponent(`Reference eq 'TECH7D-PRECHECK' and Memo eq '${MEMO}'`)}`)
  ]);
  must(accounts.every(response => response.ok), "All three accounts must be readable from SAP");
  const byCode = new Map(accounts.map(response => [response.data.Code, response.data]));
  for (const code of accountCodes) {
    const account = byCode.get(code);
    must(account?.Code === code && account.ActiveAccount === "tYES" && account.BlockManualPosting === "tNO",
      `Account ${code} is inactive, differs or blocks manual posting`);
    must(DIMENSION_FLAGS.every(flag => account[flag] === "tNO"),
      `Account ${code} has a required or unknown project/dimension flag`);
  }
  must(cents(byCode.get(TRANSIT).Balance) === -100 && cents(byCode.get(GGF).Balance) === 0 &&
    cents(byCode.get(MOD).Balance) === 0, "Current account balances differ from the approved exact precondition");
  must(branch.ok && branch.data.value?.length === 1 && branch.data.value[0].BPLID === 1 &&
    branch.data.value[0].Disabled === "tNO", "Branch 1 is missing, duplicated or disabled");
  must(admin.ok && admin.data.LocalCurrency === "R$" && admin.data.Country === "BR",
    "Local BRL currency was not confirmed");
  must(currency.ok && currency.data.Code === "R$" && currency.data.Name === "Real",
    "SAP BRL currency master is not verified");
  const periodData = period.data;
  must(period.ok && periodData.AbsoluteEntry === 180 && periodData.PeriodCode === "2026-10" &&
    String(periodData.PostingDateFrom).startsWith(DATE) && periodData.Locked === "tNO" &&
    periodData.PeriodStatus === "ltUnlocked", "October posting period is not open");
  must(source.ok && source.data.JdtNum === 2307 && source.data.Number === 1929 &&
    source.data.Reference === "TECH7C-20261001-935FF7551D" &&
    source.data.Memo === "HOMOLOGAÇÃO TÉCNICA FACTORYONE GGF" &&
    source.data.JournalEntryLines?.length === 2 &&
    source.data.JournalEntryLines.some(line => line.AccountCode === TRANSIT &&
      cents(line.Debit) === 0 && cents(line.Credit) === 100 && line.BPLID === 1),
    "The exact Phase 7C credit of R$ 1.00 was not verified");
  must(todayCount.ok && Number(todayCount.data) === 11 && todayRows.ok && todayRows.data.value?.length === 11 &&
    !todayRows.data["odata.nextLink"], "Today JournalEntries scope changed or pagination is incomplete; origin not proven");
  const transitLines = todayRows.data.value.flatMap(header => (header.JournalEntryLines ?? [])
    .filter(line => line.AccountCode === TRANSIT).map(line => ({ header, line })));
  must(transitLines.length === 1 && transitLines[0].header.JdtNum === 2307 &&
    transitLines[0].line.Debit === 0 && cents(transitLines[0].line.Credit) === 100,
    "The Phase 7C entry is not the sole October 1 movement on the transit account");
  must(markerCount.ok && Number(markerCount.data) === 0, "Phase 7D technical marker already exists");
  return { companyDB: COMPANY, routeNode: session.routeNode ?? null, tlsVerified: false,
    accounts: accountCodes.map(code => ({ code, name: byCode.get(code).Name,
      active: byCode.get(code).ActiveAccount, blockManualPosting: byCode.get(code).BlockManualPosting,
      balance: byCode.get(code).Balance, currency: byCode.get(code).AcctCurrency,
      dimensions: Object.fromEntries(DIMENSION_FLAGS.map(flag => [flag, byCode.get(code)[flag]])) })),
    branch: { id: 1, name: branch.data.value[0].BPLName, disabled: branch.data.value[0].Disabled },
    currency: { local: admin.data.LocalCurrency, country: admin.data.Country, currencyName: currency.data.Name },
    period: { code: periodData.PeriodCode, start: String(periodData.PostingDateFrom).slice(0, 10),
      end: String(periodData.PostingDateTo).slice(0, 10), locked: periodData.Locked, status: periodData.PeriodStatus },
    transitSource: { JdtNum: source.data.JdtNum, Number: source.data.Number, reference: source.data.Reference,
      account: TRANSIT, credit: 1, date: String(source.data.ReferenceDate).slice(0, 10) },
    transitAccountMovementsToday: transitLines.length };
}

async function verifyMetadata(session) {
  const metadata = await session.get("$metadata", "application/xml");
  must(metadata.ok && /<EntitySet\b(?=[^>]*\bName="JournalEntries")/.test(metadata.data) &&
    ["FBO_GGF_CLOSE","FBO_GGF_CLINE","FBO_GGF_CLAIM","FBO_GGF_PPLAN","FBO_GGF_PEXEC","FBO_GGF_PDOC"]
      .every(entity => metadata.data.includes(`Name="${entity}"`)), "Required SAP metadata is unavailable on this node");
  const counts = {};
  for (const entity of ["FBO_GGF_CLOSE","FBO_GGF_CLINE","FBO_GGF_CLAIM","FBO_GGF_PPLAN","FBO_GGF_PEXEC","FBO_GGF_PDOC"]) {
    const response = await session.get(`${entity}/$count`);
    must(response.ok && Number.isSafeInteger(Number(response.data)), `${entity} is not exposed consistently`);
    counts[entity] = Number(response.data);
  }
  return { present: true, entities: counts };
}

async function accountEffectCheck(session) {
  const [transit, ggf, mod] = await Promise.all([TRANSIT, GGF, MOD].map(code => session.get(`ChartOfAccounts('${code}')`)));
  must([transit, ggf, mod].every(response => response.ok), "Post-journal account balances could not be reread");
  const balances = [transit.data, ggf.data, mod.data];
  must(cents(balances[0].Balance) === 0 && cents(balances[1].Balance) === -60 &&
    cents(balances[2].Balance) === -40, "Post-journal account balances do not reflect transit zero and separate GGF/MOD credits");
  return balances.map(account => ({ code: account.Code, balance: account.Balance }));
}

let writer;
let reader;
let lock;
let realPosts = 0;
try {
  must(process.argv[2] === "execute", "Usage: node scripts/ggf-phase7d-homologation.mjs execute");
  await mkdir(OUT, { recursive: true, mode: 0o700 });
  lock = await open(LOCK, "wx", 0o600);
  must(!(await readFile(INTENT).then(() => true).catch(() => false)) &&
    !(await readFile(RESULT).then(() => true).catch(() => false)) &&
    !(await readFile(RUN).then(() => true).catch(() => false)),
    "Phase 7D already has a run/intent/result; never rerun without manual SAP reconciliation");
  const runtime = await loadRuntime();
  const closingId = `TECH7D-${DATE.replaceAll("-", "")}-${randomBytes(5).toString("hex").toUpperCase()}`;
  const at = new Date().toISOString();
  await saveJson(RUN, { closingId, companyDB: COMPANY, startedAt: at, status: "INITIALIZING" }, true);
  writer = await openHomologationSession();
  const before = await preflight(writer);
  const metadata = await verifyMetadata(writer);
  const payload = runtime.buildGgfPhase7DJournalEntry(closingId);
  const plan = await runtime.buildGgfPhase7DPostingPlan({ closingId, at });
  const basis = runtime.buildGgfPhase7DClosingBasis({ closingId, plan, payload });
  const closeHash = await runtime.postingHash(basis);
  must(cents(1) === cents(0.6) + cents(0.4) &&
    cents(payload.JournalEntryLines.reduce((sum, line) => sum + Number(line.Debit), 0)) ===
      cents(payload.JournalEntryLines.reduce((sum, line) => sum + Number(line.Credit), 0)),
    "Approved debit and credit do not balance in cents");

  const client = clientFor(writer, runtime);
  const closingRepository = new runtime.SapGgfClosingRepository(client);
  const planRepository = new runtime.SapGgfPostingPlanRepository(client, () => at);
  must(!(await closingRepository.get(closingId)) && (await planRepository.list(closingId)).length === 0,
    "Random technical ClosingId unexpectedly exists in SAP");
  const savedPlan = await planRepository.append(plan);
  must(savedPlan.version === 1 && savedPlan.postingHash === plan.postingHash,
    "Phase 7D PostingPlan did not persist as the exact first version");
  const close = { closingId, companyDB: COMPANY, periodStart: DATE, periodEnd: DATE, branch: "1", dimensions: {},
    status: "DRAFT", version: 1, lineVersion: 1, createdAt: at, createdBy: "FACTORYONE_PHASE7D_TEST",
    calculatedAt: null, postedAt: null, totalGgf: "0.00", totalAllocated: "0.00", totalRevalued: "0.00",
    sapMaterialRevaluationDocEntry: null, sapMaterialRevaluationDocNum: null, sapJournalEntryDocEntry: null,
    sapJournalEntryDocNum: null, sapJournalTransId: null, postingHash: null, reopenedFrom: null,
    cancelledAt: null, notes: MEMO, lastError: null, postingBasis: null, proposedPayload: null, lines: [] };
  await closingRepository.create(close);
  const calculated = { ...runtime.transitionClosing(close, "CALCULATED"), calculatedAt: at, totalGgf: "1.00",
    totalAllocated: "1.00", totalRevalued: "0.00", postingBasis: basis, proposedPayload: payload,
    postingHash: closeHash, lines: structuredClone(basis.lines) };
  await closingRepository.replace(close, calculated);
  const validated = runtime.transitionClosing(calculated, "VALIDATED");
  await closingRepository.replace(calculated, validated);
  const ready = runtime.transitionClosing(validated, "READY_TO_POST");
  await closingRepository.replace(validated, ready);
  must(ready.version === 4 && ready.postingHash === closeHash, "Closing lifecycle did not reach the expected ready state");

  const executionId = await runtime.calculateGgfExecutionId({ closingId, closingVersion: 4,
    postingPlanVersion: 1, postingHash: savedPlan.postingHash });
  writer.bindTechnicalPhase7DContext(closingId, executionId, savedPlan.postingHash);
  const marker = await writer.get(`JournalEntries/$count?$filter=${encodeURIComponent(`Reference eq '${closingId}' and Memo eq '${MEMO}'`)}`);
  must(marker.ok && Number(marker.data) === 0, "Journal Entry reconciliation marker already exists");

  const store = new runtime.SapGgfPostingOrchestrationStore(client, [], () => new Date().toISOString());
  const executionRepository = new runtime.SapGgfPostingExecutionRepository(client);
  const claimRepository = new runtime.SapGgfPostingClaimRepository(client);
  const gateway = {
    posts: 0,
    async prepare(document) {
      must(document.type === "JournalEntry.Closing" && document.totalCents === "100" &&
        document.currency === "R$" && document.lines.length === 2, "Unexpected persisted Phase 7D document plan");
      return { expectedCents: "100", payload };
    },
    async post(documentType, request) {
      must(documentType === "JournalEntry.Closing" && gateway.posts === 0, "Only one Phase 7D Journal Entry is permitted");
      const [execution, claim, currentClosing] = await Promise.all([executionRepository.get(executionId),
        claimRepository.get(executionId), closingRepository.get(closingId)]);
      const pdoc = execution?.documents[0];
      must(execution?.status === "POSTING" && claim?.status === "POSTING" && currentClosing?.status === "POSTING" &&
        execution.documents.length === 1 && pdoc?.status === "SENDING" && pdoc.attemptCount === 1 &&
        pdoc.requestHash === await runtime.calculateGgfRequestHash(request) &&
        JSON.stringify(pdoc.request) === JSON.stringify(request),
      "PostingPlan, claim, execution and SENDING PDOC must be persisted/readable before POST");
      const immediate = await preflight(writer);
      must(immediate.accounts[0].balance === -1 && immediate.transitSource.JdtNum === 2307,
        "Transit account precondition changed immediately before POST");
      await saveJson(INTENT, { closingId, executionId, postingHash: plan.postingHash,
        requestHash: pdoc.requestHash, attemptCount: pdoc.attemptCount,
        attemptStartedAt: pdoc.attemptStartedAt, payload: redact(request), preflight: immediate }, true);
      gateway.posts++;
      realPosts++;
      const response = await writer.postTechnicalPhase7DJournalEntry(request);
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500)
          throw new runtime.DefiniteGgfDocumentRejection(response.status, Number(response.errorCode));
        throw new Error("Journal Entry response is uncertain; no retry is allowed");
      }
      const row = response.data;
      const docEntry = Number(row.JdtNum), docNum = Number(row.Number);
      must(Number.isSafeInteger(docEntry) && docEntry > 0 && Number.isSafeInteger(docNum) && docNum > 0,
        "SAP Journal Entry response lacks JdtNum/Number");
      return { docEntry, docNum, transId: docEntry, response: journalSummary(row) };
    },
    async reconcile(input) {
      if (input.documentType !== "JournalEntry.Closing" || input.expectedCents !== "100")
        return { complete: false, matches: [] };
      let matches;
      if (input.knownDocEntry !== null) {
        const response = await writer.get(`JournalEntries(${input.knownDocEntry})`);
        if (!response.ok) return { complete: false, matches: [] };
        matches = validateJournal(response.data, closingId) ? [response.data] : [];
      } else {
        const filter = encodeURIComponent(`Reference eq '${closingId}' and Memo eq '${MEMO}'`);
        const [count, page] = await Promise.all([writer.get(`JournalEntries/$count?$filter=${filter}`),
          writer.get(`JournalEntries?$filter=${filter}&$top=100`)]);
        if (!count.ok || !page.ok || !Array.isArray(page.data.value) || page.data["odata.nextLink"] ||
            Number(count.data) !== page.data.value.length) return { complete: false, matches: [] };
        matches = page.data.value.filter(row => validateJournal(row, closingId));
      }
      if (matches.length !== 1) return { complete: true, matches: [] };
      const row = matches[0];
      const balances = await accountEffectCheck(writer);
      return { complete: true, matches: [{ docEntry: Number(row.JdtNum), docNum: Number(row.Number),
        transId: Number(row.JdtNum), response: { ...journalSummary(row), accountBalances: balances } }] };
    }
  };
  const orchestrator = new runtime.GgfPostingOrchestrator(store, gateway);
  const prepared = await orchestrator.prepare(closingId, 1);
  must(prepared.status === "READY_TO_POST" && prepared.documents.length === 1 &&
    prepared.documents[0].documentType === "JournalEntry.Closing", "Execution preparation differs from Phase 7D");
  const posted = await orchestrator.post(closingId, 1);
  must(realPosts === 1 && gateway.posts === 1 && posted.status === "POSTED" &&
    posted.documents[0]?.status === "RECONCILED" && posted.documents[0]?.reconciliation === "MATCHED",
    "The single Journal Entry did not reconcile exactly once");
  const link = { docEntry: posted.documents[0].docEntry, docNum: posted.documents[0].docNum,
    transId: posted.documents[0].transId };
  const afterBalances = await accountEffectCheck(writer);
  const [writeClosing, writeClaim, writeExecution] = await Promise.all([closingRepository.get(closingId),
    claimRepository.get(executionId), executionRepository.get(executionId)]);
  must(writeClosing?.status === "POSTED" && writeClosing.integrityStatus === "VALID" &&
    writeClosing.sapJournalEntryDocEntry === link.docEntry && writeClosing.sapJournalEntryDocNum === link.docNum &&
    writeClosing.sapJournalTransId === link.transId && writeClaim?.status === "POSTED" &&
    writeExecution?.status === "POSTED" && writeExecution.documents[0]?.status === "RECONCILED" &&
    writeExecution.documents[0].requestHash === await runtime.calculateGgfRequestHash(payload),
    "Writer-session Closing/claim/execution/PDOC linkage is inconsistent");
  await writer.close(); writer = null;

  reader = await openHomologationSession();
  const readMetadata = await verifyMetadata(reader);
  const readClient = clientFor(reader, runtime);
  const readStore = new runtime.SapGgfPostingOrchestrationStore(readClient, [], () => new Date().toISOString());
  const readClosingRepository = new runtime.SapGgfClosingRepository(readClient);
  const readPlanRepository = new runtime.SapGgfPostingPlanRepository(readClient);
  const readExecutionRepository = new runtime.SapGgfPostingExecutionRepository(readClient);
  const readClaimRepository = new runtime.SapGgfPostingClaimRepository(readClient);
  const [readClosing, readPlan, readClaim, readExecution, readJournal] = await Promise.all([
    readClosingRepository.get(closingId), readPlanRepository.get(closingId, 1), readClaimRepository.get(executionId),
    readExecutionRepository.get(executionId), reader.get(`JournalEntries(${link.docEntry})`)
  ]);
  must(readClosing?.status === "POSTED" && readClosing.integrityStatus === "VALID" &&
    readPlan?.postingHash === plan.postingHash && readClaim?.status === "POSTED" &&
    readExecution?.status === "POSTED" && readExecution.documents[0]?.status === "RECONCILED" &&
    readExecution.documents[0].requestHash === posted.documents[0].requestHash &&
    readExecution.documents[0].sapDocEntry === link.docEntry && readExecution.documents[0].sapDocNum === link.docNum &&
    readExecution.documents[0].sapTransId === link.transId && readJournal.ok && validateJournal(readJournal.data, closingId),
    "Fresh Service Layer session does not reproduce the complete Phase 7D record");
  const readBalances = await accountEffectCheck(reader);
  reader.bindTechnicalPhase7DContext(closingId, executionId, plan.postingHash);
  const resumeGateway = { posts: 0,
    async prepare() { return { expectedCents: "100", payload }; },
    async post() { resumeGateway.posts++; throw new Error("resumeExecution must never repost"); },
    async reconcile() { return { complete: false, matches: [] }; }
  };
  const resumed = await new runtime.GgfPostingOrchestrator(readStore, resumeGateway).resumeExecution(executionId);
  must(resumed.status === "POSTED" && resumed.documents[0]?.status === "RECONCILED" && resumeGateway.posts === 0,
    "resumeExecution did not preserve reconciled POSTED state without another POST");
  const finalExecution = await readExecutionRepository.get(executionId);
  const finalClaim = await readClaimRepository.get(executionId);
  const finalClosing = await readClosingRepository.get(closingId);
  const finalJournal = await reader.get(`JournalEntries(${link.docEntry})`);
  must(finalExecution?.status === "POSTED" && finalExecution.documents[0]?.status === "RECONCILED" &&
    finalClaim?.status === "POSTED" && finalClosing?.status === "POSTED" && finalClosing.integrityStatus === "VALID" &&
    finalJournal.ok && validateJournal(finalJournal.data, closingId), "Final fresh-session integrity check differs");
  const result = { scenario: "Phase 7D isolated closing/transitory technical Journal Entry",
    companyDB: COMPANY, closingId, closingVersion: finalClosing.version, postingPlanVersion: readPlan.version,
    executionId, postingHash: readPlan.postingHash, requestHash: finalExecution.documents[0].requestHash,
    preflight: before, payload: redact(payload), document: { JdtNum: link.docEntry, Number: link.docNum,
      TransId: link.transId, response: journalSummary(finalJournal.data) },
    reconciliation: { debitCents: 100, creditCents: 100, differenceCents: 0, transitAccount: TRANSIT,
      transitBalanceBeforeCents: -100, transitBalanceAfterCents: 0,
      ggfCreditCents: 60, ggfBalanceAfterCents: cents(readBalances[1].balance),
      modCreditCents: 40, modBalanceAfterCents: cents(readBalances[2].balance), branch: 1,
      currency: "R$", dimensions: [] },
    ledger: { closing: finalClosing.status, integrity: finalClosing.integrityStatus,
      claim: finalClaim.status, execution: finalExecution.status, pdoc: finalExecution.documents[0].status },
    freshSession: { metadata: readMetadata, integrityValid: true, balances: readBalances },
    resumeExecution: { status: resumed.status, additionalFinancialPosts: resumeGateway.posts },
    actualFinancialPostCount: realPosts };
  await saveJson(RESULT, result, true);
  await saveJson(RUN, { closingId, companyDB: COMPANY, status: "COMPLETED", completedAt: new Date().toISOString(),
    financialPostCount: realPosts });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ phase: "7D", stopped: true,
    error: error instanceof Error ? error.message.slice(0, 500) : "Phase 7D failed",
    financialIntentExists: await readFile(INTENT).then(() => true).catch(() => false), realPosts }));
  process.exitCode = 1;
} finally {
  await writer?.close().catch(() => {});
  await reader?.close().catch(() => {});
  await lock?.close().catch(() => {});
  await import("node:fs/promises").then(fs => fs.unlink(LOCK).catch(() => {}));
}
