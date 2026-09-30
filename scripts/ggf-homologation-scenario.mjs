import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { openHomologationSession } from "./ggf-homologation-session.mjs";

export const SCENARIO = Object.freeze({
  id:"F1H2609281", item:"F1GGF26H01", resource:"R300011",
  warehouse:"01", branch:1, date:"2026-09-28", company:"SBODEMOBR2",
  statePath:".local/ggf/material-revaluation-homologation-F1H2609281.json"
});

export async function readState() {
  try { return JSON.parse(await readFile(SCENARIO.statePath,"utf8")); }
  catch(error) { if(error.code==="ENOENT")return {scenario:SCENARIO,attempts:{},createdAt:new Date().toISOString()}; throw error; }
}
export async function saveState(state) {
  await mkdir(".local/ggf",{recursive:true,mode:0o700});
  const temporary=`${SCENARIO.statePath}.${process.pid}.tmp`;
  await writeFile(temporary,JSON.stringify(state,null,2)+"\n",{mode:0o600});
  await rename(temporary,SCENARIO.statePath);
}
function requireOk(result, label) {
  if(!result.ok)throw new Error(`${label}: HTTP ${result.status}, SAP ${result.errorCode??"unknown"}, ${result.errorMessage??""}`);
  return result.data;
}
function expectMissing(result,label) {
  if(result.status!==404)throw new Error(`${label} is not proven absent (HTTP ${result.status})`);
}
async function recordAttempt(state,step,endpoint,payload) {
  if(state.attempts[step])throw new Error(`${step} already attempted; reconcile before any retry`);
  state.attempts[step]={at:new Date().toISOString(),endpoint,request:payload,status:"POST_INTENT"};
  await saveState(state);
}
async function finishAttempt(state,step,result) {
  state.attempts[step].status=result.ok?"CREATED":"REJECTED";
  state.attempts[step].httpStatus=result.status;
  state.attempts[step].response=result.ok?result.data:{code:result.errorCode,message:result.errorMessage};
  await saveState(state);
  return requireOk(result,step);
}

export async function prepareScenario(step) {
  if(!["item","bom","order","release","receipt","close"].includes(step))throw new Error("Choose item, bom, order, release, receipt or close");
  const state=await readState();
  if(state.scenario.id!==SCENARIO.id || state.scenario.company!==SCENARIO.company)throw new Error("Scenario journal mismatch");
  const sap=await openHomologationSession();
  try {
    if(step==="item") {
      expectMissing(await sap.get(`Items('${SCENARIO.item}')`),"dedicated item");
      const payload={ItemCode:SCENARIO.item,ItemName:"FactoryOne GGF homologacao controlada",ItemsGroupCode:100,
        InventoryItem:"tYES",SalesItem:"tNO",PurchaseItem:"tNO",InventoryUOM:"UN",
        CostAccountingMethod:"bis_MovingAverage",GLMethod:"glm_WH",ManageBatchNumbers:"tNO",ManageSerialNumbers:"tNO"};
      await recordAttempt(state,step,"Items",payload);
      await finishAttempt(state,step,await sap.post("Items",payload));
    }
    if(step==="bom") {
      if(state.attempts.item?.status!=="CREATED")throw new Error("Dedicated item has not been reconciled");
      expectMissing(await sap.get(`ProductTrees('${SCENARIO.item}')`),"dedicated BOM");
      const payload={TreeCode:SCENARIO.item,TreeType:"iProductionTree",Quantity:1,Warehouse:SCENARIO.warehouse,
        ProductTreeLines:[{ItemCode:SCENARIO.resource,Quantity:1,Warehouse:SCENARIO.warehouse,
          IssueMethod:"im_Backflush",ItemType:"pit_Resource"}]};
      await recordAttempt(state,step,"ProductTrees",payload);
      await finishAttempt(state,step,await sap.post("ProductTrees",payload));
    }
    if(step==="order") {
      if(state.attempts.item?.status!=="CREATED" || state.attempts.bom?.status!=="CREATED")throw new Error("Dedicated item/BOM not reconciled");
      if(state.attempts.order?.status==="REJECTED") {
        const prior=state.attempts.order;
        const known=String(prior.response?.code)==="-10" &&
          (prior.response?.message?.startsWith("Invalid production bill of materials") ||
           prior.response?.message?.startsWith("Production orders can be created in planned status only"));
        if(prior.httpStatus!==400 || !known || state.attempts.orderRejected2)throw new Error("Order rejection cannot be retried automatically");
        const existing=requireOk(await sap.get(`ProductionOrders?$filter=ItemNo eq '${SCENARIO.item}'&$select=AbsoluteEntry,ItemNo`),"OP absence check");
        if(!Array.isArray(existing.value) || existing.value.length || existing["@odata.nextLink"])throw new Error("Rejected OP absence not proven");
        state.attempts[state.attempts.orderRejected?"orderRejected2":"orderRejected"]=prior;
        delete state.attempts.order;await saveState(state);
      }
      const item=requireOk(await sap.get(`Items('${SCENARIO.item}')`),"item read");
      if(item.ItemCode!==SCENARIO.item || item.QuantityOnStock!==0 || item.ManageBatchNumbers!=="tNO" || item.ManageSerialNumbers!=="tNO" || item.CostAccountingMethod!=="bis_MovingAverage")throw new Error("Item is not a clean moving average starting point");
      const payload={ItemNo:SCENARIO.item,ProductionOrderType:"bopotStandard",ProductionOrderStatus:"boposPlanned",
        PlannedQuantity:1,PostingDate:SCENARIO.date,DueDate:SCENARIO.date,Warehouse:SCENARIO.warehouse,
        Remarks:`FactoryOne GGF homologacao ${SCENARIO.id}`,
        ProductionOrderLines:[{ItemNo:SCENARIO.resource,ItemType:"pit_Resource",BaseQuantity:1,
          ProductionOrderIssueType:"im_Backflush",Warehouse:SCENARIO.warehouse}]};
      await recordAttempt(state,step,"ProductionOrders",payload);
      const op=await finishAttempt(state,step,await sap.post("ProductionOrders",payload));
      if(!Number.isSafeInteger(op.AbsoluteEntry))throw new Error("Production order key missing; reconcile journal");
      state.productionOrder={entry:op.AbsoluteEntry,number:op.DocumentNumber};await saveState(state);
    }
    if(step==="release") {
      if(state.attempts.order?.status!=="CREATED" || !state.productionOrder?.entry)throw new Error("Controlled production order not ready");
      const op=requireOk(await sap.get(`ProductionOrders(${state.productionOrder.entry})`),"OP read");
      if(op.ItemNo!==SCENARIO.item || op.ProductionOrderStatus!=="boposPlanned" || op.CompletedQuantity!==0)throw new Error("OP cannot be released from current state");
      const payload={ProductionOrderStatus:"boposReleased"};
      await recordAttempt(state,step,`ProductionOrders(${state.productionOrder.entry})`,payload);
      const response=await sap.patchProductionOrder(state.productionOrder.entry,payload);
      state.attempts.release.status=response.ok?"RELEASED":"REJECTED";
      state.attempts.release.httpStatus=response.status;
      state.attempts.release.response=response.ok?{}:{code:response.errorCode,message:response.errorMessage};
      await saveState(state);requireOk(response,"release OP");
    }
    if(step==="receipt") {
      if(state.attempts.release?.status!=="RELEASED" || !state.productionOrder?.entry)throw new Error("Controlled production order not released");
      if(state.attempts.receipt?.status==="REJECTED") {
        const prior=state.attempts.receipt;
        const known=prior.response?.message?.includes("[OIGN.TaxDate]") ||
          prior.response?.message?.includes("[DocumentLines.ItemCode]");
        if(prior.httpStatus!==400 || String(prior.response?.code)!=="-5002" || !known || state.attempts.receiptRejected2)
          throw new Error("Receipt rejection cannot be retried automatically");
        const existing=requireOk(await sap.get(`InventoryGenEntries?$filter=Comments eq 'FactoryOne GGF homologacao ${SCENARIO.id}'&$select=DocEntry,Comments`),"receipt absence check");
        if(!Array.isArray(existing.value)||existing.value.length||existing["@odata.nextLink"])
          throw new Error("Rejected receipt absence not proven");
        state.attempts[state.attempts.receiptRejected?"receiptRejected2":"receiptRejected"]=prior;
        delete state.attempts.receipt;await saveState(state);
      }
      const op=requireOk(await sap.get(`ProductionOrders(${state.productionOrder.entry})`),"OP read");
      if(op.ItemNo!==SCENARIO.item || op.ProductionOrderStatus!=="boposReleased" || op.CompletedQuantity!==0 || op.PlannedQuantity!==1)throw new Error("OP state changed before receipt");
      const payload={DocDate:SCENARIO.date,BPL_IDAssignedToInvoice:SCENARIO.branch,
        Comments:`FactoryOne GGF homologacao ${SCENARIO.id}`,
        DocumentLines:[{Quantity:1,WarehouseCode:SCENARIO.warehouse,
          BaseType:202,BaseEntry:state.productionOrder.entry,TransactionType:"botrntComplete",UseBaseUnits:"tYES"}]};
      await recordAttempt(state,step,"InventoryGenEntries",payload);
      const doc=await finishAttempt(state,step,await sap.post("InventoryGenEntries",payload));
      if(!Number.isSafeInteger(doc.DocEntry))throw new Error("Receipt key missing; reconcile journal");
      state.receipt={entry:doc.DocEntry,number:doc.DocNum,transId:doc.TransNum};await saveState(state);
    }
    if(step==="close") {
      if(state.attempts.receipt?.status!=="CREATED" || !state.productionOrder?.entry)throw new Error("Controlled receipt not ready");
      const op=requireOk(await sap.get(`ProductionOrders(${state.productionOrder.entry})`),"OP read");
      if(op.ItemNo!==SCENARIO.item || op.ProductionOrderStatus!=="boposReleased" || op.CompletedQuantity!==1)throw new Error("OP cannot be closed from current state");
      const payload={ProductionOrderStatus:"boposClosed"};
      await recordAttempt(state,step,`ProductionOrders(${state.productionOrder.entry})`,payload);
      const response=await sap.patchProductionOrder(state.productionOrder.entry,payload);
      state.attempts.close.status=response.ok?"CLOSED":"REJECTED";
      state.attempts.close.httpStatus=response.status;
      state.attempts.close.response=response.ok?{}:{code:response.errorCode,message:response.errorMessage};
      await saveState(state);requireOk(response,"close OP");
    }
    return {scenario:SCENARIO.id,step,status:state.attempts[step].status,productionOrder:state.productionOrder,receipt:state.receipt};
  } finally { await sap.close(); }
}

if(process.argv[1]?.endsWith("ggf-homologation-scenario.mjs")) {
  try{console.log(JSON.stringify(await prepareScenario(process.argv[2]),null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
