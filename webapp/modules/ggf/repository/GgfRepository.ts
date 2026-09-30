import type { Configuration } from "../engine/types";
import type { GgfSource } from "./GgfSource";

export interface GgfCatalog {
  branches: string[];
  costCenters: string[];
  resourceGroups: string[];
}

/** loadSnapshot must provide normalized units, comparable bases and complete read evidence.
 * References must resolve to retained conversion rules and independent reconciliations.
 * Future SAP implementation must resolve approved queries, completeness and source references.
 * Missing balances/bases must not be replaced with guessed values. No posting contract exists yet.
 */
export interface GgfRepository extends GgfSource {
  getCatalog(): Promise<GgfCatalog>;
  loadConfiguration(): Promise<Configuration>;
  saveConfiguration(config: Configuration): Promise<void>;
}
