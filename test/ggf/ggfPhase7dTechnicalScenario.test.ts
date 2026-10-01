import { describe, expect, it } from "vitest";
import { assertClosingConsistency, closingSapDocument, postingHash, type GgfClosing } from
  "../../webapp/modules/ggf/service/GgfClosing";
import { buildGgfPhase7DClosingBasis, buildGgfPhase7DJournalEntry, buildGgfPhase7DPostingPlan } from
  "../../webapp/modules/ggf/service/GgfPhase7DTechnicalScenario";

describe("Phase 7D isolated closing technical scenario", () => {
  it("builds the exact balanced R$ 1.00 entry with distinct GGF/MOD credits and no dimensions", async () => {
    const closingId = "TECH7D-20261001-ABCDEF0123";
    const plan = await buildGgfPhase7DPostingPlan({ closingId, at: "2026-10-01T15:00:00Z" });
    const payload = buildGgfPhase7DJournalEntry(closingId);
    expect(plan).toMatchObject({ technicalOnly: true, status: "VALIDATED", totalGgf: "60", totalMod: "40",
      totalStock: "0", totalCpv: "0", totalBlocked: "0", branch: "1", currency: "R$" });
    expect(plan.documents).toHaveLength(1);
    expect(plan.documents[0]).toMatchObject({ type: "JournalEntry.Closing", totalCents: "100", status: "VALIDATED" });
    expect(plan.documents[0]?.lines.map(line => [line.debitAccount, line.creditAccount, line.amountCents])).toEqual([
      ["5.04.01.01.05", "5.04.01.01.03", "60"],
      ["5.04.01.01.05", "5.04.01.01.04", "40"]
    ]);
    const lines = payload.JournalEntryLines as Array<Record<string, unknown>>;
    expect(lines.map(line => [line.AccountCode, line.Debit, line.Credit, line.BPLID])).toEqual([
      ["5.04.01.01.05", 1, 0, 1], ["5.04.01.01.03", 0, 0.6, 1], ["5.04.01.01.04", 0, 0.4, 1]
    ]);
    expect(lines.reduce((sum, line) => sum + Number(line.Debit), 0)).toBe(1);
    expect(lines.reduce((sum, line) => sum + Number(line.Credit), 0)).toBe(1);
    expect(lines.every(line => !["ProjectCode","CostingCode","CostingCode2","CostingCode3","CostingCode4","CostingCode5"]
      .some(key => key in line))).toBe(true);
  });

  it("keeps a posted closing JE linked and integrity-checkable", async () => {
    const closingId = "TECH7D-20261001-ABCDEF0123";
    const plan = await buildGgfPhase7DPostingPlan({ closingId, at: "2026-10-01T15:00:00Z" });
    const payload = buildGgfPhase7DJournalEntry(closingId);
    const basis = buildGgfPhase7DClosingBasis({ closingId, plan, payload });
    const closing: GgfClosing = { closingId, companyDB: "SBODEMOBR2", periodStart: "2026-10-01",
      periodEnd: "2026-10-01", branch: "1", dimensions: {}, status: "POSTED", version: 6, lineVersion: 2,
      createdAt: "2026-10-01T15:00:00Z", createdBy: "tester", calculatedAt: "2026-10-01T15:00:00Z",
      postedAt: "2026-10-01T15:01:00Z", totalGgf: "1.00", totalAllocated: "1.00", totalRevalued: "0.00",
      sapMaterialRevaluationDocEntry: null, sapMaterialRevaluationDocNum: null, sapJournalEntryDocEntry: 2308,
      sapJournalEntryDocNum: 1930, sapJournalTransId: 2308, postingHash: await postingHash(basis),
      reopenedFrom: null, cancelledAt: null, notes: "Phase 7D test", lastError: null,
      postingBasis: basis, proposedPayload: payload, lines: basis.lines };
    await assertClosingConsistency(closing);
    expect(closingSapDocument(closing)).toEqual({ docEntry: 2308, docNum: 1930, transId: 2308 });
  });
});
