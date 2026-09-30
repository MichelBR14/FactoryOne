import { describe, expect, it } from "vitest";
import {
  allocate,
  GgfError,
  validateConfiguration,
  validatePeriod
} from "../../webapp/modules/ggf/engine/allocation";
import type {
  Configuration,
  Criterion,
  OrderBasis,
  SourceSnapshot
} from "../../webapp/modules/ggf/engine/types";

function data(criterion: Criterion = "DIRECT_COST", amount = "100.01") {
  const config: Configuration = {
    classifications: [{ id: "C", name: "Custos" }],
    accounts: [{ account: "A", name: "Energia", classificationId: "C", criterion, active: true }],
    groupShares:
      criterion === "RESOURCE_GROUP"
        ? [
            { account: "A", group: "M", percent: "60" },
            { account: "A", group: "L", percent: "40" }
          ]
        : []
  };
  const snapshot: SourceSnapshot = {
    id: "TEST",
    origin: "development",
    capturedAt: "2026-09-26T12:00:00Z",
    filter: { start: "2026-09-01", end: "2026-09-30", branch: "", costCenter: "" },
    evidence: {
      currency: "BRL",
      reads: (["balances", "production", "currentCosts"] as const).map((dataset) => ({
        id: dataset,
        dataset,
        sourceRef: "unit-test-fixture",
        filter: { start: "2026-09-01", end: "2026-09-30", branch: "", costCenter: "" },
        pagesRead: 1,
        receivedRows: dataset === "balances" ? 1 : 2,
        expectedRows: dataset === "balances" ? 1 : 2,
        exhausted: true,
        reconciliationRef: "unit-test-count"
      }))
    },
    balances: [{ account: "A", amount, currency: "BRL", readId: "balances", sourceRefs: ["J1"] }],
    orders: [
      {
        id: "1",
        number: "1",
        item: "P1",
        directCost: "10.00",
        quantity: "1.5",
        hours: "4",
        groupHours: { M: "3", L: "1" },
        currentCost: "20.00",
        sourceRefs: ["M1"],
        basisEvidence: testBasisEvidence("M1")
      },
      {
        id: "2",
        number: "2",
        item: "P2",
        directCost: "30.00",
        quantity: "0.5",
        hours: "6",
        groupHours: { M: "1", L: "5" },
        currentCost: "40.00",
        sourceRefs: ["M2"],
        basisEvidence: testBasisEvidence("M2")
      }
    ]
  };
  return { config, snapshot };
}
function testBasisEvidence(ref: string): OrderBasis["basisEvidence"] {
  const basis = (unit: string, key: string, readId = "production") => ({
    unit,
    comparisonKey: key,
    normalizationRef: "unit-test-identity",
    readId,
    sourceRefs: [ref]
  });
  return {
    quantity: basis("UNIT", "quantity"),
    hours: basis("h", "hours"),
    directCost: basis("BRL", "directCost"),
    currentCost: basis("BRL", "currentCost", "currentCosts")
  };
}
function errorCode(work: () => unknown, code: string) {
  try {
    work();
    throw new Error("Expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(GgfError);
    expect((error as GgfError).code).toBe(code);
  }
}
describe("GGF allocation", () => {
  it.each([
    ["DIRECT_COST", [2500n, 7501n]],
    ["QUANTITY", [7501n, 2500n]],
    ["HOURS", [4000n, 6001n]],
    ["RESOURCE_GROUP", [5168n, 4833n]]
  ] as const)("allocates %s with independent expected amounts", (criterion, expected) => {
    const { config, snapshot } = data(criterion);
    const result = allocate(config, snapshot);
    expect(result.orders.map((o) => o.allocated)).toEqual(expected);
    expect(result.total).toBe(10001n);
    expect(result.difference).toBe(0n);
    expect(result.orders[0]!.resulting).toBe(2000n + expected[0]);
  });
  it("keeps group quotas and the within-group bases traceable", () => {
    const { config, snapshot } = data("RESOURCE_GROUP");
    const result = allocate(config, snapshot);
    const machinery = result.traces.filter((t) => t.group === "M");
    expect(machinery.map((t) => t.amount)).toEqual([4501n, 1500n]);
    expect(machinery[0]).toMatchObject({
      poolAmount: 6001n,
      percent: "60",
      basis: 3000000n,
      totalBasis: 4000000n
    });
    expect(result.traces.filter((t) => t.group === "L").map((t) => t.amount)).toEqual([
      667n,
      3333n
    ]);
  });
  it("handles signed balances symmetrically", () => {
    const { config, snapshot } = data("RESOURCE_GROUP", "-100.01");
    expect(allocate(config, snapshot).orders.map((o) => o.allocated)).toEqual([-5168n, -4833n]);
  });
  it("breaks fractional-cent ties by stable ID, independent of row order", () => {
    const { config, snapshot } = data("QUANTITY", "0.01");
    snapshot.orders.forEach((o) => (o.quantity = "1"));
    snapshot.orders.reverse();
    expect(allocate(config, snapshot).orders.map((o) => o.allocated)).toEqual([0n, 1n]);
  });
  it("reconciles multiple accounts including negative and inactive balances", () => {
    const { config, snapshot } = data();
    config.accounts.push(
      { ...config.accounts[0]!, account: "B", criterion: "HOURS" },
      { ...config.accounts[0]!, account: "C", active: false }
    );
    snapshot.balances.push({
      account: "B",
      amount: "-50.00",
      currency: "BRL",
      readId: "balances",
      sourceRefs: ["J2"]
    });
    snapshot.evidence.reads[0]!.receivedRows = snapshot.evidence.reads[0]!.expectedRows = 2;
    const result = allocate(config, snapshot);
    expect(result.total).toBe(5001n);
    expect(result.distributed).toBe(5001n);
    expect(result.criteria.find((c) => c.criterion === "HOURS")!.amount).toBe(-5000n);
  });
  it.each(CRITERIA_FOR_ZERO())("rejects empty %s basis even with zero balance", (criterion) => {
    const { config, snapshot } = data(criterion, "0.00");
    snapshot.orders = [];
    for (const read of snapshot.evidence.reads.filter((r) => r.dataset !== "balances"))
      read.receivedRows = read.expectedRows = 0;
    errorCode(() => allocate(config, snapshot), "zeroBasis");
  });
  it("rejects a positive-percent group with no hours without spreading its quota", () => {
    const { config, snapshot } = data("RESOURCE_GROUP");
    config.groupShares[0]!.group = "MISSING";
    errorCode(() => allocate(config, snapshot), "zeroBasis");
  });
  it("allows a zero-percent group with no hours", () => {
    const { config, snapshot } = data("RESOURCE_GROUP");
    config.groupShares = [
      { account: "A", group: "MISSING", percent: "0" },
      { account: "A", group: "M", percent: "100" }
    ];
    expect(allocate(config, snapshot).distributed).toBe(10001n);
  });
  it.each(["99.99", "100.01", "-1", "NaN", "", "60.001"])(
    "rejects invalid percentages %s",
    (percent) => {
      const { config, snapshot } = data("RESOURCE_GROUP");
      config.groupShares[0]!.percent = percent;
      expect(() => allocate(config, snapshot)).toThrow(GgfError);
    }
  );
  it("rejects missing balances", () => {
    const { config, snapshot } = data();
    snapshot.balances = [];
    snapshot.evidence.reads[0]!.receivedRows = snapshot.evidence.reads[0]!.expectedRows = 0;
    errorCode(() => allocate(config, snapshot), "missingBalance");
  });
  it.each(["", "-1", "1.001", "NaN"])("rejects invalid direct cost %s", (cost) => {
    const { config, snapshot } = data();
    snapshot.orders[0]!.directCost = cost;
    errorCode(() => allocate(config, snapshot), "decimal");
  });
  it("rejects inconsistent group hours", () => {
    const { config, snapshot } = data();
    snapshot.orders[0]!.hours = "5";
    errorCode(() => allocate(config, snapshot), "groupHours");
  });
  it("rejects duplicate orders and balances", () => {
    const { config, snapshot } = data();
    snapshot.orders.push(snapshot.orders[0]!);
    errorCode(() => allocate(config, snapshot), "duplicate");
    snapshot.orders.pop();
    snapshot.balances.push(snapshot.balances[0]!);
    errorCode(() => allocate(config, snapshot), "duplicate");
  });
  it("rejects duplicate accounts, missing classifications and orphan shares", () => {
    const { config } = data();
    config.accounts.push({ ...config.accounts[0]! });
    errorCode(() => validateConfiguration(config), "duplicate");
    config.accounts.pop();
    config.classifications = [];
    errorCode(() => validateConfiguration(config), "classification");
    config.classifications = [{ id: "C", name: "Custos" }];
    config.groupShares = [{ account: "OTHER", group: "M", percent: "100" }];
    errorCode(() => validateConfiguration(config), "account");
  });
  it("does not mutate inputs and keeps the result snapshot independent", () => {
    const { config, snapshot } = data();
    const before = JSON.stringify({ config, snapshot });
    const result = allocate(config, snapshot);
    expect(JSON.stringify({ config, snapshot })).toBe(before);
    config.accounts[0]!.name = "changed";
    expect(result.configuration.accounts[0]!.name).toBe("Energia");
  });
  it("reconciles fractional quantities and large balances beyond Number precision", () => {
    const { config, snapshot } = data("QUANTITY", "9007199254740993.01");
    snapshot.orders[0]!.quantity = "0.000001";
    snapshot.orders[1]!.quantity = "0.000003";
    const result = allocate(config, snapshot);
    expect(result.distributed).toBe(900719925474099301n);
  });
  it.each([
    ["2026-02-30", "2026-03-01"],
    ["2026-09-30", "2026-09-01"],
    ["", "2026-09-30"]
  ])("rejects invalid periods %s %s", (start, end) => {
    errorCode(() => validatePeriod({ start, end, branch: "", costCenter: "" }), "date");
  });
});
function CRITERIA_FOR_ZERO(): Criterion[] {
  return ["DIRECT_COST", "QUANTITY", "HOURS", "RESOURCE_GROUP"];
}
