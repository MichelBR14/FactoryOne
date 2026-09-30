const ensure=(condition,message)=>{if(!condition)throw new Error(message);};
async function read(session,path,label) {
  const response=await session.get(path);
  ensure(response.ok,`${label}: SAP read HTTP ${response.status}`);
  return response.data;
}

/** Dedicated technical scenario; never merged into a functional GGF allocation. */
export async function readTechnicalFifoPreview(session,previewFifoProduction,splitStockAndConsumed) {
  const [order,receipt,issue,item,fifo]=await Promise.all([
    read(session,"ProductionOrders(214)","technical OP"),
    read(session,"InventoryGenEntries(122)","production receipt"),
    read(session,"InventoryGenExits(90)","goods issue"),
    read(session,"Items('F1GGF26P01')?$select=ItemCode,ItemName,CostAccountingMethod,InventoryUOM,QuantityOnStock,ItemWarehouseInfoCollection","FIFO item"),
    session.readFifoLayers("F1GGF26P01","01")
  ]);
  ensure(fifo.ok,"FIFO layer read failed");
  const receiptLine=receipt.DocumentLines?.[0],issueLine=issue.DocumentLines?.[0];
  const layer=fifo.data.Layers.filter(row=>row.TransactionSequenceNum===2792&&row.LayerID===0);
  ensure(order.AbsoluteEntry===214&&order.DocumentNumber===83&&order.ItemNo==="F1GGF26P01"&&
    order.CompletedQuantity===10&&receipt.DocEntry===122&&receipt.DocNum===77&&receipt.Cancelled==="tNO"&&
    receiptLine?.BaseType===202&&receiptLine.BaseEntry===214&&receiptLine.InventoryQuantity===10&&
    receiptLine.ItemCode==="F1GGF26P01"&&receiptLine.LineNum===0&&
    receiptLine.WarehouseCode==="01"&&issue.DocEntry===90&&issue.DocNum===40&&issue.Cancelled==="tNO"&&
    issueLine?.InventoryQuantity===6&&issueLine.ItemCode==="F1GGF26P01"&&issueLine.LineNum===0&&
    issueLine.WarehouseCode==="01"&&
    item.CostAccountingMethod==="bis_FIFO"&&item.InventoryUOM==="UN"&&
    item.QuantityOnStock===4&&item.ItemWarehouseInfoCollection?.find(row=>row.WarehouseCode==="01")?.InStock===4&&
    layer.length===1,"Technical FIFO scenario changed; no stale trace published");
  const source=layer[0];
  const lineage={closingId:null,orderDocEntry:214,receiptDocEntry:122,receiptLine:0,
    receiptDocNum:77,item:"F1GGF26P01",warehouse:"01",
    originalLayer:{transactionSequenceNum:2792,layerId:0},remainingQuantity:String(source.OpenQty),
    revaluationDocEntry:null,revaluationDocNum:null,resultLayer:null};
  const preview=previewFifoProduction({lineage,producedQuantity:"10",receiptQuantity:"10",
    unit:"UN",ggFMinor:"10000",independentlyIssuedQuantity:"6",
    layers:[{transactionSequenceNum:source.TransactionSequenceNum,layerId:source.LayerID,
      docNumber:String(source.DocNumber),docType:source.DocType,item:"F1GGF26P01",warehouse:"01",
      openQuantity:String(source.OpenQty),currentCost:String(source.CurrentCost)}]});
  const split=splitStockAndConsumed({valuationMethod:item.CostAccountingMethod,proof:"FIFO_LAYER_RECONCILED",
    producedQuantity:preview.producedQuantity,consumedQuantity:preview.consumedQuantity,
    remainingQuantity:preview.openQuantity,unit:item.InventoryUOM,warehouse:"01",negativeStock:false,
    modAdjustmentCents:"0",ggfAdjustmentCents:"10000"});
  ensure(preview.status==="FIFO_PARTIALLY_CONSUMED"&&preview.inventoryGgfMinor==="4000"&&
    preview.consumedGgfMinor==="6000"&&preview.payload===null&&
    split.status==="STOCK_REVALUATION_CANDIDATE"&&split.totalStockCents==="4000"&&
    split.totalConsumedCents==="6000"&&split.payload===null,"Technical FIFO preview changed");
  return {origin:"sap",technicalOnly:true,scenario:"F1FOP2609291",capturedAt:new Date().toISOString(),
    order:"83",item:item.ItemCode,itemName:item.ItemName,warehouse:"01",unit:"UN",valuationMethod:item.CostAccountingMethod,
    produced:preview.producedQuantity,originalLayerQuantity:"10",consumed:preview.consumedQuantity,
    remaining:preview.openQuantity,status:preview.status,receipt:{docEntry:122,docNum:77,line:0,
      date:receipt.DocDate,quantity:receiptLine.InventoryQuantity},
    layer:{label:"Camada do recebimento 77",sequence:source.TransactionSequenceNum,id:source.LayerID,
      openQty:source.OpenQty,cost:source.CurrentCost},
    issues:[{docEntry:90,docNum:40,line:issueLine.LineNum,date:issue.DocDate,quantity:issueLine.InventoryQuantity}],
    example:{label:"Exemplo técnico, não é GGF funcional",ggfTotalMinor:"10000",
      ggfUnitMinor:preview.ggFUnitMinor,stockMinor:preview.inventoryGgfMinor,
      consumedMinor:preview.consumedGgfMinor,stockStatus:preview.stockDisposition,
      consumedStatus:preview.consumedDisposition},calculation:split,payload:null};
}
