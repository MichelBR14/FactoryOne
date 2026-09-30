import { describe, it, expect } from "vitest";
import { previewRevaluation, type RevaluationInput } from "../../webapp/modules/ggf/service/RevaluationPreview";
import { exportRevaluationCsv } from "../../webapp/modules/ggf/service/revaluationExport";

export function previewFixture(): RevaluationInput {
  return { origin:"development", company:"DEVELOPMENT", allocationId:"TEST", allocationDate:"2026-09-20T00:00:00Z", stockDate:"2026-09-28T00:00:00Z",
    technicalOnly:false, sourceRefs:["TEST-ONLY"], policy:{perpetual:true,costScope:"warehouse",functionalApproved:true,stockTreatment:"spread-over-current-stock",postingDate:"2026-09-30",incrementAccount:"TEST-INC",decrementAccount:"TEST-DEC",accountsVerified:true},
    items:[{code:"TEST-A",name:"Test product",unit:"UN",method:"bis_MovingAverage",inventory:true,serial:false,batch:false,totalStock:"4",globalCost:"99",warehouses:[{code:"01",stock:"4",cost:"10",locked:false}]}],
    orders:[{id:"1",number:"1",item:"TEST-A",planned:"2",produced:"2",unit:"UN",allocatedMinor:"301",accounts:[{account:"TEST-GGF",name:"Test expense",amountMinor:"301"}],
      components:[{kind:"material",code:"M",amount:"12.00",sourceRefs:["TEST-ISSUE/0"]},{kind:"resource",code:"R",amount:"4.00",sourceRefs:["TEST-ISSUE/1"]}],
      receipts:[{document:"TEST-RECEIPT",line:0,date:"2026-09-20",warehouse:"01",quantity:"2",unit:"UN"}],
      remaining:[{warehouse:"01",quantity:"2",evidence:"TEST proven remaining"}],inconsistencies:[]}]
  };
}
describe("read-only revaluation proposal, independent of allocation engine",()=>{
  it("distinguishes historical OP cost, warehouse cost and whole-stock document price",()=>{
    const input=previewFixture(), before=structuredClone(input), p=previewRevaluation(input), r=p.rows[0]!;
    expect(input).toEqual(before);
    expect(r).toMatchObject({status:"READY",materials:"12.00",resources:"4.00",original:"16.00",historicalUnitCost:"8.000000",currentCost:"10.000000",unitGgf:"1.505000",adjustedCost:"11.505000",estimated:"3.01",naivePriceChangeImpact:"6.02",adjustedHistoricalTotal:"19.01"});
    expect(p.payload?.MaterialRevaluationLines).toEqual([{ItemCode:"TEST-A",WarehouseCode:"01",Price:10.7525,RevaluationIncrementAccount:"TEST-INC"}]);
    expect(p).toMatchObject({postingBlocked:true,estimatedTotal:"3.01",payloadReady:true});
    expect(JSON.parse(JSON.stringify(p)).rows).toHaveLength(1);
  });
  it.each([
    ["no remaining proof",(i:RevaluationInput)=>{i.orders[0]!.remaining=[];},"MISSING_DATA","remainingUnproven"],
    ["negative stock",(i:RevaluationInput)=>{i.items[0]!.warehouses[0]!.stock="-1";},"NEGATIVE_STOCK","negativeStock"],
    ["no stock",(i:RevaluationInput)=>{i.items[0]!.warehouses[0]!.stock="0";},"NO_STOCK","noStock"],
    ["insufficient stock",(i:RevaluationInput)=>{i.items[0]!.warehouses[0]!.stock="1";},"INSUFFICIENT_STOCK","insufficientStock"],
    ["unknown cost",(i:RevaluationInput)=>{i.items[0]!.warehouses[0]!.cost=null;},"MISSING_DATA","missingCostOrSource"],
    ["unknown scope",(i:RevaluationInput)=>{i.policy.costScope=null;},"MISSING_DATA","missingCostOrSource"],
    ["unknown remaining policy",(i:RevaluationInput)=>{i.policy.stockTreatment=null;},"MISSING_DATA","stockTreatmentPending"],
    ["technical account",(i:RevaluationInput)=>{i.technicalOnly=true;},"MISSING_DATA","functionalPending"],
    ["unverified accounts",(i:RevaluationInput)=>{i.policy.accountsVerified=false;},"MISSING_DATA","accountsPending"],
    ["no posting date",(i:RevaluationInput)=>{i.policy.postingDate=null;},"MISSING_DATA","postingDatePending"],
    ["invalid posting date",(i:RevaluationInput)=>{i.policy.postingDate="2026-02-30";},"MISSING_DATA","postingDatePending"],
    ["different units",(i:RevaluationInput)=>{i.items[0]!.unit="KG";},"MISSING_DATA","missingCostOrSource"],
    ["receipt mismatch",(i:RevaluationInput)=>{i.orders[0]!.receipts[0]!.quantity="1";},"INCONSISTENT","originMismatch"],
    ["GGF mismatch",(i:RevaluationInput)=>{i.orders[0]!.allocatedMinor="300";},"INCONSISTENT","originMismatch"],
    ["unrecognized cost component",(i:RevaluationInput)=>{i.orders[0]!.components[0]!.kind="unknown";},"INCONSISTENT","originMismatch"],
    ["zero production",(i:RevaluationInput)=>{i.orders[0]!.produced="0";},"INCONSISTENT","originMismatch"],
    ["locked warehouse",(i:RevaluationInput)=>{i.items[0]!.warehouses[0]!.locked=true;},"INCONSISTENT","lockedWarehouse"]
  ])("blocks %s",(_,mutate,status,reason)=>{
    const i=previewFixture(); mutate(i); const p=previewRevaluation(i);
    expect(p.rows[0]!.status).toBe(status); expect(p.rows[0]!.reasons).toContain(reason);
    expect(p.payload).toBeNull(); expect(p.estimatedTotal).toBeNull(); expect(p.postingBlocked).toBe(true);
  });
  it.each(["bis_FIFO","bis_Standard","bis_SNB"])("blocks %s without a guessed price", method=>{
    const i=previewFixture(); i.items[0]!.method=method;
    const p=previewRevaluation(i); expect(p.rows[0]!.status).toBe("SPECIFIC_METHOD"); expect(p.payload).toBeNull();
  });
  it.each(["serial","batch"] as const)("blocks tracked %s",flag=>{
    const i=previewFixture(); i.items[0]![flag]=true; expect(previewRevaluation(i).payload).toBeNull();
  });
  it("does not treat warehouse quantity management as valuation scope",()=>{
    const i=previewFixture(); i.policy.costScope="company"; const p=previewRevaluation(i);
    expect(p.rows[0]!.currentCost).toBe("99.000000"); expect(p.rows[0]!.naivePriceChangeImpact).toBeNull(); expect(p.rows[0]!.reasons).toContain("companyScope"); expect(p.payload).toBeNull();
  });
  it("groups multiple OPs into one price without double-consuming shared stock",()=>{
    const i=previewFixture(); const o=structuredClone(i.orders[0]!); o.id="2";o.number="2";o.receipts[0]!.document="SECOND"; i.orders.push(o);
    const p=previewRevaluation(i); expect(p.payload?.MaterialRevaluationLines).toHaveLength(1); expect(p.estimatedTotal).toBe("6.02");
    expect(p.payload!.MaterialRevaluationLines[0]!.Price).toBe(11.505);
    i.items[0]!.warehouses[0]!.stock="3";
    const blocked=previewRevaluation(i); expect(blocked.rows.every(r=>r.status==="INSUFFICIENT_STOCK")).toBe(true);expect(blocked.payload).toBeNull();
  });
  it("does not manufacture attribution from stock and production",()=>{
    const i=previewFixture(); i.orders[0]!.remaining=[]; const p=previewRevaluation(i);
    expect(p.rows[0]).toMatchObject({eligible:null,estimated:null});
  });
  it("uses exact GGF fraction for partial remaining stock",()=>{
    const i=previewFixture();i.orders[0]!.remaining[0]!.quantity="1";const p=previewRevaluation(i);
    expect(p.rows[0]!.estimated).toBe("1.51");expect(p.scopes[0]!.targetPrice).toBe("10.377500");
  });
  it("handles negative GGF without changing sign and uses decrement account",()=>{
    const i=previewFixture();i.orders[0]!.allocatedMinor="-301";i.orders[0]!.accounts[0]!.amountMinor="-301";
    const p=previewRevaluation(i);expect(p.estimatedTotal).toBe("-3.01");
    expect(p.payload?.MaterialRevaluationLines[0]).toMatchObject({Price:9.2475,RevaluationDecrementAccount:"TEST-DEC"});
  });
  it("blocks a six-decimal price that cannot represent a cent effect",()=>{
    const i=previewFixture(); i.items[0]!.warehouses[0]!.stock="100000000";
    const p=previewRevaluation(i);expect(p.payload).toBeNull();expect(p.rows[0]!.reasons).toContain("payloadPrecision");
  });
  it("rejects duplicate identities and source mixing",()=>{
    const i=previewFixture();i.orders.push(structuredClone(i.orders[0]!));expect(()=>previewRevaluation(i)).toThrow();
    const s=previewFixture();s.origin="sap";expect(()=>previewRevaluation(s)).toThrow("mismatch");
  });
  it("exports provenance, missing eligibility and neutralizes spreadsheet formulas",()=>{
    const i=previewFixture();i.items[0]!.name="=MALICIOUS";i.orders[0]!.remaining=[];
    const csv=exportRevaluationCsv(previewRevaluation(i));expect(csv).toContain("'=MALICIOUS");expect(csv).toContain('"UNAVAILABLE"');expect(csv).toContain('"postingBlocked";"true"');
  });
});
