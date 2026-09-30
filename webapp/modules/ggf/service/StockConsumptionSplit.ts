import { divRound, formatDecimal, parseDecimal } from "../../../core/util/money";

const QTY_SCALE = 1_000_000n;

export type StockConsumptionStatus =
  | "STOCK_REVALUATION_CANDIDATE"
  | "CPV_ADJUSTMENT_CANDIDATE"
  | "CONSUMPTION_UNCLASSIFIED"
  | "BLOCKED_AMBIGUOUS_TRACE"
  | "BLOCKED_STOCK_NEGATIVE"
  | "BLOCKED_ZERO_PRODUCTION"
  | "BLOCKED_QUANTITY_DIVERGENCE"
  | "BLOCKED_METHOD_NOT_HOMOLOGATED";

export interface StockConsumptionSplitInput {
  valuationMethod: string;
  proof: "FIFO_LAYER_RECONCILED" | "MOVEMENT_RECONCILED" | "AMBIGUOUS";
  producedQuantity: string;
  consumedQuantity: string;
  remainingQuantity: string;
  unit: string;
  warehouse: string;
  consumedDisposition?: "CPV_ELIGIBLE" | "UNCLASSIFIED";
  negativeStock?: boolean;
  modAdjustmentCents: string;
  ggfAdjustmentCents: string;
}

export interface StockConsumptionSplit {
  status: StockConsumptionStatus;
  consumedStatus: "CPV_ADJUSTMENT_CANDIDATE" | "CONSUMED_UNCLASSIFIED" | "NOT_APPLICABLE";
  valuationMethod: string;
  producedQuantity: string | null;
  consumedQuantity: string | null;
  remainingQuantity: string | null;
  unit: string | null;
  warehouse: string | null;
  unitModAdjustmentCents: string | null;
  unitGgfAdjustmentCents: string | null;
  modStockCents: string | null;
  modConsumedCents: string | null;
  ggfStockCents: string | null;
  ggfConsumedCents: string | null;
  totalStockCents: string | null;
  totalConsumedCents: string | null;
  payload: null;
  reason: string;
}

const parseQuantity = (value: string): bigint | null =>
  /^\d+(?:\.\d{1,6})?$/.test(value) ? parseDecimal(value, 6) : null;

function blocked(input: StockConsumptionSplitInput, status: StockConsumptionStatus, reason: string): StockConsumptionSplit {
  return {
    status, consumedStatus: "NOT_APPLICABLE", valuationMethod: input.valuationMethod, producedQuantity: null, consumedQuantity: null,
    remainingQuantity: null, unit: null, warehouse: null, unitModAdjustmentCents: null,
    unitGgfAdjustmentCents: null, modStockCents: null, modConsumedCents: null,
    ggfStockCents: null, ggfConsumedCents: null, totalStockCents: null,
    totalConsumedCents: null, payload: null, reason
  };
}

/** Splits existing V2 allocations only after a reconciled receipt-to-stock proof. No SAP payload is produced. */
export function splitStockAndConsumed(input: StockConsumptionSplitInput): StockConsumptionSplit {
  const produced = parseQuantity(input.producedQuantity);
  const consumed = parseQuantity(input.consumedQuantity);
  const remaining = parseQuantity(input.remainingQuantity);
  const mod = /^-?\d+$/.test(input.modAdjustmentCents) ? BigInt(input.modAdjustmentCents) : null;
  const ggf = /^-?\d+$/.test(input.ggfAdjustmentCents) ? BigInt(input.ggfAdjustmentCents) : null;
  if (produced === null || consumed === null || remaining === null || mod === null || ggf === null ||
      !input.unit || !input.warehouse)
    return blocked(input, "BLOCKED_AMBIGUOUS_TRACE", "Fonte incompleta: quantidade, unidade, depósito ou ajuste sem comprovação.");
  if (produced === 0n) return blocked(input, "BLOCKED_ZERO_PRODUCTION", "Quantidade produzida elegível igual a zero.");
  if (consumed + remaining !== produced)
    return blocked(input, "BLOCKED_QUANTITY_DIVERGENCE", "Produzido não reconcilia com consumido + saldo rastreado.");
  if (input.negativeStock) return blocked(input, "BLOCKED_STOCK_NEGATIVE", "Há estoque negativo; a divisão permanece bloqueada.");
  if (input.proof === "AMBIGUOUS")
    return blocked(input, "BLOCKED_AMBIGUOUS_TRACE", "Não foi possível vincular todas as movimentações à produção da OP.");
  if (input.valuationMethod === "bis_MovingAverage")
    return blocked(input, "BLOCKED_METHOD_NOT_HOMOLOGATED", "Preço médio móvel não permite atribuir origem por OP com a evidência atual.");
  if (input.valuationMethod === "bis_Standard")
    return blocked(input, "BLOCKED_METHOD_NOT_HOMOLOGATED", "Preço padrão requer regra contábil específica ainda não homologada.");
  if (input.valuationMethod !== "bis_FIFO" || input.proof !== "FIFO_LAYER_RECONCILED")
    return blocked(input, "BLOCKED_METHOD_NOT_HOMOLOGATED", "Somente camada FIFO reconciliada está homologada para esta prévia.");

  const modStock = divRound(mod * remaining, produced);
  const ggfStock = divRound(ggf * remaining, produced);
  const modConsumed = mod - modStock;
  const ggfConsumed = ggf - ggfStock;
  return {
    status: remaining > 0n ? "STOCK_REVALUATION_CANDIDATE"
      : input.consumedDisposition === "CPV_ELIGIBLE" ? "CPV_ADJUSTMENT_CANDIDATE" : "CONSUMPTION_UNCLASSIFIED",
    consumedStatus: consumed === 0n ? "NOT_APPLICABLE" : input.consumedDisposition === "CPV_ELIGIBLE"
      ? "CPV_ADJUSTMENT_CANDIDATE" : "CONSUMED_UNCLASSIFIED",
    valuationMethod: input.valuationMethod,
    producedQuantity: formatDecimal(produced, 6), consumedQuantity: formatDecimal(consumed, 6),
    remainingQuantity: formatDecimal(remaining, 6), unit: input.unit, warehouse: input.warehouse,
    unitModAdjustmentCents: formatDecimal(divRound(mod * QTY_SCALE * QTY_SCALE, produced), 6),
    unitGgfAdjustmentCents: formatDecimal(divRound(ggf * QTY_SCALE * QTY_SCALE, produced), 6),
    modStockCents: modStock.toString(), modConsumedCents: modConsumed.toString(),
    ggfStockCents: ggfStock.toString(), ggfConsumedCents: ggfConsumed.toString(),
    totalStockCents: (modStock + ggfStock).toString(), totalConsumedCents: (modConsumed + ggfConsumed).toString(),
    payload: null,
    reason: "Rastreio FIFO do recebimento e da camada conciliado; parcela consumida permanece candidata a ajuste de CPV, pendente de regra funcional."
  };
}
