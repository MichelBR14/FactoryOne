import { describe, expect, it } from "vitest";
import { buildAccountingPreview, type AccountingPreviewConfig, type AccountingPreviewLineInput } from "../../webapp/modules/ggf/service/AccountingPreview";
import { buildGgfPostingPlanDraft, canMarkGgfPostingPlanReady, calculateGgfPostingPlanHash, LocalGgfPostingPlanRepository, type GgfPostingPlan } from "../../webapp/modules/ggf/service/GgfPostingPlan";

const config: AccountingPreviewConfig = {
  transitoryGgfAccount: "T-GGF", transitoryModAccount: "T-MOD",
  closingGgfAccount: "C-GGF", closingModAccount: "C-MOD", cpvAccount: "CPV",
  inventoryAccounts: { "ITEM/01": "INV" }, cpvEligibleOperationKeys: ["DeliveryNotes:8/0"], requireDimensions: false
};

function lines(stockAccount = "INV"): AccountingPreviewLineInput[] {
  return [
    { closingId: null, version: null, orderNumber: "76", item: "ITEM", warehouse: "01", category: "GGF",
      accountOriginal: "EXP-GGF", criterion: "DIRECT_COST", quantity: "2", unit: "UN", amountCents: "6000",
      stockCents: "6000", consumedCents: "0", stockTraceStatus: "STOCK_REVALUATION_CANDIDATE", valuationMethod: "bis_FIFO",
      inventoryAccountFromSap: { account: stockAccount, origin: "SAP_VERIFIED_TEST", verified: true, refs: ["test"] },
      consumedOperationKey: null, sourceRefs: ["InventoryGenEntries(10)/0"] },
    { closingId: null, version: null, orderNumber: "77", item: "ITEM", warehouse: "01", category: "MOD",
      accountOriginal: "EXP-MOD", criterion: "DIRECT_COST", quantity: "1", unit: "UN", amountCents: "4000",
      stockCents: "0", consumedCents: "4000", stockTraceStatus: "STOCK_REVALUATION_CANDIDATE", valuationMethod: "bis_FIFO",
      consumedOperationKey: "DeliveryNotes:8/0", sourceRefs: ["DeliveryNotes(8)/0"] }
  ];
}

function preview(stockAccount = "INV", stockAmount = "6000") {
  const source = lines(stockAccount);
  source[0]!.amountCents = stockAmount;
  source[0]!.stockCents = stockAmount;
  return buildAccountingPreview({ MOD: "4000", GGF: stockAmount }, source, config);
}

function context() {
  return { closingId: "TECH-SBODEMOBR2-202609", companyDB: "SBODEMOBR2",
    periodStart: "2026-09-01", periodEnd: "2026-09-30", branch: "", dimensions: ["", "", "", "", ""],
    currency: "R$", currencySource: "CompanyService_GetAdminInfo.LocalCurrency", sourceCapturedAt: "2026-09-30T19:54:39Z" };
}

function draft(stockAccount = "INV", stockAmount = "6000") {
  const result = preview(stockAccount, stockAmount);
  return buildGgfPostingPlanDraft(result, { closingId: "TECH-SBODEMOBR2-202609", companyDB: "SBODEMOBR2",
    periodStart: "2026-09-01", periodEnd: "2026-09-30", branch: "", dimensions: ["", "", "", "", ""],
    currency: "R$", currencySource: "CompanyService_GetAdminInfo.LocalCurrency", sourceCapturedAt: "2026-09-30T19:54:39Z" });
}

async function hashAtVersionOne(value: ReturnType<typeof draft>) {
  return calculateGgfPostingPlanHash({ ...value, version: 1, createdAt: "2026-09-30T20:00:00.000Z", postingHash: "" } as GgfPostingPlan);
}

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe("GGF V2 persistent posting plan", () => {
  it("builds a validated fully eligible plan with three document families and no payload", async () => {
    const store = new MemoryStorage();
    const repository = new LocalGgfPostingPlanRepository(store, () => "2026-09-30T20:00:00.000Z");
    const plan = await repository.append(draft());
    expect(plan).toMatchObject({ version: 1, status: "VALIDATED", totalMod: "4000", totalGgf: "6000",
      totalStock: "6000", totalCpv: "4000", totalBlocked: "0", totalDifference: "0", postingBlocked: true });
    expect(plan.documents.map(document => document.type)).toEqual(["MaterialRevaluation", "JournalEntry.CPV", "JournalEntry.Closing"]);
    expect(plan.documents.every(document => document.payload === null && document.currency === "R$" )).toBe(true);
    expect(plan.documents[2]?.lines.flatMap(line => line.sourceOrderRefs)).toEqual(expect.arrayContaining(["76/ITEM/01/GGF", "77/ITEM/01/MOD"]));
    expect(canMarkGgfPostingPlanReady(plan)).toBe(true);
  });

  it("marks a plan blocked when any line or value remains blocked", async () => {
    const blocked = buildAccountingPreview({ MOD: "0", GGF: "250" }, [], config);
    const plan = await new LocalGgfPostingPlanRepository(new MemoryStorage()).append(buildGgfPostingPlanDraft(blocked, {
      closingId: "TECH-BLOCKED-202609", companyDB: "SBODEMOBR2", periodStart: "2026-09-01", periodEnd: "2026-09-30",
      branch: "", dimensions: [], currency: "R$", currencySource: "CompanyService_GetAdminInfo.LocalCurrency", sourceCapturedAt: "t"
    }));
    expect(plan.status).toBe("BLOCKED");
    expect(plan.blockers).toContain("BLOCKED_VALUE_REMAINS");
    expect(canMarkGgfPostingPlanReady(plan)).toBe(false);
    expect(plan.documents.every(document => document.status === "BLOCKED")).toBe(true);
    expect(plan.documents.every(document => document.payload === null)).toBe(true);
  });

  it("changes the posting hash when an amount changes", async () => {
    expect(await hashAtVersionOne(draft("INV", "6001"))).not.toBe(await hashAtVersionOne(draft()));
  });

  it("changes the posting hash when an account changes", async () => {
    expect(await hashAtVersionOne(draft("INV-ALT"))).not.toBe(await hashAtVersionOne(draft("INV")));
  });

  it("binds all future document request hashes into the posting plan", async () => {
    const plan = { ...draft(), version: 1, closingVersion: 4, createdAt: "2026-09-30T20:00:00.000Z",
      technicalRequestHashes: { MaterialRevaluation: "a".repeat(64), "JournalEntry.CPV": "b".repeat(64),
        "JournalEntry.Closing": "c".repeat(64) }, postingHash: "" } as GgfPostingPlan;
    const changed = { ...plan, technicalRequestHashes: { ...plan.technicalRequestHashes!, "JournalEntry.CPV": "d".repeat(64) } };
    expect(await calculateGgfPostingPlanHash(plan)).not.toBe(await calculateGgfPostingPlanHash(changed));
  });

  it("appends a new version and preserves the validated version", async () => {
    const repository = new LocalGgfPostingPlanRepository(new MemoryStorage());
    const first = await repository.append(draft());
    const second = await repository.append(draft("INV-ALT"));
    const versions = await repository.list(first.closingId);
    expect(versions.map(plan => plan.version)).toEqual([1, 2]);
    expect(versions[0]?.postingHash).toBe(first.postingHash);
    expect(versions[1]?.postingHash).toBe(second.postingHash);
  });

  it("blocks READY_TO_POST when totals diverge", async () => {
    const result = preview();
    const divergent = { ...result, totals: { ...result.totals, differenceCents: "1" } };
    const plan = await new LocalGgfPostingPlanRepository(new MemoryStorage()).append(buildGgfPostingPlanDraft(divergent, {
      closingId: "TECH-DIVERGENCE-202609", companyDB: "SBODEMOBR2", periodStart: "2026-09-01", periodEnd: "2026-09-30",
      branch: "", dimensions: [], currency: "R$", currencySource: "SAP", sourceCapturedAt: "t"
    }));
    expect(plan.status).toBe("BLOCKED");
    expect(plan.blockers).toContain("TOTAL_RECONCILIATION_DIFFERENCE");
    expect(canMarkGgfPostingPlanReady(plan)).toBe(false);
  });

  it("detects local plan content tampering on reread", async () => {
    const store = new MemoryStorage();
    const repository = new LocalGgfPostingPlanRepository(store);
    await repository.append(draft());
    const persisted = JSON.parse(store.getItem("factoryone.ggf.v2.posting-plans")!) as Array<Record<string, unknown>>;
    persisted[0]!.totalGgf = "9999";
    store.setItem("factoryone.ggf.v2.posting-plans", JSON.stringify(persisted));
    await expect(repository.list()).rejects.toThrow("integrity verification failed");
  });

  it("uses deterministic functional hashes and excludes timestamps", async () => {
    const repository = new LocalGgfPostingPlanRepository(new MemoryStorage(), () => "2026-09-30T20:00:00.000Z");
    const plan = await repository.append(draft());
    const hash = await calculateGgfPostingPlanHash({ ...plan, createdAt: "2030-01-01T00:00:00.000Z", sourceCapturedAt: "2030-01-01T00:00:00.000Z" });
    expect(hash).toBe(plan.postingHash);
  });
});
