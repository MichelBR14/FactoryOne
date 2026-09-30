import { formatDecimal, parseDecimal } from "../../../core/util/money";
import { allocate } from "../engine/allocation";
import { GgfError } from "../engine/errors";
import { SapGgfCalculationSource } from "../repository/SapGgfCalculationSource";
import type { GgfReadClient } from "../repository/MappedGgfSource";
import type { PeriodFilter, Configuration, SourceSnapshot } from "../engine/types";
import type {
  AbsorptionCategory,
  AbsorptionMapping,
  AbsorptionReport,
  AbsorptionSourceData
} from "./types";

const TECHNICAL_ACCOUNT = (category: AbsorptionCategory) => `FACTORYONE-ABSORPTION-${category}`;
const TECHNICAL_ORDERS: Record<string, number> = { "76": 203, "77": 204, "79": 206 };

export type DistributionStatus =
  | "CALCULATED_TECHNICAL"
  | "CONCILIATED"
  | "BLOCKED_CONFIGURATION"
  | "BLOCKED_NO_ACCOUNT"
  | "BLOCKED_NO_ORDER"
  | "BLOCKED_BASIS"
  | "BLOCKED_INCOMPATIBLE_BASIS"
  | "BLOCKED_SOURCE";

export interface CategoryDistribution {
  category: AbsorptionCategory;
  criterion: string | null;
  status: DistributionStatus;
  differenceCents: bigint;
  allocatedCents: bigint;
  residualCents: bigint;
  blocker: string;
  warnings: string[];
  snapshot?: SourceSnapshot;
  allocation?: ReturnType<typeof allocate>;
}

export interface AbsorptionOrderResult {
  orderNumber: string;
  item: string;
  itemDescription: string;
  producedQuantity: string | null;
  quantityUnit: string | null;
  standardModCents: bigint;
  standardGgfCents: bigint;
  modAdjustmentCents: bigint;
  ggfAdjustmentCents: bigint;
  totalAdjustmentCents: bigint;
  originalCostCents: bigint | null;
  costAfterAbsorptionCents: bigint | null;
  bases: Array<{
    category: AbsorptionCategory;
    criterion: string;
    group: string;
    base: bigint;
    totalBase: bigint;
    basisUnit: string;
    basisDecimals: number;
    participationPercent: string;
    amountCents: bigint;
    roundingMinor: bigint;
    sourceRefs: string[];
  }>;
  directCostComponents: NonNullable<SourceSnapshot["orders"][number]["directCostComponents"]>;
}

export interface AbsorptionDistribution {
  categories: CategoryDistribution[];
  orders: AbsorptionOrderResult[];
  totalDifferenceCents: bigint;
  totalAllocatedCents: bigint;
  residualCents: bigint;
  technicalHomologation: true;
  warnings: string[];
}

function blocked(
  category: AbsorptionCategory,
  status: DistributionStatus,
  differenceCents: bigint,
  message: string,
  criterion: string | null = null
): CategoryDistribution {
  return {
    category,
    criterion,
    status,
    differenceCents,
    allocatedCents: 0n,
    residualCents: differenceCents,
    blocker: message,
    warnings: []
  };
}

function errorStatus(error: unknown): DistributionStatus {
  if (!(error instanceof GgfError)) return "BLOCKED_SOURCE";
  if (error.code === "basisUnavailable" || error.code === "zeroBasis") return "BLOCKED_BASIS";
  if (error.code === "sourceEvidence" && error.details.some((detail) => detail.includes("comparisonKey")))
    return "BLOCKED_INCOMPATIBLE_BASIS";
  if (["percentage", "accountPercentage", "criterion", "classification", "duplicate"].includes(error.code))
    return "BLOCKED_CONFIGURATION";
  return "BLOCKED_SOURCE";
}

function readConfiguration(
  category: AbsorptionCategory,
  mapping: AbsorptionMapping
): Configuration | undefined {
  const accounts = mapping.accounts.filter((item) => item.category === category);
  const setting = mapping.distribution?.[category];
  if (!accounts.length || !setting) return undefined;
  const classificationId = `TECH-${category}`;
  return {
    classifications: [{ id: classificationId, name: `${category} homologação técnica` }],
    accounts: accounts.map((item) => ({
      account: item.account,
      name: item.account,
      classificationId,
      criterion: setting.criterion,
      percent: "100",
      active: true
    })),
    groupShares: (setting.groupShares ?? []).flatMap((share) =>
      accounts.map((item) => ({ account: item.account, ...share }))
    )
  };
}

function allocationConfiguration(
  category: AbsorptionCategory,
  mapping: AbsorptionMapping
): Configuration {
  const setting = mapping.distribution![category]!;
  const account = TECHNICAL_ACCOUNT(category);
  return {
    classifications: [{ id: `TECH-${category}`, name: `${category} homologação técnica` }],
    accounts: [{
      account,
      name: `${category} a absorver`,
      classificationId: `TECH-${category}`,
      criterion: setting.criterion,
      percent: "100",
      active: true
    }],
    groupShares: (setting.groupShares ?? []).map((share) => ({ account, ...share }))
  };
}

function allocationSnapshot(
  category: AbsorptionCategory,
  amount: bigint,
  mapping: AbsorptionMapping,
  snapshot: SourceSnapshot
): SourceSnapshot {
  const mappedAccounts = new Set(mapping.accounts.filter((item) => item.category === category).map((item) => item.account));
  const sourceRefs = [...new Set(snapshot.balances
    .filter((balance) => mappedAccounts.has(balance.account))
    .flatMap((balance) => balance.sourceRefs))];
  return {
    ...snapshot,
    balances: [{
      account: TECHNICAL_ACCOUNT(category),
      amount: formatDecimal(amount, 2),
      currency: snapshot.evidence.currency,
      readId: snapshot.balances[0]?.readId ?? "JournalEntries",
      sourceRefs
    }]
  };
}

function matchingOrders(
  data: AbsorptionSourceData,
  orderNumbers: readonly string[]
): number[] | undefined {
  if (!orderNumbers.length || new Set(orderNumbers).size !== orderNumbers.length) return undefined;
  const selected = orderNumbers.map((number) => data.orders.find((order) => order.number === number));
  if (selected.some((order) => !order)) return undefined;
  return selected.map((order) => Number(order!.entry));
}

/** Reuses the SAP-validated source and V1 allocation engine; MOD and GGF are isolated. */
export async function calculateAbsorptionDistribution(
  client: GgfReadClient,
  source: AbsorptionSourceData,
  report: AbsorptionReport,
  filter: AbsorptionReport["filter"],
  mapping: AbsorptionMapping
): Promise<AbsorptionDistribution> {
  const totals = new Map(report.reconciliation.map((row) => [row.category, row.differenceCents]));
  const categories: CategoryDistribution[] = [];
  for (const category of ["MOD", "GGF"] as const) {
    const differenceCents = totals.get(category) ?? 0n;
    if (!mapping.technicalHomologation) {
      categories.push(blocked(category, "BLOCKED_CONFIGURATION", differenceCents, "Homologação técnica explícita obrigatória."));
      continue;
    }
    const mappedAccounts = mapping.accounts.filter((item) => item.category === category);
    const setting = mapping.distribution?.[category];
    if (!mappedAccounts.length) {
      categories.push(blocked(category, "BLOCKED_NO_ACCOUNT", differenceCents, `Nenhuma conta real foi mapeada explicitamente para ${category}.`));
      continue;
    }
    if (!setting || !setting.criterion || !Array.isArray(setting.orderNumbers)) {
      categories.push(blocked(category, "BLOCKED_CONFIGURATION", differenceCents, `Critério e OPs elegíveis não configurados para ${category}.`));
      continue;
    }
    if (filter.branch || filter.dimensions.some(Boolean)) {
      categories.push(blocked(category, "BLOCKED_CONFIGURATION", differenceCents, "Filial/dimensões do razão não são comprovadas na fonte de base de produção." , setting.criterion));
      continue;
    }
    const orderEntries = matchingOrders(source, setting.orderNumbers);
    if (!orderEntries) {
      categories.push(blocked(category, "BLOCKED_NO_ORDER", differenceCents, "Selecione OPs SAP existentes, sem duplicidade, para a parcela." , setting.criterion));
      continue;
    }
    const sourceConfig = readConfiguration(category, mapping);
    if (!sourceConfig) {
      categories.push(blocked(category, "BLOCKED_CONFIGURATION", differenceCents, `Configuração de distribuição ausente para ${category}.`, setting.criterion));
      continue;
    }
    try {
      const basisSnapshot = await new SapGgfCalculationSource(client, {
        orderEntries,
        ...(setting.criterion === "DIRECT_COST" ? { directCostPolicy: "DOCUMENTED_MATERIALS_AND_RESOURCES" as const } : {})
      }).loadSnapshot({
        start: filter.start,
        end: filter.end,
        branch: filter.branch,
        costCenter: ""
      } satisfies PeriodFilter, sourceConfig);
      const syntheticSnapshot = allocationSnapshot(category, differenceCents, mapping, basisSnapshot);
      const allocation = allocate(allocationConfiguration(category, mapping), syntheticSnapshot);
      categories.push({
        category,
        criterion: setting.criterion,
        status: differenceCents === 0n ? "CONCILIATED" : "CALCULATED_TECHNICAL",
        differenceCents,
        allocatedCents: allocation.distributed,
        residualCents: allocation.difference,
        blocker: "",
        warnings: [...report.blockers],
        snapshot: basisSnapshot,
        allocation
      });
    } catch (error) {
      categories.push(blocked(
        category,
        errorStatus(error),
        differenceCents,
        error instanceof Error ? error.message : "Fonte de base indisponível.",
        setting.criterion
      ));
    }
  }
  const byOrder = new Map<string, AbsorptionOrderResult>();
  for (const categoryResult of categories) {
    const result = categoryResult.allocation;
    const setting = mapping.distribution?.[categoryResult.category];
    if (!result || !setting) continue;
    for (const row of result.orders) {
      const number = row.order.number;
      const summary = byOrder.get(number) ?? {
        orderNumber: number,
        item: row.order.item,
        itemDescription: source.orders.find((order) => order.number === number)?.itemDescription ?? "",
        producedQuantity: row.order.quantity,
        quantityUnit: row.order.basisEvidence.quantity?.unit ?? null,
        standardModCents: 0n,
        standardGgfCents: 0n,
        modAdjustmentCents: 0n,
        ggfAdjustmentCents: 0n,
        totalAdjustmentCents: 0n,
        originalCostCents: row.order.directCost === null ? null : parseDecimal(row.order.directCost, 2),
        costAfterAbsorptionCents: null,
        bases: [],
        directCostComponents: row.order.directCostComponents ?? []
      };
      const amount = categoryResult.category === "MOD" ? "modAdjustmentCents" : "ggfAdjustmentCents";
      summary[amount] = row.allocated;
      summary.totalAdjustmentCents = summary.modAdjustmentCents + summary.ggfAdjustmentCents;
      summary.costAfterAbsorptionCents = summary.originalCostCents === null
        ? null
        : summary.originalCostCents + summary.totalAdjustmentCents;
      const traces = result.traces.filter((trace) => trace.orderId === row.order.id);
      summary.bases.push(...traces.map((trace) => ({
        category: categoryResult.category,
        criterion: trace.criterion,
        group: trace.group,
        base: trace.basis,
        totalBase: trace.totalBasis,
        basisUnit: trace.basisUnit,
        basisDecimals: trace.basisDecimals,
        participationPercent: trace.participationPercent,
        amountCents: trace.amount,
        roundingMinor: trace.roundingMinor,
        sourceRefs: row.order.sourceRefs
      })));
      byOrder.set(number, summary);
    }
  }
  const orders = [...byOrder.values()].map((row) => {
    const sourceOrder = source.orders.find((order) => order.number === row.orderNumber);
    for (const absorbed of report.resources.filter((resource) => resource.order === row.orderNumber)) {
      if (absorbed.category === "MOD") row.standardModCents += absorbed.amountCents;
      else row.standardGgfCents += absorbed.amountCents;
    }
    if (!sourceOrder) return row;
    return row;
  }).sort((a, b) => a.orderNumber.localeCompare(b.orderNumber, undefined, { numeric: true }));
  const totalDifferenceCents = categories.reduce((total, item) => total + item.differenceCents, 0n);
  const totalAllocatedCents = categories.reduce((total, item) => total + item.allocatedCents, 0n);
  return {
    categories,
    orders,
    totalDifferenceCents,
    totalAllocatedCents,
    residualCents: totalDifferenceCents - totalAllocatedCents,
    technicalHomologation: true,
    warnings: [...new Set(categories.flatMap((item) => item.warnings))]
  };
}
