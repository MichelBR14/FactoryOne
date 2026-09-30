import { divRound, formatDecimal, parseDecimal } from "../../../core/util/money";

export type FifoProductionStatus =
  | "FIFO_FULLY_AVAILABLE"
  | "FIFO_PARTIALLY_CONSUMED"
  | "FIFO_FULLY_CONSUMED"
  | "FIFO_LAYER_NOT_FOUND"
  | "FIFO_MULTIPLE_LAYERS"
  | "FIFO_TRACE_AMBIGUOUS";

export interface FifoLayerKey { transactionSequenceNum: number; layerId: number }

export interface FifoProductionLineage {
  closingId: string | null;
  orderDocEntry: number;
  receiptDocEntry: number;
  receiptLine: number;
  receiptDocNum: number;
  item: string;
  warehouse: string;
  originalLayer: FifoLayerKey | null;
  remainingQuantity: string | null;
  revaluationDocEntry: number | null;
  revaluationDocNum?: number | null;
  resultLayer: FifoLayerKey | null;
}

/** Audit snapshot persisted inside a GGF closing PostingBasis, not a SAP posting instruction. */
export interface FifoClosingTrace {
  closingId: string;
  version: number;
  productionOrderDocEntry: number;
  productionOrderDocNum: number;
  receiptDocEntry: number;
  receiptDocNum: number;
  receiptLine: number;
  itemCode: string;
  warehouseCode: string;
  originalProducedQuantity: string;
  originalLayerId: FifoLayerKey;
  originalLayerQuantity: string;
  originalLayerCost: string;
  remainingLayerQuantity: string;
  consumedQuantity: string;
  remainingLayerValue: string;
  traceStatus: FifoProductionStatus;
  traceTimestamp: string;
  revaluationDocEntry: number | null;
  revaluationDocNum: number | null;
  resultLayerId: FifoLayerKey | null;
  resultLayerQuantity: string | null;
  resultLayerCost: string | null;
}

export interface FifoProductionInput {
  lineage: FifoProductionLineage;
  producedQuantity: string;
  receiptQuantity: string;
  unit: string;
  ggFMinor: string;
  layers: readonly (FifoLayerKey & {
    docNumber: string;
    docType: string;
    item: string;
    warehouse: string;
    openQuantity: string;
    currentCost: string;
  })[];
  independentlyIssuedQuantity?: string;
}

export interface FifoProductionPreview {
  status: FifoProductionStatus;
  lineage: FifoProductionLineage;
  producedQuantity: string | null;
  openQuantity: string | null;
  consumedQuantity: string | null;
  ggFUnitMinor: string | null;
  inventoryGgfMinor: string | null;
  consumedGgfMinor: string | null;
  accountingForConsumed: "PENDING";
  stockDisposition: "FIFO_STOCK_REVALUATION_CANDIDATE" | null;
  consumedDisposition: "FIFO_CONSUMED_GGF_PENDING_ACCOUNTING_RULE" | null;
  potentialRevaluationMinor: string | null;
  payload: null;
}

const QTY_SCALE = 1_000_000n;
const quantity = (value: string): bigint | null =>
  typeof value === "string" && /^\d+(?:\.\d{1,6})?$/.test(value) ? parseDecimal(value, 6) : null;
const validKey = (key: FifoLayerKey | null): key is FifoLayerKey =>
  key !== null && Number.isSafeInteger(key.transactionSequenceNum) && key.transactionSequenceNum > 0 &&
  Number.isSafeInteger(key.layerId) && key.layerId >= 0;

function blocked(input: FifoProductionInput, status: FifoProductionStatus): FifoProductionPreview {
  return { status, lineage: input.lineage, producedQuantity: null, openQuantity: null,
    consumedQuantity: null, ggFUnitMinor: null, inventoryGgfMinor: null,
    consumedGgfMinor: null, accountingForConsumed: "PENDING", stockDisposition: null,
    consumedDisposition: null, potentialRevaluationMinor: null, payload: null };
}

/** The original receipt quantity remains the divisor even after part of its FIFO layer is consumed. */
export function previewFifoProduction(input: FifoProductionInput): FifoProductionPreview {
  const { lineage } = input;
  const produced = quantity(input.producedQuantity), received = quantity(input.receiptQuantity);
  const ggF = /^\d+$/.test(input.ggFMinor) ? BigInt(input.ggFMinor) : null;
  if (!Number.isSafeInteger(lineage.orderDocEntry) || lineage.orderDocEntry <= 0 ||
      !Number.isSafeInteger(lineage.receiptDocEntry) || lineage.receiptDocEntry <= 0 ||
      !Number.isSafeInteger(lineage.receiptLine) || lineage.receiptLine < 0 ||
      !Number.isSafeInteger(lineage.receiptDocNum) || lineage.receiptDocNum <= 0 ||
      !lineage.item || !lineage.warehouse || !input.unit || produced === null || produced <= 0n ||
      received === null || received !== produced || ggF === null ||
      (lineage.revaluationDocEntry !== null && (!validKey(lineage.resultLayer) ||
        !Number.isSafeInteger(lineage.revaluationDocNum) || (lineage.revaluationDocNum ?? 0) <= 0)))
    return blocked(input, "FIFO_TRACE_AMBIGUOUS");

  const layerKey = lineage.resultLayer ?? lineage.originalLayer;
  if (!validKey(layerKey)) return blocked(input, "FIFO_LAYER_NOT_FOUND");
  const matched = input.layers.filter(layer =>
    layer.transactionSequenceNum === layerKey.transactionSequenceNum && layer.layerId === layerKey.layerId);
  if (matched.length === 0) return blocked(input, "FIFO_LAYER_NOT_FOUND");
  if (matched.length > 1) return blocked(input, "FIFO_MULTIPLE_LAYERS");
  const source = matched[0]!;
  const open = quantity(source.openQuantity);
  const issued = input.independentlyIssuedQuantity === undefined ? null : quantity(input.independentlyIssuedQuantity);
  if (source.item !== lineage.item || source.warehouse !== lineage.warehouse ||
      (lineage.revaluationDocEntry === null &&
        (source.docNumber !== String(lineage.receiptDocNum) || source.docType !== "ttGeneralReceiptToStock")) ||
      (lineage.revaluationDocEntry !== null &&
        (source.docNumber !== String(lineage.revaluationDocNum) || source.docType !== "ttInventoryValuation")) ||
      open === null || open > produced ||
      (issued !== null && issued !== produced - open) ||
      (input.independentlyIssuedQuantity !== undefined && issued === null))
    return blocked(input, "FIFO_TRACE_AMBIGUOUS");

  const consumed = produced - open;
  const inventory = divRound(ggF * open, produced);
  return {
    status: open === produced ? "FIFO_FULLY_AVAILABLE" : open === 0n ? "FIFO_FULLY_CONSUMED" : "FIFO_PARTIALLY_CONSUMED",
    lineage: { ...lineage, remainingQuantity: formatDecimal(open, 6) },
    producedQuantity: formatDecimal(produced, 6), openQuantity: formatDecimal(open, 6),
    consumedQuantity: formatDecimal(consumed, 6),
    ggFUnitMinor: formatDecimal(divRound(ggF * QTY_SCALE * QTY_SCALE, produced), 6),
    inventoryGgfMinor: inventory.toString(), consumedGgfMinor: (ggF - inventory).toString(),
    accountingForConsumed: "PENDING",
    stockDisposition: open > 0n ? "FIFO_STOCK_REVALUATION_CANDIDATE" : null,
    consumedDisposition: consumed > 0n ? "FIFO_CONSUMED_GGF_PENDING_ACCOUNTING_RULE" : null,
    potentialRevaluationMinor: open > 0n ? inventory.toString() : null,
    payload: null
  };
}

/** An OP with more than one receipt/layer needs allocation by receipt before any layer-level proposal. */
export function classifyFifoOrderTraces(traces: readonly FifoProductionInput[]): FifoProductionStatus {
  if (!traces.length) return "FIFO_LAYER_NOT_FOUND";
  const previews = traces.map(previewFifoProduction);
  if (previews.some(row => row.status === "FIFO_TRACE_AMBIGUOUS")) return "FIFO_TRACE_AMBIGUOUS";
  if (previews.some(row => row.status === "FIFO_LAYER_NOT_FOUND")) return "FIFO_LAYER_NOT_FOUND";
  const receipts = new Set(traces.map(row => `${row.lineage.receiptDocEntry}/${row.lineage.receiptLine}`));
  const layers = new Set(traces.map(row => `${row.lineage.originalLayer?.transactionSequenceNum}/${row.lineage.originalLayer?.layerId}`));
  if (receipts.size !== traces.length || layers.size !== traces.length) return "FIFO_TRACE_AMBIGUOUS";
  if (traces.length > 1) return "FIFO_MULTIPLE_LAYERS";
  return previews[0]!.status;
}
