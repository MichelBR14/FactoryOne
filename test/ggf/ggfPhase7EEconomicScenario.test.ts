import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { assertPhase7EGatewayContract, allocateCentsByWeights, buildPhase7EEconomicScenario } from
  "../../webapp/modules/ggf/service/GgfPhase7EEconomicScenario";

const closingId = "TECH7E-20261001-0123456789";

beforeAll(() => vi.stubGlobal("crypto", webcrypto));

describe("Phase 7E.1 economic scenario (offline only)", () => {
  it("reconciles TotalAdjustment as stock plus consumed, without counting Closing twice", async () => {
    const scenario = await buildPhase7EEconomicScenario({ closingId });
    expect(BigInt(scenario.stockAdjustmentCents) + BigInt(scenario.consumedAdjustmentCents))
      .toBe(BigInt(scenario.totalAdjustmentCents));
    expect(scenario.documents.map(document => [document.type, document.amountCents])).toEqual([
      ["MaterialRevaluation", "100"], ["JournalEntry.CPV", "100"], ["JournalEntry.Closing", "200"]
    ]);
    const economicDestination = scenario.documents.slice(0, 2)
      .reduce((sum, document) => sum + BigInt(document.amountCents), 0n);
    expect(economicDestination).toBe(200n);
    expect(scenario.totalAdjustmentCents).toBe("200");
    await expect(assertPhase7EGatewayContract(scenario)).resolves.toBeUndefined();
  });

  it("preserves GGF/MOD composition and closes both clearing accounts", async () => {
    const scenario = await buildPhase7EEconomicScenario({ closingId });
    expect(scenario.composition).toEqual({ ggfCents: "120", modCents: "80", ggfStockCents: "60", modStockCents: "40" });
    const close = scenario.documents[2]!;
    expect(close.effects.filter(line => line.account === "5.04.01.01.03").map(line => line.creditCents)).toEqual(["120"]);
    expect(close.effects.filter(line => line.account === "5.04.01.01.04").map(line => line.creditCents)).toEqual(["80"]);
    expect(scenario.ledger.find(row => row.account === "5.04.01.01.05")?.finalCents).toBe("0");
    expect(scenario.ledger.find(row => row.account === "5.03.01.01.04")?.finalCents).toBe("0");
    expect(scenario.ledger.find(row => row.account === "1.01.02.01.01")?.finalCents).toBe("100");
    expect(scenario.ledger.find(row => row.account === "5.01.01.01.01")?.finalCents).toBe("100");
  });

  it("balances every document and rejects a missing or divergent document", async () => {
    const scenario = await buildPhase7EEconomicScenario({ closingId });
    for (const document of scenario.documents) {
      const debit = document.effects.reduce((sum, line) => sum + BigInt(line.debitCents), 0n);
      const credit = document.effects.reduce((sum, line) => sum + BigInt(line.creditCents), 0n);
      expect(debit).toBe(credit);
    }
    await expect(assertPhase7EGatewayContract({ ...scenario,
      documents: scenario.documents.slice(0, 2) as unknown as typeof scenario.documents }))
      .rejects.toThrow("exactly one document");
    const altered = structuredClone(scenario);
    altered.documents[1].amountCents = "99";
    await expect(assertPhase7EGatewayContract(altered)).rejects.toThrow("value differs");
  });

  it("supports negative adjustments by reversing entries without leaving transit balances", async () => {
    const scenario = await buildPhase7EEconomicScenario({ closingId, totalAdjustmentCents: "-200",
      stockAdjustmentCents: "-100", consumedAdjustmentCents: "-100", ggfCents: "-120", modCents: "-80",
      ggfStockCents: "-60", modStockCents: "-40", proposedUnitPriceCents: "1180" });
    expect(scenario.documents[0]!.effects.find(line => line.account === "1.01.02.01.01")?.creditCents).toBe("100");
    expect(scenario.documents[1]!.effects.find(line => line.account === "5.01.01.01.01")?.creditCents).toBe("100");
    expect(scenario.documents[2]!.effects.find(line => line.account === "5.04.01.01.03")?.debitCents).toBe("120");
    expect(scenario.ledger.find(row => row.account === "5.04.01.01.05")?.finalCents).toBe("0");
    await expect(assertPhase7EGatewayContract(scenario)).rejects.toThrow("gateway scope");
  });

  it("allocates cent residuals deterministically for positive and negative values", () => {
    expect(allocateCentsByWeights("1", { GGF: 1, MOD: 1 })).toEqual({ GGF: "1", MOD: "0" });
    expect(allocateCentsByWeights("-1", { GGF: 1, MOD: 1 })).toEqual({ GGF: "-1", MOD: "0" });
    expect(Object.values(allocateCentsByWeights("200", { GGF: 60, MOD: 40 }))
      .reduce((sum, value) => sum + BigInt(value), 0n)).toBe(200n);
  });

  it("rejects a RequestHash mismatch and any change outside the future gateway allowlist", async () => {
    const scenario = await buildPhase7EEconomicScenario({ closingId });
    const badHash = structuredClone(scenario);
    badHash.documents[0].requestHash = "0".repeat(64);
    await expect(assertPhase7EGatewayContract(badHash)).rejects.toThrow("RequestHash");
    const wrongLayer = structuredClone(scenario);
    wrongLayer.fifoLayer.transactionSequenceNum = 2789;
    await expect(assertPhase7EGatewayContract(wrongLayer)).rejects.toThrow("gateway scope");
    const wrongBranch = structuredClone(scenario);
    wrongBranch.documents[1].effects[0]!.branch = 2 as 1;
    await expect(assertPhase7EGatewayContract(wrongBranch)).rejects.toThrow("account or branch");
  });

  it("rejects an adjustment that cannot be represented exactly by the approved FIFO layer", async () => {
    await expect(buildPhase7EEconomicScenario({ closingId, stockAdjustmentCents: "99" }))
      .rejects.toThrow("totals, category split or FIFO layer value diverge");
    await expect(buildPhase7EEconomicScenario({ closingId, stockAdjustmentCents: "100.0" }))
      .rejects.toThrow("integer cents");
  });
});
