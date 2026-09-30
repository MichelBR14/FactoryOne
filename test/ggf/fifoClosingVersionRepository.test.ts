import { describe, expect, it } from "vitest";
import { SapGgfClosingVersionRepository, SapMetadataUnavailableError } from "../../webapp/modules/ggf/repository/SapGgfClosingVersionRepository";
import { ServiceLayerError } from "../../webapp/core/service/errors";
import { postingHash, type GgfClosing, type PostingBasis } from "../../webapp/modules/ggf/service/GgfClosing";

const id="F1HL260929F";
function basis(version:number,status:"FIFO_PARTIALLY_CONSUMED"|"FIFO_TRACE_AMBIGUOUS"):PostingBasis {
  const line={account:"TECH-NOT-GGF",criterion:"FIFO_TRACE",orderId:"83",item:"F1GGF26P01",
    warehouse:"01",basis:"10",percent:"0",allocated:"0.00",costBefore:"12.00",
    costAfter:"12.00",revaluation:"0.00",status:"TECHNICAL_ONLY"};
  return {companyDB:"SBODEMOBR2",periodStart:"2026-09-01",periodEnd:"2026-09-30",branch:"1",
    dimensions:{},totals:{ggf:"0.00",allocated:"0.00",revalued:"0.00"},
    accounts:[{account:"TECH-NOT-GGF",amount:"0.00",percent:"0",criterion:"FIFO_TRACE"}],
    lines:[line],inventoryAccounts:{},payload:{technicalOnly:true,MaterialRevaluationLines:[]},
    fifoLineage:[{closingId:id,version,productionOrderDocEntry:214,productionOrderDocNum:83,
      receiptDocEntry:122,receiptDocNum:77,receiptLine:0,itemCode:"F1GGF26P01",warehouseCode:"01",
      originalProducedQuantity:"10",originalLayerId:{transactionSequenceNum:2792,layerId:0},
      originalLayerQuantity:"10",originalLayerCost:"12",remainingLayerQuantity:"4",consumedQuantity:"6",
      remainingLayerValue:"48",traceStatus:status,traceTimestamp:"2026-09-29T12:00:00Z",
      revaluationDocEntry:null,revaluationDocNum:null,resultLayerId:null,resultLayerQuantity:null,resultLayerCost:null}]};
}
async function closing(version:number,status:"FIFO_PARTIALLY_CONSUMED"|"FIFO_TRACE_AMBIGUOUS"):Promise<GgfClosing> {
  const b=basis(version,status);
  return {closingId:id,companyDB:"SBODEMOBR2",periodStart:b.periodStart,periodEnd:b.periodEnd,
    branch:"1",dimensions:{},status:version===1?"DRAFT":"CALCULATED",version,lineVersion:version,
    createdAt:"2026-09-29T12:00:00Z",createdBy:"technical test",calculatedAt:version===1?null:"2026-09-29T12:01:00Z",
    postedAt:null,totalGgf:"0.00",totalAllocated:"0.00",totalRevalued:"0.00",
    sapMaterialRevaluationDocEntry:null,sapMaterialRevaluationDocNum:null,sapJournalTransId:null,
    postingHash:await postingHash(b),reopenedFrom:null,cancelledAt:null,notes:"TECHNICAL_ONLY",lastError:null,
    postingBasis:b,proposedPayload:b.payload,lines:b.lines};
}
class FakeSap {
  snapshots=new Map<string,Record<string,unknown>>();
  lines=new Map<string,Record<string,unknown>>();
  async get<T>(path:string):Promise<T|undefined> {
    if(path==="FBO_GGF_CVERS/$count") return this.snapshots.size as T;
    if(path.startsWith("FBO_GGF_CVERS(")) return this.snapshots.get(path) as T|undefined;
    const version=/U_Version eq '([^']+)'/.exec(decodeURIComponent(path))?.[1];
    const rows=[...this.lines.values()].filter(row=>row.U_Version===version);
    if(path.startsWith("FBO_GGF_CLINE/$count")) return rows.length as T;
    if(path.startsWith("FBO_GGF_CLINE?")) return {value:rows} as T;
    throw new Error("Unexpected GET");
  }
  async post<T>(path:string,body:unknown):Promise<T|undefined> {
    if(path!=="FBO_GGF_CVERS")throw new Error("Unexpected POST");
    const row=body as Record<string,unknown>,key=`FBO_GGF_CVERS('${row.Code}')`;
    if(this.snapshots.has(key))throw new Error("duplicate");
    this.snapshots.set(key,structuredClone(row));return row as T;
  }
  async patch<T>():Promise<T|undefined> {throw new Error("Archive cannot be patched");}
  addLine(c:GgfClosing) {
    const line=c.lines[0]!;
    const code=`${id}.${String(c.lineVersion).padStart(5,"0")}.0001`;
    this.lines.set(code,{Code:code,U_ClosingId:id,U_Version:String(c.lineVersion),
      U_Account:line.account,U_Criterion:line.criterion,U_OrderId:line.orderId,U_Item:line.item,
      U_Warehouse:line.warehouse,U_Basis:line.basis,U_Percent:line.percent,U_Allocated:line.allocated,
      U_CostBefore:line.costBefore,U_CostAfter:line.costAfter,U_Revaluation:line.revaluation,U_Status:line.status});
  }
}

describe("FIFO closing version archive",()=>{
  it("blocks metadata failure without treating the UDO as absent or writing",async()=>{
    const sap=new FakeSap(),repo=new SapGgfClosingVersionRepository({
      ...sap,
      get:async()=>{throw new ServiceLayerError("Service Not Found",400,-1002);},
      post:async()=>{throw new Error("Unexpected POST");},
      patch:async()=>{throw new Error("Unexpected PATCH");}
    });
    await expect(repo.assertAvailable()).rejects.toBeInstanceOf(SapMetadataUnavailableError);
    await expect(repo.get(id,1)).rejects.toMatchObject({code:"SAP_METADATA_UNAVAILABLE"});
    expect(sap.snapshots.size).toBe(0);
  });
  it("proves entity availability independently of an existing version",async()=>{
    const repo=new SapGgfClosingVersionRepository(new FakeSap());
    await expect(repo.assertAvailable()).resolves.toBeUndefined();
  });
  it("persists both posting bases and independent audit-line versions without a business POST",async()=>{
    const sap=new FakeSap(),repo=new SapGgfClosingVersionRepository(sap);
    const first=await closing(1,"FIFO_PARTIALLY_CONSUMED"),second=await closing(2,"FIFO_TRACE_AMBIGUOUS");
    sap.addLine(first);sap.addLine(second);
    expect((await repo.create(first,true)).postingHash).toBe(first.postingHash);
    expect((await repo.create(second,true)).postingHash).toBe(second.postingHash);
    expect((await repo.get(id,1))?.postingBasis.fifoLineage?.[0]?.traceStatus).toBe("FIFO_PARTIALLY_CONSUMED");
    expect((await repo.get(id,2))?.postingBasis.fifoLineage?.[0]?.traceStatus).toBe("FIFO_TRACE_AMBIGUOUS");
    expect(first.postingHash).not.toBe(second.postingHash);
    expect(sap.snapshots.size).toBe(2);
    await expect(repo.create(first,true)).rejects.toThrow("already archived");
  });
  it("detects changed historical basis and a removed line",async()=>{
    const sap=new FakeSap(),repo=new SapGgfClosingVersionRepository(sap),first=await closing(1,"FIFO_PARTIALLY_CONSUMED");
    sap.addLine(first);await repo.create(first,true);
    const row=sap.snapshots.get(`FBO_GGF_CVERS('${id}.00001')`)!;
    const basis=JSON.parse(String(row.U_PostingBasis));basis.fifoLineage[0].traceStatus="FIFO_TRACE_AMBIGUOUS";
    row.U_PostingBasis=JSON.stringify(basis);
    await expect(repo.get(id,1)).rejects.toThrow("hash or identity differs");
    row.U_PostingBasis=JSON.stringify(first.postingBasis);
    sap.lines.clear();
    await expect(repo.get(id,1)).rejects.toThrow("audit count differs");
  });
});
