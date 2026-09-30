import type { AllocationResult } from "../engine/types";
import type { GgfReadClient } from "./MappedGgfSource";
import type { RevaluationInput, PreviewItem, PreviewOrder } from "../service/RevaluationPreview";
import { parseDecimal, sum } from "../../../core/util/money";

type Row = Record<string, any>;
function checked(data: unknown): Row {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid SAP response");
  const walk = (v: unknown): void => {
    if (v && typeof v === "object") for (const [key, child] of Object.entries(v)) {
      if (/nextLink$/i.test(key) && child != null) throw new Error("Incomplete nested SAP read");
      walk(child);
    }
  };
  walk(data); return data as Row;
}
const num = (v: unknown): string | null => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e12 && /^-?\d+(\.\d{1,6})?$/.test(String(v)) ? String(v) : null;
function uniqueRows(value: unknown, key: string): Row[] {
  if (!Array.isArray(value)) throw new Error("Missing SAP collection");
  const rows = value.map(checked);
  if (rows.some(r => r[key] == null) || new Set(rows.map(r => r[key])).size !== rows.length) throw new Error("Duplicate SAP rows");
  return rows;
}
export async function readRevaluationInput(client: GgfReadClient, result: AllocationResult, technicalOnly: boolean): Promise<RevaluationInput> {
  if (result.snapshot.origin !== "sap" || BigInt(result.difference) !== 0n ||
      sum(result.orders.map(o => BigInt(o.allocated))) !== BigInt(result.total)) throw new Error("Unreconciled SAP allocation");
  const refs: string[] = [];
  const read = async (path: string) => { refs.push(path); return checked(await client.get(path)); };
  const admin = await read("CompanyService_GetAdminInfo");
  const codes = [...new Set(result.orders.map(o => o.order.item))];
  const itemSelect = "ItemCode,ItemName,InventoryItem,InventoryUOM,CostAccountingMethod,AvgStdPrice,QuantityOnStock,ManageSerialNumbers,ManageBatchNumbers,ItemWarehouseInfoCollection";
  const items: PreviewItem[] = [];
  const originals = new Map<string, Row>();
  for (const code of codes) {
    const path = `Items('${code.replaceAll("'", "''")}')?$select=${itemSelect}`;
    const row = await read(path); originals.set(path, row);
    if (row.ItemCode !== code || ![row.InventoryItem,row.ManageSerialNumbers,row.ManageBatchNumbers].every(v => ["tYES","tNO"].includes(v))) throw new Error("Incomplete item identity/valuation flags");
    const warehouses = uniqueRows(row.ItemWarehouseInfoCollection, "WarehouseCode");
    if (num(row.QuantityOnStock) === null || warehouses.some(w => num(w.InStock) === null) ||
        sum(warehouses.map(w => parseDecimal(String(w.InStock),6))) !== parseDecimal(String(row.QuantityOnStock),6)) throw new Error("Item stock does not reconcile with warehouses");
    items.push({ code, name: row.ItemName, unit: row.InventoryUOM, method: row.CostAccountingMethod,
      inventory: row.InventoryItem === "tYES", serial: row.ManageSerialNumbers === "tYES", batch: row.ManageBatchNumbers === "tYES",
      totalStock: num(row.QuantityOnStock), globalCost: num(row.AvgStdPrice),
      warehouses: warehouses.map(w => ({ code: w.WarehouseCode, stock: num(w.InStock), cost: num(w.StandardAveragePrice), locked: w.Locked !== "tNO" })) });
  }
  const orders: PreviewOrder[] = [];
  const docs = new Map<string, Row>();
  for (const {order, allocated} of result.orders) {
    if (!/^\d+$/.test(order.id)) throw new Error("Invalid OP key");
    const path = `ProductionOrders(${order.id})?$select=AbsoluteEntry,DocumentNumber,ItemNo,PlannedQuantity,CompletedQuantity,InventoryUOM,ProductionOrderStatus`;
    const op = await read(path); originals.set(path, op);
    const problems: string[] = [];
    if (String(op.AbsoluteEntry) !== order.id || String(op.DocumentNumber) !== order.number || op.ItemNo !== order.item || op.ProductionOrderStatus !== "boposClosed") problems.push("orderChanged");
    const receipts: PreviewOrder["receipts"] = [];
    for (const ref of order.sourceRefs.filter(r => r.startsWith("InventoryGenEntries"))) {
      const match = /^InventoryGenEntries\((\d+)\)\/(\d+)$/.exec(ref);
      if (!match) throw new Error("Invalid receipt reference");
      const [_, key, lineId] = match;
      const docPath = `InventoryGenEntries(${key})?$select=DocEntry,DocNum,DocDate,DocCurrency,Cancelled,CancelStatus,DocumentLines`;
      let doc = docs.get(docPath);
      if (!doc) { doc = await read(docPath); docs.set(docPath,doc); originals.set(docPath,doc); }
      const line = uniqueRows(doc.DocumentLines, "LineNum").find(l => String(l.LineNum) === lineId);
      if (!line || String(doc.DocEntry) !== key || doc.Cancelled !== "tNO" || doc.CancelStatus !== "csNo" || doc.DocCurrency !== admin.LocalCurrency ||
          line.BaseType !== 202 || String(line.BaseEntry) !== order.id || line.ItemCode !== order.item ||
          line.TransactionType !== "botrntComplete" || line.UseBaseUnits !== "tYES" || num(line.InventoryQuantity) === null ||
          num(line.Quantity) !== num(line.InventoryQuantity) || line.MeasureUnit !== op.InventoryUOM ||
          doc.DocDate.slice(0,10) < result.snapshot.filter.start || doc.DocDate.slice(0,10) > result.snapshot.filter.end) { problems.push("receiptChanged"); continue; }
      receipts.push({ document: String(key), line: Number(lineId), date: doc.DocDate.slice(0,10), warehouse: line.WarehouseCode,
        quantity: num(line.InventoryQuantity)!, unit: line.MeasureUnit });
    }
    if (!order.quantity || num(op.CompletedQuantity) === null || parseDecimal(order.quantity,6) !== parseDecimal(String(op.CompletedQuantity),6)) problems.push("quantityChanged");
    if (!order.directCost || !order.directCostComponents?.length ||
        sum(order.directCostComponents.map(c => parseDecimal(c.amount))) !== parseDecimal(order.directCost)) problems.push("originMismatch");
    orders.push({ id: order.id, number: order.number, item: order.item, planned: num(op.PlannedQuantity), produced: order.quantity,
      unit: op.InventoryUOM, allocatedMinor: String(allocated), components: order.directCostComponents ?? [], receipts, remaining: [],
      accounts: result.configuration.accounts.filter(a => result.traces.some(t => t.account === a.account && t.orderId === order.id)).map(a => ({
        account: a.account, name: a.name, amountMinor: String(sum(result.traces.filter(t => t.account === a.account && t.orderId === order.id).map(t => BigInt(t.amount)))) })),
      inconsistencies: problems });
  }
  // Relevant values must remain stable across this read; this is not a transactional snapshot.
  for (const [path, initial] of originals) {
    const again = await read(path);
    const fields = new URL(path,"https://read.invalid/").searchParams.get("$select")!.split(",");
    if (JSON.stringify(fields.map(k=>initial[k])) !== JSON.stringify(fields.map(k=>again[k]))) throw new Error("SAP data changed during preview read");
  }
  const after = await read("CompanyService_GetAdminInfo");
  for (const key of ["ContinuousStockManagement","PriceSystem","LocalCurrency"]) if (admin[key] !== after[key]) throw new Error("SAP valuation policy changed");
  if (admin.LocalCurrency !== "R$") throw new Error("Unverified allocation currency");
  return { origin: "sap", company: "SBODEMOBR2", allocationId: result.snapshot.id, allocationDate: result.snapshot.capturedAt,
    stockDate: new Date().toISOString(), technicalOnly, sourceRefs: refs,
    policy: { perpetual: admin.ContinuousStockManagement === "tYES" ? true : admin.ContinuousStockManagement === "tNO" ? false : null,
      costScope: admin.PriceSystem === "tYES" ? "warehouse" : admin.PriceSystem === "tNO" ? "company" : null,
      functionalApproved: false, stockTreatment: null, postingDate: null, incrementAccount: null, decrementAccount: null, accountsVerified: false },
    orders, items };
}
