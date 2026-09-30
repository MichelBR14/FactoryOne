import { divRound, formatDecimal, parseDecimal, sum } from "../../../core/util/money";

export type PreviewStatus = "READY" | "NO_STOCK" | "INSUFFICIENT_STOCK" | "NEGATIVE_STOCK" | "SPECIFIC_METHOD" | "MISSING_DATA" | "INCONSISTENT";
export interface PreviewReceipt {
  document: string; line: number; date: string; warehouse: string; quantity: string; unit: string;
}
export interface PreviewOrder {
  id: string; number: string; item: string; planned: string | null; produced: string | null; unit: string;
  allocatedMinor: string; accounts: Array<{ account: string; name: string; amountMinor: string }>;
  components: Array<{ kind: string; code: string; amount: string; sourceRefs: string[] }>;
  receipts: PreviewReceipt[];
  /** Proven remaining production, not min(received, warehouse stock). No UI default. */
  remaining: Array<{ warehouse: string; quantity: string; evidence: string }>;
  inconsistencies: string[];
}
export interface PreviewItem {
  code: string; name: string; unit: string; method: string; inventory: boolean; serial: boolean; batch: boolean;
  totalStock: string | null; globalCost: string | null;
  warehouses: Array<{ code: string; stock: string | null; cost: string | null; locked: boolean }>;
}
export interface RevaluationInput {
  origin: "sap" | "development"; company: string; allocationId: string; allocationDate: string; stockDate: string;
  technicalOnly: boolean; sourceRefs: string[];
  policy: { perpetual: boolean | null; costScope: "warehouse" | "company" | null;
    functionalApproved: boolean; stockTreatment: "spread-over-current-stock" | null; postingDate: string | null;
    incrementAccount: string | null; decrementAccount: string | null; accountsVerified: boolean };
  orders: PreviewOrder[]; items: PreviewItem[];
}
const quantity = (s: string | null) => exact(s, 6, false);
function exact(value: string | null, places: number, signed = true): bigint | null {
  if (value === null || !new RegExp(`^${signed ? "-?" : ""}\\d+(?:\\.\\d{1,${places}})?$`).test(value)) return null;
  return parseDecimal(value, places);
}
const price = (n: bigint | null) => n === null ? null : formatDecimal(n, 6);
const amount = (n: bigint | null) => n === null ? null : formatDecimal(n);
const Q = 1000000n;
const MONEY_PRICE_QUANTITY = 10000000000n;

/** Pure proposal only. No HTTP client, no posting method, no changes to allocation rules. */
export function previewRevaluation(input: RevaluationInput) {
  if (!input.orders.length || new Set(input.orders.map(o => o.id)).size !== input.orders.length ||
      new Set(input.items.map(i => i.code)).size !== input.items.length) throw new Error("Invalid preview identities");
  if (input.origin === "sap" && (input.company !== "SBODEMOBR2" || input.orders.some(o => o.item.startsWith("DEV-"))))
    throw new Error("Preview source mismatch");
  const receiptKeys = input.orders.flatMap(o => o.receipts.map(r => `${r.document}/${r.line}`));
  if (new Set(receiptKeys).size !== receiptKeys.length) throw new Error("Duplicate receipt attribution");
  const rows = input.orders.flatMap(order => {
    const item = input.items.find(i => i.code === order.item);
    const produced = quantity(order.produced);
    const ggf = BigInt(order.allocatedMinor);
    const components = order.components.map(c => ({ ...c, minor: exact(c.amount, 2) }));
    const original = components.length && components.every(c => c.minor !== null) ? sum(components.map(c => c.minor!)) : null;
    const materials = original === null ? null : sum(components.filter(c => c.kind === "dit_Item" || c.kind === "material").map(c => c.minor!));
    const resources = original === null ? null : sum(components.filter(c => c.kind === "dit_Resource" || c.kind === "resource").map(c => c.minor!));
    const unitGgf = produced !== null && produced > 0n ? divRound(ggf * MONEY_PRICE_QUANTITY, produced) : null;
    const warehouses = [...new Set(order.receipts.map(r => r.warehouse))];
    if (!warehouses.length) warehouses.push("");
    return warehouses.map(warehouse => {
      const reasons = [...order.inconsistencies];
      const receipts = order.receipts.filter(r => r.warehouse === warehouse);
      const quantities = receipts.map(r => quantity(r.quantity));
      const received = quantities.length && quantities.every(q => q !== null) ? sum(quantities as bigint[]) : null;
      const wh = item?.warehouses.find(w => w.code === warehouse);
      const stock = exact(wh?.stock ?? null, 6);
      const scalarCost = item && ["bis_MovingAverage", "bis_Standard"].includes(item.method) && !item.serial && !item.batch;
      const sourceCost = scalarCost ? (input.policy.costScope === "warehouse" ? wh?.cost : input.policy.costScope === "company" ? item?.globalCost : null) : null;
      const current = exact(sourceCost ?? null, 6);
      const proofs = order.remaining.filter(r => r.warehouse === warehouse);
      const eligible = proofs.length === 1 && proofs[0]!.evidence.trim() ? quantity(proofs[0]!.quantity) : null;
      const estimate = eligible !== null && produced !== null && produced > 0n ? divRound(ggf * eligible, produced) : null;
      let status: PreviewStatus = "READY";
      const block = (code: PreviewStatus, reason: string) => { if (status === "READY") status = code; reasons.push(reason); };
      const allReceived = order.receipts.map(r => quantity(r.quantity));
      if (order.inconsistencies.length || produced === null || produced <= 0n ||
          allReceived.some(q => q === null) || sum(allReceived.filter(q => q !== null)) !== produced ||
          new Set(order.receipts.map(r => `${r.document}/${r.line}`)).size !== order.receipts.length ||
          sum(order.accounts.map(a => BigInt(a.amountMinor))) !== ggf ||
          (original !== null && materials! + resources! !== original)) block("INCONSISTENT", "originMismatch");
      if (stock !== null && stock < 0n) block("NEGATIVE_STOCK", "negativeStock");
      else if (stock === 0n) block("NO_STOCK", "noStock");
      else if (stock !== null && received !== null && stock < received) block("INSUFFICIENT_STOCK", "insufficientStock");
      if (item && (item.method !== "bis_MovingAverage" || item.serial || item.batch)) block("SPECIFIC_METHOD", "specificMethod");
      if (input.policy.costScope === "company") block("SPECIFIC_METHOD", "companyScope");
      if (warehouses.length > 1) block("SPECIFIC_METHOD", "multipleWarehouses");
      if (!item || !item.inventory || !wh || !warehouse || stock === null || current === null ||
          original === null || input.policy.perpetual !== true || !input.policy.costScope || !item.unit ||
          item.unit !== order.unit || receipts.some(r => r.unit !== order.unit)) block("MISSING_DATA", "missingCostOrSource");
      if (current !== null && (current < 0n || (unitGgf !== null && current + unitGgf < 0n))) block("INCONSISTENT", "negativeCost");
      if (wh?.locked) block("INCONSISTENT", "lockedWarehouse");
      if (eligible === null) block("MISSING_DATA", "remainingUnproven");
      else if (received === null || eligible > received || (stock !== null && eligible > stock)) block("INCONSISTENT", "remainingExceedsStock");
      else if (eligible === 0n) block("NO_STOCK", "noEligibleStock");
      if (input.technicalOnly || !input.policy.functionalApproved) block("MISSING_DATA", "functionalPending");
      if (input.policy.stockTreatment !== "spread-over-current-stock") block("MISSING_DATA", "stockTreatmentPending");
      const contra = ggf < 0n ? input.policy.decrementAccount : input.policy.incrementAccount;
      if (!contra || !input.policy.accountsVerified) block("MISSING_DATA", "accountsPending");
      if (!input.policy.postingDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.policy.postingDate) ||
          !Number.isFinite(Date.parse(input.policy.postingDate)) || new Date(input.policy.postingDate).toISOString().slice(0, 10) !== input.policy.postingDate)
        block("MISSING_DATA", "postingDatePending");
      return { id: `${order.id}/${warehouse}`, orderId: order.id, order: order.number, item: order.item,
        name: item?.name ?? "", warehouse, method: item?.method ?? "", unit: order.unit,
        planned: order.planned, produced: order.produced, warehouseProduced: price(received), stock: price(stock), eligible: price(eligible),
        currentCost: price(current), costSource: current === null ? null : input.policy.costScope === "warehouse" ? "Items.ItemWarehouseInfoCollection.StandardAveragePrice" : "Items.AvgStdPrice",
        ggf: amount(ggf), unitGgf: price(unitGgf), unitGgfExactMinor: produced && produced > 0n ? `${ggf * Q}/${produced}` : null,
        adjustedCost: price(current !== null && unitGgf !== null ? current + unitGgf : null), estimated: amount(estimate),
        naivePriceChangeImpact: amount(input.policy.costScope === "warehouse" && item?.method === "bis_MovingAverage" && current !== null && stock !== null && stock >= 0n && unitGgf !== null ? divRound(stock * unitGgf, MONEY_PRICE_QUANTITY) : null),
        original: amount(original), materials: amount(materials), resources: amount(resources),
        adjustedHistoricalTotal: amount(original === null ? null : original + ggf),
        historicalUnitCost: price(original !== null && produced && produced > 0n ? divRound(original * MONEY_PRICE_QUANTITY, produced) : null),
        receipts, components: order.components, accounts: order.accounts.map(a => ({ ...a, amount: amount(BigInt(a.amountMinor)) })),
        remainingEvidence: proofs.map(p => p.evidence), status: status as PreviewStatus, reasons: [...new Set(reasons)] };
    });
  });
  const scopes = [...new Set(rows.map(r => `${r.item}/${r.warehouse}`))].map(key => {
    const members = rows.filter(r => `${r.item}/${r.warehouse}` === key);
    const stock = exact(members[0]!.stock, 6);
    const current = exact(members[0]!.currentCost, 6);
    const eligible = members.map(r => quantity(r.eligible));
    const produced = sum(members.map(r => quantity(r.warehouseProduced) ?? 0n));
    const overbooked = stock !== null && (eligible.every(q => q !== null) ? sum(eligible as bigint[]) > stock : produced > stock);
    if (overbooked && stock! > 0n) for (const r of members) {
      if (["READY", "MISSING_DATA", "INSUFFICIENT_STOCK"].includes(r.status)) r.status = "INSUFFICIENT_STOCK";
      r.reasons.push("sharedStock");
    }
    const complete = members.every(r => r.status === "READY" && r.estimated !== null);
    const targetMinor = complete ? sum(members.map(r => parseDecimal(r.estimated!))) : null;
    const targetPrice = targetMinor !== null && current !== null && stock !== null && stock > 0n
      ? current + divRound(targetMinor * MONEY_PRICE_QUANTITY, stock) : null;
    const effect = targetPrice !== null && current !== null && stock !== null ? divRound((targetPrice-current)*stock, MONEY_PRICE_QUANTITY) : null;
    const wirePrice = targetPrice === null ? null : Number(formatDecimal(targetPrice, 6));
    if (targetPrice !== null && (targetPrice < 0n || effect !== targetMinor || exact(String(wirePrice),6) !== targetPrice)) for (const r of members) {
      r.status = "INCONSISTENT"; r.reasons.push("payloadPrecision");
    }
    return { key, item: members[0]!.item, warehouse: members[0]!.warehouse, orders: members.map(r => r.order),
      currentCost: price(current), stock: price(stock), targetPrice: price(targetPrice), estimate: amount(effect),
      ready: members.every(r => r.status === "READY"), targetMinor };
  });
  const complete = scopes.every(s => s.ready);
  // One price per item/warehouse. Per-OP prices must never become duplicate SAP price-change lines.
  const payload = complete ? {
    DocDate: input.policy.postingDate!, TaxDate: input.policy.postingDate!, RevalType: "P",
    Comments: "FactoryOne GGF - PREVIEW ONLY",
    JournalMemo: "FactoryOne GGF - PREVIEW ONLY",
    MaterialRevaluationLines: scopes.map(s => ({ ItemCode: s.item, WarehouseCode: s.warehouse, Price: Number(s.targetPrice!),
      ...(s.targetMinor! < 0n ? { RevaluationDecrementAccount: input.policy.decrementAccount! } : { RevaluationIncrementAccount: input.policy.incrementAccount! }) }))
  } : null;
  return { origin: input.origin, company: input.company, allocationId: input.allocationId, allocationDate: input.allocationDate,
    stockDate: input.stockDate, technicalOnly: input.technicalOnly, postingBlocked: true as const, payloadReady: complete,
    endpoint: "MaterialRevaluation", httpMethod: "POST (NOT EXECUTED)", rows,
    scopes: scopes.map(({targetMinor, ...scope}) => scope), payload,
    totalGgf: amount(sum(input.orders.map(o => BigInt(o.allocatedMinor)))),
    estimatedTotal: complete ? amount(sum(scopes.map(s => s.targetMinor!))) : null,
    reasons: [...new Set(rows.flatMap(r => r.reasons))], sourceRefs: input.sourceRefs };
}
export type RevaluationPreview = ReturnType<typeof previewRevaluation>;
