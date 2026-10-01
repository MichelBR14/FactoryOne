import type { SlReadWrite } from "../../../core/data/SetupRepository";
import { tableName } from "../../../core/config/product";
import { ServiceLayerError } from "../../../core/service/errors";
import { CLOSING_STATUSES, assertClosingConsistency, assertClosingIdentity, closingSapDocument,
  transitionClosing, type ClosingLine, type GgfClosing } from "../service/GgfClosing";
import { ClosingIntegrityViolation, inspectClosingIntegrity, safeIntegrityContext, type ClosingIntegrityReport } from "../service/GgfClosingIntegrity";
import { calculateGgfExecutionId } from "../service/GgfPostingExecution";

const CLOSE = tableName("ggf", "CLOSE");
const LINE = tableName("ggf", "CLINE");
const CLAIM = tableName("ggf", "CLAIM");
const LOG = tableName("core", "LOG");
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const maybe = (value: string | number | null) => value === null ? null : String(value);
const positiveNumber = (value: unknown) => {
  const n = Number(value);
  return value !== null && value !== undefined && value !== "" &&
    Number.isSafeInteger(n) && n > 0 ? n : null;
};
const parseNumber = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid SAP closing document number");
  return n;
};

interface SapPage<T> { value: T[]; "@odata.nextLink"?: string; "odata.nextLink"?: string }
interface SapRow { Code: string; [key: string]: unknown }

function headerBody(c: GgfClosing): Record<string, unknown> {
  const sapDocument = closingSapDocument(c);
  return {
    Name: c.closingId, U_CompanyDB: c.companyDB, U_PeriodStart: c.periodStart,
    U_PeriodEnd: c.periodEnd, U_Branch: c.branch, U_Dimensions: JSON.stringify(c.dimensions),
    U_Status: c.status, U_Version: String(c.version), U_LineVersion: String(c.lineVersion),
    U_CreatedAt: c.createdAt, U_CreatedBy: c.createdBy,
    U_CalculatedAt: c.calculatedAt, U_PostedAt: c.postedAt,
    U_TotalGgf: c.totalGgf, U_TotalAllocated: c.totalAllocated,
    U_TotalRevalued: c.totalRevalued,
    U_SapDocEntry: maybe(sapDocument?.docEntry ?? null),
    U_SapDocNum: maybe(sapDocument?.docNum ?? null), U_SapTransId: maybe(sapDocument?.transId ?? null),
    U_PostingHash: c.postingHash, U_ReopenedFrom: c.reopenedFrom,
    U_CancelledAt: c.cancelledAt, U_Notes: c.notes, U_LastError: c.lastError,
    U_PostingBasis: c.postingBasis === null ? null : JSON.stringify(c.postingBasis),
    U_ProposedPayload: c.proposedPayload === null ? null : JSON.stringify(c.proposedPayload)
  };
}
function lineBody(c: GgfClosing, row: ClosingLine, index: number): Record<string, unknown> {
  const code = `${c.closingId}.${String(c.lineVersion).padStart(5, "0")}.${String(index + 1).padStart(4, "0")}`;
  if (code.length > 50) throw new Error("Closing audit line key exceeds SAP Code length");
  return { Code: code, Name: code, U_ClosingId: c.closingId, U_Version: String(c.lineVersion),
    U_Account: row.account, U_Criterion: row.criterion, U_OrderId: row.orderId,
    U_Item: row.item, U_Warehouse: row.warehouse, U_Basis: row.basis,
    U_Percent: row.percent, U_Allocated: row.allocated,
    U_CostBefore: row.costBefore, U_CostAfter: row.costAfter,
    U_Revaluation: row.revaluation, U_Status: row.status };
}
function fromLine(row: SapRow): ClosingLine {
  return { account: String(row.U_Account), criterion: String(row.U_Criterion),
    orderId: String(row.U_OrderId), item: String(row.U_Item), warehouse: String(row.U_Warehouse),
    basis: String(row.U_Basis), percent: String(row.U_Percent), allocated: String(row.U_Allocated),
    costBefore: String(row.U_CostBefore), costAfter: String(row.U_CostAfter),
    revaluation: String(row.U_Revaluation), status: String(row.U_Status) };
}
function fromHeader(row: SapRow, lines: ClosingLine[]): GgfClosing {
  const postingBasis = row.U_PostingBasis ? JSON.parse(String(row.U_PostingBasis)) : null;
  const documentEntry = parseNumber(row.U_SapDocEntry);
  const documentNumber = parseNumber(row.U_SapDocNum);
  const journalEntry = postingBasis?.documentType === "JournalEntry.CPV";
  const c: GgfClosing = {
    closingId: row.Code, companyDB: String(row.U_CompanyDB), periodStart: String(row.U_PeriodStart),
    periodEnd: String(row.U_PeriodEnd), branch: String(row.U_Branch ?? ""),
    dimensions: JSON.parse(String(row.U_Dimensions ?? "{}")),
    status: row.U_Status as GgfClosing["status"], version: Number(row.U_Version),
    lineVersion: Number(row.U_LineVersion), createdAt: String(row.U_CreatedAt),
    createdBy: String(row.U_CreatedBy), calculatedAt: row.U_CalculatedAt ? String(row.U_CalculatedAt) : null,
    postedAt: row.U_PostedAt ? String(row.U_PostedAt) : null,
    totalGgf: String(row.U_TotalGgf ?? "0.00"), totalAllocated: String(row.U_TotalAllocated ?? "0.00"),
    totalRevalued: String(row.U_TotalRevalued ?? "0.00"),
    sapMaterialRevaluationDocEntry: journalEntry ? null : documentEntry,
    sapMaterialRevaluationDocNum: journalEntry ? null : documentNumber,
    sapJournalEntryDocEntry: journalEntry ? documentEntry : null,
    sapJournalEntryDocNum: journalEntry ? documentNumber : null,
    sapJournalTransId: parseNumber(row.U_SapTransId),
    postingHash: row.U_PostingHash ? String(row.U_PostingHash) : null,
    reopenedFrom: row.U_ReopenedFrom ? String(row.U_ReopenedFrom) : null,
    cancelledAt: row.U_CancelledAt ? String(row.U_CancelledAt) : null,
    notes: String(row.U_Notes ?? ""), lastError: row.U_LastError ? String(row.U_LastError) : null,
    postingBasis,
    proposedPayload: row.U_ProposedPayload ? JSON.parse(String(row.U_ProposedPayload)) : null,
    lines
  };
  assertClosingIdentity(c);
  if (!CLOSING_STATUSES.includes(c.status)) throw new Error("Invalid SAP closing status");
  return c;
}

export interface GgfClosingStore {
  get(closingId: string): Promise<GgfClosing | null>;
  create(closing: GgfClosing): Promise<void>;
  replace(expected: GgfClosing, next: GgfClosing): Promise<void>;
  /** SAP Code uniqueness is the cross-session posting claim. Claims are never auto-deleted. */
  claim(closingId: string, hash: string, version: number): Promise<void>;
  getClaim(closingId: string): Promise<{ hash: string; version: number } | null>;
}

/** The UDO entity names follow the existing FactoryOne metadata convention. Not a posting transport. */
export class SapGgfClosingRepository implements GgfClosingStore {
  constructor(private readonly client: SlReadWrite,
    private readonly context: { user?: string; session?: string; now?: () => string } = {}) {}

  private async verificationClaim(closingId: string, basis?: GgfClosing["postingBasis"]): Promise<{ hash: string; version: number } | null> {
    if (basis?.documentType === "JournalEntry.CPV" && basis.postingPlanHash &&
        basis.postingClosingVersion && basis.postingPlanVersion) {
      const executionId = await calculateGgfExecutionId({ closingId, closingVersion: basis.postingClosingVersion,
        postingPlanVersion: basis.postingPlanVersion, postingHash: basis.postingPlanHash });
      let row: SapRow | undefined;
      try { row = await this.client.get<SapRow>(`${CLAIM}(${quote(executionId)})`); }
      catch (error) { if (error instanceof ServiceLayerError && error.status === 404) return null; throw error; }
      if (!row || row.Code !== executionId || row.U_ExecutionId !== executionId || row.U_ClosingId !== closingId ||
          row.U_PostingHash !== basis.postingPlanHash || Number(row.U_ClosingVersion) !== basis.postingClosingVersion ||
          Number(row.U_PostingPlanVersion) !== basis.postingPlanVersion)
        throw new Error("Execution claim identity differs from the posted closing basis");
      return { hash: String(row.U_PostingHash), version: Number(row.U_ClosingVersion) };
    }
    return this.getClaim(closingId);
  }

  private async violation(report: ClosingIntegrityReport): Promise<never> {
    const at = new Date(report.detectedAt);
    const safe = { closingId: report.closingId, version: report.version,
      closingStatus: report.closingStatus, sapDocEntry: report.sapDocEntry,
      sapDocNum: report.sapDocNum, sapTransId: report.sapTransId,
      originalHash: report.originalHash, persistedHash: report.persistedHash,
      recalculatedHash: report.recalculatedHash, detectedAt: report.detectedAt,
      user: report.user, session: report.session, divergentFields: report.divergentFields };
    try {
      await this.client.post(LOG, { Code: crypto.randomUUID(), Name: "GGF_POSTED_INTEGRITY",
        U_Module: "ggf", U_Routine: "GGF_POSTED_INTEGRITY",
        U_UserCode: (report.user ?? "unknown").slice(0, 30),
        U_StartDate: report.detectedAt.slice(0, 10), U_StartTime: at.toISOString().slice(11, 19),
        U_EndDate: report.detectedAt.slice(0, 10), U_EndTime: at.toISOString().slice(11, 19),
        U_Status: "ERROR", U_Message: JSON.stringify(safe), U_DocRef: report.closingId });
      report.auditRecorded = true;
    } catch { report.auditRecorded = false; }
    throw new ClosingIntegrityViolation(report);
  }

  async get(closingId: string): Promise<GgfClosing | null> {
    if (!/^[A-Za-z0-9_-]{1,30}$/.test(closingId)) throw new Error("Invalid ClosingId");
    let header: SapRow | undefined;
    try { header = await this.client.get<SapRow>(`${CLOSE}(${quote(closingId)})`); }
    catch (error) { if (error instanceof ServiceLayerError && error.status === 404) return null; throw error; }
    if (!header) return null;
    if (header.U_Status !== "POSTED" && header.U_Status !== "REOPENED" &&
        (header.U_PostedAt || header.U_SapDocEntry || header.U_SapTransId)) {
      let claim: { hash: string; version: number } | null = null;
      try {
        const basis = header.U_PostingBasis ? JSON.parse(String(header.U_PostingBasis)) as GgfClosing["postingBasis"] : null;
        claim = await this.verificationClaim(closingId, basis);
      } catch { /* Still block altered posted link. */ }
      return this.violation({ status: "INTEGRITY_VIOLATION", closingId,
        version: Number(header.U_Version) || 0,
        closingStatus: String(header.U_Status ?? ""),
      sapDocumentType: null,
        sapDocEntry: positiveNumber(header.U_SapDocEntry),
        sapDocNum: positiveNumber(header.U_SapDocNum),
        sapTransId: positiveNumber(header.U_SapTransId),
        originalHash: claim?.hash ?? (typeof header.U_PostingHash === "string" ? header.U_PostingHash : null),
        persistedHash: typeof header.U_PostingHash === "string" ? header.U_PostingHash : null,
        recalculatedHash: null, detectedAt: this.context.now?.() ?? new Date().toISOString(),
        ...safeIntegrityContext(this.context),
        divergentFields: ["Status/PostedLink"] });
    }
    try {
      const version = Number(header.U_LineVersion);
      if (!Number.isSafeInteger(version) || version < 1) throw new Error("Invalid audit line version");
      const filter = encodeURIComponent(`U_ClosingId eq ${quote(closingId)} and U_Version eq ${quote(String(version))}`);
      const count = Number(await this.client.get<unknown>(`${LINE}/$count?$filter=${filter}`));
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid independent closing audit count");
      let path = `${LINE}?$filter=${filter}&$orderby=Code&$top=100`;
      const rows: SapRow[] = [];
      const visited = new Set<string>();
      while (path) {
        if (visited.has(path) || visited.size >= 100) throw new Error("Incomplete closing audit pagination");
        visited.add(path);
        const page = await this.client.get<SapPage<SapRow>>(path);
        if (!page || !Array.isArray(page.value)) throw new Error("Invalid closing audit page");
        rows.push(...page.value);
        const next = page["@odata.nextLink"] ?? page["odata.nextLink"];
        path = next ? next.replace(/^\/?b1s\/v\d+\//, "") : "";
        if (next && (!path.startsWith(`${LINE}?`) || path.includes("#")))
          throw new Error("Closing audit page escaped entity");
      }
      if (rows.length !== count || new Set(rows.map(r => r.Code)).size !== count)
        throw new Error("Incomplete or duplicate closing audit rows");
      for (let i = 0; i < rows.length; i++) {
        const code = `${closingId}.${String(version).padStart(5, "0")}.${String(i + 1).padStart(4, "0")}`;
        if (rows[i]!.Code !== code || rows[i]!.U_ClosingId !== closingId ||
            rows[i]!.U_Version !== String(version))
          throw new Error("Closing audit line identity/version differs");
      }
      const closing = fromHeader(header, rows.map(fromLine));
      if (closing.status === "POSTED" ||
          (closing.status === "REOPENED" && closingSapDocument(closing) !== null)) {
        const report = await inspectClosingIntegrity(closing, await this.verificationClaim(closingId, closing.postingBasis), this.context);
        if (report.status !== "VALID") await this.violation(report);
        closing.integrityStatus = "VALID";
      } else {
        await assertClosingConsistency(closing);
        closing.integrityStatus = "NOT_APPLICABLE";
      }
      return closing;
    } catch (error) {
      if (error instanceof ClosingIntegrityViolation ||
          (header.U_Status !== "POSTED" && header.U_Status !== "REOPENED")) throw error;
      if (error instanceof ServiceLayerError) throw error;
      let claim: { hash: string; version: number } | null = null;
      try { claim = await this.verificationClaim(closingId,
        header.U_PostingBasis ? JSON.parse(String(header.U_PostingBasis)) as GgfClosing["postingBasis"] : null); }
      catch { /* Retain the read failure as a violation. */ }
      return this.violation({ status: "INTEGRITY_VIOLATION", closingId,
        version: Number(header.U_Version) || 0,
        closingStatus: String(header.U_Status ?? ""),
        sapDocumentType: null,
        sapDocEntry: positiveNumber(header.U_SapDocEntry),
        sapDocNum: positiveNumber(header.U_SapDocNum),
        sapTransId: positiveNumber(header.U_SapTransId),
        originalHash: claim?.hash ?? (typeof header.U_PostingHash === "string" ? header.U_PostingHash : null),
        persistedHash: typeof header.U_PostingHash === "string" ? header.U_PostingHash : null,
        recalculatedHash: null, detectedAt: this.context.now?.() ?? new Date().toISOString(),
        ...safeIntegrityContext(this.context),
        divergentFields: [error instanceof Error && error.message === "Closing audit line identity/version differs" ?
          "Lines/Version" : "Header/Lines/read"] });
    }
  }

  async getIntegrity(closingId: string): Promise<ClosingIntegrityReport | null> {
    try {
      const closing = await this.get(closingId);
      if (!closing) return null;
      return inspectClosingIntegrity(closing,
        closing.integrityStatus === "VALID" ? await this.verificationClaim(closingId, closing.postingBasis) : null, this.context);
    } catch (error) {
      if (error instanceof ClosingIntegrityViolation) return error.report;
      throw error;
    }
  }

  async create(closing: GgfClosing): Promise<void> {
    assertClosingIdentity(closing);
    if (closing.status !== "DRAFT" || closing.version !== 1 || closing.lineVersion !== 1)
      throw new Error("Only a first DRAFT can be created");
    await assertClosingConsistency(closing);
    for (let i = 0; i < closing.lines.length; i++)
      await this.client.post(LINE, lineBody(closing, closing.lines[i]!, i));
    await this.client.post(CLOSE, { Code: closing.closingId, ...headerBody(closing) });
  }

  async replace(expected: GgfClosing, next: GgfClosing): Promise<void> {
    if (expected.status === "POSTED" ||
        (expected.status === "REOPENED" && closingSapDocument(expected) !== null))
      await this.get(expected.closingId);
    if (expected.status === "REOPENED" && closingSapDocument(expected) !== null)
      throw new Error("Reopened posted closing is read-only; create a new ClosingId");
    assertClosingIdentity(next);
    if (next.closingId !== expected.closingId || next.companyDB !== expected.companyDB ||
        next.version !== expected.version + 1) throw new Error("Closing identity/version mismatch");
    if (next.status !== expected.status) transitionClosing(expected, next.status);
    else if (next.status !== "POSTING_UNCERTAIN") throw new Error("Unchanged closing status cannot be rewritten");
    if (["READY_TO_POST","POSTING","POSTING_PARTIAL","POSTING_UNCERTAIN","POSTED","FAILED"].includes(next.status) &&
        (!next.postingHash || !next.postingBasis || !next.proposedPayload))
      throw new Error("Posting state requires persisted hash, basis and payload");
    if (next.status === "POSTED" && (!closingSapDocument(next) || !next.postedAt))
      throw new Error("POSTED requires verified SAP link");
    if (expected.status === "POSTED" && (next.status !== "REOPENED" ||
        JSON.stringify(next.lines) !== JSON.stringify(expected.lines) ||
        next.totalGgf !== expected.totalGgf || next.totalAllocated !== expected.totalAllocated ||
        next.totalRevalued !== expected.totalRevalued ||
        JSON.stringify(closingSapDocument(next)) !== JSON.stringify(closingSapDocument(expected)) ||
        next.sapJournalTransId !== expected.sapJournalTransId))
      throw new Error("POSTED version is immutable; reopen without changing functional content");
    if (["POSTING","POSTING_PARTIAL","POSTING_UNCERTAIN","POSTED","FAILED"].includes(expected.status) &&
        (next.postingHash !== expected.postingHash ||
         JSON.stringify(next.postingBasis) !== JSON.stringify(expected.postingBasis) ||
         JSON.stringify(next.proposedPayload) !== JSON.stringify(expected.proposedPayload)))
      throw new Error("Posting basis cannot change after claim");
    await assertClosingConsistency(next);
    const current = await this.get(expected.closingId);
    if (!current || current.version !== expected.version || current.status !== expected.status ||
        current.postingHash !== expected.postingHash ||
        JSON.stringify(closingSapDocument(current)) !== JSON.stringify(closingSapDocument(expected)))
      throw new Error("Closing changed in SAP before update");
    const changed = JSON.stringify(current.lines) !== JSON.stringify(next.lines) ||
      JSON.stringify(current.postingBasis?.fifoLineage) !== JSON.stringify(next.postingBasis?.fifoLineage);
    next.lineVersion = changed ? next.version : current.lineVersion;
    if (changed) for (let i = 0; i < next.lines.length; i++)
      await this.client.post(LINE, lineBody(next, next.lines[i]!, i));
    await this.client.patch(`${CLOSE}(${quote(next.closingId)})`, headerBody(next));
  }

  async claim(closingId: string, hash: string, version: number): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,30}$/.test(closingId) || !/^[a-f0-9]{64}$/.test(hash) ||
        !Number.isSafeInteger(version) || version < 1) throw new Error("Invalid posting claim");
    await this.client.post(CLAIM, { Code: closingId, Name: closingId, U_ClosingId: closingId,
      U_PostingHash: hash, U_ClaimedAt: new Date().toISOString(), U_Version: String(version) });
  }

  async getClaim(closingId: string): Promise<{ hash: string; version: number } | null> {
    if (!/^[A-Za-z0-9_-]{1,30}$/.test(closingId)) throw new Error("Invalid ClosingId");
    let row: SapRow | undefined;
    try { row = await this.client.get<SapRow>(`${CLAIM}(${quote(closingId)})`); }
    catch (error) { if (error instanceof ServiceLayerError && error.status === 404) return null; throw error; }
    if (!row) return null;
    const hash = row.U_PostingHash;
    const version = Number(row.U_Version);
    if (row.Code !== closingId || row.U_ClosingId !== closingId ||
        typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash) ||
        !Number.isSafeInteger(version) || version < 1) throw new Error("Invalid persisted posting claim");
    return { hash, version };
  }
}
