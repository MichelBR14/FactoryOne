export type AccountingCategory = "MOD" | "GGF";
export type AccountingLineStatus =
  | "READY_FOR_STOCK_REVALUATION"
  | "READY_FOR_CPV_ADJUSTMENT"
  | "ACCOUNTING_CONFIG_INCOMPLETE"
  | "CPV_ACCOUNTING_NOT_CONFIGURED"
  | "STOCK_TRACE_INCOMPLETE"
  | "CPV_CLASSIFICATION_MISSING"
  | "NEGATIVE_STOCK"
  | "VALUATION_METHOD_NOT_HOMOLOGATED"
  | "BLOCKED";

export interface AccountingPreviewConfig {
  transitoryGgfAccount?: string;
  transitoryModAccount?: string;
  closingGgfAccount?: string;
  closingModAccount?: string;
  cpvAccount?: string;
  inventoryAccounts?: Record<string, string>;
  dimensionsByLine?: Record<string, string[]>;
  cpvEligibleOperationKeys?: string[];
  requireDimensions?: boolean;
}

export interface AccountingPreviewLineInput {
  closingId: string | null;
  version: number | null;
  orderNumber: string;
  item: string;
  warehouse: string | null;
  category: AccountingCategory;
  accountOriginal: string | null;
  criterion: string | null;
  quantity: string | null;
  unit: string | null;
  amountCents: string;
  stockCents: string | null;
  consumedCents: string | null;
  stockTraceStatus: string;
  valuationMethod: string | null;
  inventoryAccountFromSap?: { account: string | null; origin: string; verified: boolean; refs: string[] };
  consumedOperationKey?: string | null;
  sourceRefs: string[];
}

export interface AccountingEntryPreview {
  documentType: "MaterialRevaluation" | "JournalEntry.CPV" | "JournalEntry.Closing";
  category: AccountingCategory;
  orderNumber: string | null;
  item: string | null;
  warehouse: string | null;
  closingId: string | null;
  version: number | null;
  accountOriginal: string | null;
  criterion: string | null;
  quantity: string | null;
  unit: string | null;
  origin: "STOCK" | "CONSUMED" | "CLOSING";
  amountCents: string;
  debitAccount: string;
  creditAccount: string;
  debitCents: string;
  creditCents: string;
  dimensions: string[];
  sourceRefs: string[];
  payload: null;
}

const accountOk = (value: string | undefined): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._-]{1,50}$/.test(value);
const integer = (value: string): bigint | null => /^-?\d+$/.test(value) ? BigInt(value) : null;
const categoryAccount = (config: AccountingPreviewConfig, category: AccountingCategory, role: "transitory" | "closing") =>
  role === "transitory"
    ? category === "GGF" ? config.transitoryGgfAccount : config.transitoryModAccount
    : category === "GGF" ? config.closingGgfAccount : config.closingModAccount;
const lineKey = (line: AccountingPreviewLineInput) =>
  `${line.orderNumber}/${line.item}/${line.warehouse ?? ""}/${line.category}`;

function entry(input: Omit<AccountingEntryPreview, "debitCents" | "creditCents" | "payload">): AccountingEntryPreview {
  const amount = BigInt(input.amountCents);
  const abs = amount < 0n ? -amount : amount;
  return { ...input, debitCents: abs.toString(), creditCents: abs.toString(), payload: null };
}

/** Plans accounting effects only when source proof and every required account are explicit. */
export function buildAccountingPreview(
  totals: Record<AccountingCategory, string>,
  lines: readonly AccountingPreviewLineInput[],
  config: AccountingPreviewConfig
) {
  const inventoryAccounts = config.inventoryAccounts && typeof config.inventoryAccounts === "object" && !Array.isArray(config.inventoryAccounts)
    ? config.inventoryAccounts : {};
  const dimensionsByLine = config.dimensionsByLine && typeof config.dimensionsByLine === "object" && !Array.isArray(config.dimensionsByLine)
    ? config.dimensionsByLine : {};
  const cpvEligibleOperationKeys = Array.isArray(config.cpvEligibleOperationKeys)
    ? config.cpvEligibleOperationKeys.filter((value): value is string => typeof value === "string") : [];
  const requireDimensions = config.requireDimensions !== false;
  const summaries = ( ["MOD", "GGF"] as const).map(category => ({
    category, toAbsorbCents: integer(totals[category]) ?? 0n,
    stockCents: 0n, cpvCents: 0n, blockedCents: 0n
  }));
  const entries: AccountingEntryPreview[] = [];
  const rows = lines.map(line => {
    const total = integer(line.amountCents);
    const stock = line.stockCents === null ? null : integer(line.stockCents);
    const consumed = line.consumedCents === null ? null : integer(line.consumedCents);
    const summary = summaries.find(row => row.category === line.category)!;
    const reasons: AccountingLineStatus[] = [];
    if (total === null || stock === null || consumed === null || stock + consumed !== total)
      reasons.push("STOCK_TRACE_INCOMPLETE");
    const traceReady = total !== null && stock !== null && consumed !== null && stock + consumed === total;
    const configuredDimensions = dimensionsByLine[lineKey(line)];
    const dimensions = Array.isArray(configuredDimensions)
      ? configuredDimensions.filter((value): value is string => typeof value === "string") : [];
    if (requireDimensions && !dimensions.length) reasons.push("ACCOUNTING_CONFIG_INCOMPLETE");

    let stockStatus: AccountingLineStatus = "BLOCKED";
    let consumedStatus: AccountingLineStatus = "BLOCKED";
    if (traceReady && stock !== 0n) {
      let status: AccountingLineStatus | null = null;
      if (line.stockTraceStatus === "BLOCKED_STOCK_NEGATIVE") status = "NEGATIVE_STOCK";
      else if (line.valuationMethod !== "bis_FIFO") status = "VALUATION_METHOD_NOT_HOMOLOGATED";
      else if (line.stockTraceStatus !== "STOCK_REVALUATION_CANDIDATE" || !line.warehouse) status = "STOCK_TRACE_INCOMPLETE";
      const sapAccount = line.inventoryAccountFromSap;
      const explicitInventory = inventoryAccounts[`${line.item}/${line.warehouse ?? ""}`];
      const inventoryAccount = sapAccount?.verified && accountOk(sapAccount.account ?? undefined)
        ? sapAccount.account! : accountOk(explicitInventory) ? explicitInventory : null;
      const transitory = categoryAccount(config, line.category, "transitory");
      const closing = categoryAccount(config, line.category, "closing");
      if (!status && (!inventoryAccount || !accountOk(transitory) || !accountOk(closing) || (requireDimensions && !dimensions.length)))
        status = "ACCOUNTING_CONFIG_INCOMPLETE";
      if (status) {
        stockStatus = status;
        reasons.push(status);
      } else {
        stockStatus = "READY_FOR_STOCK_REVALUATION";
        const positive = stock! > 0n;
        const inventory = inventoryAccount!;
        entries.push(entry({ documentType: "MaterialRevaluation", category: line.category,
          orderNumber: line.orderNumber, item: line.item, warehouse: line.warehouse,
          closingId: line.closingId, version: line.version, accountOriginal: line.accountOriginal,
          criterion: line.criterion, quantity: line.quantity, unit: line.unit, origin: "STOCK",
          amountCents: stock!.toString(), debitAccount: positive ? inventory : transitory!,
          creditAccount: positive ? transitory! : inventory, dimensions, sourceRefs: [...line.sourceRefs, ...(sapAccount?.refs ?? [])] }));
        summary.stockCents += stock!;
      }
    }
    if (traceReady && consumed !== 0n) {
      const eligible = !!line.consumedOperationKey &&
        cpvEligibleOperationKeys.includes(line.consumedOperationKey);
      const cpv = config.cpvAccount;
      const transitory = categoryAccount(config, line.category, "transitory");
      const closing = categoryAccount(config, line.category, "closing");
      let status: AccountingLineStatus | null = null;
      if (!eligible) status = "CPV_CLASSIFICATION_MISSING";
      else if (!accountOk(cpv)) status = "CPV_ACCOUNTING_NOT_CONFIGURED";
      else if (!accountOk(transitory) || !accountOk(closing) || (requireDimensions && !dimensions.length))
        status = "ACCOUNTING_CONFIG_INCOMPLETE";
      if (status) {
        consumedStatus = status;
        reasons.push(status);
      } else {
        consumedStatus = "READY_FOR_CPV_ADJUSTMENT";
        const positive = consumed! > 0n;
        entries.push(entry({ documentType: "JournalEntry.CPV", category: line.category,
          orderNumber: line.orderNumber, item: line.item, warehouse: line.warehouse,
          closingId: line.closingId, version: line.version, accountOriginal: line.accountOriginal,
          criterion: line.criterion, quantity: line.quantity, unit: line.unit, origin: "CONSUMED",
          amountCents: consumed!.toString(), debitAccount: positive ? cpv! : transitory!,
          creditAccount: positive ? transitory! : cpv!, dimensions, sourceRefs: line.sourceRefs }));
        summary.cpvCents += consumed!;
      }
    }
    const lineReady = (stock === 0n || stockStatus === "READY_FOR_STOCK_REVALUATION") &&
      (consumed === 0n || consumedStatus === "READY_FOR_CPV_ADJUSTMENT");
    if (!lineReady && total !== null) summary.blockedCents += total -
      ((stockStatus === "READY_FOR_STOCK_REVALUATION" && stock !== null ? stock : 0n) +
       (consumedStatus === "READY_FOR_CPV_ADJUSTMENT" && consumed !== null ? consumed : 0n));
    return { ...line, id: lineKey(line), totalCents: total?.toString() ?? null,
      stockCents: stock?.toString() ?? null, consumedCents: consumed?.toString() ?? null,
      stockStatus, consumedStatus, reasons: [...new Set(reasons)], dimensions,
      status: lineReady ? "READY" as const : reasons[0] ?? "BLOCKED" as const,
      payload: null as null };
  });

  for (const summary of summaries) {
    const accounted = summary.stockCents + summary.cpvCents + summary.blockedCents;
    if (accounted !== summary.toAbsorbCents) summary.blockedCents += summary.toAbsorbCents - accounted;
    const closing = categoryAccount(config, summary.category, "closing");
    const transitory = categoryAccount(config, summary.category, "transitory");
    const amount = summary.stockCents + summary.cpvCents;
    if (amount === 0n) continue;
    if (!accountOk(closing) || !accountOk(transitory)) {
      summary.blockedCents += amount;
      summary.stockCents = 0n;
      summary.cpvCents = 0n;
      continue;
    }
    const byDimensions = new Map<string, { dimensions: string[]; amount: bigint }>();
    for (const line of entries.filter(row => row.category === summary.category && row.origin !== "CLOSING")) {
      const key = JSON.stringify(line.dimensions);
      const group = byDimensions.get(key) ?? { dimensions: line.dimensions, amount: 0n };
      group.amount += BigInt(line.amountCents);
      byDimensions.set(key, group);
    }
    for (const group of byDimensions.values()) {
      if (group.amount === 0n) continue;
      const positive = group.amount > 0n;
      entries.push(entry({ documentType: "JournalEntry.Closing", category: summary.category,
        orderNumber: null, item: null, warehouse: null, closingId: null, version: null,
        accountOriginal: null, criterion: null, quantity: null, unit: null, origin: "CLOSING",
        amountCents: group.amount.toString(), debitAccount: positive ? transitory : closing,
        creditAccount: positive ? closing : transitory, dimensions: group.dimensions, sourceRefs: [] }));
    }
  }

  const documents = (["MaterialRevaluation", "JournalEntry.CPV", "JournalEntry.Closing"] as const).map(documentType => {
    const documentLines = entries.filter(row => row.documentType === documentType);
    const debitsCents = documentLines.reduce((sum, row) => sum + BigInt(row.debitCents), 0n);
    const creditsCents = documentLines.reduce((sum, row) => sum + BigInt(row.creditCents), 0n);
    return { documentType, status: documentLines.length ? "PREVIEW_ONLY" as const : "BLOCKED" as const,
      lineCount: documentLines.length, debitsCents: debitsCents.toString(), creditsCents: creditsCents.toString(),
      balanced: debitsCents === creditsCents, lines: documentLines, payload: null as null,
      reason: documentLines.length ? "Efeito contábil conceitual; payload financeiro não gerado." : "Nenhuma linha apta ou configuração incompleta." };
  });
  const total = summaries.reduce((sum, row) => sum + row.toAbsorbCents, 0n);
  const stock = summaries.reduce((sum, row) => sum + row.stockCents, 0n);
  const cpv = summaries.reduce((sum, row) => sum + row.cpvCents, 0n);
  const blocked = summaries.reduce((sum, row) => sum + row.blockedCents, 0n);
  const debits = entries.reduce((sum, row) => sum + BigInt(row.debitCents), 0n);
  const credits = entries.reduce((sum, row) => sum + BigInt(row.creditCents), 0n);
  return { summaries: summaries.map(row => ({ ...row, toAbsorbCents: row.toAbsorbCents.toString(),
      stockCents: row.stockCents.toString(), cpvCents: row.cpvCents.toString(), blockedCents: row.blockedCents.toString(),
      differenceCents: (row.toAbsorbCents - row.stockCents - row.cpvCents - row.blockedCents).toString() })),
    rows, entries, documents, totals: { toAbsorbCents: total.toString(), stockCents: stock.toString(),
      cpvCents: cpv.toString(), blockedCents: blocked.toString(), differenceCents: (total - stock - cpv - blocked).toString(),
      debitsCents: debits.toString(), creditsCents: credits.toString(), accountingDifferenceCents: (debits - credits).toString() },
    payload: null as null, postingBlocked: true as const };
}
