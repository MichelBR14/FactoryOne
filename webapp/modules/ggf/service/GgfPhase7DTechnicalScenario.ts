import { calculateGgfPostingPlanHash, type GgfPostingPlan } from "./GgfPostingPlan";
import type { PostingBasis } from "./GgfClosing";

export const GGF_PHASE7D = {
  companyDB: "SBODEMOBR2", date: "2026-10-01", branch: "1", currency: "R$",
  totalCents: "100", ggfCents: "60", modCents: "40",
  transitAccount: "5.04.01.01.05", ggfAccount: "5.04.01.01.03", modAccount: "5.04.01.01.04",
  memo: "HOMOLOGAÇÃO TÉCNICA FACTORYONE GGF FASE 7D"
} as const;

export function buildGgfPhase7DJournalEntry(closingId: string): Record<string, unknown> {
  if (!/^TECH7D-20261001-[A-F0-9]{10}$/.test(closingId)) throw new Error("Invalid Phase 7D ClosingId");
  return {
    ReferenceDate: GGF_PHASE7D.date, DueDate: GGF_PHASE7D.date, TaxDate: GGF_PHASE7D.date,
    Reference: closingId, Memo: GGF_PHASE7D.memo,
    JournalEntryLines: [
      { AccountCode: GGF_PHASE7D.transitAccount, Debit: 1, Credit: 0, BPLID: 1, LineMemo: GGF_PHASE7D.memo },
      { AccountCode: GGF_PHASE7D.ggfAccount, Debit: 0, Credit: 0.6, BPLID: 1, LineMemo: GGF_PHASE7D.memo },
      { AccountCode: GGF_PHASE7D.modAccount, Debit: 0, Credit: 0.4, BPLID: 1, LineMemo: GGF_PHASE7D.memo }
    ]
  };
}

export async function buildGgfPhase7DPostingPlan(input: { closingId: string; at: string }): Promise<GgfPostingPlan> {
  const pairs = [
    { category: "GGF" as const, account: GGF_PHASE7D.ggfAccount, cents: GGF_PHASE7D.ggfCents },
    { category: "MOD" as const, account: GGF_PHASE7D.modAccount, cents: GGF_PHASE7D.modCents }
  ];
  const documentLines = pairs.map(row => ({ orderNumber: input.closingId, item: null, warehouse: null,
    category: row.category, accountOriginal: row.account, criterion: "TECHNICAL_CLOSING",
    quantity: null, unit: null, amountCents: row.cents, debitAccount: GGF_PHASE7D.transitAccount,
    creditAccount: row.account, dimensions: [], sourceOrderRefs: [], status: "VALIDATED" as const,
    blockers: [] as [], dependencies: [], payload: null }));
  const plan: GgfPostingPlan = {
    technicalOnly: true, closingId: input.closingId, version: 1, closingVersion: 4, postingHash: "",
    createdAt: input.at, createdBy: "FACTORYONE_PHASE7D_TEST", status: "VALIDATED",
    companyDB: GGF_PHASE7D.companyDB, periodStart: GGF_PHASE7D.date, periodEnd: GGF_PHASE7D.date,
    branch: GGF_PHASE7D.branch, dimensions: [], currency: GGF_PHASE7D.currency,
    currencySource: "CompanyService_GetAdminInfo.LocalCurrency", totalMod: "40", totalGgf: "60",
    totalStock: "0", totalCpv: "0", totalBlocked: "0", totalDifference: "0", accountingDifference: "0",
    lines: pairs.map((row, index) => ({ id: `${input.closingId}:${row.category}`, orderNumber: input.closingId,
      item: "N/A", accountOriginal: row.account, category: row.category, criterion: "TECHNICAL_CLOSING",
      quantity: null, unit: null, amountCents: row.cents, stockCents: "0", consumedCents: row.cents,
      valuationMethod: null, dimensions: [], futureDocumentTypes: ["JournalEntry.Closing"],
      effects: [{ documentType: "JournalEntry.Closing", amountCents: row.cents,
        debitAccount: GGF_PHASE7D.transitAccount, creditAccount: row.account }],
      debitAccounts: [GGF_PHASE7D.transitAccount], creditAccounts: [row.account], status: "READY",
      blockers: [], sourceRefs: [`TECHNICAL_LINE_${index + 1}`] })),
    documents: [{ type: "JournalEntry.Closing", order: 1, totalCents: GGF_PHASE7D.totalCents,
      currency: GGF_PHASE7D.currency, lines: documentLines, dimensions: [[], []], status: "VALIDATED",
      blockers: [], dependencies: [], payload: null }],
    blockers: [], sourceMode: "SAP_READ_ONLY", sourceCapturedAt: input.at, postingBlocked: true
  };
  plan.postingHash = await calculateGgfPostingPlanHash(plan);
  return plan;
}

export function buildGgfPhase7DClosingBasis(input: { closingId: string; plan: GgfPostingPlan;
  payload: Record<string, unknown> }): PostingBasis {
  if (input.plan.closingVersion !== 4 || input.plan.version !== 1) throw new Error("Invalid Phase 7D plan identity");
  const lines = [
    { account: GGF_PHASE7D.ggfAccount, criterion: "TECHNICAL_CLOSING_GGF", orderId: input.closingId,
      item: "N/A", warehouse: "N/A", basis: "60 centavos definidos para homologação", percent: "60",
      allocated: "0.60", costBefore: "0.00", costAfter: "0.00", revaluation: "0.00", status: "READY" },
    { account: GGF_PHASE7D.modAccount, criterion: "TECHNICAL_CLOSING_MOD", orderId: input.closingId,
      item: "N/A", warehouse: "N/A", basis: "40 centavos definidos para homologação", percent: "40",
      allocated: "0.40", costBefore: "0.00", costAfter: "0.00", revaluation: "0.00", status: "READY" }
  ];
  return { documentType: "JournalEntry.Closing", postingPlanHash: input.plan.postingHash,
    postingClosingVersion: 4, postingPlanVersion: 1, companyDB: GGF_PHASE7D.companyDB,
    periodStart: GGF_PHASE7D.date, periodEnd: GGF_PHASE7D.date, branch: GGF_PHASE7D.branch, dimensions: {},
    totals: { ggf: "1.00", allocated: "1.00", revalued: "0.00" },
    accounts: [
      { account: GGF_PHASE7D.ggfAccount, amount: "0.60", percent: "60", criterion: "TECHNICAL_CLOSING_GGF" },
      { account: GGF_PHASE7D.modAccount, amount: "0.40", percent: "40", criterion: "TECHNICAL_CLOSING_MOD" }
    ], lines, inventoryAccounts: {}, payload: structuredClone(input.payload) };
}
