import { describe, expect, it } from "vitest";
import {
  analyzeOrderAudit,
  readOrderAuditData
} from "../../webapp/modules/ggf/repository/SapB1OrderAudit";
import type { GgfReadClient } from "../../webapp/modules/ggf/repository/MappedGgfSource";

const filter = { start: "2026-09-01", end: "2026-09-30", branch: "", costCenter: "" };
type Row = Record<string, any>;
// Invented fixtures, not extracts from the authorized SAP company.
function fixture() {
  const date = "2026-09-02T00:00:00Z";
  const receipt = {
    DocEntry: 1,
    DocDate: date,
    DocCurrency: "TEST",
    DocTotal: 28,
    Cancelled: "tNO",
    CancelStatus: "csNo",
    TransNum: 101,
    DocumentLines: [
      {
        LineNum: 0,
        BaseType: 202,
        BaseEntry: 20,
        BaseLine: null,
        ItemCode: "TEST-P",
        ItemType: "dit_Item",
        TransactionType: "botrntComplete",
        Quantity: 2,
        InventoryQuantity: 2,
        MeasureUnit: "UN",
        UseBaseUnits: "tYES",
        LineTotal: 28
      }
    ]
  };
  const issue = {
    ...receipt,
    DocEntry: 2,
    TransNum: 102,
    DocumentLines: [
      {
        ...receipt.DocumentLines[0],
        BaseLine: 0,
        ItemCode: "TEST-M",
        TransactionType: null,
        LineTotal: 20
      },
      {
        ...receipt.DocumentLines[0],
        LineNum: 1,
        BaseLine: 1,
        ItemCode: "TEST-R",
        ItemType: "dit_Resource",
        TransactionType: null,
        Quantity: 1,
        InventoryQuantity: 0,
        MeasureUnit: "hours",
        LineTotal: 8
      }
    ]
  };
  const order = {
    AbsoluteEntry: 20,
    DocumentNumber: 7,
    ItemNo: "TEST-P",
    ProductionOrderType: "bopotStandard",
    ProductionOrderStatus: "boposClosed",
    CompletedQuantity: 2,
    InventoryUOM: "UN",
    TransactionNumber: 103,
    ProductionOrderLines: [
      {
        LineNumber: 0,
        ItemNo: "TEST-M",
        ItemType: "pit_Item",
        IssuedQuantity: 2,
        ProductionOrderIssueType: "im_Manual"
      },
      {
        LineNumber: 1,
        ItemNo: "TEST-R",
        ItemType: "pit_Resource",
        IssuedQuantity: 1,
        ProductionOrderIssueType: "im_Backflush"
      }
    ]
  };
  const entities: Record<string, Row[]> = {
    InventoryGenEntries: [receipt],
    InventoryGenExits: [issue],
    ProductionOrders: [order],
    Resources: [
      { Code: "TEST-R", Group: 1, UnitOfMeasure: "hours", TimePerUnits: 7200, UnitsPerTime: 1 }
    ],
    ResourceGroups: [{ Code: 1 }],
    ProjectManagementTimeSheet: [
      {
        AbsEntry: 1,
        DateFrom: date,
        DateTo: "2026-12-31T00:00:00Z",
        PM_TimeSheetLineDataCollection: [
          { LineID: 1, Date: "2026-08-31T00:00:00Z", Workorder: null, EffectiveTime: "04:00:00" }
        ]
      }
    ]
  };
  const points: Record<string, Row> = {
    "ChartOfAccounts(%27TEST-D%27)": { Code: "TEST-D", Name: "Test debit account" },
    "ChartOfAccounts(%27TEST-C%27)": { Code: "TEST-C", Name: "Test credit account" },
    "InventoryGenEntries(1)": structuredClone(receipt),
    "InventoryGenExits(2)": structuredClone(issue),
    "ProductionOrders(20)": structuredClone(order),
    "Items(%27TEST-P%27)": {
      ItemCode: "TEST-P",
      InventoryItem: "tYES",
      InventoryUOM: "UN",
      MovingAveragePrice: 999
    },
    "Items(%27TEST-M%27)": {
      ItemCode: "TEST-M",
      InventoryItem: "tYES",
      InventoryUOM: "UN",
      MovingAveragePrice: 999
    }
  };
  for (const [id, original, type, amount] of [
    [101, 1, "ttGeneralReceiptToStock", 28],
    [102, 2, "ttGeneralReleaseFromStock", 28],
    [103, 20, "ttProductionOrder", 16]
  ] as const)
    points[`JournalEntries(${id})`] = {
      JdtNum: id,
      ReferenceDate: date,
      Original: original,
      OriginalJournal: type,
      JournalEntryLines: [
        { Line_ID: 0, AccountCode: "TEST-D", Debit: amount, Credit: 0 },
        { Line_ID: 1, AccountCode: "TEST-C", Debit: 0, Credit: amount }
      ]
    };
  const calls: string[] = [];
  const client: GgfReadClient = {
    async get<T>(path: string): Promise<T> {
      calls.push(path);
      const resource = path.split("?")[0]!;
      if (resource.endsWith("/$count")) return String(entities[resource.slice(0, -7)]!.length) as T;
      if (entities[resource]) return { value: structuredClone(entities[resource]) } as T;
      if (points[resource]) return structuredClone(points[resource]) as T;
      throw new Error("Unexpected fixture path");
    }
  };
  return { client, calls, entities, points };
}

describe("read-only production basis audit", () => {
  it("rejects a nested continuation even if header counts reconcile", async () => {
    const f = fixture();
    f.entities.InventoryGenEntries![0]!["DocumentLines@odata.nextLink"] = "unread-lines";
    await expect(readOrderAuditData(f.client, filter)).rejects.toThrow("Nested SAP pagination");
  });
  it("reconciles only diagnostic values, keeps current cost/hours unknown and separates dates", async () => {
    const f = fixture();
    const source = await readOrderAuditData(f.client, filter);
    const report = analyzeOrderAudit(source);
    expect(source.orders.map((o) => o.AbsoluteEntry)).toEqual([20]);
    expect(report.orders[0]).toMatchObject({
      entry: 20,
      number: 7,
      receiptQuantityInPeriod: "2.000000",
      receiptCompletedDifference: "0.000000",
      issuedItemLineTotals: "20.000000",
      issuedResourceLineTotals: "8.000000",
      receivedLineTotals: "28.000000",
      issuesMinusReceipts: "0.000000",
      currentCost: null,
      actualHours: null,
      itemMasterAveragePrice: 999
    });
    expect(report.orders[0]!.closingJournal?.debit).toBe("16.000000");
    expect(report.orders[0]!.resourceConsumption[0]).toMatchObject({
      quantity: "1.000000",
      actualHours: null,
      timePerUnits: 7200
    });
    expect(report.timeSheets.periodLines).toBe(0);
    expect(report.allocationReady).toBe(false);
    expect(report.postingBlocked).toBe(true);
    expect(report.structuralDifferences).toEqual([]);
    expect(f.calls.filter((p) => p === "InventoryGenEntries/$count")).toHaveLength(2);
    expect(f.calls.every((p) => !p.includes("$filter"))).toBe(true);
  });
  it("fails before reads for unapproved branch", async () => {
    const f = fixture();
    await expect(readOrderAuditData(f.client, { ...filter, branch: "1" })).rejects.toThrow("scope");
    expect(f.calls).toEqual([]);
  });
  it("rejects a receipt whose BaseEntry is only a document number, not an order key", async () => {
    const f = fixture();
    f.entities.InventoryGenEntries![0]!.DocumentLines[0].BaseEntry = 7;
    await expect(readOrderAuditData(f.client, filter)).rejects.toThrow("missing production order");
  });
  it.each(["InventoryGenEntries(1)", "ProductionOrders(20)"])(
    "fails if %s changes between collection and point read",
    async (path) => {
      const f = fixture();
      f.points[path]!.changed = true;
      await expect(readOrderAuditData(f.client, filter)).rejects.toThrow(
        "changed between collection and detail"
      );
    }
  );
  it("rejects drift in global count after point reads", async () => {
    const f = fixture();
    let count = 0;
    const client: GgfReadClient = {
      async get<T>(p: string) {
        if (p === "Resources/$count" && ++count === 2) return "2" as T;
        return f.client.get<T>(p);
      }
    };
    await expect(readOrderAuditData(client, filter)).rejects.toThrow("count changed");
  });
  it.each(["tYES", null])(
    "does not presume sign for cancelled/unknown documents %j",
    async (cancelled) => {
      const f = fixture();
      const source = await readOrderAuditData(f.client, filter);
      source.movements[0]!.document.Cancelled = cancelled;
      const order = analyzeOrderAudit(source).orders[0]!;
      expect(order.comparisonsSupported).toBe(false);
      expect(order.receiptQuantityInPeriod).toBeNull();
      expect(order.issuedItemLineTotals).toBeNull();
    }
  );
  it("does not count returned components as parent production", async () => {
    const source = await readOrderAuditData(fixture().client, filter);
    (source.movements[0]!.document.DocumentLines as Row[])[0]!.ItemCode = "TEST-M";
    expect(analyzeOrderAudit(source).orders[0]!.findings).toContain(
      "RETURN_REJECTION_OR_BYPRODUCT_RULE_PENDING"
    );
  });
  it("never turns a resource with no UoM and capacity data into measured hours", async () => {
    const source = await readOrderAuditData(fixture().client, filter);
    source.resources[0]!.UnitOfMeasure = null;
    const order = analyzeOrderAudit(source).orders[0]!;
    expect(order.findings).toContain("RESOURCE_UNIT_MISSING_OR_DIFFERENT");
    expect(order.actualHours).toBeNull();
  });
  it("checks BaseLine and component code, not just the OP reference", async () => {
    const source = await readOrderAuditData(fixture().client, filter);
    (source.movements[1]!.document.DocumentLines as Row[])[0]!.BaseLine = 19;
    const order = analyzeOrderAudit(source).orders[0]!;
    expect(order.findings).toContain("COMPONENT_LINK_MISMATCH");
    expect(order.issuesMinusReceipts).toBeNull();
  });
  it("blocks incompatible quantities rather than summing unlike units", async () => {
    const source = await readOrderAuditData(fixture().client, filter);
    (source.movements[0]!.document.DocumentLines as Row[])[0]!.MeasureUnit = "KG";
    expect(analyzeOrderAudit(source).orders[0]!.receiptQuantityInPeriod).toBeNull();
  });
  it("reports a mismatch with the issued quantity declared on the OP", async () => {
    const source = await readOrderAuditData(fixture().client, filter);
    (source.orders[0]!.ProductionOrderLines as Row[])[0]!.IssuedQuantity = 3;
    const report = analyzeOrderAudit(source);
    expect(report.orders[0]!.componentChecks[0]!.difference).toBe("-1.000000");
    expect(report.structuralDifferences).toContain("ProductionOrders(20)");
  });
  it("detects journal origin mismatch even with balanced debit and credit", async () => {
    const source = await readOrderAuditData(fixture().client, filter);
    source.journals[0]!.Original = 99;
    expect(analyzeOrderAudit(source).structuralDifferences).toContain("InventoryGenEntries(1)");
  });
  it("rejects duplicate nested lines", async () => {
    const source = await readOrderAuditData(fixture().client, filter);
    const lines = source.journals[0]!.JournalEntryLines as Row[];
    lines[1]!.Line_ID = lines[0]!.Line_ID;
    expect(() => analyzeOrderAudit(source)).toThrow("Duplicate audit");
  });
  it("retains historical movements when comparing accumulated order quantity", async () => {
    const source = await readOrderAuditData(fixture().client, filter);
    source.movements[0]!.document.DocDate = "2026-08-31T00:00:00Z";
    const order = analyzeOrderAudit(source).orders[0]!;
    expect(order.receiptQuantityInPeriod).toBe("0.000000");
    expect(order.receiptQuantityLifetime).toBe("2.000000");
  });
  it("does not use time sheet header date as the worked date or assume key semantics", async () => {
    const f = fixture();
    f.entities.ProjectManagementTimeSheet![0]!.PM_TimeSheetLineDataCollection[0].Workorder = 7;
    const source = await readOrderAuditData(f.client, filter);
    const report = analyzeOrderAudit(source);
    expect(report.timeSheets.orderReferenceCandidates[0]).toMatchObject({
      reference: 7,
      byEntry: [],
      byNumber: [{ entry: 20, number: 7 }]
    });
    expect(report.orders[0]).toMatchObject({
      periodTimeSheetCandidates: 0,
      lifetimeTimeSheetCandidates: 1,
      actualHours: null
    });
  });
  it("rejects impossible source dates", async () => {
    const f = fixture();
    f.entities.InventoryGenEntries![0]!.DocDate = "2026-02-31T00:00:00Z";
    await expect(readOrderAuditData(f.client, filter)).rejects.toThrow("Invalid SAP audit date");
  });
});
