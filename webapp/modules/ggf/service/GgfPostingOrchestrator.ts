import { calculateGgfPostingPlanHash, type GgfPostingPlan, type GgfPostingPlanDocument } from "./GgfPostingPlan";
import { calculateGgfExecutionId, calculateGgfRequestHash, type GgfDocumentExecutionStatus,
  type GgfPostingExecutionIdentity } from "./GgfPostingExecution";

export type GgfPostingExecutionStatus =
  | "READY_TO_POST" | "POSTING" | "POSTING_PARTIAL" | "POSTING_UNCERTAIN" | "POSTED" | "FAILED"
  | "PAYLOAD_INTEGRITY_VIOLATION";

export interface GgfPostingDocumentLink {
  documentType: GgfPostingPlanDocument["type"];
  order: number;
  expectedCents: string;
  request: Record<string, unknown>;
  response: Record<string, unknown> | null;
  currency: string | null;
  docEntry: number | null;
  docNum: number | null;
  transId: number | null;
  status: "PENDING" | "SENDING" | "SENT" | "RECONCILED" | "FAILED" | "UNCERTAIN";
  reconciliation: "NOT_RUN" | "MATCHED" | "NO_MATCH" | "AMBIGUOUS" | "INCOMPLETE";
  requestHash: string | null;
  attemptCount: number;
  attemptStartedAt: string | null;
  responseReceivedAt: string | null;
  reconciledAt: string | null;
  dependencies: string[];
  attempts: Array<{ attempt: number; requestHash: string; startedAt: string; responseReceivedAt: string | null;
    status: GgfDocumentExecutionStatus; sanitizedError: string | null }>;
  error: string | null;
}

export interface GgfPostingExecution {
  executionId: string;
  closingId: string;
  /** Version bound into the PostingPlan and claim; it never changes during posting. */
  closingVersion: number;
  /** Compare-and-set version of the mutable lifecycle header. */
  lifecycleVersion: number;
  postingPlanVersion: number;
  postingHash: string;
  status: GgfPostingExecutionStatus;
  createdAt: string;
  finishedAt: string | null;
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
  closingBoundPlanHash?: string | null;
  closingIntegrity: "VALID" | "NOT_APPLICABLE" | "INTEGRITY_VIOLATION";
  plan: GgfPostingPlan;
  planReadbackHash: string;
  metadataAvailable: boolean;
  homologatedValuationMethods: string[];
  companyDB: string;
  user: string | null;
}

export interface GgfPostingClaim {
  executionId: string;
  closingId: string;
  postingHash: string;
  closingVersion: number;
  postingPlanVersion: number;
  status: string;
  updatedAt: string;
  claimedAt: string;
  claimedBy: string | null;
}

export interface GgfPostingOrchestrationStore {
  /** Must reread closing, plan and their hashes directly from SAP on every call. */
  load(closingId: string, postingPlanVersion: number): Promise<PersistedGgfPostingBundle>;
  getClaim(executionId: string): Promise<GgfPostingClaim | null>;
  findExecution(executionId: string): Promise<GgfPostingExecution | null>;
  /** Must rely on SAP Code uniqueness; claims are permanent and never auto-deleted. */
  claim(claim: GgfPostingClaim): Promise<void>;
  updateClaim(executionId: string, status: GgfPostingExecutionStatus, updatedAt: string): Promise<void>;
  /** Append-only persistence for execution status and per-document audit. */
  append(execution: GgfPostingExecution): Promise<void>;
  latest(executionId: string): Promise<GgfPostingExecution | null>;
  /** Updates the persisted closing status/version using compare-and-set semantics. */
  transitionClosing(input: {
    closingId: string; expectedVersion: number; expectedStatus: string; status: GgfPostingExecutionStatus;
    postingHash: string; postingPlanVersion: number; error: string | null;
    documentLink?: { documentType: GgfPostingPlanDocument["type"]; docEntry: number; docNum: number;
      transId: number; postedAt: string };
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
  const closingPlanHash = bundle.closingBoundPlanHash ?? bundle.closingPostingHash;
  if (!bundle.closingPostingHash || closingPlanHash !== plan.postingHash ||
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
  if (plan.technicalOnly === true) {
    if (plan.closingId.startsWith("TECH7D-")) {
      const document = required[0];
      const expected = [
        { debitAccount: "5.04.01.01.05", creditAccount: "5.04.01.01.03", amountCents: "60" },
        { debitAccount: "5.04.01.01.05", creditAccount: "5.04.01.01.04", amountCents: "40" }
      ];
      if (!/^TECH7D-20261001-[A-F0-9]{10}$/.test(plan.closingId) || plan.companyDB !== "SBODEMOBR2" ||
          plan.periodStart !== "2026-10-01" || plan.periodEnd !== "2026-10-01" || plan.branch !== "1" ||
          plan.currency !== "R$" || plan.documents.length !== 1 || required.length !== 1 ||
          document?.type !== "JournalEntry.Closing" || document.totalCents !== "100" ||
          document.currency !== "R$" || document.lines.length !== 2 ||
          expected.some((line, index) => document.lines[index]?.debitAccount !== line.debitAccount ||
            document.lines[index]?.creditAccount !== line.creditAccount ||
            document.lines[index]?.amountCents !== line.amountCents || document.lines[index]?.dimensions.length !== 0) ||
          plan.lines.length !== 2 || plan.totalGgf !== "60" || plan.totalMod !== "40" ||
          plan.totalStock !== "0" || plan.totalCpv !== "0" || plan.totalBlocked !== "0" ||
          plan.totalDifference !== "0" || plan.accountingDifference !== "0" || plan.blockers.length)
        throw new Error("Technical closing Journal Entry plan is outside the approved R$ 1.00 GGF/MOD scenario");
      return;
    }
    if (!/^TECH7C-[A-Z0-9-]{8,22}$/.test(plan.closingId) || plan.companyDB !== "SBODEMOBR2" ||
        plan.periodStart !== "2026-10-01" || plan.periodEnd !== "2026-10-01" || plan.branch !== "1" ||
        plan.documents.length !== 1 || required.length !== 1 || required[0]?.type !== "JournalEntry.CPV" ||
        required[0].totalCents !== "100" || required[0].currency !== "R$" || required[0].lines.length !== 1 ||
        required[0].lines[0]?.debitAccount !== "5.01.01.01.01" ||
        required[0].lines[0]?.creditAccount !== "5.04.01.01.05" || required[0].lines[0]?.amountCents !== "100" ||
        required[0].lines[0]?.dimensions.length !== 0 || plan.lines.length !== 1 ||
        plan.lines[0]?.debitAccounts.join() !== "5.01.01.01.01" ||
        plan.lines[0]?.creditAccounts.join() !== "5.04.01.01.05" || plan.lines[0]?.amountCents !== "100" ||
        plan.totalMod !== "0" || plan.totalGgf !== "100" || plan.totalStock !== "0" || plan.totalCpv !== "100" ||
        plan.totalBlocked !== "0" ||
        plan.totalDifference !== "0" || plan.accountingDifference !== "0" || plan.blockers.length)
      throw new Error("Technical Journal Entry homologation plan is outside the approved one-cent scenario");
    return;
  }
  const documentTotal = (type: GgfPostingPlanDocument["type"]) => required
    .filter(document => document.type === type).reduce((sum, document) => sum + BigInt(document.totalCents), 0n);
  if (documentTotal("MaterialRevaluation") !== BigInt(plan.totalStock) ||
      documentTotal("JournalEntry.CPV") !== BigInt(plan.totalCpv) ||
      documentTotal("JournalEntry.Closing") !== BigInt(plan.totalStock) + BigInt(plan.totalCpv))
    throw new Error("PostingPlan destination totals do not reconcile to its documents");
}

function createExecution(bundle: PersistedGgfPostingBundle, documents: GgfPostingDocumentLink[], status: GgfPostingExecutionStatus,
  at: string, executionId: string, error: string | null = null): GgfPostingExecution {
  return { executionId, closingId: bundle.closingId, closingVersion: bundle.closingVersion,
    lifecycleVersion: bundle.lifecycleVersion,
    postingPlanVersion: bundle.plan.version, postingHash: bundle.plan.postingHash,
    status, createdAt: at, finishedAt: null, updatedAt: at, claimedAt: null, claimedBy: bundle.user,
    documents, error };
}

function executionIdentity(bundle: PersistedGgfPostingBundle): GgfPostingExecutionIdentity {
  return { closingId: bundle.closingId, closingVersion: bundle.closingVersion,
    postingPlanVersion: bundle.plan.version, postingHash: bundle.plan.postingHash };
}

function createDocumentLinks(bundle: PersistedGgfPostingBundle): GgfPostingDocumentLink[] {
  return bundle.plan.documents.filter(document => document.status !== "NOT_REQUIRED")
    .sort((a, b) => a.order - b.order).map(document => ({ documentType: document.type,
      order: document.order, expectedCents: document.totalCents, request: {}, response: null,
      currency: document.currency,
      docEntry: null, docNum: null, transId: null, status: "PENDING" as const,
      reconciliation: "NOT_RUN" as const, requestHash: null, attemptCount: 0,
      attemptStartedAt: null, responseReceivedAt: null, reconciledAt: null,
      dependencies: [...document.dependencies], attempts: [], error: null }));
}

function requiresPreviousReconciliation(document: GgfPostingPlanDocument): boolean {
  return document.type === "JournalEntry.Closing" || document.dependencies.includes("MATERIAL_REVALUATION_AND_CPV_PLANS");
}

/** No UI wiring: every transition is based on a fresh SAP read and an append-only execution record. */
export class GgfPostingOrchestrator {
  constructor(private readonly store: GgfPostingOrchestrationStore, private readonly gateway: GgfPostingDocumentGateway,
    private readonly now: () => string = () => new Date().toISOString()) {}

  async prepare(closingId: string, postingPlanVersion: number): Promise<GgfPostingExecution> {
    const bundle = await this.store.load(closingId, postingPlanVersion);
    assertReady(bundle, closingId, postingPlanVersion);
    const executionId = await calculateGgfExecutionId(executionIdentity(bundle));
    if (await this.store.getClaim(executionId)) throw new Error("Financial claim already exists; reconcile instead of preparing again");
    const prior = await this.store.latest(executionId);
    if (prior) throw new Error(`Execution ${prior.status} cannot be prepared again`);
    const at = this.now();
    const documents = createDocumentLinks(bundle);
    const execution = createExecution(bundle, documents, "READY_TO_POST", at, executionId);
    await this.store.append(execution);
    return execution;
  }

  async post(closingId: string, postingPlanVersion: number): Promise<GgfPostingExecution> {
    const bundle = await this.store.load(closingId, postingPlanVersion);
    await assertPersistedIntegrity(bundle, closingId, postingPlanVersion);
    const executionId = await calculateGgfExecutionId(executionIdentity(bundle));
    const execution = await this.store.latest(executionId);
    const priorClaim = await this.store.getClaim(executionId);
    if (priorClaim) {
      if (execution && ["POSTED", "FAILED"].includes(execution.status)) return execution;
      if (execution) return this.reconcileExisting(bundle, execution, priorClaim);
      const at = this.now();
      const documents = createDocumentLinks(bundle);
      const lifecycleVersion = bundle.closingStatus === "READY_TO_POST"
        ? await this.store.transitionClosing({ closingId, expectedVersion: bundle.lifecycleVersion,
          expectedStatus: bundle.closingStatus, status: "POSTING_UNCERTAIN", postingHash: bundle.plan.postingHash,
          postingPlanVersion, error: "CLAIM_WITHOUT_EXECUTION_SNAPSHOT" })
        : bundle.lifecycleVersion;
      const uncertain = { ...createExecution(bundle, documents, "POSTING_UNCERTAIN", at, executionId,
        "CLAIM_WITHOUT_EXECUTION_SNAPSHOT"), lifecycleVersion, claimedAt: priorClaim.claimedAt,
        claimedBy: priorClaim.claimedBy };
      await this.store.append(uncertain);
      await this.store.updateClaim(executionId, "POSTING_UNCERTAIN", at);
      return uncertain;
    }
    await assertReady(bundle, closingId, postingPlanVersion);
    if (!execution || execution.status !== "READY_TO_POST" || execution.postingHash !== bundle.plan.postingHash ||
        execution.closingVersion !== bundle.closingVersion)
      throw new Error("A fresh READY_TO_POST execution linked to this exact SAP PostingPlan is required");
    const claimedAt = this.now();
    const claim: GgfPostingClaim = { executionId, closingId, postingHash: bundle.plan.postingHash,
      closingVersion: bundle.closingVersion, postingPlanVersion, claimedAt, claimedBy: bundle.user,
      status: "CLAIMED", updatedAt: claimedAt };
    try { await this.store.claim(claim); }
    catch {
      const persisted = await this.store.getClaim(executionId);
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
    await this.store.updateClaim(executionId, "POSTING", claimedAt);
    return this.execute(bundle, current);
  }

  async reconcile(closingId: string, postingPlanVersion: number): Promise<GgfPostingExecution> {
    const bundle = await this.store.load(closingId, postingPlanVersion);
    await assertPersistedIntegrity(bundle, closingId, postingPlanVersion);
    const identity = executionIdentity(bundle);
    const executionId = await calculateGgfExecutionId(identity);
    const execution = await this.store.latest(executionId);
    const claim = await this.store.getClaim(executionId);
    if (!execution || !claim || !["POSTING", "POSTING_PARTIAL", "POSTING_UNCERTAIN"].includes(execution.status))
      throw new Error("Execution has no uncertain/partial SAP claim to reconcile");
    if (claim.postingHash !== bundle.plan.postingHash || claim.closingVersion !== bundle.closingVersion ||
        claim.postingPlanVersion !== postingPlanVersion || execution.postingHash !== bundle.plan.postingHash ||
        execution.executionId !== executionId)
      throw new Error("Persisted claim and PostingPlan differ");
    return this.reconcileExisting(bundle, execution, claim);
  }

  async resumeExecution(executionId: string): Promise<GgfPostingExecution> {
    const stored = await this.store.findExecution(executionId);
    if (!stored) throw new Error("Posting execution does not exist in SAP");
    if (stored.status === "FAILED" || stored.documents.some(document => document.status === "FAILED"))
      throw new Error("FAILED execution requires explicit administrative treatment");
    if (stored.status === "PAYLOAD_INTEGRITY_VIOLATION")
      throw new Error("PAYLOAD_INTEGRITY_VIOLATION blocks execution recovery");
    const bundle = await this.store.load(stored.closingId, stored.postingPlanVersion);
    await assertPersistedIntegrity(bundle, stored.closingId, stored.postingPlanVersion);
    const identity = executionIdentity(bundle);
    if (await calculateGgfExecutionId(identity) !== executionId || stored.executionId !== executionId ||
        stored.closingVersion !== identity.closingVersion || stored.postingHash !== identity.postingHash)
      return this.save(bundle, stored, stored.documents, "PAYLOAD_INTEGRITY_VIOLATION", "EXECUTION_IDENTITY_CHANGED");
    const claim = await this.store.getClaim(executionId);
    if (!claim) {
      if (stored.status === "READY_TO_POST" && stored.documents.every(document => document.status === "PENDING")) return stored;
      throw new Error("Execution state has no persistent SAP claim; recovery is blocked");
    }
    if (claim.executionId !== executionId || claim.postingHash !== identity.postingHash ||
        claim.closingVersion !== identity.closingVersion || claim.postingPlanVersion !== identity.postingPlanVersion)
      return this.save(bundle, stored, stored.documents, "PAYLOAD_INTEGRITY_VIOLATION", "CLAIM_IDENTITY_CHANGED");
    return this.reconcileExisting(bundle, stored, claim);
  }

  private async execute(bundle: PersistedGgfPostingBundle, initial: GgfPostingExecution): Promise<GgfPostingExecution> {
    let documents = structuredClone(initial.documents);
    for (let index = 0; index < documents.length; index++) {
      const state = documents[index]!;
      const planned = bundle.plan.documents.find(document => document.type === state.documentType && document.order === state.order);
      if (!planned) return this.save(bundle, initial, documents, "POSTING_UNCERTAIN", "PERSISTED_DOCUMENT_PLAN_MISSING");
      if (state.status === "RECONCILED") continue;
      if (requiresPreviousReconciliation(planned) && documents.slice(0, index)
          .some(previous => previous.status !== "RECONCILED"))
        return this.save(bundle, initial, documents, "POSTING_PARTIAL", "DOCUMENT_DEPENDENCY_NOT_RECONCILED");
      let prepared: PreparedGgfPostingDocument;
      try { prepared = await this.gateway.prepare(planned, { closingId: bundle.closingId,
        closingVersion: bundle.closingVersion, postingPlanVersion: bundle.plan.version, postingHash: bundle.plan.postingHash }); }
      catch { return this.fail(bundle, initial, documents, index, "DOCUMENT_PAYLOAD_PREPARATION_FAILED", true); }
      if (prepared.expectedCents !== planned.totalCents || !Object.keys(prepared.payload).length)
        return this.fail(bundle, initial, documents, index, "DOCUMENT_PAYLOAD_DIFFERS_FROM_PLAN", true);
      const request = sanitize(prepared.payload) as Record<string, unknown>;
      const requestHash = await calculateGgfRequestHash(request);
      if (state.requestHash && state.requestHash !== requestHash)
        return this.save(bundle, initial, documents, "PAYLOAD_INTEGRITY_VIOLATION", "PAYLOAD_REBUILT_HASH_DIFFERS");
      const attemptStartedAt = this.now();
      documents[index] = { ...state, request, requestHash, status: "SENDING", attemptCount: state.attemptCount + 1,
        attemptStartedAt, responseReceivedAt: null, attempts: [...state.attempts, { attempt: state.attemptCount + 1,
          requestHash, startedAt: attemptStartedAt, responseReceivedAt: null, status: "SENDING", sanitizedError: null }] };
      initial = await this.save(bundle, initial, documents, "POSTING");
      try {
        const result = await this.gateway.post(state.documentType, prepared.payload);
        if (!positive(result.docEntry) || !positive(result.docNum) || !positive(result.transId))
          return this.fail(bundle, initial, documents, index, "DOCUMENT_RESPONSE_INCOMPLETE", false);
        const responseReceivedAt = this.now();
        documents[index] = { ...documents[index]!, response: sanitize(result.response) as Record<string, unknown>,
          docEntry: result.docEntry, docNum: result.docNum, transId: result.transId, status: "SENT", responseReceivedAt,
          attempts: documents[index]!.attempts.map((attempt, attemptIndex) => attemptIndex === documents[index]!.attempts.length - 1
            ? { ...attempt, responseReceivedAt, status: "SENT" } : attempt) };
        initial = await this.save(bundle, initial, documents, "POSTING");
      } catch (error) {
        if (error instanceof DefiniteGgfDocumentRejection)
          return this.fail(bundle, initial, documents, index,
            `SAP_REJECTED_HTTP_${error.httpStatus}_CODE_${error.sapCode ?? "UNKNOWN"}`, true);
        return this.fail(bundle, initial, documents, index, "POST_RESPONSE_UNKNOWN", false);
      }
      const reconciled = await this.reconcileDocument(bundle, documents[index]!);
      documents[index] = reconciled;
      if (reconciled.status !== "RECONCILED")
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
      if (!found.complete) return { ...line, status: "UNCERTAIN", reconciliation: "INCOMPLETE", error: "RECONCILIATION_INCOMPLETE" };
      if (found.matches.length !== 1) return { ...line, status: "UNCERTAIN",
        reconciliation: found.matches.length ? "AMBIGUOUS" : "NO_MATCH", error: "RECONCILIATION_NOT_UNIQUE" };
      const match = found.matches[0]!;
      if (line.docEntry !== null && line.docEntry !== match.docEntry)
        return { ...line, status: "UNCERTAIN", reconciliation: "AMBIGUOUS", error: "DOCUMENT_IDENTITY_DIFFERS" };
      const reconciledAt = this.now();
      return { ...line, status: "RECONCILED", reconciliation: "MATCHED", docEntry: match.docEntry,
        docNum: match.docNum, transId: match.transId, reconciledAt,
        response: sanitize(match.response) as Record<string, unknown>, error: null,
        attempts: line.attempts.map((attempt, index) => index === line.attempts.length - 1
          ? { ...attempt, status: "RECONCILED" } : attempt) };
    } catch { return { ...line, status: "UNCERTAIN", reconciliation: "INCOMPLETE", error: "RECONCILIATION_UNAVAILABLE" }; }
  }

  private async reconcileExisting(bundle: PersistedGgfPostingBundle, execution: GgfPostingExecution | null,
    claim: GgfPostingClaim): Promise<GgfPostingExecution> {
    if (!execution) throw new Error("Existing claim has no execution snapshot; automatic POST is blocked");
    if (claim.executionId !== execution.executionId || claim.postingHash !== bundle.plan.postingHash || claim.closingVersion !== execution.closingVersion ||
        claim.postingPlanVersion !== bundle.plan.version) {
      return this.save(bundle, execution, execution.documents, "POSTING_UNCERTAIN", "EXISTING_CLAIM_CONFLICT");
    }
    const documents = [...execution.documents];
    for (let index = 0; index < documents.length; index++) {
      const line = documents[index]!;
      if (line.status === "RECONCILED" && line.reconciliation === "MATCHED") continue;
      if (!Object.keys(line.request).length) {
        if (line.status === "PENDING") continue;
        return this.save(bundle, execution, documents, "POSTING_UNCERTAIN", "DISPATCHED_DOCUMENT_REQUEST_MISSING");
      }
      const planned = bundle.plan.documents.find(document => document.type === line.documentType && document.order === line.order);
      if (!planned) return this.save(bundle, execution, documents, "PAYLOAD_INTEGRITY_VIOLATION", "PERSISTED_DOCUMENT_PLAN_MISSING");
      let rebuilt: PreparedGgfPostingDocument;
      try { rebuilt = await this.gateway.prepare(planned, { closingId: bundle.closingId,
        closingVersion: bundle.closingVersion, postingPlanVersion: bundle.plan.version, postingHash: bundle.plan.postingHash }); }
      catch { return this.save(bundle, execution, documents, "POSTING_UNCERTAIN", "PAYLOAD_REBUILD_FAILED"); }
      if (rebuilt.expectedCents !== line.expectedCents ||
          await calculateGgfRequestHash(sanitize(rebuilt.payload) as Record<string, unknown>) !== line.requestHash)
        return this.save(bundle, execution, documents, "PAYLOAD_INTEGRITY_VIOLATION", "PAYLOAD_REBUILT_HASH_DIFFERS");
      documents[index] = await this.reconcileDocument(bundle, documents[index]!);
      if (documents[index]!.status !== "RECONCILED")
        return this.save(bundle, execution, documents, "POSTING_UNCERTAIN", "RECOVERY_NOT_PROVEN");
    }
    if (documents.some(line => line.status === "PENDING"))
      return this.save(bundle, execution, documents, documents.some(line => line.status === "RECONCILED") ?
        "POSTING_PARTIAL" : "POSTING_UNCERTAIN", "UNSENT_DOCUMENTS_REQUIRE_EXPLICIT_CONTINUATION");
    return this.save(bundle, execution, documents, "POSTED");
  }

  private async fail(bundle: PersistedGgfPostingBundle, execution: GgfPostingExecution,
    lines: GgfPostingDocumentLink[], failedIndex: number, reason: string, definite: boolean): Promise<GgfPostingExecution> {
    const current = lines[failedIndex]!;
    lines[failedIndex] = { ...current, status: definite ? "FAILED" : "UNCERTAIN", error: reason,
      reconciliation: definite ? "NO_MATCH" : "NOT_RUN",
      attempts: current.attempts.map((attempt, index) => index === current.attempts.length - 1
        ? { ...attempt, status: definite ? "FAILED" : "UNCERTAIN", sanitizedError: reason } : attempt) };
    const priorPosted = lines.some((line, index) => index < failedIndex && line.status === "RECONCILED");
    return this.save(bundle, execution, lines, definite && !priorPosted ? "FAILED" :
      definite ? "POSTING_PARTIAL" : "POSTING_UNCERTAIN", reason);
  }

  private async save(bundle: PersistedGgfPostingBundle, previous: GgfPostingExecution,
    documents: GgfPostingDocumentLink[], status: GgfPostingExecutionStatus, error: string | null = null): Promise<GgfPostingExecution> {
    const at = this.now();
    const lifecycleVersion = status === previous.status ? previous.lifecycleVersion :
      await this.store.transitionClosing({ closingId: bundle.closingId,
        expectedVersion: previous.lifecycleVersion, expectedStatus: previous.status, status,
        postingHash: bundle.plan.postingHash, postingPlanVersion: bundle.plan.version, error,
        ...(status === "POSTED" ? (() => {
          const document = documents.find(row => row.status === "RECONCILED" && row.reconciliation === "MATCHED");
          if (!document || document.docEntry === null || document.docNum === null || document.transId === null)
            throw new Error("Posted closing requires a reconciled SAP document link");
          return { documentLink: { documentType: document.documentType, docEntry: document.docEntry,
            docNum: document.docNum, transId: document.transId, postedAt: at } };
        })() : {}) });
    const next = { ...previous, lifecycleVersion, status, updatedAt: at,
      finishedAt: ["POSTED", "FAILED", "PAYLOAD_INTEGRITY_VIOLATION"].includes(status) ? at : null,
      documents: structuredClone(documents), error };
    await this.store.append(next);
    if (status !== "READY_TO_POST") await this.store.updateClaim(next.executionId, status, at);
    return next;
  }
}
