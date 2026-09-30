import { describe, expect, it } from "vitest";
import {
  MappedGgfSource,
  type GgfReadMapping
} from "../../webapp/modules/ggf/repository/MappedGgfSource";
import { DevelopmentGgfRepository } from "../../webapp/modules/ggf/development/DevelopmentGgfRepository";
import { demoConfiguration } from "../../webapp/modules/ggf/development/fixtures";
import { ClosingSession } from "../../webapp/modules/ggf/service/ClosingSession";
import { ServiceLayerClient } from "../../webapp/core/service/ServiceLayerClient";
import { loadIntegrationConfig } from "../../webapp/core/config/integration";
import { reply, type RecordedCall } from "../core/service/fakeFetch";

const filter = { start: "2026-09-01", end: "2026-09-30", branch: "DEV-01", costCenter: "" };
type SimulatedRow = { fixtureRowId: string };

async function fixture() {
  const sample = await new DevelopmentGgfRepository({
    getItem: () => null,
    setItem: () => {}
  }).loadSnapshot(filter, demoConfiguration);
  const datasets = sample.evidence.reads.map((r) => r.dataset);
  const responses = new Map<string, unknown>();
  const calls: RecordedCall[] = [];
  const rawRows = new Map<string, SimulatedRow[]>([
    [
      "balances",
      sample.balances.flatMap((b) => b.sourceRefs.map((fixtureRowId) => ({ fixtureRowId })))
    ],
    [
      "production",
      sample.orders.flatMap((o) => o.sourceRefs.map((fixtureRowId) => ({ fixtureRowId })))
    ],
    ["currentCosts", sample.orders.map((o) => ({ fixtureRowId: o.id }))]
  ]);
  for (const dataset of datasets) {
    const rows = rawRows.get(dataset)!;
    // Test-only paths/projections, not SAP entities or SQLQueries.
    responses.set(`test-only/${dataset}?page=1`, {
      value: rows.slice(0, 1),
      "@odata.nextLink": `/b1s/v2/test-only/${dataset}?page=2`
    });
    responses.set(`test-only/${dataset}?page=2`, { value: rows.slice(1) });
    responses.set(`test-only/${dataset}-control`, {
      expectedRows: rows.length,
      reconciliationRef: `test-only/${dataset}/independent-count`
    });
  }
  const mapping: GgfReadMapping = {
    reads: (requested, config) => {
      expect(requested).toEqual(filter);
      expect(config).toEqual(demoConfiguration);
      return datasets.map((dataset) => ({
        id: `DEV-${dataset}`,
        dataset,
        sourceRef: `test-only/projection/${dataset}`,
        dataPath: `test-only/${dataset}?page=1`,
        controlPath: `test-only/${dataset}-control`,
        rowId: (row) => (row as SimulatedRow).fixtureRowId,
        decodeControl: (response) => response as { expectedRows: number; reconciliationRef: string }
      }));
    },
    normalize: (rows) => {
      expect([...rows.keys()]).toEqual(datasets.map((d) => `DEV-${d}`));
      // This fixture supplies normalized records; real column conversions remain unconfigured.
      return structuredClone({
        currency: sample.evidence.currency,
        balances: sample.balances,
        orders: sample.orders
      });
    }
  };
  const base = "https://simulated.invalid/b1s/v2/";
  const client = new ServiceLayerClient({
    config: loadIntegrationConfig({
      FBO_ENV: "test",
      FBO_SL_URL: "https://simulated.invalid",
      FBO_SL_COMPANY_DB: "FIXTURE"
    }),
    session: { acquire: async () => ({ kind: "host" }) },
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (init.method !== "GET") throw new Error("Writes forbidden in read adapter test");
      const path = url.slice(base.length);
      if (!responses.has(path)) throw new Error(`Unexpected simulated path: ${path}`);
      const response = responses.get(path);
      if (response instanceof Error) throw response;
      return reply({ body: response as object });
    }
  });
  const source = new MappedGgfSource(client, mapping, {
    newId: () => "SIMULATED-SNAPSHOT",
    now: () => new Date("2026-09-26T12:00:00Z")
  });
  return { source, client, mapping, responses, calls };
}

describe("GGF read acquisition with simulated Service Layer responses", () => {
  it("collects every page and independent control using GET only, and feeds the closing session", async () => {
    const f = await fixture();
    const session = new ClosingSession(f.source);
    const result = (await session.calculate(demoConfiguration, filter))!;
    expect(result.total).toBe(400000n);
    expect(result.difference).toBe(0n);
    expect(result.snapshot.id).toBe("SIMULATED-SNAPSHOT");
    expect(result.snapshot.evidence.reads.map((r) => r.pagesRead)).toEqual([2, 2, 2]);
    expect(result.snapshot.evidence.reads.map((r) => r.receivedRows)).toEqual([4, 3, 3]);
    expect(f.calls).toHaveLength(9);
    expect(f.calls.every((c) => c.init.method === "GET")).toBe(true);
    expect("saveConfiguration" in f.source).toBe(false);
    expect(() => session.confirm()).toThrow("postingBlocked");
  });
  it("does not infer completeness when the page limit is reached", async () => {
    const f = await fixture();
    const source = new MappedGgfSource(f.client, f.mapping, { maxPages: 1 });
    await expect(source.loadSnapshot(filter, demoConfiguration)).rejects.toThrow(
      /incomplete pagination/
    );
    expect(f.calls).toHaveLength(1);
  });
  it.each([
    ["cycle", { value: [], "@odata.nextLink": "test-only/balances?page=2" }],
    ["invalid page", { value: null }],
    ["duplicate row", { value: [{ fixtureRowId: "DEV-J-0" }] }],
    ["different collection", { value: [], "@odata.nextLink": "test-only/other?page=3" }],
    ["external nextLink", { value: [], "@odata.nextLink": "https://other.invalid/collection" }],
    ["invalid nextLink", { value: [], "@odata.nextLink": 2 }],
    [
      "conflicting nextLinks",
      {
        value: [],
        "@odata.nextLink": "test-only/balances?page=3",
        "odata.nextLink": "test-only/balances?page=4"
      }
    ],
    ["missing row ID", { value: [{}] }]
  ])("rejects %s without publishing a partial snapshot", async (_name, response) => {
    const f = await fixture();
    f.responses.set("test-only/balances?page=2", response);
    const session = new ClosingSession(f.source);
    await expect(session.calculate(demoConfiguration, filter)).rejects.toThrow("sourceRead");
    expect(session.result).toBeUndefined();
    expect(f.calls.every((c) => c.init.method === "GET")).toBe(true);
  });
  it.each([
    undefined,
    { expectedRows: 5, reconciliationRef: "independent" },
    { expectedRows: 4, reconciliationRef: "" },
    { expectedRows: "4", reconciliationRef: "independent" }
  ])("rejects missing or inconsistent independent control %j", async (control) => {
    const f = await fixture();
    f.responses.set("test-only/balances-control", control);
    await expect(f.source.loadSnapshot(filter, demoConfiguration)).rejects.toThrow(
      "count reconciliation"
    );
    expect(f.calls).toHaveLength(3);
  });
  it("rejects fabricated source references even if counts match", async () => {
    const f = await fixture();
    const normalize = f.mapping.normalize;
    f.mapping.normalize = (...args) => {
      const output = normalize(...args);
      output.balances[0]!.sourceRefs = ["FABRICATED"];
      return output;
    };
    await expect(f.source.loadSnapshot(filter, demoConfiguration)).rejects.toThrow(
      /unknown source row/
    );
  });
  it("rejects an incomplete mapping before calling the client", async () => {
    const f = await fixture();
    f.mapping.reads = () => [];
    await expect(f.source.loadSnapshot(filter, demoConfiguration)).rejects.toThrow("mapping");
    expect(f.calls).toHaveLength(0);
  });
  it("propagates transport failure without a result or writes", async () => {
    const f = await fixture();
    f.responses.set("test-only/production?page=2", new Error("simulated offline"));
    const session = new ClosingSession(f.source);
    await expect(session.calculate(demoConfiguration, filter)).rejects.toThrow();
    expect(session.result).toBeUndefined();
    expect(f.calls.every((c) => c.init.method === "GET")).toBe(true);
  });
});
