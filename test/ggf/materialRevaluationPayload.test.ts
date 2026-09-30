import { describe, it, expect } from "vitest";
import { simulateMaterialRevaluation, pendingPayloadEvidence, PAYLOAD_STATUS as S, type PayloadEvidence, type VerifiedValue } from "../../webapp/modules/ggf/service/MaterialRevaluationPayload";
import { previewRevaluation } from "../../webapp/modules/ggf/service/RevaluationPreview";
import { demoRevaluationInput } from "../../webapp/modules/ggf/development/revaluation";
import { DevelopmentGgfRepository } from "../../webapp/modules/ggf/development/DevelopmentGgfRepository";
import { ClosingSession } from "../../webapp/modules/ggf/service/ClosingSession";
import { demoConfiguration } from "../../webapp/modules/ggf/development/fixtures";

const v=<T>(value:T):VerifiedValue<T>=>({value,refs:["DEV-controlled-evidence"]});
async function fixture() {
  const result=(await new ClosingSession(new DevelopmentGgfRepository({getItem:()=>null,setItem:()=>{}})).calculate(demoConfiguration,{start:"2026-09-01",end:"2026-09-30",branch:"DEV-02",costCenter:""}))!;
  const p=previewRevaluation(demoRevaluationInput(result));
  const e:PayloadEvidence={...pendingPayloadEvidence(p),header:{method:v("moving-average-price-change-v1"),postingDate:v("2026-09-30"),taxDate:v("2026-09-30"),series:v(7),periodOpen:v(true),branchScope:v("DEV-02"),authorization:v(true),functionalApproval:v(true),optionalFields:v("resolved")},lines:p.scopes.map(s=>({key:s.key,branch:"DEV-02",warehouse:v(s.warehouse),currentCost:v(s.currentCost!),stock:v(s.stock!),eligibility:p.rows.filter(r=>`${r.item}/${r.warehouse}`===s.key).map(r=>({orderId:r.orderId,quantity:r.eligible!,receiptRefs:r.receipts.map(d=>`${d.document}/${d.line}`),refs:["DEV-proven-remaining"]})),accounting:{inventory:v("DEV-INVENTORY"),increment:v("DEV-INCREASE"),decrement:v("DEV-DECREASE"),determination:v("legacy"),advancedEnabled:false,activePostable:v(true)}}))};
  return {p,e};
}
describe("strict MaterialRevaluation payload simulator (no transport)",()=>{
  it("emits an exact controlled document only when every condition is proven, without recalculating",async()=>{
    const {p,e}=await fixture(),before=structuredClone(p),proof=structuredClone(e);
    e.lines[0]!.project=v("DEV-PROJECT");e.lines[0]!.dimensions=[{dimension:2,rule:v("DEV-D2")}];
    const r=simulateMaterialRevaluation(p,e);
    expect(r.status).toBe(S.ready);expect(r.postingBlocked).toBe(true);expect(r.livePostingValidated).toBe(false);
    expect(r.payload).toEqual({DocDate:"2026-09-30",TaxDate:"2026-09-30",Series:7,RevalType:"P",Comments:p.payload!.Comments,JournalMemo:p.payload!.JournalMemo,MaterialRevaluationLines:[{ItemCode:"DEV-PROD-D",WarehouseCode:"DEV-WH",Price:140,RevaluationIncrementAccount:"DEV-INCREASE",Project:"DEV-PROJECT",DistributionRule2:"DEV-D2"}]});
    expect(p).toEqual(before);expect(e.header).toEqual(proof.header);
  });
  it.each([
    [S.negative,(p:any,e:any)=>{p.rows[0].stock="-1.000000";}],
    [S.stock,(p:any,e:any)=>{p.rows[0].status="INSUFFICIENT_STOCK";}],
    [S.warehouse,(p:any,e:any)=>{e.lines[0].warehouse.refs=[];}],
    [S.cost,(p:any,e:any)=>{e.lines[0].currentCost.value="99";}],
    [S.quantity,(p:any,e:any)=>{e.lines[0].eligibility=[];}],
    [S.account,(p:any,e:any)=>{delete e.lines[0].accounting;}],
    [S.method,(p:any,e:any)=>{p.rows[0].method="bis_FIFO";}]
  ])("%s never emits payload",async(status,mutate)=>{
    const {p,e}=await fixture();mutate(p,e);const r=simulateMaterialRevaluation(p,e);expect(r.rows[0]!.status).toBe(status);expect(r.payload).toBeNull();
  });
  it.each(["bis_FIFO","bis_Standard","bis_SNB"])("does not reuse the moving average rule for %s",async method=>{
    const {p,e}=await fixture();p.rows[0]!.method=method;expect(simulateMaterialRevaluation(p,e).payload).toBeNull();
  });
  it.each(["method","postingDate","taxDate","series","periodOpen","branchScope","authorization","functionalApproval","optionalFields"])("missing header %s blocks the entire document",async key=>{
    const {p,e}=await fixture();delete (e.header as any)[key];expect(simulateMaterialRevaluation(p,e).payload).toBeNull();
  });
  it.each(["origin","company","allocationId","stockDate"] as const)("rejects mismatched %s evidence",async key=>{
    const {p,e}=await fixture();(e as any)[key]="OTHER";expect(simulateMaterialRevaluation(p,e).payload).toBeNull();
  });
  it("requires effective advanced determination, not empty item or warehouse defaults",async()=>{
    const {p,e}=await fixture();e.lines[0]!.accounting!.advancedEnabled=true;
    const r=simulateMaterialRevaluation(p,e);expect(r.status).toBe(S.account);expect(r.payload).toBeNull();
  });
  it("does not treat whitespace as a verified account",async()=>{
    const {p,e}=await fixture();e.lines[0]!.accounting!.inventory.value="   ";
    const r=simulateMaterialRevaluation(p,e);expect(r.status).toBe(S.account);expect(r.payload).toBeNull();
  });
  it("includes a verified short reference and memo in the exact controlled payload",async()=>{
    const {p,e}=await fixture();e.header!.reference1=v("F1H2609281");e.header!.memo=v("FactoryOne GGF homologacao F1H2609281");
    const r=simulateMaterialRevaluation(p,e);
    expect(r.status).toBe(S.ready);
    expect(r.payload).toMatchObject({Reference1:"F1H2609281",Comments:"FactoryOne GGF homologacao F1H2609281",JournalMemo:"FactoryOne GGF homologacao F1H2609281"});
    e.header!.reference1.value="TOO-LONG-REFERENCE";
    expect(simulateMaterialRevaluation(p,e).payload).toBeNull();
  });
  it("rejects price edits without rerunning any mathematics",async()=>{
    const {p,e}=await fixture();p.payload!.MaterialRevaluationLines[0]!.Price=141;
    expect(simulateMaterialRevaluation(p,e).globalProblems).toContain("priceMismatch");expect(simulateMaterialRevaluation(p,e).payload).toBeNull();
  });
  it("rejects counteraccount mismatch, duplicate lines and invalid dimensions",async()=>{
    const {p,e}=await fixture();e.lines[0]!.accounting!.increment.value="DIFFERENT";expect(simulateMaterialRevaluation(p,e).payload).toBeNull();
    const f=await fixture();f.p.payload!.MaterialRevaluationLines.push({...f.p.payload!.MaterialRevaluationLines[0]!});expect(simulateMaterialRevaluation(f.p,f.e).payload).toBeNull();
    const g=await fixture();g.e.lines[0]!.dimensions=[{dimension:1,rule:v("D1")},{dimension:1,rule:v("D2")}];expect(simulateMaterialRevaluation(g.p,g.e).payload).toBeNull();
  });
  it("does not convert ordinary current-stock reads to remaining-stock or accounting proof",async()=>{
    const {p}=await fixture();const pending=pendingPayloadEvidence(p);const r=simulateMaterialRevaluation(p,pending);
    expect(r.status).toBe(S.quantity);expect(r.payload).toBeNull();expect(pending.header).toBeUndefined();expect(pending.lines[0]!.accounting).toBeUndefined();
  });
  it("rejects invalid dates, unproven receipt identity and technical-only pools",async()=>{
    const {p,e}=await fixture();e.header!.postingDate.value="2026-02-30";expect(simulateMaterialRevaluation(p,e).payload).toBeNull();
    const f=await fixture();f.e.lines[0]!.eligibility[0]!.receiptRefs=["OTHER/0"];expect(simulateMaterialRevaluation(f.p,f.e).status).toBe(S.quantity);
    const g=await fixture();g.p.technicalOnly=true;expect(simulateMaterialRevaluation(g.p,g.e).payload).toBeNull();
  });
});
