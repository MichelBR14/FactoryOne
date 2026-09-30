import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { openHomologationSession } from "./ggf-homologation-session.mjs";

const ID="F1HL260929F",COMPANY="SBODEMOBR2",STATE=".local/ggf/fifo-closing-F1HL260929F-state.json";
const expect=(condition,message)=>{if(!condition)throw new Error(message);};
const ok=(response,label)=>{if(!response.ok)throw new Error(`${label}: HTTP ${response.status}, SAP ${response.errorCode??"unknown"}`);return response.data;};
async function runtime() {
  await mkdir(".local/ggf",{recursive:true,mode:0o700});
  const file=".local/ggf/fifo-closing-runtime.mjs";
  await build({stdin:{contents:`export { SapGgfClosingRepository } from "./webapp/modules/ggf/repository/SapGgfClosingRepository.ts";
export { SapGgfClosingVersionRepository } from "./webapp/modules/ggf/repository/SapGgfClosingVersionRepository.ts";
export { ServiceLayerError } from "./webapp/core/service/errors.ts";
export { postingHash, assertClosingConsistency, transitionClosing } from "./webapp/modules/ggf/service/GgfClosing.ts";`,
    resolveDir:process.cwd()},outfile:file,bundle:true,platform:"node",format:"esm"});
  return import(pathToFileURL(resolve(file)).href+`?t=${Date.now()}`);
}
function transport(sap,core) {
  const unwrap=result=>{if(!result.ok)throw new core.ServiceLayerError(`SAP HTTP ${result.status}`,
    result.status,result.errorCode);return result.data;};
  return {get:async path=>unwrap(await sap.get(path)),
    post:async(path,body)=>unwrap(await sap.postClosingEvidence(path,body)),
    patch:async(path,body)=>unwrap(await sap.patchClosingEvidence(path,body))};
}
async function state() {
  try {return JSON.parse(await readFile(STATE,"utf8"));}
  catch(error) {if(error.code==="ENOENT")return {closingId:ID,attempts:{}};throw error;}
}
async function save(data) {
  await mkdir(".local/ggf",{recursive:true,mode:0o700});
  const temp=`${STATE}.${process.pid}.tmp`;
  await writeFile(temp,JSON.stringify(data,null,2)+"\n",{mode:0o600});await rename(temp,STATE);
}
async function technicalTrace(sap,version,status) {
  const op=ok(await sap.get("ProductionOrders(214)"),"technical OP");
  const receipt=ok(await sap.get("InventoryGenEntries(122)"),"production receipt");
  const issue=ok(await sap.get("InventoryGenExits(90)"),"partial issue");
  const item=ok(await sap.get("Items('F1GGF26P01')?$select=ItemCode,CostAccountingMethod,InventoryUOM,QuantityOnStock,ItemWarehouseInfoCollection"),"FIFO item");
  const layerData=ok(await sap.readAction("MaterialRevaluationFIFOService_GetMaterialRevaluationFIFO",
    {MaterialRevaluationFIFOParams:{ItemCode:"F1GGF26P01",LocationCode:"01",LocationType:"64",ShowIssuedLayers:"tNO"}}),"FIFO layer");
  const layer=layerData.Layers?.filter(row=>row.TransactionSequenceNum===2792&&row.LayerID===0);
  const receiptLine=receipt.DocumentLines?.[0],issueLine=issue.DocumentLines?.[0];
  expect(op.AbsoluteEntry===214&&op.DocumentNumber===83&&op.ItemNo==="F1GGF26P01"&&
    op.CompletedQuantity===10&&op.ProductionOrderStatus==="boposClosed"&&
    receipt.DocEntry===122&&receipt.DocNum===77&&receiptLine?.BaseType===202&&
    receiptLine.BaseEntry===214&&receiptLine.InventoryQuantity===10&&receiptLine.LineTotal===120&&
    receiptLine.WarehouseCode==="01"&&issue.DocEntry===90&&issue.DocNum===40&&
    issueLine?.InventoryQuantity===6&&issueLine.LineTotal===72&&issueLine.WarehouseCode==="01"&&
    item.CostAccountingMethod==="bis_FIFO"&&item.InventoryUOM==="UN"&&item.QuantityOnStock===4&&
    item.ItemWarehouseInfoCollection?.find(row=>row.WarehouseCode==="01")?.InStock===4&&
    layer?.length===1&&layer[0].DocNumber==="77"&&layer[0].DocType==="ttGeneralReceiptToStock"&&
    layer[0].OpenQty===4&&layer[0].CurrentCost===12,"FIFO evidence changed; no UDO write allowed");
  return {closingId:ID,version,productionOrderDocEntry:214,productionOrderDocNum:83,
    receiptDocEntry:122,receiptDocNum:77,receiptLine:0,itemCode:"F1GGF26P01",warehouseCode:"01",
    originalProducedQuantity:"10",originalLayerId:{transactionSequenceNum:2792,layerId:0},
    originalLayerQuantity:"10",originalLayerCost:"12",remainingLayerQuantity:"4",
    consumedQuantity:"6",remainingLayerValue:"48",traceStatus:status,
    traceTimestamp:new Date().toISOString(),revaluationDocEntry:null,revaluationDocNum:null,
    resultLayerId:null,resultLayerQuantity:null,resultLayerCost:null};
}
function draft(trace) {
  const line={account:"TECH-NOT-GGF",criterion:"FIFO_TRACE",orderId:"83",item:trace.itemCode,
    warehouse:trace.warehouseCode,basis:"10",percent:"0",allocated:"0.00",costBefore:"12.00",
    costAfter:"12.00",revaluation:"0.00",status:"TECHNICAL_ONLY"};
  const payload={technicalOnly:true,noPosting:true,MaterialRevaluationLines:[]};
  const basis={companyDB:COMPANY,periodStart:"2026-09-01",periodEnd:"2026-09-30",branch:"1",
    dimensions:{},totals:{ggf:"0.00",allocated:"0.00",revalued:"0.00"},
    accounts:[{account:"TECH-NOT-GGF",amount:"0.00",percent:"0",criterion:"FIFO_TRACE"}],
    lines:[line],inventoryAccounts:{},fifoLineage:[trace],payload};
  return {closingId:ID,companyDB:COMPANY,periodStart:basis.periodStart,periodEnd:basis.periodEnd,
    branch:"1",dimensions:{},status:"DRAFT",version:1,lineVersion:1,
    createdAt:new Date().toISOString(),createdBy:"FactoryOne FIFO technical homologation",
    calculatedAt:null,postedAt:null,totalGgf:"0.00",totalAllocated:"0.00",totalRevalued:"0.00",
    sapMaterialRevaluationDocEntry:null,sapMaterialRevaluationDocNum:null,sapJournalTransId:null,
    postingHash:null,reopenedFrom:null,cancelledAt:null,
    notes:"TECHNICAL ONLY; no GGF allocation, posting or MaterialRevaluation; V2 deliberately ambiguous",
    lastError:null,postingBasis:basis,proposedPayload:payload,lines:[line]};
}
async function rawLines(sap,version) {
  const filter=encodeURIComponent(`U_ClosingId eq '${ID}' and U_Version eq '${version}'`);
  const count=Number(ok(await sap.get(`FBO_GGF_CLINE/$count?$filter=${filter}`),"line count"));
  const page=ok(await sap.get(`FBO_GGF_CLINE?$filter=${filter}&$orderby=Code&$top=100`),"audit lines");
  expect(Array.isArray(page?.value)&&!page["@odata.nextLink"]&&page.value.length===count,"Incomplete audit lines");
  return page.value;
}
async function verify(core,sap,expected,version) {
  const repo=new core.SapGgfClosingRepository(transport(sap,core));
  const loaded=await repo.get(ID);
  expect(loaded?.version===version&&loaded?.lineVersion===version&&loaded.status===expected.status&&
    loaded.postingHash===expected.postingHash&&loaded.lines.length===1&&
    JSON.stringify(loaded.postingBasis?.fifoLineage)===JSON.stringify(expected.postingBasis.fifoLineage),
    `Version ${version} did not survive SAP reload`);
  await core.assertClosingConsistency(loaded);
  const lines=await rawLines(sap,version);
  expect(lines.length===1&&lines[0].Code===`${ID}.${String(version).padStart(5,"0")}.0001`&&
    lines[0].U_ClosingId===ID&&lines[0].U_Version===String(version)&&
    lines[0].U_Account==="TECH-NOT-GGF"&&lines[0].U_Allocated==="0.00",`Version ${version} audit line differs`);
  return {version:loaded.version,lineVersion:loaded.lineVersion,status:loaded.status,
    traceStatus:loaded.postingBasis.fifoLineage[0].traceStatus,postingHash:loaded.postingHash,
    lineCode:lines[0].Code,postingBasisBytes:JSON.stringify(loaded.postingBasis).length};
}
async function execute(step) {
  expect(["inspect","v1","v2","verify","archive-v1","archive-v2","verify-archive"].includes(step),
    "Choose inspect, v1, v2, verify, archive-v1, archive-v2 or verify-archive");
  const core=await runtime(),journal=await state();
  expect(journal.closingId===ID,"Wrong technical journal");
  let sap=await openHomologationSession();
  try {
    const repo=new core.SapGgfClosingRepository(transport(sap,core));
    const archive=new core.SapGgfClosingVersionRepository(transport(sap,core));
    if(step.startsWith("archive-") || step==="verify-archive") {
      expect(journal.attempts.v1?.status==="PERSISTED"&&journal.attempts.v2?.status==="PERSISTED",
        "Technical closing versions not complete");
      const current=await repo.get(ID);
      expect(current?.version===2&&current.lineVersion===2&&current.status==="CALCULATED"&&
        current.sapMaterialRevaluationDocEntry===null,"Current technical closing changed");
      const old=structuredClone(current);
      old.version=1;old.lineVersion=1;old.status="DRAFT";old.calculatedAt=null;
      old.postingBasis.fifoLineage[0].version=1;
      old.postingBasis.fifoLineage[0].traceStatus="FIFO_PARTIALLY_CONSUMED";
      old.postingHash=await core.postingHash(old.postingBasis);
      expect(old.postingHash===journal.attempts.v1.hash&&current.postingHash===journal.attempts.v2.hash,
        "Historical FIFO hash cannot be reconstructed from SAP and journal");
      await core.assertClosingConsistency(old);
      if(step==="archive-v1"||step==="archive-v2") {
        const selected=step==="archive-v1"?old:current;
        expect(!journal.attempts[step],"Archive write already attempted");
        expect(await archive.get(ID,selected.version)===null,"Version already archived");
        journal.attempts[step]={at:new Date().toISOString(),status:"WRITE_INTENT",hash:selected.postingHash};
        await save(journal);
        const saved=await archive.create(selected,true);
        journal.attempts[step].status="PERSISTED";await save(journal);
        await sap.close();sap=await openHomologationSession();
        const reread=new core.SapGgfClosingVersionRepository(transport(sap,core));
        const fresh=await reread.get(ID,selected.version);
        expect(fresh?.postingHash===saved.postingHash&&fresh.lineVersion===selected.version,
          "Archived FIFO version did not survive fresh session");
        return {closingId:ID,version:selected.version,status:fresh.status,hash:fresh.postingHash,
          lineVersion:fresh.lineVersion,traceStatus:fresh.postingBasis.fifoLineage[0].traceStatus,
          technicalOnly:fresh.technicalOnly};
      }
      const first=await archive.get(ID,1),second=await archive.get(ID,2);
      expect(first?.postingHash===old.postingHash&&second?.postingHash===current.postingHash&&
        first.technicalOnly&&second.technicalOnly&&first.postingHash!==second.postingHash,
        "Both historical versions not independently preserved in SAP");
      const proof={closingId:ID,company:COMPANY,verifiedAt:new Date().toISOString(),
        version1:{hash:first.postingHash,status:first.status,lineVersion:first.lineVersion,
          traceStatus:first.postingBasis.fifoLineage[0].traceStatus},
        version2:{hash:second.postingHash,status:second.status,lineVersion:second.lineVersion,
          traceStatus:second.postingBasis.fifoLineage[0].traceStatus},
        currentHeaderVersion:current.version,valuesFunctionalGgf:"0.00",noClaim:(await repo.getClaim(ID))===null,
        noMaterialRevaluation:current.sapMaterialRevaluationDocEntry===null};
      await writeFile(".local/ggf/fifo-closing-F1HL260929F-proof.json",JSON.stringify(proof,null,2)+"\n",{mode:0o600});
      return proof;
    }
    if(step==="inspect") {
      const trace=await technicalTrace(sap,1,"FIFO_PARTIALLY_CONSUMED");
      expect(await repo.get(ID)===null,"Technical ClosingId already exists");
      return {closingId:ID,trace,existing:false};
    }
    if(step==="v1") {
      expect(!journal.attempts.v1&&await repo.get(ID)===null,"V1 already attempted or exists");
      const closing=draft(await technicalTrace(sap,1,"FIFO_PARTIALLY_CONSUMED"));
      closing.postingHash=await core.postingHash(closing.postingBasis);
      await core.assertClosingConsistency(closing);
      journal.attempts.v1={at:new Date().toISOString(),status:"WRITE_INTENT",hash:closing.postingHash};await save(journal);
      await repo.create(closing);
      journal.attempts.v1.status="PERSISTED";await save(journal);
      await sap.close();sap=await openHomologationSession();
      return await verify(core,sap,closing,1);
    }
    if(step==="v2") {
      expect(journal.attempts.v1?.status==="PERSISTED"&&!journal.attempts.v2,"V1 not verified or V2 attempted");
      const previous=await repo.get(ID);
      expect(previous?.version===1&&previous.lineVersion===1&&previous.status==="DRAFT","V1 changed");
      await technicalTrace(sap,2,"FIFO_PARTIALLY_CONSUMED");
      const next=core.transitionClosing(previous,"CALCULATED");
      next.calculatedAt=new Date().toISOString();
      next.postingBasis=structuredClone(previous.postingBasis);
      next.postingBasis.fifoLineage[0].version=2;
      next.postingBasis.fifoLineage[0].traceStatus="FIFO_TRACE_AMBIGUOUS";
      next.postingHash=await core.postingHash(next.postingBasis);
      expect(next.postingHash!==previous.postingHash,"V2 technical status did not change hash");
      journal.attempts.v2={at:new Date().toISOString(),status:"WRITE_INTENT",hash:next.postingHash};await save(journal);
      await repo.replace(previous,next);
      journal.attempts.v2.status="PERSISTED";await save(journal);
      await sap.close();sap=await openHomologationSession();
      const current=await verify(core,sap,next,2),older=await rawLines(sap,1);
      expect(older.length===1&&older[0].Code===`${ID}.00001.0001`,"V1 audit row not retained");
      return {current,version1:{hash:previous.postingHash,lineCode:older[0].Code},
        hashChanged:true,technicalVersion2Discarded:true};
    }
    const loaded=await repo.get(ID);
    expect(loaded?.version===2&&loaded.status==="CALCULATED"&&
      loaded.postingBasis?.fifoLineage?.[0]?.traceStatus==="FIFO_TRACE_AMBIGUOUS","Technical V2 missing");
    const current=await verify(core,sap,loaded,2),older=await rawLines(sap,1);
    expect(older.length===1&&loaded.postingHash!==journal.attempts.v1.hash,"V1/hash not preserved");
    return {current,version1:{hash:journal.attempts.v1.hash,lineCode:older[0].Code},
      noClaim:(await repo.getClaim(ID))===null,noPostingDocument:loaded.sapMaterialRevaluationDocEntry===null};
  } finally {await sap.close();}
}

try {console.log(JSON.stringify(await execute(process.argv[2]),null,2));}
catch(error) {console.error(error.message);process.exitCode=1;}
