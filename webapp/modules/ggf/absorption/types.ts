export type AbsorptionCategory = "MOD" | "GGF";

export interface AbsorptionAccountMapping {
  account: string;
  category: AbsorptionCategory;
}

export interface AbsorptionResourceMapping {
  resource: string;
  component: number;
  category: AbsorptionCategory;
}

export interface AbsorptionMapping {
  accounts: AbsorptionAccountMapping[];
  resources: AbsorptionResourceMapping[];
  /** True only for explicitly labeled technical homologation, never functional approval. */
  technicalHomologation: boolean;
}

export interface AbsorptionFilter {
  start: string;
  end: string;
  branch: string;
  dimensions: [string, string, string, string, string];
}

export interface AbsorptionJournalLine {
  account: string;
  debitCents: bigint;
  creditCents: bigint;
  branch: string;
  dimensions: [string, string, string, string, string];
  referenceDate: string;
  transId: string;
  document: string;
  lineId: string;
}

export interface AbsorptionResourceCost {
  resource: string;
  description: string;
  type: string;
  unit: string | null;
  components: Array<{ component: number; unitCostCents: bigint }>;
  evidence: string;
}

export interface AbsorptionResourceMovement {
  resource: string;
  order: string;
  orderEntry: string;
  producedItem: string;
  itemDescription: string;
  plannedQuantity: string;
  completedQuantity: string;
  quantityMicros: bigint;
  unit: string | null;
  lineTotalCents: bigint;
  direction: "ISSUE" | "RETURN";
  document: string;
  docEntry: string;
  lineId: string;
  date: string;
  sourceAccount: string;
}

export interface AbsorptionSourceData {
  company: string;
  filter: AbsorptionFilter;
  accounts: Array<{ code: string; name: string }>;
  journals: AbsorptionJournalLine[];
  resources: AbsorptionResourceCost[];
  orders: Array<{ entry: string; number: string; item: string; itemDescription: string; plannedQuantity: string; completedQuantity: string; unit: string }>;
  movements: AbsorptionResourceMovement[];
  completeness: Array<{ source: string; received: number; expected: number; control: string }>;
  capturedAt: string;
}

export interface AbsorptionEntryDetail {
  account: string;
  accountName: string;
  category: AbsorptionCategory;
  debitCents: bigint;
  creditCents: bigint;
  realCents: bigint;
  entries: Array<{
    transId: string;
    document: string;
    date: string;
    lineId: string;
    debitCents: bigint;
    creditCents: bigint;
    branch: string;
    dimensions: [string, string, string, string, string];
  }>;
}

export interface AbsorptionResourceDetail {
  resource: string;
  description: string;
  producedItem: string;
  itemDescription: string;
  plannedQuantity: string;
  completedQuantity: string;
  category: AbsorptionCategory;
  component: number;
  unit: string;
  quantityMicros: bigint;
  unitCostCents: bigint;
  amountCents: bigint;
  movementCostCents: bigint;
  order: string;
  document: string;
  docEntry: string;
  lineId: string;
  date: string;
  sourceAccount: string;
}

export interface AbsorptionDifference {
  category: AbsorptionCategory;
  realCents: bigint;
  absorbedCents: bigint;
  differenceCents: bigint;
  status: "CONCILIATED" | "SUBABSORPTION" | "OVERABSORPTION";
}
export type AbsorptionReconciliation = AbsorptionDifference;

export interface AbsorptionReport {
  company: string;
  filter: AbsorptionFilter;
  technicalHomologation: boolean;
  accounts: AbsorptionEntryDetail[];
  resources: AbsorptionResourceDetail[];
  resourceCatalog: AbsorptionSourceData["resources"];
  reconciliation: AbsorptionReconciliation[];
  statuses: Array<"Sem configuração" | "Sem movimento" | "Unidade incompatível" | "Base indisponível" | "Homologação técnica">;
  blockers: string[];
  completeness: AbsorptionSourceData["completeness"];
  capturedAt: string;
}
