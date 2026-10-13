import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
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
  if (!["plan","snapshot-phase7b","install-phase7b","smoke","verify-exposure"].includes(operation))
    throw new Error("Choose plan, snapshot-phase7b, install-phase7b, smoke or verify-exposure");
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
    post:async(path,body)=>{
      const result=await sap.postMetadata(path,body);
      if(!result.ok)throw new ServiceLayerError(`SAP metadata write rejected HTTP ${result.status}`,
        result.status,result.errorCode);
      return result.data;
    },
    patch:async(path,body)=>unwrap(await sap.patchSetup(path,body))
  };
  const installer=new MetadataInstaller(client);
  const exposure=[];
  function assertAdditivePhase7B(plan) {
    const allowedTables = new Set(["FBO_GGF_CLAIM", "FBO_GGF_PEXEC", "FBO_GGF_PDOC"]);
    const rejected = plan.actions.filter(action => {
      if (!action.description.startsWith("Criar ")) return true;
      const table = String(action.body?.TableName ?? action.body?.Code ?? "").replace(/^@/, "");
      if (!allowedTables.has(table)) return true;
      if (action.entity === "UserTablesMD") return !["FBO_GGF_PEXEC", "FBO_GGF_PDOC"].includes(table);
      if (action.entity === "UserFieldsMD") return false;
      if (action.entity === "UserObjectsMD") return !["FBO_GGF_PEXEC", "FBO_GGF_PDOC"].includes(table);
      return true;
    });
    if (plan.module !== "ggf" || plan.warnings.length || rejected.length)
      throw new Error(`Phase 7B metadata plan is not strictly additive or contains a divergence: ${JSON.stringify({module:plan.module,warnings:plan.warnings,rejected:rejected.map(action=>({entity:action.entity,description:action.description,body:action.body}))})}`);
  }
  async function snapshotPhase7B(plan) {
    assertAdditivePhase7B(plan);
    const metadata = unwrap(await sap.get("$metadata", "application/xml"));
    if (typeof metadata !== "string") throw new Error("SAP_METADATA_UNAVAILABLE: metadata snapshot is not XML");
    const objectStates = [];
    for (const code of ["FBO_GGF_CLAIM", "FBO_GGF_PEXEC", "FBO_GGF_PDOC"]) {
      let state;
      try {
        const row = unwrap(await sap.get(`UserObjectsMD('${code}')`));
        state = { code, exists: true, tableName: row.TableName, objectType: row.ObjectType,
          applyAuthorization: row.ApplyAuthorization, canDelete: row.CanDelete };
      } catch (error) {
        if (!(error instanceof ServiceLayerError && error.status === 404)) throw error;
        state = { code, exists: false };
      }
      objectStates.push(state);
    }
    const safeSnapshot = {
      company: TEST_COMPANY, capturedAt: new Date().toISOString(), mode: "read-only-pre-install",
      metadataSha256: createHash("sha256").update(metadata).digest("hex"),
      exposedExecutionEntities: ["FBO_GGF_PEXEC", "FBO_GGF_PDOC"].map(name => ({
        name, present: metadata.includes(`<EntityType Name="${name}"`)
      })),
      objects: objectStates,
      plan: { version: plan.version, actionCount: plan.actions.length,
        warnings: plan.warnings, actions: plan.actions.map(action => ({ kind: action.kind,
          entity: action.entity, description: action.description })) },
      destructiveActions: 0, incompatibleChanges: 0, renames: 0, removals: 0,
      tlsCertificateVerified: !localCertificateException
    };
    await mkdir(".local/ggf", { recursive: true, mode: 0o700 });
    await writeFile(".local/ggf/phase7b-metadata-pre-install.json", `${JSON.stringify(safeSnapshot, null, 2)}\n`,
      { mode: 0o600 });
    return safeSnapshot;
  }
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
  if (operation === "snapshot-phase7b") {
    const plan = await installer.plan(GGF_CLOSING_METADATA);
    return await snapshotPhase7B(plan);
  }
  if (operation === "install-phase7b") {
    const snapshot = JSON.parse(await readFile(".local/ggf/phase7b-metadata-pre-install.json", "utf8"));
    if (snapshot.company !== TEST_COMPANY || snapshot.mode !== "read-only-pre-install")
      throw new Error("Approved Phase 7B pre-install snapshot is missing or has the wrong company");
    const plan = await installer.plan(GGF_CLOSING_METADATA);
    assertAdditivePhase7B(plan);
    const currentActions = plan.actions.map(action => ({ kind: action.kind, entity: action.entity,
      description: action.description }));
    if (JSON.stringify(currentActions) !== JSON.stringify(snapshot.plan.actions))
      throw new Error("SAP metadata changed after the approved pre-install snapshot; installation stopped");
    const result = await installer.install(GGF_CLOSING_METADATA, undefined, verifyExposure);
    if (result.failed) throw new Error(`Metadata installation stopped at ${result.failed.action.description}: ${result.failed.message}`);
    return { company: TEST_COMPANY, mode: "metadata-only", created: result.done.length,
      versionRecorded: result.versionRecorded, exposureDuringInstall: exposure,
      destructiveActions: 0, renames: 0, removals: 0, incompatibleChanges: 0 };
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
  const sets=[CORE_METADATA,GGF_CLOSING_METADATA];
  const plans=[];
  for (const set of sets) {
    const plan=await installer.plan(set);
    plans.push({module:set.module,version:plan.version,actions:plan.actions.length,
      actionDetails:plan.actions.map(action=>action.description),warnings:plan.warnings});
    if (plan.warnings.length && operation!=="plan")
      throw new Error(`Metadata divergence for ${set.module}: ${plan.warnings.join(" | ")}`);
  }
  if (operation==="plan") return {company:TEST_COMPANY,mode:"read-only",plans};
  return {company:TEST_COMPANY,mode:"read-only",plans};
  } finally { await sap.close(); }
}

try { console.log(JSON.stringify(await run(process.argv[2]),null,2)); }
catch(error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode=1; }
