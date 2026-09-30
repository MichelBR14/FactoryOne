import { describe, expect, it, vi } from "vitest";
import { readTechnicalFifoPreview } from "../../scripts/ggf-fifo-preview-read.mjs";
import { previewFifoProduction } from "../../webapp/modules/ggf/service/FifoProductionTrace";
import { splitStockAndConsumed } from "../../webapp/modules/ggf/service/StockConsumptionSplit";

function fixture(issueQty=6) {
  const data:Record<string,unknown>={
    "ProductionOrders(214)":{AbsoluteEntry:214,DocumentNumber:83,ItemNo:"F1GGF26P01",CompletedQuantity:10},
    "InventoryGenEntries(122)":{DocEntry:122,DocNum:77,DocDate:"2026-09-29",Cancelled:"tNO",
      DocumentLines:[{BaseType:202,BaseEntry:214,ItemCode:"F1GGF26P01",LineNum:0,InventoryQuantity:10,WarehouseCode:"01"}]},
    "InventoryGenExits(90)":{DocEntry:90,DocNum:40,DocDate:"2026-09-29",Cancelled:"tNO",
      DocumentLines:[{ItemCode:"F1GGF26P01",LineNum:0,InventoryQuantity:issueQty,WarehouseCode:"01"}]},
    "Items('F1GGF26P01')?$select=ItemCode,ItemName,CostAccountingMethod,InventoryUOM,QuantityOnStock,ItemWarehouseInfoCollection":{
      ItemCode:"F1GGF26P01",ItemName:"Technical FIFO",CostAccountingMethod:"bis_FIFO",InventoryUOM:"UN",
      QuantityOnStock:4,ItemWarehouseInfoCollection:[{WarehouseCode:"01",InStock:4}]}
  };
  const session={get:vi.fn(async(path:string)=>({ok:true,status:200,data:data[path]})),
    readFifoLayers:vi.fn(async()=>({ok:true,status:200,data:{Layers:[{
      TransactionSequenceNum:2792,LayerID:0,DocNumber:"77",DocType:"ttGeneralReceiptToStock",
      OpenQty:4,CurrentCost:12}]}}))};
  return session;
}

describe("SAP technical FIFO preview read",()=>{
  it("publishes a separate technical-only trace after all live reads reconcile",async()=>{
    const session=fixture();
    const result=await readTechnicalFifoPreview(session,previewFifoProduction,splitStockAndConsumed);
    expect(result).toMatchObject({origin:"sap",technicalOnly:true,order:"83",item:"F1GGF26P01",
      produced:"10.000000",consumed:"6.000000",remaining:"4.000000",status:"FIFO_PARTIALLY_CONSUMED",
      example:{stockMinor:"4000",consumedMinor:"6000",
        consumedStatus:"FIFO_CONSUMED_GGF_PENDING_ACCOUNTING_RULE"},
      calculation:{status:"STOCK_REVALUATION_CANDIDATE",totalStockCents:"4000",
        totalConsumedCents:"6000",payload:null}});
    expect(session.readFifoLayers).toHaveBeenCalledWith("F1GGF26P01","01");
  });
  it("refuses a changed issue instead of presenting stale quantities",async()=>{
    await expect(readTechnicalFifoPreview(fixture(5),previewFifoProduction,splitStockAndConsumed)).rejects.toThrow("changed");
  });
});
