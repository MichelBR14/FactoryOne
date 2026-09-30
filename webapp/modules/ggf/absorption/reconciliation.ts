import { formatDecimal } from "../../../core/util/money";
import type { AccountBalance } from "../engine/types";
import type {
  AbsorptionCategory,
  AbsorptionMapping,
  AbsorptionReport,
  AbsorptionSourceData
} from "./types";

const sum = (values: bigint[]) => values.reduce((total, value) => total + value, 0n);
function roundDiv(numerator: bigint, denominator: bigint): bigint {
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator * sign;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  return sign * (quotient + (remainder * 2n >= denominator ? 1n : 0n));
}

function verifyMapping(mapping: AbsorptionMapping): string[] {
  const blockers: string[] = [];
  const accountKeys = mapping.accounts.map((item) => item.account);
  const resourceKeys = mapping.resources.map((item) => `${item.resource}/${item.component}`);
  if (new Set(accountKeys).size !== accountKeys.length) blockers.push("Conta mapeada mais de uma vez.");
  if (new Set(resourceKeys).size !== resourceKeys.length) blockers.push("Componente de recurso mapeado mais de uma vez.");
  if (mapping.resources.some((item) => !Number.isInteger(item.component) || item.component < 1 || item.component > 10))
    blockers.push("Componente de custo de recurso inválido.");
  return blockers;
}

/** Accounting difference is intentionally separate from the validated allocation engine. */
export function reconcileAbsorption(
  source: AbsorptionSourceData,
  mapping: AbsorptionMapping
): AbsorptionReport {
  const blockers = verifyMapping(mapping);
  if (!mapping.technicalHomologation)
    blockers.push("Classificações funcionais não homologadas; leitura técnica apenas.");
  const accountNames = new Map(source.accounts.map((item) => [item.code, item.name]));
  const accountMap = new Map(mapping.accounts.map((item) => [item.account, item.category]));
  const accounts = [...accountMap.entries()].map(([account, category]) => {
    const entries = source.journals.filter((line) => line.account === account);
    const debitCents = sum(entries.map((line) => line.debitCents));
    const creditCents = sum(entries.map((line) => line.creditCents));
    return {
      account,
      accountName: accountNames.get(account) ?? "Descrição não localizada no plano de contas",
      category,
      debitCents,
      creditCents,
      realCents: debitCents - creditCents,
      entries: entries.map((line) => ({
        transId: line.transId,
        document: line.document,
        date: line.referenceDate,
        lineId: line.lineId,
        debitCents: line.debitCents,
        creditCents: line.creditCents,
        branch: line.branch,
        dimensions: line.dimensions
      }))
    };
  });
  for (const mappingItem of mapping.accounts) {
    if (!accountNames.has(mappingItem.account)) blockers.push(`Conta ${mappingItem.account} não encontrada no plano de contas.`);
    if (!source.journals.some((line) => line.account === mappingItem.account)) blockers.push(`Sem movimento contábil para a conta ${mappingItem.account} no período/filtro.`);
  }

  const resourceCatalog = new Map(source.resources.map((item) => [item.resource, item]));
  const resourceMappings = new Map(mapping.resources.map((item) => [`${item.resource}/${item.component}`, item.category]));
  const resources: AbsorptionReport["resources"] = [];
  for (const movement of source.movements) {
    const selected = mapping.resources.filter((item) => item.resource === movement.resource);
    if (!selected.length)
      blockers.push(`Recurso ${movement.resource} sem componente explicitamente classificado; absorção padrão incompleta.`);
    const catalog = resourceCatalog.get(movement.resource);
    if (!catalog) {
      blockers.push(`Cadastro do recurso ${movement.resource} não localizado.`);
      continue;
    }
    if (!catalog.unit || !movement.unit || catalog.unit !== movement.unit) {
      blockers.push(`Unidade ausente ou divergente no recurso ${movement.resource}; custos não somados.`);
    }
    if (!selected.length) {
      continue;
    }
    for (const component of catalog.components) {
      if (component.unitCostCents !== 0n && !selected.some((item) => item.component === component.component))
        blockers.push(`Cost${component.component} de ${movement.resource} sem classificação explícita; absorção padrão incompleta.`);
    }
    if (!catalog.unit || !movement.unit || catalog.unit !== movement.unit) {
      continue;
    }
    for (const selectedMapping of selected) {
      const component = catalog.components.find((item) => item.component === selectedMapping.component);
      if (!component) {
        blockers.push(`Componente Cost${selectedMapping.component} indisponível para ${movement.resource}.`);
        continue;
      }
      const signedQuantity = movement.direction === "RETURN" ? -movement.quantityMicros : movement.quantityMicros;
      const amountCents = roundDiv(signedQuantity * component.unitCostCents, 1_000_000n);
      resources.push({
        resource: movement.resource,
        description: catalog.description,
        producedItem: movement.producedItem,
        itemDescription: movement.itemDescription,
        plannedQuantity: movement.plannedQuantity,
        completedQuantity: movement.completedQuantity,
        category: selectedMapping.category,
        component: selectedMapping.component,
        unit: movement.unit,
        quantityMicros: signedQuantity,
        unitCostCents: component.unitCostCents,
        amountCents,
        movementCostCents: movement.lineTotalCents,
        order: movement.order,
        document: movement.document,
        docEntry: movement.docEntry,
        lineId: movement.lineId,
        date: movement.date,
        sourceAccount: movement.sourceAccount
      });
      if (!resourceMappings.has(`${movement.resource}/${selectedMapping.component}`))
        blockers.push(`Mapeamento inconsistente para ${movement.resource}/Cost${selectedMapping.component}.`);
    }
    if (catalog.evidence.includes("current master"))
      blockers.push(`Tarifa de ${movement.resource} vem do cadastro atual, sem histórico comprovado para o período.`);
  }

  const categories: AbsorptionCategory[] = ["MOD", "GGF"];
  const reconciliation = categories.map((category) => {
    const realCents = sum(accounts.filter((item) => item.category === category).map((item) => item.realCents));
    const absorbedCents = sum(resources.filter((item) => item.category === category).map((item) => item.amountCents));
    const differenceCents = realCents - absorbedCents;
    return {
      category,
      realCents,
      absorbedCents,
      differenceCents,
      status: differenceCents === 0n ? "CONCILIATED" as const : differenceCents > 0n ? "SUBABSORPTION" as const : "OVERABSORPTION" as const
    };
  });
  const statuses: AbsorptionReport["statuses"] = [];
  if (!mapping.accounts.length || !mapping.resources.length) statuses.push("Sem configuração");
  if (accounts.every((account) => account.entries.length === 0)) statuses.push("Sem movimento");
  if (blockers.some((text) => text.includes("Unidade ausente ou divergente"))) statuses.push("Unidade incompatível");
  if (blockers.some((text) => text.includes("base") || text.includes("componente explicitamente") || text.includes("Tarifa"))) statuses.push("Base indisponível");
  if (mapping.technicalHomologation) statuses.push("Homologação técnica");
  return {
    company: source.company,
    filter: structuredClone(source.filter),
    technicalHomologation: mapping.technicalHomologation,
    accounts,
    resources,
    resourceCatalog: structuredClone(source.resources),
    reconciliation,
    statuses,
    blockers: [...new Set(blockers)],
    completeness: structuredClone(source.completeness),
    capturedAt: source.capturedAt
  };
}

/** Adapter only: it does not change the existing rateio engine or imply a posting rule. */
export function absorptionDifferencesAsBalances(report: AbsorptionReport): AccountBalance[] {
  return report.reconciliation.map((item) => ({
    account: `ABSORPTION-DIFFERENCE-${item.category}`,
    amount: formatDecimal(item.differenceCents, 2),
    currency: "SAP_LOCAL",
    readId: "GGF-V2-ABSORPTION-DIFFERENCE",
    sourceRefs: report.accounts
      .filter((account) => account.category === item.category)
      .flatMap((account) => account.entries.map((entry) => `${entry.transId}/${entry.lineId}`))
      .concat(report.resources.filter((line) => line.category === item.category).map((line) => `${line.docEntry}/${line.lineId}`))
  }));
}
