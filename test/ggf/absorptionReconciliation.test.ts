import { describe, expect, it } from "vitest";
import { parseDecimal } from "../../webapp/core/util/money";
import { reconcileAbsorption, absorptionDifferencesAsBalances } from "../../webapp/modules/ggf/absorption/reconciliation";
import type { AbsorptionMapping, AbsorptionSourceData } from "../../webapp/modules/ggf/absorption/types";

const cents = (value: string) => parseDecimal(value, 2);
const source: AbsorptionSourceData = {
  company: "SBODEMOBR2",
  filter: { start: "2026-09-01", end: "2026-09-30", branch: "", dimensions: ["", "", "", "", ""] },
  accounts: [{ code: "4.01", name: "Conta teste" }],
  journals: [{ account: "4.01", debitCents: cents("100"), creditCents: cents("20"), branch: "", dimensions: ["", "", "", "", ""], referenceDate: "2026-09-12", transId: "12", document: "JE 12", lineId: "0" }],
  resources: [{ resource: "R1", description: "Recurso", type: "rtLabor", unit: "h", components: [{ component: 1, unitCostCents: cents("30") }, { component: 2, unitCostCents: cents("10") }], evidence: "current master; historical validity not established" }],
  movements: [{ resource: "R1", order: "76", orderEntry: "203", producedItem: "P1", itemDescription: "Produto teste", plannedQuantity: "4", completedQuantity: "2", quantityMicros: parseDecimal("2", 6), unit: "h", lineTotalCents: cents("80"), direction: "ISSUE", document: "22", docEntry: "5", lineId: "1", date: "2026-09-20", sourceAccount: "4.01" }],
  orders: [{ entry: "203", number: "76", item: "P1", itemDescription: "Produto teste", plannedQuantity: "4", completedQuantity: "2", unit: "un" }],
  completeness: [{ source: "JournalEntries", received: 1, expected: 1, control: "count" }],
  capturedAt: "2026-09-30T00:00:00.000Z"
};
const mapping: AbsorptionMapping = {
  accounts: [{ account: "4.01", category: "GGF" }],
  resources: [{ resource: "R1", component: 1, category: "MOD" }, { resource: "R1", component: 2, category: "GGF" }],
  technicalHomologation: true
};

describe("GGF V2 absorption reconciliation", () => {
  it("calculates real ledger less explicitly mapped standard absorption by category", () => {
    const report = reconcileAbsorption(source, mapping);
    expect(report.reconciliation.map((row) => [row.category, row.realCents, row.absorbedCents, row.differenceCents, row.status])).toEqual([
      ["MOD", 0n, cents("60"), cents("-60"), "OVERABSORPTION"],
      ["GGF", cents("80"), cents("20"), cents("60"), "SUBABSORPTION"]
    ]);
    expect(report.resources.map((row) => row.amountCents)).toEqual([cents("60"), cents("20")]);
    expect(report.accounts[0]?.entries[0]).toMatchObject({ transId: "12", lineId: "0", debitCents: cents("100"), creditCents: cents("20") });
  });

  it("aggregates multiple explicitly mapped ledger accounts by MOD and GGF", () => {
    const report = reconcileAbsorption({
      ...source,
      accounts: [...source.accounts, { code: "4.02", name: "Conta MOD" }],
      journals: [...source.journals, { ...source.journals[0]!, account: "4.02", debitCents: cents("25"), creditCents: 0n }]
    }, { ...mapping, accounts: [...mapping.accounts, { account: "4.02", category: "MOD" }] });
    expect(report.reconciliation.find((row) => row.category === "GGF")?.realCents).toBe(cents("80"));
    expect(report.reconciliation.find((row) => row.category === "MOD")?.realCents).toBe(cents("25"));
  });

  it("preserves zero and negative differences and adapts differences without changing allocation", () => {
    const zero = reconcileAbsorption(source, { ...mapping, resources: [{ resource: "R1", component: 2, category: "GGF" }] });
    expect(zero.reconciliation.find((row) => row.category === "MOD")?.status).toBe("CONCILIATED");
    expect(absorptionDifferencesAsBalances(zero)[1]?.amount).toBe("60.00");
    const negative = reconcileAbsorption({ ...source, journals: [{ ...source.journals[0]!, debitCents: 0n, creditCents: cents("5") }] }, mapping);
    expect(negative.reconciliation.find((row) => row.category === "GGF")?.differenceCents).toBe(cents("-25"));
    expect(negative.reconciliation.find((row) => row.category === "GGF")?.status).toBe("OVERABSORPTION");
  });

  it("rounds each resource component to cents using signed half-away-from-zero", () => {
    const fractional = {
      ...source,
      resources: [{ ...source.resources[0]!, components: [{ component: 1, unitCostCents: 1n }] }],
      movements: [{ ...source.movements[0]!, quantityMicros: 500_000n }]
    };
    const report = reconcileAbsorption(fractional, {
      accounts: [], resources: [{ resource: "R1", component: 1, category: "MOD" }], technicalHomologation: true
    });
    expect(report.resources[0]?.amountCents).toBe(1n);
    const negative = reconcileAbsorption({ ...fractional, movements: [{ ...fractional.movements[0]!, direction: "RETURN" }] }, {
      accounts: [], resources: [{ resource: "R1", component: 1, category: "MOD" }], technicalHomologation: true
    });
    expect(negative.resources[0]?.amountCents).toBe(-1n);
  });

  it("blocks unknown resources and units instead of assuming a basis", () => {
    const unknown = reconcileAbsorption({ ...source, movements: [{ ...source.movements[0]!, resource: "R2" }] }, mapping);
    expect(unknown.resources).toHaveLength(0);
    expect(unknown.blockers.some((text) => text.includes("sem componente explicitamente"))).toBe(true);
    const noUnit = reconcileAbsorption({ ...source, movements: [{ ...source.movements[0]!, unit: null }] }, mapping);
    expect(noUnit.resources).toHaveLength(0);
    expect(noUnit.blockers.some((text) => text.includes("Unidade ausente"))).toBe(true);
    const missingComponent = reconcileAbsorption(source, {
      ...mapping, resources: [{ resource: "R1", component: 1, category: "MOD" }]
    });
    expect(missingComponent.blockers.some((text) => text.includes("Cost2 de R1 sem classificação explícita"))).toBe(true);
  });

  it("marks technical classification and current rates as blockers, and rejects duplicate config", () => {
    const report = reconcileAbsorption(source, { ...mapping, accounts: [...mapping.accounts, mapping.accounts[0]!] });
    expect(report.blockers.some((text) => text.includes("mais de uma vez"))).toBe(true);
    expect(report.blockers.some((text) => text.includes("Tarifa de R1"))).toBe(true);
    expect(reconcileAbsorption(source, { ...mapping, technicalHomologation: false }).blockers).toContain("Classificações funcionais não homologadas; leitura técnica apenas.");
  });
});
