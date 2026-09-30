import { formatDecimal, parseDecimal } from "../../../core/util/money";
import { GgfError } from "../engine/errors";
import { validatePeriod } from "../engine/allocation";
import type { PeriodFilter, SourceDataset } from "../engine/types";
import {
  MappedGgfSource,
  type GgfReadClient,
  type GgfReadDefinition,
  type GgfReadMapping
} from "./MappedGgfSource";

type Row = Record<string, unknown>;
function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid SAP record");
  return value as Row;
}
function collection(value: unknown): Row[] {
  if (!Array.isArray(value)) throw new Error("Missing SAP lines");
  return value.map(row);
}
function id(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  throw new Error("Missing SAP key");
}
function money(value: unknown): bigint {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) >= 1e12)
    throw new Error("Invalid SAP amount");
  // Preserve six source decimals for diagnostics; no allocation or presumed ISO currency.
  const decimal = String(value);
  if (!/^-?\d+(\.\d{1,6})?$/.test(decimal)) throw new Error("Unsupported SAP monetary precision");
  return parseDecimal(decimal, 6);
}
function dateClause(field: string, filter: PeriodFilter): string {
  return `${field} ge '${filter.start}' and ${field} le '${filter.end}'`;
}
function definition(
  entity: string,
  key: string,
  dataset: SourceDataset,
  select: string,
  clause = ""
): GgfReadDefinition {
  const query = clause ? `&$filter=${encodeURIComponent(clause)}` : "";
  return {
    id: entity,
    dataset,
    sourceRef: `/b1s/v2/${entity}`,
    dataPath: `${entity}?$select=${select}&$orderby=${key}${query}`,
    controlPath: `${entity}/$count${clause ? `?$filter=${encodeURIComponent(clause)}` : ""}`,
    rowId: (value) => id(row(value)[key]),
    decodeControl: (value) => {
      if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("Invalid SAP count");
      return {
        expectedRows: Number(value),
        reconciliationRef: `${entity}/$count; structural control only`
      };
    }
  };
}

export { definition as defineSapRead };

/** Verified entity/field reads, NOT an approved conversion into allocation bases. */
export const sapB1ReadMapping: GgfReadMapping = {
  reads(filter) {
    validatePeriod(filter);
    if (filter.branch || filter.costCenter)
      throw new Error("Branch/dimension scope is not approved for SAP GGF");
    return [
      definition(
        "ChartOfAccounts",
        "Code",
        "balances",
        "Code,Name,ActiveAccount,AccountType,AcctCurrency"
      ),
      definition(
        "JournalEntries",
        "JdtNum",
        "balances",
        "JdtNum,ReferenceDate,OriginalJournal,JournalEntryLines",
        dateClause("ReferenceDate", filter)
      ),
      // Full order/resource inventory: no eligibility or release/closing-date rule presumed.
      definition(
        "ProductionOrders",
        "AbsoluteEntry",
        "production",
        "AbsoluteEntry,DocumentNumber,ItemNo,PostingDate,ClosingDate,CompletedQuantity,InventoryUOM,ProductionOrderStatus,ProductionOrderLines"
      ),
      ...["InventoryGenEntries", "InventoryGenExits"].map((entity) =>
        definition(
          entity,
          "DocEntry",
          "production",
          "DocEntry,DocNum,DocDate,DocCurrency,DocTotal,Cancelled,TransNum,BPL_IDAssignedToInvoice,DocumentLines",
          dateClause("DocDate", filter)
        )
      ),
      definition("Resources", "Code", "production", "Code,Name,Group,UnitOfMeasure,Cost1"),
      definition("ResourceGroups", "Code", "production", "Code,Name,NumOfUnitsText"),
      definition(
        "ProjectManagementTimeSheet",
        "AbsEntry",
        "production",
        "AbsEntry,DateFrom,DateTo"
      ),
      definition("BusinessPlaces", "BPLID", "balances", "BPLID,BPLName"),
      definition("UnitOfMeasurements", "AbsEntry", "production", "AbsEntry,Code,Name")
    ];
  },
  normalize(): never {
    throw new GgfError("sourceRead", [
      "SAP normalization pending: order cost, hours, units, eligibility and GGF accounts"
    ]);
  }
};

const lineFields = [
  "Line_ID",
  "AccountCode",
  "Debit",
  "Credit",
  "DebitSys",
  "CreditSys",
  "FCDebit",
  "FCCredit",
  "FCCurrency",
  "BPLID",
  "CostingCode",
  "CostingCode2",
  "CostingCode3",
  "CostingCode4",
  "CostingCode5"
];
function lineSignature(lines: Row[]): string {
  const ids = lines.map((line) => id(line.Line_ID));
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate journal line");
  return JSON.stringify(
    [...lines]
      .sort((a, b) => id(a.Line_ID).localeCompare(id(b.Line_ID)))
      .map((line) => lineFields.map((field) => line[field]))
  );
}

export async function inspectSapB1(client: GgfReadClient, filter: PeriodFilter) {
  const startedAt = new Date().toISOString();
  const source = new MappedGgfSource(client, sapB1ReadMapping);
  const definitions = sapB1ReadMapping.reads(filter, {
    classifications: [],
    accounts: [],
    groupShares: []
  });
  const { rows, evidence } = await source.inspectSources(filter, definitions);
  const records = (name: string) => (rows.get(name) ?? []).map(row);
  const journals = records("JournalEntries");
  const accountNames = new Map(records("ChartOfAccounts").map((a) => [id(a.Code), String(a.Name)]));
  const accounts = new Map<
    string,
    { account: string; name: string; debit: bigint; credit: bigint; refs: string[] }
  >();
  let debit = 0n,
    credit = 0n,
    linesCount = 0;
  const differences: string[] = [];
  for (const journal of journals) {
    const key = id(journal.JdtNum);
    const lines = collection(journal.JournalEntryLines);
    const single = row(
      await client.get(`JournalEntries(${key})?$select=JdtNum,ReferenceDate,JournalEntryLines`)
    );
    if (
      single.JdtNum !== journal.JdtNum ||
      single.ReferenceDate !== journal.ReferenceDate ||
      lineSignature(lines) !== lineSignature(collection(single.JournalEntryLines))
    )
      differences.push(`JournalEntries(${key}): collection/detail mismatch`);
    let journalDebit = 0n,
      journalCredit = 0n;
    for (const line of lines) {
      const account = id(line.AccountCode);
      if (!accountNames.has(account)) throw new Error("Journal account missing from chart");
      const d = money(line.Debit),
        c = money(line.Credit);
      journalDebit += d;
      journalCredit += c;
      linesCount++;
      const accumulated = accounts.get(account) ?? {
        account,
        name: accountNames.get(account)!,
        debit: 0n,
        credit: 0n,
        refs: []
      };
      accumulated.debit += d;
      accumulated.credit += c;
      accumulated.refs.push(`${key}/${id(line.Line_ID)}`);
      accounts.set(account, accumulated);
    }
    if (journalDebit !== journalCredit)
      differences.push(`JournalEntries(${key}): debit/credit mismatch`);
    debit += journalDebit;
    credit += journalCredit;
  }
  const aggregatePath = `JournalEntries?$apply=filter(${encodeURIComponent(dateClause("ReferenceDate", filter))})/aggregate(JdtNum%20with%20countdistinct%20as%20Count)`;
  const aggregate = collection(row(await client.get(aggregatePath)).value);
  if (aggregate.length !== 1 || aggregate[0]!.Count !== journals.length)
    throw new Error("SAP aggregate count mismatch");
  // Recheck counts after point reads. This detects count drift, not a transactional snapshot.
  for (const def of definitions) {
    if (
      def.decodeControl(await client.get(def.controlPath)).expectedRows !== rows.get(def.id)!.length
    )
      throw new Error("SAP changed during inspection; repeat the read");
  }
  const receipts = records("InventoryGenEntries").map((document) => {
    const lines = collection(document.DocumentLines);
    const linked = lines.filter((line) => line.BaseType === 202 && line.BaseEntry != null);
    const transaction = journals.find((j) => j.JdtNum === document.TransNum);
    const postingDebit = transaction
      ? collection(transaction.JournalEntryLines).reduce((sum, l) => sum + money(l.Debit), 0n)
      : undefined;
    const total = money(document.DocTotal);
    const delta = postingDebit == null ? null : formatDecimal(postingDebit - total, 6);
    // Diagnostic comparison only: document total need not equal inventory cost in general.
    return {
      id: id(document.DocEntry),
      date: document.DocDate,
      currency: document.DocCurrency,
      total: formatDecimal(total, 6),
      transaction: document.TransNum,
      cancelled: document.Cancelled,
      lines: lines.length,
      productionLines: linked.length,
      missingUnits: lines.filter((l) => !l.MeasureUnit).length,
      journalDebitDifference: delta
    };
  });
  const orders = records("ProductionOrders").map((o) => ({
    id: id(o.AbsoluteEntry),
    number: o.DocumentNumber,
    item: o.ItemNo,
    completedQuantity: o.CompletedQuantity,
    unit: o.InventoryUOM,
    status: o.ProductionOrderStatus
  }));
  return {
    origin: "sap" as const,
    startedAt,
    capturedAt: new Date().toISOString(),
    filter,
    allocationReady: false as const,
    postingBlocked: true as const,
    reads: evidence.map((e) => ({
      entity: e.id,
      pages: e.pagesRead,
      rows: e.receivedRows,
      count: e.expectedRows
    })),
    journal: {
      documents: journals.length,
      lines: linesCount,
      debit: formatDecimal(debit, 6),
      credit: formatDecimal(credit, 6),
      difference: formatDecimal(debit - credit, 6),
      unit: "SAP local currency; ISO/precision not approved",
      pointReads: journals.length,
      distinctCount: aggregate[0]!.Count
    },
    accounts: [...accounts.values()].map((a) => ({
      ...a,
      debit: formatDecimal(a.debit, 6),
      credit: formatDecimal(a.credit, 6),
      net: formatDecimal(a.debit - a.credit, 6)
    })),
    orders,
    receipts,
    differences,
    blockers: [
      ...(orders.length ? [] : ["Nenhuma ordem de producao disponivel na empresa."]),
      ...(records("Resources").length ? [] : ["Nenhum recurso disponivel na empresa."]),
      "Contas participantes e periodo industrial ainda nao aprovados.",
      "Custo atual, custo direto, horas e unidades comparaveis sem normalizacao aprovada.",
      "Conferencia estrutural nao substitui conciliacao funcional no SAP. Contabilizacao bloqueada."
    ]
  };
}
