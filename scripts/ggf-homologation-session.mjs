import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseEnv } from "node:util";
import { AUTHORIZED_COMPANY } from "./ggf-sap-session.mjs";
import { createLocalTestHttpsTransport } from "./ggf-local-test-https-transport.mjs";

const READ_ACTIONS = new Set([
  "CompanyService_GetAdvancedGLAccount", "CompanyService_GetFinancePeriods",
  "CompanyService_GetFinancePeriod", "CompanyService_GetAdminInfo", "SeriesService_GetDefaultSeries",
  "MaterialRevaluationFIFOService_GetMaterialRevaluationFIFO"
]);
const WRITABLE = new Set(["Items", "ProductTrees", "ProductionOrders", "InventoryGenEntries"]);
const CLOSING_EVIDENCE_IDS = new Set(["F1HC260928A", "F1HC260928B", "F1HL260928A", "F1HL260929F"]);
const EXECUTION_METADATA_FIELDS = new Map([
  ["FBO_GGF_CLAIM", new Set(["ClosingVersion", "PostingPlanVersion", "ExecutionId", "Status", "CreatedAt", "UpdatedAt", "ClaimedBy"])],
  ["FBO_GGF_PEXEC", new Set(["ClosingId", "ClosingVersion", "PostingPlanVersion", "PostingHash", "Status", "StartedAt", "FinishedAt", "StartedBy", "LastError", "TotalExpected", "TotalPosted", "TotalReconciled", "DocumentCount"])],
  ["FBO_GGF_PDOC", new Set(["ExecutionId", "ClosingId", "ClosingVersion", "PostingPlanVersion", "PostingHash", "Sequence", "DocumentType", "PlannedAmount", "Currency", "Status", "RequestHash", "Request", "Response", "Dependencies", "AttemptCount", "AttemptStartedAt", "ResponseReceivedAt", "SapDocEntry", "SapDocNum", "SapTransId", "ReconciledAt", "ReconStatus", "SanitizedError", "AttemptHistory"])]
]);
const TECHNICAL_EXECUTION_PREFIX = "TECH7B-";
const PHASE7C = Object.freeze({ debit: "5.01.01.01.01", credit: "5.04.01.01.05", cents: 100,
  date: "2026-10-01", branch: 1, currency: "R$", memo: "HOMOLOGAÇÃO TÉCNICA FACTORYONE GGF" });
const PHASE7D = Object.freeze({ transit: "5.04.01.01.05", ggf: "5.04.01.01.03", mod: "5.04.01.01.04",
  total: 100, ggfCents: 60, modCents: 40, date: "2026-10-01", branch: 1, currency: "R$",
  memo: "HOMOLOGAÇÃO TÉCNICA FACTORYONE GGF FASE 7D" });

/** Local, opt-in test-company transport. Callers own the persistent write-intent journal. */
export async function openHomologationSession(transportOverride) {
  const env = parseEnv(await readFile(".env", "utf8"));
  const origin = new URL(env.FBO_SL_URL);
  const localCertificateException = process.env.FBO_SL_ALLOW_INVALID_CERTIFICATE === "1";
  if (env.FBO_SL_COMPANY_DB !== AUTHORIZED_COMPANY || !["dev", "test"].includes(env.FBO_ENV) ||
      origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash ||
      origin.username || origin.password || !env.FBO_SL_USER || !env.FBO_SL_PASSWORD ||
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
      (env.FBO_SL_VERIFY_TLS?.toLowerCase() === "false" && !localCertificateException))
    throw new Error("Unsafe or unauthorized homologation environment");
  const transport = transportOverride ?? (localCertificateException
    ? createLocalTestHttpsTransport(origin.origin) : fetch);
  const root = `${origin.origin}/b1s/v2/`;
  const login = await transport(root + "Login", { method:"POST", redirect:"error", signal:AbortSignal.timeout(20000),
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({CompanyDB:AUTHORIZED_COMPANY,UserName:env.FBO_SL_USER,Password:env.FBO_SL_PASSWORD}) });
  if (!login.ok) throw new Error(`SAP login rejected: HTTP ${login.status}`);
  const auth = await login.json();
  if (typeof auth.SessionId !== "string" || !/^[\w-]+$/.test(auth.SessionId)) throw new Error("SAP session missing");
  const route = login.headers.getSetCookie().map(c=>c.split(";")[0]).find(c=>c.startsWith("ROUTEID="));
  const routeNode = /ROUTEID=\.node(\d+)$/.exec(route??"")?.[1]??null;
  let cookie = `B1SESSION=${auth.SessionId}${route ? `; ${route}` : ""}`;
  let revaluationAttempted = false;
  let phase7cFinancialAttempted = false;
  let phase7cClosingId = null;
  let phase7cExecutionId = null;
  let phase7cPostingHash = null;
  let phase7dFinancialAttempted = false;
  let phase7dClosingId = null;
  let phase7dExecutionId = null;
  let phase7dPostingHash = null;
  let phase7eContext = null;
  const phase7eFinancialAttempts = new Set();
  let phase7eNextDocumentIndex = 0;
  let phase7eAllowedDocumentTypes = new Set(["MaterialRevaluation", "JournalEntry.CPV", "JournalEntry.Closing"]);
  const assertNonFinancialTlsScope = (operation) => {
    if (localCertificateException && !["PPLAN_METADATA", "PPLAN_SNAPSHOT", "GGF_SCHEMA_VERSION",
        "PEXEC_PDOC_TECHNICAL_LEDGER", "PHASE7D_TECHNICAL_LEDGER"].includes(operation))
      throw new Error("Unverified certificate mode permits only GGF posting-plan metadata and snapshot operations");
  };
  async function request(path, method, body, accept = "application/json") {
    if (!cookie || typeof path !== "string" || !path || path.startsWith("/") || /[\\#\r\n]/.test(path) || /^[a-z]+:/i.test(path))
      throw new Error("Invalid SAP path");
    const url = new URL(path,root);
    if (url.origin !== origin.origin || !url.pathname.startsWith("/b1s/v2/") || /\/(Login|Logout)(?:\/|$)/i.test(url.pathname))
      throw new Error("SAP request escaped company boundary");
    const response = await transport(url,{method,redirect:"error",signal:AbortSignal.timeout(30000),
      headers:{Cookie:cookie,Accept:accept,...(method!=="GET"?{"Content-Type":"application/json"}:{})},
      ...(method!=="GET"?{body:JSON.stringify(body)}:{})});
    const raw=await response.text();
    let data=raw;
    if ((response.headers.get("content-type")??"").includes("json")) {
      try { data=raw?JSON.parse(raw):null; } catch { if(response.ok) throw new Error("Invalid SAP JSON response"); }
    }
    return {ok:response.ok,status:response.status,data:response.ok?data:null,
      errorCode:response.ok?undefined:data?.error?.code,
      errorMessage:response.ok?undefined:String(data?.error?.message?.value??data?.error?.message??"").slice(0,300)};
  }
  return {
    routeNode,
    get(path, accept) { return request(path,"GET",undefined,accept); },
    readAction(name,body) {
      if(!READ_ACTIONS.has(name))throw new Error("Only read actions are allowed here");
      return request(name,"POST",body);
    },
    post(name,body) {
      assertNonFinancialTlsScope("BUSINESS_DOCUMENT");
      if(!WRITABLE.has(name))throw new Error("Business endpoint outside homologation scope");
      return request(name,"POST",body);
    },
    postFifoProductionIssue(body) {
      if (body?.Comments!=="FactoryOne FIFO production F1FOP2609291 issue" ||
          body?.DocDate!=="2026-09-29" || body?.BPL_IDAssignedToInvoice!==1 ||
          body?.DocumentLines?.length!==1 ||
          body.DocumentLines[0]?.ItemCode!=="F1GGF26P01" ||
          body.DocumentLines[0]?.WarehouseCode!=="01" ||
          body.DocumentLines[0]?.Quantity!==6 ||
          body.DocumentLines[0]?.AccountCode!=="5.03.01.01.03")
        throw new Error("Issue outside the dedicated FIFO production scenario");
      return request("InventoryGenExits","POST",body);
    },
    postMetadata(name,body) {
      const table=body?.TableName??body?.Code;
      const executionTable = typeof table === "string" ? table.replace(/^@/, "") : "";
      const executionMetadataWrite = (name === "UserTablesMD" && ["FBO_GGF_PEXEC","FBO_GGF_PDOC"].includes(table)) ||
        (name === "UserFieldsMD" && table === `@${executionTable}` && EXECUTION_METADATA_FIELDS.has(executionTable) &&
          EXECUTION_METADATA_FIELDS.get(executionTable).has(body?.Name)) ||
        (name === "UserObjectsMD" && ["FBO_GGF_PEXEC","FBO_GGF_PDOC"].includes(table));
      const postingPlanMetadataWrite = (name === "UserTablesMD" && table === "FBO_GGF_PPLAN") ||
        (name === "UserFieldsMD" && table === "@FBO_GGF_PPLAN") ||
        (name === "UserObjectsMD" && table === "FBO_GGF_PPLAN");
      if (localCertificateException && !(name === "UserTablesMD" && table === "FBO_GGF_PPLAN") &&
          !(name === "UserFieldsMD" && table === "@FBO_GGF_PPLAN") &&
          !(name === "UserObjectsMD" && table === "FBO_GGF_PPLAN") && !executionMetadataWrite)
        throw new Error("Unverified certificate mode permits only approved GGF posting metadata");
      if (["UserTablesMD","UserFieldsMD","UserObjectsMD"].includes(name) &&
          (typeof table==="string" && /^@?FBO_(?:SETUP|LIC|LOG|GGF_CLOSE|GGF_CLINE|GGF_CLAIM|GGF_CVERS|GGF_PPLAN|GGF_PEXEC|GGF_PDOC)$/.test(table)) &&
          (executionMetadataWrite || postingPlanMetadataWrite || !localCertificateException))
        return request(name,"POST",body);
      if (name==="FBO_SETUP" && ["core","ggf"].includes(body?.Code))return request(name,"POST",body);
      if (name==="FBO_GGF_CLOSE" && body?.Code==="F1CL2609281" && body?.U_Status==="DRAFT")
        return request(name,"POST",body);
      throw new Error("Metadata write outside controlled scope");
    },
    postTechnicalExecutionLedger(name,body) {
      assertNonFinancialTlsScope("PEXEC_PDOC_TECHNICAL_LEDGER");
      const closingId = body?.U_ClosingId;
      const executionId = body?.U_ExecutionId ?? (name === "FBO_GGF_CLAIM" ? body?.Code : body?.Code);
      if (!/^TECH7B-[A-Z0-9-]{8,40}$/.test(String(closingId)) ||
          !/^F1EX[a-f0-9]{40}$/.test(String(executionId)) ||
          !/^[a-f0-9]{64}$/.test(String(body?.U_PostingHash)))
        throw new Error("Technical execution ledger identity outside approved scope");
      if (name === "FBO_GGF_CLAIM") {
        if (body.Code !== executionId || body.U_ExecutionId !== executionId || body.U_ClosingId !== closingId ||
            body.U_Status !== "CLAIMED" || body.U_ClosingVersion !== "1" || body.U_PostingPlanVersion !== "1")
          throw new Error("Only the isolated Phase 7B test claim may be created");
      } else if (name === "FBO_GGF_PEXEC") {
        if (body.Code !== executionId || body.U_ClosingId !== closingId || body.U_Status !== "POSTING_UNCERTAIN" ||
            body.U_StartedBy !== "TECHNICAL_LEDGER_HOMOLOGATION_NO_FINANCIAL_POST")
          throw new Error("Only the isolated Phase 7B technical execution may be created");
      } else if (name === "FBO_GGF_PDOC") {
        const sequence = Number(body.U_Sequence);
        const statusAllowed = sequence === 1 ? body.U_Status === "RECONCILED" :
          sequence === 2 ? body.U_Status === "UNCERTAIN" : sequence === 3 && body.U_Status === "PENDING";
        let technical;
        try { technical = body.U_Request ? JSON.parse(body.U_Request).technicalFixture === true : body.U_Status === "PENDING"; }
        catch { technical = false; }
        if (typeof body.Code !== "string" || !body.Code.startsWith(`${executionId}D`) || body.U_ExecutionId !== executionId ||
            body.U_ClosingId !== closingId || body.U_ClosingVersion !== "1" || body.U_PostingPlanVersion !== "1" ||
            !statusAllowed || !technical)
          throw new Error("Only the three explicit technical ledger fixtures may be created");
      } else throw new Error("Execution ledger write outside technical UDO scope");
      return request(name,"POST",body);
    },
    postTechnicalCpvRecord(name, body) {
      assertNonFinancialTlsScope("PEXEC_PDOC_TECHNICAL_LEDGER");
      const closingId = String(body?.U_ClosingId ?? body?.Code ?? "");
      if (!/^TECH7C-[A-Z0-9-]{8,22}$/.test(closingId))
        throw new Error("Phase 7C technical UDO record has an invalid ClosingId");
      if (name === "FBO_GGF_PPLAN") {
        let plan;
        try { plan = JSON.parse(String(body.U_PlanSnapshot)); } catch { throw new Error("Invalid Phase 7C plan snapshot"); }
        const document = plan?.documents?.[0];
        const line = document?.lines?.[0];
        const expectedCode = `P${createHash("sha256").update(closingId).digest("hex").slice(0,14)}0001`;
        if (body.Code !== expectedCode || body.U_Status !== "VALIDATED" || body.U_PostingHash !== plan.postingHash ||
            body.U_PostingPlanVersion !== "1" || body.U_ClosingId !== closingId ||
            body.U_Version !== "4" ||
            plan.technicalOnly !== true || plan.companyDB !== AUTHORIZED_COMPANY ||
            plan.periodStart !== PHASE7C.date || plan.periodEnd !== PHASE7C.date || plan.branch !== "1" ||
            plan.currency !== PHASE7C.currency || plan.status !== "VALIDATED" || plan.totalCpv !== "100" ||
            plan.totalGgf !== "100" || plan.totalMod !== "0" || plan.totalStock !== "0" ||
            plan.totalBlocked !== "0" || plan.totalDifference !== "0" || plan.accountingDifference !== "0" ||
            plan.totalCpv !== body.U_TotalCpv || plan.totalGgf !== body.U_TotalGgf ||
            plan.totalMod !== body.U_TotalMod || plan.totalStock !== body.U_TotalStock ||
            plan.totalBlocked !== body.U_TotalBlocked || plan.accountingDifference !== body.U_AcctDifference ||
            plan.documents.length !== 1 ||
            document.type !== "JournalEntry.CPV" || document.totalCents !== "100" ||
            line.debitAccount !== PHASE7C.debit || line.creditAccount !== PHASE7C.credit ||
            line.amountCents !== "100" || line.dimensions.length !== 0 || line.payload !== null)
          throw new Error("PostingPlan is outside the approved isolated CPV scenario");
        phase7cClosingId = closingId;
        phase7cPostingHash = plan.postingHash;
      } else if (name === "FBO_GGF_CLOSE") {
        if (body.Code !== closingId || body.U_CompanyDB !== AUTHORIZED_COMPANY ||
            body.U_PeriodStart !== PHASE7C.date || body.U_PeriodEnd !== PHASE7C.date ||
            body.U_Branch !== String(PHASE7C.branch))
          throw new Error("Closing header differs from the Phase 7C test identity");
        phase7cClosingId = closingId;
      } else if (name === "FBO_GGF_CLINE") {
        if (closingId !== phase7cClosingId || body.Code !== `${closingId}.00002.0001` ||
            body.U_Version !== "2" ||
            body.U_Account !== PHASE7C.debit || body.U_Allocated !== "1.00" || body.U_Revaluation !== "0.00")
          throw new Error("Closing line is outside the single Phase 7C CPV line");
      } else if (name === "FBO_GGF_CLAIM") {
        if (!/^F1EX[a-f0-9]{40}$/.test(String(body.Code)) || body.Code !== body.U_ExecutionId ||
            body.U_ClosingId !== phase7cClosingId || body.U_ClosingVersion !== "4" ||
            body.U_PostingPlanVersion !== "1" || body.U_PostingHash !== phase7cPostingHash ||
            body.U_Status !== "CLAIMED")
          throw new Error("Financial claim is outside the one approved Phase 7C identity");
        phase7cExecutionId = body.Code;
      } else if (name === "FBO_GGF_PEXEC") {
        if (!phase7cExecutionId && body.U_Status === "READY" && /^F1EX[a-f0-9]{40}$/.test(String(body.Code)))
          phase7cExecutionId = body.Code;
        if (!/^F1EX[a-f0-9]{40}$/.test(String(body.Code)) || body.Code !== phase7cExecutionId ||
            body.U_ClosingId !== phase7cClosingId || body.U_ClosingVersion !== "4" ||
            body.U_PostingPlanVersion !== "1" || body.U_PostingHash !== phase7cPostingHash ||
            !["READY","POSTING","POSTING_PARTIAL","POSTING_UNCERTAIN","POSTED","FAILED"].includes(body.U_Status))
          throw new Error("Execution record is outside the one approved Phase 7C identity");
      } else if (name === "FBO_GGF_PDOC") {
        if (!phase7cExecutionId || body.U_ExecutionId !== phase7cExecutionId ||
            body.U_ClosingId !== phase7cClosingId || body.U_ClosingVersion !== "4" ||
            body.U_PostingPlanVersion !== "1" || body.U_DocumentType !== "JournalEntry.CPV" ||
            body.U_PostingHash !== phase7cPostingHash ||
            body.U_PlannedAmount !== "100" || body.U_Currency !== PHASE7C.currency ||
            Number(body.U_Sequence) !== 1 || !["PENDING","SENDING","SENT","RECONCILED","UNCERTAIN","FAILED"].includes(body.U_Status))
          throw new Error("Posting document record is outside the one approved Phase 7C CPV document");
        if (body.U_Status === "SENDING" && (body.U_AttemptCount !== "1" ||
            !body.U_AttemptStartedAt || !/^[a-f0-9]{64}$/.test(String(body.U_RequestHash)) ||
            !body.U_Request || JSON.parse(body.U_Request).Memo !== PHASE7C.memo))
          throw new Error("SENDING ledger state must persist one hashed attempt before the Journal Entry POST");
      } else throw new Error("UDO write outside Phase 7C technical ledger scope");
      if (!phase7cClosingId) phase7cClosingId = closingId;
      return request(name,"POST",body);
    },
    bindTechnicalCpvContext(closingId, executionId, postingHash) {
      if (!/^TECH7C-[A-Z0-9-]{8,22}$/.test(String(closingId)) ||
          !/^F1EX[a-f0-9]{40}$/.test(String(executionId)) || !/^[a-f0-9]{64}$/.test(String(postingHash)))
        throw new Error("Invalid Phase 7C readback identity");
      phase7cClosingId = closingId;
      phase7cExecutionId = executionId;
      phase7cPostingHash = postingHash;
      return true;
    },
    patchTechnicalCpvRecord(path, body) {
      assertNonFinancialTlsScope("PEXEC_PDOC_TECHNICAL_LEDGER");
      const match = /^(FBO_GGF_CLOSE|FBO_GGF_CLAIM|FBO_GGF_PEXEC|FBO_GGF_PDOC)\('([^']+)'\)$/.exec(path);
      if (!match || !phase7cClosingId || Object.keys(body ?? {}).some(key => key !== "Name" && !key.startsWith("U_")))
        throw new Error("Patch outside Phase 7C technical ledger scope");
      const [, entity, code] = match;
      if (entity === "FBO_GGF_CLOSE" && (code !== phase7cClosingId || body.U_CompanyDB !== AUTHORIZED_COMPANY ||
          body.U_PeriodStart !== PHASE7C.date || body.U_PeriodEnd !== PHASE7C.date || body.U_Branch !== "1"))
        throw new Error("Closing patch differs from Phase 7C identity");
      if (entity === "FBO_GGF_CLAIM" && (code !== phase7cExecutionId ||
          !["POSTING","POSTED","POSTING_UNCERTAIN","FAILED"].includes(body.U_Status)))
        throw new Error("Claim patch outside Phase 7C status transitions");
      if (entity === "FBO_GGF_PEXEC" && (code !== phase7cExecutionId || body.U_ClosingId !== phase7cClosingId ||
          body.U_PostingPlanVersion !== "1" || !["POSTING","POSTED","POSTING_UNCERTAIN","FAILED"].includes(body.U_Status)))
        throw new Error("Execution patch outside Phase 7C status transitions");
      if (entity === "FBO_GGF_PDOC" && (code !== `${phase7cExecutionId}D001` || body.U_ClosingId !== phase7cClosingId ||
          body.U_DocumentType !== "JournalEntry.CPV" || body.U_PlannedAmount !== "100" ||
          !["PENDING","SENDING","SENT","RECONCILED","UNCERTAIN","FAILED"].includes(body.U_Status)))
        throw new Error("Document patch outside Phase 7C CPV transitions");
      if (entity === "FBO_GGF_PDOC" && body.U_Status === "PENDING" &&
          (body.U_AttemptCount !== "0" || body.U_RequestHash || body.U_Request))
        throw new Error("A pending document cannot contain a financial attempt");
      if (entity === "FBO_GGF_CLOSE" && !["CALCULATED","VALIDATED","READY_TO_POST","POSTING","POSTED","POSTING_UNCERTAIN","FAILED"].includes(body.U_Status))
        throw new Error("Closing status outside Phase 7C lifecycle");
      return request(path,"PATCH",body);
    },
    postTechnicalCpvJournalEntry(body) {
      if (phase7cFinancialAttempted) throw new Error("Phase 7C already attempted its single Journal Entry POST");
      const lines = body?.JournalEntryLines;
      if (!phase7cClosingId || body?.Reference !== phase7cClosingId ||
          body?.ReferenceDate !== PHASE7C.date || body?.DueDate !== PHASE7C.date || body?.TaxDate !== PHASE7C.date ||
          body?.Memo !== PHASE7C.memo || !Array.isArray(lines) || lines.length !== 2 ||
          lines[0]?.AccountCode !== PHASE7C.debit || lines[0]?.Debit !== 1 || lines[0]?.Credit !== 0 ||
          lines[1]?.AccountCode !== PHASE7C.credit || lines[1]?.Debit !== 0 || lines[1]?.Credit !== 1 ||
          lines.some(line => line.BPLID !== PHASE7C.branch ||
            ["CostingCode","CostingCode2","CostingCode3","CostingCode4","CostingCode5","ProjectCode","FCCurrency"].some(key => key in line)))
        throw new Error("Journal Entry payload differs from the approved Phase 7C one-document scenario");
      phase7cFinancialAttempted = true;
      return request("JournalEntries","POST",body);
    },
    bindTechnicalPhase7DContext(closingId, executionId, postingHash) {
      if (!/^TECH7D-20261001-[A-F0-9]{10}$/.test(String(closingId)) ||
          !/^F1EX[a-f0-9]{40}$/.test(String(executionId)) || !/^[a-f0-9]{64}$/.test(String(postingHash)))
        throw new Error("Invalid Phase 7D execution identity");
      phase7dClosingId = closingId; phase7dExecutionId = executionId; phase7dPostingHash = postingHash;
      return true;
    },
    bindTechnicalPhase7EContext(closingId, executionId, postingHash, requests, requestHashes, orderIds = null,
      reconciledDocumentTypes = [], allowedDocumentTypes = ["MaterialRevaluation", "JournalEntry.CPV", "JournalEntry.Closing"]) {
      const orderedTypes = ["MaterialRevaluation", "JournalEntry.CPV", "JournalEntry.Closing"];
      if (!/^TECH7E-20261001-[A-F0-9]{10}$/.test(String(closingId)) ||
          !/^F1EX[a-f0-9]{40}$/.test(String(executionId)) || !/^[a-f0-9]{64}$/.test(String(postingHash)) ||
          !requests || Object.keys(requests).sort().join("|") !==
            "JournalEntry.CPV|JournalEntry.Closing|MaterialRevaluation" ||
          !requestHashes || Object.keys(requestHashes).sort().join("|") !==
            "JournalEntry.CPV|JournalEntry.Closing|MaterialRevaluation" ||
          Object.values(requestHashes).some(hash => !/^[a-f0-9]{64}$/.test(String(hash))) ||
          !orderIds || Object.keys(orderIds).sort().join("|") !==
            "JournalEntry.CPV|JournalEntry.Closing|MaterialRevaluation" ||
          Object.values(orderIds).some(id => typeof id !== "string" || id.length > 30 || !/^7E-(MR-01|CPV-02|CLS-03)-[A-F0-9]{16}$/.test(id)) ||
          !Array.isArray(reconciledDocumentTypes) || reconciledDocumentTypes.some((type, index) => orderedTypes[index] !== type) ||
          !Array.isArray(allowedDocumentTypes) || !allowedDocumentTypes.length ||
          allowedDocumentTypes.some(type => !orderedTypes.includes(type)) ||
          new Set(allowedDocumentTypes).size !== allowedDocumentTypes.length ||
          allowedDocumentTypes.some(type => orderedTypes.indexOf(type) < reconciledDocumentTypes.length))
        throw new Error("Invalid Phase 7E identity or request set");
      phase7eContext = { closingId, executionId, postingHash,
        requests: structuredClone(requests), requestHashes: structuredClone(requestHashes), orderIds: structuredClone(orderIds) };
      phase7eFinancialAttempts.clear();
      phase7eNextDocumentIndex = reconciledDocumentTypes.length;
      phase7eAllowedDocumentTypes = new Set(allowedDocumentTypes);
      return true;
    },
    postTechnicalPhase7ERecord(name, body) {
      assertNonFinancialTlsScope("PHASE7D_TECHNICAL_LEDGER");
      const context = phase7eContext;
      if (!context || Object.keys(body ?? {}).some(key => key !== "Name" && key !== "Code" && !key.startsWith("U_")))
        throw new Error("Phase 7E ledger write lacks bound identity or contains unexpected fields");
      if (name === "FBO_GGF_PPLAN") {
        let plan;
        try { plan = JSON.parse(String(body.U_PlanSnapshot)); } catch { throw new Error("Invalid Phase 7E plan snapshot"); }
        if (body.U_ClosingId !== context.closingId || body.U_PostingHash !== context.postingHash ||
            body.U_Status !== "VALIDATED" || body.U_PostingPlanVersion !== "1" || body.U_Version !== "4" ||
            plan.scenarioId !== "PHASE7E_TECHNICAL" || plan.postingHash !== context.postingHash || plan.closingId !== context.closingId ||
            plan.technicalRequestHashes === undefined ||
            JSON.stringify(plan.technicalRequestHashes) !== JSON.stringify(context.requestHashes) ||
            plan.totalGgf !== "120" || plan.totalMod !== "80" || plan.totalStock !== "100" ||
            plan.totalCpv !== "100" || plan.totalBlocked !== "0" || plan.documents?.length !== 3 ||
            plan.documents.map(row => row.type).join("|") !==
              "MaterialRevaluation|JournalEntry.CPV|JournalEntry.Closing" ||
            plan.documents.some(row => row.payload !== null || row.status !== "VALIDATED"))
          throw new Error("PostingPlan differs from the exact Phase 7E authorized scenario");
      } else if (name === "FBO_GGF_CLOSE") {
        if (body.Code !== context.closingId || body.U_CompanyDB !== AUTHORIZED_COMPANY ||
            body.U_PeriodStart !== "2026-10-01" || body.U_PeriodEnd !== "2026-10-01" ||
            body.U_Branch !== "1") throw new Error("Closing identity differs from Phase 7E");
      } else if (name === "FBO_GGF_CLINE") {
        const row = Number(String(body.Code).split(".").at(-1));
        const expected = row === 1 ? ["5.04.01.01.03", "1.20", "0.60"] :
          row === 2 ? ["5.04.01.01.04", "0.80", "0.40"] : null;
        const expectedOrderId = row === 1 ? context.orderIds.MaterialRevaluation : context.orderIds["JournalEntry.CPV"];
        if (body.U_ClosingId !== context.closingId || !expected || body.U_Account !== expected[0] ||
            body.U_Allocated !== expected[1] || body.U_Revaluation !== expected[2] || body.U_Version !== "2" ||
            body.U_OrderId !== expectedOrderId || String(body.U_OrderId).length > 30)
          throw new Error("Closing audit line differs from Phase 7E category values");
      } else if (name === "FBO_GGF_CLAIM") {
        if (body.Code !== context.executionId || body.U_ExecutionId !== context.executionId ||
            body.U_ClosingId !== context.closingId || body.U_ClosingVersion !== "4" ||
            body.U_PostingPlanVersion !== "1" || body.U_PostingHash !== context.postingHash ||
            body.U_Status !== "CLAIMED") throw new Error("Claim differs from Phase 7E identity");
      } else if (name === "FBO_GGF_PEXEC") {
        if (body.Code !== context.executionId || body.U_ClosingId !== context.closingId ||
            body.U_ClosingVersion !== "4" || body.U_PostingPlanVersion !== "1" ||
            body.U_PostingHash !== context.postingHash ||
            !["READY", "POSTING", "POSTING_PARTIAL", "POSTING_UNCERTAIN", "POSTED", "FAILED"].includes(body.U_Status))
          throw new Error("Execution differs from Phase 7E identity");
      } else if (name === "FBO_GGF_PDOC") {
        const sequence = Number(body.U_Sequence);
        const type = [null, "MaterialRevaluation", "JournalEntry.CPV", "JournalEntry.Closing"][sequence];
        const amount = [null, "100", "100", "200"][sequence];
        if (body.U_ExecutionId !== context.executionId || body.U_ClosingId !== context.closingId ||
            body.U_ClosingVersion !== "4" || body.U_PostingPlanVersion !== "1" ||
            body.U_PostingHash !== context.postingHash || body.U_DocumentType !== type ||
            body.U_PlannedAmount !== amount || body.U_Currency !== "R$" ||
            !["PENDING", "SENDING", "SENT", "RECONCILED", "UNCERTAIN", "FAILED"].includes(body.U_Status))
          throw new Error("PDOC differs from Phase 7E identity or authorized document set");
        if (body.U_Status === "SENDING" && (!body.U_Request || body.U_AttemptCount !== "1" ||
            !body.U_AttemptStartedAt || body.U_RequestHash !== context.requestHashes[type] ||
            JSON.stringify(JSON.parse(body.U_Request)) !== JSON.stringify(context.requests[type])))
          throw new Error("SENDING PDOC must persist its exact authorized request before POST");
      } else throw new Error("Phase 7E ledger write outside approved UDOs");
      return request(name, "POST", body);
    },
    patchTechnicalPhase7ERecord(path, body) {
      assertNonFinancialTlsScope("PHASE7D_TECHNICAL_LEDGER");
      const match = /^(FBO_GGF_CLOSE|FBO_GGF_CLAIM|FBO_GGF_PEXEC|FBO_GGF_PDOC)\('([^']+)'\)$/.exec(path);
      const context = phase7eContext;
      if (!match || !context || Object.keys(body ?? {}).some(key => key !== "Name" && !key.startsWith("U_")))
        throw new Error("Phase 7E patch outside bound technical ledger");
      const [, entity, code] = match;
      if (entity === "FBO_GGF_CLOSE") {
        const recovery = code === context.closingId && body.U_Status === "READY_TO_POST" && body.U_Version === "7" &&
          Object.keys(body).sort().join("|") === "U_Status|U_Version";
        const normal = code === context.closingId && body.U_CompanyDB === AUTHORIZED_COMPANY &&
          body.U_PeriodStart === "2026-10-01" && body.U_PeriodEnd === "2026-10-01" && body.U_Branch === "1" &&
          ["CALCULATED", "VALIDATED", "READY_TO_POST", "POSTING", "POSTING_PARTIAL", "POSTING_UNCERTAIN", "POSTED", "FAILED"].includes(body.U_Status);
        if (code !== context.closingId || (!recovery && !normal))
          throw new Error("Phase 7E closing transition outside exact lifecycle");
      }
      if (entity === "FBO_GGF_CLAIM" && (code !== context.executionId ||
          !["POSTING", "POSTING_PARTIAL", "POSTING_UNCERTAIN", "POSTED", "FAILED", "CLAIMED"].includes(body.U_Status) ||
          (body.U_Status === "CLAIMED" && Object.keys(body).some(key => !["U_Status", "U_UpdatedAt"].includes(key)))))
        throw new Error("Phase 7E claim transition outside exact lifecycle");
      if (entity === "FBO_GGF_PEXEC") {
        const auditOnly = Object.keys(body).length === 1 && typeof body.U_LastError === "string";
        const reconciliationTotals = code === context.executionId && body.U_Status === "POSTING_PARTIAL" &&
          body.U_ClosingId === context.closingId && body.U_PostingHash === context.postingHash &&
          body.U_TotalExpected === "400" && body.U_TotalPosted === "100" && body.U_TotalReconciled === "100" &&
          Object.keys(body).sort().join("|") ===
            "U_ClosingId|U_PostingHash|U_Status|U_TotalExpected|U_TotalPosted|U_TotalReconciled";
        const recoveredReady = code === context.executionId && body.U_Status === "READY" && body.U_FinishedAt === "" &&
          Object.keys(body).sort().join("|") === "U_FinishedAt|U_Status";
        const statusPatch = code === context.executionId && body.U_ClosingId === context.closingId &&
          body.U_PostingHash === context.postingHash &&
          ["POSTING", "POSTING_PARTIAL", "POSTING_UNCERTAIN", "POSTED", "FAILED", "READY"].includes(body.U_Status) &&
          (body.U_Status !== "READY" || Object.keys(body).every(key => ["U_Status", "U_FinishedAt"].includes(key)));
        if (code !== context.executionId || (!auditOnly && !statusPatch && !recoveredReady && !reconciliationTotals))
          throw new Error("Phase 7E execution transition outside exact lifecycle");
      }
      if (entity === "FBO_GGF_PDOC" && (body.U_ExecutionId !== context.executionId ||
          body.U_ClosingId !== context.closingId || !["PENDING", "SENDING", "SENT", "RECONCILED", "UNCERTAIN", "FAILED"].includes(body.U_Status)))
        throw new Error("Phase 7E PDOC transition outside exact lifecycle");
      return request(path, "PATCH", body);
    },
    postTechnicalPhase7EDocument(documentType, body) {
      const context = phase7eContext;
      const orderedTypes = ["MaterialRevaluation", "JournalEntry.CPV", "JournalEntry.Closing"];
      const endpoint = documentType === "MaterialRevaluation" ? "MaterialRevaluation" :
        documentType === "JournalEntry.CPV" || documentType === "JournalEntry.Closing" ? "JournalEntries" : null;
      if (!context || !endpoint || phase7eFinancialAttempts.has(documentType) ||
          !phase7eAllowedDocumentTypes.has(documentType) ||
          orderedTypes[phase7eNextDocumentIndex] !== documentType ||
          JSON.stringify(body) !== JSON.stringify(context.requests[documentType]))
        throw new Error("Financial POST differs from the one authorized Phase 7E request");
      phase7eFinancialAttempts.add(documentType);
      phase7eNextDocumentIndex++;
      return request(endpoint, "POST", body);
    },
    postTechnicalPhase7DRecord(name, body) {
      assertNonFinancialTlsScope("PHASE7D_TECHNICAL_LEDGER");
      const closingId = String(body?.U_ClosingId ?? body?.Code ?? "");
      if (!/^TECH7D-20261001-[A-F0-9]{10}$/.test(closingId) ||
          Object.keys(body ?? {}).some(key => key !== "Name" && !key.startsWith("U_") && key !== "Code"))
        throw new Error("Phase 7D UDO write outside the isolated technical identity");
      if (name === "FBO_GGF_PPLAN") {
        let plan;
        try { plan = JSON.parse(String(body.U_PlanSnapshot)); } catch { throw new Error("Invalid Phase 7D plan snapshot"); }
        const document = plan?.documents?.[0];
        const lines = document?.lines;
        const expectedCode = `P${createHash("sha256").update(closingId).digest("hex").slice(0,14)}0001`;
        if (body.Code !== expectedCode || body.U_Status !== "VALIDATED" || body.U_PostingHash !== plan.postingHash ||
            body.U_PostingPlanVersion !== "1" || body.U_Version !== "4" || plan.closingId !== closingId ||
            plan.technicalOnly !== true || plan.companyDB !== AUTHORIZED_COMPANY || plan.periodStart !== PHASE7D.date ||
            plan.periodEnd !== PHASE7D.date || plan.branch !== "1" || plan.currency !== PHASE7D.currency ||
            plan.totalGgf !== "60" || plan.totalMod !== "40" || plan.totalStock !== "0" || plan.totalCpv !== "0" ||
            plan.totalBlocked !== "0" || plan.documents.length !== 1 || document.type !== "JournalEntry.Closing" ||
            document.totalCents !== "100" || lines.length !== 2 ||
            lines[0].debitAccount !== PHASE7D.transit || lines[0].creditAccount !== PHASE7D.ggf || lines[0].amountCents !== "60" ||
            lines[1].debitAccount !== PHASE7D.transit || lines[1].creditAccount !== PHASE7D.mod || lines[1].amountCents !== "40" ||
            lines.some(line => line.dimensions.length !== 0 || line.payload !== null))
          throw new Error("PostingPlan differs from the approved Phase 7D accounts or values");
        phase7dClosingId = closingId; phase7dPostingHash = plan.postingHash;
      } else if (name === "FBO_GGF_CLOSE") {
        if (body.Code !== closingId || body.U_CompanyDB !== AUTHORIZED_COMPANY || body.U_PeriodStart !== PHASE7D.date ||
            body.U_PeriodEnd !== PHASE7D.date || body.U_Branch !== "1")
          throw new Error("Closing header differs from the Phase 7D scenario");
        phase7dClosingId = closingId;
      } else if (name === "FBO_GGF_CLINE") {
        const lineIndex = body.Code === `${closingId}.00002.0001` ? 0 : body.Code === `${closingId}.00002.0002` ? 1 : -1;
        const expectedAccount = lineIndex === 0 ? PHASE7D.ggf : PHASE7D.mod;
        const expectedValue = lineIndex === 0 ? "0.60" : "0.40";
        if (closingId !== phase7dClosingId || lineIndex < 0 || body.U_Version !== "2" ||
            body.U_Account !== expectedAccount || body.U_Allocated !== expectedValue || body.U_Revaluation !== "0.00")
          throw new Error("Closing audit line differs from Phase 7D values");
      } else if (name === "FBO_GGF_CLAIM") {
        if (body.Code !== body.U_ExecutionId || !/^F1EX[a-f0-9]{40}$/.test(String(body.Code)) ||
            body.U_ClosingId !== phase7dClosingId || body.U_ClosingVersion !== "4" ||
            body.U_PostingPlanVersion !== "1" || body.U_PostingHash !== phase7dPostingHash || body.U_Status !== "CLAIMED")
          throw new Error("Claim differs from the Phase 7D execution identity");
        phase7dExecutionId = body.Code;
      } else if (name === "FBO_GGF_PEXEC") {
        if (!phase7dExecutionId && body.U_Status === "READY" && /^F1EX[a-f0-9]{40}$/.test(String(body.Code)))
          phase7dExecutionId = body.Code;
        if (body.Code !== phase7dExecutionId || body.U_ClosingId !== phase7dClosingId ||
            body.U_ClosingVersion !== "4" || body.U_PostingPlanVersion !== "1" ||
            body.U_PostingHash !== phase7dPostingHash || !["READY","POSTING","POSTED","FAILED","POSTING_PARTIAL","POSTING_UNCERTAIN"].includes(body.U_Status))
          throw new Error("Execution differs from the Phase 7D identity or state");
      } else if (name === "FBO_GGF_PDOC") {
        if (body.U_ExecutionId !== phase7dExecutionId || body.U_ClosingId !== phase7dClosingId ||
            body.U_ClosingVersion !== "4" || body.U_PostingPlanVersion !== "1" ||
            body.U_DocumentType !== "JournalEntry.Closing" || body.U_PostingHash !== phase7dPostingHash ||
            body.U_PlannedAmount !== "100" || body.U_Currency !== PHASE7D.currency || Number(body.U_Sequence) !== 1 ||
            !["PENDING","SENDING","SENT","RECONCILED","UNCERTAIN","FAILED"].includes(body.U_Status))
          throw new Error("PDOC differs from the Phase 7D document");
        if (body.U_Status === "SENDING" && (body.U_AttemptCount !== "1" || !body.U_AttemptStartedAt ||
            !/^[a-f0-9]{64}$/.test(String(body.U_RequestHash)) ||
            JSON.parse(String(body.U_Request)).Memo !== PHASE7D.memo))
          throw new Error("Phase 7D SENDING state must persist its request hash before JournalEntries POST");
      } else throw new Error("Phase 7D write outside approved UDO ledger");
      return request(name, "POST", body);
    },
    patchTechnicalPhase7DRecord(path, body) {
      assertNonFinancialTlsScope("PHASE7D_TECHNICAL_LEDGER");
      const match = /^(FBO_GGF_CLOSE|FBO_GGF_CLAIM|FBO_GGF_PEXEC|FBO_GGF_PDOC)\('([^']+)'\)$/.exec(path);
      if (!match || !phase7dClosingId || Object.keys(body ?? {}).some(key => key !== "Name" && !key.startsWith("U_")))
        throw new Error("Phase 7D patch outside the technical ledger");
      const [, entity, code] = match;
      if (entity === "FBO_GGF_CLOSE" && (code !== phase7dClosingId || body.U_CompanyDB !== AUTHORIZED_COMPANY ||
          body.U_PeriodStart !== PHASE7D.date || body.U_PeriodEnd !== PHASE7D.date || body.U_Branch !== "1" ||
          !["CALCULATED","VALIDATED","READY_TO_POST","POSTING","POSTED","POSTING_UNCERTAIN","FAILED"].includes(body.U_Status)))
        throw new Error("Phase 7D closing transition outside the approved lifecycle");
      if (entity === "FBO_GGF_CLAIM" && (code !== phase7dExecutionId ||
          !["POSTING","POSTED","POSTING_UNCERTAIN","FAILED"].includes(body.U_Status)))
        throw new Error("Phase 7D claim transition is invalid");
      if (entity === "FBO_GGF_PEXEC" && (code !== phase7dExecutionId || body.U_ClosingId !== phase7dClosingId ||
          body.U_PostingPlanVersion !== "1" || !["POSTING","POSTED","POSTING_UNCERTAIN","FAILED"].includes(body.U_Status)))
        throw new Error("Phase 7D execution transition is invalid");
      if (entity === "FBO_GGF_PDOC" && (code !== `${phase7dExecutionId}D001` || body.U_ClosingId !== phase7dClosingId ||
          body.U_DocumentType !== "JournalEntry.Closing" || body.U_PlannedAmount !== "100" ||
          !["PENDING","SENDING","SENT","RECONCILED","UNCERTAIN","FAILED"].includes(body.U_Status)))
        throw new Error("Phase 7D PDOC transition is invalid");
      if (entity === "FBO_GGF_PDOC" && body.U_Status === "PENDING" &&
          (body.U_AttemptCount !== "0" || body.U_RequestHash || body.U_Request))
        throw new Error("A pending Phase 7D document cannot have a dispatched request");
      return request(path, "PATCH", body);
    },
    postTechnicalPhase7DJournalEntry(body) {
      if (phase7dFinancialAttempted) throw new Error("Phase 7D already attempted its single authorized Journal Entry");
      const lines = body?.JournalEntryLines;
      const exact = body?.Reference === phase7dClosingId && body?.Memo === PHASE7D.memo &&
        body?.ReferenceDate === PHASE7D.date && body?.DueDate === PHASE7D.date && body?.TaxDate === PHASE7D.date &&
        Array.isArray(lines) && lines.length === 3 &&
        lines[0]?.AccountCode === PHASE7D.transit && lines[0]?.Debit === 1 && lines[0]?.Credit === 0 &&
        lines[1]?.AccountCode === PHASE7D.ggf && lines[1]?.Debit === 0 && lines[1]?.Credit === 0.6 &&
        lines[2]?.AccountCode === PHASE7D.mod && lines[2]?.Debit === 0 && lines[2]?.Credit === 0.4 &&
        lines.every(line => line.BPLID === 1 && !["FCCurrency","ProjectCode","CostingCode","CostingCode2","CostingCode3","CostingCode4","CostingCode5"].some(key => key in line));
      if (!phase7dClosingId || !phase7dExecutionId || !phase7dPostingHash || !exact)
        throw new Error("Financial payload differs from the exact approved Phase 7D Journal Entry");
      phase7dFinancialAttempted = true;
      return request("JournalEntries", "POST", body);
    },
    postPostingPlan(body) {
      assertNonFinancialTlsScope("PPLAN_SNAPSHOT");
      let plan;
      try { plan = JSON.parse(String(body?.U_PlanSnapshot)); } catch { throw new Error("Invalid technical posting plan snapshot"); }
      const version = Number(body?.U_PostingPlanVersion);
      const codePrefix = createHash("sha256").update("TECH-SBODEMOBR2-202609").digest("hex").slice(0,14);
      if (body?.Code !== `P${codePrefix}${String(version).padStart(4,"0")}` ||
          body?.U_ClosingId !== "TECH-SBODEMOBR2-202609" || body?.U_Version !== "0" ||
          !Number.isSafeInteger(version) || version < 1 || body?.U_Status !== "BLOCKED" ||
          !/^[a-f0-9]{64}$/.test(String(body?.U_PostingHash)) ||
          body?.U_TotalMod !== "-300000" || body?.U_TotalGgf !== "-616600" ||
          body?.U_TotalStock !== "0" || body?.U_TotalCpv !== "0" ||
          body?.U_TotalBlocked !== "-916600" || plan?.postingBlocked !== true ||
          plan?.status !== "BLOCKED" || plan?.closingId !== body.U_ClosingId ||
          plan?.version !== version || plan?.postingHash !== body.U_PostingHash ||
          plan?.totalDifference !== "0" || plan?.documents?.some(document => document.payload !== null))
        throw new Error("Posting plan write outside the blocked technical scenario");
      return request("FBO_GGF_PPLAN","POST",body);
    },
    patchSetup(path,body) {
      if (localCertificateException && !/^FBO_SETUP\('ggf'\)$/.test(path))
        throw new Error("Unverified certificate mode permits only GGF schema version recording");
      if (!/^FBO_SETUP\('(core|ggf)'\)$/.test(path))throw new Error("Setup patch outside controlled scope");
      return request(path,"PATCH",body);
    },
    postClosingEvidence(name,body) {
      assertNonFinancialTlsScope("CLOSING_EVIDENCE");
      const id = typeof body?.Code === "string" ? body.Code.split(".")[0] : "";
      if (!new Set(["FBO_GGF_CLOSE","FBO_GGF_CLINE","FBO_GGF_CLAIM","FBO_GGF_CVERS"]).has(name) ||
          !CLOSING_EVIDENCE_IDS.has(id) ||
          !/^F1H[CL]26092[89][A-Z0-9]+(?:\.\d{5}(?:\.\d{4})?)?$/.test(body?.Code) ||
          (name==="FBO_GGF_CLINE" && !body.Code.includes(".")) ||
          (name==="FBO_GGF_CVERS" && (!/^F1HL260929F\.0000[12]$/.test(body.Code) ||
            body.U_ClosingId!==id || !["1","2"].includes(body.U_Version) ||
            body.U_TechnicalOnly!=="tYES" || !/^[a-f0-9]{64}$/.test(body.U_PostingHash) ||
            typeof body.U_PostingBasis!=="string")) ||
          (!["FBO_GGF_CLINE","FBO_GGF_CVERS"].includes(name) && body.Code.includes(".")) ||
          (name==="FBO_GGF_CLAIM" && body.U_ClosingId!==body.Code) ||
          (name==="FBO_GGF_CLINE" && !body.Code.startsWith(`${body.U_ClosingId}.`)) ||
          (name==="FBO_GGF_CLOSE" && (body.U_CompanyDB!==AUTHORIZED_COMPANY ||
            body.U_Status!=="DRAFT")))
        throw new Error("Closing evidence write outside controlled scope");
      return request(name,"POST",body);
    },
    patchClosingEvidence(path,body) {
      assertNonFinancialTlsScope("CLOSING_EVIDENCE");
      const match = /^FBO_GGF_CLOSE\('([^']+)'\)$/.exec(path);
      if (!match || !CLOSING_EVIDENCE_IDS.has(match[1]) ||
          !["CALCULATED","VALIDATED","READY_TO_POST","POSTING_UNCERTAIN","CANCELLED"].includes(body?.U_Status) ||
          Object.keys(body).some(key=>key!=="Name" && !key.startsWith("U_")) ||
          body.U_CompanyDB!==AUTHORIZED_COMPANY)
        throw new Error("Closing evidence patch outside controlled scope");
      return request(path,"PATCH",body);
    },
    patchGgfUdoAuthorization(code,body) {
      assertNonFinancialTlsScope("UDO_AUTHORIZATION");
      if (!["FBO_GGF_CLOSE","FBO_GGF_CLINE","FBO_GGF_CLAIM"].includes(code) ||
          Object.keys(body??{}).length!==1 || body.ApplyAuthorization!=="tYES")
        throw new Error("Only GGF UDO ApplyAuthorization=tYES is allowed");
      return request(`UserObjectsMD('${code}')`,"PATCH",body);
    },
    postRevaluation(payload,simulation) {
      assertNonFinancialTlsScope("MATERIAL_REVALUATION");
      if(revaluationAttempted)throw new Error("Second revaluation POST rejected");
      if(simulation?.status!=="APTO" || simulation?.evidence?.origin!=="sap" ||
          simulation.evidence.company!==AUTHORIZED_COMPANY || simulation.payload===null ||
          JSON.stringify(simulation.payload)!==JSON.stringify(payload) ||
          payload?.Reference1!=="F1H2609281" || payload?.MaterialRevaluationLines?.length!==1 ||
          payload.MaterialRevaluationLines[0].ItemCode!=="F1GGF26H01")
        throw new Error("Controlled APTO payload required");
      revaluationAttempted=true;
      return request("MaterialRevaluation","POST",payload);
    },
    postFifoRevaluation(payload,proof) {
      assertNonFinancialTlsScope("MATERIAL_REVALUATION");
      if (revaluationAttempted) throw new Error("Second revaluation POST rejected");
      const line=payload?.MaterialRevaluationLines?.[0];
      const layer=line?.FIFOLayers?.[0];
      if (proof?.status!=="FIFO_APTO" || proof.company!==AUTHORIZED_COMPANY ||
          JSON.stringify(proof.payload)!==JSON.stringify(payload) ||
          payload?.RevalType!=="P" || payload?.Reference1!=="F1FIFO2609281" ||
          payload.MaterialRevaluationLines.length!==1 || line.ItemCode!=="F1GGF26F01" ||
          line.WarehouseCode!=="01" || line.FIFOLayers.length!==1 ||
          !Number.isSafeInteger(layer.TransactionSequenceNum) ||
          !Number.isSafeInteger(layer.LayerID) || layer.Price!==10.2)
        throw new Error("Controlled FIFO_APTO payload required");
      revaluationAttempted=true;
      return request("MaterialRevaluation","POST",payload);
    },
    patchProductionOrder(key,body) {
      assertNonFinancialTlsScope("PRODUCTION_ORDER_PATCH");
      if(!Number.isSafeInteger(key)||key<=0||Object.keys(body).length!==1||
          !["boposReleased","boposClosed"].includes(body.ProductionOrderStatus))
        throw new Error("Only controlled OP release/close is allowed");
      return request(`ProductionOrders(${key})`,"PATCH",body);
    },
    async close() {
      if(!cookie)return;
      try{await transport(root+"Logout",{method:"POST",redirect:"error",signal:AbortSignal.timeout(10000),headers:{Cookie:cookie}});}
      finally{cookie="";}
    }
  };
}
