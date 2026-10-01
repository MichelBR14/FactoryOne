import { describe, expect, it } from "vitest";
import { assertClosingConsistency, closingSapDocument, postingHash, type GgfClosing } from "../../webapp/modules/ggf/service/GgfClosing";
import { inspectClosingIntegrity } from "../../webapp/modules/ggf/service/GgfClosingIntegrity";
import { buildGgfPhase7CClosingBasis, buildGgfPhase7CJournalEntry, buildGgfPhase7CPostingPlan } from
  "../../webapp/modules/ggf/service/GgfPhase7CTechnicalScenario";

describe("Phase 7C isolated CPV technical scenario", () => {
  it("builds one balanced BRL-local-currency CPV Journal Entry with no invented dimensions", async () => {
    const closingId = "TECH7C-20261001-AB12CD34EF";
    const plan = await buildGgfPhase7CPostingPlan({ closingId, at: "2026-10-01T13:00:00Z", createdBy: "tester" });
    const payload = buildGgfPhase7CJournalEntry(closingId);
    expect(plan).toMatchObject({ technicalOnly: true, status: "VALIDATED", totalCpv: "100",
      totalStock: "0", totalBlocked: "0", branch: "1", currency: "R$" });
    expect(plan.documents).toHaveLength(1);
    expect(plan.documents[0]).toMatchObject({ type: "JournalEntry.CPV", totalCents: "100", status: "VALIDATED" });
    expect(plan.documents[0]?.lines[0]).toMatchObject({ debitAccount: "5.01.01.01.01",
      creditAccount: "5.04.01.01.05", amountCents: "100", dimensions: [] });
    const lines = payload.JournalEntryLines as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(2);
    expect(lines.reduce((sum, line) => sum + Number(line.Debit), 0) * 100).toBe(100);
    expect(lines.reduce((sum, line) => sum + Number(line.Credit), 0) * 100).toBe(100);
    expect(lines.every(line => line.BPLID === 1 && !("CostingCode" in line) && !("ProjectCode" in line))).toBe(true);
    expect(payload.Memo).toBe("HOMOLOGAÇÃO TÉCNICA FACTORYONE GGF");
  });

  it("binds a posted Journal Entry closing through its explicit document type and separate plan hash", async () => {
    const closingId = "TECH7C-20261001-AB12CD34EF";
    const plan = await buildGgfPhase7CPostingPlan({ closingId, at: "2026-10-01T13:00:00Z", createdBy: "tester" });
    const payload = buildGgfPhase7CJournalEntry(closingId);
    const basis = buildGgfPhase7CClosingBasis({ closingId, plan, payload });
    const closing: GgfClosing = { closingId, companyDB: "SBODEMOBR2", periodStart: "2026-10-01",
      periodEnd: "2026-10-01", branch: "1", dimensions: {}, status: "POSTED", version: 4, lineVersion: 2,
      createdAt: "2026-10-01T13:00:00Z", createdBy: "tester", calculatedAt: "2026-10-01T13:00:00Z",
      postedAt: "2026-10-01T13:01:00Z", totalGgf: "1.00", totalAllocated: "1.00", totalRevalued: "0.00",
      sapMaterialRevaluationDocEntry: null, sapMaterialRevaluationDocNum: null, sapJournalEntryDocEntry: 81,
      sapJournalEntryDocNum: 2301, sapJournalTransId: 81, postingHash: await postingHash(basis),
      reopenedFrom: null, cancelledAt: null, notes: "HOMOLOGAÇÃO TÉCNICA FACTORYONE GGF", lastError: null,
      postingBasis: basis, proposedPayload: payload, lines: basis.lines };

    await assertClosingConsistency(closing);
    expect(closingSapDocument(closing)).toEqual({ docEntry: 81, docNum: 2301, transId: 81 });
    const integrity = await inspectClosingIntegrity(closing,
      { hash: plan.postingHash, version: 2 }, { now: () => "2026-10-01T13:02:00Z" });
    expect(integrity).toMatchObject({ status: "VALID", sapDocumentType: "JournalEntry.CPV",
      sapDocEntry: 81, sapDocNum: 2301, sapTransId: 81, divergentFields: [] });
  });
});
