import { describe, expect, it } from "vitest";
import { SapGgfCalculationSource } from "../../webapp/modules/ggf/repository/SapGgfCalculationSource";
import { allocate } from "../../webapp/modules/ggf/engine/allocation";
import type { Configuration, Criterion } from "../../webapp/modules/ggf/engine/types";
import type { GgfReadClient } from "../../webapp/modules/ggf/repository/MappedGgfSource";
import { ClosingSession } from "../../webapp/modules/ggf/service/ClosingSession";
import { readFileSync } from "node:fs";
import { calculateAbsorptionDistribution } from "../../webapp/modules/ggf/absorption/distribution";
import { reconcileAbsorption } from "../../webapp/modules/ggf/absorption/reconciliation";
import type { AbsorptionMapping, AbsorptionSourceData } from "../../webapp/modules/ggf/absorption/types";

const filter = { start: "2026-09-01", end: "2026-09-30", branch: "", costCenter: "" };
const config = (criterion: Criterion = "DIRECT_COST"): Configuration => ({
  classifications: [{ id: "TEST", name: "Test only" }],
  accounts: [
    {
      account: "TEST-GGF",
      name: "Test only",
      classificationId: "TEST",
      criterion,
      percent: "100",
      active: true
    }
  ],
  groupShares:
    criterion === "RESOURCE_GROUP"
      ? [{ account: "TEST-GGF", group: "1", percent: "100", basis: "RESOURCE_VALUE" }]
      : []
});
function fixture(entries = [203, 204, 206]) {
  // Invented source responses. Only the OP key allow-list matches the approved scope.
  const rows: Record<string, any[]> = {
    JournalEntries: [
      {
        JdtNum: 1,
        ReferenceDate: "2026-09-10T00:00:00Z",
        JournalEntryLines: [{ Line_ID: 0, AccountCode: "TEST-GGF", Debit: 100, Credit: 0 }]
      }
    ],
    ChartOfAccounts: [{ Code: "TEST-GGF", Name: "Test only" }],
    Resources: [{ Code: "TEST-R", Group: 1, UnitOfMeasure: "cycles" }],
    ResourceGroups: [{ Code: 1, Name: "Test group" }],
    ProductionOrders: entries.map((key, i) => ({
      AbsoluteEntry: key,
      DocumentNumber: i + 1,
      ItemNo: key === 203 ? "TEST-A" : "TEST-B",
      InventoryUOM: "UN",
      CompletedQuantity: 1,
      PlannedQuantity: 1,
      PostingDate: "2026-09-01T00:00:00Z",
      ClosingDate: "2026-09-28T00:00:00Z",
      ProductionOrderStatus: "boposClosed",
      ProductionOrderType: "bopotStandard",
      ProductionOrderLines: [
        { LineNumber: 0, ItemNo: "TEST-M", ItemType: "pit_Item", IssuedQuantity: 1 },
        { LineNumber: 1, ItemNo: "TEST-R", ItemType: "pit_Resource", IssuedQuantity: 1 }
      ]
    })),
    InventoryGenEntries: [],
    InventoryGenExits: []
  };
  entries.forEach((key, i) => {
    const header = {
      DocDate: "2026-09-28T00:00:00Z",
      DocCurrency: "R$",
      Cancelled: "tNO",
      CancelStatus: "csNo"
    };
    rows.InventoryGenEntries!.push({
      ...header,
      DocEntry: 11 + i,
      DocumentLines: [
        {
          LineNum: 0,
          ItemCode: key === 203 ? "TEST-A" : "TEST-B",
          BaseType: 202,
          BaseEntry: key,
          BaseLine: null,
          ItemType: "dit_Item",
          TransactionType: "botrntComplete",
          MeasureUnit: "UN",
          UseBaseUnits: "tYES",
          InventoryQuantity: 1,
          Quantity: 1,
          LineTotal: 15 + i * 20
        }
      ]
    });
    rows.InventoryGenExits!.push({
      ...header,
      DocEntry: 21 + i,
      DocumentLines: [
        {
          LineNum: 0,
          BaseType: 202,
          BaseEntry: key,
          BaseLine: 0,
          ItemCode: "TEST-M",
          ItemType: "dit_Item",
          Quantity: 1,
          LineTotal: 10 + i * 20
        },
        {
          LineNum: 1,
          BaseType: 202,
          BaseEntry: key,
          BaseLine: 1,
          ItemCode: "TEST-R",
          ItemType: "dit_Resource",
          Quantity: 1,
          MeasureUnit: "cycles",
          LineTotal: 5
        }
      ]
    });
  });
  const calls: string[] = [];
  const client = {
    async get(path: string) {
      calls.push(path);
      const entity = path.split(/[/?]/)[0]!;
      if (path.includes("/$count")) return String(rows[entity]!.length);
      return { value: structuredClone(rows[entity]) };
    }
  } as GgfReadClient;
  const source = new SapGgfCalculationSource(client, {
    orderEntries: entries,
    directCostPolicy: "DOCUMENTED_MATERIALS_AND_RESOURCES"
  });
  return { rows, calls, client, source };
}

describe("narrow SAP calculation mapping with controlled responses", () => {
  it("uses recorded issue totals with composition, never master tariff or current stock price", async () => {
    const f = fixture(),
      c = config();
    const s = await f.source.loadSnapshot(filter, c);
    const r = allocate(c, s);
    expect(r.orders.map((o) => o.order.directCost)).toEqual(["15.00", "35.00", "55.00"]);
    expect(r.orders.map((o) => o.allocated)).toEqual([1429n, 3333n, 5238n]);
    expect(r.orders.every((o) => o.current === null && o.resulting === null)).toBe(true);
    expect(r.orders[0]!.order.directCostComponents).toHaveLength(2);
    expect(r.snapshot.origin).toBe("sap");
    expect(r.snapshot.evidence.currency).toBe("SAP_LOCAL");
    expect(f.calls.some((p) => p.includes("Cost1") || p.includes("MovingAveragePrice"))).toBe(
      false
    );
  });
  it("requires explicit direct-cost policy", async () => {
    const f = fixture(),
      c = config();
    const src = new SapGgfCalculationSource(f.client, { orderEntries: [203, 204, 206] });
    const s = await src.loadSnapshot(filter, c);
    expect(() => allocate(c, s)).toThrow("basisUnavailable");
  });
  it("quantity works for identical items and blocks mixed products even with UN", async () => {
    const f = fixture([204, 206]),
      c = config("QUANTITY");
    expect(
      allocate(c, await f.source.loadSnapshot(filter, c)).orders.map((o) => o.allocated)
    ).toEqual([5000n, 5000n]);
    const all = fixture();
    const snapshot = await all.source.loadSnapshot(filter, c);
    expect(() => allocate(c, snapshot)).toThrow("sourceEvidence");
  });
  it("blocks hours without a mapped actual-hours source", async () => {
    const f = fixture(),
      c = config("HOURS");
    const s = await f.source.loadSnapshot(filter, c);
    expect(s.orders.every((o) => o.hours === null)).toBe(true);
    expect(() => allocate(c, s)).toThrow("basisUnavailable");
  });
  it("resource value supports group distribution independently of hours", async () => {
    const f = fixture(),
      c = config("RESOURCE_GROUP");
    const r = allocate(c, await f.source.loadSnapshot(filter, c));
    expect(r.orders.map((o) => o.allocated)).toEqual([3334n, 3333n, 3333n]);
    expect(r.traces.every((t) => t.basisKind === "RESOURCE_VALUE")).toBe(true);
  });
  it("resource quantities require actual matching units and comparable resource codes", async () => {
    const f = fixture(),
      c = config("RESOURCE_GROUP");
    c.groupShares[0]!.basis = "RESOURCE_QUANTITY";
    expect(allocate(c, await f.source.loadSnapshot(filter, c)).difference).toBe(0n);
    f.rows.Resources![0].UnitOfMeasure = null;
    const s = await f.source.loadSnapshot(filter, c);
    expect(() => allocate(c, s)).toThrow("basisUnavailable");
  });
  it("zero ledger amount is allowed only with an actual available basis", async () => {
    const f = fixture(),
      c = config();
    f.rows.JournalEntries = [];
    const r = allocate(c, await f.source.loadSnapshot(filter, c));
    expect(r.total).toBe(0n);
  });
  it("does not discard missing resource consumption and spread its pool elsewhere", async () => {
    const f = fixture(),
      c = config("RESOURCE_GROUP");
    f.rows.InventoryGenExits![0].DocumentLines.pop();
    await expect(f.source.loadSnapshot(filter, c)).rejects.toThrow("basisUnavailable");
  });
  it("blocks unrecognized account rather than treating it as zero", async () => {
    const f = fixture();
    f.rows.ChartOfAccounts = [];
    await expect(f.source.loadSnapshot(filter, config())).rejects.toThrow("missingBalance");
  });
  it("blocks cancellations and unsupported order lifecycle", async () => {
    const f = fixture();
    f.rows.InventoryGenEntries![0].Cancelled = "tYES";
    await expect(f.source.loadSnapshot(filter, config())).rejects.toThrow("basisUnavailable");
  });
  it("rejects period, branch, foreign OP and fictional account before reading", async () => {
    const f = fixture();
    await expect(f.source.loadSnapshot({ ...filter, branch: "1" }, config())).rejects.toThrow(
      "basisUnavailable"
    );
    await expect(
      new SapGgfCalculationSource(f.client, { orderEntries: [999] }).loadSnapshot(filter, config())
    ).rejects.toThrow("basisUnavailable");
    const c = config();
    c.accounts[0]!.account = "DEV-ACCOUNT";
    await expect(f.source.loadSnapshot(filter, c)).rejects.toThrow("sourceMismatch");
    expect(f.calls).toEqual([]);
  });
  it("rejects missing real percentage before reading", async () => {
    const f = fixture(),
      c = config();
    delete c.accounts[0]!.percent;
    await expect(f.source.loadSnapshot(filter, c)).rejects.toThrow("sourceMismatch");
    expect(f.calls).toEqual([]);
  });
  it("cannot publish incomplete nested pages", async () => {
    const f = fixture();
    f.rows.InventoryGenEntries![0]["DocumentLines@odata.nextLink"] = "more";
    await expect(f.source.loadSnapshot(filter, config())).rejects.toThrow("sourceRead");
  });
  it("rejects changed counts on the closing control read", async () => {
    const f = fixture();
    let counts = 0;
    const client = {
      async get(path: string) {
        if (path.startsWith("JournalEntries/$count") && ++counts > 1) return "2";
        return f.client.get(path);
      }
    } as GgfReadClient;
    const source = new SapGgfCalculationSource(client, { orderEntries: [203, 204, 206] });
    await expect(source.loadSnapshot(filter, config())).rejects.toThrow("Count changed");
  });
  it("rejects unmapped resource groups", async () => {
    const f = fixture();
    f.rows.ResourceGroups = [];
    await expect(f.source.loadSnapshot(filter, config("RESOURCE_GROUP"))).rejects.toThrow(
      "Resource/group not resolved"
    );
  });
  it("blocks posting in the real calculation session", async () => {
    const f = fixture();
    const s = new ClosingSession(f.source);
    await s.calculate(config(), filter);
    expect(() => s.confirm()).toThrow("postingBlocked");
  });
  it("CLI has no generic audit, demo source or business write calls", () => {
    const script = readFileSync("scripts/ggf-sap-calculate.mjs", "utf8");
    expect(script).not.toMatch(
      /DevelopmentGgf|readOrderAuditData|readSap\(|\.(post|patch|put|delete)\(/
    );
    expect(script).toContain("openReadSession()");
    expect(script).toMatch(/finally\s*\{\s*await connection\.close\(\)/);
  });
});

describe("V2 absorption distribution reusing the approved allocation engine", () => {
  const absorptionData = (): AbsorptionSourceData => ({
    company: "SBODEMOBR2",
    filter: { start: filter.start, end: filter.end, branch: "", dimensions: ["", "", "", "", ""] },
    accounts: [{ code: "TEST-GGF", name: "Technical only" }, { code: "TEST-MOD", name: "Technical only" }],
    journals: [
      { account: "TEST-GGF", debitCents: 10000n, creditCents: 0n, branch: "", dimensions: ["", "", "", "", ""], referenceDate: filter.start, transId: "1", document: "JE 1", lineId: "0" },
      { account: "TEST-MOD", debitCents: 0n, creditCents: 1000n, branch: "", dimensions: ["", "", "", "", ""], referenceDate: filter.start, transId: "2", document: "JE 2", lineId: "0" }
    ],
    resources: [{ resource: "TEST-R", description: "Resource", type: "rtLabor", unit: "cycles", components: [{ component: 1, unitCostCents: 3000n }, { component: 2, unitCostCents: 1000n }], evidence: "current SAP resource master; period history not proven" }],
    movements: [203, 204, 206].map((entry, index) => ({ resource: "TEST-R", order: String(index + 1), orderEntry: String(entry), producedItem: entry === 203 ? "TEST-A" : "TEST-B", itemDescription: "Test product", plannedQuantity: "1", completedQuantity: "1", quantityMicros: 1000000n, unit: "cycles", lineTotalCents: 4000n, direction: "ISSUE" as const, document: String(20 + index), docEntry: String(10 + index), lineId: "0", date: filter.start, sourceAccount: "" })),
    orders: [203, 204, 206].map((entry, index) => ({ entry: String(entry), number: String(index + 1), item: entry === 203 ? "TEST-A" : "TEST-B", itemDescription: "Test product", plannedQuantity: "1", completedQuantity: "1", unit: "UN" })),
    completeness: [], capturedAt: "2026-09-30T00:00:00.000Z"
  });
  const absorptionMapping = (modCriterion: Criterion = "DIRECT_COST", ggfCriterion: Criterion = "DIRECT_COST"): AbsorptionMapping => ({
    accounts: [{ account: "TEST-MOD", category: "MOD" }, { account: "TEST-GGF", category: "GGF" }],
    resources: [{ resource: "TEST-R", component: 1, category: "MOD" }, { resource: "TEST-R", component: 2, category: "GGF" }],
    technicalHomologation: true,
    distribution: {
      MOD: { criterion: modCriterion, orderNumbers: ["1", "2", "3"] },
      GGF: { criterion: ggfCriterion, orderNumbers: ["1", "2", "3"] }
    }
  });
  function preparedClient() {
    const f = fixture();
    f.rows.ChartOfAccounts!.push({ Code: "TEST-MOD", Name: "Test only" });
    f.rows.JournalEntries![0]!.JournalEntryLines.push({ Line_ID: 1, AccountCode: "TEST-MOD", Debit: 0, Credit: 10 });
    return f.client;
  }

  it("distributes MOD and GGF independently and preserves negative over-absorption", async () => {
    const source = absorptionData(), mapping = absorptionMapping();
    const report = reconcileAbsorption(source, mapping);
    const result = await calculateAbsorptionDistribution(preparedClient(), source, report, source.filter, mapping);
    expect(result.categories.map((row) => [row.category, row.differenceCents, row.allocatedCents, row.residualCents])).toEqual([
      ["MOD", -10000n, -10000n, 0n], ["GGF", 7000n, 7000n, 0n]
    ]);
    expect(result.orders.reduce((sum, row) => sum + row.modAdjustmentCents, 0n)).toBe(-10000n);
    expect(result.orders.reduce((sum, row) => sum + row.ggfAdjustmentCents, 0n)).toBe(7000n);
    expect(result.orders.every((row) => row.bases.some((base) => base.category === "MOD") && row.bases.some((base) => base.category === "GGF"))).toBe(true);
    expect(result.residualCents).toBe(0n);
  });

  it("blocks only the category without actual hours while direct cost remains calculable", async () => {
    const source = absorptionData(), mapping = absorptionMapping("HOURS", "DIRECT_COST");
    const result = await calculateAbsorptionDistribution(preparedClient(), source, reconcileAbsorption(source, mapping), source.filter, mapping);
    expect(result.categories[0]?.status).toBe("BLOCKED_BASIS");
    expect(result.categories[0]?.blocker).toContain("hours");
    expect(result.categories[1]?.status).toBe("CALCULATED_TECHNICAL");
    expect(result.residualCents).toBe(-10000n);
  });

  it("blocks QUANTITY for mixed products instead of summing unlike items", async () => {
    const source = absorptionData(), mapping = absorptionMapping("DIRECT_COST", "QUANTITY");
    const result = await calculateAbsorptionDistribution(preparedClient(), source, reconcileAbsorption(source, mapping), source.filter, mapping);
    expect(result.categories.find((row) => row.category === "GGF")?.status).toBe("BLOCKED_INCOMPATIBLE_BASIS");
    expect(result.categories.find((row) => row.category === "MOD")?.status).toBe("CALCULATED_TECHNICAL");
  });

  it("leaves a category blocked when no real account is configured", async () => {
    const source = absorptionData();
    const mapping = { ...absorptionMapping(), accounts: [{ account: "TEST-GGF", category: "GGF" as const }] };
    const result = await calculateAbsorptionDistribution(preparedClient(), source, reconcileAbsorption(source, mapping), source.filter, mapping);
    expect(result.categories.find((row) => row.category === "MOD")?.status).toBe("BLOCKED_NO_ACCOUNT");
    expect(result.categories.find((row) => row.category === "MOD")?.allocation).toBeUndefined();
  });
});
