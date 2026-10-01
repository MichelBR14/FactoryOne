export type GgfPostingPlanStatus = "DRAFT" | "VALIDATED" | "READY_TO_POST" | "BLOCKED";
export type GgfPostingDocumentType = "MaterialRevaluation" | "JournalEntry.CPV" | "JournalEntry.Closing";

export interface GgfPostingPlanLine {
  id: string;
  orderNumber: string;
  item: string;
  accountOriginal: string | null;
  category: "MOD" | "GGF";
  criterion: string | null;
  quantity: string | null;
  unit: string | null;
  amountCents: string;
  stockCents: string | null;
  consumedCents: string | null;
  valuationMethod: string | null;
  dimensions: string[];
  futureDocumentTypes: GgfPostingDocumentType[];
  effects: Array<{ documentType: GgfPostingDocumentType; amountCents: string; debitAccount: string; creditAccount: string }>;
  debitAccounts: string[];
  creditAccounts: string[];
  status: string;
  blockers: string[];
  sourceRefs: string[];
}

export interface GgfPostingPlanDocumentLine {
  orderNumber: string | null;
  item: string | null;
  warehouse: string | null;
  category: "MOD" | "GGF";
  accountOriginal: string | null;
  criterion: string | null;
  quantity: string | null;
  unit: string | null;
  amountCents: string;
  debitAccount: string;
  creditAccount: string;
  dimensions: string[];
  sourceOrderRefs: string[];
  status: "VALIDATED";
  blockers: [];
  dependencies: string[];
  payload: null;
}

export interface GgfPostingPlanDocument {
  type: GgfPostingDocumentType;
  order: number;
  totalCents: string;
  currency: string | null;
  lines: GgfPostingPlanDocumentLine[];
  dimensions: string[][];
  status: "VALIDATED" | "NOT_REQUIRED" | "BLOCKED";
  blockers: string[];
  dependencies: string[];
  payload: null;
}

export interface GgfPostingPlan {
  /** Explicitly isolated test ledger plan. Never produced by the product UI. */
  technicalOnly?: boolean;
  closingId: string;
  version: number;
  closingVersion: number | null;
  postingHash: string;
  createdAt: string;
  createdBy: string | null;
  status: GgfPostingPlanStatus;
  companyDB: string;
  periodStart: string;
  periodEnd: string;
  branch: string;
  dimensions: string[];
  currency: string | null;
  currencySource: string | null;
  totalMod: string;
  totalGgf: string;
  totalStock: string;
  totalCpv: string;
  totalBlocked: string;
  totalDifference: string;
  accountingDifference: string;
  lines: GgfPostingPlanLine[];
  documents: GgfPostingPlanDocument[];
  blockers: string[];
  sourceMode: "SAP_READ_ONLY";
  sourceCapturedAt: string;
  postingBlocked: true;
}

export type GgfPostingPlanDraft = Omit<GgfPostingPlan, "version" | "postingHash" | "createdAt">;

type Preview = ReturnType<typeof import("./AccountingPreview").buildAccountingPreview>;

const abs = (value: bigint) => value < 0n ? -value : value;
const sameDimensions = (left: string[], right: string[]) => JSON.stringify(left) === JSON.stringify(right);

function stable(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  throw new Error("Posting plan contains a non-JSON value");
}

function functionalContent(plan: GgfPostingPlan) {
  const { postingHash: _hash, createdAt: _created, createdBy: _creator, sourceCapturedAt: _captured, ...functional } = plan;
  return stable(functional);
}

export async function calculateGgfPostingPlanHash(plan: GgfPostingPlan): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("SHA-256 is unavailable for the posting plan");
  const bytes = new TextEncoder().encode(JSON.stringify(functionalContent(plan)));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function canMarkGgfPostingPlanReady(plan: GgfPostingPlan): boolean {
  return plan.status === "VALIDATED" && plan.blockers.length === 0 && plan.totalBlocked === "0" &&
    plan.totalDifference === "0" && plan.documents.every(document => document.status !== "BLOCKED") &&
    plan.lines.every(line => line.status === "READY" && line.blockers.length === 0);
}

export function buildGgfPostingPlanDraft(
  preview: Preview,
  context: {
    closingId: string;
    companyDB: string;
    periodStart: string;
    periodEnd: string;
    branch: string;
    dimensions: string[];
    currency: string | null;
    currencySource: string | null;
    sourceCapturedAt: string;
    closingVersion?: number | null;
    createdBy?: string | null;
  }
): GgfPostingPlanDraft {
  const blockers = new Set<string>();
  if (!context.currency) blockers.add("CURRENCY_UNRESOLVED");
  if (preview.totals.differenceCents !== "0") blockers.add("TOTAL_RECONCILIATION_DIFFERENCE");
  if (preview.totals.accountingDifferenceCents !== "0") blockers.add("DEBIT_CREDIT_DIFFERENCE");
  if (preview.totals.blockedCents !== "0") blockers.add("BLOCKED_VALUE_REMAINS");

  const documents = preview.documents.map((document, index): GgfPostingPlanDocument => {
    const type = document.documentType;
    const requiredCents = type === "MaterialRevaluation" ? preview.totals.stockCents
      : type === "JournalEntry.CPV" ? preview.totals.cpvCents
        : (BigInt(preview.totals.stockCents) + BigInt(preview.totals.cpvCents)).toString();
    const needed = requiredCents !== "0";
    const destinationUndetermined = preview.totals.blockedCents !== "0";
    const documentBlockers = new Set<string>();
    if (needed && !context.currency) documentBlockers.add("CURRENCY_UNRESOLVED");
    if (!needed && destinationUndetermined) documentBlockers.add("DESTINATION_NOT_DETERMINED");
    if (needed && document.lines.length === 0) documentBlockers.add("REQUIRED_DOCUMENT_LINES_MISSING");
    if (document.lines.length && !document.balanced) documentBlockers.add("DOCUMENT_NOT_BALANCED");
    if (document.lines.some(line => line.payload !== null)) documentBlockers.add("FINANCIAL_PAYLOAD_FORBIDDEN");
    if (document.lines.length && document.lines.some(line => !line.dimensions || !Array.isArray(line.dimensions)))
      documentBlockers.add("DOCUMENT_DIMENSIONS_INVALID");

    const rawLines = document.lines.map(line => {
      const contributing = document.documentType === "JournalEntry.Closing"
        ? preview.entries.filter(source => source.category === line.category && source.origin !== "CLOSING" &&
            sameDimensions(source.dimensions, line.dimensions))
        : preview.entries.filter(source => source.category === line.category && source.origin === line.origin &&
            source.orderNumber === line.orderNumber && source.item === line.item);
      const sourceRows = preview.rows.filter(row => contributing.some(source =>
        source.orderNumber === row.orderNumber && source.item === row.item && source.category === row.category));
      const sourceOrderRefs = [...new Set(sourceRows.map(row => row.id))].sort();
      const dependencies = type === "MaterialRevaluation"
        ? ["STOCK_TRACE", "VALUATION_METHOD", "INVENTORY_ACCOUNT_DETERMINATION"]
        : type === "JournalEntry.CPV" ? ["CONSUMPTION_CLASSIFICATION", "CPV_ACCOUNT", "DIMENSIONS"]
          : ["STOCK_AND_CPV_DOCUMENTS", "TRANSITORY_ACCOUNT", "CLOSING_ACCOUNT", "DIMENSIONS"];
      if (type === "JournalEntry.Closing" && !sourceOrderRefs.length) documentBlockers.add("CLOSING_LINE_WITHOUT_ORDER_TRACE");
      return { orderNumber: line.orderNumber, item: line.item, warehouse: line.warehouse,
        category: line.category, accountOriginal: line.accountOriginal, criterion: line.criterion,
        quantity: line.quantity, unit: line.unit, amountCents: line.amountCents,
        debitAccount: line.debitAccount, creditAccount: line.creditAccount, dimensions: [...line.dimensions],
        sourceOrderRefs, status: "VALIDATED" as const, blockers: [] as [], dependencies, payload: null };
    });
    const totalCents = rawLines.reduce((sum, line) => sum + BigInt(line.amountCents), 0n).toString();
    if (needed && totalCents !== requiredCents) documentBlockers.add("DOCUMENT_TOTAL_DIFFERS_FROM_DESTINATION");
    if (document.lines.length === 0 && needed) documentBlockers.add("DOCUMENT_BLOCKED_BY_SOURCE");
    for (const reason of documentBlockers) blockers.add(`${type}:${reason}`);
    return { type, order: index + 1, totalCents, currency: context.currency,
      lines: rawLines, dimensions: [...new Map(rawLines.map(line => [JSON.stringify(line.dimensions), line.dimensions])).values()],
      status: documentBlockers.size ? "BLOCKED" : needed ? "VALIDATED" : "NOT_REQUIRED",
      blockers: [...documentBlockers].sort(),
      dependencies: type === "MaterialRevaluation" ? ["PRODUCTION_ORDER_STOCK_TRACE", "SAP_INVENTORY_ACCOUNT"]
        : type === "JournalEntry.CPV" ? ["OUTFLOW_CLASSIFICATION", "CPV_GL_ACCOUNT"]
          : ["MATERIAL_REVALUATION_AND_CPV_PLANS", "TRANSITORY_AND_CLOSING_ACCOUNTS"],
      payload: null };
  });

  const effectsByRow = new Map<string, GgfPostingPlanLine["effects"]>();
  for (const document of documents) for (const planned of document.lines) {
    for (const sourceId of planned.sourceOrderRefs) {
      const effect = { documentType: document.type, amountCents: planned.amountCents,
        debitAccount: planned.debitAccount, creditAccount: planned.creditAccount };
      effectsByRow.set(sourceId, [...(effectsByRow.get(sourceId) ?? []), effect]);
    }
  }
  const lines: GgfPostingPlanLine[] = preview.rows.map(row => {
    const stockAmount = row.stockCents ?? "0";
    const consumedAmount = row.consumedCents ?? "0";
    const futureDocumentTypes: GgfPostingDocumentType[] = [];
    if (stockAmount !== "0") futureDocumentTypes.push("MaterialRevaluation");
    if (consumedAmount !== "0") futureDocumentTypes.push("JournalEntry.CPV");
    const effects = effectsByRow.get(row.id) ?? [];
    const reasons: string[] = [...row.reasons];
    if (row.status !== "READY" && !reasons.length) reasons.push(String(row.status));
    return { id: row.id, orderNumber: row.orderNumber, item: row.item, accountOriginal: row.accountOriginal,
      category: row.category, criterion: row.criterion, quantity: row.quantity, unit: row.unit,
      amountCents: row.amountCents, stockCents: row.stockCents, consumedCents: row.consumedCents,
      valuationMethod: row.valuationMethod, dimensions: [...row.dimensions], futureDocumentTypes,
      effects, debitAccounts: [...new Set(effects.map(effect => effect.debitAccount))].sort(),
      creditAccounts: [...new Set(effects.map(effect => effect.creditAccount))].sort(),
      status: row.status, blockers: reasons, sourceRefs: [...row.sourceRefs] };
  });

  const totalMod = preview.summaries.find(summary => summary.category === "MOD")?.toAbsorbCents ?? "0";
  const totalGgf = preview.summaries.find(summary => summary.category === "GGF")?.toAbsorbCents ?? "0";
  if (BigInt(totalMod) + BigInt(totalGgf) !== BigInt(preview.totals.stockCents) +
      BigInt(preview.totals.cpvCents) + BigInt(preview.totals.blockedCents))
    blockers.add("PLAN_TOTALS_DIVERGE");
  if (lines.some(line => line.status !== "READY")) blockers.add("ACCOUNTING_LINE_BLOCKED");
  return { ...context,
    status: blockers.size ? "BLOCKED" as const : "VALIDATED" as const,
    closingVersion: context.closingVersion ?? null,
    createdBy: context.createdBy ?? null,
    totalMod, totalGgf, totalStock: preview.totals.stockCents, totalCpv: preview.totals.cpvCents,
    totalBlocked: preview.totals.blockedCents, totalDifference: preview.totals.differenceCents,
    accountingDifference: preview.totals.accountingDifferenceCents,
    lines, documents, blockers: [...blockers].sort(), sourceMode: "SAP_READ_ONLY" as const,
    postingBlocked: true as const };
}

export class LocalGgfPostingPlanRepository {
  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem">, private readonly now = () => new Date().toISOString()) {}

  async list(closingId?: string): Promise<GgfPostingPlan[]> {
    let parsed: unknown;
    try { parsed = JSON.parse(this.storage.getItem("factoryone.ggf.v2.posting-plans") ?? "[]"); }
    catch { throw new Error("Posting plan local store is invalid"); }
    if (!Array.isArray(parsed)) throw new Error("Posting plan local store is invalid");
    const plans = parsed as GgfPostingPlan[];
    const identities = new Set<string>();
    for (const plan of plans) {
      const identity = `${plan.closingId}/${plan.version}`;
      if (!plan || !plan.closingId || !Number.isSafeInteger(plan.version) || plan.version < 1 || identities.has(identity) ||
          !/^[a-f0-9]{64}$/.test(plan.postingHash) || plan.postingBlocked !== true ||
          await calculateGgfPostingPlanHash(plan) !== plan.postingHash)
        throw new Error("Posting plan local integrity verification failed");
      identities.add(identity);
    }
    return plans.filter(plan => !closingId || plan.closingId === closingId).map(plan => structuredClone(plan));
  }

  async append(draft: GgfPostingPlanDraft): Promise<GgfPostingPlan> {
    const plans = await this.list();
    const version = Math.max(0, ...plans.filter(plan => plan.closingId === draft.closingId).map(plan => plan.version)) + 1;
    const plan = { ...draft, version, createdAt: this.now(), postingHash: "" } as GgfPostingPlan;
    plan.postingHash = await calculateGgfPostingPlanHash(plan);
    const next = [...plans, plan];
    this.storage.setItem("factoryone.ggf.v2.posting-plans", JSON.stringify(next));
    const reread = await this.list(draft.closingId);
    const saved = reread.find(row => row.version === version);
    if (!saved || saved.postingHash !== plan.postingHash) throw new Error("Posting plan local write/readback differs");
    return saved;
  }
}

export function technicalPostingPlanId(companyDB: string, periodStart: string): string {
  const month = /^\d{4}-\d{2}-\d{2}$/.test(periodStart) ? periodStart.slice(0, 7).replace("-", "") : "UNKNOWN";
  const safeCompany = companyDB.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 15) || "UNKNOWN";
  return `TECH-${safeCompany}-${month}`.slice(0, 30);
}
