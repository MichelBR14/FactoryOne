import type { PeriodFilter } from "../engine/types";
import { MappedGgfSource, type GgfReadClient } from "./MappedGgfSource";
import { defineSapRead, sapB1ReadMapping } from "./SapB1ReadMapping";
import { formatDecimal, parseDecimal } from "../../../core/util/money";

type Row = Record<string, unknown>;
function rejectNestedPagination(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [name, child] of Object.entries(value)) {
    if (/nextLink$/i.test(name) && child != null)
      throw new Error("Nested SAP pagination requires explicit mapping");
    rejectNestedPagination(child);
  }
}
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid audit row");
  rejectNestedPagination(value);
  return value as Row;
}

function decimal(value: unknown): bigint {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) >= 1e12 ||
    !/^-?\d+(\.\d{1,6})?$/.test(String(value))
  )
    throw new Error("Invalid audit decimal precision");
  return parseDecimal(String(value), 6);
}
const formatted = (value: bigint) => formatDecimal(value, 6);
function unique(rows: Row[], field: string): void {
  const keys = rows.map((row) => key(row[field]));
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate audit line/key");
}

/** Diagnostic comparisons only. Even matching totals never enable a normalized GGF basis. */
export function analyzeOrderAudit(data: Awaited<ReturnType<typeof readOrderAuditData>>) {
  unique(data.orders, "AbsoluteEntry");
  unique(data.journals, "JdtNum");
  const journalSummary = (journal: Row) => {
    const lines = list(journal.JournalEntryLines);
    unique(lines, "Line_ID");
    const accounts = new Map<string, { debit: bigint; credit: bigint; refs: string[] }>();
    for (const line of lines) {
      if (typeof line.AccountCode !== "string" || !line.AccountCode)
        throw new Error("Missing journal account");
      const group = accounts.get(line.AccountCode) ?? { debit: 0n, credit: 0n, refs: [] };
      group.debit += decimal(line.Debit);
      group.credit += decimal(line.Credit);
      group.refs.push(`${journal.JdtNum}/${line.Line_ID}`);
      accounts.set(line.AccountCode, group);
    }
    const debit = [...accounts.values()].reduce((sum, a) => sum + a.debit, 0n);
    const credit = [...accounts.values()].reduce((sum, a) => sum + a.credit, 0n);
    return {
      id: journal.JdtNum,
      date: sourceDate(journal.ReferenceDate),
      original: journal.Original,
      type: journal.OriginalJournal,
      debit: formatted(debit),
      credit: formatted(credit),
      difference: formatted(debit - credit),
      accounts: [...accounts].map(([account, a]) => ({
        account,
        name: data.accounts.find((record) => record.Code === account)?.Name ?? null,
        debit: formatted(a.debit),
        credit: formatted(a.credit),
        net: formatted(a.debit - a.credit),
        bothSides: a.debit !== 0n && a.credit !== 0n,
        refs: a.refs
      }))
    };
  };
  const journalChecks = data.journals.map(journalSummary);
  const sheetLines: Array<Row & { date: string }> = data.timeSheets.flatMap((sheet) => {
    const lines = list(sheet.PM_TimeSheetLineDataCollection);
    unique(lines, "LineID");
    return lines.map((line) => ({ ...line, sheet: sheet.AbsEntry, date: sourceDate(line.Date) }));
  });
  const inPeriod = (date: string) => date >= data.filter.start && date <= data.filter.end;
  const documentChecks = data.movements.map(({ entity, document }) => {
    const lines = list(document.DocumentLines);
    unique(lines, "LineNum");
    const journal = journalChecks.find((j) => j.id === document.TransNum);
    if (!journal) throw new Error("Missing movement journal");
    const lineTotal = lines.reduce((sum, line) => sum + decimal(line.LineTotal), 0n);
    return {
      source: `${entity}(${document.DocEntry})`,
      transaction: journal.id,
      date: sourceDate(document.DocDate),
      cancelled: document.Cancelled,
      cancelStatus: document.CancelStatus,
      journalOriginMatches:
        journal.original === document.DocEntry &&
        journal.type ===
          (entity === "InventoryGenEntries"
            ? "ttGeneralReceiptToStock"
            : "ttGeneralReleaseFromStock"),
      documentTotal: formatted(decimal(document.DocTotal)),
      lineTotal: formatted(lineTotal),
      lineHeaderDifference: formatted(lineTotal - decimal(document.DocTotal)),
      journalDebitDifference: formatted(
        parseDecimal(journal.debit, 6) - decimal(document.DocTotal)
      ),
      mixedOrders:
        new Set(lines.map((l) => (l.BaseType === 202 ? l.BaseEntry : "unlinked"))).size > 1
    };
  });
  const orders = data.orders.map((order) => {
    const findings = new Set<string>([
      "CURRENT_COST_UNPROVEN",
      "DIRECT_COST_POLICY_PENDING",
      "RECORDED_HOURS_UNPROVEN"
    ]);
    const components = list(order.ProductionOrderLines);
    unique(components, "LineNumber");
    const parent = data.items.find((item) => item.ItemCode === order.ItemNo);
    if (!parent) throw new Error("Missing parent item evidence");
    const movements = data.movements.flatMap(({ entity, document }) =>
      list(document.DocumentLines)
        .filter((line) => line.BaseType === 202 && line.BaseEntry === order.AbsoluteEntry)
        .map((line) => ({
          entity,
          document,
          line,
          date: sourceDate(document.DocDate),
          ref: `${entity}(${document.DocEntry})/${key(line.LineNum)}`
        }))
    );
    let supported = order.ProductionOrderType === "bopotStandard";
    if (!supported) findings.add("ORDER_TYPE_NOT_SUPPORTED");
    if (parent.InventoryItem !== "tYES") {
      supported = false;
      findings.add("NON_INVENTORY_PARENT");
    }
    if (
      new Set(movements.map((m) => m.document.DocCurrency)).size !== 1 ||
      movements.some((m) => typeof m.document.DocCurrency !== "string" || !m.document.DocCurrency)
    ) {
      supported = false;
      findings.add("CURRENCY_UNPROVEN");
    }
    const quantities = new Map<number, bigint>();
    let receipts = 0n,
      periodReceipts = 0n,
      receivedValue = 0n,
      itemValue = 0n,
      resourceValue = 0n;
    const resourceConsumption: Array<Record<string, unknown>> = [];
    for (const movement of movements) {
      const { entity, document, line, date, ref } = movement;
      if (
        document.Cancelled !== "tNO" ||
        document.CancelStatus !== "csNo" ||
        decimal(line.Quantity) < 0n ||
        decimal(line.LineTotal) < 0n
      ) {
        supported = false;
        findings.add("CANCELLATION_OR_SIGN_RULE_PENDING");
        continue;
      }
      if (entity === "InventoryGenEntries") {
        if (
          line.ItemCode !== order.ItemNo ||
          line.TransactionType !== "botrntComplete" ||
          line.ItemType !== "dit_Item"
        ) {
          supported = false;
          findings.add("RETURN_REJECTION_OR_BYPRODUCT_RULE_PENDING");
          continue;
        }
        if (
          !order.InventoryUOM ||
          line.MeasureUnit !== order.InventoryUOM ||
          parent.InventoryUOM !== order.InventoryUOM ||
          line.UseBaseUnits !== "tYES" ||
          decimal(line.InventoryQuantity) !== decimal(line.Quantity)
        ) {
          supported = false;
          findings.add("RECEIPT_UNIT_MISMATCH");
          continue;
        }
        receipts += decimal(line.InventoryQuantity);
        if (inPeriod(date)) periodReceipts += decimal(line.InventoryQuantity);
        receivedValue += decimal(line.LineTotal);
      } else {
        const component = components.find((c) => c.LineNumber === line.BaseLine);
        if (
          !component ||
          component.ItemNo !== line.ItemCode ||
          (line.ItemType !== "dit_Resource" && line.ItemType !== "dit_Item") ||
          component.ItemType !== (line.ItemType === "dit_Resource" ? "pit_Resource" : "pit_Item")
        ) {
          supported = false;
          findings.add("COMPONENT_LINK_MISMATCH");
          continue;
        }
        quantities.set(
          key(component.LineNumber),
          (quantities.get(key(component.LineNumber)) ?? 0n) + decimal(line.Quantity)
        );
        if (line.ItemType === "dit_Resource") {
          resourceValue += decimal(line.LineTotal);
          const resource = data.resources.find((r) => r.Code === line.ItemCode);
          if (!resource) throw new Error("Missing resource evidence");
          if (!data.resourceGroups.some((g) => g.Code === resource.Group))
            throw new Error("Missing resource group evidence");
          if (
            !resource.UnitOfMeasure ||
            !line.MeasureUnit ||
            resource.UnitOfMeasure !== line.MeasureUnit
          )
            findings.add("RESOURCE_UNIT_MISSING_OR_DIFFERENT");
          if (component.ProductionOrderIssueType === "im_Backflush")
            findings.add("BACKFLUSH_IS_NOT_TIME_LOG");
          resourceConsumption.push({
            ref,
            date,
            inPeriod: inPeriod(date),
            componentLine: component.LineNumber,
            resource: resource.Code,
            group: resource.Group,
            quantity: formatted(decimal(line.Quantity)),
            documentUnit: line.MeasureUnit,
            masterUnit: resource.UnitOfMeasure,
            issueMethod: component.ProductionOrderIssueType,
            timePerUnits: resource.TimePerUnits,
            unitsPerTime: resource.UnitsPerTime,
            lineTotal: formatted(decimal(line.LineTotal)),
            actualHours: null
          });
        } else {
          const item = data.items.find((i) => i.ItemCode === line.ItemCode);
          if (
            !item ||
            item.InventoryItem !== "tYES" ||
            !item.InventoryUOM ||
            line.MeasureUnit !== item.InventoryUOM ||
            line.UseBaseUnits !== "tYES" ||
            decimal(line.Quantity) !== decimal(line.InventoryQuantity)
          ) {
            supported = false;
            findings.add("COMPONENT_UNIT_OR_NON_INVENTORY_RULE_PENDING");
          }
          itemValue += decimal(line.LineTotal);
        }
      }
    }
    const componentChecks = components
      .filter((c) => c.ItemType !== "pit_Text")
      .map((c) => ({
        line: key(c.LineNumber),
        item: c.ItemNo,
        type: c.ItemType,
        declaredIssued: formatted(decimal(c.IssuedQuantity)),
        movementQuantity: formatted(quantities.get(key(c.LineNumber)) ?? 0n),
        difference: supported
          ? formatted((quantities.get(key(c.LineNumber)) ?? 0n) - decimal(c.IssuedQuantity))
          : null
      }));
    if (componentChecks.some((c) => c.difference !== null && c.difference !== "0.000000"))
      findings.add("ISSUED_QUANTITY_MISMATCH");
    if (supported && receipts !== decimal(order.CompletedQuantity))
      findings.add("RECEIVED_QUANTITY_MISMATCH");
    if (supported && itemValue + resourceValue !== receivedValue)
      findings.add("COMPONENT_RECEIPT_VALUE_DIFFERENCE");
    const linkedTimeSheets = sheetLines.filter(
      (line) => line.Workorder === order.AbsoluteEntry || line.Workorder === order.DocumentNumber
    );
    if (linkedTimeSheets.length) findings.add("TIMESHEET_LINK_AND_RESOURCE_MAPPING_PENDING");
    const closing = journalChecks.find((j) => j.id === order.TransactionNumber) ?? null;
    if (
      closing &&
      (closing.original !== order.AbsoluteEntry || closing.type !== "ttProductionOrder")
    )
      findings.add("CLOSING_JOURNAL_LINK_MISMATCH");
    if (order.ProductionOrderStatus === "boposClosed" && !closing)
      findings.add("CLOSING_JOURNAL_MISSING");
    return {
      entry: order.AbsoluteEntry,
      number: order.DocumentNumber,
      item: order.ItemNo,
      status: order.ProductionOrderStatus,
      unit: order.InventoryUOM,
      comparisonsSupported: supported,
      currencyLabel: movements[0]?.document.DocCurrency,
      completedQuantity: formatted(decimal(order.CompletedQuantity)),
      receiptQuantityInPeriod: supported ? formatted(periodReceipts) : null,
      receiptQuantityLifetime: supported ? formatted(receipts) : null,
      receiptCompletedDifference: supported
        ? formatted(receipts - decimal(order.CompletedQuantity))
        : null,
      issuedItemLineTotals: supported ? formatted(itemValue) : null,
      issuedResourceLineTotals: supported ? formatted(resourceValue) : null,
      receivedLineTotals: supported ? formatted(receivedValue) : null,
      issuesMinusReceipts: supported ? formatted(itemValue + resourceValue - receivedValue) : null,
      valueScope: "All linked movements, not a normalized direct/current cost",
      currentCost: null,
      actualHours: null,
      itemMasterAveragePrice: parent.MovingAveragePrice,
      periodTimeSheetCandidates: linkedTimeSheets.filter((l) => inPeriod(l.date)).length,
      lifetimeTimeSheetCandidates: linkedTimeSheets.length,
      componentChecks,
      resourceConsumption,
      closingJournal: closing,
      movements: movements.map((m) => ({ ref: m.ref, date: m.date, inPeriod: inPeriod(m.date) })),
      findings: [...findings]
    };
  });
  return {
    origin: "sap" as const,
    filter: data.filter,
    capturedAt: data.capturedAt,
    allocationReady: false as const,
    postingBlocked: true as const,
    sourceScope: data.scope,
    reads: data.reads.map((r) => ({
      entity: r.id,
      pages: r.pagesRead,
      rows: r.receivedRows,
      count: r.expectedRows
    })),
    timeSheets: {
      headers: data.timeSheets.length,
      lines: sheetLines.length,
      periodLines: sheetLines.filter((l) => inPeriod(l.date)).length,
      orderReferenceCandidates: data.timeSheetOrderCandidates
    },
    orders,
    documentChecks,
    journalChecks,
    structuralDifferences: [
      ...documentChecks
        .filter(
          (d) =>
            !d.journalOriginMatches ||
            d.lineHeaderDifference !== "0.000000" ||
            d.journalDebitDifference !== "0.000000"
        )
        .map((d) => d.source),
      ...journalChecks
        .filter((j) => j.difference !== "0.000000")
        .map((j) => `JournalEntries(${j.id})`),
      ...orders
        .filter((o) =>
          o.findings.some((f) =>
            [
              "ISSUED_QUANTITY_MISMATCH",
              "RECEIVED_QUANTITY_MISMATCH",
              "COMPONENT_RECEIPT_VALUE_DIFFERENCE",
              "CLOSING_JOURNAL_LINK_MISMATCH"
            ].includes(f)
          )
        )
        .map((o) => `ProductionOrders(${o.entry})`)
    ],
    limitations: [
      "Counts and point reads are structural controls, not a transactional snapshot or independent SAP client report.",
      "Resource consumption and capacity parameters are not measured hours.",
      "Header item average price and closing journal debit are not current order cost.",
      "Unit equivalence across different products and direct cost policy require functional approval."
    ]
  };
}
function list(value: unknown): Row[] {
  if (!Array.isArray(value)) throw new Error("Missing audit lines");
  return value.map(object);
}
function key(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error("Invalid SAP audit key");
  return value as number;
}
function signature(value: unknown): string {
  const normalize = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(normalize)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([k]) => !k.startsWith("@odata."))
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, normalize(v)])
          )
        : value;
  return JSON.stringify(normalize(value));
}
function sourceDate(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value.slice(0, 10)).toISOString().slice(0, 10) !== value.slice(0, 10)
  )
    throw new Error("Invalid SAP audit date");
  return value.slice(0, 10);
}
const documentSelect =
  "DocEntry,DocNum,DocDate,DocCurrency,DocTotal,Cancelled,CancelStatus,TransNum,BPL_IDAssignedToInvoice,DocumentLines";
const orderSelect =
  "AbsoluteEntry,DocumentNumber,ItemNo,ProductionOrderStatus,ProductionOrderType,PlannedQuantity,CompletedQuantity,RejectedQuantity,PostingDate,ReleaseDate,ClosingDate,Warehouse,InventoryUOM,UoMEntry,TransactionNumber,DistributionRule,DistributionRule2,DistributionRule3,DistributionRule4,DistributionRule5,ProductionOrderLines";

/** Raw, scoped evidence. No snapshot, allocation basis or posting operation is produced. */
export async function readOrderAuditData(client: GgfReadClient, filter: PeriodFilter) {
  if (filter.branch || filter.costCenter)
    throw new Error("Audit scope requires all branches/dimensions");
  const definitions = [
    ...["InventoryGenEntries", "InventoryGenExits"].map((entity) =>
      defineSapRead(entity, "DocEntry", "production", documentSelect)
    ),
    defineSapRead("ProductionOrders", "AbsoluteEntry", "production", orderSelect),
    defineSapRead(
      "Resources",
      "Code",
      "production",
      "Code,Name,Group,UnitOfMeasure,UnitsPerTime,TimePerUnits,Cost1,Cost2,Cost3,Cost4,Cost5,Cost6,Cost7,Cost8,Cost9,Cost10"
    ),
    defineSapRead("ResourceGroups", "Code", "production", "Code,Name,NumOfUnitsText"),
    defineSapRead(
      "ProjectManagementTimeSheet",
      "AbsEntry",
      "production",
      "AbsEntry,DateFrom,DateTo,PM_TimeSheetLineDataCollection"
    )
  ];
  const startedAt = new Date().toISOString();
  const source = new MappedGgfSource(client, sapB1ReadMapping);
  const collected = await source.inspectSources(filter, definitions);
  const rows = (entity: string) => collected.rows.get(entity)!.map(object);
  const selectedOrders = new Set<number>();
  for (const document of rows("InventoryGenEntries")) {
    const date = sourceDate(document.DocDate);
    if (date < filter.start || date > filter.end) continue;
    for (const line of list(document.DocumentLines)) {
      if (line.BaseType === 202) selectedOrders.add(key(line.BaseEntry));
    }
  }
  const movements = ["InventoryGenEntries", "InventoryGenExits"].flatMap((entity) =>
    rows(entity)
      .filter((document) =>
        list(document.DocumentLines).some(
          (line) => line.BaseType === 202 && selectedOrders.has(key(line.BaseEntry))
        )
      )
      .map((document) => ({ entity, document }))
  );
  const orders = rows("ProductionOrders").filter((order) =>
    selectedOrders.has(key(order.AbsoluteEntry))
  );
  if (orders.length !== selectedOrders.size)
    throw new Error("Receipt refers to a missing production order");
  const details: Array<{ entity: string; record: Row }> = [];
  for (const { entity, document } of movements) {
    const record = object(
      await client.get(`${entity}(${key(document.DocEntry)})?$select=${documentSelect}`)
    );
    if (signature(record) !== signature(document))
      throw new Error("Audit movement changed between collection and detail");
    details.push({ entity, record });
  }
  for (const order of orders) {
    const record = object(
      await client.get(`ProductionOrders(${key(order.AbsoluteEntry)})?$select=${orderSelect}`)
    );
    if (signature(record) !== signature(order))
      throw new Error("Audit order changed between collection and detail");
    details.push({ entity: "ProductionOrders", record });
  }
  const journals: Row[] = [];
  const transactionIds = new Set(movements.map((m) => key(m.document.TransNum)));
  for (const order of orders) {
    if (typeof order.TransactionNumber === "number" && order.TransactionNumber > 0)
      transactionIds.add(key(order.TransactionNumber));
  }
  for (const transaction of transactionIds) {
    const journal = object(
      await client.get(
        `JournalEntries(${transaction})?$select=JdtNum,ReferenceDate,OriginalJournal,Original,JournalEntryLines`
      )
    );
    if (journal.JdtNum !== transaction) throw new Error("Audit journal identity mismatch");
    journals.push(journal);
  }
  const itemCodes = new Set<string>();
  for (const order of orders) {
    if (typeof order.ItemNo !== "string" || !order.ItemNo) throw new Error("Missing parent item");
    itemCodes.add(order.ItemNo);
    for (const line of list(order.ProductionOrderLines))
      if (line.ItemType === "pit_Item") {
        if (typeof line.ItemNo !== "string" || !line.ItemNo)
          throw new Error("Missing component item");
        itemCodes.add(line.ItemNo);
      }
  }
  const items: Row[] = [];
  for (const code of itemCodes) {
    const literal = encodeURIComponent(code.replace(/'/g, "''")).replace(/'/g, "%27");
    const item = object(
      await client.get(
        `Items(%27${literal}%27)?$select=ItemCode,InventoryItem,InventoryUOM,InventoryUoMEntry,CostAccountingMethod,MovingAveragePrice`
      )
    );
    if (item.ItemCode !== code) throw new Error("Audit item identity mismatch");
    items.push(item);
  }
  const accounts: Row[] = [];
  const accountCodes = new Set(
    journals.flatMap((journal) => list(journal.JournalEntryLines).map((line) => line.AccountCode))
  );
  for (const code of accountCodes) {
    if (typeof code !== "string" || !code) throw new Error("Missing account reference");
    const literal = encodeURIComponent(code.replace(/'/g, "''")).replace(/'/g, "%27");
    const account = object(
      await client.get(`ChartOfAccounts(%27${literal}%27)?$select=Code,Name,AccountType`)
    );
    if (account.Code !== code) throw new Error("Audit account identity mismatch");
    accounts.push(account);
  }
  for (const definition of definitions) {
    if (
      definition.decodeControl(await client.get(definition.controlPath)).expectedRows !==
      collected.rows.get(definition.id)!.length
    )
      throw new Error("Source count changed during order audit");
  }
  return {
    origin: "sap" as const,
    startedAt,
    capturedAt: new Date().toISOString(),
    filter,
    scope:
      "Orders referenced by receipts in period; movements and time sheets read across all dates",
    allocationReady: false as const,
    postingBlocked: true as const,
    reads: collected.evidence.map(({ filter: _requestedFilter, ...read }) => ({
      ...read,
      scope: "all dates"
    })),
    queries: definitions.map((d) => ({
      entity: d.id,
      dataPath: d.dataPath,
      controlPath: d.controlPath,
      scope: "global inventory; not period-filtered"
    })),
    orders,
    movements,
    details,
    journals,
    items,
    accounts,
    timeSheetOrderCandidates: rows("ProjectManagementTimeSheet").flatMap((sheet) =>
      list(sheet.PM_TimeSheetLineDataCollection)
        .filter((line) => line.Workorder != null)
        .map((line) => ({
          sheet: sheet.AbsEntry,
          line: line.LineID,
          reference: line.Workorder,
          byEntry: rows("ProductionOrders")
            .filter((o) => o.AbsoluteEntry === line.Workorder)
            .map((o) => ({ entry: o.AbsoluteEntry, number: o.DocumentNumber })),
          byNumber: rows("ProductionOrders")
            .filter((o) => o.DocumentNumber === line.Workorder)
            .map((o) => ({ entry: o.AbsoluteEntry, number: o.DocumentNumber }))
        }))
    ),
    resources: rows("Resources"),
    resourceGroups: rows("ResourceGroups"),
    timeSheets: rows("ProjectManagementTimeSheet")
  };
}
