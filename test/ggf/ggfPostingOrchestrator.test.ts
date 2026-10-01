import { describe, expect, it } from "vitest";
import { buildAccountingPreview, type AccountingPreviewLineInput } from "../../webapp/modules/ggf/service/AccountingPreview";
import { buildGgfPostingPlanDraft, calculateGgfPostingPlanHash, type GgfPostingPlan,
  type GgfPostingPlanDocument } from "../../webapp/modules/ggf/service/GgfPostingPlan";
import { DefiniteGgfDocumentRejection, GgfPostingOrchestrator, type GgfPostingClaim,
  type GgfPostingDocumentGateway, type GgfPostingExecution, type GgfPostingOrchestrationStore,
  type GgfDocumentPostingResult, type PersistedGgfPostingBundle } from "../../webapp/modules/ggf/service/GgfPostingOrchestrator";

const closingId = "ORCHESTRATOR_TEST";
const actor = "operator-test";
const time = "2026-09-30T20:00:00.000Z";

async function planFixture(): Promise<GgfPostingPlan> {
  const lines: AccountingPreviewLineInput[] = [
    { closingId: null, version: null, orderNumber: "76", item: "ITEM-A", warehouse: "01", category: "GGF",
      accountOriginal: "EXP-GGF", criterion: "DIRECT_COST", quantity: "2", unit: "UN", amountCents: "6000",
      stockCents: "6000", consumedCents: "0", stockTraceStatus: "STOCK_REVALUATION_CANDIDATE", valuationMethod: "bis_FIFO",
      inventoryAccountFromSap: { account: "INV", origin: "SAP_TEST", verified: true, refs: ["receipt/1"] },
      consumedOperationKey: null, sourceRefs: ["receipt/1"] },
    { closingId: null, version: null, orderNumber: "77", item: "ITEM-A", warehouse: "01", category: "MOD",
      accountOriginal: "EXP-MOD", criterion: "DIRECT_COST", quantity: "1", unit: "UN", amountCents: "4000",
      stockCents: "0", consumedCents: "4000", stockTraceStatus: "STOCK_REVALUATION_CANDIDATE", valuationMethod: "bis_FIFO",
      consumedOperationKey: "DeliveryNotes:8/0", sourceRefs: ["issue/8"] }
  ];
  const preview = buildAccountingPreview({ MOD: "4000", GGF: "6000" }, lines, {
    transitoryGgfAccount: "T-GGF", transitoryModAccount: "T-MOD", closingGgfAccount: "C-GGF",
    closingModAccount: "C-MOD", cpvAccount: "CPV", inventoryAccounts: { "ITEM-A/01": "INV" },
    cpvEligibleOperationKeys: ["DeliveryNotes:8/0"], requireDimensions: false
  });
  const draft = buildGgfPostingPlanDraft(preview, { closingId, companyDB: "SBODEMOBR2",
    periodStart: "2026-09-01", periodEnd: "2026-09-30", branch: "", dimensions: [], currency: "BRL",
    currencySource: "test fixture", sourceCapturedAt: time, closingVersion: 7, createdBy: actor });
  const result = { ...draft, version: 1, createdAt: time, postingHash: "" } as GgfPostingPlan;
  result.postingHash = await calculateGgfPostingPlanHash(result);
  return result;
}

class MemoryOrchestrationStore implements GgfPostingOrchestrationStore {
  plan!: GgfPostingPlan;
  lifecycleVersion = 7;
  closingStatus = "READY_TO_POST";
  claimValue: GgfPostingClaim | null = null;
  executions: GgfPostingExecution[] = [];
  async load(): Promise<PersistedGgfPostingBundle> {
    return { closingId, closingVersion: 7, lifecycleVersion: this.lifecycleVersion,
      closingStatus: this.closingStatus, closingPostingHash: this.plan.postingHash,
      closingIntegrity: "NOT_APPLICABLE", plan: structuredClone(this.plan), planReadbackHash: this.plan.postingHash,
      metadataAvailable: true, homologatedValuationMethods: ["bis_FIFO"], companyDB: "SBODEMOBR2", user: actor };
  }
  async getClaim() { return this.claimValue ? structuredClone(this.claimValue) : null; }
  async claim(claim: GgfPostingClaim) {
    if (this.claimValue) throw new Error("SAP Code conflict");
    this.claimValue = structuredClone(claim);
  }
  async append(execution: GgfPostingExecution) { this.executions.push(structuredClone(execution)); }
  async latest() { return structuredClone(this.executions.at(-1) ?? null); }
  async transitionClosing(input: { expectedVersion: number; expectedStatus: string; status: GgfPostingExecution["status"] }) {
    if (input.expectedVersion !== this.lifecycleVersion || input.expectedStatus !== this.closingStatus)
      throw new Error("stale closing");
    this.lifecycleVersion++;
    this.closingStatus = input.status;
    return this.lifecycleVersion;
  }
}

class MemoryDocumentGateway implements GgfPostingDocumentGateway {
  posts: GgfPostingPlanDocument["type"][] = [];
  failAt: number | null = null;
  uncertainAt: number | null = null;
  found = true;
  async prepare(document: GgfPostingPlanDocument) {
    return { expectedCents: document.totalCents,
      payload: { Comments: `FactoryOne GGF ${closingId}`, type: document.type, total: document.totalCents,
        AuthCookie: "must-not-persist" } };
  }
  async post(documentType: GgfPostingPlanDocument["type"]): Promise<GgfDocumentPostingResult> {
    const index = this.posts.length;
    this.posts.push(documentType);
    if (index === this.failAt) throw new DefiniteGgfDocumentRejection(400, -5002);
    if (index === this.uncertainAt) throw new Error("socket timeout");
    return { docEntry: 100 + index, docNum: 200 + index, transId: 300 + index,
      response: { DocEntry: 100 + index, SessionId: "must-not-persist" } };
  }
  async reconcile(input: { documentType: GgfPostingPlanDocument["type"]; expectedCents: string }):
    Promise<{ complete: true; matches: GgfDocumentPostingResult[] }> {
    const index = this.posts.indexOf(input.documentType);
    return { complete: true, matches: this.found && index >= 0 ? [{ docEntry: 100 + index, docNum: 200 + index,
      transId: 300 + index, response: { DocEntry: 100 + index, Amount: input.expectedCents } }] : [] };
  }
}

async function fixture() {
  const store = new MemoryOrchestrationStore();
  store.plan = await planFixture();
  const gateway = new MemoryDocumentGateway();
  const service = new GgfPostingOrchestrator(store, gateway, () => time);
  await service.prepare(closingId, 1);
  return { store, gateway, service };
}

describe("GGF posting orchestration (offline; no SAP financial POST)", () => {
  it("blocks a blocked plan, divergent hash, missing metadata and integrity violation before claim", async () => {
    const { store, service } = await fixture();
    store.plan = { ...store.plan, status: "BLOCKED", postingHash: "" };
    store.plan.postingHash = await calculateGgfPostingPlanHash(store.plan);
    await expect(service.post(closingId, 1)).rejects.toThrow("PostingPlan is blocked");
    expect(store.claimValue).toBeNull();
    store.plan = await planFixture();
    const original = store.load.bind(store);
    store.load = async (...args) => ({ ...await original(...args), planReadbackHash: "0".repeat(64) });
    await expect(service.post(closingId, 1)).rejects.toThrow("hash differs");
    expect(store.claimValue).toBeNull();
    store.load = async (...args) => ({ ...await original(...args), metadataAvailable: false });
    await expect(service.post(closingId, 1)).rejects.toThrow("metadata or closing integrity");
    expect(store.claimValue).toBeNull();
    store.load = async (...args) => ({ ...await original(...args), closingIntegrity: "INTEGRITY_VIOLATION" });
    await expect(service.post(closingId, 1)).rejects.toThrow("metadata or closing integrity");
    expect(store.claimValue).toBeNull();
  });

  it("claims once, posts documents in plan order, reconciles and records a sanitized POSTED result", async () => {
    const { store, gateway, service } = await fixture();
    const expectedOrder = store.plan.documents.filter(document => document.status !== "NOT_REQUIRED")
      .sort((a, b) => a.order - b.order).map(document => document.type);
    const result = await service.post(closingId, 1);
    expect(result.status).toBe("POSTED");
    expect(gateway.posts).toEqual(expectedOrder);
    expect(store.claimValue).toMatchObject({ closingId, postingHash: store.plan.postingHash,
      closingVersion: 7, postingPlanVersion: 1 });
    expect(result.documents.every(document => document.status === "POSTED" && document.reconciliation === "MATCHED")).toBe(true);
    expect(JSON.stringify(store.executions)).not.toContain("must-not-persist");
  });

  it("a pre-existing claim never reposts and stays uncertain when reconciliation finds no document", async () => {
    const { store, gateway, service } = await fixture();
    store.claimValue = { closingId, postingHash: store.plan.postingHash, closingVersion: 7,
      postingPlanVersion: 1, claimedAt: time, claimedBy: actor };
    gateway.found = false;
    const result = await service.post(closingId, 1);
    expect(result.status).toBe("POSTING_UNCERTAIN");
    expect(gateway.posts).toEqual([]);
  });

  it("a definite first-document rejection is FAILED and a later rejection is POSTING_PARTIAL", async () => {
    const first = await fixture();
    first.gateway.failAt = 0;
    expect((await first.service.post(closingId, 1)).status).toBe("FAILED");

    const second = await fixture();
    second.gateway.failAt = 1;
    const result = await second.service.post(closingId, 1);
    expect(result.status).toBe("POSTING_PARTIAL");
    expect(result.documents[0]?.status).toBe("POSTED");
    expect(result.documents[1]?.status).toBe("FAILED");
  });

  it("timeout after dispatch reconciles the created document, preserves partial state and never resends", async () => {
    const { store, gateway, service } = await fixture();
    gateway.uncertainAt = 0;
    const pending = await service.post(closingId, 1);
    expect(pending.status).toBe("POSTING_UNCERTAIN");
    const count = gateway.posts.length;
    gateway.uncertainAt = null;
    const recovered = await service.reconcile(closingId, 1);
    expect(recovered.status).toBe("POSTING_PARTIAL");
    expect(recovered.documents[0]).toMatchObject({ status: "POSTED", reconciliation: "MATCHED", docEntry: 100 });
    expect(recovered.documents[1]?.status).toBe("PENDING");
    expect(gateway.posts).toHaveLength(count);
    expect(store.claimValue).not.toBeNull();
  });

  it("rejects a second prepare after a persisted execution and blocks a posted closing", async () => {
    const { store, service } = await fixture();
    await expect(service.prepare(closingId, 1)).rejects.toThrow("cannot be prepared again");
    store.closingStatus = "POSTED";
    await expect(service.post(closingId, 1)).rejects.toThrow("Persisted closing/PostingPlan status differs");
  });
});
