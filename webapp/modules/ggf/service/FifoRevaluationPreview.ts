import { divRound, formatDecimal, parseDecimal, sum } from "../../../core/util/money";

export type FifoPreviewStatus =
  | "FIFO_APTO"
  | "FIFO_CAMADA_NAO_IDENTIFICADA"
  | "FIFO_CAMADA_FECHADA"
  | "FIFO_QUANTIDADE_INSUFICIENTE"
  | "FIFO_ESTOQUE_NEGATIVO"
  | "FIFO_DADOS_INCOMPLETOS";

export interface FifoLayerEvidence {
  transactionSequenceNum: number;
  layerId: number;
  openQty: string;
  currentCost: string;
  receiptQty: string;
  source: string;
}

export interface FifoPreviewInput {
  item: string;
  warehouse: string;
  stockQty: string;
  layers: readonly FifoLayerEvidence[];
  target: { transactionSequenceNum: number; layerId: number; eligibleQty: string; newPrice: string };
  posting: { date: string; series: number; reference: string; memo: string; incrementAccount: string };
}

export interface FifoPayload {
  DocDate: string;
  TaxDate: string;
  Series: number;
  RevalType: "P";
  Reference1: string;
  Comments: string;
  JournalMemo: string;
  MaterialRevaluationLines: Array<{
    ItemCode: string;
    WarehouseCode: string;
    RevaluationIncrementAccount: string;
    FIFOLayers: Array<{ TransactionSequenceNum: number; LayerID: number; Price: number }>;
  }>;
}

export interface FifoPreview {
  status: FifoPreviewStatus;
  reason: string;
  payload: FifoPayload | null;
  beforeMinor: string | null;
  deltaMinor: string | null;
  afterMinor: string | null;
  affectedQty: string | null;
  receiptConsumedQty: string | null;
  expectedLayers: Array<{ transactionSequenceNum: number; layerId: number;
    openQty: string; currentCost: string }> | null;
}

type FifoAfterLayer = Pick<FifoLayerEvidence,
  "transactionSequenceNum" | "layerId" | "openQty" | "currentCost"> &
  { docNumber?: string; docType?: string };

const DECIMAL = /^-?\d+(?:\.\d{1,6})?$/;
const DENOMINATOR = 10_000_000_000n;

function decimal(value: string): bigint | null {
  return typeof value === "string" && DECIMAL.test(value) ? parseDecimal(value, 6) : null;
}

function amount(qty: bigint, price: bigint): bigint {
  return divRound(qty * price, DENOMINATOR);
}

function blocked(status: FifoPreviewStatus, reason: string): FifoPreview {
  return { status, reason, payload: null, beforeMinor: null, deltaMinor: null,
    afterMinor: null, affectedQty: null, receiptConsumedQty: null, expectedLayers: null };
}

export function previewFifoRevaluation(input: FifoPreviewInput): FifoPreview {
  const stock = decimal(input.stockQty);
  if (stock !== null && stock < 0n) return blocked("FIFO_ESTOQUE_NEGATIVO", "Estoque negativo");
  if (!input.item || !input.warehouse || stock === null || !input.layers?.length ||
      !input.target || !input.posting || !/^\d{4}-\d{2}-\d{2}$/.test(input.posting.date) ||
      !Number.isSafeInteger(input.posting.series) || input.posting.series <= 0 ||
      !input.posting.reference || !input.posting.memo || !input.posting.incrementAccount)
    return blocked("FIFO_DADOS_INCOMPLETOS", "Identidade, estoque ou contabilizacao incompletos");
  if (!Number.isSafeInteger(input.target.transactionSequenceNum) ||
      !Number.isSafeInteger(input.target.layerId))
    return blocked("FIFO_CAMADA_NAO_IDENTIFICADA", "Sequencia e ID da camada obrigatorios");

  const keys = new Set<string>();
  const parsed = [];
  for (const layer of input.layers) {
    const qty = decimal(layer.openQty), cost = decimal(layer.currentCost), received = decimal(layer.receiptQty);
    const key = `${layer.transactionSequenceNum}/${layer.layerId}`;
    if (!Number.isSafeInteger(layer.transactionSequenceNum) || !Number.isSafeInteger(layer.layerId) ||
        qty === null || cost === null || received === null || received <= 0n || qty < 0n || cost < 0n ||
        qty > received || !layer.source || keys.has(key))
      return blocked("FIFO_DADOS_INCOMPLETOS", "Camadas sem origem, valor ou identidade confiavel");
    keys.add(key);
    parsed.push({ ...layer, qty, cost, received, key });
  }
  if (sum(parsed.map(layer => layer.qty)) !== stock)
    return blocked("FIFO_DADOS_INCOMPLETOS", "Soma das camadas diferente do estoque");
  const target = parsed.find(layer => layer.key ===
    `${input.target.transactionSequenceNum}/${input.target.layerId}`);
  if (!target || target.qty === 0n)
    return blocked("FIFO_CAMADA_FECHADA", "Camada nao esta aberta no estoque atual");
  const eligible = decimal(input.target.eligibleQty), newPrice = decimal(input.target.newPrice);
  if (eligible === null || newPrice === null || eligible <= 0n || newPrice <= 0n)
    return blocked("FIFO_DADOS_INCOMPLETOS", "Quantidade elegivel ou novo preco invalidos");
  if (eligible !== target.qty)
    return blocked("FIFO_QUANTIDADE_INSUFICIENTE", "Price Change afeta toda a quantidade aberta da camada");

  const before = sum(parsed.map(layer => amount(layer.qty, layer.cost)));
  const after = sum(parsed.map(layer => amount(layer.qty,
    layer.key === target.key ? newPrice : layer.cost)));
  const delta = after - before;
  if (delta <= 0n)
    return blocked("FIFO_DADOS_INCOMPLETOS", "Esta previa tecnica exige aumento positivo comprovado");
  const payload: FifoPayload = {
    DocDate: input.posting.date, TaxDate: input.posting.date, Series: input.posting.series,
    RevalType: "P", Reference1: input.posting.reference,
    Comments: input.posting.memo, JournalMemo: input.posting.memo,
    MaterialRevaluationLines: [{ ItemCode: input.item, WarehouseCode: input.warehouse,
      RevaluationIncrementAccount: input.posting.incrementAccount,
      FIFOLayers: [{ TransactionSequenceNum: target.transactionSequenceNum,
        LayerID: target.layerId, Price: Number(formatDecimal(newPrice, 6)) }] }]
  };
  return { status: "FIFO_APTO", reason: "", payload, beforeMinor: before.toString(),
    deltaMinor: delta.toString(), afterMinor: after.toString(),
    affectedQty: formatDecimal(eligible, 6),
    receiptConsumedQty: formatDecimal(target.received - target.qty, 6),
    expectedLayers: parsed.map(layer => ({ transactionSequenceNum: layer.transactionSequenceNum,
      layerId: layer.layerId, openQty: formatDecimal(layer.qty, 6),
      currentCost: formatDecimal(layer.key === target.key ? newPrice : layer.cost, 6) })) };
}

export function reconcileFifoValues(preview: FifoPreview,
  afterLayers: readonly FifoAfterLayer[],
  inventoryDebitMinor: string, offsetCreditMinor: string,
  replacement?: { docNum: string }): { reconciled: boolean; differenceMinor: string | null } {
  if (preview.status !== "FIFO_APTO" || preview.beforeMinor === null || preview.deltaMinor === null ||
      preview.afterMinor === null || preview.expectedLayers === null || !/^\d+$/.test(inventoryDebitMinor) ||
      !/^\d+$/.test(offsetCreditMinor)) return { reconciled: false, differenceMinor: null };
  const amounts = afterLayers.map(layer => {
    const qty = decimal(layer.openQty), cost = decimal(layer.currentCost);
    return qty === null || cost === null ? null : amount(qty, cost);
  });
  if (amounts.some(value => value === null)) return { reconciled: false, differenceMinor: null };
  const actual = sum(amounts as bigint[]);
  const difference = actual - BigInt(preview.afterMinor);
  const matches = (expected: NonNullable<FifoPreview["expectedLayers"]>[number],
    actualLayer: (typeof afterLayers)[number]) =>
    actualLayer.transactionSequenceNum === expected.transactionSequenceNum &&
    actualLayer.layerId === expected.layerId &&
    decimal(actualLayer.openQty) === decimal(expected.openQty) &&
    decimal(actualLayer.currentCost) === decimal(expected.currentCost);
  let identities = afterLayers.length === preview.expectedLayers.length &&
    preview.expectedLayers.every(expected => afterLayers.some(actualLayer => matches(expected, actualLayer)));
  if (replacement) {
    const selected = preview.payload?.MaterialRevaluationLines[0]?.FIFOLayers[0];
    const target = preview.expectedLayers.find(layer =>
      layer.transactionSequenceNum === selected?.TransactionSequenceNum && layer.layerId === selected.LayerID);
    const unchanged = preview.expectedLayers.filter(layer => layer !== target);
    const newcomers = afterLayers.filter(layer => layer.docNumber === replacement.docNum &&
      layer.docType === "ttInventoryValuation");
    identities = Boolean(target) && afterLayers.length === preview.expectedLayers.length &&
      afterLayers.every(layer => !(layer.transactionSequenceNum === target?.transactionSequenceNum &&
        layer.layerId === target.layerId)) &&
      unchanged.every(layer => afterLayers.some(actualLayer => matches(layer, actualLayer))) &&
      newcomers.length === 1 &&
      decimal(newcomers[0]!.openQty) === decimal(target!.openQty) &&
      decimal(newcomers[0]!.currentCost) === decimal(target!.currentCost) &&
      !preview.expectedLayers.some(layer => layer.transactionSequenceNum === newcomers[0]!.transactionSequenceNum &&
        layer.layerId === newcomers[0]!.layerId);
  }
  return { reconciled: identities && difference === 0n &&
    actual - BigInt(preview.beforeMinor) === BigInt(preview.deltaMinor) &&
    BigInt(inventoryDebitMinor) === BigInt(preview.deltaMinor) &&
    BigInt(offsetCreditMinor) === BigInt(preview.deltaMinor),
  differenceMinor: difference.toString() };
}
