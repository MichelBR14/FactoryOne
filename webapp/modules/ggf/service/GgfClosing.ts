import { divRound, parseDecimal } from "../../../core/util/money";
import type { FifoClosingTrace } from "./FifoProductionTrace";

export const CLOSING_STATUSES = [
  "DRAFT", "CALCULATED", "VALIDATED", "READY_TO_POST", "POSTING",
  "POSTING_UNCERTAIN", "POSTED", "FAILED", "REOPENED", "CANCELLED"
] as const;
export type ClosingStatus = typeof CLOSING_STATUSES[number];

export interface ClosingLine {
  account: string;
  criterion: string;
  orderId: string;
  item: string;
  warehouse: string;
  basis: string;
  percent: string;
  allocated: string;
  costBefore: string;
  costAfter: string;
  revaluation: string;
  status: string;
}

export interface PostingBasis {
  companyDB: string;
  periodStart: string;
  periodEnd: string;
  branch: string;
  dimensions: Record<string, string>;
  totals: { ggf: string; allocated: string; revalued: string };
  accounts: Array<{ account: string; amount: string; percent: string; criterion: string }>;
  lines: ClosingLine[];
  inventoryAccounts: Record<string, string>;
  /** Persisted in U_PostingBasis and covered by PostingHash for future FIFO closings. */
  fifoLineage?: FifoClosingTrace[];
  payload: Record<string, unknown>;
}

export interface GgfClosing {
  closingId: string;
  companyDB: string;
  periodStart: string;
  periodEnd: string;
  branch: string;
  dimensions: Record<string, string>;
  status: ClosingStatus;
  version: number;
  lineVersion: number;
  createdAt: string;
  createdBy: string;
  calculatedAt: string | null;
  postedAt: string | null;
  totalGgf: string;
  totalAllocated: string;
  totalRevalued: string;
  sapMaterialRevaluationDocEntry: number | null;
  sapMaterialRevaluationDocNum: number | null;
  sapJournalTransId: number | null;
  postingHash: string | null;
  reopenedFrom: string | null;
  cancelledAt: string | null;
  notes: string;
  lastError: string | null;
  postingBasis: PostingBasis | null;
  proposedPayload: Record<string, unknown> | null;
  lines: ClosingLine[];
  /** Calculated on read; never stored in the SAP closing header. */
  integrityStatus?: "VALID" | "INTEGRITY_VIOLATION" | "NOT_APPLICABLE";
}

export interface SapPostingLink {
  docEntry: number;
  docNum: number;
  transId: number;
}

const transitions: Record<ClosingStatus, readonly ClosingStatus[]> = {
  DRAFT: ["CALCULATED", "CANCELLED"],
  CALCULATED: ["VALIDATED", "DRAFT", "CANCELLED"],
  VALIDATED: ["READY_TO_POST", "CALCULATED", "CANCELLED"],
  READY_TO_POST: ["POSTING", "POSTING_UNCERTAIN", "CALCULATED", "CANCELLED"],
  POSTING: ["POSTED", "FAILED", "POSTING_UNCERTAIN"],
  POSTING_UNCERTAIN: ["POSTED", "FAILED"],
  POSTED: ["REOPENED"],
  FAILED: ["POSTING_UNCERTAIN", "CANCELLED"],
  REOPENED: ["CALCULATED", "CANCELLED"],
  CANCELLED: []
};

export function transitionClosing(closing: GgfClosing, status: ClosingStatus): GgfClosing {
  if (!transitions[closing.status].includes(status))
    throw new Error(`GGF closing transition ${closing.status} -> ${status} is blocked`);
  return { ...closing, status, version: closing.version + 1 };
}

export function assertClosingIdentity(closing: GgfClosing): void {
  if (!/^[A-Za-z0-9_-]{1,30}$/.test(closing.closingId) || !closing.companyDB ||
      !Number.isSafeInteger(closing.version) || closing.version < 1 ||
      !Number.isSafeInteger(closing.lineVersion) || closing.lineVersion < 1)
    throw new Error("Invalid GGF closing identity");
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => {
      if (v === undefined || /^(session|token|createdAt|calculatedAt|postedAt|capturedAt)$/i.test(k))
        throw new Error(`Volatile or undefined posting field: ${k}`);
      return [k, canonical(v)];
    }));
  throw new Error("Non-JSON posting value");
}

/** SHA-256 of functional input only; no timestamps, session data, or transport state. */
export async function postingHash(input: PostingBasis): Promise<string> {
  if (!input.companyDB || !input.periodStart || !input.periodEnd || !input.accounts.length ||
      !input.lines.length || !Array.isArray(input.payload.MaterialRevaluationLines) ||
      !(globalThis.crypto?.subtle)) throw new Error("Incomplete posting basis or SHA-256 unavailable");
  const keys = input.lines.map(l => `${l.account}/${l.orderId}/${l.item}/${l.warehouse}`);
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate GGF closing audit line");
  if (input.fifoLineage) {
    const receiptKeys = new Set<string>();
    for (const lineage of input.fifoLineage) {
      const key = `${lineage.receiptDocEntry}/${lineage.receiptLine}`;
      const qty = /^\d+(?:\.\d{1,6})?$/.test(lineage.originalLayerQuantity) ? parseDecimal(lineage.originalLayerQuantity, 6) : null;
      const remaining = /^\d+(?:\.\d{1,6})?$/.test(lineage.remainingLayerQuantity) ? parseDecimal(lineage.remainingLayerQuantity, 6) : null;
      const consumed = /^\d+(?:\.\d{1,6})?$/.test(lineage.consumedQuantity) ? parseDecimal(lineage.consumedQuantity, 6) : null;
      const layerCost = /^\d+(?:\.\d{1,6})?$/.test(lineage.originalLayerCost) ? parseDecimal(lineage.originalLayerCost, 6) : null;
      const resultCost = lineage.resultLayerCost !== null && /^\d+(?:\.\d{1,6})?$/.test(lineage.resultLayerCost)
        ? parseDecimal(lineage.resultLayerCost, 6) : null;
      const openValue = /^\d+(?:\.\d{1,6})?$/.test(lineage.remainingLayerValue) ? parseDecimal(lineage.remainingLayerValue) : null;
      if (!lineage.closingId || !Number.isSafeInteger(lineage.version) || lineage.version < 1 ||
          !Number.isSafeInteger(lineage.productionOrderDocEntry) || lineage.productionOrderDocEntry <= 0 ||
          !Number.isSafeInteger(lineage.productionOrderDocNum) || lineage.productionOrderDocNum <= 0 ||
          !Number.isSafeInteger(lineage.receiptDocEntry) || lineage.receiptDocEntry <= 0 ||
          !Number.isSafeInteger(lineage.receiptLine) || lineage.receiptLine < 0 ||
          !Number.isSafeInteger(lineage.receiptDocNum) || lineage.receiptDocNum <= 0 ||
          !lineage.itemCode || !lineage.warehouseCode || !lineage.originalLayerId ||
          !Number.isSafeInteger(lineage.originalLayerId.transactionSequenceNum) || lineage.originalLayerId.transactionSequenceNum <= 0 ||
          !Number.isSafeInteger(lineage.originalLayerId.layerId) || lineage.originalLayerId.layerId < 0 ||
          qty === null || qty <= 0n || remaining === null || consumed === null || remaining + consumed !== qty ||
          !/^\d+(?:\.\d{1,6})?$/.test(lineage.originalProducedQuantity) ||
          parseDecimal(lineage.originalProducedQuantity, 6) < qty ||
          layerCost === null || openValue === null || remaining === null ||
          divRound(remaining * (lineage.revaluationDocEntry === null ? layerCost : (resultCost ?? -1n)),
            10_000_000_000n) !== openValue ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(lineage.traceTimestamp) ||
          !["FIFO_FULLY_AVAILABLE","FIFO_PARTIALLY_CONSUMED","FIFO_FULLY_CONSUMED",
            "FIFO_LAYER_NOT_FOUND","FIFO_MULTIPLE_LAYERS","FIFO_TRACE_AMBIGUOUS"].includes(lineage.traceStatus) ||
          receiptKeys.has(key) ||
          ((lineage.revaluationDocEntry === null) !== (lineage.resultLayerId === null)) ||
          (lineage.revaluationDocEntry !== null && (!Number.isSafeInteger(lineage.revaluationDocEntry) ||
            lineage.revaluationDocEntry <= 0 ||
            !Number.isSafeInteger(lineage.revaluationDocNum) || (lineage.revaluationDocNum ?? 0) <= 0 ||
            !Number.isSafeInteger(lineage.resultLayerId?.transactionSequenceNum) ||
            !Number.isSafeInteger(lineage.resultLayerId?.layerId) ||
            lineage.resultLayerQuantity !== lineage.remainingLayerQuantity || resultCost === null)) ||
          (lineage.revaluationDocEntry === null && (lineage.revaluationDocNum !== null ||
            lineage.resultLayerQuantity !== null || lineage.resultLayerCost !== null)))
        throw new Error("Incomplete or duplicate FIFO closing lineage");
      receiptKeys.add(key);
    }
  }
  const stable = canonical({
    companyDB: input.companyDB, periodStart: input.periodStart, periodEnd: input.periodEnd,
    branch: input.branch, dimensions: input.dimensions, totals: input.totals,
    accounts: [...input.accounts].sort((a, b) => a.account.localeCompare(b.account)),
    lines: [...input.lines].map(({status, ...functional}) => functional).sort((a, b) =>
      `${a.account}/${a.orderId}/${a.item}/${a.warehouse}`.localeCompare(`${b.account}/${b.orderId}/${b.item}/${b.warehouse}`)),
    inventoryAccounts: input.inventoryAccounts,
    ...(input.fifoLineage ? { fifoLineage: [...input.fifoLineage].map(({version,traceTimestamp,...functional}) => functional)
      .sort((a, b) => `${a.receiptDocEntry}/${a.receiptLine}`.localeCompare(`${b.receiptDocEntry}/${b.receiptLine}`)) } : {}),
    payload: input.payload
  });
  const bytes = new TextEncoder().encode(JSON.stringify(stable));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

const functionalLines = (lines: ClosingLine[]) => lines.map(({ status, ...functional }) => functional)
  .sort((a, b) => `${a.account}/${a.orderId}/${a.item}/${a.warehouse}`
    .localeCompare(`${b.account}/${b.orderId}/${b.item}/${b.warehouse}`));

/** Detects a partial/tampered SAP record before it can be used or advanced. */
export async function assertClosingConsistency(closing: GgfClosing): Promise<void> {
  assertClosingIdentity(closing);
  if (closing.status === "POSTED" &&
      (!closing.sapMaterialRevaluationDocEntry || !closing.sapMaterialRevaluationDocNum ||
       !closing.sapJournalTransId || !closing.postedAt))
    throw new Error("POSTED closing lacks a verified SAP document link");
  const allocated = closing.lines.reduce((total, line) => total + parseDecimal(line.allocated), 0n);
  const revalued = closing.lines.reduce((total, line) => total + parseDecimal(line.revaluation), 0n);
  if (parseDecimal(closing.totalGgf) !== allocated ||
      parseDecimal(closing.totalAllocated) !== allocated ||
      parseDecimal(closing.totalRevalued) !== revalued)
    throw new Error("GGF closing header and audit line totals differ");
  const basis = closing.postingBasis;
  if (!basis) {
    if (closing.lines.length || closing.postingHash || closing.proposedPayload ||
        ["READY_TO_POST","POSTING","POSTING_UNCERTAIN","POSTED","FAILED"].includes(closing.status))
      throw new Error("GGF closing has lines or hash without persisted posting basis");
    return;
  }
  if (!closing.postingHash || !closing.proposedPayload ||
      basis.fifoLineage?.some(lineage => lineage.closingId !== closing.closingId) ||
      basis.companyDB !== closing.companyDB || basis.periodStart !== closing.periodStart ||
      basis.periodEnd !== closing.periodEnd || basis.branch !== closing.branch ||
      JSON.stringify(canonical(basis.dimensions)) !== JSON.stringify(canonical(closing.dimensions)) ||
      basis.totals.ggf !== closing.totalGgf || basis.totals.allocated !== closing.totalAllocated ||
      basis.totals.revalued !== closing.totalRevalued ||
      basis.lines.length !== closing.lines.length ||
      JSON.stringify(canonical(functionalLines(basis.lines))) !==
        JSON.stringify(canonical(functionalLines(closing.lines))) ||
      JSON.stringify(canonical(basis.payload)) !== JSON.stringify(canonical(closing.proposedPayload)) ||
      await postingHash(basis) !== closing.postingHash)
    throw new Error("GGF closing functional content or PostingHash differs");
}
