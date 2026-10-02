import type { SlReadWrite } from "../../../core/data/SetupRepository";
import { tableName } from "../../../core/config/product";
import { ServiceLayerError } from "../../../core/service/errors";
import { assertExecutionIdentity, calculateGgfExecutionId, calculateGgfRequestHash, executionTotals,
  type GgfDocumentAttempt, type GgfPostingDocumentLedger, type GgfPostingExecutionIdentity,
  type GgfPostingExecutionRecord, type GgfPrePostRecoveryAudit } from "../service/GgfPostingExecution";

const EXEC = tableName("ggf", "PEXEC");
const DOC = tableName("ggf", "PDOC");
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const optional = (value: unknown) => value === null || value === undefined || value === "" ? null : String(value);
const sapNumber = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("Invalid SAP document identity in posting ledger");
  return parsed;
};

interface SapRow { Code: string; [key: string]: unknown }
interface SapPage { value: SapRow[]; "@odata.nextLink"?: string; "odata.nextLink"?: string }

export class SapGgfExecutionMetadataUnavailableError extends Error {
  readonly code = "SAP_EXECUTION_METADATA_UNAVAILABLE";
  constructor() { super("SAP posting execution ledger metadata is unavailable"); }
}

export class SapGgfExecutionIntegrityError extends Error {
  readonly code = "POSTING_EXECUTION_LEDGER_INTEGRITY_VIOLATION";
  constructor(message: string) { super(message); }
}

export class SapGgfExecutionWriteUncertainError extends Error {
  readonly code = "POSTING_EXECUTION_WRITE_UNCERTAIN";
  constructor(readonly httpStatus?: number, readonly sapCode?: number | string, localDiagnostic?: string) {
    const safe = localDiagnostic?.replace(/(password|cookie|token|session|authorization)\s*[:=]\s*\S+/ig, "$1=[REDACTED]")
      .replace(/[\r\n]/g, " ").slice(0, 160);
    super(`SAP execution ledger write is uncertain${httpStatus ? ` (HTTP ${httpStatus}${sapCode ? `, code ${sapCode}` : ""})` : ""}` +
      `${safe ? ` [${safe}]` : ""}; reread SAP before continuing`);
  }
}

function normalize(error: unknown): unknown {
  if (error instanceof ServiceLayerError && (error.status === 404 || error.status === 400 &&
      (Number(error.code) === -1002 || /Service Not Found/i.test(error.detail ?? error.message))))
    return new SapGgfExecutionMetadataUnavailableError();
  return error;
}

function headerBody(record: GgfPostingExecutionRecord): Record<string, string> {
  const totals = executionTotals(record.documents);
  if (record.totalExpected !== totals.expected || record.totalPosted !== totals.posted ||
      record.totalReconciled !== totals.reconciled) throw new Error("Execution header totals differ from document ledger");
  return { Code: record.executionId, Name: record.executionId,
    U_ClosingId: record.identity.closingId, U_ClosingVersion: String(record.identity.closingVersion),
    U_PostingPlanVersion: String(record.identity.postingPlanVersion), U_PostingHash: record.identity.postingHash,
    U_Status: record.status, U_StartedAt: record.startedAt, U_FinishedAt: record.finishedAt ?? "",
    U_StartedBy: record.startedBy ?? "", U_LastError: record.lastError ?? "",
    U_TotalExpected: record.totalExpected, U_TotalPosted: record.totalPosted,
    U_TotalReconciled: record.totalReconciled, U_DocumentCount: String(record.documents.length) };
}

function documentCode(executionId: string, sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999) throw new Error("Invalid ledger document sequence");
  const code = `${executionId}D${String(sequence).padStart(3, "0")}`;
  if (code.length > 50) throw new Error("SAP posting document ledger key exceeds Code length");
  return code;
}

function documentBody(document: GgfPostingDocumentLedger): Record<string, string> {
  return { Code: documentCode(document.executionId, document.sequence), Name: documentCode(document.executionId, document.sequence),
    U_ExecutionId: document.executionId, U_ClosingId: document.identity.closingId,
    U_ClosingVersion: String(document.identity.closingVersion),
    U_PostingPlanVersion: String(document.identity.postingPlanVersion), U_PostingHash: document.identity.postingHash,
    U_Sequence: String(document.sequence), U_DocumentType: document.documentType,
    U_PlannedAmount: document.plannedAmount, U_Currency: document.currency ?? "", U_Status: document.status,
    U_RequestHash: document.requestHash ?? "", U_Request: document.request ? JSON.stringify(document.request) : "",
    U_Response: document.response ? JSON.stringify(document.response) : "",
    U_Dependencies: JSON.stringify(document.dependencies), U_AttemptCount: String(document.attemptCount),
    U_AttemptStartedAt: document.attemptStartedAt ?? "", U_ResponseReceivedAt: document.responseReceivedAt ?? "",
    U_SapDocEntry: document.sapDocEntry === null ? "" : String(document.sapDocEntry),
    U_SapDocNum: document.sapDocNum === null ? "" : String(document.sapDocNum),
    U_SapTransId: document.sapTransId === null ? "" : String(document.sapTransId),
    U_ReconciledAt: document.reconciledAt ?? "", U_ReconStatus: document.reconciliationStatus,
    U_SanitizedError: document.sanitizedError ?? "", U_AttemptHistory: JSON.stringify(document.attempts) };
}

async function parseDocument(row: SapRow, identity: GgfPostingExecutionIdentity, executionId: string,
  index: number): Promise<GgfPostingDocumentLedger> {
  let request: Record<string, unknown> | null = null;
  let response: Record<string, unknown> | null = null;
  let dependencies: string[];
  let attempts: GgfDocumentAttempt[];
  try {
    request = row.U_Request ? JSON.parse(String(row.U_Request)) as Record<string, unknown> : null;
    response = row.U_Response ? JSON.parse(String(row.U_Response)) as Record<string, unknown> : null;
    dependencies = JSON.parse(String(row.U_Dependencies ?? "[]")) as string[];
    attempts = JSON.parse(String(row.U_AttemptHistory ?? "[]")) as GgfDocumentAttempt[];
  } catch { throw new SapGgfExecutionIntegrityError("Posting document ledger contains invalid JSON"); }
  const sequence = Number(row.U_Sequence);
  const status = String(row.U_Status) as GgfPostingDocumentLedger["status"];
  const requestHash = optional(row.U_RequestHash);
  const attemptCount = Number(row.U_AttemptCount);
  if (requestHash && request && await calculateGgfRequestHash(request) !== requestHash)
    throw new SapGgfExecutionIntegrityError("Persisted request differs from its RequestHash");
  const attemptsValid = Array.isArray(attempts) && attempts.every((attempt, attemptIndex) => attempt &&
    attempt.attempt === attemptIndex + 1 && /^[a-f0-9]{64}$/.test(attempt.requestHash) &&
    typeof attempt.startedAt === "string" &&
    ["PENDING", "SENDING", "SENT", "UNCERTAIN", "RECONCILED", "FAILED"].includes(attempt.status));
  const reconciliationStatus = String(row.U_ReconStatus);
  if (row.Code !== documentCode(executionId, index + 1) || sequence !== index + 1 ||
      row.U_ExecutionId !== executionId || row.U_ClosingId !== identity.closingId ||
      Number(row.U_ClosingVersion) !== identity.closingVersion ||
      Number(row.U_PostingPlanVersion) !== identity.postingPlanVersion || row.U_PostingHash !== identity.postingHash ||
      !["PENDING", "SENDING", "SENT", "UNCERTAIN", "RECONCILED", "FAILED"].includes(status) ||
      !Array.isArray(dependencies) || dependencies.some(value => typeof value !== "string") ||
      !Array.isArray(attempts) || !attemptsValid || !Number.isSafeInteger(attemptCount) || attemptCount !== attempts.length ||
      (requestHash !== null && !/^[a-f0-9]{64}$/.test(requestHash)) || (!!requestHash !== !!request) ||
      (["SENDING", "SENT", "UNCERTAIN", "RECONCILED"].includes(status) && (!requestHash || !attempts.length)) ||
      (status === "PENDING" && (attemptCount !== 0 || requestHash !== null)) ||
      (status === "RECONCILED" && (row.U_ReconStatus !== "MATCHED" ||
        !optional(row.U_ReconciledAt) || !sapNumber(row.U_SapDocEntry) || !sapNumber(row.U_SapDocNum) ||
        !sapNumber(row.U_SapTransId))) ||
      (status === "SENT" && (!optional(row.U_ResponseReceivedAt) || !sapNumber(row.U_SapDocEntry) ||
        !sapNumber(row.U_SapDocNum) || !sapNumber(row.U_SapTransId))) ||
      !/^-?\d+$/.test(String(row.U_PlannedAmount)) ||
      !["NOT_RUN", "MATCHED", "NO_MATCH", "AMBIGUOUS", "INCOMPLETE"].includes(reconciliationStatus) ||
      (requestHash && attempts.at(-1)?.requestHash !== requestHash))
    throw new SapGgfExecutionIntegrityError("Posting document ledger identity or state differs");
  return { executionId, identity, sequence, documentType: String(row.U_DocumentType),
    plannedAmount: String(row.U_PlannedAmount), currency: optional(row.U_Currency), status,
    requestHash, request, response, dependencies, attemptCount,
    attemptStartedAt: optional(row.U_AttemptStartedAt), responseReceivedAt: optional(row.U_ResponseReceivedAt),
    sapDocEntry: sapNumber(row.U_SapDocEntry), sapDocNum: sapNumber(row.U_SapDocNum),
    sapTransId: sapNumber(row.U_SapTransId), reconciledAt: optional(row.U_ReconciledAt),
    reconciliationStatus: reconciliationStatus as GgfPostingDocumentLedger["reconciliationStatus"],
    sanitizedError: optional(row.U_SanitizedError), attempts };
}

/** SAP-authoritative execution/document ledger. It has no financial-document transport. */
export class SapGgfPostingExecutionRepository {
  constructor(private readonly client: SlReadWrite) {}

  private async readHeader(executionId: string): Promise<SapRow | undefined> {
    try { return await this.client.get<SapRow>(`${EXEC}(${quote(executionId)})`); }
    catch (error) {
      if (error instanceof ServiceLayerError && error.status === 404) return undefined;
      throw normalize(error);
    }
  }

  async assertAvailable(): Promise<void> {
    try {
      const count = Number(await this.client.get(`${EXEC}/$count`));
      const docCount = Number(await this.client.get(`${DOC}/$count`));
      if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(docCount) || docCount < 0)
        throw new Error("Invalid posting ledger endpoint count");
    } catch (error) { throw normalize(error); }
  }

  async get(executionId: string): Promise<GgfPostingExecutionRecord | null> {
    if (!/^F1EX[a-f0-9]{40}$/.test(executionId)) throw new Error("Invalid ExecutionId");
    const header = await this.readHeader(executionId);
    if (!header) return null;
    const identity: GgfPostingExecutionIdentity = { closingId: String(header.U_ClosingId),
      closingVersion: Number(header.U_ClosingVersion), postingPlanVersion: Number(header.U_PostingPlanVersion),
      postingHash: String(header.U_PostingHash) };
    const expectedId = await calculateGgfExecutionId(identity);
    if (expectedId !== executionId) throw new SapGgfExecutionIntegrityError("ExecutionId does not match its financial identity");
    const filter = encodeURIComponent(`U_ExecutionId eq ${quote(executionId)}`);
    const count = Number(await this.client.get(`${DOC}/$count?$filter=${filter}`));
    if (!Number.isSafeInteger(count) || count < 0 || count !== Number(header.U_DocumentCount))
      throw new SapGgfExecutionIntegrityError("Execution/document ledger count differs");
    let path = `${DOC}?$filter=${filter}&$orderby=U_Sequence&$top=100`;
    const rows: SapRow[] = [];
    const visited = new Set<string>();
    while (path) {
      if (visited.has(path) || visited.size >= 100) throw new SapGgfExecutionIntegrityError("Execution ledger pagination incomplete");
      visited.add(path);
      const page = await this.client.get<SapPage>(path);
      if (!page || !Array.isArray(page.value)) throw new SapGgfExecutionIntegrityError("Execution ledger page invalid");
      rows.push(...page.value);
      const next = page["@odata.nextLink"] ?? page["odata.nextLink"];
      path = next ? next.replace(/^\/?b1s\/v\d+\//, "") : "";
      if (next && (!path.startsWith(`${DOC}?`) || path.includes("#")))
        throw new SapGgfExecutionIntegrityError("Execution ledger pagination escaped its entity");
    }
    if (rows.length !== count || new Set(rows.map(row => row.Code)).size !== count)
      throw new SapGgfExecutionIntegrityError("Execution document count is incomplete or duplicated");
    const documents = await Promise.all(rows.map((row, index) => parseDocument(row, identity, executionId, index)));
    const totals = executionTotals(documents);
    if (header.U_TotalExpected !== totals.expected || header.U_TotalPosted !== totals.posted ||
        header.U_TotalReconciled !== totals.reconciled)
      throw new SapGgfExecutionIntegrityError("Execution totals diverge from document ledger");
    const status = String(header.U_Status) as GgfPostingExecutionRecord["status"];
    if (!["READY", "POSTING", "POSTING_PARTIAL", "POSTING_UNCERTAIN", "POSTED", "FAILED",
      "PAYLOAD_INTEGRITY_VIOLATION"].includes(status))
      throw new SapGgfExecutionIntegrityError("Unknown posting execution status");
    return { executionId, identity, status, startedAt: String(header.U_StartedAt),
      finishedAt: optional(header.U_FinishedAt), startedBy: optional(header.U_StartedBy),
      lastError: optional(header.U_LastError), totalExpected: totals.expected, totalPosted: totals.posted,
      totalReconciled: totals.reconciled, documents };
  }

  async create(record: GgfPostingExecutionRecord): Promise<GgfPostingExecutionRecord> {
    if (record.executionId !== await calculateGgfExecutionId(record.identity)) throw new Error("ExecutionId differs from identity");
    const expectedHeader = headerBody(record);
    let header = await this.readHeader(record.executionId);
    if (header) {
      try {
        if (await this.get(record.executionId)) throw new Error("ExecutionId already exists; use save for its current state");
      } catch (error) {
        if (!(error instanceof SapGgfExecutionIntegrityError && error.message === "Execution/document ledger count differs"))
          throw error;
      }
      if (Object.entries(expectedHeader).some(([key, value]) => header![key] !== value))
        throw new SapGgfExecutionIntegrityError("Existing execution header differs; it will not be overwritten");
      if (record.status !== "READY" || record.documents.some(document => document.status !== "PENDING" ||
          document.attemptCount !== 0 || document.requestHash !== null))
        throw new SapGgfExecutionIntegrityError("Only an undispatched READY ledger can resume incomplete initialization");
    } else {
      try { await this.client.post(EXEC, expectedHeader); }
      catch (error) {
        header = await this.readHeader(record.executionId);
        if (!header || Object.entries(expectedHeader).some(([key, value]) => header![key] !== value))
          throw new SapGgfExecutionWriteUncertainError(
            error instanceof ServiceLayerError ? error.status : undefined,
            error instanceof ServiceLayerError ? error.code : undefined,
            !(error instanceof ServiceLayerError) && error instanceof Error ? error.message : undefined);
      }
    }
    for (const document of record.documents) {
      if (document.executionId !== record.executionId) throw new Error("Document belongs to another execution");
      const code = documentCode(record.executionId, document.sequence);
      let persisted: SapRow | undefined;
      try { persisted = await this.client.get<SapRow>(`${DOC}(${quote(code)})`); }
      catch (error) { if (!(error instanceof ServiceLayerError && error.status === 404)) throw normalize(error); }
      const expectedDocument = documentBody(document);
      if (persisted) {
        const parsed = await parseDocument(persisted, record.identity, record.executionId, document.sequence - 1);
        if (JSON.stringify(parsed) !== JSON.stringify(document))
          throw new SapGgfExecutionIntegrityError("Existing document ledger row differs; it will not be overwritten");
        continue;
      }
      try { await this.client.post(DOC, expectedDocument); }
      catch (error) {
        try { persisted = await this.client.get<SapRow>(`${DOC}(${quote(code)})`); }
        catch { throw new SapGgfExecutionWriteUncertainError(
          error instanceof ServiceLayerError ? error.status : undefined,
          error instanceof ServiceLayerError ? error.code : undefined,
          !(error instanceof ServiceLayerError) && error instanceof Error ? error.message : undefined); }
        if (!persisted) throw new SapGgfExecutionWriteUncertainError(
          error instanceof ServiceLayerError ? error.status : undefined,
          error instanceof ServiceLayerError ? error.code : undefined,
          !(error instanceof ServiceLayerError) && error instanceof Error ? error.message : undefined);
        const parsed = await parseDocument(persisted, record.identity, record.executionId, document.sequence - 1);
        if (JSON.stringify(parsed) !== JSON.stringify(document))
          throw new SapGgfExecutionIntegrityError("Ambiguous document create differs from its planned state");
      }
    }
    const saved = await this.get(record.executionId);
    if (!saved) throw new Error("Posting execution create/readback failed");
    return saved;
  }

  async save(record: GgfPostingExecutionRecord): Promise<GgfPostingExecutionRecord> {
    const current = await this.get(record.executionId);
    if (!current) throw new Error("Posting execution does not exist in SAP");
    assertExecutionIdentity(current.identity, record.identity);
    if (current.documents.length !== record.documents.length) throw new Error("Posting document set is immutable");
    const executionTransitions: Record<string, string[]> = {
      READY: ["READY", "POSTING", "FAILED", "POSTING_UNCERTAIN"],
      POSTING: ["POSTING", "POSTING_PARTIAL", "POSTING_UNCERTAIN", "POSTED", "FAILED", "PAYLOAD_INTEGRITY_VIOLATION"],
      POSTING_PARTIAL: ["POSTING_PARTIAL", "POSTING_UNCERTAIN", "POSTED", "FAILED", "PAYLOAD_INTEGRITY_VIOLATION"],
      POSTING_UNCERTAIN: ["POSTING_UNCERTAIN", "POSTING_PARTIAL", "POSTED", "FAILED", "PAYLOAD_INTEGRITY_VIOLATION"],
      POSTED: ["POSTED"], FAILED: ["FAILED"], PAYLOAD_INTEGRITY_VIOLATION: ["PAYLOAD_INTEGRITY_VIOLATION"]
    };
    if (!executionTransitions[current.status]?.includes(record.status)) throw new Error("Execution status transition is blocked");
    for (let index = 0; index < record.documents.length; index++) {
      const before = current.documents[index]!;
      const after = record.documents[index]!;
      if (before.sequence !== after.sequence || before.documentType !== after.documentType ||
          before.plannedAmount !== after.plannedAmount || JSON.stringify(before.dependencies) !== JSON.stringify(after.dependencies))
        throw new Error("Posting document identity is immutable");
      const documentTransitions: Record<string, string[]> = {
        PENDING: ["PENDING", "SENDING", "FAILED"], SENDING: ["SENDING", "SENT", "UNCERTAIN", "RECONCILED", "FAILED"],
        SENT: ["SENT", "RECONCILED", "UNCERTAIN"], UNCERTAIN: ["UNCERTAIN", "RECONCILED"],
        RECONCILED: ["RECONCILED"], FAILED: ["FAILED"]
      };
      if (!documentTransitions[before.status]?.includes(after.status)) throw new Error("Posting document status transition is blocked");
      const historyChanged = before.attempts.some((attempt, attemptIndex) => {
        const next = after.attempts[attemptIndex];
        if (!next || attempt.attempt !== next.attempt || attempt.requestHash !== next.requestHash ||
            attempt.startedAt !== next.startedAt) return true;
        if (attemptIndex < before.attempts.length - 1)
          return JSON.stringify(attempt) !== JSON.stringify(next);
        return false;
      });
      if (after.attemptCount < before.attemptCount || after.attempts.length < before.attempts.length || historyChanged)
        throw new Error("Posting document attempt history is immutable");
      const code = documentCode(record.executionId, after.sequence);
      const { Code: _code, Name, ...body } = documentBody(after);
      await this.client.patch(`${DOC}(${quote(code)})`, { Name, ...body });
    }
    const { Code: _code, Name, ...body } = headerBody(record);
    await this.client.patch(`${EXEC}(${quote(record.executionId)})`, { Name, ...body });
    const saved = await this.get(record.executionId);
    if (!saved) throw new Error("Posting execution update/readback failed");
    return saved;
  }

  async recordPrePostRecoveryAudit(executionId: string, originalError: string, audit: GgfPrePostRecoveryAudit): Promise<string> {
    const current = await this.get(executionId);
    if (!current || !["FAILED", "READY"].includes(current.status) || current.documents.length !== 3 ||
        current.documents.some(document => document.status !== "PENDING" || document.attemptCount !== 0 ||
          document.attemptStartedAt !== null || document.responseReceivedAt !== null || document.requestHash !== null ||
          document.request !== null || document.response !== null || document.sapDocEntry !== null ||
          document.sapDocNum !== null || document.sapTransId !== null || document.attempts.length !== 0))
      throw new Error("Execution no longer satisfies the zero-attempt FAILED recovery gate");
    const event = JSON.stringify({ failureCategory: audit.failureCategory, failureDetail: audit.failureDetail,
      originalError, failedAt: current.finishedAt, RecoveryAuthorizedAt: audit.authorizedAt,
      RecoveryReason: audit.reason, RecoveryFromStatus: audit.recoveryFromStatus,
      RecoveryCount: audit.recoveryCount });
    if (current.lastError === event) return event;
    if (current.lastError === originalError && originalError !== "PRE_POST_CHECK_FAILED") {
      let previous: Record<string, unknown> | null = null;
      try { previous = JSON.parse(originalError) as Record<string, unknown>; } catch { /* invalid audit */ }
      if (["FAILED", "READY"].includes(current.status) && previous?.failureCategory === audit.failureCategory &&
          previous.failureDetail === audit.failureDetail && previous.originalError === "PRE_POST_CHECK_FAILED" &&
          previous.RecoveryAuthorizedAt === audit.authorizedAt && previous.RecoveryReason === audit.reason &&
          previous.RecoveryFromStatus === audit.recoveryFromStatus && previous.RecoveryCount === audit.recoveryCount)
        return originalError;
      throw new Error("Original pre-POST failure differs from the authorized recovery event");
    }
    if (current.lastError !== originalError) {
      let previous: Record<string, unknown> | null = null;
      try { previous = JSON.parse(current.lastError ?? "null") as Record<string, unknown> | null; } catch { /* invalid audit */ }
      if (current.status === "FAILED" && previous?.failureCategory === audit.failureCategory &&
          previous.failureDetail === audit.failureDetail && previous.originalError === "PRE_POST_CHECK_FAILED" &&
          previous.RecoveryAuthorizedAt === audit.authorizedAt && previous.RecoveryReason === audit.reason &&
          previous.RecoveryFromStatus === audit.recoveryFromStatus && previous.RecoveryCount === audit.recoveryCount)
        return current.lastError!;
      throw new Error("Original pre-POST failure differs from the authorized recovery event");
    }
    if (originalError !== "PRE_POST_CHECK_FAILED" || current.status !== "FAILED")
      throw new Error("Original pre-POST failure differs from the authorized recovery event");
    await this.client.patch(`${EXEC}(${quote(executionId)})`, { U_LastError: event });
    const saved = await this.get(executionId);
    if (!saved || saved.status !== "FAILED" || saved.lastError !== event || saved.finishedAt !== current.finishedAt)
      throw new Error("Recovery audit event readback differs");
    return event;
  }

  async finishPrePostRecovery(executionId: string, event: string): Promise<GgfPostingExecutionRecord> {
    const current = await this.get(executionId);
    if (!current || !["FAILED", "READY"].includes(current.status) || current.lastError !== event || current.documents.length !== 3 ||
        current.documents.some(document => document.status !== "PENDING" || document.attemptCount !== 0 ||
          document.attemptStartedAt !== null || document.responseReceivedAt !== null || document.requestHash !== null ||
          document.request !== null || document.response !== null || document.sapDocEntry !== null ||
          document.sapDocNum !== null || document.sapTransId !== null || document.attempts.length !== 0))
      throw new Error("Execution changed before the explicit pre-POST recovery could finish");
    if (current.status === "READY") return current;
    await this.client.patch(`${EXEC}(${quote(executionId)})`, { U_Status: "READY", U_FinishedAt: "" });
    const saved = await this.get(executionId);
    if (!saved || saved.status !== "READY" || saved.lastError !== event || saved.finishedAt !== null ||
        saved.documents.some(document => document.status !== "PENDING" || document.attemptCount !== 0))
      throw new Error("Recovered execution readback differs");
    return saved;
  }
}

export interface SapGgfFinancialClaim extends GgfPostingExecutionIdentity {
  executionId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  claimedBy: string | null;
}

/** Identity-scoped claim; old ClosingId-only records are preserved and treated as ambiguous blockers. */
export class SapGgfPostingClaimRepository {
  private readonly entity = tableName("ggf", "CLAIM");
  constructor(private readonly client: SlReadWrite) {}

  async get(executionId: string): Promise<SapGgfFinancialClaim | null> {
    if (!/^F1EX[a-f0-9]{40}$/.test(executionId)) throw new Error("Invalid ExecutionId");
    let row: SapRow | undefined;
    try { row = await this.client.get<SapRow>(`${this.entity}(${quote(executionId)})`); }
    catch (error) { if (error instanceof ServiceLayerError && error.status === 404) return null; throw normalize(error); }
    if (!row) return null;
    const claim: SapGgfFinancialClaim = { executionId, closingId: String(row.U_ClosingId),
      closingVersion: Number(row.U_ClosingVersion), postingPlanVersion: Number(row.U_PostingPlanVersion),
      postingHash: String(row.U_PostingHash), status: String(row.U_Status),
      createdAt: String(row.U_CreatedAt), updatedAt: String(row.U_UpdatedAt), claimedBy: optional(row.U_ClaimedBy) };
    if (row.Code !== executionId || await calculateGgfExecutionId(claim) !== executionId ||
        !["CLAIMED", "POSTING", "POSTING_PARTIAL", "POSTING_UNCERTAIN", "POSTED", "FAILED",
          "PAYLOAD_INTEGRITY_VIOLATION"].includes(claim.status))
      throw new SapGgfExecutionIntegrityError("SAP financial claim identity differs");
    return claim;
  }

  async claim(identity: GgfPostingExecutionIdentity, status = "CLAIMED", at = new Date().toISOString(),
    claimedBy: string | null = null): Promise<SapGgfFinancialClaim> {
    const executionId = await calculateGgfExecutionId(identity);
    const filter = encodeURIComponent(`U_ClosingId eq ${quote(identity.closingId)}`);
    const count = Number(await this.client.get(`${this.entity}/$count?$filter=${filter}`));
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("SAP claim read is incomplete");
    const response = await this.client.get<SapPage>(`${this.entity}?$filter=${filter}&$top=100`);
    if (!response || !Array.isArray(response.value) || response.value.length !== count)
      throw new Error("SAP claim rows differ from independent count");
    for (const row of response.value) {
      const sameClosing = row.U_ClosingId === identity.closingId;
      if (!sameClosing) throw new SapGgfExecutionIntegrityError("SAP claim filter returned another ClosingId");
      const complete = Number.isSafeInteger(Number(row.U_ClosingVersion)) &&
        Number.isSafeInteger(Number(row.U_PostingPlanVersion)) && /^[a-f0-9]{64}$/.test(String(row.U_PostingHash)) &&
        typeof row.U_ExecutionId === "string";
      if (!complete) throw new Error("Legacy ClosingId-only claim blocks execution pending explicit reconciliation");
      if (row.U_ExecutionId !== executionId || Number(row.U_ClosingVersion) !== identity.closingVersion ||
          Number(row.U_PostingPlanVersion) !== identity.postingPlanVersion || row.U_PostingHash !== identity.postingHash)
        throw new Error("Another financial identity already has a claim for this ClosingId");
      throw new Error("Financial claim already exists; reconcile instead of claiming again");
    }
    const body = { Code: executionId, Name: executionId, U_ClosingId: identity.closingId,
      U_ClosingVersion: String(identity.closingVersion), U_PostingPlanVersion: String(identity.postingPlanVersion),
      U_PostingHash: identity.postingHash, U_ExecutionId: executionId, U_Version: String(identity.closingVersion),
      U_ClaimedAt: at, U_CreatedAt: at, U_UpdatedAt: at, U_ClaimedBy: claimedBy ?? "", U_Status: status };
    try { await this.client.post(this.entity, body); }
    catch (error) {
      const persisted = await this.get(executionId).catch(() => null);
      if (persisted) throw new Error("Financial claim was created concurrently; reconcile its execution");
      throw normalize(error);
    }
    const saved = await this.get(executionId);
    if (!saved) throw new Error("SAP financial claim create/readback failed");
    assertExecutionIdentity(saved, identity);
    return saved;
  }

  async updateStatus(executionId: string, status: string, at: string): Promise<void> {
    const current = await this.get(executionId);
    if (!current) throw new Error("SAP financial claim is missing");
    const allowed: Record<string, string[]> = {
      CLAIMED: ["POSTING", "FAILED", "POSTING_UNCERTAIN"],
      POSTING: ["POSTING", "POSTING_PARTIAL", "POSTING_UNCERTAIN", "POSTED", "FAILED", "PAYLOAD_INTEGRITY_VIOLATION"],
      POSTING_PARTIAL: ["POSTING_PARTIAL", "POSTING_UNCERTAIN", "POSTED", "FAILED", "PAYLOAD_INTEGRITY_VIOLATION"],
      POSTING_UNCERTAIN: ["POSTING_UNCERTAIN", "POSTING_PARTIAL", "POSTED", "FAILED", "PAYLOAD_INTEGRITY_VIOLATION"],
      POSTED: ["POSTED"], FAILED: ["FAILED"], PAYLOAD_INTEGRITY_VIOLATION: ["PAYLOAD_INTEGRITY_VIOLATION"]
    };
    if (!allowed[current.status]?.includes(status)) throw new Error("Financial claim status transition is blocked");
    await this.client.patch(`${this.entity}(${quote(executionId)})`, { U_Status: status, U_UpdatedAt: at });
    const saved = await this.get(executionId);
    if (!saved || saved.status !== status || saved.updatedAt !== at)
      throw new Error("SAP financial claim status readback differs");
  }

  async recoverFailed(executionId: string, at: string): Promise<void> {
    const current = await this.get(executionId);
    if (!current || !["FAILED", "CLAIMED"].includes(current.status)) throw new Error("Only the same FAILED claim can be recovered");
    if (current.status === "CLAIMED") {
      if (current.updatedAt !== at) throw new Error("Existing recovered claim audit timestamp differs");
      return;
    }
    await this.client.patch(`${this.entity}(${quote(executionId)})`, { U_Status: "CLAIMED", U_UpdatedAt: at });
    const saved = await this.get(executionId);
    if (!saved || saved.status !== "CLAIMED" || saved.updatedAt !== at ||
        saved.closingId !== current.closingId || saved.closingVersion !== current.closingVersion ||
        saved.postingPlanVersion !== current.postingPlanVersion || saved.postingHash !== current.postingHash)
      throw new Error("Recovered claim readback differs");
  }
}
