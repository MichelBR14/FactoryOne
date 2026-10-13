import { describe, expect, it } from "vitest";
import { buildAccountingPreview, type AccountingPreviewLineInput } from "../../webapp/modules/ggf/service/AccountingPreview";
import { buildGgfPostingPlanDraft, calculateGgfPostingPlanHash, type GgfPostingPlan,
  type GgfPostingPlanDocument } from "../../webapp/modules/ggf/service/GgfPostingPlan";
import { calculateGgfExecutionId, calculateGgfRequestHash } from "../../webapp/modules/ggf/service/GgfPostingExecution";
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
  result.technicalRequestHashes = Object.fromEntries(await Promise.all(result.documents.map(async document => [document.type,
    await calculateGgfRequestHash({ Comments: `FactoryOne GGF ${closingId}`, type: document.type,
      total: document.totalCents })] as const)));
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
  async getClaim(_executionId: string) { return this.claimValue ? structuredClone(this.claimValue) : null; }
  async findExecution(executionId: string) {
    const found = [...this.executions].reverse().find(row => row.executionId === executionId);
    return found ? structuredClone(found) : null;
  }
  async claim(claim: GgfPostingClaim) {
    if (this.claimValue) throw new Error("SAP Code conflict");
    this.claimValue = structuredClone(claim);
  }
  async updateClaim(_executionId: string, status: GgfPostingExecution["status"], updatedAt: string) {
    if (this.claimValue) this.claimValue = { ...this.claimValue, status, updatedAt };
  }
  async append(execution: GgfPostingExecution) { this.executions.push(structuredClone(execution)); }
  async latest(executionId: string) {
    const found = [...this.executions].reverse().find(row => row.executionId === executionId);
    return found ? structuredClone(found) : null;
  }
  async transitionClosing(input: { expectedVersion: number; expectedStatus: string; status: GgfPostingExecution["status"] }) {
    if (input.expectedVersion !== this.lifecycleVersion || input.expectedStatus !== this.closingStatus)
      throw new Error("stale closing");
    this.lifecycleVersion++;
    this.closingStatus = input.status;
    return this.lifecycleVersion;
  }
  async recoverPrePostFailedExecution(executionId: string, audit: { authorizedAt: string; reason: string;
    failureCategory: "PRE_POST_CHECKPOINT_SERIALIZATION_ERROR"; failureDetail: "NULL_VS_EMPTY_REQUEST_NORMALIZATION";
    recoveryFromStatus: "FAILED"; recoveryCount: number }) {
    const current = await this.findExecution(executionId);
    if (!current || current.status !== "FAILED" || current.error !== "PRE_POST_CHECK_FAILED" ||
        this.claimValue?.status !== "FAILED" || current.documents.some(document => document.status !== "PENDING" ||
          document.attemptCount !== 0 || document.attempts.length || document.requestHash !== null))
      throw new Error("Recovery gate failed");
    const event = JSON.stringify({ failureCategory: audit.failureCategory, failureDetail: audit.failureDetail,
      originalError: current.error, failedAt: current.finishedAt, RecoveryAuthorizedAt: audit.authorizedAt,
      RecoveryReason: audit.reason, RecoveryFromStatus: audit.recoveryFromStatus, RecoveryCount: audit.recoveryCount });
    this.lifecycleVersion++;
    this.closingStatus = "READY_TO_POST";
    this.claimValue = { ...this.claimValue, status: "CLAIMED", updatedAt: audit.authorizedAt };
    const recovered = { ...current, status: "READY_TO_POST" as const, lifecycleVersion: this.lifecycleVersion,
      finishedAt: null, updatedAt: audit.authorizedAt, error: event };
    this.executions.push(structuredClone(recovered));
    return structuredClone(recovered);
  }
}

class MemoryDocumentGateway implements GgfPostingDocumentGateway {
  posts: GgfPostingPlanDocument["type"][] = [];
  reconciliations: GgfPostingPlanDocument["type"][] = [];
  failAt: number | null = null;
  uncertainAt: number | null = null;
  found = true;
  alterPayload = false;
  failPrepare = false;
  async prepare(document: GgfPostingPlanDocument) {
    if (this.failPrepare) throw new Error("invalid local proposal");
    return { expectedCents: document.totalCents,
      payload: { Comments: `FactoryOne GGF ${closingId}`, type: document.type,
        total: this.alterPayload ? `${document.totalCents}-changed` : document.totalCents } };
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
    this.reconciliations.push(input.documentType);
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

async function partialFixture() {
  const f = await fixture();
  const execution = structuredClone(f.store.executions[0]!);
  const planned = f.store.plan.documents.find(document => document.order === 1)!;
  const prepared = await f.gateway.prepare(planned);
  const request = prepared.payload;
  const requestHash = await calculateGgfRequestHash(request);
  execution.status = "POSTING_PARTIAL";
  execution.documents[0] = { ...execution.documents[0]!, request, requestHash, status: "RECONCILED",
    reconciliation: "MATCHED", attemptCount: 1, attemptStartedAt: time, responseReceivedAt: time,
    reconciledAt: time, docEntry: 44, docNum: 7, transId: 2311,
    response: { DocEntry: 44 }, attempts: [{ attempt: 1, requestHash, startedAt: time,
      responseReceivedAt: time, status: "RECONCILED", sanitizedError: null }] };
  f.store.executions = [execution];
  f.store.closingStatus = "POSTING_PARTIAL";
  f.store.claimValue = { executionId: execution.executionId, closingId, postingHash: execution.postingHash,
    closingVersion: execution.closingVersion, postingPlanVersion: execution.postingPlanVersion,
    status: "POSTING_PARTIAL", updatedAt: time, claimedAt: time, claimedBy: actor };
  return f;
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
    expect(result.documents.every(document => document.status === "RECONCILED" && document.reconciliation === "MATCHED")).toBe(true);
    expect(JSON.stringify(store.executions)).not.toContain("must-not-persist");
  });

  it("runs the persisted-state checkpoint after claim and before any financial POST", async () => {
    const { store, gateway, service } = await fixture();
    let checked = false;
    const result = await service.post(closingId, 1, async () => {
      const latest = store.executions.at(-1)!;
      expect(store.claimValue?.status).toBe("POSTING");
      expect(latest.status).toBe("POSTING");
      expect(latest.documents.every(document => document.status === "PENDING" && document.attemptCount === 0)).toBe(true);
      expect(gateway.posts).toEqual([]);
      checked = true;
    });
    expect(checked).toBe(true);
    expect(gateway.posts).toHaveLength(3);
    expect(result.status).toBe("POSTED");
  });

  it("requires explicit recovery for a zero-attempt pre-POST failure and preserves the failure event", async () => {
    const { store, gateway, service } = await fixture();
    const failed = await service.post(closingId, 1, async () => { throw new Error("null vs empty"); });
    expect(failed.status).toBe("FAILED");
    expect(store.claimValue?.status).toBe("FAILED");
    expect(gateway.posts).toEqual([]);
    await expect(service.resumeExecution(failed.executionId)).rejects.toThrow("FAILED execution requires explicit administrative treatment");

    const recovered = await service.recoverPrePostFailedExecution(closingId, 1,
      "Manual recovery after canonical empty-request checkpoint fix");
    expect(recovered.status).toBe("READY_TO_POST");
    expect(recovered.lifecycleVersion).toBe(10);
    expect(recovered.error).toContain("PRE_POST_CHECKPOINT_SERIALIZATION_ERROR");
    expect(recovered.error).toContain("PRE_POST_CHECK_FAILED");
    expect(recovered.error).toContain("RecoveryFromStatus");
    expect(store.claimValue?.status).toBe("CLAIMED");
    expect(recovered.documents).toHaveLength(3);
    expect(recovered.documents.every(document => document.status === "PENDING" && document.attemptCount === 0 &&
      document.requestHash === null && document.docEntry === null)).toBe(true);
    expect(gateway.posts).toEqual([]);
  });

  it("blocks explicit recovery when a document has any recorded attempt", async () => {
    const { store, gateway, service } = await fixture();
    const failed = await service.post(closingId, 1, async () => { throw new Error("checkpoint mismatch"); });
    const changed = structuredClone(failed);
    changed.documents[0]!.attemptCount = 1;
    store.executions.push(changed);
    await expect(service.recoverPrePostFailedExecution(closingId, 1, "authorized test recovery"))
      .rejects.toThrow("Execution contains an attempt");
    expect(gateway.posts).toEqual([]);
  });

  it("fails closed when the pre-POST checkpoint diverges", async () => {
    const { store, gateway, service } = await fixture();
    const result = await service.post(closingId, 1, async () => { throw new Error("checkpoint mismatch"); });
    expect(result.status).toBe("FAILED");
    expect(gateway.posts).toEqual([]);
    expect(store.claimValue?.status).toBe("FAILED");
    expect(result.documents.every(document => document.status === "PENDING")).toBe(true);
  });

  it("a pre-existing claim never reposts and stays uncertain when reconciliation finds no document", async () => {
    const { store, gateway, service } = await fixture();
    const identity = { closingId, postingHash: store.plan.postingHash, closingVersion: 7, postingPlanVersion: 1 };
    store.claimValue = { ...identity, executionId: await calculateGgfExecutionId(identity), status: "CLAIMED",
      updatedAt: time, claimedAt: time, claimedBy: actor };
    gateway.found = false;
    const result = await service.post(closingId, 1);
    expect(result.status).toBe("POSTING_UNCERTAIN");
    expect(gateway.posts).toEqual([]);
  });

  it("does not treat a claim for the wrong posting-plan version as this execution's claim", async () => {
    const { store, gateway, service } = await fixture();
    const identity = { closingId, postingHash: store.plan.postingHash, closingVersion: 7, postingPlanVersion: 1 };
    store.claimValue = { ...identity, executionId: await calculateGgfExecutionId(identity), status: "CLAIMED",
      updatedAt: time, claimedAt: time, claimedBy: actor, postingPlanVersion: 2 };
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
    expect(result.documents[0]?.status).toBe("RECONCILED");
    expect(result.documents[1]?.status).toBe("FAILED");
    expect(second.gateway.posts).toHaveLength(2);
  });

  it("records a preparation failure before any gateway POST", async () => {
    const { gateway, service } = await fixture();
    gateway.failPrepare = true;
    const result = await service.post(closingId, 1);
    expect(result.status).toBe("FAILED");
    expect(result.documents[0]).toMatchObject({ status: "FAILED", attemptCount: 0, requestHash: null });
    expect(gateway.posts).toEqual([]);
  });

  it("timeout after dispatch reconciles the created document, preserves partial state and never resends", async () => {
    const { store, gateway, service } = await fixture();
    gateway.uncertainAt = 0;
    const pending = await service.post(closingId, 1);
    expect(pending.status).toBe("POSTING_UNCERTAIN");
    const count = gateway.posts.length;
    gateway.uncertainAt = null;
    const recovered = await service.resumeExecution(pending.executionId);
    expect(recovered.status).toBe("POSTING_PARTIAL");
    expect(recovered.documents[0]).toMatchObject({ status: "RECONCILED", reconciliation: "MATCHED", docEntry: 100 });
    expect(recovered.documents[1]?.status).toBe("PENDING");
    expect(gateway.posts).toHaveLength(count);
    expect(store.claimValue).not.toBeNull();
  });

  it("resume reconciles UNCERTAIN only and leaves a dependent PENDING document undispatched", async () => {
    const { store, gateway, service } = await fixture();
    const ready = store.executions[0]!;
    const plans = store.plan.documents.filter(document => document.status !== "NOT_REQUIRED")
      .sort((left, right) => left.order - right.order);
    expect(plans).toHaveLength(3);
    const documents = [];
    for (let index = 0; index < plans.length; index++) {
      const planned = plans[index]!;
      const status = index === 0 ? "RECONCILED" as const : index === 1 ? "UNCERTAIN" as const : "PENDING" as const;
      const raw = index < 2 ? (await gateway.prepare(planned)).payload : null;
      const request = raw ?? {};
      const requestHash = raw ? await calculateGgfRequestHash(request) : null;
      const completedAt = status === "RECONCILED" ? time : null;
      documents.push({ documentType: planned.type, order: planned.order, expectedCents: planned.totalCents,
        request, response: status === "RECONCILED" ? { DocEntry: 100 } : null, currency: planned.currency,
        docEntry: status === "RECONCILED" ? 100 : null, docNum: status === "RECONCILED" ? 200 : null,
        transId: status === "RECONCILED" ? 300 : null, status,
        reconciliation: status === "RECONCILED" ? "MATCHED" as const : status === "UNCERTAIN" ? "NO_MATCH" as const : "NOT_RUN" as const,
        requestHash, attemptCount: status === "PENDING" ? 0 : 1,
        attemptStartedAt: status === "PENDING" ? null : time, responseReceivedAt: completedAt,
        reconciledAt: completedAt, dependencies: [...planned.dependencies],
        attempts: requestHash ? [{ attempt: 1, requestHash, startedAt: time, responseReceivedAt: completedAt,
          status, sanitizedError: null }] : [], error: null });
    }
    const execution = { ...ready, status: "POSTING_UNCERTAIN" as const, claimedAt: time, claimedBy: actor,
      documents, error: "TECHNICAL_FIXTURE_UNCERTAIN" };
    store.executions = [execution];
    store.lifecycleVersion = execution.lifecycleVersion;
    store.closingStatus = "POSTING_UNCERTAIN";
    store.claimValue = { executionId: execution.executionId, closingId, postingHash: execution.postingHash,
      closingVersion: execution.closingVersion, postingPlanVersion: execution.postingPlanVersion,
      status: "POSTING_UNCERTAIN", updatedAt: time, claimedAt: time, claimedBy: actor };

    const resumed = await service.resumeExecution(execution.executionId);
    expect(gateway.posts).toEqual([]);
    expect(gateway.reconciliations).toEqual([plans[1]!.type]);
    expect(resumed.documents.map(document => document.status)).toEqual(["RECONCILED", "UNCERTAIN", "PENDING"]);
    expect(resumed.documents[2]?.dependencies).toEqual(plans[2]!.dependencies);
  });

  it("continues exactly the selected next document and leaves later documents pending", async () => {
    const { store, gateway, service } = await partialFixture();
    const result = await service.postNextDocument(store.executions[0]!.executionId, "JournalEntry.CPV");
    expect(gateway.posts).toEqual(["JournalEntry.CPV"]);
    expect(result.status).toBe("POSTING_PARTIAL");
    expect(result.documents.map(document => document.status)).toEqual(["RECONCILED", "RECONCILED", "PENDING"]);
    expect(result.documents[1]).toMatchObject({ attemptCount: 1, requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      docEntry: 100, docNum: 200, transId: 300 });
    expect(result.documents[2]).toMatchObject({ attemptCount: 0, requestHash: null, status: "PENDING" });
  });

  it("blocks a skipped or already dispatched document before any new POST", async () => {
    const skipped = await partialFixture();
    await expect(skipped.service.postNextDocument(skipped.store.executions[0]!.executionId, "JournalEntry.Closing"))
      .rejects.toThrow("single next undispatched document");
    expect(skipped.gateway.posts).toEqual([]);

    const incomplete = await partialFixture();
    incomplete.store.executions[0]!.documents[0]!.status = "PENDING";
    await expect(incomplete.service.postNextDocument(incomplete.store.executions[0]!.executionId, "JournalEntry.CPV"))
      .rejects.toThrow("single next undispatched document");
    expect(incomplete.gateway.posts).toEqual([]);
  });

  it("does not send when the bounded continuation finds existing external document evidence", async () => {
    const { store, gateway, service } = await partialFixture();
    gateway.posts.push("JournalEntry.CPV");
    await expect(service.postNextDocument(store.executions[0]!.executionId, "JournalEntry.CPV"))
      .rejects.toThrow("Existing or incomplete SAP document evidence");
    expect(gateway.posts).toEqual(["JournalEntry.CPV"]);
    expect(store.executions.at(-1)!.documents[1]).toMatchObject({ status: "PENDING", attemptCount: 0 });
  });

  it("blocks resume when the reconstructed request hash differs and never resends", async () => {
    const { gateway, service } = await fixture();
    gateway.uncertainAt = 0;
    const pending = await service.post(closingId, 1);
    const postCount = gateway.posts.length;
    gateway.alterPayload = true;
    const recovered = await service.resumeExecution(pending.executionId);
    expect(recovered.status).toBe("PAYLOAD_INTEGRITY_VIOLATION");
    expect(gateway.posts).toHaveLength(postCount);
  });

  it("returns an already completed execution without reposting reconciled documents", async () => {
    const { gateway, service } = await fixture();
    const posted = await service.post(closingId, 1);
    const count = gateway.posts.length;
    const resumed = await service.resumeExecution(posted.executionId);
    expect(resumed.status).toBe("POSTED");
    expect(gateway.posts).toHaveLength(count);
  });

  it("rejects a second prepare after a persisted execution and blocks a posted closing", async () => {
    const { store, service } = await fixture();
    await expect(service.prepare(closingId, 1)).rejects.toThrow("cannot be prepared again");
    store.closingStatus = "POSTED";
    await expect(service.post(closingId, 1)).rejects.toThrow("Persisted closing/PostingPlan status differs");
  });
});
