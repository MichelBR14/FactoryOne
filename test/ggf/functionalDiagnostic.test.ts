import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const modulePath = "../../scripts/ggf-functional-diagnostic-lib.mjs";
const { decimal, format, readScope, rejectContinuation, summarizeJournals } = await import(modulePath);

const accounts = [
  { Code: "TEST-A", Name: "Test debit" },
  { Code: "TEST-B", Name: "Test credit" }
];
function journal(id = 10) {
  return {
    JdtNum: id,
    ReferenceDate: "2026-09-10T00:00:00Z",
    OriginalJournal: "ttJournalEntry",
    JournalEntryLines: [
      {
        Line_ID: 0,
        AccountCode: "TEST-A",
        Debit: 0.1,
        Credit: 0,
        BPLID: 1,
        CostingCode: "",
        CostingCode2: "",
        CostingCode3: "",
        CostingCode4: "",
        CostingCode5: ""
      },
      {
        Line_ID: 1,
        AccountCode: "TEST-B",
        Debit: 0,
        Credit: 0.1,
        BPLID: 1,
        CostingCode: "",
        CostingCode2: "",
        CostingCode3: "",
        CostingCode4: "",
        CostingCode5: ""
      }
    ] satisfies [object, object]
  };
}
const run = (journals: unknown[]) =>
  summarizeJournals(journals, accounts, "2026-09-01", "2026-09-30");

describe("functional diagnosis remains read-only and unapproved", () => {
  it("retains exact signed six-decimal sums and unique journal counts", () => {
    const a = journal(),
      b = journal(11);
    b.JournalEntryLines[0].Debit = 0.2;
    b.JournalEntryLines[1].Credit = 0.2;
    const r = run([a, b]);
    expect(r.debit).toBe("0.300000");
    expect(r.credit).toBe("0.300000");
    expect(r.journalCount).toBe(2);
    expect(r.lineCount).toBe(4);
    expect(r.accounts[1].net).toBe("-0.300000");
    expect(r.accounts[0].origins[0].journals).toEqual([10, 11]);
    expect(r.accounts[0].refs).toEqual(["10/0", "11/0"]);
    expect(r.allocationReady).toBe(false);
    expect(r.postingBlocked).toBe(true);
  });
  it("separates branches and each dimension without presuming a cost center", () => {
    const a = journal(),
      b = journal(11),
      c = journal(12);
    b.JournalEntryLines.forEach((l) => (l.BPLID = 2));
    c.JournalEntryLines.forEach((l) => (l.CostingCode3 = "TEST-CENTER"));
    expect(run([a, b, c]).accounts).toHaveLength(6);
  });
  it("does not merge explicit empty dimensions with nulls", () => {
    const a = journal(),
      b = journal(11);
    Object.assign(b.JournalEntryLines[0], { CostingCode: null });
    expect(run([a, b]).accounts).toHaveLength(3);
  });
  it("rejects absent dimensions instead of treating them as unassigned", () => {
    const j = journal();
    Reflect.deleteProperty(j.JournalEntryLines[0], "CostingCode2");
    expect(() => run([j])).toThrow("Missing dimension");
  });
  it("rejects absent branch", () => {
    const j = journal();
    Reflect.deleteProperty(j.JournalEntryLines[0], "BPLID");
    expect(() => run([j])).toThrow("Missing branch");
  });
  it("counts multiple lines in one journal once and keeps both debit and credit", () => {
    const j = journal();
    j.JournalEntryLines[1].AccountCode = "TEST-A";
    const a = run([j]).accounts[0];
    expect(a.journalCount).toBe(1);
    expect(a.lineCount).toBe(2);
    expect(a.debit).toBe("0.100000");
    expect(a.credit).toBe("0.100000");
    expect(a.net).toBe("0.000000");
  });
  it("preserves negative source amounts without absolute-value conversion", () => {
    const j = journal();
    j.JournalEntryLines[0].Debit = -0.1;
    j.JournalEntryLines[1].Credit = -0.1;
    expect(run([j]).debit).toBe("-0.100000");
  });
  it("rejects missing, nonfinite and unsupported-precision source amounts", () => {
    for (const v of [undefined, null, NaN, Infinity, "12", 0.0000001, 1e12])
      expect(() => decimal(v)).toThrow("Invalid source decimal");
    expect(format(decimal(-0.123456))).toBe("-0.123456");
  });
  it("does not replace local amounts with foreign amounts", () => {
    const j = journal();
    Object.assign(j.JournalEntryLines[0], { FCDebit: 9999, DebitSys: 555 });
    expect(run([j]).debit).toBe("0.100000");
  });
  it("rejects duplicate journals and lines", () => {
    expect(() => run([journal(), journal()])).toThrow("journal key");
    const j = journal();
    j.JournalEntryLines[1].Line_ID = 0;
    expect(() => run([j])).toThrow("journal line");
  });
  it("rejects unknown accounts, unbalanced entries and missing lines", () => {
    const a = journal();
    a.JournalEntryLines[0].AccountCode = "UNKNOWN";
    expect(() => run([a])).toThrow("Unknown ledger");
    const b = journal();
    b.JournalEntryLines[0].Debit = 1;
    expect(() => run([b])).toThrow("Unbalanced");
    const c = journal();
    Reflect.deleteProperty(c, "JournalEntryLines");
    expect(() => run([c])).toThrow("Missing journal lines");
  });
  it("rejects dates outside the fixed selection and missing origin", () => {
    const j = journal();
    j.ReferenceDate = "2026-08-31T00:00:00Z";
    expect(() => run([j])).toThrow("outside selected period");
    const k = journal();
    k.OriginalJournal = "";
    expect(() => run([k])).toThrow("Missing journal origin");
  });
  it("rejects incomplete nested collections", () => {
    expect(() => rejectContinuation({ lines: [{ "@odata.nextLink": "more" }] })).toThrow(
      "Incomplete"
    );
    expect(() => rejectContinuation({ "Lines@odata.nextLink": "more" })).toThrow("Incomplete");
  });
  it("labels only ledger reads as period-filtered", () => {
    expect(readScope({ id: "JournalEntries" })).toContain("September 2026");
    expect(readScope({ id: "ChartOfAccounts" })).toBe("all master records");
  });
  it("collector reuses approved order evidence and has no business write transport", () => {
    const script = readFileSync("scripts/ggf-sap-functional-diagnostic.mjs", "utf8");
    expect(script).toContain('".local/ggf/order-audit-source.json"');
    expect(script).toContain('createHash("sha256")');
    expect(script).not.toMatch(
      /readOrderAuditData|analyzeOrderAudit|session\.(post|patch|put|delete)|fetch\(/
    );
    expect(script).not.toMatch(
      /ProductionOrders\(|InventoryGenEntries\(|InventoryGenExits\(|ProjectManagementTimeSheet/
    );
  });
});
