import { describe, expect, it } from "vitest";
import { DevelopmentGgfRepository } from "../../webapp/modules/ggf/development/DevelopmentGgfRepository";
import { demoConfiguration } from "../../webapp/modules/ggf/development/fixtures";
import { allocate } from "../../webapp/modules/ggf/engine/allocation";
import type { SourceSnapshot } from "../../webapp/modules/ggf/engine/types";

async function snapshot() {
  return new DevelopmentGgfRepository({ getItem: () => null, setItem: () => {} }).loadSnapshot(
    { start: "2026-09-01", end: "2026-09-30", branch: "DEV-01", costCenter: "" },
    demoConfiguration
  );
}

describe("normalized source contract", () => {
  it.each([
    [
      "quantity unit",
      (s: SourceSnapshot) => {
        s.orders[0]!.basisEvidence.quantity!.unit = "kg";
      }
    ],
    [
      "quantity comparison",
      (s: SourceSnapshot) => {
        s.orders[0]!.basisEvidence.quantity!.comparisonKey = "different-products";
      }
    ],
    [
      "hours unit",
      (s: SourceSnapshot) => {
        s.orders[0]!.basisEvidence.hours!.unit = "min";
      }
    ],
    [
      "hours policy",
      (s: SourceSnapshot) => {
        s.orders[0]!.basisEvidence.hours!.comparisonKey = "different-resources";
      }
    ],
    [
      "cost policy",
      (s: SourceSnapshot) => {
        s.orders[0]!.basisEvidence.directCost!.comparisonKey = "different-components";
      }
    ],
    [
      "missing conversion",
      (s: SourceSnapshot) => {
        s.orders[0]!.basisEvidence.quantity!.normalizationRef = "";
      }
    ],
    [
      "wrong source dataset",
      (s: SourceSnapshot) => {
        s.orders[0]!.basisEvidence.hours!.readId = "DEV-balances";
      }
    ],
    [
      "missing source rows",
      (s: SourceSnapshot) => {
        s.orders[0]!.basisEvidence.directCost!.sourceRefs = [];
      }
    ],
    [
      "balance currency",
      (s: SourceSnapshot) => {
        s.balances[0]!.currency = "USD";
      }
    ],
    [
      "current cost currency",
      (s: SourceSnapshot) => {
        s.orders[0]!.basisEvidence.currentCost!.unit = "USD";
      }
    ],
    [
      "missing pages",
      (s: SourceSnapshot) => {
        s.evidence.reads[0]!.exhausted = false;
      }
    ],
    [
      "count mismatch",
      (s: SourceSnapshot) => {
        s.evidence.reads[0]!.expectedRows++;
      }
    ],
    [
      "missing count evidence",
      (s: SourceSnapshot) => {
        s.evidence.reads[0]!.reconciliationRef = "";
      }
    ],
    [
      "wrong scope",
      (s: SourceSnapshot) => {
        s.evidence.reads[0]!.filter.branch = "OTHER";
      }
    ],
    [
      "missing dataset",
      (s: SourceSnapshot) => {
        s.evidence.reads.pop();
      }
    ],
    [
      "omitted order after collection",
      (s: SourceSnapshot) => {
        s.orders.pop();
      }
    ],
    [
      "omitted balance after collection",
      (s: SourceSnapshot) => {
        s.balances.pop();
      }
    ],
    [
      "duplicate read",
      (s: SourceSnapshot) => {
        s.evidence.reads.push(s.evidence.reads[0]!);
      }
    ]
  ] as const)("rejects %s", async (_name, change) => {
    const data = await snapshot();
    change(data);
    expect(() => allocate(demoConfiguration, data)).toThrow("sourceEvidence");
  });
  it("requires evidence at runtime even when a caller bypasses the TypeScript contract", async () => {
    const data = await snapshot();
    Reflect.deleteProperty(data, "evidence");
    expect(() => allocate(demoConfiguration, data)).toThrow("sourceEvidence");
  });
  it("compares quantity units only when quantity is an active allocation criterion", async () => {
    const data = await snapshot();
    data.orders[0]!.basisEvidence.quantity!.unit = "kg";
    const config = structuredClone(demoConfiguration);
    config.accounts.find((a) => a.criterion === "QUANTITY")!.active = false;
    expect(allocate(config, data).total).toBe(340000n);
  });
  it("retains fictional source evidence in the result without asserting SAP validation", async () => {
    const result = allocate(demoConfiguration, await snapshot());
    expect(result.snapshot.origin).toBe("development");
    expect(
      result.snapshot.evidence.reads.every((r) => r.sourceRef.startsWith("development/"))
    ).toBe(true);
    expect(result.orders[0]!.order.basisEvidence.quantity!.unit).toBe("DEV-UNIT");
    expect(result.difference).toBe(0n);
  });
});
