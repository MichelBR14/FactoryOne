import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { openReadSession } from "./ggf-sap-session.mjs";

// Targeted evidence only. No query creation, actions, or business writes.
const dir = `.local/ggf/revaluation-evidence-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}`;
await mkdir(dir, { recursive: true, mode: 0o700 });
const session = await openReadSession();
const reads = [], failures = [], collections = [], movements = [], documents = [], journals = [];
const clean = value => Array.isArray(value) ? value.map(clean) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).filter(([k]) => !k.startsWith("@odata.context")).map(([k,v])=>[k,clean(v)])) : value;
const pick = (row, fields) => Object.fromEntries(fields.split(",").map(k=>[k,row[k]]));
async function get(path, optional = false) {
  const r = await session.get(path, { Prefer: "odata.maxpagesize=20" });
  reads.push({ path, status: r.status, at: new Date().toISOString() });
  if (!r.ok) { failures.push({path,status:r.status}); if (!optional) throw new Error(`GET rejected: ${r.status}`); return null; }
  return clean(r.data);
}
async function pages(path, key) {
  const rows = [], seen = new Set(); let next = path;
  while(next) {
    if (seen.has(next) || seen.size >= 100) throw new Error("Incomplete/cyclic evidence pagination");
    seen.add(next); const data = await get(next,true);
    if (!data || !Array.isArray(data.value)) return {rows, complete:false};
    rows.push(...data.value); next=data["@odata.nextLink"] ?? data["odata.nextLink"];
  }
  const keys=rows.map(key);
  if(new Set(keys).size!==keys.length) throw new Error("Duplicate evidence rows");
  return {rows,complete:true,pages:seen.size};
}
try {
  const metadata = await get("$metadata");
  await writeFile(`${dir}/metadata.xml`,metadata,{mode:0o600});
  const admin=pick(await get("CompanyService_GetAdminInfo"),"ContinuousStockManagement,PriceSystem,LocalCurrency,EnableAdvancedGLAccountDetermination,EnableBranches,BlockStockNegativeQuantity,GLMethod");
  const items=[];
  for (const item of ["C00003","z202604"]) items.push(await get(`Items('${item}')?$select=ItemCode,ItemName,CostAccountingMethod,InventoryUOM,InventoryItem,ManageBatchNumbers,ManageSerialNumbers,GLMethod,ItemsGroupCode,QuantityOnStock,AvgStdPrice,CreateDate,CreateTime,ItemWarehouseInfoCollection`));
  const warehouses=[];
  for(const w of ["01","02","03","04"]) warehouses.push(await get(`Warehouses('${w}')?$select=WarehouseCode,BusinessPlaceID,Inactive,DropShip,StockAccount,IncreaseGLAccount,DecreaseGLAccount,PriceDifferencesAccount,VarianceAccount,NegativeInventoryAdjustmentAccount`));
  const groups=[];
  for(const n of [100,105]) groups.push(await get(`ItemGroups(${n})?$select=Number,InventoryAccount,IncreaseGLAccount,DecreaseGLAccount,VarianceAccount,PriceDifferencesAccount,NegativeInventoryAdjustmentAccount`));
  const advancedRules=await pages("GLAccountAdvancedRules?$orderby=AbsoluteEntry",r=>r.AbsoluteEntry);
  const advancedCount=await get("GLAccountAdvancedRules/$count");
  if(!advancedRules.complete || !/^\d+$/.test(String(advancedCount)) || Number(advancedCount)!==advancedRules.rows.length) throw new Error("Incomplete advanced account rules");
  const historicalRevaluation=await get("MaterialRevaluation(7)?$select=DocEntry,DocNum,DocDate,TaxDate,Series,TransNum,RevalType,RevaluationIncomeAccount,RevaluationExpenseAccount,MaterialRevaluationLines");
  const roots=["InventoryGenEntries","InventoryGenExits","DeliveryNotes","Returns","Invoices","CreditNotes","PurchaseDeliveryNotes","PurchaseReturns","PurchaseInvoices","PurchaseCreditNotes","StockTransfers","InventoryPostings","InventoryOpeningBalances"];
  for(const entity of roots) {
    if(entity === "StockTransfers") {
      const path="StockTransfers?$select=DocEntry,DocDate,CreationDate,TransNum,StockTransferLines&$orderby=DocEntry";
      const data=await pages(path,r=>r.DocEntry);
      const count=await get("StockTransfers/$count");
      if(!data.complete || !/^\d+$/.test(String(count)) || Number(count)!==data.rows.length) throw new Error("Incomplete transfer evidence");
      let matched=0;
      for(const d of data.rows) {
        if(!Array.isArray(d.StockTransferLines) || Object.keys(d).some(k=>/nextLink$/i.test(k))) throw new Error("Incomplete transfer lines");
        for(const line of d.StockTransferLines.filter(l=>["C00003","z202604"].includes(l.ItemCode))) {
          matched++;
          movements.push({entity,header:pick(d,"DocEntry,DocDate,CreationDate,TransNum"),line:pick(line,"LineNum,ItemCode,InventoryQuantity,WarehouseCode,FromWarehouseCode,BaseType,BaseEntry")});
        }
      }
      collections.push({entity,path,rows:matched,documents:data.rows.length,pages:data.pages,exhausted:true,independentCount:count,independentReconciled:true,countScope:"all transfer documents; child rows filtered locally"});
      continue;
    }
    const special=entity==="StockTransfers",posting=entity==="InventoryPostings",opening=entity==="InventoryOpeningBalances";
    const lines=special?"StockTransferLines":posting?"InventoryPostingLines":opening?"InventoryOpeningBalanceLines":"DocumentLines";
    const id=posting||opening?"DocumentEntry":"DocEntry";
    const lineId=posting||opening?"LineNumber":"LineNum";
    const header=posting||opening?`${id},PostingDate`:`DocEntry,DocNum,DocDate,DocTime,CreationDate,TransNum${special?"":",Cancelled,CancelStatus"}`;
    const fields=posting?"LineNumber,ItemCode,WarehouseCode,Variance,InWarehouseQuantity,CountedQuantity,BaseEntry,BaseType":opening?"LineNumber,ItemCode,WarehouseCode,OpeningBalance,InWarehouseQuantity":`LineNum,ItemCode,InventoryQuantity,WarehouseCode,BaseType,BaseEntry${special?",FromWarehouseCode":",Quantity,MeasureUnit,WithoutInventoryMovement"}`;
    const join=`$crossjoin(${entity},${entity}/${lines})`;
    const filter=`${entity}/${id} eq ${entity}/${lines}/${id} and (${entity}/${lines}/ItemCode eq 'C00003' or ${entity}/${lines}/ItemCode eq 'z202604')`;
    const path=`${join}?$expand=${entity}($select=${header}),${entity}/${lines}($select=${fields})&$filter=${encodeURIComponent(filter)}&$orderby=${entity}/${id},${entity}/${lines}/${lineId}`;
    const data=await pages(path,r=>`${r[entity]?.[id]}/${r[`${entity}/${lines}`]?.[lineId]}`);
    const control=await get(`${join}/$count?$filter=${encodeURIComponent(filter)}`,true);
    collections.push({entity,path,rows:data.rows.length,pages:data.pages,exhausted:data.complete,independentCount:control,independentReconciled:control!==null && Number(control)===data.rows.length});
    for(const row of data.rows) movements.push({entity,header:row[entity],line:row[`${entity}/${lines}`]});
  }
  // Re-read actual documents for cancellation flags and inventory links (crossjoin returns raw enum values).
  for(const entity of ["InventoryGenEntries","InventoryGenExits","DeliveryNotes","Returns","Invoices","CreditNotes","PurchaseDeliveryNotes","PurchaseReturns","PurchaseInvoices","PurchaseCreditNotes"]) {
    const keys=[...new Set(movements.filter(m=>m.entity===entity).map(m=>m.header.DocEntry))];
    for(const id of keys) {
      const d=await get(`${entity}(${id})?$select=DocEntry,DocNum,DocDate,DocTime,CreationDate,TransNum,Cancelled,CancelStatus,DocumentLines`);
      const lines=d.DocumentLines.filter(l=>["C00003","z202604"].includes(l.ItemCode));
      documents.push({...pick(d,"DocEntry,DocNum,DocDate,DocTime,CreationDate,TransNum,Cancelled,CancelStatus"),entity,lines:lines.map(l=>pick(l,"LineNum,ItemCode,Quantity,InventoryQuantity,WarehouseCode,BaseType,BaseEntry,MeasureUnit,WithoutInventoryMovement,AccountCode,COGSAccountCode,StockValue,CostingCode,ProjectCode,SerialNumbers,BatchNumbers"))});
    }
  }
  for(const id of [...new Set(documents.filter(d=>d.DocDate.slice(0,10)>="2026-09-01" || d.lines.some(l=>l.ItemCode==="z202604")).map(d=>d.TransNum).filter(Boolean))]) {
    const j=await get(`JournalEntries(${id})?$select=JdtNum,ReferenceDate,JournalEntryLines`);
    journals.push({JdtNum:j.JdtNum,ReferenceDate:j.ReferenceDate,lines:j.JournalEntryLines.map(l=>pick(l,"Line_ID,AccountCode,Debit,Credit,CostingCode,ProjectCode,BPLID"))});
  }
  const accountCodes=[...new Set([...journals.flatMap(j=>j.lines.map(l=>l.AccountCode)),...documents.flatMap(d=>d.lines.flatMap(l=>[l.AccountCode,l.COGSAccountCode])),...historicalRevaluation.MaterialRevaluationLines.flatMap(l=>[l.RevaluationIncrementAccount,l.RevaluationDecrementAccount])].filter(Boolean))];
  const accounts=[];
  for(const code of accountCodes) accounts.push(await get(`ChartOfAccounts('${code}')?$select=Code,Name,ActiveAccount,AccountType`));
  const unchanged=[];
  for(const item of items) {
    const now=await get(`Items('${item.ItemCode}')?$select=ItemCode,QuantityOnStock,AvgStdPrice,ItemWarehouseInfoCollection`);
    unchanged.push({item:item.ItemCode,stable:JSON.stringify([item.QuantityOnStock,item.AvgStdPrice,item.ItemWarehouseInfoCollection])===JSON.stringify([now.QuantityOnStock,now.AvgStdPrice,now.ItemWarehouseInfoCollection])});
  }
  const report={company:session.info.company,capturedAt:new Date().toISOString(),connection:session.info,postingBlocked:true,metadataSha256:createHash("sha256").update(metadata).digest("hex"),admin,items,warehouses,groups,advancedRules:{...advancedRules,independentCount:advancedCount},historicalRevaluation,collections,movements,documents,journals,accounts,unchanged,reads,failures};
  await writeFile(`${dir}/evidence.json`,JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({directory:dir,collections,stable:unchanged,failures:failures.length,documents:documents.length},null,2));
} catch(error) {
  await writeFile(`${dir}/failed-read.json`,JSON.stringify({reads,failures,message:error.message},null,2),{mode:0o600});
  console.error(error.message);process.exitCode=1;
} finally { await session.close(); }
