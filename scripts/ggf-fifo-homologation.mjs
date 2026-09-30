import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";
import { openHomologationSession } from "./ggf-homologation-session.mjs";

const C=Object.freeze({id:"F1FIFO2609281",company:"SBODEMOBR2",item:"F1GGF26F01",
  warehouse:"01",branch:1,date:"2026-09-28",quantity:5,firstPrice:10,secondPrice:12,
  adjustedPrice:10.2,statePath:".local/ggf/fifo-F1FIFO2609281-state.json"});
const DIR=".local/ggf";
const previewPath=`${DIR}/fifo-${C.id}-preview.json`;
const resultPath=`${DIR}/fifo-${C.id}-post.json`;
const verifyPath=`${DIR}/fifo-${C.id}-verify.json`;
const memo=`FactoryOne FIFO homologacao ${C.id}`;

async function fifoEngine() {
  await mkdir(DIR,{recursive:true,mode:0o700});
  const output=`${DIR}/fifo-preview-engine.mjs`;
  await build({stdin:{contents:`export { previewFifoRevaluation, reconcileFifoValues } from "./webapp/modules/ggf/service/FifoRevaluationPreview.ts";`,
    resolveDir:process.cwd()},outfile:output,platform:"node",format:"esm",bundle:true});
  return import(pathToFileURL(resolve(output)).href+`?t=${Date.now()}`);
}

function ok(result,label) {
  if(!result.ok)throw new Error(`${label}: HTTP ${result.status}, SAP ${result.errorCode??"unknown"}, ${result.errorMessage??""}`);
  return result.data;
}
function exactCollection(result,label) {
  const value=ok(result,label);
  if(!Array.isArray(value?.value)||value["@odata.nextLink"])
    throw new Error(`${label}: incomplete SAP collection`);
  return value.value;
}
function expect(condition,message) { if(!condition)throw new Error(message); }
function cents(value,label) {
  if(typeof value!=="number"||!Number.isFinite(value)||Math.abs(value*100-Math.round(value*100))>1e-7)
    throw new Error(`${label}: unverified cent precision`);
  return Math.round(value*100);
}
function fingerprint(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
async function state() {
  try {
    const value=JSON.parse(await readFile(C.statePath,"utf8"));
    expect(value.scenario?.id===C.id&&value.scenario.company===C.company,"FIFO state belongs to another scenario");
    return value;
  } catch(error) {
    if(error.code==="ENOENT")return {scenario:C,createdAt:new Date().toISOString(),attempts:{}};
    throw error;
  }
}
async function save(value) {
  await mkdir(DIR,{recursive:true,mode:0o700});
  const temporary=`${C.statePath}.${process.pid}.tmp`;
  await writeFile(temporary,JSON.stringify(value,null,2)+"\n",{mode:0o600});
  await rename(temporary,C.statePath);
}
async function attempt(value,key,endpoint,request) {
  expect(!value.attempts[key],`${key} already attempted; reconcile SAP before retry`);
  value.attempts[key]={at:new Date().toISOString(),status:"POST_INTENT",endpoint,request};
  await save(value);
}
async function finish(value,key,response) {
  value.attempts[key].status=response.ok?"CREATED":"REJECTED";
  value.attempts[key].httpStatus=response.status;
  value.attempts[key].response=response.ok?response.data:
    {code:response.errorCode,message:response.errorMessage};
  await save(value);
  return ok(response,key);
}
async function fifo(sap) {
  const data=ok(await sap.readAction("MaterialRevaluationFIFOService_GetMaterialRevaluationFIFO",
    {MaterialRevaluationFIFOParams:{ItemCode:C.item,LocationCode:C.warehouse,
      LocationType:"64",ShowIssuedLayers:"tNO"}}),"FIFO layers");
  expect(Array.isArray(data?.Layers),"FIFO layer response incomplete");
  return data.Layers;
}
async function item(sap) {
  return ok(await sap.get(`Items('${C.item}')?$select=ItemCode,ItemName,InventoryItem,InventoryUOM,CostAccountingMethod,ManageSerialNumbers,ManageBatchNumbers,QuantityOnStock,ItemWarehouseInfoCollection`),"FIFO item");
}
function warehouse(row) {
  const locations=row.ItemWarehouseInfoCollection?.filter(w=>w.WarehouseCode===C.warehouse);
  expect(locations?.length===1,"Dedicated item has no unique warehouse row");
  return locations[0];
}
function checkItem(row,quantity) {
  expect(row.ItemCode===C.item&&row.InventoryItem==="tYES"&&row.CostAccountingMethod==="bis_FIFO"&&
    row.ManageSerialNumbers==="tNO"&&row.ManageBatchNumbers==="tNO"&&row.InventoryUOM==="UN"&&
    row.QuantityOnStock===quantity&&warehouse(row).InStock===quantity&&warehouse(row).Locked==="tNO",
    "FIFO item, method, unit or stock differs from controlled scenario");
}
function checkLayers(layers,count) {
  expect(layers.length===count,"Unexpected number of open FIFO layers");
  for(let i=0;i<count;i++) {
    const layer=layers[i],price=i===0?C.firstPrice:C.secondPrice;
    expect(Number.isSafeInteger(layer.TransactionSequenceNum)&&Number.isSafeInteger(layer.LayerID)&&
      layer.OpenQty===C.quantity&&cents(layer.CurrentCost,"FIFO cost")===price*100,
      `FIFO layer ${i+1} does not match the controlled receipt`);
  }
  expect(new Set(layers.map(l=>`${l.TransactionSequenceNum}/${l.LayerID}`)).size===count,
    "FIFO layer identity repeated");
}
async function period(sap) {
  const p=ok(await sap.readAction("CompanyService_GetFinancePeriod",
    {FinancePeriodParams:{AbsoluteEntry:179,PeriodIndicator:"Padrão"}}),"finance period");
  expect(p.PeriodCode==="2026-09"&&p.PeriodStatus==="ltUnlocked"&&p.Locked==="tNO"&&
    C.date>=p.PostingDateFrom.slice(0,10)&&C.date<=p.PostingDateTo.slice(0,10)&&
    C.date>=p.TaxDateFrom.slice(0,10)&&C.date<=p.TaxDateTo.slice(0,10),"Posting period is not open");
  return p;
}
async function inspect() {
  const sap=await openHomologationSession();
  try {
    const existing=await sap.get(`Items('${C.item}')?$select=ItemCode`);
    const wh=ok(await sap.get(`Warehouses('${C.warehouse}')?$select=WarehouseCode,BusinessPlaceID,Inactive,DropShip`),"warehouse");
    const admin=ok(await sap.get("CompanyService_GetAdminInfo"),"admin settings");
    const p=await period(sap);
    const series=ok(await sap.readAction("SeriesService_GetDefaultSeries",
      {DocumentTypeParams:{Document:"162"}}),"revaluation series");
    const receiptMarkers=[];
    for(const number of [1,2])receiptMarkers.push(exactCollection(await sap.get(
      `InventoryGenEntries?$filter=Comments eq '${memo} L${number}'&$select=DocEntry,Comments`),`receipt L${number}`).length);
    const rev=exactCollection(await sap.get(`MaterialRevaluation?$filter=Comments eq '${memo}'&$select=DocEntry,Comments`),"prior revaluation");
    expect(existing.status===404&&wh.BusinessPlaceID===C.branch&&wh.Inactive==="tNO"&&wh.DropShip==="tNO"&&
      admin.ContinuousStockManagement==="tYES"&&admin.PriceSystem==="tYES"&&
      admin.EnableAdvancedGLAccountDetermination==="tYES"&&series.Series===25&&series.Locked==="tNO"&&
      series.PeriodIndicator===p.PeriodIndicator&&receiptMarkers.every(n=>n===0)&&rev.length===0,
      "Dedicated FIFO baseline is not empty or accounting setup differs");
    return {scenario:C.id,itemAbsent:true,warehouse:C.warehouse,branch:C.branch,
      period:p.PeriodCode,series:series.Series,receiptMarkers,priorRevaluation:rev.length};
  } finally {await sap.close();}
}
async function createItem() {
  await inspect();
  const journal=await state();
  const request={ItemCode:C.item,ItemName:`FactoryOne FIFO homologacao ${C.id}`,ItemsGroupCode:100,
    InventoryItem:"tYES",SalesItem:"tNO",PurchaseItem:"tNO",InventoryUOM:"UN",
    CostAccountingMethod:"bis_FIFO",GLMethod:"glm_WH",ManageBatchNumbers:"tNO",ManageSerialNumbers:"tNO"};
  const sap=await openHomologationSession();
  try {
    await attempt(journal,"item","Items",request);
    await finish(journal,"item",await sap.post("Items",request));
    const row=await item(sap);checkItem(row,0);
    return {item:C.item,method:row.CostAccountingMethod,stock:row.QuantityOnStock};
  } finally {await sap.close();}
}
async function receipt(number) {
  expect(number===1||number===2,"Only two dedicated receipts are allowed");
  const journal=await state();
  expect(journal.attempts.item?.status==="CREATED"&&
    (number===1||journal.attempts.receipt1?.status==="CREATED"),"Prior FIFO scenario step is incomplete");
  const sap=await openHomologationSession();
  try {
    checkItem(await item(sap),(number-1)*C.quantity);
    checkLayers(await fifo(sap),number-1);
    const marker=`${memo} L${number}`;
    expect(exactCollection(await sap.get(`InventoryGenEntries?$filter=Comments eq '${marker}'&$select=DocEntry,Comments`),
      "receipt duplicate check").length===0,"Receipt already exists");
    const price=number===1?C.firstPrice:C.secondPrice;
    const request={DocDate:C.date,BPL_IDAssignedToInvoice:C.branch,Comments:marker,
      DocumentLines:[{ItemCode:C.item,Quantity:C.quantity,WarehouseCode:C.warehouse,
        UnitPrice:price,UseBaseUnits:"tYES"}]};
    const key=`receipt${number}`;
    await attempt(journal,key,"InventoryGenEntries",request);
    const posted=await finish(journal,key,await sap.post("InventoryGenEntries",request));
    expect(Number.isSafeInteger(posted.DocEntry)&&Number.isSafeInteger(posted.DocNum),
      "Receipt key missing; reconcile SAP before proceeding");
    journal[key]={entry:posted.DocEntry,num:posted.DocNum,transId:posted.TransNum};
    await save(journal);
    checkItem(await item(sap),number*C.quantity);
    checkLayers(await fifo(sap),number);
    return {document:journal[key],layerCount:number,stock:number*C.quantity};
  } finally {await sap.close();}
}
async function gather(sap,journal) {
  expect(journal.attempts.receipt1?.status==="CREATED"&&journal.attempts.receipt2?.status==="CREATED",
    "Two confirmed FIFO receipts are required");
  const row=await item(sap);checkItem(row,10);
  const layers=await fifo(sap);checkLayers(layers,2);
  const receipts=[];
  for(const number of [1,2]) {
    const d=ok(await sap.get(`InventoryGenEntries(${journal[`receipt${number}`].entry})`),`receipt L${number}`);
    const line=d.DocumentLines?.[0],price=number===1?C.firstPrice:C.secondPrice;
    expect(d.DocNum===journal[`receipt${number}`].num&&d.Comments===`${memo} L${number}`&&
      d.Cancelled==="tNO"&&d.CancelStatus==="csNo"&&d.DocCurrency==="R$"&&
      d.DocumentLines?.length===1&&line.ItemCode===C.item&&line.WarehouseCode===C.warehouse&&
      line.Quantity===C.quantity&&line.InventoryQuantity===C.quantity&&
      cents(line.UnitPrice,"receipt unit cost")===price*100&&
      cents(line.LineTotal,"receipt line value")===C.quantity*price*100,
      `Receipt L${number} cost, quantity or identity changed`);
    receipts.push({entry:d.DocEntry,num:d.DocNum,transId:d.TransNum,date:d.DocDate,
      quantity:line.InventoryQuantity,price:line.UnitPrice,total:line.LineTotal,warehouse:line.WarehouseCode});
  }
  expect(layers.every((layer,index)=>String(layer.DocNumber)===String(receipts[index].num)),
    "FIFO layers cannot be tied uniquely to the two controlled receipts");
  const p=await period(sap);
  const series=ok(await sap.readAction("SeriesService_GetDefaultSeries",
    {DocumentTypeParams:{Document:"162"}}),"revaluation series");
  expect(series.Series===25&&series.Locked==="tNO"&&series.PeriodIndicator===p.PeriodIndicator,
    "Revaluation series changed");
  const wh=ok(await sap.get(`Warehouses('${C.warehouse}')?$select=WarehouseCode,BusinessPlaceID,Inactive,DropShip`),"warehouse");
  expect(wh.BusinessPlaceID===C.branch&&wh.Inactive==="tNO"&&wh.DropShip==="tNO","Warehouse changed");
  const accounts={};
  for(const kind of ["iatInventory","iatIncreasing","iatGLIncrease"]) {
    const data=ok(await sap.readAction("CompanyService_GetAdvancedGLAccount",
      {AdvancedGLAccountParams:{ItemCode:C.item,Warehouse:C.warehouse,
        PostingDate:`${C.date}T00:00:00Z`,AccountType:kind}}),kind);
    expect(typeof data.AccountCode==="string"&&data.AccountCode,"Required account not resolved");
    const chart=ok(await sap.get(`ChartOfAccounts('${data.AccountCode}')?$select=Code,Name,ActiveAccount,BlockManualPosting,CostAccountingOnly,ProjectRelevant`),kind);
    expect(chart.ActiveAccount==="tYES"&&chart.BlockManualPosting==="tNO"&&
      chart.CostAccountingOnly==="tNO"&&chart.ProjectRelevant==="tNO","Account not postable");
    accounts[kind]={code:data.AccountCode,name:chart.Name};
  }
  for(const receipt of receipts) {
    const entry=ok(await sap.get(`JournalEntries(${receipt.transId})?$select=JdtNum,ReferenceDate,JournalEntryLines`),
      `receipt journal ${receipt.transId}`);
    const lines=entry.JournalEntryLines?.filter(l=>l.Debit||l.Credit);
    const amount=cents(receipt.total,"receipt journal amount");
    expect(entry.JdtNum===receipt.transId&&lines?.length===2&&
      lines.some(l=>l.AccountCode===accounts.iatInventory.code&&
        cents(l.Debit,"receipt inventory debit")===amount&&cents(l.Credit,"receipt inventory credit")===0&&
        l.BPLID===C.branch)&&
      lines.some(l=>l.AccountCode===accounts.iatIncreasing.code&&
        cents(l.Credit,"receipt offset credit")===amount&&cents(l.Debit,"receipt offset debit")===0&&
        l.BPLID===C.branch),"Receipt journal does not independently support FIFO layer value");
    receipt.journal={transId:entry.JdtNum,lines:lines.map(l=>({account:l.AccountCode,
      debit:l.Debit,credit:l.Credit,branch:l.BPLID}))};
  }
  const previous=exactCollection(await sap.get(`MaterialRevaluation?$filter=Comments eq '${memo}'&$select=DocEntry,Comments`),
    "MaterialRevaluation duplicate check");
  expect(previous.length===0,"Revaluation already exists for the FIFO marker");
  const before={item:C.item,warehouse:C.warehouse,method:row.CostAccountingMethod,unit:row.InventoryUOM,
    stock:warehouse(row).InStock,layers:layers.map(l=>({transactionSequenceNum:l.TransactionSequenceNum,
      layerId:l.LayerID,docNumber:l.DocNumber,docType:l.DocType,entryDate:l.EntryDate,
      openQty:l.OpenQty,currentCost:l.CurrentCost})),receipts,accounts,period:p.PeriodCode,series:series.Series};
  const valueBefore=layers.reduce((sum,l)=>sum+cents(l.CurrentCost,"layer cost")*l.OpenQty,0);
  expect(valueBefore===11000,"Unexpected FIFO value before revaluation");
  const proposedValue=valueBefore+(C.adjustedPrice-C.firstPrice)*100*C.quantity;
  expect(Math.abs(proposedValue-11100)<1e-7,"Unexpected proposed FIFO value");
  const {previewFifoRevaluation}=await fifoEngine();
  const calculation=previewFifoRevaluation({item:C.item,warehouse:C.warehouse,
    stockQty:String(warehouse(row).InStock),
    layers:layers.map((layer,index)=>({transactionSequenceNum:layer.TransactionSequenceNum,
      layerId:layer.LayerID,openQty:String(layer.OpenQty),currentCost:String(layer.CurrentCost),
      receiptQty:String(receipts[index].quantity),source:`InventoryGenEntries(${receipts[index].entry})/0`})),
    target:{transactionSequenceNum:layers[0].TransactionSequenceNum,layerId:layers[0].LayerID,
      eligibleQty:String(layers[0].OpenQty),newPrice:String(C.adjustedPrice)},
    posting:{date:C.date,series:series.Series,reference:C.id,memo,
      incrementAccount:accounts.iatGLIncrease.code}});
  expect(calculation.status==="FIFO_APTO"&&calculation.beforeMinor==="11000"&&
    calculation.deltaMinor==="100"&&calculation.afterMinor==="11100"&&
    calculation.payload?.MaterialRevaluationLines?.[0]?.FIFOLayers?.[0]?.Price===C.adjustedPrice,
    `FIFO preview differs from independent calculation: ${calculation.status}`);
  const payload=calculation.payload;
  const stable={before,payload,calculation,valueBeforeMinor:valueBefore,
    expectedDeltaMinor:100,expectedAfterMinor:11100};
  return {status:"FIFO_APTO",company:C.company,scenario:C.id,capturedAt:new Date().toISOString(),
    ...stable,fingerprint:fingerprint(stable)};
}
async function preview() {
  const journal=await state();
  expect(!journal.attempts.revaluation,"Revaluation was already attempted");
  const sap=await openHomologationSession();
  try {
    const result=await gather(sap,journal);
    await writeFile(previewPath,JSON.stringify(result,null,2)+"\n",{mode:0o600});
    return {path:previewPath,status:result.status,before:result.before,
      expected:{beforeMinor:result.valueBeforeMinor,deltaMinor:result.expectedDeltaMinor,
        afterMinor:result.expectedAfterMinor},payload:result.payload};
  } finally {await sap.close();}
}
async function postOnce() {
  await mkdir(DIR,{recursive:true,mode:0o700});
  const lockPath=`${DIR}/fifo-${C.id}-post.lock`,lock=await open(lockPath,"wx",0o600);
  try {
    const journal=await state();
    expect(!journal.attempts.revaluation,"FIFO revaluation already attempted; never repost automatically");
    const prior=JSON.parse(await readFile(previewPath,"utf8"));
    const sap=await openHomologationSession();
    try {
      const fresh=await gather(sap,journal);
      expect(fresh.status==="FIFO_APTO"&&fresh.fingerprint===prior.fingerprint,
        "SAP stock, accounts, layers or payload changed since preview");
      await attempt(journal,"revaluation","MaterialRevaluation",fresh.payload);
      const startedAt=new Date().toISOString();
      let response;
      try {response=await sap.postFifoRevaluation(fresh.payload,fresh);}
      catch(error) {
        journal.attempts.revaluation.status="POSTING_UNCERTAIN";
        journal.attempts.revaluation.error="Transport/response uncertainty; reconcile SAP before any action";
        await save(journal);
        throw error;
      }
      const result={scenario:C.id,startedAt,endedAt:new Date().toISOString(),request:fresh.payload,
        httpStatus:response.status,response:response.ok?response.data:
          {code:response.errorCode,message:response.errorMessage}};
      await writeFile(resultPath,JSON.stringify(result,null,2)+"\n",{mode:0o600});
      journal.attempts.revaluation.status=response.ok?"POSTED":"REJECTED";
      journal.attempts.revaluation.httpStatus=response.status;
      journal.attempts.revaluation.response=response.ok?
        {DocEntry:response.data?.DocEntry,DocNum:response.data?.DocNum,TransNum:response.data?.TransNum}:
        {code:response.errorCode,message:response.errorMessage};
      await save(journal);
      ok(response,"single FIFO revaluation");
      return {path:resultPath,httpStatus:response.status,document:journal.attempts.revaluation.response};
    } finally {await sap.close();}
  } finally {await lock.close();await unlink(lockPath);}
}
async function verify() {
  const journal=await state();
  expect(journal.attempts.revaluation?.status==="POSTED","No confirmed FIFO revaluation to verify");
  const prior=JSON.parse(await readFile(previewPath,"utf8"));
  const id=journal.attempts.revaluation.response.DocEntry;
  expect(Number.isSafeInteger(id),"SAP revaluation DocEntry missing");
  const sap=await openHomologationSession();
  try {
    const doc=ok(await sap.get(`MaterialRevaluation(${id})`),"created FIFO revaluation");
    const itemAfter=await item(sap);checkItem(itemAfter,10);
    const layers=await fifo(sap);
    const journalEntry=ok(await sap.get(`JournalEntries(${doc.TransNum})`),"generated journal");
    const markerMatches=exactCollection(await sap.get(`MaterialRevaluation?$filter=Comments eq '${memo}'&$select=DocEntry,Comments`),
      "revaluation marker lookup");
    const after=layers.map(l=>({transactionSequenceNum:l.TransactionSequenceNum,layerId:l.LayerID,
      docNumber:l.DocNumber,docType:l.DocType,openQty:l.OpenQty,currentCost:l.CurrentCost}));
    const afterMinor=layers.reduce((sum,l)=>sum+cents(l.CurrentCost,"after layer cost")*l.OpenQty,0);
    const lines=journalEntry.JournalEntryLines?.filter(l=>l.Debit||l.Credit).map(l=>
      ({account:l.AccountCode,debit:l.Debit,credit:l.Credit,branch:l.BPLID,dimension:l.CostingCode}));
    const debitMinor=lines?.reduce((sum,l)=>sum+cents(l.debit,"journal debit"),0);
    const creditMinor=lines?.reduce((sum,l)=>sum+cents(l.credit,"journal credit"),0);
    const documentLine=doc.MaterialRevaluationLines?.find(l=>l.ItemCode===C.item&&l.WarehouseCode===C.warehouse);
    const result={scenario:C.id,capturedAt:new Date().toISOString(),before:prior.before,
      expected:{beforeMinor:prior.valueBeforeMinor,deltaMinor:prior.expectedDeltaMinor,afterMinor:prior.expectedAfterMinor},
      document:{entry:doc.DocEntry,num:doc.DocNum,transId:doc.TransNum,date:doc.DocDate,
        type:doc.RevalType,comments:doc.Comments,reference1:doc.Reference1,
        line:documentLine?{item:documentLine.ItemCode,warehouse:documentLine.WarehouseCode,
          revaluationAmountToStock:documentLine.RevalAmountToStock,
          fifoLayers:documentLine.FIFOLayers,incrementAccount:documentLine.RevaluationIncrementAccount}:null},
      after:{stock:warehouse(itemAfter).InStock,layers,valueMinor:afterMinor},
      journal:{transId:journalEntry.JdtNum,lines,debitMinor,creditMinor},
      differenceMinor:afterMinor-prior.valueBeforeMinor-prior.expectedDeltaMinor};
    const {reconcileFifoValues}=await fifoEngine();
    result.layerReconciliation=reconcileFifoValues(prior.calculation,after.map(l=>({
      transactionSequenceNum:l.transactionSequenceNum,layerId:l.layerId,
      openQty:String(l.openQty),currentCost:String(l.currentCost),
      docNumber:String(l.docNumber),docType:l.docType})),
    String(debitMinor),String(creditMinor),{docNum:String(doc.DocNum)});
    const sourceLayer=prior.payload.MaterialRevaluationLines[0].FIFOLayers[0];
    const postedLayer=documentLine?.FIFOLayers?.[0];
    result.reconciled=doc.DocEntry===id&&doc.RevalType==="P"&&doc.Series===prior.before.series&&
      doc.Comments===memo&&doc.JournalMemo===memo&&
      markerMatches.length===1&&markerMatches[0].DocEntry===id&&
      documentLine?.RevaluationIncrementAccount===prior.before.accounts.iatGLIncrease.code&&
      documentLine?.FIFOLayers?.length===1&&
      postedLayer?.TransactionSequenceNum===sourceLayer.TransactionSequenceNum&&
      postedLayer?.LayerID===sourceLayer.LayerID&&postedLayer?.Price===sourceLayer.Price&&
      afterMinor===11100&&result.differenceMinor===0&&
      journalEntry.JdtNum===doc.TransNum&&debitMinor===100&&creditMinor===100&&lines?.length===2&&
      lines.some(l=>l.account===prior.before.accounts.iatInventory.code&&cents(l.debit,"inventory debit")===100)&&
      lines.some(l=>l.account===prior.before.accounts.iatGLIncrease.code&&cents(l.credit,"GL credit")===100)&&
      result.layerReconciliation.reconciled;
    await writeFile(verifyPath,JSON.stringify(result,null,2)+"\n",{mode:0o600});
    if(!result.reconciled)throw new Error(`FIFO reconciliation failed; inspect ${verifyPath}`);
    return {path:verifyPath,reconciled:true,document:result.document,after:result.after,journal:result.journal};
  } finally {await sap.close();}
}

const operation=process.argv[2];
try {
  const result=operation==="inspect"?await inspect():operation==="item"?await createItem():
    operation==="receipt1"?await receipt(1):operation==="receipt2"?await receipt(2):
    operation==="preview"?await preview():operation==="post"?await postOnce():
    operation==="verify"?await verify():null;
  if(!result)throw new Error("Choose inspect, item, receipt1, receipt2, preview, post or verify");
  console.log(JSON.stringify(result,null,2));
} catch(error) {console.error(error.message);process.exitCode=1;}
