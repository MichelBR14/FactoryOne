import { describe, expect, it } from "vitest";
import { GGF_CLOSING_METADATA } from "../../webapp/modules/ggf/data/closingMetadata";
import { validateMetadataSet } from "../../webapp/core/data/metadata";
import { postingHash, type GgfClosing, type PostingBasis } from "../../webapp/modules/ggf/service/GgfClosing";
import { DefiniteSapRejection, GgfPostingCoordinator, type RevaluationCandidate, type RevaluationGateway } from "../../webapp/modules/ggf/service/GgfPostingCoordinator";
import { SapMetadataUnavailableError } from "../../webapp/modules/ggf/repository/SapGgfClosingVersionRepository";
import type { GgfClosingStore } from "../../webapp/modules/ggf/repository/SapGgfClosingRepository";

const basis = (): PostingBasis => ({
  companyDB: "SBODEMOBR2", periodStart: "2026-09-01", periodEnd: "2026-09-30", branch: "1",
  dimensions: { d1: "IND" }, totals: { ggf: "1.00", allocated: "1.00", revalued: "1.00" },
  accounts: [{ account: "4.01", amount: "1.00", percent: "100", criterion: "DIRECT_COST" }],
  lines: [{ account: "4.01", criterion: "DIRECT_COST", orderId: "212", item: "F1GGF26H01",
    warehouse: "01", basis: "12.00", percent: "100", allocated: "1.00", costBefore: "12.00",
    costAfter: "13.00", revaluation: "1.00", status: "READY" }],
  inventoryAccounts: { "F1GGF26H01/01": "1.01.02.01.01" },
  payload: { DocDate: "2026-09-28", TaxDate: "2026-09-28", RevalType: "P",
    Comments: "FactoryOne GGF TEST_1", JournalMemo: "FactoryOne GGF TEST_1",
    MaterialRevaluationLines: [{ ItemCode: "F1GGF26H01", WarehouseCode: "01", Price: 13,
      RevaluationIncrementAccount: "5.03.01.01.04" }] }
});
const closing = (): GgfClosing => ({ closingId: "TEST_1", companyDB: "SBODEMOBR2",
  periodStart: "2026-09-01", periodEnd: "2026-09-30", branch: "1", dimensions: { d1: "IND" },
  status: "VALIDATED", version: 3, lineVersion: 2, createdAt: "2026-09-28T10:00:00Z", createdBy: "tester",
  calculatedAt: "2026-09-28T10:01:00Z", postedAt: null, totalGgf: "1.00", totalAllocated: "1.00",
  totalRevalued: "1.00", sapMaterialRevaluationDocEntry: null, sapMaterialRevaluationDocNum: null,
  sapJournalTransId: null, postingHash: null, reopenedFrom: null, cancelledAt: null, notes: "",
  lastError: null, postingBasis: null, proposedPayload: null, lines: [] });
const candidate = (): RevaluationCandidate => ({ docEntry: 25, docNum: 5, transId: 2278,
  docDate: "2026-09-28T00:00:00Z", revalType: "P", comments: "FactoryOne GGF TEST_1",
  journalMemo: "FactoryOne GGF TEST_1", lines: [{ item: "F1GGF26H01", warehouse: "01", price: 13,
    amount: "1.00", incrementAccount: "5.03.01.01.04", decrementAccount: "5.03.01.01.04" }],
  journalLines: [{ account: "1.01.02.01.01", debit: "1.00", credit: "0.00" },
    { account: "5.03.01.01.04", debit: "0.00", credit: "1.00" }] });

class MemoryStore implements GgfClosingStore {
  value = closing(); claims = new Map<string,{hash:string;version:number}>(); failReplace = false;
  async get(id: string) { return id === this.value.closingId ? structuredClone(this.value) : null; }
  async create(value: GgfClosing) { this.value = structuredClone(value); }
  async replace(expected: GgfClosing, next: GgfClosing) {
    if (this.failReplace) throw new Error("storage down");
    if (this.value.version !== expected.version || this.value.status !== expected.status) throw new Error("stale closing");
    this.value = structuredClone(next);
  }
  async claim(id: string, hash: string, version:number) {
    if (this.claims.has(id)) throw new Error("duplicate SAP Code");
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("invalid hash");
    this.claims.set(id,{hash,version});
  }
  async getClaim(id:string) { return this.claims.get(id)??null; }
}
function fixture() {
  const store = new MemoryStore();
  let posts = 0;
  let metadataAvailable = true;
  let candidates = [candidate()];
  let postAction: () => Promise<{ docEntry: number; docNum: number; transId: number }> = async () => ({docEntry:25,docNum:5,transId:2278});
  let findAction: () => Promise<RevaluationCandidate[]> = async () => candidates;
  const gateway: RevaluationGateway = {
    async post() { posts++; return postAction(); },
    find: async () => findAction()
  };
  const service = new GgfPostingCoordinator(store, gateway, {
    async assertAvailable() { if (!metadataAvailable) throw new SapMetadataUnavailableError(); }
  }, () => "2026-09-28T11:00:00Z");
  return { store, service, get posts() { return posts; },
    setMetadataAvailable(value: boolean) { metadataAvailable = value; },
    setPost(fn: typeof postAction) { postAction = fn; },
    setFind(fn: typeof findAction) { findAction = fn; },
    setCandidates(rows: RevaluationCandidate[]) { candidates = rows; } };
}

describe("GGF closing lifecycle (offline; no SAP POST)", () => {
  it("blocks preparation and POST when version metadata is unavailable", async () => {
    const f=fixture(), b=basis();
    f.setMetadataAvailable(false);
    await expect(f.service.prepareReady("TEST_1",b)).rejects.toMatchObject({code:"SAP_METADATA_UNAVAILABLE"});
    expect(f.store.value.status).toBe("VALIDATED");
    f.setMetadataAvailable(true);
    await f.service.prepareReady("TEST_1",b);
    f.setMetadataAvailable(false);
    await expect(f.service.post("TEST_1",b)).rejects.toMatchObject({code:"SAP_METADATA_UNAVAILABLE"});
    expect(f.store.value.status).toBe("READY_TO_POST");
    expect(f.store.claims.size).toBe(0);
    expect(f.posts).toBe(0);
  });
  it("declares a valid native UDT/UDO schema", () => {
    expect(validateMetadataSet(GGF_CLOSING_METADATA)).toEqual([]);
    expect(GGF_CLOSING_METADATA.objects.map(o=>o.table)).toEqual(["CLOSE","CLINE","CLAIM","CVERS"]);
  });
  it("first valid POST claims once, persists POSTING, and links the verified SAP document", async () => {
    const f=fixture(), b=basis(); await f.service.prepareReady("TEST_1",b);
    f.setPost(async()=>{ expect(f.store.value.status).toBe("POSTING");expect(f.store.claims.has("TEST_1")).toBe(true);return {docEntry:25,docNum:5,transId:2278}; });
    const posted=await f.service.post("TEST_1",b);
    expect(posted).toMatchObject({status:"POSTED",postingHash:await postingHash(b),postedAt:"2026-09-28T11:00:00Z",
      sapMaterialRevaluationDocEntry:25,sapMaterialRevaluationDocNum:5,sapJournalTransId:2278});
    expect(f.posts).toBe(1);
  });
  it("blocks duplicate ClosingId and the same hash after POSTED", async () => {
    const f=fixture(),b=basis();await f.service.prepareReady("TEST_1",b);await f.service.post("TEST_1",b);
    await expect(f.service.post("TEST_1",b)).rejects.toThrow("already linked");expect(f.posts).toBe(1);
  });
  it("same persisted hash is stable across object key order and operational line status", async () => {
    const a=basis(),b=basis();b.dimensions={...b.dimensions};b.lines[0]!.status="POSTING";
    expect(await postingHash(a)).toBe(await postingHash(b));
  });
  it("binds FIFO receipt and original/result layers to the persisted posting hash", async () => {
    const a=basis(),b=basis();
    b.fifoLineage=[{closingId:"TEST_1",version:1,productionOrderDocEntry:214,productionOrderDocNum:83,
      receiptDocEntry:122,receiptLine:0,receiptDocNum:77,itemCode:"F1GGF26P01",warehouseCode:"01",
      originalProducedQuantity:"10",originalLayerId:{transactionSequenceNum:2792,layerId:0},
      originalLayerQuantity:"10",originalLayerCost:"12",remainingLayerQuantity:"4",
      consumedQuantity:"6",remainingLayerValue:"48",traceStatus:"FIFO_PARTIALLY_CONSUMED",
      traceTimestamp:"2026-09-29T12:00:00Z",revaluationDocEntry:null,revaluationDocNum:null,
      resultLayerId:null,resultLayerQuantity:null,resultLayerCost:null}];
    expect(await postingHash(a)).not.toBe(await postingHash(b));
    const first=await postingHash(b);
    const row=b.fifoLineage[0]!;
    for(const key of ["productionOrderDocEntry","productionOrderDocNum","receiptDocEntry","receiptLine",
      "itemCode","warehouseCode","originalProducedQuantity","originalLayerCost",
      "remainingLayerValue","traceStatus"] as const) {
      const copy=structuredClone(b);
      (copy.fifoLineage![0] as unknown as Record<string,unknown>)[key]=
        typeof row[key]==="number" ? Number(row[key])+1 : `${row[key]}X`;
      if(key==="originalProducedQuantity")copy.fifoLineage![0]!.originalProducedQuantity="11";
      if(key==="originalLayerCost")copy.fifoLineage![0]!.originalLayerCost="13";
      if(key==="originalLayerCost")copy.fifoLineage![0]!.remainingLayerValue="52";
      if(key==="remainingLayerValue") {
        copy.fifoLineage![0]!.remainingLayerValue="52";
        copy.fifoLineage![0]!.originalLayerCost="13";
      }
      if(key==="traceStatus")copy.fifoLineage![0]!.traceStatus="FIFO_TRACE_AMBIGUOUS";
      expect(await postingHash(copy)).not.toBe(first);
    }
    b.fifoLineage[0]!.originalLayerId.layerId=1;
    expect(await postingHash(b)).not.toBe(first);
    b.fifoLineage[0]!.originalLayerId.layerId=0;
    b.fifoLineage[0]!.version=2;
    b.fifoLineage[0]!.traceTimestamp="2026-09-29T13:00:00Z";
    expect(await postingHash(b)).toBe(first);
    const modified=structuredClone(b);
    modified.fifoLineage![0]!.remainingLayerQuantity="3";
    modified.fifoLineage![0]!.consumedQuantity="7";
    modified.fifoLineage![0]!.remainingLayerValue="36";
    expect(await postingHash(modified)).not.toBe(first);
    modified.fifoLineage![0]!.originalLayerId.transactionSequenceNum=2793;
    expect(await postingHash(modified)).not.toBe(first);
  });
  it.each(["companyDB","periodStart","periodEnd","branch","dimensions","accounts","lines","inventoryAccounts","payload"] as const)(
    "changes the hash when functional %s changes", async key => {
      const a=basis(),b=basis();
      switch(key) {
        case "companyDB": b.companyDB="OTHER";break;
        case "periodStart": b.periodStart="2026-08-01";break;
        case "periodEnd": b.periodEnd="2026-10-01";break;
        case "branch": b.branch="2";break;
        case "dimensions": b.dimensions.d1="OTHER";break;
        case "accounts": b.accounts[0]!.criterion="QUANTITY";break;
        case "lines": b.lines[0]!.allocated="1.01";break;
        case "inventoryAccounts": b.inventoryAccounts["F1GGF26H01/01"]="OTHER";break;
        case "payload": (b.payload.MaterialRevaluationLines as any[])[0].Price=14;break;
      }
      expect(await postingHash(a)).not.toBe(await postingHash(b));
    });
  it("rejects changed input under the old hash before claim or POST", async () => {
    const f=fixture(),b=basis();await f.service.prepareReady("TEST_1",b);b.lines[0]!.costAfter="14.00";
    await expect(f.service.post("TEST_1",b)).rejects.toThrow("PostingHash");
    expect(f.posts).toBe(0);expect(f.store.claims.size).toBe(0);
  });
  it("timeout after dispatch becomes POSTING_UNCERTAIN and never auto-reposts", async () => {
    const f=fixture(),b=basis();await f.service.prepareReady("TEST_1",b);
    f.setPost(async()=>{throw new Error("network timeout secret details");});
    const result=await f.service.post("TEST_1",b);
    expect(result.status).toBe("POSTING_UNCERTAIN");expect(result.lastError).toBe("POST_RESPONSE_UNKNOWN");
    await expect(f.service.post("TEST_1",b)).rejects.toThrow("cannot be posted");expect(f.posts).toBe(1);
  });
  it("reconciliation finds a unique document with economics, marker and journal", async () => {
    const f=fixture(),b=basis();await f.service.prepareReady("TEST_1",b);
    f.setPost(async()=>{throw new Error("timeout");});await f.service.post("TEST_1",b);
    expect((await f.service.reconcile("TEST_1")).status).toBe("POSTED");expect(f.posts).toBe(1);
  });
  it("reconciliation with no document remains uncertain, without retry", async () => {
    const f=fixture(),b=basis();await f.service.prepareReady("TEST_1",b);
    f.setPost(async()=>{throw new Error("timeout");});await f.service.post("TEST_1",b);f.setCandidates([]);
    const result=await f.service.reconcile("TEST_1");expect(result.status).toBe("POSTING_UNCERTAIN");
    expect(result.lastError).toBe("NO_PROVEN_SAP_MATCH");expect(f.posts).toBe(1);
  });
  it("rejects a candidate sharing only Comments, but with wrong price or journal", async () => {
    const f=fixture(),b=basis();await f.service.prepareReady("TEST_1",b);
    f.setPost(async()=>{throw new Error("timeout");});await f.service.post("TEST_1",b);
    const wrong=candidate();wrong.lines[0]!.price=99;f.setCandidates([wrong]);
    expect((await f.service.reconcile("TEST_1")).status).toBe("POSTING_UNCERTAIN");
  });
  it("failure before POST leaves no SAP request and a durable claim blocks another attempt", async () => {
    const f=fixture(),b=basis();await f.service.prepareReady("TEST_1",b);
    f.store.failReplace=true;
    await expect(f.service.post("TEST_1",b)).rejects.toThrow("storage down");
    expect(f.posts).toBe(0);expect(f.store.claims.has("TEST_1")).toBe(true);
    f.store.failReplace=false;
    const recovered=await f.service.post("TEST_1",b);
    expect(recovered.status).toBe("POSTING_UNCERTAIN");
    expect(recovered.lastError).toBe("CLAIM_EXISTS_BEFORE_POSTING_STATE");
    expect(f.posts).toBe(0);
  });
  it("definitive SAP rejection records FAILED, sanitized code and retains hash", async () => {
    const f=fixture(),b=basis();await f.service.prepareReady("TEST_1",b);
    f.setPost(async()=>{throw new DefiniteSapRejection(400,-5002);});
    const result=await f.service.post("TEST_1",b);
    expect(result.status).toBe("FAILED");expect(result.postingHash).toBe(await postingHash(b));
    expect(result.lastError).toBe("SAP_REJECTED_HTTP_400_CODE_-5002");
  });
  it("failure after SAP success leaves POSTING_UNCERTAIN with DocEntry for reconciliation", async () => {
    const f=fixture(),b=basis();await f.service.prepareReady("TEST_1",b);
    f.setFind(async()=>{throw new Error("read unavailable");});
    const result=await f.service.post("TEST_1",b);
    expect(result).toMatchObject({status:"POSTING_UNCERTAIN",sapMaterialRevaluationDocEntry:25,
      sapMaterialRevaluationDocNum:5,sapJournalTransId:2278,lastError:"POST_VERIFICATION_UNAVAILABLE"});
    expect(f.posts).toBe(1);
  });
  it("multiple equally matching candidates remain ambiguous", async () => {
    const f=fixture(),b=basis();await f.service.prepareReady("TEST_1",b);
    f.setPost(async()=>{throw new Error("timeout");});await f.service.post("TEST_1",b);
    f.setCandidates([candidate(),{...candidate(),docEntry:26,docNum:6,transId:2279}]);
    const result=await f.service.reconcile("TEST_1");
    expect(result.status).toBe("POSTING_UNCERTAIN");expect(result.lastError).toBe("MULTIPLE_SAP_MATCHES");
  });
});
