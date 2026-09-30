import { DEFAULT_BASE_PATH } from "../../../core/service/types";
import { validateConfiguration, validatePeriod } from "../engine/allocation";
import { GgfError } from "../engine/errors";
import { validateSourceEvidence } from "../engine/sourceEvidence";
import type {
  Configuration,
  PeriodFilter,
  ReadEvidence,
  SourceDataset,
  SourceSnapshot
} from "../engine/types";
import type { GgfSource } from "./GgfSource";

export interface GgfReadClient {
  get<T = unknown>(path: string): Promise<T | undefined>;
}
interface ReadPage {
  value?: unknown[];
  "@odata.nextLink"?: unknown;
  "odata.nextLink"?: unknown;
}
export interface GgfReadDefinition {
  id: string;
  dataset: SourceDataset;
  sourceRef: string;
  dataPath: string;
  controlPath: string;
  rowId(row: unknown): string;
  decodeControl(response: unknown): { expectedRows: number; reconciliationRef: string };
}
export interface GgfReadMapping {
  /** Paths and decoders must come from a verified mapping; none are supplied by this module. */
  reads(filter: PeriodFilter, config: Configuration): GgfReadDefinition[];
  normalize(
    rows: ReadonlyMap<string, readonly unknown[]>,
    filter: PeriodFilter,
    config: Configuration
  ): {
    currency: string;
    balances: SourceSnapshot["balances"];
    orders: SourceSnapshot["orders"];
  };
}

const fail = (details: string): never => {
  throw new GgfError("sourceRead", [details]);
};
const nonempty = (value: unknown): value is string => typeof value === "string" && !!value.trim();

/** Read-only acquisition. Diagnostic reads are not allocation-ready snapshots. */
export class MappedGgfSource implements GgfSource {
  readonly mode = "sap" as const;
  constructor(
    private readonly client: GgfReadClient,
    private readonly mapping: GgfReadMapping,
    private readonly options: {
      maxPages?: number;
      basePath?: string;
      now?: () => Date;
      newId?: () => string;
    } = {}
  ) {}

  async loadSnapshot(filter: PeriodFilter, config: Configuration): Promise<SourceSnapshot> {
    const requested = structuredClone(filter);
    const configuration = structuredClone(config);
    validatePeriod(requested);
    validateConfiguration(configuration);
    const reads = this.mapping.reads(structuredClone(requested), structuredClone(configuration));
    if (
      ["balances", "production", "currentCosts"].some(
        (dataset) => !reads.some((r) => r.dataset === dataset)
      )
    )
      fail("mapping");
    const { rows, keys, evidence } = await this.inspectSources(requested, reads);
    const normalized = this.mapping.normalize(
      rows,
      structuredClone(requested),
      structuredClone(configuration)
    );
    const snapshot: SourceSnapshot = {
      id: (this.options.newId ?? (() => crypto.randomUUID()))(),
      origin: this.mode,
      capturedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      filter: requested,
      balances: normalized.balances,
      orders: normalized.orders,
      evidence: { currency: normalized.currency, reads: evidence }
    };
    validateSourceEvidence(snapshot, configuration);
    const references = [
      ...snapshot.balances.map((b) => ({ readId: b.readId, sourceRefs: b.sourceRefs })),
      ...snapshot.orders.flatMap((o) => [
        ...Object.values(o.basisEvidence).filter((b) => b !== null),
        ...Object.values(o.resourceBases ?? {}).flatMap((g) =>
          Object.values(g).map((m) => m.evidence)
        ),
        ...Object.values(o.basisEvidence).flatMap((b) => b?.supportingReads ?? []),
        ...Object.values(o.resourceBases ?? {}).flatMap((g) =>
          Object.values(g).flatMap((m) => m.evidence.supportingReads ?? [])
        )
      ])
    ];
    for (const ref of references) {
      if (ref.sourceRefs.some((id) => !keys.get(ref.readId)?.has(id)))
        fail(`${ref.readId} / unknown source row`);
    }
    for (const read of snapshot.evidence.reads) {
      if (read.excludedSourceRefs?.some((id) => !keys.get(read.id)?.has(id)))
        fail(`${read.id} / unknown excluded row`);
    }
    return structuredClone(snapshot);
  }

  /** Partial source inspection never supplies a SourceSnapshot or permits calculation. */
  async inspectSources(filter: PeriodFilter, reads: GgfReadDefinition[]) {
    const requested = structuredClone(filter);
    validatePeriod(requested);
    const maxPages = this.options.maxPages ?? 100;
    if (
      !Number.isSafeInteger(maxPages) ||
      maxPages < 1 ||
      !reads.length ||
      new Set(reads.map((r) => r.id)).size !== reads.length ||
      reads.some((r) => !nonempty(r.id) || !nonempty(r.sourceRef))
    )
      fail("mapping");
    const rows = new Map<string, unknown[]>();
    const keys = new Map<string, Set<string>>();
    const evidence: ReadEvidence[] = [];
    for (const read of reads) {
      let path: string | undefined = this.relativePath(read.dataPath);
      const resource = path.split("?")[0];
      const controlPath = this.relativePath(read.controlPath);
      if (controlPath === path) fail(`${read.id} / independent control`);
      const visited = new Set<string>();
      const collected: unknown[] = [];
      const rowIds = new Set<string>();
      let pagesRead = 0;
      while (path) {
        if (pagesRead >= maxPages || visited.has(path)) fail(`${read.id} / incomplete pagination`);
        visited.add(path);
        const page: ReadPage | undefined = await this.client.get<ReadPage>(path);
        if (!page || !Array.isArray(page.value))
          throw new GgfError("sourceRead", [`${read.id} / invalid page`]);
        for (const row of page.value) {
          const id = read.rowId(row);
          if (!nonempty(id) || rowIds.has(id)) fail(`${read.id} / duplicate or missing row ID`);
          rowIds.add(id);
          collected.push(row);
        }
        pagesRead++;
        const modern: unknown = page["@odata.nextLink"];
        const legacy: unknown = page["odata.nextLink"];
        if (
          (modern != null && legacy != null && modern !== legacy) ||
          [modern, legacy].some((link) => link != null && !nonempty(link))
        )
          fail(`${read.id} / invalid nextLink`);
        const next: unknown = modern ?? legacy;
        path = next == null ? undefined : this.relativePath(next as string);
        if (path && path.split("?")[0] !== resource) fail(`${read.id} / different collection`);
      }
      const control = read.decodeControl(await this.client.get(controlPath));
      if (
        !control ||
        !Number.isSafeInteger(control.expectedRows) ||
        control.expectedRows < 0 ||
        control.expectedRows !== collected.length ||
        !nonempty(control.reconciliationRef)
      )
        fail(`${read.id} / count reconciliation`);
      rows.set(read.id, collected);
      keys.set(read.id, rowIds);
      evidence.push({
        id: read.id,
        dataset: read.dataset,
        sourceRef: read.sourceRef,
        filter: { ...requested },
        pagesRead,
        receivedRows: collected.length,
        expectedRows: control.expectedRows,
        exhausted: true,
        reconciliationRef: control.reconciliationRef
      });
    }
    return { rows, keys, evidence };
  }

  private relativePath(value: string): string {
    const base = `${(this.options.basePath ?? DEFAULT_BASE_PATH).replace(/\/$/, "")}/`;
    let path = value;
    if (typeof path !== "string") throw new GgfError("sourceRead", ["invalid path"]);
    if (path.startsWith(base)) path = path.slice(base.length);
    else if (path.startsWith(base.slice(1))) path = path.slice(base.length - 1);
    // Only configured relative paths. Absolute nextLinks require future, origin-aware validation.
    if (
      !path ||
      /^[/?]/.test(path) ||
      /[:\\#\s]/.test(path) ||
      path
        .split("?")[0]!
        .split("/")
        .some((s) => {
          const decoded = decodeURIComponent(s);
          return decoded === "." || decoded === ".." || /[\\/]/.test(decoded);
        })
    )
      fail("invalid relative path");
    return path;
  }
}
