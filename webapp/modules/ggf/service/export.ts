import { formatDecimal } from "../../../core/util/money";
import type { AllocationResult } from "../engine/types";

// Neutralize spreadsheet formulas in identifiers and descriptions.
function cell(value: string): string {
  const safe = /^[=+@\-\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function exportCsv(result: AllocationResult): string {
  const rows: string[][] = [
    [
      "origin",
      result.snapshot.origin,
      "snapshot",
      result.snapshot.id,
      "capturedAt",
      result.snapshot.capturedAt
    ],
    [
      "start",
      result.snapshot.filter.start,
      "end",
      result.snapshot.filter.end,
      "branch",
      result.snapshot.filter.branch,
      "costCenter",
      result.snapshot.filter.costCenter
    ],
    [
      "total",
      formatDecimal(result.total),
      "distributed",
      formatDecimal(result.distributed),
      "difference",
      formatDecimal(result.difference)
    ],
    [],
    [
      "order",
      "item",
      "directCost",
      "quantity",
      "hours",
      "currentCost",
      "ggf",
      "resultingCost",
      "sourceRefs"
    ],
    ...result.orders.map((o) => [
      o.order.id,
      o.order.item,
      o.order.directCost ?? "UNAVAILABLE",
      o.order.quantity ?? "UNAVAILABLE",
      o.order.hours ?? "UNAVAILABLE",
      o.current === null ? "UNAVAILABLE" : formatDecimal(o.current),
      formatDecimal(o.allocated),
      o.resulting === null ? "UNAVAILABLE" : formatDecimal(o.resulting),
      o.order.sourceRefs.join(" | ")
    ]),
    [],
    [
      "readId",
      "dataset",
      "sourceRef",
      "currency",
      "pagesRead",
      "receivedRows",
      "expectedRows",
      "exhausted",
      "reconciliationRef",
      "scope",
      "requestPath",
      "controlPath",
      "excludedSourceRefs",
      "exclusionRef"
    ],
    ...result.snapshot.evidence.reads.map((read) => [
      read.id,
      read.dataset,
      read.sourceRef,
      result.snapshot.evidence.currency,
      String(read.pagesRead),
      String(read.receivedRows),
      String(read.expectedRows),
      String(read.exhausted),
      read.reconciliationRef,
      read.scope ?? "",
      read.requestPath ?? "",
      read.controlPath ?? "",
      read.excludedSourceRefs?.join(" | ") ?? "",
      read.exclusionRef ?? ""
    ]),
    [],
    [
      "order",
      "basis",
      "unit",
      "comparisonKey",
      "normalizationRef",
      "readId",
      "sourceRefs",
      "supportingReads"
    ],
    ...result.orders.flatMap(({ order }) =>
      Object.entries(order.basisEvidence).flatMap(([key, basis]) =>
        basis
          ? [
              [
                order.id,
                key,
                basis.unit,
                basis.comparisonKey,
                basis.normalizationRef,
                basis.readId,
                basis.sourceRefs.join(" | "),
                JSON.stringify(basis.supportingReads ?? [])
              ]
            ]
          : [
              [
                order.id,
                key,
                "UNAVAILABLE",
                order.unavailable?.[key as keyof typeof order.unavailable] ?? ""
              ]
            ]
      )
    ),
    [],
    [
      "order",
      "resourceGroup",
      "groupBasis",
      "value",
      "unit",
      "comparisonKey",
      "normalizationRef",
      "readId",
      "sourceRefs",
      "resourceRefs",
      "supportingReads"
    ],
    ...result.orders.flatMap(({ order }) =>
      Object.entries(order.resourceBases ?? {}).flatMap(([group, bases]) =>
        Object.entries(bases).map(([kind, measure]) => [
          order.id,
          group,
          kind,
          measure.value,
          measure.evidence.unit,
          measure.evidence.comparisonKey,
          measure.evidence.normalizationRef,
          measure.evidence.readId,
          measure.evidence.sourceRefs.join(" | "),
          measure.resourceRefs.join(" | "),
          JSON.stringify(measure.evidence.supportingReads ?? [])
        ])
      )
    ),
    [],
    [
      "account",
      "periodAmount",
      "accountPercent",
      "applicableAmount",
      "accountRoundingNumerator/10000cent",
      "distributed",
      "difference"
    ],
    ...result.accounts.map((a) => [
      a.account,
      formatDecimal(a.periodAmount),
      a.percent,
      formatDecimal(a.applicableAmount),
      String(a.roundingNumerator),
      formatDecimal(a.distributed),
      formatDecimal(a.difference)
    ]),
    [],
    ["order", "componentKind", "componentCode", "componentAmount", "sourceRefs"],
    ...result.orders.flatMap(({ order }) =>
      (order.directCostComponents ?? []).map((c) => [
        order.id,
        c.kind,
        c.code,
        c.amount,
        c.sourceRefs.join(" | ")
      ])
    ),
    [],
    [
      "account",
      "classification",
      "criterion",
      "group",
      "percent",
      "order",
      "accountAmount",
      "accountPercent",
      "applicableAmount",
      "basisKind",
      "basisUnit",
      "participationPercent",
      "groupRoundingMinor",
      "groupFractionalCentNumerator/10000",
      "poolAmount",
      "basis",
      "totalBasis",
      "fractionalCentNumerator",
      "fractionalCentDenominator",
      "roundingMinor",
      "allocated",
      "sourceRefs"
    ],
    ...result.traces.map((t) => [
      t.account,
      t.classificationId,
      t.criterion,
      t.group,
      t.percent,
      t.orderId,
      formatDecimal(t.accountAmount),
      t.accountPercent,
      formatDecimal(t.applicableAmount),
      t.basisKind,
      t.basisUnit,
      t.participationPercent,
      String(t.groupRoundingMinor),
      String(t.groupRemainder),
      formatDecimal(t.poolAmount),
      formatDecimal(t.basis, t.basisDecimals),
      formatDecimal(t.totalBasis, t.basisDecimals),
      String(t.remainder),
      String(t.totalBasis),
      String(t.roundingMinor),
      formatDecimal(t.amount),
      result.snapshot.balances.find((b) => b.account === t.account)!.sourceRefs.join(" | ")
    ])
  ];
  return "\uFEFF" + rows.map((row) => row.map(cell).join(";")).join("\r\n");
}
