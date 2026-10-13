import { describe, expect, it } from "vitest";
import { buildPhase7EOrderIds } from "../../webapp/modules/ggf/service/GgfPhase7EOrderId";

const CLOSING = "TECH7E-20261001-6D12027067";

describe("Phase 7E SAP OrderId", () => {
  it("keeps every ID within the 30-character SAP field limit", async () => {
    const ids = await buildPhase7EOrderIds("C".repeat(30));
    expect(Object.values(ids).every(id => id.length <= 30)).toBe(true);
  });

  it("is deterministic for the same ClosingId and distinct across different closings", async () => {
    expect(await buildPhase7EOrderIds(CLOSING)).toEqual(await buildPhase7EOrderIds(CLOSING));
    expect(await buildPhase7EOrderIds(CLOSING)).not.toEqual(await buildPhase7EOrderIds(`${CLOSING}-OTHER`));
  });

  it("keeps different documents collision-free even when their digest suffixes coincide", async () => {
    const ids = await buildPhase7EOrderIds(CLOSING, async () => "a".repeat(64));
    expect(new Set(Object.values(ids)).size).toBe(3);
  });

  it("generates three traceable IDs in financial-document sequence", async () => {
    const ids = await buildPhase7EOrderIds(CLOSING);
    expect(ids).toEqual(expect.objectContaining({
      MaterialRevaluation: expect.stringMatching(/^7E-MR-01-/),
      "JournalEntry.CPV": expect.stringMatching(/^7E-CPV-02-/),
      "JournalEntry.Closing": expect.stringMatching(/^7E-CLS-03-/)
    }));
    expect(new Set(Object.values(ids)).size).toBe(3);
  });
});
