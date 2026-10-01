import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseEnv } from "node:util";
import { AUTHORIZED_COMPANY } from "./ggf-sap-session.mjs";
import { createLocalTestHttpsTransport } from "./ggf-local-test-https-transport.mjs";

const READ_ACTIONS = new Set([
  "CompanyService_GetAdvancedGLAccount", "CompanyService_GetFinancePeriods",
  "CompanyService_GetFinancePeriod", "SeriesService_GetDefaultSeries",
  "MaterialRevaluationFIFOService_GetMaterialRevaluationFIFO"
]);
const WRITABLE = new Set(["Items", "ProductTrees", "ProductionOrders", "InventoryGenEntries"]);
const CLOSING_EVIDENCE_IDS = new Set(["F1HC260928A", "F1HC260928B", "F1HL260928A", "F1HL260929F"]);

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
  const assertNonFinancialTlsScope = (operation) => {
    if (localCertificateException && !["PPLAN_METADATA", "PPLAN_SNAPSHOT", "GGF_SCHEMA_VERSION"].includes(operation))
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
      if (localCertificateException && !(name === "UserTablesMD" && table === "FBO_GGF_PPLAN") &&
          !(name === "UserFieldsMD" && table === "@FBO_GGF_PPLAN") &&
          !(name === "UserObjectsMD" && table === "FBO_GGF_PPLAN"))
        throw new Error("Unverified certificate mode permits only PPLAN metadata");
      if (["UserTablesMD","UserFieldsMD","UserObjectsMD"].includes(name) &&
          typeof table==="string" && /^@?FBO_(?:SETUP|LIC|LOG|GGF_CLOSE|GGF_CLINE|GGF_CLAIM|GGF_CVERS|GGF_PPLAN)$/.test(table))
        return request(name,"POST",body);
      if (name==="FBO_SETUP" && ["core","ggf"].includes(body?.Code))return request(name,"POST",body);
      if (name==="FBO_GGF_CLOSE" && body?.Code==="F1CL2609281" && body?.U_Status==="DRAFT")
        return request(name,"POST",body);
      throw new Error("Metadata write outside controlled scope");
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
