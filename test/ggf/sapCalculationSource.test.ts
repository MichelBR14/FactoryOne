import { describe, expect, it } from "vitest";
import { SapGgfCalculationSource } from "../../webapp/modules/ggf/repository/SapGgfCalculationSource";
import { allocate } from "../../webapp/modules/ggf/engine/allocation";
import type { Configuration, Criterion } from "../../webapp/modules/ggf/engine/types";
import type { GgfReadClient } from "../../webapp/modules/ggf/repository/MappedGgfSource";
import { ClosingSession } from "../../webapp/modules/ggf/service/ClosingSession";
import { readFileSync } from "node:fs";

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
