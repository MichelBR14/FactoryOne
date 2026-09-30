import { describe, expect, it } from "vitest";
import { buildAccountingPreview, type AccountingPreviewConfig, type AccountingPreviewLineInput } from "../../webapp/modules/ggf/service/AccountingPreview";

const config: AccountingPreviewConfig = {
  transitoryGgfAccount: "TRANS-GGF", transitoryModAccount: "TRANS-MOD",
  closingGgfAccount: "CLOSE-GGF", closingModAccount: "CLOSE-MOD", cpvAccount: "CPV",
  inventoryAccounts: { "ITEM/01": "INV" }, cpvEligibleOperationKeys: ["DeliveryNotes:12/0"], requireDimensions: false
};

function line(overrides: Partial<AccountingPreviewLineInput> = {}): AccountingPreviewLineInput {
  return { closingId: "GGF-TEST", version: 1, orderNumber: "76", item: "ITEM", warehouse: "01",
    category: "GGF", accountOriginal: "EXP", criterion: "DIRECT_COST", quantity: "2", unit: "UN",
    amountCents: "101", stockCents: "101", consumedCents: "0", stockTraceStatus: "STOCK_REVALUATION_CANDIDATE",
    valuationMethod: "bis_FIFO", consumedOperationKey: null, sourceRefs: ["InventoryGenEntries(1)/0"], ...overrides };
}

describe("GGF V2 accounting preview", () => {
  it("previews stock-only lines and a balanced closing entry", () => {
    const result = buildAccountingPreview({ GGF: "101", MOD: "0" }, [line()], config);
    expect(result.totals).toMatchObject({ toAbsorbCents: "101", stockCents: "101", cpvCents: "0", blockedCents: "0", differenceCents: "0", accountingDifferenceCents: "0" });
    expect(result.documents.find(d => d.documentType === "MaterialRevaluation")).toMatchObject({ status: "PREVIEW_ONLY", balanced: true });
    expect(result.documents.find(d => d.documentType === "JournalEntry.Closing")).toMatchObject({ lineCount: 1, balanced: true });
    expect(result.payload).toBeNull();
  });

  it("previews CPV only for an explicitly eligible operation and configured account", () => {
    const consumed = line({ amountCents: "50", stockCents: "0", consumedCents: "50", consumedOperationKey: "DeliveryNotes:12/0" });
    const result = buildAccountingPreview({ GGF: "50", MOD: "0" }, [consumed], config);
    expect(result.totals).toMatchObject({ cpvCents: "50", blockedCents: "0", differenceCents: "0", accountingDifferenceCents: "0" });
    expect(result.rows[0]?.consumedStatus).toBe("READY_FOR_CPV_ADJUSTMENT");
    expect(result.documents.find(d => d.documentType === "JournalEntry.CPV")?.balanced).toBe(true);
  });

  it("reconciles simultaneous stock and consumed portions for MOD and GGF", () => {
    const rows = [line({ category: "MOD", amountCents: "51", stockCents: "25", consumedCents: "26" }),
      line({ category: "GGF", amountCents: "-51", stockCents: "-25", consumedCents: "-26", consumedOperationKey: "DeliveryNotes:12/0" })];
    const result = buildAccountingPreview({ MOD: "51", GGF: "-51" }, rows, config);
    expect(result.summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "MOD", stockCents: "25", blockedCents: "26" }),
      expect.objectContaining({ category: "GGF", stockCents: "-25", cpvCents: "-26", blockedCents: "0" })
    ]));
    expect(result.totals.differenceCents).toBe("0");
    expect(result.totals.accountingDifferenceCents).toBe("0");
  });

  it("blocks the consumed portion when the CPV account or operation classification is missing", () => {
    const row = line({ amountCents: "40", stockCents: "0", consumedCents: "40", consumedOperationKey: "GoodsIssue:9/0" });
    const missingClass = buildAccountingPreview({ GGF: "40", MOD: "0" }, [row], config);
    expect(missingClass.rows[0]?.consumedStatus).toBe("CPV_CLASSIFICATION_MISSING");
    const missingAccount = buildAccountingPreview({ GGF: "40", MOD: "0" },
      [line({ ...row, consumedOperationKey: "DeliveryNotes:12/0" })], { ...config, cpvAccount: "" });
    expect(missingAccount.rows[0]?.consumedStatus).toBe("CPV_ACCOUNTING_NOT_CONFIGURED");
    expect(missingAccount.totals.blockedCents).toBe("40");
  });

  it("blocks stock when account/transitory configuration is missing", () => {
    const result = buildAccountingPreview({ GGF: "101", MOD: "0" }, [line()], { ...config, transitoryGgfAccount: "" });
    expect(result.rows[0]?.stockStatus).toBe("ACCOUNTING_CONFIG_INCOMPLETE");
    expect(result.totals).toMatchObject({ stockCents: "0", blockedCents: "101", differenceCents: "0" });
  });

  it("blocks required dimensions unless the line has explicit dimension rules", () => {
    const row = line();
    const result = buildAccountingPreview({ GGF: "101", MOD: "0" }, [row], { ...config, requireDimensions: true });
    expect(result.rows[0]?.stockStatus).toBe("ACCOUNTING_CONFIG_INCOMPLETE");
    expect(result.totals.blockedCents).toBe("101");
  });

  it("preserves dimension combinations when generating closing preview lines", () => {
    const rows = [line({ amountCents: "50", stockCents: "50" }),
      line({ orderNumber: "77", amountCents: "51", stockCents: "51" })];
    const result = buildAccountingPreview({ GGF: "101", MOD: "0" }, rows, {
      ...config, requireDimensions: true,
      dimensionsByLine: { "76/ITEM/01/GGF": ["D1"], "77/ITEM/01/GGF": ["D2"] }
    });
    const closing = result.documents.find(document => document.documentType === "JournalEntry.Closing");
    expect(closing?.lineCount).toBe(2);
    expect(closing?.lines.map(entry => entry.dimensions)).toEqual([["D1"], ["D2"]]);
    expect(result.totals).toMatchObject({ stockCents: "101", blockedCents: "0", differenceCents: "0" });
  });

  it.each([
    ["negative stock", { stockTraceStatus: "BLOCKED_STOCK_NEGATIVE" }, "NEGATIVE_STOCK"],
    ["incomplete trace", { stockTraceStatus: "BLOCKED_AMBIGUOUS_TRACE" }, "STOCK_TRACE_INCOMPLETE"],
    ["moving average", { valuationMethod: "bis_MovingAverage" }, "VALUATION_METHOD_NOT_HOMOLOGATED"]
  ] as const)("blocks %s", (_label, change, status) => {
    const result = buildAccountingPreview({ GGF: "101", MOD: "0" }, [line(change)], config);
    expect(result.rows[0]?.stockStatus).toBe(status);
    expect(result.totals.blockedCents).toBe("101");
  });

  it("keeps cent rounding residual on consumed and supports overabsorption sign", () => {
    const rounding = line({ amountCents: "101", stockCents: "51", consumedCents: "50" });
    const result = buildAccountingPreview({ GGF: "101", MOD: "0" }, [rounding], config);
    expect(BigInt(result.rows[0]!.stockCents!) + BigInt(result.rows[0]!.consumedCents!)).toBe(101n);
    const negative = buildAccountingPreview({ GGF: "-101", MOD: "0" },
      [line({ amountCents: "-101", stockCents: "-51", consumedCents: "-50" })], config);
    expect(negative.totals.differenceCents).toBe("0");
    expect(negative.totals.accountingDifferenceCents).toBe("0");
  });

  it("leaves unallocated absorption as blocked and never creates payloads", () => {
    const result = buildAccountingPreview({ GGF: "-300", MOD: "70" }, [], {});
    expect(result.totals).toMatchObject({ toAbsorbCents: "-230", blockedCents: "-230", differenceCents: "0" });
    expect(result.documents.every(d => d.status === "BLOCKED" && d.payload === null)).toBe(true);
    expect(result.entries).toHaveLength(0);
  });
});
