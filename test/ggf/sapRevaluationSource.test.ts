import { describe, it, expect } from "vitest";
import { readRevaluationInput } from "../../webapp/modules/ggf/repository/SapRevaluationSource";
import { previewRevaluation } from "../../webapp/modules/ggf/service/RevaluationPreview";
import { demoRevaluationInput } from "../../webapp/modules/ggf/development/revaluation";
import { DevelopmentGgfRepository } from "../../webapp/modules/ggf/development/DevelopmentGgfRepository";
import { demoConfiguration } from "../../webapp/modules/ggf/development/fixtures";
import { ClosingSession } from "../../webapp/modules/ggf/service/ClosingSession";
import type { AllocationResult } from "../../webapp/modules/ggf/engine/types";

async function fixture() {
  const repo=new DevelopmentGgfRepository({getItem:()=>null,setItem:()=>{}});
  const result=(await new ClosingSession(repo).calculate(demoConfiguration,{start:"2026-09-01",end:"2026-09-30",branch:"DEV-02",costCenter:""}))!;
  const demo=structuredClone(result);
  result.snapshot.origin="sap";result.orders[0]!.order.id="1";result.orders[0]!.order.item="TEST-A";
  result.orders[0]!.order.sourceRefs=["InventoryGenEntries(10)/0"];
  result.orders[0]!.order.directCostComponents=result.orders[0]!.order.directCostComponents!.map(c=>({...c,kind:c.kind==="DEVELOPMENT_MATERIAL"?"dit_Item":"dit_Resource"}));
  result.traces.forEach(t=>{t.orderId="1";});
  const data:Record<string,any>={
    CompanyService_GetAdminInfo:{ContinuousStockManagement:"tYES",PriceSystem:"tYES",LocalCurrency:"R$"},
    "Items('TEST-A')":{ItemCode:"TEST-A",ItemName:"Test product",InventoryItem:"tYES",InventoryUOM:"UN",CostAccountingMethod:"bis_MovingAverage",ManageSerialNumbers:"tNO",ManageBatchNumbers:"tNO",QuantityOnStock:20,AvgStdPrice:99,
      ItemWarehouseInfoCollection:[{WarehouseCode:"01",InStock:20,StandardAveragePrice:10,Locked:"tNO"}]},
    "ProductionOrders(1)":{AbsoluteEntry:1,DocumentNumber:201,ItemNo:"TEST-A",PlannedQuantity:10,CompletedQuantity:10,InventoryUOM:"UN",ProductionOrderStatus:"boposClosed"},
    "InventoryGenEntries(10)":{DocEntry:10,DocNum:10,DocDate:"2026-09-20",DocCurrency:"R$",Cancelled:"tNO",CancelStatus:"csNo",DocumentLines:[{LineNum:0,BaseType:202,BaseEntry:1,ItemCode:"TEST-A",TransactionType:"botrntComplete",UseBaseUnits:"tYES",InventoryQuantity:10,Quantity:10,MeasureUnit:"UN",WarehouseCode:"01"}]}
  };
  const paths:string[]=[];
  const client={async get(path:string){paths.push(path);return structuredClone(data[path.split("?")[0]!]);}};
  return {result,demo,data,paths,client};
}
describe("targeted SAP revaluation read",()=>{
  it("extracts actual valuation scope and warehouse cost without inferring OP remaining stock",async()=>{
    const f=await fixture(), input=await readRevaluationInput(f.client,f.result,true);
    expect(input.policy).toMatchObject({costScope:"warehouse",functionalApproved:false,accountsVerified:false,postingDate:null,stockTreatment:null});
    expect(input.orders[0]!.remaining).toEqual([]);expect(input.orders[0]!.inconsistencies).toEqual([]);
    const p=previewRevaluation(input);expect(p.rows[0]).toMatchObject({currentCost:"10.000000",stock:"20.000000",produced:"10.000000",eligible:null,status:"MISSING_DATA"});
    expect(p.payload).toBeNull();expect(f.paths).toHaveLength(8);
    expect(f.paths.every(p=>/^(Items|ProductionOrders|InventoryGenEntries|CompanyService_GetAdminInfo)/.test(p))).toBe(true);
  });
  it("supports company cost as a distinct blocked scope",async()=>{
    const f=await fixture();f.data.CompanyService_GetAdminInfo.PriceSystem="tNO";
    const p=previewRevaluation(await readRevaluationInput(f.client,f.result,true));expect(p.rows[0]!.currentCost).toBe("99.000000");expect(p.rows[0]!.reasons).toContain("companyScope");
  });
  it.each(["stock","pagination","duplicates","flag","currency"])("rejects incomplete %s evidence",async kind=>{
    const f=await fixture(),item=f.data["Items('TEST-A')"];
    if(kind==="stock")item.QuantityOnStock=999;
    if(kind==="pagination")item["ItemWarehouseInfoCollection@odata.nextLink"]="more";
    if(kind==="duplicates")item.ItemWarehouseInfoCollection.push({...item.ItemWarehouseInfoCollection[0]});
    if(kind==="flag")item.ManageSerialNumbers=null;
    if(kind==="currency")f.data.CompanyService_GetAdminInfo.LocalCurrency="USD";
    await expect(readRevaluationInput(f.client,f.result,true)).rejects.toThrow();
  });
  it("rejects stock or policy changing between reads",async()=>{
    const f=await fixture();let hits=0;
    const client={async get(p:string){const r=await f.client.get(p);if(p.startsWith("Items") && ++hits===2) r.ItemWarehouseInfoCollection[0].StandardAveragePrice=11;return r;}};
    await expect(readRevaluationInput(client,f.result,true)).rejects.toThrow("changed during");
  });
  it.each(["BaseEntry","MeasureUnit","TransactionType","InventoryQuantity"])("blocks changed receipt %s",async field=>{
    const f=await fixture();f.data["InventoryGenEntries(10)"].DocumentLines[0][field]="invalid";
    const p=previewRevaluation(await readRevaluationInput(f.client,f.result,true));expect(p.rows[0]!.status).toBe("INCONSISTENT");expect(p.payload).toBeNull();
  });
  it("rejects unreconciled or fictional allocation at SAP boundary",async()=>{
    const f=await fixture();await expect(readRevaluationInput(f.client,f.demo,true)).rejects.toThrow("Unreconciled");
    f.result.difference=1n;await expect(readRevaluationInput(f.client,f.result,true)).rejects.toThrow("Unreconciled");expect(f.paths).toEqual([]);
  });
  it("keeps controlled simulation isolated and ready without altering allocation",async()=>{
    const f=await fixture();const before=structuredClone(f.demo),p=previewRevaluation(demoRevaluationInput(f.demo));
    expect(p.origin).toBe("development");expect(p.payloadReady).toBe(true);expect(p.postingBlocked).toBe(true);expect(f.demo).toEqual(before);
    expect(()=>demoRevaluationInput(f.result as AllocationResult)).toThrow("fictional allocation");
  });
});
