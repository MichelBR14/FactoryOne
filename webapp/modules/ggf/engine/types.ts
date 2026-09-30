export const CRITERIA = ["DIRECT_COST", "QUANTITY", "HOURS", "RESOURCE_GROUP"] as const;
export type Criterion = (typeof CRITERIA)[number];
export type GroupBasis = "HOURS" | "RESOURCE_QUANTITY" | "RESOURCE_VALUE";

export interface Classification {
  id: string;
  name: string;
}
export interface AccountRule {
  account: string;
  name: string;
  classificationId: string;
  criterion: Criterion;
  /** Missing only in legacy configurations: the previous rule was explicitly 100%. */
  percent?: string;
  active: boolean;
}
export interface GroupShare {
  account: string;
  group: string;
  percent: string;
  basis?: GroupBasis;
}
export interface Configuration {
  classifications: Classification[];
  accounts: AccountRule[];
  groupShares: GroupShare[];
}
export interface PeriodFilter {
  start: string;
  end: string;
  branch: string;
  costCenter: string;
}
export interface AccountBalance {
  account: string;
  amount: string;
  currency: string;
  readId: string;
  sourceRefs: string[];
}

export type SourceDataset = "balances" | "production" | "currentCosts";

/** References describe business evidence, never an assumed SAP query or endpoint. */
export interface ReadEvidence {
  id: string;
  dataset: SourceDataset;
  sourceRef: string;
  filter: PeriodFilter;
  pagesRead: number;
  receivedRows: number;
  expectedRows: number;
  exhausted: boolean;
  /** Independent count/reconciliation evidence, not merely the number of rows received. */
  reconciliationRef: string;
  /** Rows read completely but outside the explicitly selected order/account set. */
  excludedSourceRefs?: string[];
  exclusionRef?: string;
  requestPath?: string;
  controlPath?: string;
  scope?: string;
}
export interface BasisEvidence {
  /** Unit after normalization. Hours use h; monetary values use the snapshot currency. */
  unit: string;
  /** Same unit alone does not make different products or costing policies comparable. */
  comparisonKey: string;
  /** Versioned rule with source units, conversions and scope, retained by the adapter. */
  normalizationRef: string;
  readId: string;
  sourceRefs: string[];
  supportingReads?: Array<{ readId: string; sourceRefs: string[] }>;
}
export interface OrderBasis {
  id: string;
  number: string;
  item: string;
  directCost: string | null;
  quantity: string | null;
  hours: string | null;
  groupHours: Record<string, string>;
  /** Total current cost of the order, not a unit cost or stock valuation. */
  currentCost: string | null;
  unavailable?: Partial<Record<"directCost" | "quantity" | "hours" | "currentCost", string>>;
  directCostComponents?: Array<{
    kind: string;
    code: string;
    amount: string;
    sourceRefs: string[];
  }>;
  resourceBases?: Record<
    string,
    Partial<
      Record<
        GroupBasis,
        {
          value: string;
          evidence: BasisEvidence;
          resourceRefs: string[];
        }
      >
    >
  >;
  sourceRefs: string[];
  basisEvidence: {
    quantity: BasisEvidence | null;
    /** Applies to both hours and groupHours, including the resource-to-group mapping. */
    hours: BasisEvidence | null;
    directCost: BasisEvidence | null;
    currentCost: BasisEvidence | null;
  };
}
/** Normalized business data. No SAP entity or field names are assumed here. */
export interface SourceSnapshot {
  id: string;
  origin: "development" | "sap";
  capturedAt: string;
  filter: PeriodFilter;
  balances: AccountBalance[];
  orders: OrderBasis[];
  evidence: {
    currency: string;
    reads: ReadEvidence[];
  };
}
export interface AllocationTrace {
  account: string;
  classificationId: string;
  criterion: Criterion;
  orderId: string;
  group: string;
  percent: string;
  accountPercent: string;
  applicableAmount: bigint;
  accountRoundingNumerator: bigint;
  groupRoundingMinor: bigint;
  groupRemainder: bigint;
  basisUnit: string;
  basisKind: string;
  participationPercent: string;
  accountAmount: bigint;
  poolAmount: bigint;
  basis: bigint;
  totalBasis: bigint;
  basisDecimals: number;
  /** Fractional cent before largest-remainder adjustment. */
  remainder: bigint;
  roundingMinor: bigint;
  amount: bigint;
}
export interface AllocationResult {
  snapshot: SourceSnapshot;
  configuration: Configuration;
  total: bigint;
  distributed: bigint;
  difference: bigint;
  criteria: Array<{ criterion: Criterion; amount: bigint }>;
  accounts: Array<{
    account: string;
    periodAmount: bigint;
    percent: string;
    applicableAmount: bigint;
    roundingNumerator: bigint;
    distributed: bigint;
    difference: bigint;
  }>;
  orders: Array<{
    order: OrderBasis;
    allocated: bigint;
    current: bigint | null;
    resulting: bigint | null;
  }>;
  traces: AllocationTrace[];
}
