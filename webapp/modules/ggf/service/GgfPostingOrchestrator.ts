import { calculateGgfPostingPlanHash, type GgfPostingPlan, type GgfPostingPlanDocument } from "./GgfPostingPlan";

export type GgfPostingExecutionStatus =
  | "READY_TO_POST" | "POSTING" | "POSTING_PARTIAL" | "POSTING_UNCERTAIN" | "POSTED" | "FAILED";

export interface GgfPostingDocumentLink {
  documentType: GgfPostingPlanDocument["type"];
  order: number;
  expectedCents: string;
  request: Record<string, unknown>;
  response: Record<string, unknown> | null;
  docEntry: number | null;
  docNum: number | null;
  transId: number | null;
  status: "PENDING" | "POSTING" | "POSTED" | "FAILED" | "UNCERTAIN";
  reconciliation: "NOT_RUN" | "MATCHED" | "NO_MATCH" | "AMBIGUOUS";
  error: string | null;
}

export interface GgfPostingExecution {
  closingId: string;
  /** Version bound into the PostingPlan and claim; it never changes during posting. */
  closingVersion: number;
  /** Compare-and-set version of the mutable lifecycle header. */
  lifecycleVersion: number;
  postingPlanVersion: number;
  postingHash: string;
  status: GgfPostingExecutionStatus;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  claimedBy: string | null;
  documents: GgfPostingDocumentLink[];
  error: string | null;
}

export interface PersistedGgfPostingBundle {
  closingId: string;
  /** Immutable closing version referenced by the persisted PostingPlan. */
  closingVersion: number;
  lifecycleVersion: number;
  closingStatus: string;
  closingPostingHash: string | null;
  closingIntegrity: "VALID" | "NOT_APPLICABLE" | "INTEGRITY_VIOLATION";
  plan: GgfPostingPlan;
  planReadbackHash: string;
  metadataAvailable: boolean;
  homologatedValuationMethods: string[];
  companyDB: string;
  user: string | null;
}

export interface GgfPostingClaim {
  closingId: string;
  postingHash: string;
  closingVersion: number;
  postingPlanVersion: number;
  claimedAt: string;
  claimedBy: string | null;
}

export interface GgfPostingOrchestrationStore {
  /** Must reread closing, plan and their hashes directly from SAP on every call. */
  load(closingId: string, postingPlanVersion: number): Promise<PersistedGgfPostingBundle>;
  getClaim(closingId: string): Promise<GgfPostingClaim | null>;
  /** Must rely on SAP Code uniqueness; claims are permanent and never auto-deleted. */
  claim(claim: GgfPostingClaim): Promise<void>;
  /** Append-only persistence for execution status and per-document audit. */
  append(execution: GgfPostingExecution): Promise<void>;
  latest(closingId: string, postingPlanVersion: number): Promise<GgfPostingExecution | null>;
  /** Updates the persisted closing status/version using compare-and-set semantics. */
  transitionClosing(input: {
    closingId: string; expectedVersion: number; expectedStatus: string; status: GgfPostingExecutionStatus;
    postingHash: string; postingPlanVersion: number; error: string | null;
  }): Promise<number>;
}

export interface PreparedGgfPostingDocument {
  payload: Record<string, unknown>;
  expectedCents: string;
}

export interface GgfDocumentPostingResult {
  docEntry: number;
  docNum: number;
  transId: number;
  response: Record<string, unknown>;
}

export type GgfDocumentReconciliation =
  | { complete: true; matches: [GgfDocumentPostingResult] }
  | { complete: true; matches: [] }
  | { complete: true; matches: GgfDocumentPostingResult[] }
  | { complete: false; matches: GgfDocumentPostingResult[] };

export interface GgfPostingDocumentGateway {
  prepare(document: GgfPostingPlanDocument, identity: {
    closingId: string; closingVersion: number; postingPlanVersion: number; postingHash: string;
  }): Promise<PreparedGgfPostingDocument>;
  post(documentType: GgfPostingPlanDocument["type"], payload: Record<string, unknown>): Promise<GgfDocumentPostingResult>;
  reconcile(input: {
    closingId: string; documentType: GgfPostingPlanDocument["type"]; expectedCents: string;
    knownDocEntry: number | null; payload: Record<string, unknown>;
  }): Promise<GgfDocumentReconciliation>;
}

export class DefiniteGgfDocumentRejection extends Error {
  constructor(readonly httpStatus: number, readonly sapCode?: number) {
    super("SAP definitively rejected a GGF posting document");
  }
}

const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /password|cookie|token|session|authorization/i.test(key) ? "[REDACTED]" : sanitize(item)]));
}

async function assertPersistedIntegrity(bundle: PersistedGgfPostingBundle, requestedClosingId: string,
  planVersion: number): Promise<void> {
  const plan = bundle.plan;
  if (!bundle.metadataAvailable || bundle.closingIntegrity === "INTEGRITY_VIOLATION")
    throw new Error("SAP metadata or closing integrity is not verified");
  if (bundle.closingId !== requestedClosingId || plan.closingId !== requestedClosingId ||
      plan.version !== planVersion || plan.closingVersion !== bundle.closingVersion ||
      plan.companyDB !== bundle.companyDB || plan.sourceMode !== "SAP_READ_ONLY")
    throw new Error("Persisted closing and PostingPlan identity differs");
  if (!bundle.closingPostingHash || bundle.closingPostingHash !== plan.postingHash ||
      bundle.planReadbackHash !== plan.postingHash || await calculateGgfPostingPlanHash(plan) !== plan.postingHash)
    throw new Error("Persisted closing/PostingPlan hash differs");
}

async function assertReady(bundle: PersistedGgfPostingBundle, requestedClosingId: string, planVersion: number): Promise<void> {
  await assertPersistedIntegrity(bundle, requestedClosingId, planVersion);
  const plan = bundle.plan;
  if (bundle.closingStatus !== "READY_TO_POST") throw new Error("Persisted closing/PostingPlan status differs");
  if (plan.status !== "VALIDATED" || plan.totalBlocked !== "0" || plan.totalDifference !== "0" ||
      plan.accountingDifference !== "0" || plan.blockers.length || plan.postingBlocked !== true)
    throw new Error("PostingPlan is blocked or not reconciled");
  const required = plan.documents.filter(document => document.status !== "NOT_REQUIRED");
  if (!required.length || required.some(document => document.status !== "VALIDATED" || document.blockers.length ||
      document.lines.some(line => line.status !== "VALIDATED" || line.blockers.length || !line.debitAccount || !line.creditAccount)))
    throw new Error("PostingPlan contains a blocked document, line or account");
  if (plan.lines.some(line => line.status !== "READY" || line.blockers.length))
    throw new Error("PostingPlan contains blocked accounting lines");
  for (const document of required) {
    const total = document.lines.reduce((sum, line) => sum + BigInt(line.amountCents), 0n);
    if (total !== BigInt(document.totalCents)) throw new Error("PostingPlan document total differs from its lines");
    if (document.type === "MaterialRevaluation") {
      for (const line of document.lines) {
        const source = plan.lines.filter(row => line.sourceOrderRefs.includes(row.id));
        if (!source.length || source.some(row => !row.valuationMethod ||
            !bundle.homologatedValuationMethods.includes(row.valuationMethod)))
          throw new Error("MaterialRevaluation valuation method is not homologated");
      }
    }
  }
  const documentTotal = (type: GgfPostingPlanDocument["type"]) => required
    .filter(document => document.type === type).reduce((sum, document) => sum + BigInt(document.totalCents), 0n);
  if (documentTotal("MaterialRevaluation") !== BigInt(plan.totalStock) ||
      documentTotal("JournalEntry.CPV") !== BigInt(plan.totalCpv) ||
      documentTotal("JournalEntry.Closing") !== BigInt(plan.totalStock) + BigInt(plan.totalCpv))
    throw new Error("PostingPlan destination totals do not reconcile to its documents");
}

function createExecution(bundle: PersistedGgfPostingBundle, documents: GgfPostingDocumentLink[], status: GgfPostingExecutionStatus,
  at: string, error: string | null = null): GgfPostingExecution {
  return { closingId: bundle.closingId, closingVersion: bundle.closingVersion,
    lifecycleVersion: bundle.lifecycleVersion,
    postingPlanVersion: bundle.plan.version, postingHash: bundle.plan.postingHash,
    status, createdAt: at, updatedAt: at, claimedAt: null, claimedBy: bundle.user,
    documents, error };
}

/** No UI wiring: every transition is based on a fresh SAP read and an append-only execution record. */
export class GgfPostingOrchestrator {
  constructor(private readonly store: GgfPostingOrchestrationStore, private readonly gateway: GgfPostingDocumentGateway,
    private readonly now: () => string = () => new Date().toISOString()) {}

  async prepare(closingId: string, postingPlanVersion: number): Promise<GgfPostingExecution> {
    const bundle = await this.store.load(closingId, postingPlanVersion);
    assertReady(bundle, closingId, postingPlanVersion);
    if (await this.store.getClaim(closingId)) throw new Error("Financial claim already exists; reconcile instead of preparing again");
    const prior = await this.store.latest(closingId, postingPlanVersion);
    if (prior && prior.status !== "FAILED") throw new Error(`Execution ${prior.status} cannot be prepared again`);
    const at = this.now();
    const documents = bundle.plan.documents.filter(document => document.status !== "NOT_REQUIRED")
      .sort((a, b) => a.order - b.order).map(document => ({ documentType: document.type,
        order: document.order, expectedCents: document.totalCents, request: {}, response: null,
        docEntry: null, docNum: null, transId: null, status: "PENDING" as const,
        reconciliation: "NOT_RUN" as const, error: null }));
    const execution = createExecution(bundle, documents, "READY_TO_POST", at);
    await this.store.append(execution);
    return execution;
  }

  async post(closingId: string, postingPlanVersion: number): Promise<GgfPostingExecution> {
    const bundle = await this.store.load(closingId, postingPlanVersion);
    const execution = await this.store.latest(closingId, postingPlanVersion);
    await assertPersistedIntegrity(bundle, closingId, postingPlanVersion);
    const priorClaim = await this.store.getClaim(closingId);
    if (priorClaim) {
      if (execution && ["POSTED", "FAILED"].includes(execution.status)) return execution;
      if (execution) return this.reconcileExisting(bundle, execution, priorClaim);
      const at = this.now();
      const documents = bundle.plan.documents.filter(document => document.status !== "NOT_REQUIRED")
        .sort((a, b) => a.order - b.order).map(document => ({ documentType: document.type,
          order: document.order, expectedCents: document.totalCents, request: {}, response: null,
          docEntry: null, docNum: null, transId: null, status: "PENDING" as const,
          reconciliation: "NOT_RUN" as const, error: null }));
      const lifecycleVersion = bundle.closingStatus === "READY_TO_POST"
        ? await this.store.transitionClosing({ closingId, expectedVersion: bundle.lifecycleVersion,
          expectedStatus: bundle.closingStatus, status: "POSTING_UNCERTAIN", postingHash: bundle.plan.postingHash,
          postingPlanVersion, error: "CLAIM_WITHOUT_EXECUTION_SNAPSHOT" })
        : bundle.lifecycleVersion;
      const uncertain = { ...createExecution(bundle, documents, "POSTING_UNCERTAIN", at,
        "CLAIM_WITHOUT_EXECUTION_SNAPSHOT"), lifecycleVersion, claimedAt: priorClaim.claimedAt,
        claimedBy: priorClaim.claimedBy };
      await this.store.append(uncertain);
      return uncertain;
    }
    await assertReady(bundle, closingId, postingPlanVersion);
    if (!execution || execution.status !== "READY_TO_POST" || execution.postingHash !== bundle.plan.postingHash ||
        execution.closingVersion !== bundle.closingVersion)
      throw new Error("A fresh READY_TO_POST execution linked to this exact SAP PostingPlan is required");
    const claimedAt = this.now();
    const claim: GgfPostingClaim = { closingId, postingHash: bundle.plan.postingHash,
      closingVersion: bundle.closingVersion, postingPlanVersion, claimedAt, claimedBy: bundle.user };
    try { await this.store.claim(claim); }
    catch {
      const persisted = await this.store.getClaim(closingId);
      if (!persisted) throw new Error("SAP claim failed without a readable claim; no financial POST was sent");
      return this.reconcileExisting(bundle, execution, persisted);
    }
    const posting: GgfPostingExecution = { ...execution, status: "POSTING", claimedAt,
      updatedAt: claimedAt, claimedBy: bundle.user };
    const postingVersion = await this.store.transitionClosing({ closingId, expectedVersion: bundle.lifecycleVersion,
      expectedStatus: "READY_TO_POST", status: "POSTING", postingHash: bundle.plan.postingHash,
      postingPlanVersion, error: null });
    const current = { ...posting, lifecycleVersion: postingVersion };
    await this.store.append(current);
    return this.execute(bundle, current);
  }

  async reconcile(closingId: string, postingPlanVersion: number): Promise<GgfPostingExecution> {
    const bundle = await this.store.load(closingId, postingPlanVersion);
    await assertPersistedIntegrity(bundle, closingId, postingPlanVersion);
    const execution = await this.store.latest(closingId, postingPlanVersion);
    const claim = await this.store.getClaim(closingId);
    if (!execution || !claim || !["POSTING", "POSTING_PARTIAL", "POSTING_UNCERTAIN"].includes(execution.status))
      throw new Error("Execution has no uncertain/partial SAP claim to reconcile");
    if (claim.postingHash !== bundle.plan.postingHash || claim.postingPlanVersion !== postingPlanVersion ||
        execution.postingHash !== bundle.plan.postingHash)
      throw new Error("Persisted claim and PostingPlan differ");
    return this.reconcileExisting(bundle, execution, claim);
  }

  private async execute(bundle: PersistedGgfPostingBundle, initial: GgfPostingExecution): Promise<GgfPostingExecution> {
    let documents = structuredClone(initial.documents);
    for (let index = 0; index < documents.length; index++) {
      const state = documents[index]!;
      const planned = bundle.plan.documents.find(document => document.type === state.documentType && document.order === state.order);
      if (!planned) return this.save(bundle, initial, documents, "POSTING_UNCERTAIN", "PERSISTED_DOCUMENT_PLAN_MISSING");
      let prepared: PreparedGgfPostingDocument;
      try { prepared = await this.gateway.prepare(planned, { closingId: bundle.closingId,
        closingVersion: bundle.closingVersion, postingPlanVersion: bundle.plan.version, postingHash: bundle.plan.postingHash }); }
      catch { return this.fail(bundle, initial, documents, index, "DOCUMENT_PAYLOAD_PREPARATION_FAILED", true); }
      if (prepared.expectedCents !== planned.totalCents || !Object.keys(prepared.payload).length)
        return this.fail(bundle, initial, documents, index, "DOCUMENT_PAYLOAD_DIFFERS_FROM_PLAN", true);
      documents[index] = { ...state, request: sanitize(prepared.payload) as Record<string, unknown>, status: "POSTING" };
      initial = await this.save(bundle, initial, documents, "POSTING");
      try {
        const result = await this.gateway.post(state.documentType, prepared.payload);
        if (!positive(result.docEntry) || !positive(result.docNum) || !positive(result.transId))
          return this.fail(bundle, initial, documents, index, "DOCUMENT_RESPONSE_INCOMPLETE", false);
        documents[index] = { ...documents[index]!, response: sanitize(result.response) as Record<string, unknown>,
          docEntry: result.docEntry, docNum: result.docNum, transId: result.transId };
      } catch (error) {
        if (error instanceof DefiniteGgfDocumentRejection)
          return this.fail(bundle, initial, documents, index,
            `SAP_REJECTED_HTTP_${error.httpStatus}_CODE_${error.sapCode ?? "UNKNOWN"}`, true);
        return this.fail(bundle, initial, documents, index, "POST_RESPONSE_UNKNOWN", false);
      }
      const reconciled = await this.reconcileDocument(bundle, documents[index]!);
      documents[index] = reconciled;
      if (reconciled.status !== "POSTED")
        return this.save(bundle, initial, documents, reconciled.reconciliation === "AMBIGUOUS" ? "POSTING_UNCERTAIN" : "POSTING_UNCERTAIN",
          "DOCUMENT_RECONCILIATION_UNPROVEN");
      initial = await this.save(bundle, initial, documents, "POSTING");
    }
    return this.save(bundle, initial, documents, "POSTED");
  }

  private async reconcileDocument(bundle: PersistedGgfPostingBundle, line: GgfPostingDocumentLink): Promise<GgfPostingDocumentLink> {
    try {
      const found = await this.gateway.reconcile({ closingId: bundle.closingId, documentType: line.documentType,
        expectedCents: line.expectedCents, knownDocEntry: line.docEntry, payload: line.request });
      if (!found.complete) return { ...line, status: "UNCERTAIN", reconciliation: "NO_MATCH", error: "RECONCILIATION_INCOMPLETE" };
      if (found.matches.length !== 1) return { ...line, status: "UNCERTAIN",
        reconciliation: found.matches.length ? "AMBIGUOUS" : "NO_MATCH", error: "RECONCILIATION_NOT_UNIQUE" };
      const match = found.matches[0]!;
      if (line.docEntry !== null && line.docEntry !== match.docEntry)
        return { ...line, status: "UNCERTAIN", reconciliation: "AMBIGUOUS", error: "DOCUMENT_IDENTITY_DIFFERS" };
      return { ...line, status: "POSTED", reconciliation: "MATCHED", docEntry: match.docEntry,
        docNum: match.docNum, transId: match.transId, response: sanitize(match.response) as Record<string, unknown>, error: null };
    } catch { return { ...line, status: "UNCERTAIN", reconciliation: "NO_MATCH", error: "RECONCILIATION_UNAVAILABLE" }; }
  }

  private async reconcileExisting(bundle: PersistedGgfPostingBundle, execution: GgfPostingExecution | null,
    claim: GgfPostingClaim): Promise<GgfPostingExecution> {
    if (!execution) throw new Error("Existing claim has no execution snapshot; automatic POST is blocked");
    if (claim.postingHash !== bundle.plan.postingHash || claim.closingVersion !== execution.closingVersion ||
        claim.postingPlanVersion !== bundle.plan.version) {
      return this.save(bundle, execution, execution.documents, "POSTING_UNCERTAIN", "EXISTING_CLAIM_CONFLICT");
    }
    const documents = [...execution.documents];
    for (let index = 0; index < documents.length; index++) {
      const line = documents[index]!;
      if (line.status === "POSTED" && line.reconciliation === "MATCHED") continue;
      if (!Object.keys(line.request).length) {
        if (line.status === "PENDING") continue;
        return this.save(bundle, execution, documents, "POSTING_UNCERTAIN", "DISPATCHED_DOCUMENT_REQUEST_MISSING");
      }
      documents[index] = await this.reconcileDocument(bundle, documents[index]!);
      if (documents[index]!.status !== "POSTED")
        return this.save(bundle, execution, documents, "POSTING_UNCERTAIN", "RECOVERY_NOT_PROVEN");
    }
    if (documents.some(line => line.status === "PENDING"))
      return this.save(bundle, execution, documents, documents.some(line => line.status === "POSTED") ?
        "POSTING_PARTIAL" : "POSTING_UNCERTAIN", "UNSENT_DOCUMENTS_REQUIRE_EXPLICIT_CONTINUATION");
    return this.save(bundle, execution, documents, "POSTED");
  }

  private async fail(bundle: PersistedGgfPostingBundle, execution: GgfPostingExecution,
    lines: GgfPostingDocumentLink[], failedIndex: number, reason: string, definite: boolean): Promise<GgfPostingExecution> {
    lines[failedIndex] = { ...lines[failedIndex]!, status: definite ? "FAILED" : "UNCERTAIN", error: reason,
      reconciliation: definite ? "NO_MATCH" : "NOT_RUN" };
    const priorPosted = lines.some((line, index) => index < failedIndex && line.status === "POSTED");
    return this.save(bundle, execution, lines, definite && !priorPosted ? "FAILED" :
      definite ? "POSTING_PARTIAL" : "POSTING_UNCERTAIN", reason);
  }

  private async save(bundle: PersistedGgfPostingBundle, previous: GgfPostingExecution,
    documents: GgfPostingDocumentLink[], status: GgfPostingExecutionStatus, error: string | null = null): Promise<GgfPostingExecution> {
    const at = this.now();
    const lifecycleVersion = status === previous.status ? previous.lifecycleVersion :
      await this.store.transitionClosing({ closingId: bundle.closingId,
        expectedVersion: previous.lifecycleVersion, expectedStatus: previous.status, status,
        postingHash: bundle.plan.postingHash, postingPlanVersion: bundle.plan.version, error });
    const next = { ...previous, lifecycleVersion, status, updatedAt: at, documents: structuredClone(documents), error };
    await this.store.append(next);
    return next;
  }
}
