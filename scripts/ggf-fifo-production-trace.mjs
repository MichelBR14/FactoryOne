import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { openHomologationSession } from "./ggf-homologation-session.mjs";

const C=Object.freeze({id:"F1FOP2609291",company:"SBODEMOBR2",item:"F1GGF26P01",
  resource:"R300011",warehouse:"01",branch:1,date:"2026-09-29",quantity:10,issued:6,
  statePath:".local/ggf/fifo-production-F1FOP2609291-state.json"});
const marker=`FactoryOne FIFO production ${C.id}`;
const ensure=(test,message)=>{if(!test)throw new Error(message);};
function ok(result,label) {
  if(!result.ok)throw new Error(`${label}: HTTP ${result.status}, SAP ${result.errorCode??"unknown"}, ${result.errorMessage??""}`);
  return result.data;
}
function rows(result,label) {
  const data=ok(result,label);
  ensure(Array.isArray(data?.value)&&!data["@odata.nextLink"],`${label}: incomplete page`);
  return data.value;
}
async function load() {
  try {const state=JSON.parse(await readFile(C.statePath,"utf8"));
    ensure(state.scenario?.id===C.id&&state.scenario.company===C.company,"Scenario journal mismatch");return state;
  } catch(error) {if(error.code==="ENOENT")return {scenario:C,attempts:{}};throw error;}
}
async function save(state) {
  await mkdir(".local/ggf",{recursive:true,mode:0o700});
  const temporary=`${C.statePath}.${process.pid}.tmp`;
  await writeFile(temporary,JSON.stringify(state,null,2)+"\n",{mode:0o600});
  await rename(temporary,C.statePath);
}
async function productionPreview(input) {
  const output=".local/ggf/fifo-production-preview-engine.mjs";
  await build({stdin:{contents:'export { previewFifoProduction } from "./webapp/modules/ggf/service/FifoProductionTrace.ts";',
    resolveDir:process.cwd()},outfile:output,platform:"node",format:"esm",bundle:true});
  const {previewFifoProduction}=await import(pathToFileURL(resolve(output)).href+`?t=${Date.now()}`);
  return previewFifoProduction(input);
}
async function attempt(state,key,endpoint,payload,action) {
  ensure(!state.attempts[key],`${key} already attempted; reconcile SAP before retry`);
  state.attempts[key]={at:new Date().toISOString(),endpoint,payload,status:"POST_INTENT"};await save(state);
  const response=await action();
  state.attempts[key].status=response.ok?"CREATED":"REJECTED";
  state.attempts[key].httpStatus=response.status;
  state.attempts[key].response=response.ok?response.data:{code:response.errorCode,message:response.errorMessage};
  await save(state);
  return ok(response,key);
}
async function item(sap) {return ok(await sap.get(`Items('${C.item}')?$select=ItemCode,CostAccountingMethod,QuantityOnStock,InventoryUOM,ManageBatchNumbers,ManageSerialNumbers,ItemWarehouseInfoCollection`),"item");}
async function layers(sap) {
  const data=ok(await sap.readAction("MaterialRevaluationFIFOService_GetMaterialRevaluationFIFO",
    {MaterialRevaluationFIFOParams:{ItemCode:C.item,LocationCode:C.warehouse,LocationType:"64",ShowIssuedLayers:"tNO"}}),"FIFO layers");
  ensure(Array.isArray(data?.Layers),"FIFO layers missing");return data.Layers;
}
async function inspect(sap) {
  const existing=await sap.get(`Items('${C.item}')?$select=ItemCode`);
  const wh=ok(await sap.get(`Warehouses('${C.warehouse}')?$select=WarehouseCode,BusinessPlaceID,Inactive,DropShip`),"warehouse");
  const resource=ok(await sap.get(`Resources('${C.resource}')`),"resource");
  const period=ok(await sap.readAction("CompanyService_GetFinancePeriod",
    {FinancePeriodParams:{AbsoluteEntry:179,PeriodIndicator:"Padrão"}}),"period");
  const orders=rows(await sap.get(`ProductionOrders?$filter=ItemNo eq '${C.item}'&$select=AbsoluteEntry,ItemNo`),"prior OPs");
  const receipts=rows(await sap.get(`InventoryGenEntries?$filter=Comments eq '${marker} receipt'&$select=DocEntry,Comments`),"prior receipts");
  const issues=rows(await sap.get(`InventoryGenExits?$filter=Comments eq '${marker} issue'&$select=DocEntry,Comments`),"prior issues");
  ensure(existing.status===404&&wh.BusinessPlaceID===C.branch&&wh.Inactive==="tNO"&&wh.DropShip==="tNO"&&
    resource.Code===C.resource&&resource.Active==="tYES"&&period.PeriodCode==="2026-09"&&period.PeriodStatus==="ltUnlocked"&&
    period.Locked==="tNO"&&C.date>=period.PostingDateFrom.slice(0,10)&&C.date<=period.PostingDateTo.slice(0,10)&&
    orders.length===0&&receipts.length===0&&issues.length===0,"Technical scenario baseline not clean");
  return {itemAbsent:true,warehouse:wh.WarehouseCode,resource:{code:resource.Code,name:resource.Name},period:period.PeriodCode};
}
async function trace(sap,state) {
  const op=ok(await sap.get(`ProductionOrders(${state.order.entry})`),"OP");
  const receipt=ok(await sap.get(`InventoryGenEntries(${state.receipt.entry})`),"production receipt");
  const line=receipt.DocumentLines?.find(row=>row.BaseEntry===op.AbsoluteEntry&&row.BaseType===202&&row.ItemCode===C.item);
  const current=await item(sap),open=await layers(sap);
  const target=open.filter(row=>String(row.DocNumber)===String(receipt.DocNum));
  ensure(op.ItemNo===C.item&&op.PlannedQuantity===C.quantity&&op.CompletedQuantity===C.quantity&&
    receipt.Comments===`${marker} receipt`&&receipt.Cancelled==="tNO"&&line?.Quantity===C.quantity&&
    line?.WarehouseCode===C.warehouse&&current.CostAccountingMethod==="bis_FIFO"&&
    current.ManageBatchNumbers==="tNO"&&current.ManageSerialNumbers==="tNO"&&target.length===1,
    "OP, receipt or FIFO layer cannot be uniquely reconciled");
  const layer=target[0];
  ensure(Number.isSafeInteger(layer.TransactionSequenceNum)&&Number.isSafeInteger(layer.LayerID)&&
    layer.OpenQty>0&&layer.OpenQty<=C.quantity,"FIFO identity or quantity invalid");
  return {order:{entry:op.AbsoluteEntry,num:op.DocumentNumber,item:op.ItemNo,planned:op.PlannedQuantity,
      completed:op.CompletedQuantity,status:op.ProductionOrderStatus},
    receipt:{entry:receipt.DocEntry,num:receipt.DocNum,transId:receipt.TransNum,date:receipt.DocDate,
      line:line.LineNum,quantity:line.InventoryQuantity,warehouse:line.WarehouseCode,
      value:line.LineTotal,unitPrice:line.UnitPrice},
    layer:{transactionSequenceNum:layer.TransactionSequenceNum,layerId:layer.LayerID,
      docNumber:layer.DocNumber,docType:layer.DocType,entryDate:layer.EntryDate,
      openQty:layer.OpenQty,currentCost:layer.CurrentCost},stock:current.QuantityOnStock,
    warehouseStock:current.ItemWarehouseInfoCollection?.find(row=>row.WarehouseCode===C.warehouse)?.InStock};
}
async function run(step) {
  ensure(["inspect","item","bom","order","release","receipt","close","issue","verify"].includes(step),"Unknown step");
  const state=await load(),sap=await openHomologationSession();
  try {
    if(step==="inspect")return await inspect(sap);
    if(step==="item") {
      await inspect(sap);
      const payload={ItemCode:C.item,ItemName:`FactoryOne FIFO producao ${C.id}`,ItemsGroupCode:100,
        InventoryItem:"tYES",SalesItem:"tNO",PurchaseItem:"tNO",InventoryUOM:"UN",
        CostAccountingMethod:"bis_FIFO",GLMethod:"glm_WH",ManageBatchNumbers:"tNO",ManageSerialNumbers:"tNO"};
      await attempt(state,step,"Items",payload,()=>sap.post("Items",payload));
    } else if(step==="bom") {
      ensure(state.attempts.item?.status==="CREATED"&&state.attempts.bom===undefined,"Item not ready");
      ensure((await sap.get(`ProductTrees('${C.item}')`)).status===404,"BOM already exists or cannot prove absence");
      const payload={TreeCode:C.item,TreeType:"iProductionTree",Quantity:1,Warehouse:C.warehouse,
        ProductTreeLines:[{ItemCode:C.resource,Quantity:1,Warehouse:C.warehouse,
          IssueMethod:"im_Backflush",ItemType:"pit_Resource"}]};
      await attempt(state,step,"ProductTrees",payload,()=>sap.post("ProductTrees",payload));
    } else if(step==="order") {
      ensure(state.attempts.bom?.status==="CREATED","BOM not ready");
      const current=await item(sap);
      ensure(current.CostAccountingMethod==="bis_FIFO"&&current.QuantityOnStock===0,"Item changed");
      ensure(rows(await sap.get(`ProductionOrders?$filter=ItemNo eq '${C.item}'&$select=AbsoluteEntry`),"prior OP").length===0,"OP already exists");
      const payload={ItemNo:C.item,ProductionOrderType:"bopotStandard",ProductionOrderStatus:"boposPlanned",
        PlannedQuantity:C.quantity,PostingDate:C.date,DueDate:C.date,Warehouse:C.warehouse,Remarks:marker,
        ProductionOrderLines:[{ItemNo:C.resource,ItemType:"pit_Resource",BaseQuantity:1,
          ProductionOrderIssueType:"im_Backflush",Warehouse:C.warehouse}]};
      const op=await attempt(state,step,"ProductionOrders",payload,()=>sap.post("ProductionOrders",payload));
      ensure(Number.isSafeInteger(op.AbsoluteEntry),"OP key missing; reconcile journal");
      state.order={entry:op.AbsoluteEntry,num:op.DocumentNumber};await save(state);
    } else if(step==="release"||step==="close") {
      ensure(state.order?.entry&&state.attempts[step==="release"?"order":"receipt"]?.status==="CREATED","OP step not ready");
      const op=ok(await sap.get(`ProductionOrders(${state.order.entry})`),"OP");
      ensure(op.ItemNo===C.item&&op.ProductionOrderStatus===(step==="release"?"boposPlanned":"boposReleased")&&
        op.CompletedQuantity===(step==="release"?0:C.quantity),"OP state changed");
      const payload={ProductionOrderStatus:step==="release"?"boposReleased":"boposClosed"};
      await attempt(state,step,`ProductionOrders(${state.order.entry})`,payload,
        ()=>sap.patchProductionOrder(state.order.entry,payload));
    } else if(step==="receipt") {
      ensure(state.attempts.release?.status==="CREATED","OP not released");
      const op=ok(await sap.get(`ProductionOrders(${state.order.entry})`),"OP");
      ensure(op.ItemNo===C.item&&op.ProductionOrderStatus==="boposReleased"&&op.CompletedQuantity===0,"OP changed");
      ensure(rows(await sap.get(`InventoryGenEntries?$filter=Comments eq '${marker} receipt'&$select=DocEntry`),"prior receipt").length===0,"Receipt exists");
      const payload={DocDate:C.date,BPL_IDAssignedToInvoice:C.branch,Comments:`${marker} receipt`,
        DocumentLines:[{Quantity:C.quantity,WarehouseCode:C.warehouse,BaseType:202,
          BaseEntry:state.order.entry,TransactionType:"botrntComplete",UseBaseUnits:"tYES"}]};
      const doc=await attempt(state,step,"InventoryGenEntries",payload,()=>sap.post("InventoryGenEntries",payload));
      ensure(Number.isSafeInteger(doc.DocEntry),"Receipt key missing; reconcile journal");
      state.receipt={entry:doc.DocEntry,num:doc.DocNum,transId:doc.TransNum};await save(state);
    } else if(step==="issue") {
      ensure(state.attempts.close?.status==="CREATED"&&!state.attempts.issue,"OP not closed or issue already attempted");
      const proof=await trace(sap,state);
      ensure(proof.layer.openQty===C.quantity&&proof.stock===C.quantity&&proof.warehouseStock===C.quantity,
        "Original production layer not fully available");
      ensure(rows(await sap.get(`InventoryGenExits?$filter=Comments eq '${marker} issue'&$select=DocEntry`),"prior issue").length===0,"Issue exists");
      const account=ok(await sap.get("ChartOfAccounts('5.03.01.01.03')?$select=Code,Name,ActiveAccount,BlockManualPosting,CostAccountingOnly"),"issue offset account");
      ensure(account.ActiveAccount==="tYES"&&account.BlockManualPosting==="tNO"&&account.CostAccountingOnly==="tNO","Issue offset account unavailable");
      const payload={DocDate:C.date,BPL_IDAssignedToInvoice:C.branch,Comments:`${marker} issue`,
        DocumentLines:[{ItemCode:C.item,Quantity:C.issued,WarehouseCode:C.warehouse,
          AccountCode:account.Code,UseBaseUnits:"tYES"}]};
      const doc=await attempt(state,step,"InventoryGenExits",payload,()=>sap.postFifoProductionIssue(payload));
      ensure(Number.isSafeInteger(doc.DocEntry),"Issue key missing; reconcile journal");
      state.issue={entry:doc.DocEntry,num:doc.DocNum,transId:doc.TransNum};await save(state);
    } else if(step==="verify") {
      ensure(state.receipt?.entry&&state.issue?.entry,"Receipt and issue required");
      const proof=await trace(sap,state);
      const issue=ok(await sap.get(`InventoryGenExits(${state.issue.entry})`),"issue");
      ensure(rows(await sap.get(`MaterialRevaluation?$filter=Comments eq '${marker}'&$select=DocEntry`),
        "scenario MaterialRevaluation absence").length===0,"Unexpected MaterialRevaluation for scenario");
      ensure(issue.Comments===`${marker} issue`&&issue.Cancelled==="tNO"&&issue.DocumentLines?.length===1&&
        issue.DocumentLines[0].ItemCode===C.item&&issue.DocumentLines[0].Quantity===C.issued&&
        proof.layer.openQty===C.quantity-C.issued&&proof.stock===C.quantity-C.issued&&
        proof.warehouseStock===C.quantity-C.issued,"Partial layer consumption not independently proven");
      const receiptJournal=ok(await sap.get(`JournalEntries(${proof.receipt.transId})?$select=JdtNum,JournalEntryLines`),"receipt journal");
      const issueJournal=ok(await sap.get(`JournalEntries(${issue.TransNum})?$select=JdtNum,JournalEntryLines`),"issue journal");
      const journalLines=entry=>entry.JournalEntryLines?.filter(line=>line.Debit!==0||line.Credit!==0)
        .map(line=>({account:line.AccountCode,debit:line.Debit,credit:line.Credit}));
      const originalValue=proof.receipt.value,remainingValue=proof.layer.openQty*proof.layer.currentCost;
      const consumedValue=issue.DocumentLines[0].LineTotal;
      ensure(originalValue===120&&remainingValue===48&&consumedValue===72&&
        journalLines(receiptJournal)?.some(line=>line.debit===120&&line.account==="1.01.02.01.01")&&
        journalLines(issueJournal)?.some(line=>line.credit===72&&line.account==="1.01.02.01.01")&&
        originalValue===remainingValue+consumedValue,"FIFO original/open/issued value or journals disagree");
      const lineage={closingId:null,orderDocEntry:proof.order.entry,receiptDocEntry:proof.receipt.entry,
        receiptLine:proof.receipt.line,receiptDocNum:proof.receipt.num,item:C.item,warehouse:C.warehouse,
        originalLayer:{transactionSequenceNum:proof.layer.transactionSequenceNum,layerId:proof.layer.layerId},
          remainingQuantity:String(proof.layer.openQty),revaluationDocEntry:null,revaluationDocNum:null,resultLayer:null};
      const conceptual=await productionPreview({lineage,producedQuantity:String(C.quantity),
        receiptQuantity:String(proof.receipt.quantity),unit:"UN",ggFMinor:"10000",
        independentlyIssuedQuantity:String(issue.DocumentLines[0].InventoryQuantity),
        layers:[{transactionSequenceNum:proof.layer.transactionSequenceNum,layerId:proof.layer.layerId,
          docNumber:proof.layer.docNumber,docType:proof.layer.docType,item:C.item,warehouse:C.warehouse,
          openQuantity:String(proof.layer.openQty),currentCost:String(proof.layer.currentCost)}]});
      ensure(conceptual.status==="FIFO_PARTIALLY_CONSUMED"&&conceptual.inventoryGgfMinor==="4000"&&
        conceptual.consumedGgfMinor==="6000"&&conceptual.payload===null,"Conceptual FIFO preview disagrees with independent split");
      const evidence={scenario:C,closingId:null,verifiedAt:new Date().toISOString(),...proof,
        issue:{entry:issue.DocEntry,num:issue.DocNum,transId:issue.TransNum,date:issue.DocDate,
          line:issue.DocumentLines[0].LineNum,quantity:issue.DocumentLines[0].InventoryQuantity,
          value:issue.DocumentLines[0].LineTotal},
        lineage,
        originalQuantity:C.quantity,originalCost:proof.layer.currentCost,
        originalValue,remainingValue,consumedValue,
        receiptJournal:{transId:receiptJournal.JdtNum,lines:journalLines(receiptJournal)},
        issueJournal:{transId:issueJournal.JdtNum,lines:journalLines(issueJournal)},
        consumedQuantity:C.issued,remainingQuantity:proof.layer.openQty,
        conceptualGgf:{...conceptual,totalMinor:10000,unitMinor:1000,inventoryMinor:4000,consumedMinor:6000,
          accountingDecision:"PENDING",materialRevaluationDocEntry:null,resultLayer:null}};
      await mkdir(".local/ggf",{recursive:true,mode:0o700});
      await writeFile(`.local/ggf/fifo-production-${C.id}-evidence.json`,JSON.stringify(evidence,null,2)+"\n",{mode:0o600});
      return evidence;
    }
    return {scenario:C.id,step,status:state.attempts[step].status,order:state.order,receipt:state.receipt,issue:state.issue};
  } finally {await sap.close();}
}

try {console.log(JSON.stringify(await run(process.argv[2]),null,2));}
catch(error) {console.error(error.message);process.exitCode=1;}
