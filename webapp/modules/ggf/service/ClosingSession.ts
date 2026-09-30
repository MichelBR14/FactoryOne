import { allocate, GgfError } from "../engine/allocation";
import type {
  AllocationResult,
  Configuration,
  PeriodFilter,
  SourceSnapshot
} from "../engine/types";
import type { GgfSource } from "../repository/GgfSource";

/** Owns the calculation lifecycle, including stale asynchronous reads. */
export class ClosingSession {
  private revision = 0;
  result?: AllocationResult;
  constructor(private readonly repository: GgfSource) {}
  invalidate(): void {
    this.revision++;
    this.result = undefined;
  }
  async calculate(
    config: Configuration,
    filter: PeriodFilter
  ): Promise<AllocationResult | undefined> {
    this.invalidate();
    const revision = this.revision;
    const configuration = structuredClone(config);
    const requested = { ...filter };
    let snapshot: SourceSnapshot;
    try {
      snapshot = await this.repository.loadSnapshot(requested, configuration);
    } catch (error) {
      if (revision !== this.revision) return undefined;
      throw error;
    }
    if (revision !== this.revision) return undefined;
    if (
      snapshot.origin !== this.repository.mode ||
      (Object.keys(requested) as Array<keyof PeriodFilter>).some(
        (key) => snapshot.filter[key] !== requested[key]
      )
    )
      throw new GgfError("sourceMismatch");
    const result = allocate(configuration, snapshot);
    this.result = result;
    return result;
  }
  confirm(): never {
    throw new GgfError("postingBlocked");
  }
}
