import { assertClosingConsistency, postingHash, type GgfClosing } from "./GgfClosing";

export type ClosingIntegrityStatus = "VALID" | "INTEGRITY_VIOLATION" | "NOT_APPLICABLE";

export interface ClosingIntegrityReport {
  status: ClosingIntegrityStatus;
  closingId: string;
  version: number;
  closingStatus: string;
  sapDocEntry: number | null;
  sapDocNum: number | null;
  sapTransId: number | null;
  originalHash: string | null;
  persistedHash: string | null;
  recalculatedHash: string | null;
  detectedAt: string;
  user: string | null;
  session: string | null;
  divergentFields: string[];
  auditRecorded?: boolean;
}

export class ClosingIntegrityViolation extends Error {
  constructor(readonly report: ClosingIntegrityReport) {
    super("GGF POSTED integrity violation; administrative review required");
    this.name = "ClosingIntegrityViolation";
  }
}

export function safeIntegrityContext(context: { user?: string | null; session?: string | null }) {
  return {
    user: context.user && /^[A-Za-z0-9_.@-]{1,30}$/.test(context.user) ? context.user : null,
    session: context.session === "local-preview" ||
      (context.session && /^app-[A-Za-z0-9_-]{1,50}$/.test(context.session)) ? context.session : null
  };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stable(item)]));
  return value;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const functionalLines = (closing: GgfClosing) => closing.lines.map(({ status, ...line }) => line)
  .sort((a, b) => `${a.account}/${a.orderId}/${a.item}/${a.warehouse}`
    .localeCompare(`${b.account}/${b.orderId}/${b.item}/${b.warehouse}`));

/** Verifies the persisted POSTED content against the earlier, separately keyed claim. */
export async function inspectClosingIntegrity(
  closing: GgfClosing,
  claim: { hash: string; version: number } | null,
  context: { now?: () => string; user?: string | null; session?: string | null } = {}
): Promise<ClosingIntegrityReport> {
  const safeContext = safeIntegrityContext(context);
  const fields = new Set<string>();
  let recalculatedHash: string | null = null;
  const postedContent = closing.status === "POSTED" ||
    (closing.status === "REOPENED" && closing.sapMaterialRevaluationDocEntry !== null);
  if (postedContent) {
    if (!closing.postedAt || !closing.sapMaterialRevaluationDocEntry ||
        !closing.sapMaterialRevaluationDocNum || !closing.sapJournalTransId)
      fields.add("SapPostingLink");
    if (!claim) fields.add("Claim");
    if (!closing.postingHash) fields.add("PostingHash");
    if (claim && closing.postingHash !== claim.hash) fields.add("PostingHash/Claim");
    if (claim && closing.version < claim.version + 2) fields.add("Version/Claim");
    if (closing.lineVersion > closing.version || closing.lineVersion < 1) fields.add("LineVersion");
    if (!closing.postingBasis) fields.add("PostingBasis");
    else {
      const basis = closing.postingBasis;
      for (const [field, actual, original] of [
        ["CompanyDB", closing.companyDB, basis.companyDB],
        ["PeriodStart", closing.periodStart, basis.periodStart],
        ["PeriodEnd", closing.periodEnd, basis.periodEnd],
        ["Branch", closing.branch, basis.branch],
        ["Dimensions", closing.dimensions, basis.dimensions],
        ["TotalGgf", closing.totalGgf, basis.totals.ggf],
        ["TotalAllocated", closing.totalAllocated, basis.totals.allocated],
        ["TotalRevalued", closing.totalRevalued, basis.totals.revalued]
      ] as const) if (!equal(actual, original)) fields.add(field);
      if (closing.lines.length !== basis.lines.length) fields.add("Lines/count");
      if (!equal(functionalLines(closing), basis.lines.map(({ status, ...line }) => line)
        .sort((a, b) => `${a.account}/${a.orderId}/${a.item}/${a.warehouse}`
          .localeCompare(`${b.account}/${b.orderId}/${b.item}/${b.warehouse}`)))) fields.add("Lines/content");
      if (!equal(closing.proposedPayload, basis.payload)) fields.add("ProposedPayload");
      const currentFunctionalContent = {
        ...basis,
        companyDB: closing.companyDB,
        periodStart: closing.periodStart,
        periodEnd: closing.periodEnd,
        branch: closing.branch,
        dimensions: closing.dimensions,
        totals: { ggf: closing.totalGgf, allocated: closing.totalAllocated,
          revalued: closing.totalRevalued },
        lines: closing.lines,
        payload: closing.proposedPayload ?? {}
      };
      try { recalculatedHash = await postingHash(currentFunctionalContent); }
      catch { fields.add("PostingBasis/hashInput"); }
      if (recalculatedHash !== closing.postingHash) fields.add("PostingHash/recalculated");
      if (claim && recalculatedHash !== claim.hash) fields.add("Claim/recalculated");
    }
    try { await assertClosingConsistency(closing); }
    catch { fields.add("Header/Lines/PostingBasis"); }
  }
  return {
    status: !postedContent ? "NOT_APPLICABLE" : fields.size ? "INTEGRITY_VIOLATION" : "VALID",
    closingId: closing.closingId, version: closing.version,
    closingStatus: closing.status,
    sapDocEntry: closing.sapMaterialRevaluationDocEntry,
    sapDocNum: closing.sapMaterialRevaluationDocNum,
    sapTransId: closing.sapJournalTransId,
    originalHash: claim?.hash ?? closing.postingHash, persistedHash: closing.postingHash,
    recalculatedHash, detectedAt: context.now?.() ?? new Date().toISOString(),
    ...safeContext,
    divergentFields: [...fields].sort()
  };
}
