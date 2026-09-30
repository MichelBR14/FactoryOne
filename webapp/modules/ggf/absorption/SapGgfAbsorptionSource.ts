import { parseDecimal } from "../../../core/util/money";
import type { GgfReadClient, GgfReadDefinition } from "../repository/MappedGgfSource";
import { MappedGgfSource } from "../repository/MappedGgfSource";
import type { AbsorptionFilter, AbsorptionMapping, AbsorptionSourceData } from "./types";

type Row = Record<string, unknown>;
const asRow = (value: unknown): Row => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid SAP record");
  return value as Row;
};
const text = (value: unknown): string => typeof value === "string" || typeof value === "number" ? String(value) : "";
const decimal = (value: unknown, places: number): bigint => {
  if ((typeof value !== "number" && typeof value !== "string") || !/^-?\d+(?:\.\d{1,6})?$/.test(String(value)))
    throw new Error("Unsupported SAP decimal");
  return parseDecimal(String(value), places);
};
const escape = (value: string) => value.replaceAll("'", "''");

function readDefinition(entity: string, key: string, select: string, filter: string): GgfReadDefinition {
  const clause = encodeURIComponent(filter);
  return {
    id: entity,
    dataset: entity === "JournalEntries" ? "balances" : "production",
    sourceRef: `/b1s/v2/${entity}`,
    dataPath: `${entity}?$select=${select}&$orderby=${key}&$filter=${clause}`,
    controlPath: `${entity}/$count?$filter=${clause}`,
    rowId: (value) => text(asRow(value)[key]),
    decodeControl(value) {
      if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("Invalid SAP count");
      return { expectedRows: Number(value), reconciliationRef: `${entity}/$count structural completeness control` };
    }
  };
}

function cost(value: unknown): bigint {
  return decimal(value ?? 0, 2);
}

/** Explicitly scoped read of ledger lines and resource issue/return documents. */
export async function readGgfV2Absorption(
  client: GgfReadClient,
  company: string,
  filter: AbsorptionFilter,
  mapping: AbsorptionMapping
): Promise<AbsorptionSourceData> {
  const validDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  if (company !== "SBODEMOBR2" || !validDate(filter.start) || !validDate(filter.end) || filter.start > filter.end ||
      filter.branch.length > 50 || filter.dimensions.some((dimension) => dimension.length > 50))
    throw new Error("Company or period scope rejected");
  const start = `${filter.start}`;
  const end = `${filter.end}`;
  const journalFilter = `ReferenceDate ge '${start}' and ReferenceDate le '${end}'`;
  const movementFilter = `DocDate ge '${start}' and DocDate le '${end}'`;
  const definitions = [
    readDefinition("JournalEntries", "JdtNum", "JdtNum,ReferenceDate,OriginalJournal,Original,BaseReference,TransactionCode,JournalEntryLines", journalFilter),
    readDefinition("ChartOfAccounts", "Code", "Code,Name", mapping.accounts.length
      ? mapping.accounts.map((item) => `Code eq '${escape(item.account)}'`).join(" or ")
      : "Code eq '__FACTORYONE_NO_CONFIG__'"),
    ...["InventoryGenExits", "InventoryGenEntries"].map((entity) => readDefinition(
      entity,
      "DocEntry",
      "DocEntry,DocNum,DocDate,Cancelled,CancelStatus,TransNum,DocumentLines",
      movementFilter
    ))
  ];
  const source = new MappedGgfSource(client, { reads: () => definitions, normalize: () => { throw new Error("Inspection only"); } });
  const { rows, evidence } = await source.inspectSources({ start, end, branch: filter.branch, costCenter: filter.dimensions[0] }, definitions);
  const get = (key: string) => (rows.get(key) ?? []).map(asRow);
  const accountRows = get("ChartOfAccounts");
  const journalEntries = get("JournalEntries");
  const accountSet = new Set(mapping.accounts.map((item) => item.account));
  const journals: AbsorptionSourceData["journals"] = [];
  for (const entry of journalEntries) {
    const transId = text(entry.JdtNum);
    const date = text(entry.ReferenceDate).slice(0, 10);
    if (!Array.isArray(entry.JournalEntryLines)) throw new Error(`JournalEntries(${transId}) sem linhas`);
    for (const rawLine of entry.JournalEntryLines) {
      const line = asRow(rawLine);
      const account = text(line.AccountCode);
      if (!accountSet.has(account)) continue;
      const branch = text(line.BPLID);
      const dimensions = [line.CostingCode, line.CostingCode2, line.CostingCode3, line.CostingCode4, line.CostingCode5].map(text) as [string, string, string, string, string];
      if (filter.branch && branch !== filter.branch) continue;
      if (filter.dimensions.some((dimension, index) => dimension && dimension !== dimensions[index])) continue;
      journals.push({
        account,
        debitCents: cost(line.Debit),
        creditCents: cost(line.Credit),
        branch,
        dimensions,
        referenceDate: date,
        transId,
        document: text(entry.OriginalJournal) || text(entry.Original) || text(entry.BaseReference) || text(entry.TransactionCode) || `JE ${transId}`,
        lineId: text(line.Line_ID)
      });
    }
  }
  const movements: AbsorptionSourceData["movements"] = [];
  for (const entity of ["InventoryGenExits", "InventoryGenEntries"]) {
    for (const document of get(entity)) {
      if (document.Cancelled !== "tNO" || document.CancelStatus !== "csNo") continue;
      if (!Array.isArray(document.DocumentLines)) throw new Error(`${entity}(${text(document.DocEntry)}) sem linhas`);
      for (const rawLine of document.DocumentLines) {
        const line = asRow(rawLine);
        const resource = text(line.ItemCode);
        if (line.ItemType !== "dit_Resource" || line.BaseType !== 202) continue;
        if (typeof line.BaseEntry !== "number" && typeof line.BaseEntry !== "string") throw new Error("OP reference missing on resource movement");
        const account = text(line.AccountCode);
        const baseType = text(line.BaseType);
        if (baseType !== "202") continue;
        movements.push({
          resource,
          order: text(line.BaseEntry),
          orderEntry: text(line.BaseEntry),
          producedItem: "",
          itemDescription: "",
          plannedQuantity: "",
          completedQuantity: "",
          quantityMicros: decimal(line.Quantity, 6),
          unit: text(line.MeasureUnit) || null,
          lineTotalCents: cost(line.LineTotal),
          direction: entity === "InventoryGenExits" ? "ISSUE" : "RETURN",
          document: text(document.DocNum),
          docEntry: text(document.DocEntry),
          lineId: text(line.LineNum),
          date: text(document.DocDate).slice(0, 10),
          sourceAccount: account
        });
      }
    }
  }
  const resourceCodes = [...new Set(movements.map((movement) => movement.resource))];
  const resourceRows = await Promise.all(resourceCodes.map(async (code) => {
    const result = asRow(await client.get(`Resources('${escape(code)}')?$select=Code,Name,Type,UnitOfMeasure,Cost1,Cost2,Cost3,Cost4,Cost5,Cost6,Cost7,Cost8,Cost9,Cost10`));
    if (text(result.Code) !== code) throw new Error(`Resources(${code}) identity mismatch`);
    return result;
  }));
  const resources: AbsorptionSourceData["resources"] = resourceRows.map((row) => ({
    resource: text(row.Code),
    description: text(row.Name),
    type: text(row.Type),
    unit: text(row.UnitOfMeasure) || null,
    components: Array.from({ length: 10 }, (_unused, index) => ({ component: index + 1, unitCostCents: cost(row[`Cost${index + 1}`]) })),
    evidence: "current master Resource.CostN; historical validity not established"
  }));
  const orderEntries = [...new Set(movements.map((movement) => movement.orderEntry))];
  const orders = await Promise.all(orderEntries.map(async (entry) => {
    const result = await client.get(`ProductionOrders(${encodeURIComponent(entry)})?$select=AbsoluteEntry,DocumentNumber,ItemNo,InventoryUOM,PlannedQuantity,CompletedQuantity`);
    const order = asRow(result);
    if (text(order.AbsoluteEntry) !== entry) throw new Error(`ProductionOrders(${entry}) identity mismatch`);
    return {
      entry,
      number: text(order.DocumentNumber),
      item: text(order.ItemNo),
      itemDescription: "",
      plannedQuantity: String(order.PlannedQuantity ?? ""),
      completedQuantity: String(order.CompletedQuantity ?? ""),
      unit: text(order.InventoryUOM)
    };
  }));
  for (const order of orders) {
    const item = asRow(await client.get(`Items('${escape(order.item)}')?$select=ItemCode,ItemName`));
    if (text(item.ItemCode) !== order.item) throw new Error(`Items(${order.item}) identity mismatch`);
    order.itemDescription = text(item.ItemName);
  }
  const orderByEntry = new Map(orders.map((order) => [order.entry, order]));
  for (const movement of movements) {
    const order = orderByEntry.get(movement.orderEntry);
    if (!order) throw new Error(`Production order ${movement.orderEntry} unavailable`);
    movement.order = order.number;
    movement.producedItem = order.item;
    movement.itemDescription = order.itemDescription;
    movement.plannedQuantity = order.plannedQuantity;
    movement.completedQuantity = order.completedQuantity;
  }
  const complete = evidence.map((read) => ({ source: read.id, received: read.receivedRows, expected: read.expectedRows, control: read.reconciliationRef }));
  complete.push({ source: "Resources point reads", received: resources.length, expected: resourceCodes.length, control: "Resources(key) identity checked for every resource in period resource movement" });
  return {
    company,
    filter: structuredClone(filter),
    accounts: accountRows.map((row) => ({ code: text(row.Code), name: text(row.Name) })),
    journals,
    resources,
    orders,
    movements,
    completeness: complete,
    capturedAt: new Date().toISOString()
  };
}
