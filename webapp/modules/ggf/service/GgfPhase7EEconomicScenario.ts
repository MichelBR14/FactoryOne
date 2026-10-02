import { calculateGgfRequestHash } from "./GgfPostingExecution";

export const GGF_PHASE7E_GATEWAY_CONTRACT = Object.freeze({
  scenarioId: "PHASE7E_TECHNICAL",
  financialWritesEnabled: false,
  companyDB: "SBODEMOBR2",
  branch: 1,
  currency: "R$",
  maxDocumentCounts: { MaterialRevaluation: 1, JournalEntryCPV: 1, JournalEntryClosing: 1 },
  maxCents: { totalAdjustment: "200", stockAdjustment: "100", consumedAdjustment: "100", closingEntry: "200" },
  allowedAccounts: ["1.01.02.01.01", "5.03.01.01.04", "5.01.01.01.01", "5.04.01.01.05",
    "5.04.01.01.03", "5.04.01.01.04"],
  fifoLayer: { item: "F1GGF26F01", warehouse: "01", transactionSequenceNum: 2790, layerId: 0,
    quantity: "5", unit: "UN", currentUnitPriceCents: "1200", proposedUnitPriceCents: "1220" }
} as const);

export type Phase7EDocumentType = "MaterialRevaluation" | "JournalEntry.CPV" | "JournalEntry.Closing";
export type Phase7EAccountLine = { account: string; debitCents: string; creditCents: string; branch: 1 };
export interface Phase7EFifoLayer {
  item: "F1GGF26F01";
  warehouse: "01";
  transactionSequenceNum: number;
  layerId: number;
  quantity: "5";
  unit: "UN";
  currentUnitPriceCents: string;
  proposedUnitPriceCents: string;
}

export interface Phase7EDocument {
  type: Phase7EDocumentType;
  order: 1 | 2 | 3;
  amountCents: string;
  request: Record<string, unknown>;
  requestHash: string;
  effects: Phase7EAccountLine[];
}

export interface Phase7EEconomicScenario {
  scenarioId: "PHASE7E_TECHNICAL";
  companyDB: "SBODEMOBR2";
  closingId: string;
  closingVersion: 1;
  postingPlanVersion: 1;
  branch: 1;
  currency: "R$";
  postingHash: string;
  totalAdjustmentCents: string;
  stockAdjustmentCents: string;
  consumedAdjustmentCents: string;
  composition: { ggfCents: string; modCents: string; ggfStockCents: string; modStockCents: string };
  fifoLayer: Phase7EFifoLayer;
  documents: [Phase7EDocument, Phase7EDocument, Phase7EDocument];
  ledger: Array<{ account: string; openingCents: string; afterDocument1Cents: string;
    afterDocument2Cents: string; finalCents: string }>;
  financialWritesEnabled: false;
}

export interface Phase7EScenarioInput {
  closingId: string;
  totalAdjustmentCents?: string;
  stockAdjustmentCents?: string;
  consumedAdjustmentCents?: string;
  ggfCents?: string;
  modCents?: string;
  ggfStockCents?: string;
  modStockCents?: string;
  currentUnitPriceCents?: string;
  proposedUnitPriceCents?: string;
}

const abs = (value: bigint) => value < 0n ? -value : value;
const signedInteger = (value: string) => /^-?\d+$/.test(value) ? BigInt(value) : null;
const money = (cents: string) => Number(BigInt(cents)) / 100;

function requireAmount(value: string, label: string): bigint {
  const parsed = signedInteger(value);
  if (parsed === null) throw new Error(`${label} must be integer cents`);
  return parsed;
}

function accountLine(account: string, signedDebit: bigint): Phase7EAccountLine {
  return { account, debitCents: signedDebit > 0n ? signedDebit.toString() : "0",
    creditCents: signedDebit < 0n ? abs(signedDebit).toString() : "0", branch: 1 };
}

function totals(effects: readonly Phase7EAccountLine[]) {
  return effects.reduce((sum, line) => ({ debit: sum.debit + BigInt(line.debitCents),
    credit: sum.credit + BigInt(line.creditCents) }), { debit: 0n, credit: 0n });
}

function documentAmount(effects: readonly Phase7EAccountLine[]): string {
  const result = totals(effects);
  if (result.debit !== result.credit) throw new Error("Document debit and credit do not balance");
  return result.debit.toString();
}

function apply(lines: readonly Phase7EAccountLine[], opening: Map<string, bigint>): Map<string, bigint> {
  const next = new Map(opening);
  for (const line of lines) next.set(line.account,
    (next.get(line.account) ?? 0n) + BigInt(line.debitCents) - BigInt(line.creditCents));
  return next;
}

function assertDocument(type: Phase7EDocumentType, expectedCents: bigint, document: Phase7EDocument): void {
  if (document.type !== type || requireAmount(document.amountCents, `${type}.amount`) !== abs(expectedCents))
    throw new Error(`${type} document is missing or its value differs from PostingPlan`);
  const result = totals(document.effects);
  if (result.debit !== result.credit || result.debit !== abs(expectedCents))
    throw new Error(`${type} debit/credit does not reconcile to its planned amount`);
}

function payloadLine(account: string, debitCents: string, creditCents: string) {
  return { AccountCode: account, Debit: money(debitCents), Credit: money(creditCents), BPLID: 1 };
}

export async function buildPhase7EEconomicScenario(input: Phase7EScenarioInput): Promise<Phase7EEconomicScenario> {
  if (!/^TECH7E-20261001-[A-F0-9]{10}$/.test(input.closingId)) throw new Error("Invalid isolated Phase 7E ClosingId");
  const total = requireAmount(input.totalAdjustmentCents ?? "200", "totalAdjustmentCents");
  const stock = requireAmount(input.stockAdjustmentCents ?? "100", "stockAdjustmentCents");
  const consumed = requireAmount(input.consumedAdjustmentCents ?? "100", "consumedAdjustmentCents");
  const ggf = requireAmount(input.ggfCents ?? "120", "ggfCents");
  const mod = requireAmount(input.modCents ?? "80", "modCents");
  const ggfStock = requireAmount(input.ggfStockCents ?? "60", "ggfStockCents");
  const modStock = requireAmount(input.modStockCents ?? "40", "modStockCents");
  const currentPrice = requireAmount(input.currentUnitPriceCents ?? "1200", "currentUnitPriceCents");
  const proposedPrice = requireAmount(input.proposedUnitPriceCents ?? "1220", "proposedUnitPriceCents");
  const ggfConsumed = ggf - ggfStock;
  const modConsumed = mod - modStock;
  if (stock + consumed !== total || ggf + mod !== total || ggfStock + modStock !== stock ||
      ggfConsumed + modConsumed !== consumed || stock === 0n || consumed === 0n ||
      (stock > 0n) !== (consumed > 0n) || (stock > 0n) !== (ggf > 0n) || (stock > 0n) !== (mod > 0n) ||
      (stock > 0n) !== (proposedPrice > currentPrice) ||
      abs(stock) !== 5n * abs(proposedPrice - currentPrice))
    throw new Error("PostingPlan totals, category split or FIFO layer value diverge");

  const transit = "5.04.01.01.05";
  const stockAccount = "1.01.02.01.01";
  const revaluationAccount = "5.03.01.01.04";
  const cpvAccount = "5.01.01.01.01";
  const ggfAccount = "5.04.01.01.03";
  const modAccount = "5.04.01.01.04";
  const layer = { ...GGF_PHASE7E_GATEWAY_CONTRACT.fifoLayer,
    currentUnitPriceCents: currentPrice.toString(), proposedUnitPriceCents: proposedPrice.toString() };
  const amount1 = abs(stock).toString();
  const revaluationRequest = {
    DocDate: "2026-10-01", TaxDate: "2026-10-01", Series: 25, RevalType: "P", Reference1: input.closingId,
    Comments: `FactoryOne ${GGF_PHASE7E_GATEWAY_CONTRACT.scenarioId} ${input.closingId}`,
    JournalMemo: `FactoryOne ${GGF_PHASE7E_GATEWAY_CONTRACT.scenarioId} ${input.closingId}`,
    MaterialRevaluationLines: [{ ItemCode: layer.item, WarehouseCode: layer.warehouse,
      RevaluationIncrementAccount: revaluationAccount,
      FIFOLayers: [{ TransactionSequenceNum: layer.transactionSequenceNum, LayerID: layer.layerId,
        Price: Number(proposedPrice) / 100 }] }]
  };
  const revaluationEffects = stock > 0n
    ? [accountLine(stockAccount, stock), accountLine(revaluationAccount, -stock)]
    : [accountLine(stockAccount, stock), accountLine(revaluationAccount, -stock)];
  const cpvEffects = [accountLine(cpvAccount, consumed), accountLine(transit, -consumed)];
  const closingEffects = [accountLine(transit, consumed), accountLine(revaluationAccount, stock),
    accountLine(ggfAccount, -ggf), accountLine(modAccount, -mod)];
  const cpvRequest = {
    ReferenceDate: "2026-10-01", DueDate: "2026-10-01", TaxDate: "2026-10-01", Reference: input.closingId,
    Memo: `FactoryOne ${GGF_PHASE7E_GATEWAY_CONTRACT.scenarioId} ${input.closingId}`,
    JournalEntryLines: cpvEffects.map(line => payloadLine(line.account, line.debitCents, line.creditCents))
  };
  const closingRequest = {
    ReferenceDate: "2026-10-01", DueDate: "2026-10-01", TaxDate: "2026-10-01", Reference: input.closingId,
    Memo: `FactoryOne ${GGF_PHASE7E_GATEWAY_CONTRACT.scenarioId} ${input.closingId}`,
    JournalEntryLines: closingEffects.map(line => payloadLine(line.account, line.debitCents, line.creditCents))
  };
  const rawDocuments = [
    { type: "MaterialRevaluation" as const, order: 1 as const, amountCents: amount1, request: revaluationRequest, effects: revaluationEffects },
    { type: "JournalEntry.CPV" as const, order: 2 as const, amountCents: abs(consumed).toString(), request: cpvRequest, effects: cpvEffects },
    { type: "JournalEntry.Closing" as const, order: 3 as const, amountCents: documentAmount(closingEffects), request: closingRequest, effects: closingEffects }
  ];
  const documents = await Promise.all(rawDocuments.map(async document => ({ ...document,
    requestHash: await calculateGgfRequestHash(document.request) }))) as
    unknown as [Phase7EDocument, Phase7EDocument, Phase7EDocument];
  const opening = new Map<string, bigint>([stockAccount, cpvAccount, transit, revaluationAccount, ggfAccount, modAccount]
    .map(account => [account, 0n]));
  const after1 = apply(documents[0]!.effects, opening);
  const after2 = apply(documents[1]!.effects, after1);
  const after3 = apply(documents[2]!.effects, after2);
  const accounts = [stockAccount, cpvAccount, transit, revaluationAccount, ggfAccount, modAccount];
  const ledger = accounts.map(account => ({ account, openingCents: "0",
    afterDocument1Cents: (after1.get(account) ?? 0n).toString(),
    afterDocument2Cents: (after2.get(account) ?? 0n).toString(),
    finalCents: (after3.get(account) ?? 0n).toString() }));
  const planCore = { scenarioId: GGF_PHASE7E_GATEWAY_CONTRACT.scenarioId, companyDB: "SBODEMOBR2" as const,
    closingId: input.closingId, closingVersion: 1 as const, postingPlanVersion: 1 as const, branch: 1 as const,
    currency: "R$" as const, totalAdjustmentCents: total.toString(), stockAdjustmentCents: stock.toString(),
    consumedAdjustmentCents: consumed.toString(), composition: { ggfCents: ggf.toString(), modCents: mod.toString(),
      ggfStockCents: ggfStock.toString(), modStockCents: modStock.toString() }, fifoLayer: layer,
    documents, ledger, financialWritesEnabled: false as const };
  const postingHash = await calculateGgfRequestHash(planCore);
  return { ...planCore, postingHash };
}

export async function assertPhase7EGatewayContract(scenario: Phase7EEconomicScenario): Promise<void> {
  const contract = GGF_PHASE7E_GATEWAY_CONTRACT;
  if (scenario.documents.length !== 3) throw new Error("Phase 7E requires exactly one document of each authorized type");
  if (scenario.scenarioId !== contract.scenarioId || scenario.financialWritesEnabled !== false ||
      scenario.companyDB !== contract.companyDB || scenario.branch !== contract.branch ||
      scenario.currency !== contract.currency || scenario.totalAdjustmentCents !== "200" ||
      scenario.stockAdjustmentCents !== "100" || scenario.consumedAdjustmentCents !== "100" ||
      scenario.composition.ggfCents !== "120" || scenario.composition.modCents !== "80" ||
      scenario.composition.ggfStockCents !== "60" || scenario.composition.modStockCents !== "40" ||
      scenario.fifoLayer.item !== contract.fifoLayer.item || scenario.fifoLayer.warehouse !== contract.fifoLayer.warehouse ||
      scenario.fifoLayer.transactionSequenceNum !== contract.fifoLayer.transactionSequenceNum ||
      scenario.fifoLayer.layerId !== contract.fifoLayer.layerId || scenario.fifoLayer.quantity !== contract.fifoLayer.quantity ||
      scenario.fifoLayer.unit !== contract.fifoLayer.unit || scenario.documents.map(row => row.type).join("|") !==
        "MaterialRevaluation|JournalEntry.CPV|JournalEntry.Closing")
    throw new Error("Phase 7E gateway scope differs from the approved offline scenario");
  if (abs(requireAmount(scenario.totalAdjustmentCents, "totalAdjustmentCents")) > BigInt(contract.maxCents.totalAdjustment) ||
      abs(requireAmount(scenario.stockAdjustmentCents, "stockAdjustmentCents")) > BigInt(contract.maxCents.stockAdjustment) ||
      abs(requireAmount(scenario.consumedAdjustmentCents, "consumedAdjustmentCents")) > BigInt(contract.maxCents.consumedAdjustment) ||
      abs(requireAmount(scenario.documents[2]!.amountCents, "closing amount")) > BigInt(contract.maxCents.closingEntry))
    throw new Error("Phase 7E amount exceeds its explicit offline limits");
  assertDocument("MaterialRevaluation", BigInt(scenario.stockAdjustmentCents), scenario.documents[0]!);
  assertDocument("JournalEntry.CPV", BigInt(scenario.consumedAdjustmentCents), scenario.documents[1]!);
  assertDocument("JournalEntry.Closing", BigInt(scenario.totalAdjustmentCents), scenario.documents[2]!);
  if (scenario.documents[2]!.order !== 3 || scenario.documents[0]!.order !== 1 || scenario.documents[1]!.order !== 2)
    throw new Error("Phase 7E documents are missing or out of sequence");
  const allAccounts = scenario.documents.flatMap(document => document.effects.map(line => line.account));
  if (allAccounts.some(account => !(contract.allowedAccounts as readonly string[]).includes(account)) ||
      scenario.documents.some(document => document.effects.some(line => line.branch !== contract.branch)))
    throw new Error("Phase 7E document contains an unauthorized account or branch");
  const memo = `FactoryOne ${contract.scenarioId} ${scenario.closingId}`;
  const revaluation = scenario.documents[0]!.request as Record<string, any>;
  const revaluationLine = revaluation.MaterialRevaluationLines?.[0];
  const fifo = revaluationLine?.FIFOLayers?.[0];
  if (revaluation.DocDate !== "2026-10-01" || revaluation.TaxDate !== "2026-10-01" ||
      revaluation.Series !== 25 || revaluation.RevalType !== "P" || revaluation.Reference1 !== scenario.closingId ||
      revaluation.Comments !== memo || revaluation.JournalMemo !== memo ||
      revaluation.MaterialRevaluationLines?.length !== 1 || revaluationLine.ItemCode !== contract.fifoLayer.item ||
      revaluationLine.WarehouseCode !== contract.fifoLayer.warehouse ||
      revaluationLine.RevaluationIncrementAccount !== "5.03.01.01.04" || revaluationLine.FIFOLayers?.length !== 1 ||
      fifo.TransactionSequenceNum !== contract.fifoLayer.transactionSequenceNum || fifo.LayerID !== contract.fifoLayer.layerId ||
      fifo.Price !== Number(scenario.fifoLayer.proposedUnitPriceCents) / 100)
    throw new Error("Phase 7E MaterialRevaluation request differs from the authorized FIFO layer");
  for (const document of scenario.documents.slice(1)) {
    const payload = document.request as Record<string, any>;
    const expectedLines = document.effects.map(line => payloadLine(line.account, line.debitCents, line.creditCents));
    if (payload.ReferenceDate !== "2026-10-01" || payload.DueDate !== "2026-10-01" ||
        payload.TaxDate !== "2026-10-01" || payload.Reference !== scenario.closingId || payload.Memo !== memo ||
        JSON.stringify(payload.JournalEntryLines) !== JSON.stringify(expectedLines))
      throw new Error(`${document.type} request differs from its PostingPlan lines`);
  }
  for (const document of scenario.documents) {
    if (!/^[a-f0-9]{64}$/.test(document.requestHash) ||
        await calculateGgfRequestHash(document.request) !== document.requestHash)
      throw new Error("Phase 7E RequestHash is missing or divergent");
  }
  const { postingHash: _hash, ...functional } = scenario;
  if (!/^[a-f0-9]{64}$/.test(scenario.postingHash) || await calculateGgfRequestHash(functional) !== scenario.postingHash)
    throw new Error("Phase 7E PostingHash is missing or divergent");
  if (scenario.documents.some(document => document.amountCents !==
      (document.type === "MaterialRevaluation" ? "100" : document.type === "JournalEntry.CPV" ? "100" : "200")) ||
      scenario.fifoLayer.currentUnitPriceCents !== "1200" || scenario.fifoLayer.proposedUnitPriceCents !== "1220")
    throw new Error("Phase 7E request values differ from the exact authorized scenario limits");
  const transitFinal = scenario.ledger.find(row => row.account === "5.04.01.01.05")?.finalCents;
  const revaluationFinal = scenario.ledger.find(row => row.account === "5.03.01.01.04")?.finalCents;
  if (transitFinal !== "0" || revaluationFinal !== "0") throw new Error("Phase 7E clearing accounts do not close to zero");
}

export function allocateCentsByWeights(totalCents: string, weights: Record<string, number>): Record<string, string> {
  const total = requireAmount(totalCents, "totalCents");
  const entries = Object.entries(weights);
  if (!entries.length || entries.some(([, weight]) => !Number.isSafeInteger(weight) || weight < 0) ||
      entries.reduce((sum, [, weight]) => sum + weight, 0) <= 0)
    throw new Error("Allocation weights must be nonnegative integers with a positive total");
  const denominator = BigInt(entries.reduce((sum, [, weight]) => sum + weight, 0));
  const magnitude = abs(total);
  const shares = entries.map(([key, weight]) => {
    const product = magnitude * BigInt(weight);
    return { key, cents: product / denominator, remainder: product % denominator };
  });
  let residual = magnitude - shares.reduce((sum, row) => sum + row.cents, 0n);
  const order = [...shares].sort((a, b) => a.remainder === b.remainder
    ? a.key.localeCompare(b.key) : a.remainder > b.remainder ? -1 : 1);
  for (let index = 0; residual > 0n; index++, residual--) order[index % order.length]!.cents++;
  const sign = total < 0n ? -1n : 1n;
  return Object.fromEntries(shares.map(row => [row.key, (row.cents * sign).toString()]));
}
