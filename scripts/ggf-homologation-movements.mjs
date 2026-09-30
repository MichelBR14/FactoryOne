import { mkdir, writeFile } from "node:fs/promises";
import { openHomologationSession } from "./ggf-homologation-session.mjs";
import { SCENARIO, readState } from "./ggf-homologation-scenario.mjs";

const TYPES = [
  ["InventoryGenEntries","DocEntry","DocDate","DocumentLines"],
  ["InventoryGenExits","DocEntry","DocDate","DocumentLines"],
  ["DeliveryNotes","DocEntry","DocDate","DocumentLines"],
  ["Returns","DocEntry","DocDate","DocumentLines"],
  ["Invoices","DocEntry","DocDate","DocumentLines"],
  ["CreditNotes","DocEntry","DocDate","DocumentLines"],
  ["PurchaseDeliveryNotes","DocEntry","DocDate","DocumentLines"],
  ["PurchaseReturns","DocEntry","DocDate","DocumentLines"],
  ["PurchaseInvoices","DocEntry","DocDate","DocumentLines"],
  ["PurchaseCreditNotes","DocEntry","DocDate","DocumentLines"],
  ["StockTransfers","DocEntry","DocDate","StockTransferLines"],
  ["InventoryPostings","DocumentEntry","PostingDate","InventoryPostingLines"],
  ["InventoryOpeningBalances","DocumentEntry","PostingDate","InventoryOpeningBalanceLines"],
  ["MaterialRevaluation","DocEntry","DocDate","MaterialRevaluationLines"]
];
function requireOk(response,context) {
  if(!response.ok)throw new Error(`${context}: HTTP ${response.status}, SAP ${response.errorCode??"unknown"}`);
  return response.data;
}
export async function captureMovements() {
  const state=await readState();
  if(state.attempts.close?.status!=="CLOSED")throw new Error("Scenario production is incomplete");
  const sap=await openHomologationSession();
  try {
    const itemPath=`Items('${SCENARIO.item}')?$select=ItemCode,QuantityOnStock,CostAccountingMethod,ItemWarehouseInfoCollection`;
    const first=requireOk(await sap.get(itemPath),"item before movements");
    const collections=[];const matches=[];
    for(const [entity,key,date,lines] of TYPES) {
      const filter=`${date} ge ${SCENARIO.date}`;
      const count=Number(requireOk(await sap.get(`${entity}/$count?$filter=${encodeURIComponent(filter)}`),`${entity} count`));
      if(!Number.isSafeInteger(count)||count<0)throw new Error(`${entity} count is incomplete`);
      let path=`${entity}?$filter=${encodeURIComponent(filter)}&$select=${key},${date},${lines}&$orderby=${key}`;
      const seen=new Set();let read=0,pages=0;
      while(path) {
        if(seen.has(path)||pages>=100)throw new Error(`${entity} pagination incomplete`);
        seen.add(path);pages++;
        const data=requireOk(await sap.get(path),`${entity} page`);
        if(!Array.isArray(data.value))throw new Error(`${entity} rows missing`);
        for(const doc of data.value) {
          if(!Array.isArray(doc[lines]) || Object.keys(doc).some(k=>/nextLink$/i.test(k)))throw new Error(`${entity} child collection incomplete`);
          read++;
          for(const line of doc[lines])if(line.ItemCode===SCENARIO.item) {
            matches.push({entity,document:doc[key],date:doc[date],line:line.LineNum??line.LineNumber,
              item:line.ItemCode,warehouse:line.WarehouseCode,fromWarehouse:line.FromWarehouseCode,
              quantity:line.InventoryQuantity??line.Quantity??line.InWarehouseQuantity??null,
              baseType:line.BaseType,baseEntry:line.BaseEntry,withoutInventoryMovement:line.WithoutInventoryMovement});
          }
        }
        path=data["@odata.nextLink"]??data["odata.nextLink"]??null;
      }
      if(read!==count)throw new Error(`${entity} page/count mismatch: ${read}/${count}`);
      collections.push({entity,count,pages,exhausted:true,independentlyCounted:true});
    }
    const after=requireOk(await sap.get(itemPath),"item after movements");
    if(JSON.stringify(first)!==JSON.stringify(after))throw new Error("Item changed during movement capture");
    const receipt=matches.filter(m=>m.entity==="InventoryGenEntries"&&m.document===state.receipt.entry&&m.line===0&&
      m.warehouse===SCENARIO.warehouse&&m.baseType===202&&m.baseEntry===state.productionOrder.entry&&m.quantity===1);
    if(matches.length!==1||receipt.length!==1||after.QuantityOnStock!==1 ||
        after.ItemWarehouseInfoCollection.filter(w=>w.WarehouseCode===SCENARIO.warehouse)[0]?.InStock!==1)
      throw new Error("Dedicated item movements do not prove a single remaining unit");
    const report={scenario:SCENARIO.id,capturedAt:new Date().toISOString(),company:SCENARIO.company,
      initialStockProvenBy:"Items before OP creation: 0 units; scenario journal order precondition",
      currentStock:after.QuantityOnStock,warehouse:SCENARIO.warehouse,receipt:state.receipt,
      collections,matches,remainingQuantity:1,unit:"UN",stockDate:new Date().toISOString()};
    await mkdir(".local/ggf",{recursive:true,mode:0o700});
    const path=`.local/ggf/material-revaluation-movements-${SCENARIO.id}.json`;
    await writeFile(path,JSON.stringify(report,null,2)+"\n",{mode:0o600});
    return {path,report};
  } finally { await sap.close(); }
}
if(process.argv[1]?.endsWith("ggf-homologation-movements.mjs")) {
  try{const {path,report}=await captureMovements();console.log(JSON.stringify({path,collections:report.collections.length,matches:report.matches,remainingQuantity:report.remainingQuantity},null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
