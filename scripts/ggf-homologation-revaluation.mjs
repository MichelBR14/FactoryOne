import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";
import { openHomologationSession } from "./ggf-homologation-session.mjs";
import { SCENARIO, readState, saveState } from "./ggf-homologation-scenario.mjs";
import { captureMovements } from "./ggf-homologation-movements.mjs";

const DIR=".local/ggf";
const PREVIEW_FILE=`${DIR}/material-revaluation-preflight-${SCENARIO.id}.json`;
const POST_FILE=`${DIR}/material-revaluation-post-${SCENARIO.id}.json`;
const VERIFY_FILE=`${DIR}/material-revaluation-verify-${SCENARIO.id}.json`;
const TECHNICAL_AMOUNT_MINOR=100;

async function engine() {
  await mkdir(DIR,{recursive:true,mode:0o700});
  const output=`${DIR}/homologation-engine.mjs`;
  await build({stdin:{contents:`export { previewRevaluation } from "./webapp/modules/ggf/service/RevaluationPreview.ts";
export { simulateMaterialRevaluation } from "./webapp/modules/ggf/service/MaterialRevaluationPayload.ts";`,resolveDir:process.cwd()},
    outfile:output,platform:"node",format:"esm",bundle:true});
  return import(pathToFileURL(resolve(output)).href+`?t=${Date.now()}`);
}
function requireOk(result,label) {
  if(!result.ok)throw new Error(`${label}: HTTP ${result.status}, SAP ${result.errorCode??"unknown"}, ${result.errorMessage??""}`);
  return result.data;
}
const v=(value,ref)=>({value,refs:Array.isArray(ref)?ref:[ref]});
function money(value) {
  if(typeof value!=="number"||!Number.isFinite(value)||Math.round(value*100)!==value*100)
    throw new Error("SAP amount has unverified currency precision");
  return value.toFixed(2);
}
function number(value) {
  if(typeof value!=="number"||!Number.isFinite(value)||!/^\d+(\.\d{1,6})?$/.test(String(value)))
    throw new Error("SAP number has unverified precision");
  return String(value);
}
async function readBusiness(sap,path,label) { return requireOk(await sap.get(path),label); }
async function action(sap,name,body,label) { return requireOk(await sap.readAction(name,body),label); }

async function preflight() {
  const state=await readState();
  if(state.attempts.close?.status!=="CLOSED"||!state.productionOrder?.entry||!state.receipt?.entry)
    throw new Error("Dedicated OP and receipt are not complete");
  if(state.attempts.materialRevaluation)throw new Error("A revaluation POST was already attempted for this closing");
  const movement=await captureMovements();
  const sap=await openHomologationSession();
  try {
    const itemPath=`Items('${SCENARIO.item}')?$select=ItemCode,ItemName,ItemsGroupCode,InventoryItem,InventoryUOM,CostAccountingMethod,ManageSerialNumbers,ManageBatchNumbers,QuantityOnStock,AvgStdPrice,ItemWarehouseInfoCollection`;
    const item=await readBusiness(sap,itemPath,"item");
    const op=await readBusiness(sap,`ProductionOrders(${state.productionOrder.entry})?$select=AbsoluteEntry,DocumentNumber,ItemNo,ProductionOrderStatus,PlannedQuantity,CompletedQuantity,InventoryUOM,Warehouse,ProductionOrderLines`,"OP");
    const receipt=await readBusiness(sap,`InventoryGenEntries(${state.receipt.entry})?$select=DocEntry,DocNum,DocDate,DocTime,DocCurrency,Cancelled,CancelStatus,TransNum,DocumentLines`,"receipt");
    const issues=await readBusiness(sap,`InventoryGenExits?$filter=DocDate ge ${SCENARIO.date}&$select=DocEntry,DocNum,DocDate,Cancelled,CancelStatus,TransNum,DocumentLines&$orderby=DocEntry`,"resource issues");
    if(issues["@odata.nextLink"]||!Array.isArray(issues.value))throw new Error("Resource issue page incomplete");
    const matchedIssues=issues.value.flatMap(d=>d.DocumentLines.filter(l=>l.BaseType===202&&l.BaseEntry===op.AbsoluteEntry)
      .map(l=>({doc:d,line:l})));
    const resource=await readBusiness(sap,`Resources('${SCENARIO.resource}')?$select=Code,Name,Type,Group,Cost1,Active,Inactive`,"resource");
    const admin=await readBusiness(sap,"CompanyService_GetAdminInfo","admin policy");
    const warehouse=await readBusiness(sap,`Warehouses('${SCENARIO.warehouse}')?$select=WarehouseCode,BusinessPlaceID,Inactive,DropShip`,"warehouse");
    const period=await action(sap,"CompanyService_GetFinancePeriod",{FinancePeriodParams:{AbsoluteEntry:179,PeriodIndicator:"Padrão"}},"posting period");
    const series=await action(sap,"SeriesService_GetDefaultSeries",{DocumentTypeParams:{Document:"162"}},"revaluation series");
    const accountTypes=["iatInventory","iatGLIncrease","iatGLDecrease"];
    const resolved={};
    for(const kind of accountTypes) {
      const params={AdvancedGLAccountParams:{ItemCode:SCENARIO.item,Warehouse:SCENARIO.warehouse,
        PostingDate:`${SCENARIO.date}T00:00:00Z`,AccountType:kind}};
      const result=await action(sap,"CompanyService_GetAdvancedGLAccount",params,`account ${kind}`);
      if(!result.AccountCode)throw new Error(`No resolved account for ${kind}`);
      resolved[kind]=result.AccountCode;
    }
    const charts={};
    for(const code of new Set(Object.values(resolved)))charts[code]=await readBusiness(sap,
      `ChartOfAccounts('${code}')?$select=Code,Name,ActiveAccount,PrimaryAccount,BlockManualPosting,CostAccountingOnly,ProjectRelevant`,"chart account");
    const same=await readBusiness(sap,itemPath,"item stability reread");
    const duplicate=await readBusiness(sap,`MaterialRevaluation?$filter=Comments eq 'FactoryOne GGF homologacao ${SCENARIO.id}'&$select=DocEntry,Comments,Reference1`,"idempotency lookup");
    if(!Array.isArray(duplicate.value)||duplicate.value.length||duplicate["@odata.nextLink"])throw new Error("MaterialRevaluation already exists or check incomplete");
    const wh=item.ItemWarehouseInfoCollection?.filter(w=>w.WarehouseCode===SCENARIO.warehouse);
    const line=receipt.DocumentLines?.filter(l=>l.LineNum===0);
    if(JSON.stringify(item)!==JSON.stringify(same)||item.ItemCode!==SCENARIO.item||item.InventoryItem!=="tYES"||
        item.CostAccountingMethod!=="bis_MovingAverage"||item.ManageSerialNumbers!=="tNO"||item.ManageBatchNumbers!=="tNO"||
        item.InventoryUOM!=="UN"||item.QuantityOnStock!==1||wh?.length!==1||wh[0].InStock!==1||wh[0].Locked!=="tNO"||
        op.ItemNo!==SCENARIO.item||op.DocumentNumber!==state.productionOrder.number||op.ProductionOrderStatus!=="boposClosed"||
        op.PlannedQuantity!==1||op.CompletedQuantity!==1||op.InventoryUOM!=="UN"||op.Warehouse!==SCENARIO.warehouse||
        receipt.Cancelled!=="tNO"||receipt.CancelStatus!=="csNo"||receipt.DocCurrency!=="R$"||line?.length!==1||
        line[0].ItemCode!==SCENARIO.item||line[0].BaseType!==202||line[0].BaseEntry!==op.AbsoluteEntry||
        line[0].InventoryQuantity!==1||line[0].MeasureUnit!=="UN"||line[0].WarehouseCode!==SCENARIO.warehouse||
        line[0].TransactionType!=="botrntComplete"||matchedIssues.length!==1||matchedIssues[0].doc.Cancelled!=="tNO"||
        matchedIssues[0].line.ItemCode!==SCENARIO.resource||matchedIssues[0].line.ItemType!=="dit_Resource"||
        resource.Code!==SCENARIO.resource||resource.Active!=="tYES"||resource.Inactive!=="tNO"||
        admin.ContinuousStockManagement!=="tYES"||admin.PriceSystem!=="tYES"||
        admin.EnableAdvancedGLAccountDetermination!=="tYES"||warehouse.BusinessPlaceID!==SCENARIO.branch||
        warehouse.Inactive!=="tNO"||warehouse.DropShip!=="tNO"||
        period.PeriodCode!=="2026-09"||period.PeriodStatus!=="ltUnlocked"||period.Locked!=="tNO"||
        SCENARIO.date<period.PostingDateFrom.slice(0,10)||SCENARIO.date>period.PostingDateTo.slice(0,10)||
        SCENARIO.date<period.TaxDateFrom.slice(0,10)||SCENARIO.date>period.TaxDateTo.slice(0,10)||
        series.Document!=="162"||series.Series!==25||series.Locked!=="tNO"||series.IsManual!=="tNO"||
        series.PeriodIndicator!==period.PeriodIndicator||
        Object.values(charts).some(c=>c.ActiveAccount!=="tYES"||c.BlockManualPosting!=="tNO"||
          c.CostAccountingOnly!=="tNO"||c.ProjectRelevant!=="tNO"))
      throw new Error("SAP preflight identity, amount, period or accounting proof failed");
    const direct=money(matchedIssues[0].line.LineTotal);
    if(direct!==money(line[0].LineTotal)||direct!==money(wh[0].StandardAveragePrice)||
        resource.Cost1!==matchedIssues[0].line.LineTotal)throw new Error("Direct cost and receipt price differ");
    const issueRef=`InventoryGenExits(${matchedIssues[0].doc.DocEntry})/${matchedIssues[0].line.LineNum}`;
    const receiptRef=`InventoryGenEntries(${receipt.DocEntry})/0`;
    const stockAt=new Date().toISOString();
    const input={origin:"sap",company:SCENARIO.company,allocationId:SCENARIO.id,allocationDate:stockAt,
      stockDate:stockAt,technicalOnly:false,
      sourceRefs:[`ProductionOrders(${op.AbsoluteEntry})`,issueRef,receiptRef,movement.path],
      policy:{perpetual:true,costScope:"warehouse",functionalApproved:true,stockTreatment:"spread-over-current-stock",
        postingDate:SCENARIO.date,incrementAccount:resolved.iatGLIncrease,decrementAccount:resolved.iatGLDecrease,accountsVerified:true},
      orders:[{id:String(op.AbsoluteEntry),number:String(op.DocumentNumber),item:SCENARIO.item,
        planned:number(op.PlannedQuantity),produced:number(op.CompletedQuantity),unit:"UN",allocatedMinor:String(TECHNICAL_AMOUNT_MINOR),
        accounts:[{account:"F1-TECH",name:"Valor tecnico controlado, sem conta GGF",amountMinor:String(TECHNICAL_AMOUNT_MINOR)}],
        components:[{kind:"resource",code:SCENARIO.resource,amount:direct,sourceRefs:[issueRef]}],
        receipts:[{document:String(receipt.DocEntry),line:0,date:receipt.DocDate.slice(0,10),
          warehouse:SCENARIO.warehouse,quantity:number(line[0].InventoryQuantity),unit:"UN"}],
        remaining:[{warehouse:SCENARIO.warehouse,quantity:"1",evidence:`${movement.path}: one receipt, no outflow, independently counted`}],
        inconsistencies:[]}],
      items:[{code:SCENARIO.item,name:item.ItemName,unit:item.InventoryUOM,method:item.CostAccountingMethod,
        inventory:true,serial:false,batch:false,totalStock:number(item.QuantityOnStock),globalCost:number(item.AvgStdPrice),
        warehouses:item.ItemWarehouseInfoCollection.map(w=>({code:w.WarehouseCode,stock:number(w.InStock),
          cost:number(w.StandardAveragePrice),locked:w.Locked!=="tNO"}))}]};
    const {previewRevaluation,simulateMaterialRevaluation}=await engine();
    const preview=previewRevaluation(input);
    const source=(label)=>`Service Layer ${label} / ${SCENARIO.item} / ${SCENARIO.date}`;
    const evidence={origin:"sap",company:SCENARIO.company,allocationId:SCENARIO.id,stockDate:preview.stockDate,
      header:{method:v("moving-average-price-change-v1",source("Items.CostAccountingMethod + AdminInfo.PriceSystem")),
        postingDate:v(SCENARIO.date,source("FinancePeriod(179).PostingDateFrom/To")),
        taxDate:v(SCENARIO.date,source("FinancePeriod(179).TaxDateFrom/To")),
        series:v(series.Series,source("SeriesService_GetDefaultSeries(162)")),
        periodOpen:v(true,source("FinancePeriod(179).PeriodStatus=ltUnlocked")),
        branchScope:v(String(warehouse.BusinessPlaceID),source("Warehouses(01).BusinessPlaceID")),
        authorization:v(true,"User-authorized SBODEMOBR2 technical homologation; SAP permission to be confirmed by POST"),
        functionalApproval:v(true,"User-authorized one technical R$ 1.00 revaluation; not a functional GGF pool"),
        optionalFields:v("resolved",source("ChartOfAccounts ProjectRelevant=tNO, CostAccountingOnly=tNO; no required project or dimensions")),
        reference1:v(SCENARIO.id,"FactoryOne unique local closing ID/version 1"),
        memo:v(`FactoryOne GGF homologacao ${SCENARIO.id}`,"FactoryOne test scenario identifier")},
      lines:[{key:`${SCENARIO.item}/${SCENARIO.warehouse}`,branch:String(warehouse.BusinessPlaceID),
        warehouse:v(SCENARIO.warehouse,`${receiptRef}:WarehouseCode`),
        currentCost:v(preview.scopes[0].currentCost,source("Items.ItemWarehouseInfoCollection(01).StandardAveragePrice")),
        stock:v(preview.scopes[0].stock,source("Items.ItemWarehouseInfoCollection(01).InStock")),
        eligibility:[{orderId:String(op.AbsoluteEntry),quantity:"1",receiptRefs:[`${receipt.DocEntry}/0`],
          refs:[movement.path,source("14 independently counted inventory document collections")]}],
        accounting:{inventory:v(resolved.iatInventory,source("GetAdvancedGLAccount iatInventory")),
          increment:v(resolved.iatGLIncrease,source("GetAdvancedGLAccount iatGLIncrease")),
          decrement:v(resolved.iatGLDecrease,source("GetAdvancedGLAccount iatGLDecrease")),
          determination:v("advanced",source("AdminInfo.EnableAdvancedGLAccountDetermination=tYES")),
          advancedEnabled:true,activePostable:v(true,source("ChartOfAccounts ActiveAccount=tYES BlockManualPosting=tNO"))}}]};
    const simulation=simulateMaterialRevaluation(preview,evidence);
    const before={item:SCENARIO.item,warehouse:SCENARIO.warehouse,method:item.CostAccountingMethod,
      quantity:number(wh[0].InStock),cost:money(wh[0].StandardAveragePrice),stockValue:money(wh[0].InStock*wh[0].StandardAveragePrice),
      directCost:direct,resourceIssue:issueRef,receipt:receiptRef,op:String(op.DocumentNumber),
      expectedGgf:"1.00",expectedUnitGgf:"1.00",expectedCost:"13.00",expectedStockValue:"13.00",expectedDifference:"1.00"};
    if(simulation.status!=="APTO"||preview.rows.length!==1||preview.rows[0].status!=="READY"||
        preview.rows[0].ggf!=="1.00"||preview.rows[0].currentCost!=="12.000000"||
        preview.rows[0].adjustedCost!=="13.000000"||preview.estimatedTotal!=="1.00"||
        simulation.payload?.MaterialRevaluationLines.length!==1||simulation.payload.MaterialRevaluationLines[0].Price!==13)
      throw new Error(`Document simulator not ready: ${simulation.status}`);
    const report={scenario:SCENARIO,company:SCENARIO.company,capturedAt:stockAt,technicalAmountOnly:true,
      functionalGgfPoolValidated:false,before,period:{entry:period.AbsoluteEntry,code:period.PeriodCode,status:period.PeriodStatus},
      series:{number:series.Series,next:series.NextNumber,locked:series.Locked},resolvedAccounts:resolved,
      accountNames:Object.fromEntries(Object.entries(charts).map(([code,c])=>[code,c.Name])),
      movementEvidence:movement.path,input,preview,simulation,request:simulation.payload};
    await writeFile(PREVIEW_FILE,JSON.stringify(report,null,2)+"\n",{mode:0o600});
    return {path:PREVIEW_FILE,report};
  } finally { await sap.close(); }
}

async function postOnceLocked() {
  const {report,path}=await preflight();
  const state=await readState();
  if(state.attempts.materialRevaluation)throw new Error("Revaluation already attempted");
  const sap=await openHomologationSession();
  try {
    const duplicate=requireOk(await sap.get(`MaterialRevaluation?$filter=Comments eq 'FactoryOne GGF homologacao ${SCENARIO.id}'&$select=DocEntry,Comments,Reference1`),"last idempotency check");
    if(!Array.isArray(duplicate.value)||duplicate.value.length||duplicate["@odata.nextLink"])
      throw new Error("A document with this closing reference already exists");
    const current=requireOk(await sap.get(`Items('${SCENARIO.item}')?$select=QuantityOnStock,ItemWarehouseInfoCollection`),"last cost/stock check");
    const wh=current.ItemWarehouseInfoCollection?.find(w=>w.WarehouseCode===SCENARIO.warehouse);
    if(current.QuantityOnStock!==1||wh?.InStock!==1||wh?.StandardAveragePrice!==12)
      throw new Error("Stock/cost changed between preview and POST");
    state.attempts.materialRevaluation={status:"POST_INTENT",at:new Date().toISOString(),endpoint:"MaterialRevaluation",
      preflightFile:path,request:report.request,requestCompany:SCENARIO.company,closingId:SCENARIO.id,version:1};
    await saveState(state);
    const startedAt=new Date().toISOString();
    const response=await sap.postRevaluation(report.request,report.simulation);
    const endedAt=new Date().toISOString();
    const posted={scenario:SCENARIO.id,startedAt,endedAt,request:report.request,
      status:response.status,response:response.ok?response.data:{code:response.errorCode,message:response.errorMessage}};
    await writeFile(POST_FILE,JSON.stringify(posted,null,2)+"\n",{mode:0o600});
    state.attempts.materialRevaluation.status=response.ok?"POSTED":"REJECTED";
    state.attempts.materialRevaluation.httpStatus=response.status;
    state.attempts.materialRevaluation.response=response.ok?
      {DocEntry:response.data?.DocEntry,DocNum:response.data?.DocNum,TransNum:response.data?.TransNum}:
      {code:response.errorCode,message:response.errorMessage};
    await saveState(state);
    if(!response.ok)throw new Error(`MaterialRevaluation rejected: HTTP ${response.status}, SAP ${response.errorCode}, ${response.errorMessage}`);
    return {path:POST_FILE,status:response.status,docEntry:response.data?.DocEntry,docNum:response.data?.DocNum,transId:response.data?.TransNum};
  } finally { await sap.close(); }
}

async function postOnce() {
  await mkdir(DIR,{recursive:true,mode:0o700});
  const path=`${DIR}/material-revaluation-post-${SCENARIO.id}.lock`;
  const lock=await open(path,"wx",0o600);
  try { return await postOnceLocked(); }
  finally { await lock.close(); await unlink(path); }
}

async function verify() {
  const state=await readState();
  if(state.attempts.materialRevaluation?.status!=="POSTED")throw new Error("No posted revaluation to verify");
  const preflight=JSON.parse(await readFile(PREVIEW_FILE,"utf8"));
  const sap=await openHomologationSession();
  try {
    const id=state.attempts.materialRevaluation.response.DocEntry;
    if(!Number.isSafeInteger(id))throw new Error("Posted revaluation key missing");
    const doc=requireOk(await sap.get(`MaterialRevaluation(${id})`),"created document");
    const matches=requireOk(await sap.get(`MaterialRevaluation?$filter=Comments eq 'FactoryOne GGF homologacao ${SCENARIO.id}'&$select=DocEntry,Comments,Reference1`),"remote closing link");
    const item=requireOk(await sap.get(`Items('${SCENARIO.item}')?$select=ItemCode,QuantityOnStock,AvgStdPrice,CostAccountingMethod,ItemWarehouseInfoCollection`),"item after");
    const journal=requireOk(await sap.get(`JournalEntries(${doc.TransNum})`),"generated journal");
    const op=requireOk(await sap.get(`ProductionOrders(${state.productionOrder.entry})?$select=AbsoluteEntry,DocumentNumber,ItemNo,ProductionOrderStatus,PlannedQuantity,CompletedQuantity`),"historical OP");
    const receipt=requireOk(await sap.get(`InventoryGenEntries(${state.receipt.entry})?$select=DocEntry,TransNum,DocumentLines`),"historical receipt");
    const issueId=/^InventoryGenExits\((\d+)\)\/0$/.exec(preflight.before.resourceIssue);
    if(!issueId)throw new Error("Historical issue reference is invalid");
    const issue=requireOk(await sap.get(`InventoryGenExits(${issueId[1]})?$select=DocEntry,TransNum,DocumentLines`),"historical resource issue");
    const wh=item.ItemWarehouseInfoCollection?.find(w=>w.WarehouseCode===SCENARIO.warehouse);
    const line=doc.MaterialRevaluationLines?.find(l=>l.ItemCode===SCENARIO.item&&l.WarehouseCode===SCENARIO.warehouse);
    const journalLines=journal.JournalEntryLines?.filter(l=>l.Debit||l.Credit).map(l=>({line:l.Line_ID,account:l.AccountCode,
      debit:l.Debit,credit:l.Credit,dimension:l.CostingCode,branch:l.BPLID,reference:l.Reference1}));
    const result={scenario:SCENARIO.id,capturedAt:new Date().toISOString(),company:SCENARIO.company,
      document:{entry:doc.DocEntry,num:doc.DocNum,date:doc.DocDate,taxDate:doc.TaxDate,series:doc.Series,
        reference:doc.Reference1,comments:doc.Comments,journalMemo:doc.JournalMemo,type:doc.RevalType,transId:doc.TransNum,
        line:line?{item:line.ItemCode,warehouse:line.WarehouseCode,oldCost:line.ActualPrice,newCost:line.Price,
          onHand:line.OnHand,revaluationAmountToStock:line.RevalAmountToStock,
          incrementAccount:line.RevaluationIncrementAccount,decrementAccount:line.RevaluationDecrementAccount}:null},
      before:preflight.before,after:{stock:wh?.InStock,cost:wh?.StandardAveragePrice,total:wh?.InStock*wh?.StandardAveragePrice,
        method:item.CostAccountingMethod},journal:{transId:journal.JdtNum,date:journal.ReferenceDate,lines:journalLines},
      historicalProduction:{opEntry:op.AbsoluteEntry,opNumber:op.DocumentNumber,status:op.ProductionOrderStatus,
        completed:op.CompletedQuantity,receiptEntry:receipt.DocEntry,receiptCost:receipt.DocumentLines?.[0]?.LineTotal,
        resourceIssueEntry:issue.DocEntry,resourceIssueCost:issue.DocumentLines?.[0]?.LineTotal},
      expectedDifference:1,
      observedDifference:wh?.InStock*wh?.StandardAveragePrice-Number(preflight.before.stockValue),
      postedAmount:line?.RevalAmountToStock,
      reference1Persisted:doc.Reference1===SCENARIO.id,
      remoteClosingMatches:Array.isArray(matches.value)?matches.value.map(x=>x.DocEntry):null,
      journalDebit:journalLines?.reduce((n,l)=>n+l.debit,0),journalCredit:journalLines?.reduce((n,l)=>n+l.credit,0)};
    result.financialReconciled=doc.RevalType==="P"&&doc.Series===25&&
      line?.Price===13&&line?.ActualPrice===12&&line?.OnHand===1&&line?.RevalAmountToStock===1&&
      item.CostAccountingMethod==="bis_MovingAverage"&&wh?.InStock===1&&wh?.StandardAveragePrice===13&&
      result.observedDifference===1&&journal.JdtNum===doc.TransNum&&result.journalDebit===1&&result.journalCredit===1&&
      journalLines?.length===2&&journalLines.some(l=>l.account===preflight.resolvedAccounts.iatInventory&&l.debit===1)&&
      journalLines.some(l=>l.account===preflight.resolvedAccounts.iatGLIncrease&&l.credit===1)&&
      op.AbsoluteEntry===state.productionOrder.entry&&op.DocumentNumber===state.productionOrder.number&&op.ItemNo===SCENARIO.item&&
      op.ProductionOrderStatus==="boposClosed"&&op.CompletedQuantity===1&&
      receipt.DocEntry===state.receipt.entry&&receipt.DocumentLines?.[0]?.LineTotal===Number(preflight.before.directCost)&&
      issue.DocEntry===Number(issueId[1])&&issue.DocumentLines?.[0]?.LineTotal===Number(preflight.before.directCost);
    result.traceReconciled=doc.Comments===`FactoryOne GGF homologacao ${SCENARIO.id}`&&
      doc.JournalMemo===doc.Comments&&matches.value?.length===1&&matches.value[0].DocEntry===id;
    result.reconciled=result.financialReconciled&&result.traceReconciled;
    await writeFile(VERIFY_FILE,JSON.stringify(result,null,2)+"\n",{mode:0o600});
    if(!result.reconciled)throw new Error(`Posted document differs from preview; inspect ${VERIFY_FILE}`);
    return {path:VERIFY_FILE,reconciled:true,document:result.document,after:result.after,journal:result.journal};
  } finally { await sap.close(); }
}

const operation=process.argv[2];
if(process.argv[1]?.endsWith("ggf-homologation-revaluation.mjs")) {
  try {
    const value=operation==="preview"?await preflight():operation==="post"?await postOnce():operation==="verify"?await verify():null;
    if(!value)throw new Error("Choose preview, post or verify");
    console.log(JSON.stringify(operation==="preview"?{path:value.path,status:value.report.simulation.status,
      before:value.report.before,payload:value.report.request}:value,null,2));
  } catch(error) { console.error(error.message);process.exitCode=1; }
}
