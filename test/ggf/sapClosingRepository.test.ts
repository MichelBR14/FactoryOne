import { describe, expect, it } from "vitest";
import { SapGgfClosingRepository } from "../../webapp/modules/ggf/repository/SapGgfClosingRepository";
import { GGF_CLOSING_METADATA } from "../../webapp/modules/ggf/data/closingMetadata";
import { planMetadata } from "../../webapp/core/data/plan";
import { postingHash, transitionClosing, type GgfClosing } from "../../webapp/modules/ggf/service/GgfClosing";
import { ClosingIntegrityViolation } from "../../webapp/modules/ggf/service/GgfClosingIntegrity";
import { GgfPostingCoordinator } from "../../webapp/modules/ggf/service/GgfPostingCoordinator";

const draft = (): GgfClosing => ({ closingId:"CLOSE_1",companyDB:"SBODEMOBR2",periodStart:"2026-09-01",
  periodEnd:"2026-09-30",branch:"1",dimensions:{},status:"DRAFT",version:1,lineVersion:1,
  createdAt:"2026-09-28T10:00:00Z",createdBy:"tester",calculatedAt:null,postedAt:null,
  totalGgf:"0.00",totalAllocated:"0.00",totalRevalued:"0.00",
  sapMaterialRevaluationDocEntry:null,sapMaterialRevaluationDocNum:null,sapJournalTransId:null,
  postingHash:null,reopenedFrom:null,cancelledAt:null,notes:"",lastError:null,
  postingBasis:null,proposedPayload:null,lines:[] });

async function technical(base:GgfClosing,value:string):Promise<GgfClosing> {
  const line={account:"TECH-GGF",criterion:"DIRECT_COST",orderId:"212",item:"F1GGF26H01",
    warehouse:"01",basis:"12.00",percent:"100",allocated:value,costBefore:"13.00",
    costAfter:value==="1.00"?"14.00":"14.50",revaluation:value,status:"TECHNICAL_ONLY"};
  const payload={DocDate:"2026-09-28",RevalType:"P",Comments:`FactoryOne GGF ${base.closingId}`,
    MaterialRevaluationLines:[{ItemCode:line.item,WarehouseCode:line.warehouse,
      Price:Number(line.costAfter),RevaluationIncrementAccount:"5.03.01.01.04"}]};
  const postingBasis={companyDB:base.companyDB,periodStart:base.periodStart,periodEnd:base.periodEnd,
    branch:base.branch,dimensions:base.dimensions,totals:{ggf:value,allocated:value,revalued:value},
    accounts:[{account:line.account,amount:value,percent:"100",criterion:line.criterion}],
    lines:[line],inventoryAccounts:{"F1GGF26H01/01":"1.01.02.01.01"},payload};
  return {...base,totalGgf:value,totalAllocated:value,totalRevalued:value,lines:[line],
    postingBasis,proposedPayload:payload,postingHash:await postingHash(postingBasis)};
}

class FakeSap {
  rows = new Map<string,Record<string,unknown>>();
  writes: Array<{method:string;path:string}> = [];
  async get<T>(path:string):Promise<T|undefined> {
    if (path.startsWith("FBO_GGF_CLINE/$count?")) {
      const url=new URL(`https://sap.invalid/${path}`);
      const filter=url.searchParams.get("$filter")??"";
      const id=/U_ClosingId eq '([^']+)'/.exec(filter)?.[1];
      const version=/U_Version eq '([^']+)'/.exec(filter)?.[1];
      return [...this.rows.entries()].filter(([key,row])=>key.startsWith("FBO_GGF_CLINE(")&&
        row.U_ClosingId===id&&row.U_Version===version).length as T;
    }
    if (path.startsWith("FBO_GGF_CLINE?")) {
      const url=new URL(`https://sap.invalid/${path}`);
      const filter=decodeURIComponent(url.searchParams.get("$filter")??"");
      const id=/U_ClosingId eq '([^']+)'/.exec(filter)?.[1];
      const version=/U_Version eq '([^']+)'/.exec(filter)?.[1];
      return {value:[...this.rows.entries()].filter(([key,row])=>key.startsWith("FBO_GGF_CLINE(")&&
        row.U_ClosingId===id&&row.U_Version===version).map(([,row])=>row)} as T;
    }
    return this.rows.get(path) as T|undefined;
  }
  async post<T>(path:string,body:unknown):Promise<T|undefined> {
    const row=body as Record<string,unknown>;
    const key=`${path}('${row.Code}')`;
    if (this.rows.has(key)) throw new Error("duplicate SAP Code");
    this.writes.push({method:"POST",path});this.rows.set(key,structuredClone(row));return row as T;
  }
  async patch<T>(path:string,body:unknown):Promise<T|undefined> {
    const row=this.rows.get(path);if(!row)throw new Error("missing row");
    this.writes.push({method:"PATCH",path});Object.assign(row,structuredClone(body));return undefined;
  }
}

async function postedFixture() {
  const sap=new FakeSap(),repo=new SapGgfClosingRepository(sap,{
    user:"test-operator",session:"app-test-request",now:()=>"2026-09-28T15:00:00Z"});
  const first=await technical(draft(),"1.00");
  await repo.create(first);
  await repo.claim(first.closingId,first.postingHash!,1);
  const header=sap.rows.get("FBO_GGF_CLOSE('CLOSE_1')")!;
  Object.assign(header,{U_Status:"POSTED",U_Version:"3",U_PostedAt:"2026-09-28T12:00:00Z",
    U_SapDocEntry:"999001",U_SapDocNum:"999002",U_SapTransId:"999003"});
  return {sap,repo,first,header,line:sap.rows.get("FBO_GGF_CLINE('CLOSE_1.00001.0001')")!};
}

async function expectViolation(repo:SapGgfClosingRepository,field:string) {
  let violation:ClosingIntegrityViolation|undefined;
  try { await repo.get("CLOSE_1"); }
  catch(error) { if(error instanceof ClosingIntegrityViolation) violation=error; else throw error; }
  expect(violation).toBeInstanceOf(ClosingIntegrityViolation);
  expect(violation?.report.status).toBe("INTEGRITY_VIOLATION");
  expect(violation?.report.divergentFields.some(value=>value.includes(field))).toBe(true);
  expect(violation?.report.auditRecorded).toBe(true);
  expect(violation?.report).toMatchObject({closingId:"CLOSE_1",detectedAt:"2026-09-28T15:00:00Z",
    user:"test-operator",session:"app-test-request"});
  return violation!.report;
}

describe("SAP native closing repository (offline)",()=>{
  it("plans seven nondeletable UDOs and all audit fields",()=>{
    const plan=planMetadata(GGF_CLOSING_METADATA);
    expect(plan.warnings).toEqual([]);
    expect(plan.actions.filter(a=>a.kind==="createObject")).toHaveLength(7);
    expect(plan.actions.filter(a=>a.kind==="createObject").every(a=>a.body.CanDelete==="tNO")).toBe(true);
    expect(plan.actions.filter(a=>a.kind==="createObject")
      .every(a=>a.body.ApplyAuthorization==="tYES")).toBe(true);
    expect(plan.actions.some(a=>a.description.includes("U_PostingHash"))).toBe(true);
  });
  it("persists header, versioned audit rows and immutable claim by SAP Code",async()=>{
    const sap=new FakeSap(),repo=new SapGgfClosingRepository(sap);const a=await technical(draft(),"1.00");
    await repo.create(a);expect((await repo.get(a.closingId))?.lines).toEqual(a.lines);
    const b=await technical(transitionClosing(a,"CALCULATED"),"1.50");
    await repo.replace(a,b);const read=await repo.get(a.closingId);
    expect(read).toMatchObject({status:"CALCULATED",version:2,lineVersion:2,totalGgf:"1.50"});
    expect(read?.lines).toEqual(b.lines);
    expect(read?.postingHash).not.toBe(a.postingHash);
    expect(sap.rows.get("FBO_GGF_CLINE('CLOSE_1.00001.0001')")?.U_Allocated).toBe("1.00");
    expect(sap.rows.get("FBO_GGF_CLINE('CLOSE_1.00002.0001')")?.U_Allocated).toBe("1.50");
    const c=transitionClosing(read!,"VALIDATED");await repo.replace(read!,c);
    expect((await repo.get(a.closingId))?.lineVersion).toBe(2);
    await repo.claim(a.closingId,"a".repeat(64),3);
    expect(await repo.getClaim(a.closingId)).toEqual({hash:"a".repeat(64),version:3});
    await expect(repo.claim(a.closingId,"a".repeat(64),3)).rejects.toThrow("duplicate");
  });
  it("blocks an invalid status or stale version",async()=>{
    const sap=new FakeSap(),repo=new SapGgfClosingRepository(sap);const a=draft();await repo.create(a);
    const invalid={...a,version:2,status:"POSTED" as const};
    await expect(repo.replace(a,invalid)).rejects.toThrow("transition");
    const b=transitionClosing(a,"CALCULATED");await repo.replace(a,b);
    await expect(repo.replace(a,b)).rejects.toThrow("changed in SAP");
  });
  it("detects a header/line total or persisted hash mismatch on reload",async()=>{
    const sap=new FakeSap(),repo=new SapGgfClosingRepository(sap);const a=await technical(draft(),"1.00");
    await repo.create(a);
    const raw=sap.rows.get("FBO_GGF_CLOSE('CLOSE_1')")!;
    raw.U_TotalGgf="2.00";
    await expect(repo.get(a.closingId)).rejects.toThrow("totals differ");
    raw.U_TotalGgf="1.00";
    raw.U_PostingHash="f".repeat(64);
    await expect(repo.get(a.closingId)).rejects.toThrow("PostingHash differs");
  });
  it("rejects a functional edit of a simulated POSTED version; reopening preserves it",async()=>{
    const sap=new FakeSap(),repo=new SapGgfClosingRepository(sap);const a=await technical(draft(),"1.00");
    await repo.create(a);
    await repo.claim(a.closingId,a.postingHash!,1);
    const raw=sap.rows.get("FBO_GGF_CLOSE('CLOSE_1')")!;
    Object.assign(raw,{U_Status:"POSTED",U_Version:"3",U_PostedAt:"2026-09-28T12:00:00Z",
      U_SapDocEntry:"999001",U_SapDocNum:"999002",U_SapTransId:"999003"});
    const posted=(await repo.get(a.closingId))!;
    const changed=await technical(transitionClosing(posted,"REOPENED"),"1.50");
    await expect(repo.replace(posted,changed)).rejects.toThrow("POSTED version is immutable");
    const reopened=transitionClosing(posted,"REOPENED");
    await repo.replace(posted,reopened);
    expect((await repo.get(a.closingId))?.status).toBe("REOPENED");
    expect((await repo.get(a.closingId))?.postingHash).toBe(posted.postingHash);
    const reread=(await repo.get(a.closingId))!;
    expect(reread.integrityStatus).toBe("VALID");
    await expect(repo.replace(reread,transitionClosing(reread,"CALCULATED")))
      .rejects.toThrow("read-only; create a new ClosingId");
  });
  it("reports VALID for an intact POSTED and NOT_APPLICABLE for a DRAFT",async()=>{
    const sap=new FakeSap(),repo=new SapGgfClosingRepository(sap);
    await repo.create(draft());
    expect((await repo.getIntegrity("CLOSE_1"))?.status).toBe("NOT_APPLICABLE");
    const f=await postedFixture();
    expect((await f.repo.get("CLOSE_1"))?.integrityStatus).toBe("VALID");
    expect(await f.repo.getIntegrity("CLOSE_1")).toMatchObject({status:"VALID",
      closingId:"CLOSE_1",version:3,closingStatus:"POSTED",
      sapDocEntry:999001,sapDocNum:999002,sapTransId:999003,
      originalHash:f.first.postingHash,recalculatedHash:f.first.postingHash,divergentFields:[]});
  });
  it("detects a changed POSTED header and records the sanitized incident",async()=>{
    const f=await postedFixture();f.header.U_TotalGgf="2.00";
    const report=await expectViolation(f.repo,"TotalGgf");
    expect(report.originalHash).toBe(f.first.postingHash);
    expect(report).toMatchObject({closingStatus:"POSTED",sapDocEntry:999001,
      sapDocNum:999002,sapTransId:999003});
    expect([...f.sap.rows.values()].some(row=>row.U_Routine==="GGF_POSTED_INTEGRITY" &&
      String(row.U_Message).includes("TotalGgf") && !String(row.U_Message).includes("B1SESSION"))).toBe(true);
  });
  it("detects a changed POSTED audit line",async()=>{
    const f=await postedFixture();f.line.U_Allocated="2.00";
    const report=await expectViolation(f.repo,"Lines/content");
    expect(report.recalculatedHash).not.toBe(report.originalHash);
  });
  it("detects a removed POSTED audit line",async()=>{
    const f=await postedFixture();f.sap.rows.delete("FBO_GGF_CLINE('CLOSE_1.00001.0001')");
    await expectViolation(f.repo,"Lines/count");
  });
  it("detects an added POSTED audit line",async()=>{
    const f=await postedFixture();
    const code="CLOSE_1.00001.0002";
    f.sap.rows.set(`FBO_GGF_CLINE('${code}')`,{...f.line,Code:code,Name:code});
    await expectViolation(f.repo,"Lines/count");
  });
  it("detects an absent or rewritten PostingHash against the claim",async()=>{
    const f=await postedFixture();f.header.U_PostingHash=null;
    await expectViolation(f.repo,"PostingHash");
    f.header.U_PostingHash="f".repeat(64);
    await expectViolation(f.repo,"PostingHash/Claim");
  });
  it("detects a divergent version",async()=>{
    const f=await postedFixture();f.header.U_Version="1";
    await expectViolation(f.repo,"Version/Claim");
  });
  it("detects a changed audit line identity/version",async()=>{
    const f=await postedFixture();f.line.Code="CLOSE_1.00002.0001";
    await expectViolation(f.repo,"Lines/Version");
  });
  it("uses the independent claim when the header and its stored hash are both rewritten",async()=>{
    const f=await postedFixture();
    const altered=await technical(draft(),"1.50");
    Object.assign(f.header,{U_PostingBasis:JSON.stringify(altered.postingBasis),
      U_ProposedPayload:JSON.stringify(altered.proposedPayload),U_TotalGgf:"1.50",
      U_TotalAllocated:"1.50",U_TotalRevalued:"1.50",U_PostingHash:altered.postingHash});
    Object.assign(f.line,{U_Allocated:"1.50",U_CostAfter:"14.50",U_Revaluation:"1.50"});
    const report=await expectViolation(f.repo,"PostingHash/Claim");
    expect(report.recalculatedHash).toBe(altered.postingHash);
    expect(report.originalHash).toBe(f.first.postingHash);
  });
  it("detects a direct status change that leaves a posted SAP link",async()=>{
    const f=await postedFixture();f.header.U_Status="DRAFT";
    await expectViolation(f.repo,"Status/PostedLink");
  });
  it("does not let a direct REOPENED status hide altered posted content",async()=>{
    const f=await postedFixture();f.header.U_Status="REOPENED";f.line.U_Allocated="2.00";
    await expectViolation(f.repo,"Lines/content");
  });
  it("remains blocked if the SAP audit log cannot be written",async()=>{
    const f=await postedFixture();f.line.U_Allocated="2.00";
    const client={get:f.sap.get.bind(f.sap),patch:f.sap.patch.bind(f.sap),
      post:async <T>(path:string,body:unknown):Promise<T|undefined>=>{
        if(path==="FBO_LOG")throw new Error("audit unavailable");
        return f.sap.post<T>(path,body);
      }};
    const repo=new SapGgfClosingRepository(client);
    await expect(repo.get("CLOSE_1")).rejects.toMatchObject({
      report:{status:"INTEGRITY_VIOLATION",auditRecorded:false}
    });
  });
  it("blocks posting, payload preparation and reopening after a violation",async()=>{
    const f=await postedFixture();f.line.U_Allocated="2.00";
    let gatewayCalls=0;
    const coordinator=new GgfPostingCoordinator(f.repo,{post:async()=>{gatewayCalls++;throw Error("forbidden");},
      find:async()=>{gatewayCalls++;return [];}},{assertAvailable:async()=>{}});
    await expect(coordinator.post("CLOSE_1",f.first.postingBasis!)).rejects.toBeInstanceOf(ClosingIntegrityViolation);
    await expect(coordinator.prepareReady("CLOSE_1",f.first.postingBasis!)).rejects.toBeInstanceOf(ClosingIntegrityViolation);
    const forged={...f.first,status:"POSTED" as const,version:3,
      sapMaterialRevaluationDocEntry:999001,sapMaterialRevaluationDocNum:999002,
      sapJournalTransId:999003,postedAt:"2026-09-28T12:00:00Z"};
    await expect(f.repo.replace(forged,transitionClosing(forged,"REOPENED")))
      .rejects.toBeInstanceOf(ClosingIntegrityViolation);
    expect(gatewayCalls).toBe(0);
    expect(f.sap.writes.some(write=>write.method==="PATCH"&&write.path.includes("CLOSE_1"))).toBe(false);
  });
});
