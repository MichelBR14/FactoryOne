import { writeFile } from "node:fs/promises";
import { openReadSession } from "./ggf-sap-session.mjs";

const session = await openReadSession();
try {
  const result = {};
  for (const entity of [
    "JournalEntries",
    "InventoryGenEntries",
    "ProductionOrders",
    "Resources",
    "BusinessPlaces",
    "ResourceGroups",
    "UnitOfMeasurements"
  ]) {
    const rows = [];
    let path = entity;
    const visited = new Set();
    while (path) {
      if (visited.has(path) || visited.size >= 100) throw new Error("Incomplete pagination");
      visited.add(path);
      const page = await session.get(path, { Prefer: "odata.maxpagesize=20" });
      if (!page.ok || !Array.isArray(page.data?.value)) throw new Error(`Read failed: ${entity}`);
      rows.push(...page.data.value);
      path = page.data["@odata.nextLink"] ?? page.data["odata.nextLink"];
      if (path?.startsWith("/b1s/v2/")) path = path.slice(8);
    }
    const count = await session.get(`${entity}/$count`);
    result[entity] = { rows, pages: visited.size, count: count.data };
    console.log(
      JSON.stringify({ entity, rows: rows.length, pages: visited.size, count: count.data })
    );
  }
  await writeFile(".local/ggf/inspection.json", JSON.stringify(result, null, 2), { mode: 0o600 });
  const journals = result.JournalEntries.rows;
  console.log(
    JSON.stringify({
      journalDates: [...new Set(journals.map((j) => j.ReferenceDate))].sort(),
      receipts: result.InventoryGenEntries.rows.map((d) => ({
        id: d.DocEntry,
        date: d.DocDate,
        currency: d.DocCurrency,
        total: d.DocTotal,
        cancelled: d.Cancelled,
        branch: d.BPL_IDAssignedToInvoice,
        transaction: d.TransNum,
        lines: d.DocumentLines.map((l) => ({
          line: l.LineNum,
          baseType: l.BaseType,
          baseEntry: l.BaseEntry,
          quantity: l.Quantity,
          inventoryQuantity: l.InventoryQuantity,
          unit: l.MeasureUnit,
          uom: l.UoMCode,
          cost: l.StockPrice,
          total: l.LineTotal
        }))
      }))
    })
  );
} finally {
  await session.close();
}
