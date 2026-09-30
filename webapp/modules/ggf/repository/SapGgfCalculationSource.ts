import { decimal, validateConfiguration, validatePeriod } from "../engine/allocation";
import { GgfError } from "../engine/errors";
import { formatDecimal, sum } from "../../../core/util/money";
import type {
  BasisEvidence,
  Configuration,
  OrderBasis,
  PeriodFilter,
  SourceSnapshot
} from "../engine/types";
import { MappedGgfSource, type GgfReadClient } from "./MappedGgfSource";
import { defineSapRead } from "./SapB1ReadMapping";
import type { GgfSource } from "./GgfSource";

type Row = Record<string, any>;
export interface SapCalculationSelection {
  orderEntries: number[];
  /** Explicit diagnostic denominator, never an automatic GGF pool or tariff classification. */
  directCostPolicy?: "DOCUMENTED_MATERIALS_AND_RESOURCES";
}
function checked(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new GgfError("sourceRead", ["record"]);
  const walk = (v: unknown) => {
    if (v && typeof v === "object")
      for (const [k, c] of Object.entries(v)) {
        if (/nextLink$/i.test(k) && c != null)
          throw new GgfError("sourceRead", ["nested pagination"]);
        walk(c);
      }
  };
  walk(value);
  return value;
}
function lines(row: Row, field: string, key: string): Row[] {
  if (!Array.isArray(row[field])) throw new GgfError("sourceRead", [field]);
  const result = row[field].map(checked);
  if (
    result.some((l: Row) => !Number.isSafeInteger(l[key]) || l[key] < 0) ||
    new Set(result.map((l: Row) => l[key])).size !== result.length
  )
    throw new GgfError("sourceRead", [`${field} identity`]);
  return result;
}
function value(input: unknown, places: number): bigint {
  if (typeof input !== "number" || !Number.isFinite(input) || Math.abs(input) >= 1e12)
    throw new GgfError("sourceRead", ["source decimal"]);
  return decimal(String(input), places, "SAP source", true);
}

/** Narrow validation read. It does not repeat the generic diagnostic or write to SAP. */
export class SapGgfCalculationSource implements GgfSource {
  readonly mode = "sap" as const;
  constructor(
    private client: GgfReadClient,
    private selection: SapCalculationSelection
  ) {}

  async loadSnapshot(filter: PeriodFilter, config: Configuration): Promise<SourceSnapshot> {
    validatePeriod(filter);
    validateConfiguration(config);
    const entries = this.selection.orderEntries;
    if (
      filter.start !== "2026-09-01" ||
      filter.end !== "2026-09-30" ||
      filter.branch ||
      filter.costCenter ||
      !entries?.length ||
      new Set(entries).size !== entries.length ||
      entries.some((k) => ![203, 204, 206].includes(k)) ||
      (this.selection.directCostPolicy !== undefined &&
        this.selection.directCostPolicy !== "DOCUMENTED_MATERIALS_AND_RESOURCES")
    )
      throw new GgfError("basisUnavailable", [
        "Unapproved selection; September 2026 / OP 76, 77, 79 only"
      ]);
    if (
      config.accounts.some(
        (a) => a.active && (a.percent === undefined || a.account.startsWith("DEV-"))
      )
    )
      throw new GgfError("sourceMismatch", ["Explicit real accounts and percentages required"]);
    const dateFilter = (field: string) =>
      `${field} ge '${filter.start}' and ${field} le '${filter.end}'`;
    const reads = [
      defineSapRead(
        "JournalEntries",
        "JdtNum",
        "balances",
        "JdtNum,ReferenceDate,JournalEntryLines",
        dateFilter("ReferenceDate")
      ),
      defineSapRead(
        "ChartOfAccounts",
        "Code",
        "balances",
        "Code,Name",
        config.accounts
          .filter((a) => a.active)
          .map((a) => `Code eq '${a.account.replaceAll("'", "''")}'`)
          .join(" or ")
      ),
      defineSapRead(
        "ProductionOrders",
        "AbsoluteEntry",
        "production",
        "AbsoluteEntry,DocumentNumber,ItemNo,InventoryUOM,PlannedQuantity,CompletedQuantity,PostingDate,ClosingDate,ProductionOrderStatus,ProductionOrderType,ProductionOrderLines",
        entries.map((k) => `AbsoluteEntry eq ${k}`).join(" or ")
      ),
      ...["InventoryGenEntries", "InventoryGenExits"].map((entity) =>
        defineSapRead(
          entity,
          "DocEntry",
          "production",
          "DocEntry,DocDate,DocCurrency,Cancelled,CancelStatus,DocumentLines",
          dateFilter("DocDate")
        )
      ),
      defineSapRead("Resources", "Code", "production", "Code,Group,UnitOfMeasure"),
      defineSapRead("ResourceGroups", "Code", "production", "Code,Name")
    ];
    const source = new MappedGgfSource(this.client, {
      reads: () => reads,
      normalize() {
        throw new Error("Not a posting snapshot");
      }
    });
    const { rows, evidence } = await source.inspectSources(filter, reads);
    const records = (name: string) => rows.get(name)!.map(checked);
    const orders = records("ProductionOrders");
    if (orders.length !== entries.length || orders.some((o) => !entries.includes(o.AbsoluteEntry)))
      throw new GgfError("sourceRead", ["Selected OP missing"]);
    const journals = records("JournalEntries");
    const ledger: Array<Row & { journal: string }> = journals.flatMap((j) => {
      if (
        typeof j.ReferenceDate !== "string" ||
        j.ReferenceDate.slice(0, 10) < filter.start ||
        j.ReferenceDate.slice(0, 10) > filter.end
      )
        throw new GgfError("sourceRead", ["Ledger outside period"]);
      return lines(j, "JournalEntryLines", "Line_ID").map((l) => ({
        ...l,
        journal: String(j.JdtNum)
      }));
    });
    const accounts = records("ChartOfAccounts");
    const balances = config.accounts
      .filter((a) => a.active)
      .map((a) => {
        if (!accounts.some((row) => row.Code === a.account))
          throw new GgfError("missingBalance", [a.account]);
        const selected = ledger.filter((l) => l.AccountCode === a.account);
        return {
          account: a.account,
          amount: formatDecimal(sum(selected.map((l) => value(l.Debit, 2) - value(l.Credit, 2)))),
          currency: "SAP_LOCAL",
          readId: "JournalEntries",
          sourceRefs: [...new Set(selected.map((l) => l.journal))]
        };
      });
    const moves = ["InventoryGenEntries", "InventoryGenExits"].flatMap((entity) =>
      records(entity).flatMap((doc) => {
        if (
          typeof doc.DocDate !== "string" ||
          doc.DocDate.slice(0, 10) < filter.start ||
          doc.DocDate.slice(0, 10) > filter.end
        )
          throw new GgfError("sourceRead", ["Movement outside period"]);
        return lines(doc, "DocumentLines", "LineNum").map((line) => ({ entity, doc, line }));
      })
    );
    const resources = records("Resources");
    const resourceGroups = records("ResourceGroups");
    const basis = (
      readId: string,
      refs: string[],
      unit: string,
      comparisonKey: string,
      supportingReads: BasisEvidence["supportingReads"] = []
    ): BasisEvidence => ({
      unit,
      comparisonKey,
      readId,
      sourceRefs: [...new Set(refs)],
      supportingReads,
      normalizationRef: `SAP-GGF-validation/v1/${comparisonKey}; exact source units; no inferred time`
    });
    const normalized: OrderBasis[] = orders.map((o) => {
      const own = moves.filter(
        (m) => m.line.BaseType === 202 && m.line.BaseEntry === o.AbsoluteEntry
      );
      const received = own.filter((m) => m.entity === "InventoryGenEntries");
      const issued = own.filter((m) => m.entity === "InventoryGenExits");
      const components = lines(o, "ProductionOrderLines", "LineNumber");
      const orderSupport = [{ readId: "ProductionOrders", sourceRefs: [String(o.AbsoluteEntry)] }];
      const supported =
        o.ProductionOrderType === "bopotStandard" &&
        o.ProductionOrderStatus === "boposClosed" &&
        o.PostingDate?.slice(0, 10) >= filter.start &&
        o.ClosingDate?.slice(0, 10) <= filter.end &&
        own.every(
          (m) =>
            m.doc.Cancelled === "tNO" &&
            m.doc.CancelStatus === "csNo" &&
            m.doc.DocCurrency === "R$" &&
            value(m.line.Quantity, 6) >= 0n &&
            value(m.line.LineTotal, 2) >= 0n
        );
      if (!supported)
        throw new GgfError("basisUnavailable", [
          `OP ${o.DocumentNumber}: cancellation/type/currency/lifecycle outside validated scope`
        ]);
      const quantityValid =
        received.length > 0 &&
        !!o.InventoryUOM &&
        received.every(
          (m) =>
            m.line.ItemCode === o.ItemNo &&
            m.line.ItemType === "dit_Item" &&
            m.line.TransactionType === "botrntComplete" &&
            m.line.MeasureUnit === o.InventoryUOM &&
            m.line.UseBaseUnits === "tYES" &&
            value(m.line.InventoryQuantity, 6) === value(m.line.Quantity, 6)
        ) &&
        sum(received.map((m) => value(m.line.InventoryQuantity, 6))) ===
          value(o.CompletedQuantity, 6);
      const consumptionValid =
        issued.length > 0 &&
        issued.every((m) =>
          components.some(
            (c) =>
              c.LineNumber === m.line.BaseLine &&
              c.ItemNo === m.line.ItemCode &&
              c.ItemType ===
                (m.line.ItemType === "dit_Resource"
                  ? "pit_Resource"
                  : m.line.ItemType === "dit_Item"
                    ? "pit_Item"
                    : "UNSUPPORTED")
          )
        ) &&
        components
          .filter((c) => ["pit_Item", "pit_Resource"].includes(c.ItemType))
          .every(
            (c) =>
              sum(
                issued
                  .filter((m) => m.line.BaseLine === c.LineNumber)
                  .map((m) => value(m.line.Quantity, 6))
              ) === value(c.IssuedQuantity, 6)
          );
      if (
        (!consumptionValid || !quantityValid) &&
        config.accounts.some((a) => a.active && a.criterion === "RESOURCE_GROUP")
      )
        throw new GgfError("basisUnavailable", [
          `OP ${o.DocumentNumber}: resource consumption incomplete`
        ]);
      const resourceBases: NonNullable<OrderBasis["resourceBases"]> = {};
      if (consumptionValid)
        for (const m of issued.filter((m) => m.line.ItemType === "dit_Resource")) {
          const resource = resources.find((r) => r.Code === m.line.ItemCode);
          if (
            !resource ||
            !Number.isSafeInteger(resource.Group) ||
            !resourceGroups.some((g) => g.Code === resource.Group)
          )
            throw new GgfError("sourceRead", ["Resource/group not resolved"]);
          resourceBases[String(resource.Group)] ??= {};
        }
      for (const group of Object.keys(resourceBases)) {
        const groupMoves = issued.filter(
          (m) =>
            m.line.ItemType === "dit_Resource" &&
            resources.some((r) => r.Code === m.line.ItemCode && String(r.Group) === group)
        );
        const support = [
          ...orderSupport,
          {
            readId: "Resources",
            sourceRefs: [...new Set(groupMoves.map((m) => String(m.line.ItemCode)))]
          },
          { readId: "ResourceGroups", sourceRefs: [group] }
        ];
        resourceBases[group]!.RESOURCE_VALUE = {
          value: formatDecimal(sum(groupMoves.map((m) => value(m.line.LineTotal, 2)))),
          evidence: basis(
            "InventoryGenExits",
            groupMoves.map((m) => String(m.doc.DocEntry)),
            "SAP_LOCAL",
            `recorded-resource-value/group-${group}`,
            support
          ),
          resourceRefs: groupMoves.map(
            (m) => `${m.line.ItemCode}:InventoryGenExits(${m.doc.DocEntry})/${m.line.LineNum}`
          )
        };
        const units = new Set(groupMoves.map((m) => m.line.MeasureUnit));
        const codes = new Set(groupMoves.map((m) => m.line.ItemCode));
        if (
          units.size === 1 &&
          codes.size === 1 &&
          groupMoves.every(
            (m) =>
              m.line.MeasureUnit &&
              resources.find((r) => r.Code === m.line.ItemCode)?.UnitOfMeasure ===
                m.line.MeasureUnit
          )
        ) {
          resourceBases[group]!.RESOURCE_QUANTITY = {
            value: formatDecimal(sum(groupMoves.map((m) => value(m.line.Quantity, 6))), 6),
            evidence: basis(
              "InventoryGenExits",
              groupMoves.map((m) => String(m.doc.DocEntry)),
              [...units][0],
              `resource-quantity/${[...codes][0]}`,
              support
            ),
            resourceRefs: resourceBases[group]!.RESOURCE_VALUE!.resourceRefs
          };
        }
      }
      const directAvailable =
        consumptionValid &&
        quantityValid &&
        this.selection.directCostPolicy === "DOCUMENTED_MATERIALS_AND_RESOURCES";
      return {
        id: String(o.AbsoluteEntry),
        number: String(o.DocumentNumber),
        item: o.ItemNo,
        quantity: quantityValid
          ? formatDecimal(sum(received.map((m) => value(m.line.InventoryQuantity, 6))), 6)
          : null,
        directCost: directAvailable
          ? formatDecimal(sum(issued.map((m) => value(m.line.LineTotal, 2))))
          : null,
        directCostComponents: directAvailable
          ? issued.map((m) => ({
              kind: m.line.ItemType,
              code: m.line.ItemCode,
              amount: formatDecimal(value(m.line.LineTotal, 2)),
              sourceRefs: [`InventoryGenExits(${m.doc.DocEntry})/${m.line.LineNum}`]
            }))
          : undefined,
        hours: null,
        groupHours: {},
        currentCost: null,
        resourceBases,
        unavailable: {
          ...(quantityValid ? {} : { quantity: "Receipt quantity or unit not proven" }),
          ...(directAvailable
            ? {}
            : { directCost: "Select documented-components policy and reconcile issues" }),
          hours: "No validated actual-hours source for this period",
          currentCost: "Current stock/order valuation not mapped"
        },
        sourceRefs: own.map((m) => `${m.entity}(${m.doc.DocEntry})/${m.line.LineNum}`),
        basisEvidence: {
          quantity: quantityValid
            ? basis(
                "InventoryGenEntries",
                received.map((m) => String(m.doc.DocEntry)),
                o.InventoryUOM,
                `produced-item/${o.ItemNo}`,
                orderSupport
              )
            : null,
          directCost: directAvailable
            ? basis(
                "InventoryGenExits",
                issued.map((m) => String(m.doc.DocEntry)),
                "SAP_LOCAL",
                "documented-materials-and-resources",
                orderSupport
              )
            : null,
          hours: null,
          currentCost: null
        }
      };
    });
    const references = [
      ...balances,
      ...normalized.flatMap((o) => [
        ...Object.values(o.basisEvidence).filter((b) => b !== null),
        ...Object.values(o.resourceBases ?? {}).flatMap((g) =>
          Object.values(g).map((m) => m.evidence)
        )
      ])
    ];
    const used = new Map(evidence.map((r) => [r.id, new Set<string>()]));
    for (const ref of references) {
      ref.sourceRefs.forEach((id) => used.get(ref.readId)!.add(id));
      if ("supportingReads" in ref)
        for (const support of ref.supportingReads ?? [])
          support.sourceRefs.forEach((id) => used.get(support.readId)!.add(id));
    }
    // Keep all inspected rows accounted for, including records outside the chosen OP set.
    for (const read of evidence) {
      const definition = reads.find((d) => d.id === read.id)!;
      read.requestPath = definition.dataPath;
      read.controlPath = definition.controlPath;
      read.scope = ["JournalEntries", "InventoryGenEntries", "InventoryGenExits"].includes(read.id)
        ? "Period dates; all branches/dimensions; selected OP/account rows identified in references"
        : read.id === "ProductionOrders"
          ? "Explicit selected OP keys; lifecycle validated within period"
          : "Current master data; no historical date filter";
      const ids = rows.get(read.id)!.map(definition.rowId);
      if ([...used.get(read.id)!].some((id) => !ids.includes(id)))
        throw new GgfError("sourceRead", ["Unknown source row"]);
      read.excludedSourceRefs = ids.filter((id) => !used.get(read.id)!.has(id));
      read.exclusionRef =
        "SAP-GGF-validation/v1: source rows not referenced by selected account/OP bases; catalog used only for identity";
      const control = definition.decodeControl(await this.client.get(definition.controlPath));
      if (control.expectedRows !== ids.length)
        throw new GgfError("sourceRead", ["Count changed during calculation read"]);
    }
    return {
      id: `SAP-${crypto.randomUUID()}`,
      origin: "sap",
      capturedAt: new Date().toISOString(),
      filter: { ...filter },
      balances,
      orders: normalized,
      evidence: { currency: "SAP_LOCAL", reads: evidence }
    };
  }
}
