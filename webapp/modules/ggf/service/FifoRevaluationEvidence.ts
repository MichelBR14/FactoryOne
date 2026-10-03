export interface FifoRevaluationEvidenceExpectation {
  docEntry: number;
  docNum: number;
  transId: number;
  itemCode: string;
  warehouseCode: string;
  sourceSequence: number;
  sourceLayerId: number;
  quantity: number;
  unitCostBefore: number;
  unitCostAfter: number;
  branch: number;
  currency: string;
  revaluationAccount: string;
  debitAccount: string;
  creditAccount: string;
  amountCents: number;
}

export interface FifoRevaluationEvidenceResult {
  matched: boolean;
  reasons: string[];
  evidence: string[];
}

const cents = (value: unknown): number | null => {
  const amount = Number(value);
  return Number.isFinite(amount) && Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-7
    ? Math.round(amount * 100) : null;
};

const blank = (value: unknown) => value === null || value === undefined || value === "";

/** FIFO proof is the selected and resulting layer plus the linked balanced JE, not optional summary fields. */
export function reconcileFifoMaterialRevaluation(input: {
  document: Record<string, any>;
  journalEntry: Record<string, any>;
  sourceLayer: Record<string, any>;
  resultingLayer: Record<string, any>;
  expected: FifoRevaluationEvidenceExpectation;
}): FifoRevaluationEvidenceResult {
  const { document, journalEntry, sourceLayer, resultingLayer, expected } = input;
  const reasons: string[] = [];
  const lines = document?.MaterialRevaluationLines;
  const line = Array.isArray(lines) && lines.length === 1 ? lines[0] : null;
  const fifo = line?.FIFOLayers;
  const selected = Array.isArray(fifo) && fifo.length === 1 ? fifo[0] : null;

  if (Number(document?.DocEntry) !== expected.docEntry || Number(document?.DocNum) !== expected.docNum)
    reasons.push("MATERIAL_REVALUATION_IDENTITY_MISMATCH");
  if (document?.RevalType !== "P") reasons.push("MATERIAL_REVALUATION_METHOD_MISMATCH");
  if (Number(document?.TransNum) !== expected.transId) reasons.push("MATERIAL_REVALUATION_TRANSID_MISMATCH");
  if (!line || line.ItemCode !== expected.itemCode || line.WarehouseCode !== expected.warehouseCode)
    reasons.push("MATERIAL_REVALUATION_ITEM_OR_WAREHOUSE_MISMATCH");
  if (line?.RevaluationIncrementAccount !== expected.revaluationAccount)
    reasons.push("MATERIAL_REVALUATION_ACCOUNT_MISMATCH");
  if (!selected || Number(selected.TransactionSequenceNum) !== expected.sourceSequence ||
      Number(selected.LayerID) !== expected.sourceLayerId || Number(selected.Price) !== expected.unitCostAfter)
    reasons.push("MATERIAL_REVALUATION_FIFO_LAYER_MISMATCH");

  const expectedAmount = expected.quantity * (expected.unitCostAfter - expected.unitCostBefore);
  if (cents(expectedAmount) !== expected.amountCents) reasons.push("EXPECTED_FIFO_VALUE_INCONSISTENT");
  if (!sourceLayer || Number(sourceLayer.TransactionSequenceNum) !== expected.sourceSequence ||
      Number(sourceLayer.LayerID) !== expected.sourceLayerId || Number(sourceLayer.OpenQty) !== expected.quantity ||
      Number(sourceLayer.CurrentCost) !== expected.unitCostBefore)
    reasons.push("SOURCE_FIFO_LAYER_MISMATCH");
  if (!resultingLayer || Number(resultingLayer.DocNumber) !== expected.docNum ||
      resultingLayer.DocType !== "ttInventoryValuation" ||
      (!blank(resultingLayer.ItemCode) && resultingLayer.ItemCode !== expected.itemCode) ||
      (!blank(resultingLayer.WarehouseCode) && resultingLayer.WarehouseCode !== expected.warehouseCode) ||
      Number(resultingLayer.OpenQty) !== expected.quantity || Number(resultingLayer.CurrentCost) !== expected.unitCostAfter)
    reasons.push("RESULTING_FIFO_LAYER_MISMATCH");

  const journalLines = Array.isArray(journalEntry?.JournalEntryLines)
    ? journalEntry.JournalEntryLines.filter((row: Record<string, unknown>) => cents(row.Debit) !== 0 || cents(row.Credit) !== 0)
    : [];
  if (Number(journalEntry?.JdtNum) !== expected.transId || journalLines.length !== 2)
    reasons.push("LINKED_JOURNAL_ENTRY_MISMATCH");
  const debit = journalLines.find((row: Record<string, any>) => row.AccountCode === expected.debitAccount &&
    cents(row.Debit) === expected.amountCents && cents(row.Credit) === 0);
  const credit = journalLines.find((row: Record<string, any>) => row.AccountCode === expected.creditAccount &&
    cents(row.Credit) === expected.amountCents && cents(row.Debit) === 0);
  if (!debit || !credit) reasons.push("JOURNAL_ENTRY_ACCOUNT_OR_AMOUNT_MISMATCH");
  if (journalLines.some((row: Record<string, any>) => Number(row.BPLID) !== expected.branch ||
      (!blank(row.FCCurrency) && row.FCCurrency !== expected.currency) ||
      [row.ProjectCode, row.CostingCode, row.CostingCode2, row.CostingCode3, row.CostingCode4, row.CostingCode5]
        .some(value => !blank(value)))) reasons.push("JOURNAL_ENTRY_BRANCH_CURRENCY_OR_DIMENSION_MISMATCH");
  const debitTotal = journalLines.reduce((sum: number, row: Record<string, any>) => sum + (cents(row.Debit) ?? 0), 0);
  const creditTotal = journalLines.reduce((sum: number, row: Record<string, any>) => sum + (cents(row.Credit) ?? 0), 0);
  if (debitTotal !== expected.amountCents || creditTotal !== expected.amountCents || debitTotal !== creditTotal)
    reasons.push("JOURNAL_ENTRY_NOT_BALANCED");

  return { matched: reasons.length === 0, reasons, evidence: reasons.length === 0 ? [
    "MATERIAL_REVALUATION_IDENTITY", "ITEM_WAREHOUSE_FIFO_LAYER", "SOURCE_AND_RESULTING_LAYER_COSTS",
    "QUANTITY_AND_FIFO_VALUE", "LINKED_TRANSID", "JOURNAL_ENTRY_ACCOUNTS_AND_BALANCE",
    "BRANCH_CURRENCY_AND_NO_DIMENSIONS"
  ] : [] };
}
