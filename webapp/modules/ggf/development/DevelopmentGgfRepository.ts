import { formatDecimal, sum } from "../../../core/util/money";
import { decimal, GgfError, validateConfiguration, validatePeriod } from "../engine/allocation";
import type {
  BasisEvidence,
  Configuration,
  PeriodFilter,
  SourceDataset,
  SourceSnapshot
} from "../engine/types";
import type { GgfRepository } from "../repository/GgfRepository";
import { demoConfiguration, demoLedger, demoOrders, demoProduction } from "./fixtures";

export const DEVELOPMENT_CONFIG_KEY = "factoreone.development.ggf.config.v1";
type StoragePort = Pick<Storage, "getItem" | "setItem">;

export class DevelopmentGgfRepository implements GgfRepository {
  readonly mode = "development" as const;
  constructor(private readonly storage: StoragePort) {}

  async getCatalog() {
    return {
      branches: ["DEV-01", "DEV-02"],
      costCenters: ["FABRICA", "APOIO"],
      resourceGroups: ["MAQUINA", "EQUIPE"]
    };
  }
  async loadConfiguration(): Promise<Configuration> {
    const stored = this.storage.getItem(DEVELOPMENT_CONFIG_KEY);
    if (!stored) return structuredClone(demoConfiguration);
    try {
      const parsed = JSON.parse(stored) as Configuration;
      for (const account of parsed.accounts)
        if (account.percent === undefined) account.percent = "100";
      validateConfiguration(parsed);
      return parsed;
    } catch {
      throw new GgfError("storedConfiguration");
    }
  }
  async saveConfiguration(config: Configuration): Promise<void> {
    validateConfiguration(config);
    this.storage.setItem(DEVELOPMENT_CONFIG_KEY, JSON.stringify(config));
  }
  async loadSnapshot(filter: PeriodFilter, config: Configuration): Promise<SourceSnapshot> {
    validatePeriod(filter);
    validateConfiguration(config);
    const matches = (row: { date: string; branch: string; costCenter: string }) =>
      row.date >= filter.start &&
      row.date <= filter.end &&
      (!filter.branch || filter.branch === row.branch) &&
      (!filter.costCenter || filter.costCenter === row.costCenter);
    const balances = config.accounts
      .filter((a) => a.active)
      .map((a) => {
        if (!demoConfiguration.accounts.some((d) => d.account === a.account))
          throw new GgfError("missingBalance", [a.account]);
        const rows = demoLedger.filter(
          (r) => matches(r) && r.account === a.account && !r.generatedByGgf
        );
        return {
          account: a.account,
          amount: formatDecimal(sum(rows.map((r) => decimal(r.amount, 2, r.id, true)))),
          currency: "BRL",
          readId: "DEV-balances",
          sourceRefs: rows.map((r) => r.id)
        };
      });
    const orders = demoOrders.flatMap((order) => {
      const moves = demoProduction.filter((m) => m.orderId === order.id && matches(m));
      if (!moves.length) return [];
      const groupHours = Object.fromEntries(
        ["MAQUINA", "EQUIPE"].map((group) => [
          group,
          formatDecimal(
            sum(moves.map((m) => decimal(m.groupHours[group as "MAQUINA" | "EQUIPE"], 6, m.id))),
            6
          )
        ])
      );
      const basis = (
        unit: string,
        key: string,
        dataset: SourceDataset,
        refs: string[]
      ): BasisEvidence => ({
        unit,
        comparisonKey: `DEV-${key}-v1`,
        normalizationRef: `development/fixtures/v1/${key}-identity`,
        readId: `DEV-${dataset}`,
        sourceRefs: refs
      });
      return [
        {
          ...order,
          directCost: formatDecimal(sum(moves.map((m) => decimal(m.directCost, 2, m.id)))),
          directCostComponents: moves.flatMap((m) => [
            {
              kind: "DEVELOPMENT_MATERIAL",
              code: `${m.id}-MATERIAL`,
              amount: m.materials,
              sourceRefs: [m.id]
            },
            {
              kind: "DEVELOPMENT_RESOURCE",
              code: `${m.id}-RESOURCE`,
              amount: m.resources,
              sourceRefs: [m.id]
            }
          ]),
          resourceBases: Object.fromEntries(
            (["MAQUINA", "EQUIPE"] as const).map((group) => [
              group,
              {
                RESOURCE_QUANTITY: {
                  value: formatDecimal(
                    sum(moves.map((m) => decimal(m.resourceConsumption[group].quantity, 6, m.id))),
                    6
                  ),
                  evidence: basis(
                    `DEV-${group}-UNIT`,
                    `${group}-quantity`,
                    "production",
                    moves.map((m) => m.id)
                  ),
                  resourceRefs: [`DEV-RESOURCE-${group}`]
                },
                RESOURCE_VALUE: {
                  value: formatDecimal(
                    sum(moves.map((m) => decimal(m.resourceConsumption[group].value, 2, m.id)))
                  ),
                  evidence: basis(
                    "BRL",
                    `${group}-value`,
                    "production",
                    moves.map((m) => m.id)
                  ),
                  resourceRefs: [`DEV-RESOURCE-${group}`]
                }
              }
            ])
          ),
          quantity: formatDecimal(sum(moves.map((m) => decimal(m.quantity, 6, m.id))), 6),
          hours: formatDecimal(
            sum(Object.values(groupHours).map((h) => decimal(h, 6, order.id))),
            6
          ),
          groupHours,
          basisEvidence: {
            quantity: basis(
              "DEV-UNIT",
              "quantity",
              "production",
              moves.map((m) => m.id)
            ),
            hours: basis(
              "h",
              "hours",
              "production",
              moves.map((m) => m.id)
            ),
            directCost: basis(
              "BRL",
              "directCost",
              "production",
              moves.map((m) => m.id)
            ),
            currentCost: basis("BRL", "currentCost", "currentCosts", [order.id])
          },
          sourceRefs: moves.map((m) => m.id)
        }
      ];
    });
    return {
      id: `DEV-${crypto.randomUUID()}`,
      origin: "development",
      capturedAt: new Date().toISOString(),
      filter: { ...filter },
      balances,
      orders,
      evidence: {
        currency: "BRL",
        reads: (["balances", "production", "currentCosts"] as const).map((dataset) => {
          // Independent counts from the finite fictional source, scoped to this request.
          const count =
            dataset === "balances"
              ? demoLedger.filter(
                  (r) =>
                    matches(r) &&
                    !r.generatedByGgf &&
                    config.accounts.some((a) => a.active && a.account === r.account)
                ).length
              : dataset === "production"
                ? demoProduction.filter(matches).length
                : demoOrders.filter((o) =>
                    demoProduction.some((m) => m.orderId === o.id && matches(m))
                  ).length;
          const receivedRows =
            dataset === "balances"
              ? balances.reduce((n, b) => n + b.sourceRefs.length, 0)
              : dataset === "production"
                ? orders.reduce((n, o) => n + o.sourceRefs.length, 0)
                : orders.length;
          return {
            id: `DEV-${dataset}`,
            dataset,
            sourceRef: `development/fixtures/v1/${dataset}`,
            filter: { ...filter },
            pagesRead: 1,
            receivedRows,
            expectedRows: count,
            exhausted: true,
            reconciliationRef: `development/fixtures/v1/${dataset}-filtered-count`
          };
        })
      }
    };
  }
}
