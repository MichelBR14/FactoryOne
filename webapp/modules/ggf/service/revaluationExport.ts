import type { RevaluationPreview } from "./RevaluationPreview";

export function exportRevaluationCsv(preview: RevaluationPreview): string {
  const columns = ["order", "item", "name", "warehouse", "method", "unit", "planned", "produced", "stock", "eligible", "currentCost", "costSource", "ggf", "unitGgf", "adjustedCost", "estimated", "status", "reasons"] as const;
  const rows = [
    ["origin", preview.origin, "company", preview.company, "technicalOnly", String(preview.technicalOnly), "postingBlocked", "true"],
    ["allocation", preview.allocationId, "allocationDate", preview.allocationDate, "stockDate", preview.stockDate],
    [...columns], ...preview.rows.map(r => columns.map(c => Array.isArray(r[c]) ? (r[c] as string[]).join(" | ") : String(r[c] ?? "UNAVAILABLE"))),
    ["totalGgf", preview.totalGgf!, "estimatedTotal", preview.estimatedTotal ?? "UNAVAILABLE"],
    ["scope", "item", "warehouse", "stock", "targetPrice", "estimated", "ready"],
    ...preview.scopes.map(s => [s.key, s.item, s.warehouse, s.stock ?? "UNAVAILABLE", s.targetPrice ?? "UNAVAILABLE", s.estimate ?? "UNAVAILABLE", String(s.ready)])
  ];
  const cell = (v: string) => `"${(/^[=+@\-\t\r]/.test(v) ? "'" + v : v).replaceAll('"', '""')}"`;
  return "\uFEFF" + rows.map(row => row.map(cell).join(";")).join("\r\n");
}
