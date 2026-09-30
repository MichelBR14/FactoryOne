import { parseDecimal } from "../../../core/util/money";
import { postingHash, transitionClosing, type GgfClosing, type PostingBasis, type SapPostingLink } from "./GgfClosing";
import type { GgfClosingStore } from "../repository/SapGgfClosingRepository";

export interface RevaluationCandidate extends SapPostingLink {
  docDate: string;
  revalType: string;
  comments: string | null;
  journalMemo: string | null;
  lines: Array<{ item: string; warehouse: string; price: number; amount: string;
    incrementAccount: string | null; decrementAccount: string | null }>;
  journalLines: Array<{ account: string; debit: string; credit: string }>;
}

export interface RevaluationGateway {
  post(payload: Record<string, unknown>): Promise<SapPostingLink>;
  /** Read-only, exhaustive for the posting date. Incomplete reads must throw. */
  find(closing: GgfClosing): Promise<RevaluationCandidate[]>;
}

export interface ClosingMetadataGate {
  assertAvailable(): Promise<void>;
}

export class DefiniteSapRejection extends Error {
  constructor(readonly httpStatus: number, readonly sapCode?: number) {
    super("SAP rejected MaterialRevaluation without creating a document");
  }
}

const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const marker = (closing: GgfClosing) => `FactoryOne GGF ${closing.closingId}`;

function candidateMatches(closing: GgfClosing, candidate: RevaluationCandidate): boolean {
  const payload = closing.proposedPayload;
  if (!payload || !positive(candidate.docEntry) || !positive(candidate.docNum) || !positive(candidate.transId) ||
      candidate.docDate.slice(0, 10) !== payload.DocDate || candidate.revalType !== payload.RevalType ||
      !Array.isArray(payload.MaterialRevaluationLines)) return false;
  const known = closing.sapMaterialRevaluationDocEntry;
  if (known !== null && known !== candidate.docEntry) return false;
  if (known === null && candidate.comments !== marker(closing) && candidate.journalMemo !== marker(closing)) return false;
  const expected = payload.MaterialRevaluationLines as Array<Record<string, unknown>>;
  if (expected.length !== candidate.lines.length || !expected.length) return false;
  const sorted = <T extends { item: string; warehouse: string }>(rows: T[]) => [...rows].sort((a, b) =>
    `${a.item}/${a.warehouse}`.localeCompare(`${b.item}/${b.warehouse}`));
  const actual = sorted(candidate.lines);
  const wanted = sorted(expected.map(l => ({ item: String(l.ItemCode), warehouse: String(l.WarehouseCode), ...l })) as
    Array<{ item: string; warehouse: string; Price?: unknown; RevaluationIncrementAccount?: unknown; RevaluationDecrementAccount?: unknown }>);
  try {
    for (let i = 0; i < actual.length; i++) {
      const a = actual[i]!;
      const w = wanted[i]!;
      if (a.item !== w.item || a.warehouse !== w.warehouse || a.price !== w.Price ||
          (w.RevaluationIncrementAccount !== undefined && w.RevaluationIncrementAccount !== a.incrementAccount) ||
          (w.RevaluationDecrementAccount !== undefined && w.RevaluationDecrementAccount !== a.decrementAccount)) return false;
    }
    const amount = candidate.lines.reduce((n, l) => n + parseDecimal(l.amount), 0n);
    const wantedAmount = parseDecimal(closing.totalRevalued);
    if (amount !== wantedAmount || candidate.journalLines.length < 2) return false;
    const debits = candidate.journalLines.reduce((n, l) => n + parseDecimal(l.debit), 0n);
    const credits = candidate.journalLines.reduce((n, l) => n + parseDecimal(l.credit), 0n);
    const absolute = wantedAmount < 0n ? -wantedAmount : wantedAmount;
    if (debits !== absolute || credits !== absolute) return false;
    for (const [scope, account] of Object.entries(closing.postingBasis?.inventoryAccounts ?? {})) {
      if (!candidate.lines.some(l => `${l.item}/${l.warehouse}` === scope) ||
          !candidate.journalLines.some(l => l.account === account)) return false;
    }
    for (const l of candidate.lines) {
      const account = amount >= 0n ? l.incrementAccount : l.decrementAccount;
      if (!account || !candidate.journalLines.some(j => j.account === account)) return false;
    }
    return true;
  } catch { return false; }
}

/** Not wired to UI. The transport is injected, and SAP metadata must be installed first. */
export class GgfPostingCoordinator {
  constructor(private readonly store: GgfClosingStore, private readonly gateway: RevaluationGateway,
    private readonly metadata: ClosingMetadataGate,
    private readonly now: () => string = () => new Date().toISOString()) {}

  async prepareReady(closingId: string, basis: PostingBasis): Promise<GgfClosing> {
    await this.metadata.assertAvailable();
    const current = await this.required(closingId);
    if (current.status !== "VALIDATED" || current.sapMaterialRevaluationDocEntry !== null ||
        current.companyDB !== basis.companyDB || current.periodStart !== basis.periodStart ||
        current.periodEnd !== basis.periodEnd || current.branch !== basis.branch ||
        current.totalGgf !== basis.totals.ggf || current.totalAllocated !== basis.totals.allocated ||
        current.totalRevalued !== basis.totals.revalued ||
        JSON.stringify(current.dimensions) !== JSON.stringify(basis.dimensions))
      throw new Error("Validated closing and posting basis differ");
    if (basis.payload.Comments !== marker(current) || basis.payload.JournalMemo !== marker(current))
      throw new Error("Human audit marker differs from ClosingId");
    const hash = await postingHash(basis);
    const next = { ...transitionClosing(current, "READY_TO_POST"), postingHash: hash,
      postingBasis: structuredClone(basis), proposedPayload: structuredClone(basis.payload),
      lines: structuredClone(basis.lines), lastError: null };
    await this.store.replace(current, next);
    return next;
  }

  async post(closingId: string, basis: PostingBasis): Promise<GgfClosing> {
    await this.metadata.assertAvailable();
    const current = await this.required(closingId);
    if (current.status === "POSTED" || current.sapMaterialRevaluationDocEntry !== null)
      throw new Error("Closing already linked to a SAP MaterialRevaluation");
    if (current.status !== "READY_TO_POST") throw new Error(`Closing ${current.status} cannot be posted`);
    const hash = await postingHash(basis);
    if (current.postingHash !== hash || JSON.stringify(current.postingBasis) !== JSON.stringify(basis) ||
        JSON.stringify(current.proposedPayload) !== JSON.stringify(basis.payload))
      throw new Error("PostingHash or persisted payload differs; recalculate and revalidate");
    try { await this.store.claim(closingId, hash, current.version); }
    catch (error) {
      const claim = await this.store.getClaim(closingId);
      if (claim) return this.uncertain(current, claim.hash === hash && claim.version === current.version ?
        "CLAIM_EXISTS_BEFORE_POSTING_STATE" : "CLAIM_CONFLICT");
      throw error;
    }
    const posting = transitionClosing(current, "POSTING");
    await this.store.replace(current, posting);
    let response: SapPostingLink;
    try { response = await this.gateway.post(posting.proposedPayload!); }
    catch (error) {
      const definite = error instanceof DefiniteSapRejection;
      const next = { ...transitionClosing(posting, definite ? "FAILED" : "POSTING_UNCERTAIN"),
        lastError: definite ? `SAP_REJECTED_HTTP_${error.httpStatus}_CODE_${error.sapCode ?? "UNKNOWN"}` : "POST_RESPONSE_UNKNOWN" };
      await this.store.replace(posting, next);
      return next;
    }
    if (!positive(response.docEntry) || !positive(response.docNum) || !positive(response.transId))
      return this.uncertain(posting, "POST_RESPONSE_INCOMPLETE");
    const linked = { ...posting, sapMaterialRevaluationDocEntry: response.docEntry,
      sapMaterialRevaluationDocNum: response.docNum, sapJournalTransId: response.transId };
    try { return await this.reconcileCandidate(posting, linked); }
    catch { return this.uncertain(posting, "POST_VERIFICATION_UNAVAILABLE", response); }
  }

  async reconcile(closingId: string): Promise<GgfClosing> {
    const current = await this.required(closingId);
    if (current.status !== "POSTING" && current.status !== "POSTING_UNCERTAIN")
      throw new Error("Closing does not require posting reconciliation");
    try { return await this.reconcileCandidate(current, current); }
    catch { return this.uncertain(current, "RECONCILIATION_UNAVAILABLE"); }
  }

  private async reconcileCandidate(current: GgfClosing, linked: GgfClosing): Promise<GgfClosing> {
    const candidates = await this.gateway.find(linked);
    const matches = candidates.filter(c => candidateMatches(linked, c));
    if (matches.length !== 1) return this.uncertain(current, matches.length ? "MULTIPLE_SAP_MATCHES" : "NO_PROVEN_SAP_MATCH");
    const match = matches[0]!;
    const posted = { ...transitionClosing(current, "POSTED"), postedAt: this.now(), lastError: null,
      sapMaterialRevaluationDocEntry: match.docEntry, sapMaterialRevaluationDocNum: match.docNum,
      sapJournalTransId: match.transId };
    await this.store.replace(current, posted);
    return posted;
  }

  private async uncertain(current: GgfClosing, reason: string, link?: SapPostingLink): Promise<GgfClosing> {
    const next = { ...(current.status === "POSTING_UNCERTAIN" ? { ...current, version: current.version + 1 } :
      transitionClosing(current, "POSTING_UNCERTAIN")), lastError: reason,
      sapMaterialRevaluationDocEntry: link?.docEntry ?? current.sapMaterialRevaluationDocEntry,
      sapMaterialRevaluationDocNum: link?.docNum ?? current.sapMaterialRevaluationDocNum,
      sapJournalTransId: link?.transId ?? current.sapJournalTransId };
    await this.store.replace(current, next);
    return next;
  }

  private async required(id: string): Promise<GgfClosing> {
    const closing = await this.store.get(id);
    if (!closing) throw new Error("GGF closing not found in native SAP storage");
    return closing;
  }
}
