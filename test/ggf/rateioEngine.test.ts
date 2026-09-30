import { describe, expect, it } from "vitest";
import { allocate, GgfError } from "../../webapp/modules/ggf/engine/allocation";
import { DevelopmentGgfRepository } from "../../webapp/modules/ggf/development/DevelopmentGgfRepository";
import { demoConfiguration } from "../../webapp/modules/ggf/development/fixtures";
import { exportCsv } from "../../webapp/modules/ggf/service/export";
import type { Configuration, Criterion, OrderBasis } from "../../webapp/modules/ggf/engine/types";

async function scenario(criterion: Criterion = "DIRECT_COST") {
  const configuration = structuredClone(demoConfiguration);
  configuration.accounts.forEach((a) => {
    a.active = a.criterion === criterion;
    a.percent = "100";
  });
  const source = new DevelopmentGgfRepository({ getItem: () => null, setItem: () => {} });
  const snapshot = await source.loadSnapshot(
    { start: "2026-09-01", end: "2026-09-30", branch: "DEV-01", costCenter: "" },
    configuration
  );
  return { configuration, snapshot };
}
function unavailable(o: OrderBasis, key: "hours" | "currentCost" | "quantity") {
  o[key] = null;
  o.basisEvidence[key] = null;
  o.unavailable = { ...o.unavailable, [key]: "No verified source" };
  if (key === "hours") o.groupHours = {};
}
describe("four criteria with account applicability and traceable bases", () => {
  it.each(["DIRECT_COST", "QUANTITY", "HOURS", "RESOURCE_GROUP"] as const)(
    "reconciles %s independently",
    async (criterion) => {
      const { configuration, snapshot } = await scenario(criterion);
      const r = allocate(configuration, snapshot);
      expect(r.accounts[0]!.difference).toBe(0n);
      expect(r.total).toBe(r.distributed);
      expect(r.traces.every((t) => t.participationPercent && t.basisUnit)).toBe(true);
    }
  );
  it("applies each account percentage before distributing and keeps original balance", async () => {
    const { configuration, snapshot } = await scenario();
    configuration.accounts[0]!.percent = "25";
    const r = allocate(configuration, snapshot);
    expect(r.accounts[0]).toMatchObject({
      periodAmount: 100000n,
      applicableAmount: 25000n,
      distributed: 25000n,
      difference: 0n
    });
    expect(r.orders.map((o) => o.allocated)).toEqual([4167n, 8333n, 12500n]);
    expect(r.traces[0]).toMatchObject({
      accountAmount: 100000n,
      accountPercent: "25",
      applicableAmount: 25000n
    });
  });
  it("does not turn an explicitly null percentage into legacy100", async () => {
    const { configuration, snapshot } = await scenario();
    Object.assign(configuration.accounts[0]!, { percent: null });
    expect(() => allocate(configuration, snapshot)).toThrow("decimal");
  });
  it.each(["100.01", "-1", "1.001", ""])("blocks invalid account percent %s", async (percent) => {
    const { configuration, snapshot } = await scenario();
    configuration.accounts[0]!.percent = percent;
    expect(() => allocate(configuration, snapshot)).toThrow(GgfError);
  });
  it.each(["0.01", "-0.01"])("records applicability half-cent rounding for %s", async (amount) => {
    const { configuration, snapshot } = await scenario();
    configuration.accounts[0]!.percent = "50";
    snapshot.balances[0]!.amount = amount;
    const r = allocate(configuration, snapshot);
    expect(r.accounts[0]!.roundingNumerator).toBe(amount.startsWith("-") ? -5000n : 5000n);
    expect(r.total).toBe(amount.startsWith("-") ? -1n : 1n);
  });
  it("splits ENVASE20/USINAGEM80 then only among related OPs by verified resource use", async () => {
    const { configuration, snapshot } = await scenario("RESOURCE_GROUP");
    const account = configuration.accounts.find((a) => a.active)!.account;
    configuration.groupShares = [
      { account, group: "ENVASE", percent: "20", basis: "RESOURCE_QUANTITY" },
      { account, group: "USINAGEM", percent: "80", basis: "RESOURCE_QUANTITY" }
    ];
    snapshot.balances[0]!.amount = "10000.00";
    snapshot.orders.forEach((o, i) => {
      unavailable(o, "hours");
      o.resourceBases = {};
      for (const [g, n] of i === 0
        ? [["ENVASE", "1"]]
        : i === 1
          ? [
              ["ENVASE", "3"],
              ["USINAGEM", "1"]
            ]
          : [["USINAGEM", "3"]])
        o.resourceBases[g!] = {
          RESOURCE_QUANTITY: {
            value: n!,
            resourceRefs: [`DEV-${g}`],
            evidence: { ...o.basisEvidence.quantity!, unit: `DEV-${g}-UNIT`, comparisonKey: g! }
          }
        };
    });
    const r = allocate(configuration, snapshot);
    expect(r.orders.map((o) => o.allocated)).toEqual([50000n, 350000n, 600000n]);
    expect(r.traces).toHaveLength(4);
    expect(r.traces.find((t) => t.group === "ENVASE")!.poolAmount).toBe(200000n);
    expect(r.traces.find((t) => t.group === "USINAGEM")!.poolAmount).toBe(800000n);
  });
  it("resource value is a separate selectable base, not presumed hours", async () => {
    const { configuration, snapshot } = await scenario("RESOURCE_GROUP");
    configuration.groupShares.forEach((g) => (g.basis = "RESOURCE_VALUE"));
    snapshot.orders.forEach((o) => unavailable(o, "hours"));
    const r = allocate(configuration, snapshot);
    expect(r.traces.every((t) => t.basisKind === "RESOURCE_VALUE" && t.basisUnit === "BRL")).toBe(
      true
    );
    expect(r.difference).toBe(0n);
  });
  it("zero-percent hour group does not require an unused unavailable time basis", async () => {
    const { configuration, snapshot } = await scenario("RESOURCE_GROUP");
    configuration.groupShares[0]!.percent = "0";
    configuration.groupShares[1]!.percent = "100";
    configuration.groupShares[1]!.basis = "RESOURCE_VALUE";
    snapshot.orders.forEach((o) => unavailable(o, "hours"));
    expect(allocate(configuration, snapshot).difference).toBe(0n);
  });
  it("accepts an explicit comparable normalized quantity contract", async () => {
    const { configuration, snapshot } = await scenario("QUANTITY");
    snapshot.orders.forEach((o, i) => {
      o.quantity = ["0.5", "1", "1.5"][i]!;
      o.basisEvidence.quantity = {
        ...o.basisEvidence.quantity!,
        unit: "kg",
        comparisonKey: "TEST-equivalent-mass-v1",
        normalizationRef:
          "controlled-fixture: 100/200/300 grams converted and scaled by explicit factor5"
      };
    });
    expect(allocate(configuration, snapshot).orders.map((o) => o.allocated)).toEqual([
      10000n,
      20000n,
      30000n
    ]);
  });
  it("missing internal quantity blocks even if group value exists", async () => {
    const { configuration, snapshot } = await scenario("RESOURCE_GROUP");
    configuration.groupShares.forEach((g) => (g.basis = "RESOURCE_QUANTITY"));
    delete snapshot.orders[0]!.resourceBases!.MAQUINA!.RESOURCE_QUANTITY;
    expect(() => allocate(configuration, snapshot)).toThrow("basisUnavailable");
  });
  it("zero OP basis receives zero but a missing eligible OP basis blocks", async () => {
    const { configuration, snapshot } = await scenario("QUANTITY");
    snapshot.orders[0]!.quantity = "0";
    expect(allocate(configuration, snapshot).orders[0]!.allocated).toBe(0n);
    unavailable(snapshot.orders[0]!, "quantity");
    expect(() => allocate(configuration, snapshot)).toThrow("basisUnavailable");
  });
  it("rejects total-zero basis and group without eligible OP", async () => {
    const { configuration, snapshot } = await scenario("QUANTITY");
    snapshot.orders.forEach((o) => (o.quantity = "0"));
    expect(() => allocate(configuration, snapshot)).toThrow("zeroBasis");
    const g = await scenario("RESOURCE_GROUP");
    g.configuration.groupShares[0]!.group = "ABSENT";
    g.configuration.groupShares.forEach((s) => (s.basis = "RESOURCE_VALUE"));
    expect(() => allocate(g.configuration, g.snapshot)).toThrow("zeroBasis");
  });
  it.each(["19.99", "20.01"])("blocks group sum other than100 (%s/80)", async (percent) => {
    const { configuration, snapshot } = await scenario("RESOURCE_GROUP");
    configuration.groupShares[0]!.percent = percent;
    configuration.groupShares[1]!.percent = "80";
    expect(() => allocate(configuration, snapshot)).toThrow("percentage");
  });
  it("hours cannot fall back to consumption quantities or capacity", async () => {
    const { configuration, snapshot } = await scenario("HOURS");
    snapshot.orders.forEach((o) => unavailable(o, "hours"));
    expect(() => allocate(configuration, snapshot)).toThrow("basisUnavailable");
  });
  it("calculates quantity without fabricating hours or current stock cost", async () => {
    const { configuration, snapshot } = await scenario("QUANTITY");
    snapshot.orders.forEach((o) => {
      unavailable(o, "hours");
      unavailable(o, "currentCost");
    });
    snapshot.evidence.reads = snapshot.evidence.reads.filter((r) => r.dataset !== "currentCosts");
    const result = allocate(configuration, snapshot);
    expect(result.orders.every((o) => o.current === null && o.resulting === null)).toBe(true);
    expect(exportCsv(result)).toContain("UNAVAILABLE");
  });
  it("rejects incompatible units or same units with different product equivalence", async () => {
    const { configuration, snapshot } = await scenario("QUANTITY");
    snapshot.orders[0]!.basisEvidence.quantity!.unit = "kg";
    expect(() => allocate(configuration, snapshot)).toThrow("sourceEvidence");
    snapshot.orders[0]!.basisEvidence.quantity!.unit = "DEV-UNIT";
    snapshot.orders[0]!.basisEvidence.quantity!.comparisonKey = "other-product";
    expect(() => allocate(configuration, snapshot)).toThrow("sourceEvidence");
  });
  it("retains direct cost components and rejects mismatched composition", async () => {
    const { configuration, snapshot } = await scenario();
    expect(allocate(configuration, snapshot).orders[0]!.order.directCostComponents).toHaveLength(2);
    snapshot.orders[0]!.directCostComponents![0]!.amount = "1.00";
    expect(() => allocate(configuration, snapshot)).toThrow("sourceEvidence");
  });
  it("reconciles multiple criteria and account percentages separately", async () => {
    const configuration: Configuration = structuredClone(demoConfiguration);
    configuration.accounts.forEach((a, i) => (a.percent = ["50", "25", "10", "80"][i]!));
    const snapshot = await new DevelopmentGgfRepository({
      getItem: () => null,
      setItem: () => {}
    }).loadSnapshot(
      { start: "2026-09-01", end: "2026-09-30", branch: "DEV-01", costCenter: "" },
      configuration
    );
    const r = allocate(configuration, snapshot);
    expect(r.accounts.map((a) => a.applicableAmount)).toEqual([50000n, 15000n, 9000n, 120000n]);
    expect(r.total).toBe(194000n);
    expect(r.accounts.every((a) => a.difference === 0n)).toBe(true);
    expect(exportCsv(r)).toContain("participationPercent");
    expect(exportCsv(r)).toContain("componentAmount");
  });
});
