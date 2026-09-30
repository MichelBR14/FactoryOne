import { describe, expect, it } from "vitest";
import {
  DevelopmentGgfRepository,
  DEVELOPMENT_CONFIG_KEY
} from "../../webapp/modules/ggf/development/DevelopmentGgfRepository";
import { demoConfiguration } from "../../webapp/modules/ggf/development/fixtures";
import { ClosingSession } from "../../webapp/modules/ggf/service/ClosingSession";
import { exportCsv } from "../../webapp/modules/ggf/service/export";
import { isDevelopmentMode } from "../../webapp/core/config/runtime";
import type { SourceSnapshot } from "../../webapp/modules/ggf/engine/types";

const filter = { start: "2026-09-01", end: "2026-09-30", branch: "DEV-01", costCenter: "" };
function repository() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    }
  };
  return { repo: new DevelopmentGgfRepository(storage), storage };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
describe("local GGF workflow", () => {
  it("loads fixture balances by dates and filters, excluding self-generated postings", async () => {
    const { repo } = repository();
    const session = new ClosingSession(repo);
    const result = (await session.calculate(demoConfiguration, filter))!;
    expect(result.total).toBe(400000n);
    expect(result.orders).toHaveLength(3);
    expect(result.difference).toBe(0n);
    expect(result.snapshot.origin).toBe("development");
    const branch2 = (await session.calculate(demoConfiguration, {
      ...filter,
      branch: "DEV-02",
      costCenter: "APOIO"
    }))!;
    expect(branch2.total).toBe(40000n);
    expect(branch2.orders.map((o) => o.order.number)).toEqual(["201"]);
    await expect(
      session.calculate(demoConfiguration, { ...filter, costCenter: "APOIO" })
    ).rejects.toThrow("zeroBasis");
    expect(session.result).toBeUndefined();
    await expect(
      session.calculate(demoConfiguration, { ...filter, start: "2026-08-01", end: "2026-08-31" })
    ).rejects.toThrow("zeroBasis");
  });
  it("saves configuration locally under a development-only key", async () => {
    const { repo, storage } = repository();
    const config = await repo.loadConfiguration();
    config.accounts[0]!.name = "Edited";
    await repo.saveConfiguration(config);
    expect((await repo.loadConfiguration()).accounts[0]!.name).toBe("Edited");
    expect(storage.getItem(DEVELOPMENT_CONFIG_KEY)).toContain("Edited");
    config.accounts.push({ ...config.accounts[0]! });
    await expect(repo.saveConfiguration(config)).rejects.toThrow("duplicate");
    expect((await repo.loadConfiguration()).accounts).toHaveLength(4);
  });
  it("reports corrupted local state without silently loading demonstration data", async () => {
    const { repo, storage } = repository();
    storage.setItem(DEVELOPMENT_CONFIG_KEY, "{}");
    await expect(repo.loadConfiguration()).rejects.toThrow("storedConfiguration");
  });
  it("rejects missing fixture accounts instead of assuming zero", async () => {
    const { repo } = repository();
    const config = await repo.loadConfiguration();
    config.accounts[0]!.account = "UNKNOWN";
    await expect(repo.loadSnapshot(filter, config)).rejects.toThrow("missingBalance");
  });
  it("discards an asynchronous read invalidated by edits", async () => {
    const { repo } = repository();
    let complete!: (snapshot: SourceSnapshot) => void;
    const snapshot = await repo.loadSnapshot(filter, demoConfiguration);
    repo.loadSnapshot = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    const session = new ClosingSession(repo);
    const pending = session.calculate(demoConfiguration, filter);
    session.invalidate();
    complete(snapshot);
    expect(await pending).toBeUndefined();
    expect(session.result).toBeUndefined();
  });
  it("blocks confirmation even after a reconciled calculation", async () => {
    const session = new ClosingSession(repository().repo);
    await session.calculate(demoConfiguration, filter);
    expect(() => session.confirm()).toThrow("postingBlocked");
  });
  it("ignores an obsolete rejection while the newer read is pending", async () => {
    const { repo } = repository();
    const snapshot = await repo.loadSnapshot(filter, demoConfiguration);
    const first = deferred<SourceSnapshot>();
    const second = deferred<SourceSnapshot>();
    const queue = [first, second];
    repo.loadSnapshot = () => queue.shift()!.promise;
    const session = new ClosingSession(repo);
    const old = session.calculate(demoConfiguration, filter);
    const latest = session.calculate(demoConfiguration, filter);
    first.reject(new Error("old failure"));
    expect(await old).toBeUndefined();
    expect(session.result).toBeUndefined();
    second.resolve(snapshot);
    expect((await latest)!.snapshot.id).toBe(snapshot.id);
    expect(session.result!.snapshot.id).toBe(snapshot.id);
  });
  it.each(["resolve", "reject"] as const)(
    "keeps the newest result after an obsolete %s",
    async (outcome) => {
      const { repo } = repository();
      const snapshot = await repo.loadSnapshot(filter, demoConfiguration);
      const first = deferred<SourceSnapshot>();
      const second = deferred<SourceSnapshot>();
      const queue = [first, second];
      repo.loadSnapshot = () => queue.shift()!.promise;
      const session = new ClosingSession(repo);
      const old = session.calculate(demoConfiguration, filter);
      const latest = session.calculate(demoConfiguration, filter);
      second.resolve({ ...snapshot, id: "LATEST" });
      await latest;
      if (outcome === "resolve") first.resolve(snapshot);
      else first.reject(new Error("old failure"));
      expect(await old).toBeUndefined();
      expect(session.result!.snapshot.id).toBe("LATEST");
    }
  );
  it("does not restore an old result after the active read failed", async () => {
    const { repo } = repository();
    const snapshot = await repo.loadSnapshot(filter, demoConfiguration);
    const first = deferred<SourceSnapshot>();
    const second = deferred<SourceSnapshot>();
    const queue = [first, second];
    repo.loadSnapshot = () => queue.shift()!.promise;
    const session = new ClosingSession(repo);
    const old = session.calculate(demoConfiguration, filter);
    const latest = session.calculate(demoConfiguration, filter);
    const failure = expect(latest).rejects.toThrow("active failure");
    second.reject(new Error("active failure"));
    await failure;
    first.resolve(snapshot);
    expect(await old).toBeUndefined();
    expect(session.result).toBeUndefined();
  });
  it("ignores a rejected read after an edit invalidated it", async () => {
    const { repo } = repository();
    const pending = deferred<SourceSnapshot>();
    repo.loadSnapshot = () => pending.promise;
    const session = new ClosingSession(repo);
    const work = session.calculate(demoConfiguration, filter);
    session.invalidate();
    pending.reject(new Error("obsolete"));
    expect(await work).toBeUndefined();
    expect(session.result).toBeUndefined();
  });
  it("exports traceability, period, reconciliation and spreadsheet-safe values", async () => {
    const result = (await new ClosingSession(repository().repo).calculate(
      demoConfiguration,
      filter
    ))!;
    result.orders[0]!.order.item = '=HYPERLINK("bad")';
    const csv = exportCsv(result);
    expect(csv).toContain('"development"');
    expect(csv).toContain('"4000.00"');
    expect(csv).toContain('"2026-09-01"');
    expect(csv).toContain("DEV-J-0");
    expect(csv).toContain("fractionalCentNumerator");
    expect(csv).toContain("'=");
    expect(csv).toContain('"60"');
    expect(csv).toContain('"DEV-UNIT"');
    expect(csv).toContain("normalizationRef");
    expect(csv).toContain("reconciliationRef");
  });
  it.each([
    ["localhost", "?mode=development", true],
    ["127.0.0.1", "?mode=development", true],
    ["localhost", "", false],
    ["sap.example", "?mode=development", false]
  ] as const)("gates development on %s %s", (hostname, search, expected) => {
    expect(isDevelopmentMode({ hostname, search })).toBe(expected);
  });
});
