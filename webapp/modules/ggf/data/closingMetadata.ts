import type { MetadataSet } from "../../../core/data/metadata";

const alpha = (name: string, size: number) => ({ name, description: name, type: "alpha" as const, size });
const memo = (name: string) => ({ name, description: name, type: "memo" as const });

/** Native SAP UDT/UDO schema. Installation is separate from package build and posting. */
export const GGF_CLOSING_METADATA: MetadataSet = {
  module: "ggf",
  version: 3,
  tables: [
    { name: "CLOSE", description: "FactoryOne GGF closing", kind: "masterData", fields: [
      alpha("CompanyDB", 50), alpha("PeriodStart", 10), alpha("PeriodEnd", 10),
      alpha("Branch", 50), memo("Dimensions"), alpha("Status", 20),
      alpha("Version", 12), alpha("CreatedAt", 30), alpha("CreatedBy", 50),
      alpha("CalculatedAt", 30), alpha("PostedAt", 30), alpha("TotalGgf", 30),
      alpha("TotalAllocated", 30), alpha("TotalRevalued", 30),
      alpha("SapDocEntry", 20), alpha("SapDocNum", 20), alpha("SapTransId", 20),
      alpha("PostingHash", 64), alpha("ReopenedFrom", 50), alpha("CancelledAt", 30),
      memo("Notes"), memo("PostingBasis"), memo("ProposedPayload"), memo("LastError"),
      alpha("LineVersion", 12)
    ] },
    { name: "CLINE", description: "FactoryOne GGF audit line", kind: "masterData", fields: [
      alpha("ClosingId", 50), alpha("Version", 12), alpha("Account", 50), alpha("Criterion", 30),
      alpha("OrderId", 30), alpha("Item", 50), alpha("Warehouse", 20),
      alpha("Basis", 40), alpha("Percent", 30), alpha("Allocated", 30),
      alpha("CostBefore", 30), alpha("CostAfter", 30), alpha("Revaluation", 30),
      alpha("Status", 20)
    ] },
    { name: "CLAIM", description: "F1 GGF posting claim", kind: "masterData", fields: [
      alpha("ClosingId", 50), alpha("PostingHash", 64), alpha("ClaimedAt", 30),
      alpha("Version", 12)
    ] },
    { name: "CVERS", description: "F1 GGF closing version", kind: "masterData", fields: [
      alpha("ClosingId", 50), alpha("Version", 12), alpha("LineVersion", 12),
      alpha("PostingHash", 64), memo("PostingBasis"), alpha("Status", 20),
      alpha("RecordedAt", 30), alpha("TechnicalOnly", 5)
    ] },
    { name: "PPLAN", description: "F1 GGF Plan", kind: "masterData", fields: [
      alpha("ClosingId", 50), alpha("Version", 12), alpha("PostingPlanVersion", 12),
      alpha("PostingHash", 64), alpha("CreatedAt", 30), alpha("CreatedBy", 50),
      alpha("Status", 20), alpha("TotalMod", 30), alpha("TotalGgf", 30),
      alpha("TotalStock", 30), alpha("TotalCpv", 30), alpha("TotalBlocked", 30),
      alpha("AcctDifference", 30), memo("PlanSnapshot")
    ] }
  ],
  objects: [
    { table: "CLOSE", name: "FactoryOne GGF closing", kind: "masterData", canDelete: false, applyAuthorization: true },
    { table: "CLINE", name: "FactoryOne GGF closing line", kind: "masterData", canDelete: false, applyAuthorization: true },
    { table: "CLAIM", name: "FactoryOne GGF posting claim", kind: "masterData", canDelete: false, applyAuthorization: true },
    { table: "CVERS", name: "FactoryOne GGF closing version", kind: "masterData", canDelete: false, applyAuthorization: true },
    { table: "PPLAN", name: "FactoryOne GGF posting plan", kind: "masterData", canDelete: false, applyAuthorization: true }
  ]
};
