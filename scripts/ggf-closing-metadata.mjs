import { readFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";
import { openHomologationSession } from "./ggf-homologation-session.mjs";

const TEST_COMPANY = "SBODEMOBR2";
const SMOKE_ID = "F1CL2609281";

async function bundle() {
  await mkdir(".local/ggf", { recursive:true, mode:0o700 });
  const file=".local/ggf/closing-metadata-runtime.mjs";
  await build({stdin:{contents:`
export { CORE_METADATA } from "./webapp/core/data/definitions/core.ts";
export { MetadataInstaller } from "./webapp/core/data/MetadataInstaller.ts";
export { GGF_CLOSING_METADATA } from "./webapp/modules/ggf/data/closingMetadata.ts";
export { fullTableName } from "./webapp/core/data/metadata.ts";
export { SapGgfClosingRepository } from "./webapp/modules/ggf/repository/SapGgfClosingRepository.ts";
export { ServiceLayerError } from "./webapp/core/service/errors.ts";
`,resolveDir:process.cwd()},outfile:file,bundle:true,platform:"node",format:"esm"});
  return import(pathToFileURL(resolve(file)).href+`?t=${Date.now()}`);
}

async function run(operation) {
  if (!["plan","install","smoke","verify-exposure"].includes(operation))
    throw new Error("Choose plan, install, smoke or verify-exposure");
  const env=parseEnv(await readFile(".env","utf8"));
  const url=new URL(env.FBO_SL_URL);
  const localCertificateException=process.env.FBO_SL_ALLOW_INVALID_CERTIFICATE==="1";
  if (env.FBO_SL_COMPANY_DB!==TEST_COMPANY || !["dev","test"].includes(env.FBO_ENV) ||
      url.protocol!=="https:" || url.pathname!=="/" || url.search || url.hash || url.username || url.password ||
      (env.FBO_SL_VERIFY_TLS?.toLowerCase()==="false" && !localCertificateException) ||
      process.env.NODE_TLS_REJECT_UNAUTHORIZED==="0")
    throw new Error("Controlled HTTPS test company required; TLS bypass must be scoped locally");
  const {CORE_METADATA,MetadataInstaller,GGF_CLOSING_METADATA,fullTableName,SapGgfClosingRepository,
    ServiceLayerError}=await bundle();
  const sap=await openHomologationSession();
  const unwrap=(result)=>{
    if (!result.ok) throw new ServiceLayerError(result.errorMessage||"SAP Service Layer rejected request",result.status,result.errorCode);
    return result.data;
  };
  const client={
    get:async(path)=>unwrap(await sap.get(path)),
    post:async(path,body)=>unwrap(await sap.postMetadata(path,body)),
    patch:async(path,body)=>unwrap(await sap.patchSetup(path,body))
  };
  const exposure=[];
  async function verifyExposure(set) {
    const nodes=new Set();
    const samples=set.module==="ggf"?16:8;
    for(let attempt=0;attempt<samples;attempt++) {
      const fresh=await openHomologationSession();
      try {
        if(fresh.routeNode)nodes.add(fresh.routeNode);
        const schema=await fresh.get("$metadata","application/xml");
        if(!schema.ok || typeof schema.data!=="string" || set.objects.some(object=>
            !schema.data.includes(`<EntityType Name="${fullTableName(set,object.table)}"`)))
          throw new Error("SAP_METADATA_UNAVAILABLE: UDO entity missing from fresh-session metadata");
        for(const object of set.objects) {
          const code=fullTableName(set,object.table);
          const metadata=await fresh.get(`UserObjectsMD('${code}')`);
          if(!metadata.ok || metadata.data?.Code!==code || metadata.data?.TableName!==code ||
              metadata.data?.ObjectType!=="boud_MasterData" ||
              (object.applyAuthorization && metadata.data?.ApplyAuthorization!=="tYES") ||
              (object.canDelete===false && metadata.data?.CanDelete!=="tNO"))
            throw new Error(`SAP_METADATA_UNAVAILABLE: ${code} registration not confirmed`);
          const entity=await fresh.get(`${code}/$count`);
          if(!entity.ok || !Number.isSafeInteger(Number(entity.data)) || Number(entity.data)<0)
            throw new Error(`SAP_METADATA_UNAVAILABLE: ${code} endpoint HTTP ${entity.status}`);
        }
      } finally { await fresh.close(); }
    }
    exposure.push({module:set.module,sessions:samples,nodes:[...nodes].sort(),objects:set.objects.length});
  }
  try {
  if (operation==="verify-exposure") {
    await verifyExposure(GGF_CLOSING_METADATA);
    return {company:TEST_COMPANY,mode:"read-only",exposure};
  }
  if (operation==="smoke") {
    const repo=new SapGgfClosingRepository(client);
    const existing=await repo.get(SMOKE_ID);
    if (existing) return {company:TEST_COMPANY,closingId:SMOKE_ID,status:existing.status,
      version:existing.version,created:false};
    const closing={closingId:SMOKE_ID,companyDB:TEST_COMPANY,periodStart:"2026-09-01",periodEnd:"2026-09-30",
      branch:"1",dimensions:{},status:"DRAFT",version:1,lineVersion:1,createdAt:new Date().toISOString(),
      createdBy:"FactoryOne technical metadata smoke",calculatedAt:null,postedAt:null,totalGgf:"0.00",
      totalAllocated:"0.00",totalRevalued:"0.00",sapMaterialRevaluationDocEntry:null,
      sapMaterialRevaluationDocNum:null,sapJournalTransId:null,postingHash:null,reopenedFrom:null,
      cancelledAt:null,notes:"Technical persistence smoke only; no GGF allocation or SAP revaluation",
      lastError:null,postingBasis:null,proposedPayload:null,lines:[]};
    await repo.create(closing);
    const saved=await repo.get(SMOKE_ID);
    if (!saved || saved.status!=="DRAFT" || saved.companyDB!==TEST_COMPANY || saved.version!==1)
      throw new Error("SAP closing smoke reread differs");
    return {company:TEST_COMPANY,closingId:SMOKE_ID,status:saved.status,version:saved.version,created:true};
  }
  const installer=new MetadataInstaller(client);
  const sets=[CORE_METADATA,GGF_CLOSING_METADATA];
  const plans=[];
  for (const set of sets) {
    const plan=await installer.plan(set);
    plans.push({module:set.module,version:plan.version,actions:plan.actions.length,warnings:plan.warnings});
    if (plan.warnings.length && operation!=="plan")
      throw new Error(`Metadata divergence for ${set.module}: ${plan.warnings.join(" | ")}`);
  }
  if (operation==="plan") return {company:TEST_COMPANY,mode:"read-only",plans};
  const installed=[];
  for (const set of sets) {
    let result;
    try { result=await installer.install(set,undefined,verifyExposure); }
    catch(error) { throw new Error(`${set.module} metadata install/read: ${error instanceof Error?error.message:String(error)}`); }
    installed.push({module:set.module,created:result.done.length,failed:result.failed?.action.description??null,
      versionRecorded:result.versionRecorded});
    if (result.failed) throw new Error(`Metadata installation stopped at ${result.failed.action.description}: ${result.failed.message}`);
  }
  return {company:TEST_COMPANY,mode:"metadata-only",installed,exposure};
  } finally { await sap.close(); }
}

try { console.log(JSON.stringify(await run(process.argv[2]),null,2)); }
catch(error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode=1; }
