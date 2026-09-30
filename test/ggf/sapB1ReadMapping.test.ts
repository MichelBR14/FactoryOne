import { describe, expect, it } from "vitest";
import {
  inspectSapB1,
  sapB1ReadMapping
} from "../../webapp/modules/ggf/repository/SapB1ReadMapping";
import {
  MappedGgfSource,
  type GgfReadClient
} from "../../webapp/modules/ggf/repository/MappedGgfSource";
import { ClosingSession } from "../../webapp/modules/ggf/service/ClosingSession";
import { demoConfiguration } from "../../webapp/modules/ggf/development/fixtures";

const filter = { start: "2026-06-01", end: "2026-06-30", branch: "", costCenter: "" };
const emptyConfig = { classifications: [], accounts: [], groupShares: [] };
// Invented, minimal responses. No captured business data or SAP credentials in tests.
function fixture() {
  const line = { Line_ID: 0, AccountCode: "TEST-A", Debit: 12.123456, Credit: 0, BPLID: 1 };
  const journal = {
    JdtNum: 7,
    ReferenceDate: "2026-06-02T00:00:00Z",
    JournalEntryLines: [line, { ...line, Line_ID: 1, Debit: 0, Credit: 12.123456 }]
  };
  const definitions = sapB1ReadMapping.reads(filter, emptyConfig);
  const responses = new Map<string, unknown>();
  for (const def of definitions) {
    const value =
      def.id === "ChartOfAccounts"
        ? [{ Code: "TEST-A", Name: "Simulated test account" }]
        : def.id === "JournalEntries"
          ? [journal]
          : [];
    responses.set(def.dataPath, { value });
    responses.set(def.controlPath, String(value.length));
  }
  responses.set(
    "JournalEntries(7)?$select=JdtNum,ReferenceDate,JournalEntryLines",
    structuredClone(journal)
  );
  const calls: string[] = [];
  const client: GgfReadClient = {
    async get<T>(path: string): Promise<T> {
      calls.push(path);
      if (path.includes("$apply=")) return { value: [{ Count: 1 }] } as T;
      if (!responses.has(path)) throw new Error("Unexpected test path");
      return structuredClone(responses.get(path)) as T;
    }
  };
  return { client, definitions, responses, calls, journal };
}

describe("verified SAP field mapping with simulated responses", () => {
  it("keeps diagnostic reads separate from allocation and preserves six monetary decimals", async () => {
    const f = fixture();
    const report = await inspectSapB1(f.client, filter);
    expect(report.origin).toBe("sap");
    expect(report.allocationReady).toBe(false);
    expect(report.postingBlocked).toBe(true);
    expect(report.journal).toMatchObject({
      debit: "12.123456",
      credit: "12.123456",
      difference: "0.000000",
      pointReads: 1,
      lines: 2
    });
    expect(report.accounts[0]).toMatchObject({
      account: "TEST-A",
      net: "0.000000",
      refs: ["7/0", "7/1"]
    });
    expect(report.differences).toEqual([]);
    expect(report.blockers.join(" ")).toContain("Nenhuma ordem");
    for (const def of f.definitions)
      expect(f.calls.filter((path) => path === def.controlPath)).toHaveLength(2);
  });
  it("cannot turn the partial mapping into an allocation-ready snapshot", async () => {
    const f = fixture();
    const session = new ClosingSession(new MappedGgfSource(f.client, sapB1ReadMapping));
    await expect(session.calculate(demoConfiguration, filter)).rejects.toThrow("mapping");
    expect(session.result).toBeUndefined();
    expect(f.calls).toEqual([]);
    expect(() => session.confirm()).toThrow("postingBlocked");
    expect(() => sapB1ReadMapping.normalize(new Map(), filter, emptyConfig)).toThrow(
      "normalization pending"
    );
  });
  it.each([{ branch: "1" }, { costCenter: "TEST" }])(
    "rejects unapproved scope %j",
    async (scope) => {
      const f = fixture();
      await expect(inspectSapB1(f.client, { ...filter, ...scope })).rejects.toThrow("not approved");
      expect(f.calls).toEqual([]);
    }
  );
  it("encodes dates and does not presume order eligibility", () => {
    const defs = fixture().definitions;
    expect(decodeURIComponent(defs.find((d) => d.id === "JournalEntries")!.dataPath)).toContain(
      "ReferenceDate ge '2026-06-01' and ReferenceDate le '2026-06-30'"
    );
    expect(defs.find((d) => d.id === "ProductionOrders")!.dataPath).not.toContain("$filter");
  });
  it("compares collection lines with separately requested document details", async () => {
    const f = fixture();
    const key = "JournalEntries(7)?$select=JdtNum,ReferenceDate,JournalEntryLines";
    const detail = structuredClone(f.journal);
    detail.JournalEntryLines[0]!.Debit = 13;
    f.responses.set(key, detail);
    expect((await inspectSapB1(f.client, filter)).differences).toContain(
      "JournalEntries(7): collection/detail mismatch"
    );
  });
  it.each([undefined, NaN, Infinity, 0.0000001, "12.12"])(
    "rejects missing or unsupported amounts %j",
    async (value) => {
      const f = fixture();
      (f.journal.JournalEntryLines[0] as Record<string, unknown>).Debit = value;
      await expect(inspectSapB1(f.client, filter)).rejects.toThrow("SAP");
    }
  );
  it("rejects duplicate line keys", async () => {
    const f = fixture();
    f.journal.JournalEntryLines[1]!.Line_ID = 0;
    await expect(inspectSapB1(f.client, filter)).rejects.toThrow("Duplicate journal line");
  });
  it("fails closed if the aggregate differs", async () => {
    const f = fixture();
    const client: GgfReadClient = {
      async get<T>(path: string) {
        return path.includes("$apply=") ? ({ value: [{ Count: 2 }] } as T) : f.client.get<T>(path);
      }
    };
    await expect(inspectSapB1(client, filter)).rejects.toThrow("aggregate count mismatch");
  });
  it("fails closed if counts drift after detail reads", async () => {
    const f = fixture();
    let counts = 0;
    const client: GgfReadClient = {
      async get<T>(path: string) {
        if (path.startsWith("JournalEntries/$count") && ++counts === 2) return "2" as T;
        return f.client.get<T>(path);
      }
    };
    await expect(inspectSapB1(client, filter)).rejects.toThrow("changed during inspection");
  });
  it("never interprets an unlinked receipt as production", async () => {
    const f = fixture();
    const def = f.definitions.find((d) => d.id === "InventoryGenEntries")!;
    f.responses.set(def.dataPath, {
      value: [
        {
          DocEntry: 3,
          DocDate: "2026-06-02",
          DocTotal: 12.123456,
          TransNum: 7,
          Cancelled: "tNO",
          DocCurrency: "TEST",
          DocumentLines: [{ BaseType: -1, BaseEntry: null, MeasureUnit: null }]
        }
      ]
    });
    f.responses.set(def.controlPath, "1");
    const report = await inspectSapB1(f.client, filter);
    expect(report.receipts[0]).toMatchObject({
      productionLines: 0,
      missingUnits: 1,
      journalDebitDifference: "0.000000"
    });
    expect(report.orders).toEqual([]);
  });
});
