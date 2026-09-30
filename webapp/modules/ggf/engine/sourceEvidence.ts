import { GgfError } from "./errors";
import type { BasisEvidence, Configuration, SourceDataset, SourceSnapshot } from "./types";

const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const reject = (context: string): never => {
  throw new GgfError("sourceEvidence", [context]);
};

/** Checks declared evidence for consistency. Actual source verification belongs to the adapter. */
export function validateSourceEvidence(snapshot: SourceSnapshot, config: Configuration): void {
  const evidence = snapshot.evidence;
  if (
    !evidence ||
    !/^(?:[A-Z]{3}|SAP_LOCAL)$/.test(evidence.currency) ||
    !Array.isArray(evidence.reads)
  )
    reject("snapshot");
  const ids = new Set<string>();
  for (const read of evidence.reads) {
    if (
      !read ||
      !text(read.id) ||
      ids.has(read.id) ||
      !text(read.sourceRef) ||
      !["balances", "production", "currentCosts"].includes(read.dataset) ||
      !text(read.reconciliationRef) ||
      !read.filter ||
      !count(read.pagesRead) ||
      read.pagesRead < 1 ||
      !count(read.receivedRows) ||
      !count(read.expectedRows) ||
      read.receivedRows !== read.expectedRows ||
      read.exhausted !== true ||
      ["start", "end", "branch", "costCenter"].some(
        (key) =>
          read.filter[key as keyof typeof read.filter] !==
          snapshot.filter[key as keyof typeof snapshot.filter]
      )
    ) {
      reject(read?.id ?? "read");
    }
    ids.add(read.id);
  }
  const datasets: SourceDataset[] = ["balances", "production"];
  if (snapshot.orders.some((o) => o.currentCost !== null)) datasets.push("currentCosts");
  for (const dataset of datasets) {
    if (!evidence.reads.some((read) => read.dataset === dataset)) reject(dataset);
  }
  const referencedRows = new Map(evidence.reads.map((read) => [read.id, new Set<string>()]));
  const support = (basis: BasisEvidence) => {
    for (const ref of basis.supportingReads ?? []) {
      if (!referencedRows.has(ref.readId) || !ref.sourceRefs.length || !ref.sourceRefs.every(text))
        reject("supportingReads");
      ref.sourceRefs.forEach((id) => referencedRows.get(ref.readId)!.add(id));
    }
  };
  for (const balance of snapshot.balances) {
    if (
      balance.currency !== evidence.currency ||
      !evidence.reads.some((read) => read.id === balance.readId && read.dataset === "balances") ||
      !Array.isArray(balance.sourceRefs) ||
      !balance.sourceRefs.every(text)
    )
      reject(balance.account);
    balance.sourceRefs.forEach((ref) => referencedRows.get(balance.readId)!.add(ref));
  }
  const comparable = new Map<string, BasisEvidence>();
  const criteria = new Set(config.accounts.filter((a) => a.active).map((a) => a.criterion));
  const usesGroupHours = config.groupShares.some(
    (g) =>
      (g.basis ?? "HOURS") === "HOURS" &&
      Number(g.percent) > 0 &&
      config.accounts.some(
        (a) => a.active && a.criterion === "RESOURCE_GROUP" && a.account === g.account
      )
  );
  for (const order of snapshot.orders) {
    for (const key of ["quantity", "hours", "directCost", "currentCost"] as const) {
      const basis = order.basisEvidence?.[key];
      const dataset: SourceDataset = key === "currentCost" ? "currentCosts" : "production";
      const used =
        (key === "quantity" && criteria.has("QUANTITY")) ||
        (key === "directCost" && criteria.has("DIRECT_COST")) ||
        (key === "hours" && (criteria.has("HOURS") || usesGroupHours));
      if (order[key] === null) {
        if (basis !== null || !text(order.unavailable?.[key]))
          reject(`${order.id} / ${key} / unavailable`);
        if (used)
          throw new GgfError("basisUnavailable", [
            `${order.number} / ${key}: ${order.unavailable![key]}`
          ]);
        continue;
      }
      if (!basis) throw new GgfError("sourceEvidence", [`${order.id} / ${key}`]);
      if (
        !basis ||
        !text(basis.unit) ||
        !text(basis.comparisonKey) ||
        !text(basis.normalizationRef) ||
        !Array.isArray(basis.sourceRefs) ||
        !basis.sourceRefs.length ||
        !basis.sourceRefs.every(text) ||
        !evidence.reads.some((read) => read.id === basis.readId && read.dataset === dataset)
      ) {
        reject(`${order.id} / ${key}`);
      }
      if (
        (key === "hours" && basis.unit !== "h") ||
        ((key === "directCost" || key === "currentCost") && basis.unit !== evidence.currency)
      ) {
        reject(`${order.id} / ${key} / unit`);
      }
      const previous = used || key === "currentCost" ? comparable.get(key) : undefined;
      if (
        previous &&
        (previous.unit !== basis.unit || previous.comparisonKey !== basis.comparisonKey)
      ) {
        reject(`${order.id} / ${key} / comparisonKey`);
      }
      comparable.set(key, basis);
      basis.sourceRefs.forEach((ref) => referencedRows.get(basis.readId)!.add(ref));
      support(basis);
    }
    for (const [group, measures] of Object.entries(order.resourceBases ?? {})) {
      for (const [kind, measure] of Object.entries(measures)) {
        const basis = measure.evidence;
        if (
          !basis ||
          !text(basis.unit) ||
          !text(basis.comparisonKey) ||
          !text(basis.normalizationRef) ||
          !basis.sourceRefs?.length ||
          !basis.sourceRefs.every(text) ||
          !measure.resourceRefs?.length ||
          !measure.resourceRefs.every(text) ||
          !evidence.reads.some((r) => r.id === basis.readId && r.dataset === "production") ||
          (kind === "RESOURCE_VALUE" && basis.unit !== evidence.currency) ||
          (kind === "HOURS" && basis.unit !== "h")
        )
          reject(`${order.id} / ${group} / ${kind}`);
        const used = config.groupShares.some(
          (g) =>
            g.group === group &&
            Number(g.percent) > 0 &&
            (g.basis ?? "HOURS") === kind &&
            config.accounts.some((a) => a.active && a.account === g.account)
        );
        const key = `${group}/${kind}`;
        const previous = used ? comparable.get(key) : undefined;
        if (
          previous &&
          (previous.unit !== basis.unit || previous.comparisonKey !== basis.comparisonKey)
        )
          reject(`${order.id} / ${key} / comparisonKey`);
        if (used) comparable.set(key, basis);
        basis.sourceRefs.forEach((ref) => referencedRows.get(basis.readId)!.add(ref));
        support(basis);
      }
    }
  }
  for (const read of evidence.reads) {
    if (read.excludedSourceRefs) {
      if (
        !text(read.exclusionRef) ||
        !read.excludedSourceRefs.every(text) ||
        new Set(read.excludedSourceRefs).size !== read.excludedSourceRefs.length ||
        read.excludedSourceRefs.some((ref) => referencedRows.get(read.id)!.has(ref))
      )
        reject(`${read.id} / exclusions`);
      read.excludedSourceRefs.forEach((ref) => referencedRows.get(read.id)!.add(ref));
    }
    if (referencedRows.get(read.id)!.size !== read.receivedRows) reject(`${read.id} / sourceRefs`);
  }
}
