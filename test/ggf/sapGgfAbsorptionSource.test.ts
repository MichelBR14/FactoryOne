import { describe, expect, it } from "vitest";
import { readGgfV2Absorption } from "../../webapp/modules/ggf/absorption/SapGgfAbsorptionSource";
import type { GgfReadClient } from "../../webapp/modules/ggf/repository/MappedGgfSource";
import type { AbsorptionMapping } from "../../webapp/modules/ggf/absorption/types";

const filter = { start: "2026-09-01", end: "2026-09-30", branch: "", dimensions: ["", "", "", "", ""] as [string, string, string, string, string] };
const mapping: AbsorptionMapping = {
  accounts: [{ account: "4.01", category: "GGF" }],
  resources: [{ resource: "R1", component: 1, category: "MOD" }],
  technicalHomologation: true
};

describe("GGF V2 SAP read mapping", () => {
  it("uses date-bounded ledger and inventory sources, resolves real OP/item labels, and proves collection counts", async () => {
    const rows: Record<string, unknown[]> = {
      JournalEntries: [{ JdtNum: 50, ReferenceDate: "2026-09-20", OriginalJournal: "JE-50", JournalEntryLines: [{ Line_ID: 2, AccountCode: "4.01", Debit: 12.5, Credit: 2, BPLID: 1, CostingCode: "A" }] }],
      ChartOfAccounts: [{ Code: "4.01", Name: "Conta mapeada" }],
      InventoryGenExits: [{ DocEntry: 8, DocNum: 88, DocDate: "2026-09-20", Cancelled: "tNO", CancelStatus: "csNo", DocumentLines: [{ LineNum: 0, ItemCode: "R1", ItemType: "dit_Resource", BaseType: 202, BaseEntry: 203, Quantity: 2, MeasureUnit: "h", LineTotal: 10, AccountCode: "4.01" }] }],
      InventoryGenEntries: []
    };
    const calls: string[] = [];
    const client: GgfReadClient = {
      async get<T = unknown>(path: string): Promise<T | undefined> {
        calls.push(path);
        if (path.includes("/$count")) return String(rows[path.split("/")[0]!]!.length) as T;
        if (path.startsWith("Resources(")) return { Code: "R1", Name: "Recurso", Type: "rtLabor", UnitOfMeasure: "h", Cost1: 5 } as T;
        if (path.startsWith("ProductionOrders(")) return { AbsoluteEntry: 203, DocumentNumber: 76, ItemNo: "P1", InventoryUOM: "UN", PlannedQuantity: 3, CompletedQuantity: 2 } as T;
        if (path.startsWith("Items(")) return { ItemCode: "P1", ItemName: "Produto" } as T;
        const entity = path.split(/[/?]/)[0]!;
        return { value: structuredClone(rows[entity] ?? []) } as T;
      }
    };
    const result = await readGgfV2Absorption(client, "SBODEMOBR2", filter, mapping);
    expect(result.accounts[0]).toMatchObject({ code: "4.01", name: "Conta mapeada" });
    expect(result.journals[0]).toMatchObject({ transId: "50", document: "JE-50", debitCents: 1250n, creditCents: 200n, branch: "1", dimensions: ["A", "", "", "", ""] });
    expect(result.orders[0]).toMatchObject({ number: "76", item: "P1", itemDescription: "Produto", plannedQuantity: "3", completedQuantity: "2" });
    expect(result.movements[0]).toMatchObject({ order: "76", quantityMicros: 2_000_000n, direction: "ISSUE", unit: "h" });
    expect(result.completeness).toHaveLength(5);
    expect(calls.some((path) => decodeURIComponent(path).includes("ReferenceDate ge '2026-09-01'"))).toBe(true);
    expect(calls.some((path) => decodeURIComponent(path).includes("DocDate ge '2026-09-01'"))).toBe(true);
    expect(calls.some((path) => path.startsWith("ProductionOrders(203)"))).toBe(true);
  });

  it("rejects another company before any Service Layer read", async () => {
    const client: GgfReadClient = { async get() { throw new Error("should not read"); } };
    await expect(readGgfV2Absorption(client, "SBO_OTHER", filter, mapping)).rejects.toThrow("Company or period scope rejected");
  });
});
