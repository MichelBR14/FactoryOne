import { formatDecimal, parseDecimal, sum } from "../../../core/util/money";
import { GgfError } from "./errors";
import { validateSourceEvidence } from "./sourceEvidence";
export { GgfError } from "./errors";
import {
  CRITERIA,
  type AllocationResult,
  type AllocationTrace,
  type Configuration,
  type PeriodFilter,
  type SourceSnapshot
} from "./types";

const fail = (code: string, ...details: string[]): never => {
  throw new GgfError(code, details);
};
const required = (value: unknown, context: string): void => {
  if (typeof value !== "string" || !value.trim() || value !== value.trim())
    fail("required", context);
};
export function decimal(value: string, places: number, context: string, signed = false): bigint {
  if (
    typeof value !== "string" ||
    !new RegExp(`^${signed ? "-?" : ""}\\d+(?:\\.\\d{1,${places}})?$`).test(value)
  ) {
    fail("decimal", context, String(places));
  }
  return parseDecimal(value, places);
}
function unique(values: string[], context: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    required(value, context);
    if (seen.has(value)) fail("duplicate", context, value);
    seen.add(value);
  }
}
export function validatePeriod(filter: PeriodFilter): void {
  for (const value of [filter.start, filter.end]) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value
    )
      fail("date");
  }
  if (filter.start > filter.end) fail("date");
}
export function validateConfiguration(config: Configuration): void {
  unique(
    config.classifications.map((c) => c.id),
    "classification"
  );
  for (const c of config.classifications) required(c.name, c.id);
  unique(
    config.accounts.map((a) => a.account),
    "account"
  );
  if (!config.accounts.some((a) => a.active)) fail("noAccounts");
  for (const a of config.accounts) {
    required(a.name, a.account);
    if (typeof a.active !== "boolean" || !CRITERIA.includes(a.criterion))
      fail("criterion", a.account);
    if (!config.classifications.some((c) => c.id === a.classificationId))
      fail("classification", a.account);
    if (decimal(a.percent === undefined ? "100" : a.percent, 2, a.account) > 10000n)
      fail("accountPercentage", a.account);
    const groups = config.groupShares.filter((g) => g.account === a.account);
    if (a.criterion !== "RESOURCE_GROUP") {
      if (groups.length) fail("unexpectedGroups", a.account);
      continue;
    }
    unique(
      groups.map((g) => g.group),
      a.account
    );
    const percentages = groups.map((g) => decimal(g.percent, 2, `${a.account} / ${g.group}`));
    if (
      groups.some(
        (g) =>
          !["HOURS", "RESOURCE_QUANTITY", "RESOURCE_VALUE"].includes(
            g.basis === undefined ? "HOURS" : g.basis
          )
      )
    )
      fail("criterion", a.account);
    if (percentages.some((p) => p > 10000n) || sum(percentages) !== 10000n)
      fail("percentage", a.account);
  }
  for (const g of config.groupShares) {
    if (!config.accounts.some((a) => a.account === g.account)) fail("account", g.account);
  }
}

/** Exact signed largest remainder; ties use stable IDs, never input order. */
function apportion(
  amount: bigint,
  weights: Array<{ id: string; weight: bigint }>,
  context: string
) {
  const total = sum(weights.map((w) => w.weight));
  if (total <= 0n) fail("zeroBasis", context);
  const sign = amount < 0n ? -1n : 1n;
  const absolute = amount * sign;
  const rows = weights.map((w) => ({
    ...w,
    amount: (absolute * w.weight) / total,
    remainder: (absolute * w.weight) % total,
    roundingMinor: 0n
  }));
  let rest = absolute - sum(rows.map((r) => r.amount));
  const ranked = [...rows].sort((a, b) =>
    a.remainder === b.remainder
      ? a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0
      : a.remainder > b.remainder
        ? -1
        : 1
  );
  for (const row of ranked) {
    if (rest === 0n) break;
    row.amount += 1n;
    row.roundingMinor = sign;
    rest -= 1n;
  }
  return rows.map((row) => ({ ...row, amount: row.amount * sign, total }));
}

export function allocate(config: Configuration, snapshot: SourceSnapshot): AllocationResult {
  validateConfiguration(config);
  validatePeriod(snapshot.filter);
  validateSourceEvidence(snapshot, config);
  unique(
    snapshot.orders.map((o) => o.id),
    "order"
  );
  unique(
    snapshot.balances.map((b) => b.account),
    "balance"
  );
  const normalized = snapshot.orders.map((order) => {
    const direct =
      order.directCost === null
        ? null
        : decimal(order.directCost, 2, `${order.number} / DIRECT_COST`);
    const quantity =
      order.quantity === null ? null : decimal(order.quantity, 6, `${order.number} / QUANTITY`);
    const hours = order.hours === null ? null : decimal(order.hours, 6, `${order.number} / HOURS`);
    const current =
      order.currentCost === null
        ? null
        : decimal(order.currentCost, 2, `${order.number} / currentCost`, true);
    const groups = new Map(
      Object.entries(order.groupHours).map(([key, value]) => [
        key,
        decimal(value, 6, `${order.number} / ${key}`)
      ])
    );
    if (hours !== null && sum([...groups.values()]) !== hours) fail("groupHours", order.number);
    if (order.directCostComponents) {
      if (
        direct === null ||
        order.directCostComponents.some((c) => !c.code || !c.kind || !c.sourceRefs.length) ||
        sum(order.directCostComponents.map((c) => decimal(c.amount, 2, c.code))) !== direct
      )
        fail("sourceEvidence", `${order.number} / directCostComponents`);
    }
    if (
      snapshot.origin === "sap" &&
      config.accounts.some((a) => a.active && a.criterion === "DIRECT_COST") &&
      !order.directCostComponents?.length
    )
      fail("sourceEvidence", `${order.number} / directCostComponents`);
    return { order, direct, quantity, hours, current, groups };
  });
  const traces: AllocationTrace[] = [];
  const criteria = CRITERIA.map((criterion) => ({ criterion, amount: 0n }));
  const accounts: AllocationResult["accounts"] = [];
  let total = 0n;
  for (const rule of config.accounts.filter((a) => a.active)) {
    const balance = snapshot.balances.find((b) => b.account === rule.account);
    if (!balance) throw new GgfError("missingBalance", [rule.account]);
    const periodAmount = decimal(balance.amount, 2, rule.account, true);
    const accountPercent = rule.percent === undefined ? "100" : rule.percent;
    const numerator = periodAmount * decimal(accountPercent, 2, rule.account);
    // One explicit half-away-from-zero rounding at the account boundary.
    const sign = numerator < 0n ? -1n : 1n;
    const amount = ((numerator * sign + 5000n) / 10000n) * sign;
    const accountRoundingNumerator = amount * 10000n - numerator;
    total += amount;
    criteria.find((c) => c.criterion === rule.criterion)!.amount += amount;
    const groups = config.groupShares.filter((g) => g.account === rule.account);
    const pools =
      rule.criterion === "RESOURCE_GROUP"
        ? apportion(
            amount,
            groups.map((g) => ({ id: g.group, weight: decimal(g.percent, 2, g.group) })),
            rule.account
          )
            .filter((g) => g.weight > 0n)
            .map((g) => ({
              group: g.id,
              percent: groups.find((s) => s.group === g.id)!.percent,
              amount: g.amount,
              kind: groups.find((s) => s.group === g.id)!.basis ?? "HOURS",
              groupRoundingMinor: g.roundingMinor,
              groupRemainder: g.remainder
            }))
        : [
            {
              group: "",
              percent: "100",
              amount,
              kind: rule.criterion,
              groupRoundingMinor: 0n,
              groupRemainder: 0n
            }
          ];
    for (const pool of pools) {
      let basisUnit = "";
      const eligible = pool.group
        ? normalized.filter((o) =>
            pool.kind === "HOURS"
              ? Object.hasOwn(o.order.groupHours, pool.group)
              : o.order.resourceBases?.[pool.group] !== undefined
          )
        : normalized;
      const weights = eligible.map((o) => {
        const measure =
          pool.group && pool.kind !== "HOURS"
            ? o.order.resourceBases?.[pool.group]?.[
                pool.kind as "RESOURCE_VALUE" | "RESOURCE_QUANTITY"
              ]
            : undefined;
        if (pool.group && pool.kind !== "HOURS" && !measure)
          fail("basisUnavailable", `${o.order.number} / ${pool.group} / ${pool.kind}`);
        const evidence =
          measure?.evidence ??
          o.order.basisEvidence[
            rule.criterion === "DIRECT_COST"
              ? "directCost"
              : rule.criterion === "QUANTITY"
                ? "quantity"
                : "hours"
          ];
        basisUnit = evidence?.unit ?? "";
        return {
          id: o.order.id,
          weight:
            rule.criterion === "DIRECT_COST"
              ? o.direct
              : rule.criterion === "QUANTITY"
                ? o.quantity
                : rule.criterion === "HOURS"
                  ? o.hours
                  : pool.kind === "HOURS"
                    ? (o.groups.get(pool.group) ?? 0n)
                    : decimal(
                        measure!.value,
                        pool.kind === "RESOURCE_VALUE" ? 2 : 6,
                        `${o.order.number} / ${pool.group}`
                      )
        };
      });
      if (weights.some((w) => w.weight === null)) fail("basisUnavailable", rule.account);
      for (const row of apportion(
        pool.amount,
        weights as Array<{ id: string; weight: bigint }>,
        `${rule.account}${pool.group ? ` / ${pool.group}` : ""}`
      )) {
        traces.push({
          account: rule.account,
          classificationId: rule.classificationId,
          criterion: rule.criterion,
          orderId: row.id,
          group: pool.group,
          percent: pool.percent,
          accountAmount: periodAmount,
          accountPercent,
          applicableAmount: amount,
          accountRoundingNumerator,
          groupRoundingMinor: pool.groupRoundingMinor,
          groupRemainder: pool.groupRemainder,
          basisKind: pool.kind,
          basisUnit,
          participationPercent: formatDecimal(
            (row.weight * 100000000n + row.total / 2n) / row.total,
            6
          ),
          poolAmount: pool.amount,
          basis: row.weight,
          totalBasis: row.total,
          basisDecimals: rule.criterion === "DIRECT_COST" || pool.kind === "RESOURCE_VALUE" ? 2 : 6,
          remainder: row.remainder,
          roundingMinor: row.roundingMinor,
          amount: row.amount
        });
      }
    }
    const distributed = sum(traces.filter((t) => t.account === rule.account).map((t) => t.amount));
    if (distributed !== amount) fail("reconciliation", rule.account);
    accounts.push({
      account: rule.account,
      periodAmount,
      percent: accountPercent,
      applicableAmount: amount,
      roundingNumerator: accountRoundingNumerator,
      distributed,
      difference: amount - distributed
    });
  }
  const orders = normalized.map((o) => {
    const allocated = sum(traces.filter((t) => t.orderId === o.order.id).map((t) => t.amount));
    return {
      order: structuredClone(o.order),
      allocated,
      current: o.current,
      resulting: o.current === null ? null : o.current + allocated
    };
  });
  const distributed = sum(orders.map((o) => o.allocated));
  if (total !== distributed) fail("reconciliation", formatDecimal(total - distributed));
  return {
    snapshot: structuredClone(snapshot),
    configuration: structuredClone(config),
    total,
    distributed,
    difference: total - distributed,
    criteria,
    accounts,
    orders,
    traces
  };
}
