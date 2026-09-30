import { describe, expect, it } from "vitest";
import { splitStockAndConsumed } from "../../webapp/modules/ggf/service/StockConsumptionSplit";

const input = (overrides: Record<string, unknown> = {}) => ({
  valuationMethod: "bis_FIFO", proof: "FIFO_LAYER_RECONCILED" as const,
  producedQuantity: "10", consumedQuantity: "6", remainingQuantity: "4",
  unit: "UN", warehouse: "01", modAdjustmentCents: "333", ggfAdjustmentCents: "10000",
  ...overrides
});

describe("V2 stock and consumed split", () => {
  it("splits a partially consumed FIFO receipt and keeps residual cents", () => {
    const result = splitStockAndConsumed(input());
    expect(result).toMatchObject({ status: "STOCK_REVALUATION_CANDIDATE", totalStockCents: "4133", totalConsumedCents: "6200" });
    expect(BigInt(result.modStockCents!) + BigInt(result.modConsumedCents!)).toBe(333n);
    expect(BigInt(result.ggfStockCents!) + BigInt(result.ggfConsumedCents!)).toBe(10000n);
    expect(result.payload).toBeNull();
  });

  it("handles fully available and fully consumed production", () => {
    expect(splitStockAndConsumed(input({ consumedQuantity: "0", remainingQuantity: "10" })).status)
      .toBe("STOCK_REVALUATION_CANDIDATE");
    expect(splitStockAndConsumed(input({ consumedQuantity: "10", remainingQuantity: "0", consumedDisposition: "CPV_ELIGIBLE" })))
      .toMatchObject({ status: "CPV_ADJUSTMENT_CANDIDATE", totalStockCents: "0", totalConsumedCents: "10333" });
    expect(splitStockAndConsumed(input({ consumedQuantity: "10", remainingQuantity: "0" })).status)
      .toBe("CONSUMPTION_UNCLASSIFIED");
  });

  it("preserves sign and exact cents for a negative absorption difference", () => {
    const result = splitStockAndConsumed(input({ modAdjustmentCents: "-1", ggfAdjustmentCents: "-10001" }));
    expect(BigInt(result.modStockCents!) + BigInt(result.modConsumedCents!)).toBe(-1n);
    expect(BigInt(result.ggfStockCents!) + BigInt(result.ggfConsumedCents!)).toBe(-10001n);
  });

  it.each([
    ["negative stock", { negativeStock: true }, "BLOCKED_STOCK_NEGATIVE"],
    ["zero production", { producedQuantity: "0", consumedQuantity: "0", remainingQuantity: "0" }, "BLOCKED_ZERO_PRODUCTION"],
    ["quantity divergence", { consumedQuantity: "5", remainingQuantity: "4" }, "BLOCKED_QUANTITY_DIVERGENCE"],
    ["ambiguous multiple receipts", { proof: "AMBIGUOUS" }, "BLOCKED_AMBIGUOUS_TRACE"],
    ["ambiguous outflows", { proof: "AMBIGUOUS" }, "BLOCKED_AMBIGUOUS_TRACE"],
    ["ambiguous warehouses", { proof: "AMBIGUOUS" }, "BLOCKED_AMBIGUOUS_TRACE"],
    ["moving average", { valuationMethod: "bis_MovingAverage", proof: "MOVEMENT_RECONCILED" }, "BLOCKED_METHOD_NOT_HOMOLOGATED"],
    ["standard cost", { valuationMethod: "bis_Standard" }, "BLOCKED_METHOD_NOT_HOMOLOGATED"],
    ["FIFO without a reconciled layer", { proof: "MOVEMENT_RECONCILED" }, "BLOCKED_METHOD_NOT_HOMOLOGATED"]
  ] as const)("blocks %s", (_label, overrides, status) => {
    expect(splitStockAndConsumed(input(overrides)).status).toBe(status);
  });

  it("does not treat an unclassified issue as CPV", () => {
    const result = splitStockAndConsumed(input({ proof: "AMBIGUOUS", consumedQuantity: "10", remainingQuantity: "0" }));
    expect(result.status).toBe("BLOCKED_AMBIGUOUS_TRACE");
    expect(result.totalConsumedCents).toBeNull();
  });

  it("marks a consumed split as CPV candidate only after explicit operation classification", () => {
    const result = splitStockAndConsumed(input({ consumedDisposition: "CPV_ELIGIBLE" }));
    expect(result.consumedStatus).toBe("CPV_ADJUSTMENT_CANDIDATE");
  });
});
