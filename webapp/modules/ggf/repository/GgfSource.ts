import type { Configuration, PeriodFilter, SourceSnapshot } from "../engine/types";

/** The closing workflow needs data reads only, never configuration or posting writes. */
export interface GgfSource {
  readonly mode: "development" | "sap";
  loadSnapshot(filter: PeriodFilter, config: Configuration): Promise<SourceSnapshot>;
}
