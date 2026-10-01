import type { GgfPostingPlan, GgfPostingPlanDocument } from "./GgfPostingPlan";
import { calculateGgfPostingPlanHash } from "./GgfPostingPlan";
import type { PostingBasis } from "./GgfClosing";

export const GGF_PHASE7C = {
  companyDB: "SBODEMOBR2",
  date: "2026-10-01",
  branch: "1",
  currency: "R$",
  amountCents: "100",
  debitAccount: "5.01.01.01.01",
  creditAccount: "5.04.01.01.05",
  memo: "HOMOLOGAÇÃO TÉCNICA FACTORYONE GGF"
} as const;

export function buildGgfPhase7CJournalEntry(closingId: string): Record<string, unknown> {
  if (!/^TECH7C-[A-Z0-9-]{8,22}$/.test(closingId)) throw new Error("Invalid Phase 7C ClosingId");
  return {
    ReferenceDate: GGF_PHASE7C.date,
    DueDate: GGF_PHASE7C.date,
    TaxDate: GGF_PHASE7C.date,
    Reference: closingId,
    Memo: GGF_PHASE7C.memo,
    JournalEntryLines: [
      { AccountCode: GGF_PHASE7C.debitAccount, Debit: 1, Credit: 0, BPLID: 1, LineMemo: GGF_PHASE7C.memo },
      { AccountCode: GGF_PHASE7C.creditAccount, Debit: 0, Credit: 1, BPLID: 1, LineMemo: GGF_PHASE7C.memo }
    ]
  };
}

export async function buildGgfPhase7CPostingPlan(input: {
  closingId: string; at: string; createdBy: string | null;
}): Promise<GgfPostingPlan> {
  const line: GgfPostingPlanDocument["lines"][number] = {
    orderNumber: input.closingId, item: null, warehouse: null, category: "GGF", accountOriginal: null,
    criterion: "TECHNICAL_CPV", quantity: null, unit: null, amountCents: GGF_PHASE7C.amountCents,
    debitAccount: GGF_PHASE7C.debitAccount, creditAccount: GGF_PHASE7C.creditAccount, dimensions: [],
    sourceOrderRefs: [], status: "VALIDATED", blockers: [], dependencies: [], payload: null
  };
  const plan: GgfPostingPlan = {
    closingId: input.closingId, version: 1, closingVersion: 4, postingHash: "", createdAt: input.at,
    createdBy: input.createdBy, status: "VALIDATED", companyDB: GGF_PHASE7C.companyDB,
    periodStart: GGF_PHASE7C.date, periodEnd: GGF_PHASE7C.date, branch: GGF_PHASE7C.branch,
    dimensions: [], currency: GGF_PHASE7C.currency, currencySource: "CompanyService_GetAdminInfo.LocalCurrency",
    totalMod: "0", totalGgf: GGF_PHASE7C.amountCents, totalStock: "0", totalCpv: GGF_PHASE7C.amountCents,
    totalBlocked: "0", totalDifference: "0", accountingDifference: "0",
    lines: [{ id: `${input.closingId}:CPV`, orderNumber: input.closingId, item: "N/A",
      accountOriginal: GGF_PHASE7C.debitAccount, category: "GGF", criterion: "TECHNICAL_CPV",
      quantity: null, unit: null, amountCents: GGF_PHASE7C.amountCents, stockCents: "0",
      consumedCents: GGF_PHASE7C.amountCents, valuationMethod: null, dimensions: [],
      futureDocumentTypes: ["JournalEntry.CPV"], effects: [{ documentType: "JournalEntry.CPV",
        amountCents: GGF_PHASE7C.amountCents, debitAccount: GGF_PHASE7C.debitAccount,
        creditAccount: GGF_PHASE7C.creditAccount }], debitAccounts: [GGF_PHASE7C.debitAccount],
      creditAccounts: [GGF_PHASE7C.creditAccount], status: "READY", blockers: [], sourceRefs: [] }],
    documents: [{ type: "JournalEntry.CPV", order: 1, totalCents: GGF_PHASE7C.amountCents,
      currency: GGF_PHASE7C.currency, lines: [line], dimensions: [[]], status: "VALIDATED",
      blockers: [], dependencies: [], payload: null }],
    blockers: [], sourceMode: "SAP_READ_ONLY", sourceCapturedAt: input.at, postingBlocked: true,
    technicalOnly: true
  };
  plan.postingHash = await calculateGgfPostingPlanHash(plan);
  return plan;
}

export function buildGgfPhase7CClosingBasis(input: {
  closingId: string; plan: GgfPostingPlan; payload: Record<string, unknown>;
}): PostingBasis {
  if (input.plan.closingVersion !== 4 || input.plan.version !== 1)
    throw new Error("Phase 7C technical identity must bind closing version 4 and plan version 1");
  return {
    documentType: "JournalEntry.CPV", postingPlanHash: input.plan.postingHash,
    postingClosingVersion: input.plan.closingVersion, postingPlanVersion: input.plan.version,
    companyDB: GGF_PHASE7C.companyDB, periodStart: GGF_PHASE7C.date, periodEnd: GGF_PHASE7C.date,
    branch: GGF_PHASE7C.branch, dimensions: {},
    totals: { ggf: "1.00", allocated: "1.00", revalued: "0.00" },
    accounts: [
      { account: GGF_PHASE7C.debitAccount, amount: "1.00", percent: "100", criterion: "TECHNICAL_CPV_DEBIT" },
      { account: GGF_PHASE7C.creditAccount, amount: "1.00", percent: "100", criterion: "TECHNICAL_CPV_CREDIT" }
    ],
    lines: [{ account: GGF_PHASE7C.debitAccount, criterion: "TECHNICAL_CPV", orderId: input.closingId,
      item: "N/A", warehouse: "N/A", basis: "100 cents", percent: "100", allocated: "1.00",
      costBefore: "0.00", costAfter: "0.00", revaluation: "0.00", status: "READY" }],
    inventoryAccounts: {}, payload: structuredClone(input.payload)
  };
}
