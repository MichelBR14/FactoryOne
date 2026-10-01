import type { SlReadWrite } from "../../../core/data/SetupRepository";
import { SapGgfClosingRepository } from "./SapGgfClosingRepository";
import { SapGgfPostingPlanRepository } from "./SapGgfPostingPlanRepository";
import { SapGgfExecutionIntegrityError, SapGgfPostingClaimRepository,
  SapGgfPostingExecutionRepository } from "./SapGgfPostingExecutionRepository";
import { transitionClosing, type ClosingStatus } from "../service/GgfClosing";
import { calculateGgfExecutionId, executionTotals, type GgfPostingDocumentLedger,
  type GgfPostingExecutionRecord } from "../service/GgfPostingExecution";
import type { GgfPostingOrchestrationStore, GgfPostingExecution, GgfPostingClaim,
  PersistedGgfPostingBundle } from "../service/GgfPostingOrchestrator";

const executionStatus = (status: GgfPostingExecution["status"]): GgfPostingExecutionRecord["status"] =>
  status === "READY_TO_POST" ? "READY" : status;
const snapshotStatus = (status: GgfPostingExecutionRecord["status"]): GgfPostingExecution["status"] =>
  status === "READY" ? "READY_TO_POST" : status;

function asRecord(execution: GgfPostingExecution): GgfPostingExecutionRecord {
  const identity = { closingId: execution.closingId, closingVersion: execution.closingVersion,
    postingPlanVersion: execution.postingPlanVersion, postingHash: execution.postingHash };
  const documents: GgfPostingDocumentLedger[] = execution.documents.map(document => ({
    executionId: execution.executionId, identity, sequence: document.order, documentType: document.documentType,
    plannedAmount: document.expectedCents, currency: document.currency, status: document.status,
    requestHash: document.requestHash, request: Object.keys(document.request).length ? document.request : null,
    response: document.response, dependencies: document.dependencies, attemptCount: document.attemptCount,
    attemptStartedAt: document.attemptStartedAt, responseReceivedAt: document.responseReceivedAt,
    sapDocEntry: document.docEntry, sapDocNum: document.docNum, sapTransId: document.transId,
    reconciledAt: document.reconciledAt, reconciliationStatus: document.reconciliation === "INCOMPLETE" ? "INCOMPLETE" : document.reconciliation,
    sanitizedError: document.error, attempts: document.attempts
  }));
  const totals = executionTotals(documents);
  return { executionId: execution.executionId, identity, status: executionStatus(execution.status),
    startedAt: execution.createdAt, finishedAt: execution.finishedAt, startedBy: execution.claimedBy,
    lastError: execution.error, totalExpected: totals.expected, totalPosted: totals.posted,
    totalReconciled: totals.reconciled, documents };
}

function fromRecord(record: GgfPostingExecutionRecord, lifecycleVersion: number): GgfPostingExecution {
  return { executionId: record.executionId, closingId: record.identity.closingId,
    closingVersion: record.identity.closingVersion, lifecycleVersion,
    postingPlanVersion: record.identity.postingPlanVersion, postingHash: record.identity.postingHash,
    status: snapshotStatus(record.status), createdAt: record.startedAt, finishedAt: record.finishedAt,
    updatedAt: record.finishedAt ?? record.startedAt, claimedAt: null, claimedBy: record.startedBy,
    error: record.lastError, documents: record.documents.map(document => ({
      documentType: document.documentType as GgfPostingExecution["documents"][number]["documentType"],
      order: document.sequence, expectedCents: document.plannedAmount,
      request: document.request ?? {}, response: document.response, docEntry: document.sapDocEntry,
      docNum: document.sapDocNum, transId: document.sapTransId, status: document.status,
      currency: document.currency,
      reconciliation: document.reconciliationStatus, requestHash: document.requestHash,
      attemptCount: document.attemptCount, attemptStartedAt: document.attemptStartedAt,
      responseReceivedAt: document.responseReceivedAt, reconciledAt: document.reconciledAt,
      dependencies: document.dependencies, attempts: document.attempts, error: document.sanitizedError
    })) };
}

/** Binds the SAP closing and immutable plan repositories to the durable execution/document ledger. */
export class SapGgfPostingOrchestrationStore implements GgfPostingOrchestrationStore {
  private readonly closing: SapGgfClosingRepository;
  private readonly plans: SapGgfPostingPlanRepository;
  private readonly claims: SapGgfPostingClaimRepository;
  private readonly executions: SapGgfPostingExecutionRepository;

  constructor(private readonly client: SlReadWrite, private readonly homologatedValuationMethods: string[] = [],
    private readonly now = () => new Date().toISOString()) {
    this.closing = new SapGgfClosingRepository(client, { now });
    this.plans = new SapGgfPostingPlanRepository(client, now);
    this.claims = new SapGgfPostingClaimRepository(client);
    this.executions = new SapGgfPostingExecutionRepository(client);
  }

  async load(closingId: string, postingPlanVersion: number): Promise<PersistedGgfPostingBundle> {
    await this.plans.assertAvailable();
    await this.executions.assertAvailable();
    const [closing, plan] = await Promise.all([this.closing.get(closingId), this.plans.get(closingId, postingPlanVersion)]);
    if (!closing || !plan) throw new Error("Closing or PostingPlan is missing from SAP");
    const closingVersion = plan.closingVersion ?? closing.version;
    return { closingId, closingVersion, lifecycleVersion: closing.version, closingStatus: closing.status,
      closingPostingHash: closing.postingHash, closingIntegrity: closing.integrityStatus ?? "NOT_APPLICABLE",
      closingBoundPlanHash: closing.postingBasis?.postingPlanHash ?? null,
      plan, planReadbackHash: plan.postingHash, metadataAvailable: true,
      homologatedValuationMethods: [...this.homologatedValuationMethods], companyDB: closing.companyDB,
      user: plan.createdBy ?? closing.createdBy ?? null };
  }

  async getClaim(executionId: string): Promise<GgfPostingClaim | null> {
    const claim = await this.claims.get(executionId);
    return claim ? { ...claim, claimedAt: claim.createdAt, updatedAt: claim.updatedAt } : null;
  }

  async claim(claim: GgfPostingClaim): Promise<void> {
    const { executionId: expectedId, ...identity } = claim;
    if (await calculateGgfExecutionId(identity) !== expectedId) throw new Error("Claim ExecutionId differs from identity");
    await this.claims.claim(identity, claim.status, claim.claimedAt, claim.claimedBy);
  }

  async updateClaim(executionId: string, status: GgfPostingExecution["status"], updatedAt: string): Promise<void> {
    await this.claims.updateStatus(executionId, status, updatedAt);
  }

  async append(execution: GgfPostingExecution): Promise<void> {
    const record = asRecord(execution);
    let existing: GgfPostingExecutionRecord | null;
    try { existing = await this.executions.get(execution.executionId); }
    catch (error) {
      if (error instanceof SapGgfExecutionIntegrityError && error.message === "Execution/document ledger count differs" &&
          execution.status === "READY_TO_POST" && !await this.claims.get(execution.executionId)) {
        await this.executions.create(record);
        return;
      }
      throw error;
    }
    if (existing) await this.executions.save(record);
    else await this.executions.create(record);
  }

  async findExecution(executionId: string): Promise<GgfPostingExecution | null> {
    const record = await this.executions.get(executionId);
    if (!record) return null;
    const closing = await this.closing.get(record.identity.closingId);
    if (!closing) throw new Error("Execution references a missing SAP Closing");
    const expectedId = await calculateGgfExecutionId(record.identity);
    if (expectedId !== executionId) throw new Error("Persisted execution identity differs");
    return fromRecord(record, closing.version);
  }

  async latest(executionId: string): Promise<GgfPostingExecution | null> {
    try { return await this.findExecution(executionId); }
    catch (error) {
      if (error instanceof SapGgfExecutionIntegrityError && error.message === "Execution/document ledger count differs" &&
          !await this.claims.get(executionId)) return null;
      throw error;
    }
  }

  async transitionClosing(input: { closingId: string; expectedVersion: number; expectedStatus: string;
    status: GgfPostingExecution["status"]; postingHash: string; postingPlanVersion: number; error: string | null;
    documentLink?: { documentType: string; docEntry: number; docNum: number; transId: number; postedAt: string } }): Promise<number> {
    const current = await this.closing.get(input.closingId);
    if (!current || current.version !== input.expectedVersion || current.status !== input.expectedStatus)
      throw new Error("SAP closing changed before execution state transition");
    const target = input.status === "PAYLOAD_INTEGRITY_VIOLATION" ? "POSTING_UNCERTAIN" : input.status;
    const documentLink = input.documentLink;
    const expectedDocumentType = current.postingBasis?.documentType ?? "MaterialRevaluation";
    if (target === "POSTED" && (!documentLink || documentLink.documentType !== expectedDocumentType))
      throw new Error("Posted SAP document type/link differs from the bound closing basis");
    const next = { ...transitionClosing(current, target as ClosingStatus), postingHash: current.postingHash,
      lastError: input.error,
      ...(documentLink?.documentType === "JournalEntry.CPV" ? {
        sapJournalEntryDocEntry: documentLink.docEntry, sapJournalEntryDocNum: documentLink.docNum,
        sapJournalTransId: documentLink.transId, postedAt: documentLink.postedAt
      } : documentLink ? {
        sapMaterialRevaluationDocEntry: documentLink.docEntry, sapMaterialRevaluationDocNum: documentLink.docNum,
        sapJournalTransId: documentLink.transId, postedAt: documentLink.postedAt
      } : {}) };
    await this.closing.replace(current, next);
    return next.version;
  }
}
