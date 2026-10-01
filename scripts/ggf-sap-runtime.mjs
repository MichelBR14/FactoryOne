import { build } from "esbuild";
import { appendFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { openReadSession } from "./ggf-sap-session.mjs";
import { openHomologationSession } from "./ggf-homologation-session.mjs";

await mkdir(".local/ggf", { recursive: true, mode: 0o700 });
const output = ".local/ggf/read-runtime.mjs";
await build({
  entryPoints: ["webapp/modules/ggf/repository/SapB1ReadMapping.ts"],
  outfile: output,
  platform: "node",
  format: "esm",
  bundle: true
});
const { inspectSapB1 } = await import(pathToFileURL(resolve(output)).href);
const absorptionOutput = ".local/ggf/absorption-runtime.mjs";
await build({ stdin: { contents: `
export { readGgfV2Absorption } from "./webapp/modules/ggf/absorption/SapGgfAbsorptionSource.ts";
export { reconcileAbsorption } from "./webapp/modules/ggf/absorption/reconciliation.ts";
export { calculateAbsorptionDistribution } from "./webapp/modules/ggf/absorption/distribution.ts";
export { previewFifoProduction } from "./webapp/modules/ggf/service/FifoProductionTrace.ts";
export { splitStockAndConsumed } from "./webapp/modules/ggf/service/StockConsumptionSplit.ts";
`, resolveDir: process.cwd() }, outfile: absorptionOutput, platform: "node", format: "esm", bundle: true });
const { readGgfV2Absorption, reconcileAbsorption, calculateAbsorptionDistribution,
  previewFifoProduction, splitStockAndConsumed } = await import(pathToFileURL(resolve(absorptionOutput)).href);
const { readTechnicalFifoPreview } = await import("./ggf-fifo-preview-read.mjs");
const integrityOutput = ".local/ggf/closing-integrity-runtime.mjs";
await build({ stdin: { contents: `
export { SapGgfClosingRepository } from "./webapp/modules/ggf/repository/SapGgfClosingRepository.ts";
export { SapGgfClosingVersionRepository, SapMetadataUnavailableError } from "./webapp/modules/ggf/repository/SapGgfClosingVersionRepository.ts";
export { ServiceLayerError } from "./webapp/core/service/errors.ts";
`, resolveDir: process.cwd() }, outfile: integrityOutput, platform: "node", format: "esm", bundle: true });
const { SapGgfClosingRepository, SapGgfClosingVersionRepository, SapMetadataUnavailableError,
  ServiceLayerError } = await import(pathToFileURL(resolve(integrityOutput)).href);
export { SapMetadataUnavailableError };

const postingPlanOutput = ".local/ggf/posting-plan-runtime.mjs";
await build({ stdin: { contents: `
export { SapGgfPostingPlanRepository, SapPostingPlanMetadataUnavailableError } from "./webapp/modules/ggf/repository/SapGgfPostingPlanRepository.ts";
export { buildAccountingPreview } from "./webapp/modules/ggf/service/AccountingPreview.ts";
export { buildGgfPostingPlanDraft, technicalPostingPlanId } from "./webapp/modules/ggf/service/GgfPostingPlan.ts";
`, resolveDir: process.cwd() }, outfile: postingPlanOutput, platform: "node", format: "esm", bundle: true });
const { SapGgfPostingPlanRepository, SapPostingPlanMetadataUnavailableError,
  buildAccountingPreview, buildGgfPostingPlanDraft, technicalPostingPlanId } =
  await import(pathToFileURL(resolve(postingPlanOutput)).href);

const postingExecutionOutput = ".local/ggf/posting-execution-runtime.mjs";
await build({ stdin: { contents: `
export { SapGgfPostingExecutionRepository, SapGgfExecutionMetadataUnavailableError } from "./webapp/modules/ggf/repository/SapGgfPostingExecutionRepository.ts";
`, resolveDir: process.cwd() }, outfile: postingExecutionOutput, platform: "node", format: "esm", bundle: true });
const { SapGgfPostingExecutionRepository, SapGgfExecutionMetadataUnavailableError } =
  await import(pathToFileURL(resolve(postingExecutionOutput)).href);

function postingPlanClient(session, write = false) {
  const unwrap = (response) => {
    if (!response.ok) throw new ServiceLayerError("SAP posting plan request rejected", response.status,
      response.errorCode, response.errorMessage);
    return response.data;
  };
  return {
    async get(path) { return unwrap(await session.get(path, { Prefer: "odata.maxpagesize=100" })); },
    async post(path, body) {
      if (!write || path !== "FBO_GGF_PPLAN") throw new Error("SAP posting plan writes are disabled");
      return unwrap(await session.postPostingPlan(body));
    },
    async patch() { throw new Error("SAP posting plan is append-only"); }
  };
}

export async function readPersistedPostingPlan(closingId) {
  if (!/^[A-Za-z0-9_-]{1,30}$/.test(closingId)) throw new Error("Invalid posting plan ClosingId");
  const session = await openReadSession();
  try {
    const repository = new SapGgfPostingPlanRepository(postingPlanClient(session));
    const versions = await repository.list(closingId);
    return { company: session.info.company, closingId, versions, latest: versions.at(-1) ?? null,
      integrityVerified: true, source: "SAP" };
  } finally { await session.close(); }
}

export async function readPostingExecution(executionId) {
  if (!/^F1EX[a-f0-9]{40}$/.test(executionId)) throw new Error("Invalid ExecutionId");
  const session = await openReadSession();
  try {
    const client = {
      async get(path) {
        const response = await session.get(path, { Prefer: "odata.maxpagesize=100" });
        if (!response.ok) throw new ServiceLayerError("SAP execution ledger read rejected", response.status,
          response.errorCode, response.errorMessage);
        return response.data;
      },
      async post() { throw new Error("Posting execution read-only client rejects writes"); },
      async patch() { throw new Error("Posting execution read-only client rejects writes"); }
    };
    const execution = await new SapGgfPostingExecutionRepository(client).get(executionId);
    return { company: session.info.company, execution, integrityVerified: execution !== null, source: "SAP" };
  } catch (error) {
    if (error?.code === "SAP_EXECUTION_METADATA_UNAVAILABLE" || error instanceof SapGgfExecutionMetadataUnavailableError)
      throw error;
    throw error;
  } finally { await session.close(); }
}

export async function persistBlockedPostingPlan(draft) {
  if (!draft || draft.status !== "BLOCKED" || draft.postingBlocked !== true ||
      draft.closingId !== "TECH-SBODEMOBR2-202609" || draft.companyDB !== "SBODEMOBR2" ||
      draft.totalMod !== "-300000" || draft.totalGgf !== "-616600" ||
      draft.totalStock !== "0" || draft.totalCpv !== "0" || draft.totalBlocked !== "-916600" ||
      draft.totalDifference !== "0" || draft.documents?.some(document => document.payload !== null))
    throw new Error("Posting plan is outside the authorized blocked technical snapshot");
  const session = await openHomologationSession();
  let saved;
  try {
    const repository = new SapGgfPostingPlanRepository(postingPlanClient(session, true));
    saved = await repository.append(draft);
  } finally { await session.close(); }
  const reread = await readPersistedPostingPlan(saved.closingId);
  const verified = reread.versions.find(plan => plan.version === saved.version);
  if (!verified || verified.postingHash !== saved.postingHash)
    throw new Error("Posting plan was not verified from a new SAP session");
  return reread;
}

export async function readSap(filter) {
  const session = await openReadSession();
  try {
    const client = {
      async get(path) {
        const response = await session.get(path, { Prefer: "odata.maxpagesize=20" });
        if (!response.ok) throw new Error(`SAP read rejected: HTTP ${response.status}`);
        return response.data;
      }
    };
    return { ...(await inspectSapB1(client, filter)), company: session.info.company, connection: session.info };
  } finally {
    await session.close();
  }
}

export async function readV2Absorption({ filter, mapping }) {
  const session = await openReadSession();
  try {
    const client = {
      async get(path) {
        const response = await session.get(path, { Prefer: "odata.maxpagesize=100" });
        if (!response.ok) throw new Error(`SAP read rejected: HTTP ${response.status}`);
        return response.data;
      }
    };
    const source = await readGgfV2Absorption(client, session.info.company, filter, mapping);
    return { source, report: reconcileAbsorption(source, mapping), connection: session.info };
  } finally { await session.close(); }
}

export async function readV2AbsorptionDistribution({ filter, mapping }) {
  const session = await openReadSession();
  try {
    const client = {
      async get(path) {
        const response = await session.get(path, { Prefer: "odata.maxpagesize=100" });
        if (!response.ok) throw new Error(`SAP read rejected: HTTP ${response.status}`);
        return response.data;
      }
    };
    const source = await readGgfV2Absorption(client, session.info.company, filter, mapping);
    const report = reconcileAbsorption(source, mapping);
    const distribution = await calculateAbsorptionDistribution(client, source, report, filter, mapping);
    const stockConsumption = await readStockConsumptionReview(session, distribution);
    return { source, report, distribution, stockConsumption, connection: session.info };
  } finally { await session.close(); }
}

export function buildTechnicalPostingPlan({ source, report, distribution, stockConsumption }, mapping, accountingConfig) {
  const categoryTotals = Object.fromEntries(report.reconciliation.map(row =>
    [String(row.category), String(row.differenceCents)]));
  const reviewByOrder = new Map((stockConsumption?.orders ?? []).map(row => [String(row.orderNumber), row]));
  const accountingLines = [];
  for (const order of distribution.orders) for (const category of ["MOD", "GGF"]) {
    const amount = String(category === "MOD" ? order.modAdjustmentCents : order.ggfAdjustmentCents);
    if (amount === "0") continue;
    const review = reviewByOrder.get(String(order.orderNumber));
    const basis = order.bases.find(row => row.category === category);
    accountingLines.push({
      closingId: null, version: null, orderNumber: String(order.orderNumber), item: String(order.item), warehouse: null,
      category, accountOriginal: mapping.accounts?.find(row => row.category === category)?.account ?? null,
      criterion: basis ? String(basis.criterion) : null,
      quantity: review?.producedQuantity == null ? null : String(review.producedQuantity),
      unit: review?.unit == null ? null : String(review.unit), amountCents: amount,
      stockCents: review?.[category === "MOD" ? "modStockCents" : "ggfStockCents"] == null
        ? null : String(review[category === "MOD" ? "modStockCents" : "ggfStockCents"]),
      consumedCents: review?.[category === "MOD" ? "modConsumedCents" : "ggfConsumedCents"] == null
        ? null : String(review[category === "MOD" ? "modConsumedCents" : "ggfConsumedCents"]),
      stockTraceStatus: String(review?.status ?? "BLOCKED_AMBIGUOUS_TRACE"),
      valuationMethod: review?.valuationMethod == null ? null : String(review.valuationMethod),
      inventoryAccountFromSap: review?.accountingDetermination,
      consumedOperationKey: null,
      sourceRefs: order.bases.filter(row => row.category === category).flatMap(row => row.sourceRefs ?? [])
    });
  }
  const accounting = buildAccountingPreview({ MOD: categoryTotals.MOD ?? "0", GGF: categoryTotals.GGF ?? "0" },
    accountingLines, accountingConfig);
  const draft = buildGgfPostingPlanDraft(accounting, {
    closingId: technicalPostingPlanId(source.company, source.filter.start), companyDB: source.company,
    periodStart: source.filter.start, periodEnd: source.filter.end, branch: source.filter.branch,
    dimensions: source.filter.dimensions, currency: stockConsumption?.currency ?? null,
    currencySource: stockConsumption?.currencySource ?? null, sourceCapturedAt: source.capturedAt
  });
  return { accounting, draft };
}

async function readStockConsumptionReview(session, distribution) {
  const reviews = [];
  let admin = null;
  try {
    const result = await session.get("CompanyService_GetAdminInfo");
    if (result.ok) admin = result.data;
  } catch { /* Determination remains unresolved if the company policy cannot be read. */ }
  const warehouseRows = new Map();
  const groupRows = new Map();
  const safeRead = async path => {
    try { const result = await session.get(path); return result.ok ? result.data : null; }
    catch { return null; }
  };
  for (const row of distribution.orders) {
    if (!/^[A-Za-z0-9._-]{1,50}$/.test(row.item)) {
      reviews.push({ orderNumber: row.orderNumber, item: row.item, status: "BLOCKED_AMBIGUOUS_TRACE",
        reason: "Código do item não pode ser consultado com segurança." });
      continue;
    }
    const response = await session.get(
      `Items('${row.item}')?$select=ItemCode,CostAccountingMethod,InventoryUOM,QuantityOnStock,ItemWarehouseInfoCollection,ManageBatchNumbers,ManageSerialNumbers,GLMethod,ItemsGroupCode`,
      { Prefer: "odata.maxpagesize=100" });
    if (!response.ok) {
      reviews.push({ orderNumber: row.orderNumber, item: row.item, status: "BLOCKED_AMBIGUOUS_TRACE",
        reason: "Método de avaliação e saldo por depósito não puderam ser lidos." });
      continue;
    }
    const item = response.data;
    const warehouses = (item.ItemWarehouseInfoCollection ?? []).map((warehouse) => ({
      code: warehouse.WarehouseCode,
      quantity: warehouse.InStock,
      committed: warehouse.Committed ?? null,
      available: warehouse.InStock == null || warehouse.Committed == null
        ? null : warehouse.InStock - warehouse.Committed
    }));
    for (const warehouse of warehouses) if (!warehouseRows.has(warehouse.code))
      warehouseRows.set(warehouse.code, await safeRead(`Warehouses('${warehouse.code}')?$select=WarehouseCode,StockAccount,IncreaseGLAccount,DecreaseGLAccount,PriceDifferencesAccount,VarianceAccount`));
    if (item.ItemsGroupCode != null && !groupRows.has(String(item.ItemsGroupCode)))
      groupRows.set(String(item.ItemsGroupCode), await safeRead(`ItemGroups(${item.ItemsGroupCode})?$select=Number,InventoryAccount,IncreaseGLAccount,DecreaseGLAccount,PriceDifferencesAccount,VarianceAccount`));
    const negative = Number(item.QuantityOnStock) < 0 || warehouses.some((warehouse) => Number(warehouse.quantity) < 0);
    const advanced = admin?.EnableAdvancedGLAccountDetermination === "tYES";
    const refs = ["CompanyService_GetAdminInfo:EnableAdvancedGLAccountDetermination", `Items('${row.item}'):GLMethod,ItemsGroupCode`];
    let source = "SAP_DETERMINATION_UNRESOLVED";
    if (item.GLMethod === "glm_WH") {
      source = advanced ? "SAP_ADVANCED_GL_ACCOUNT_DETERMINATION" : "SAP_WAREHOUSE";
      for (const warehouse of warehouses) refs.push(`Warehouses('${warehouse.code}'):StockAccount`);
    } else if (item.GLMethod === "glm_ItemGroup") {
      source = advanced ? "SAP_ADVANCED_GL_ACCOUNT_DETERMINATION" : "SAP_ITEM_GROUP";
      refs.push(`ItemGroups(${item.ItemsGroupCode}):InventoryAccount`);
    }
    reviews.push({
      orderNumber: row.orderNumber, item: row.item, producedQuantity: row.producedQuantity,
      modAdjustmentCents: row.modAdjustmentCents.toString(), ggfAdjustmentCents: row.ggfAdjustmentCents.toString(),
      valuationMethod: item.CostAccountingMethod ?? null,
      unit: item.InventoryUOM ?? null, quantityOnStock: item.QuantityOnStock ?? null,
      manageBatches: item.ManageBatchNumbers ?? null, manageSerials: item.ManageSerialNumbers ?? null,
      glMethod: item.GLMethod ?? null, advancedGlDetermination: admin?.EnableAdvancedGLAccountDetermination ?? null,
      accountingDetermination: { inventoryAccount: null, origin: source, verified: false, refs,
        warehouseCandidates: warehouses.map(warehouse => ({ code: warehouse.code,
          inventoryAccount: warehouseRows.get(warehouse.code)?.StockAccount ?? null,
          increaseAccount: warehouseRows.get(warehouse.code)?.IncreaseGLAccount ?? null,
          decreaseAccount: warehouseRows.get(warehouse.code)?.DecreaseGLAccount ?? null })),
        itemGroup: item.ItemsGroupCode == null ? null : { code: item.ItemsGroupCode,
          inventoryAccount: groupRows.get(String(item.ItemsGroupCode))?.InventoryAccount ?? null,
          increaseAccount: groupRows.get(String(item.ItemsGroupCode))?.IncreaseGLAccount ?? null,
          decreaseAccount: groupRows.get(String(item.ItemsGroupCode))?.DecreaseGLAccount ?? null } },
      warehouses, status: negative ? "BLOCKED_STOCK_NEGATIVE" : "BLOCKED_AMBIGUOUS_TRACE",
      reason: negative
        ? "Saldo negativo do item ou de depósito; não é possível atribuir a quantidade à OP."
        : "Saldo atual é agregado por item/depósito. Saídas, transferências e outros movimentos posteriores não foram reconciliados à camada/OP."
    });
  }
  let fifoScenario;
  try {
    fifoScenario = await readTechnicalFifoPreview(session, previewFifoProduction, splitStockAndConsumed);
  } catch {
    fifoScenario = { origin: "sap", technicalOnly: true, status: "BLOCKED_AMBIGUOUS_TRACE",
      reason: "Cenário FIFO técnico não pôde ser reconciliado nesta leitura; nenhum valor anterior foi reutilizado.", payload: null };
  }
  return { orders: reviews, fifoScenario, outflowCoverage: "INCOMPLETE_FOR_GENERAL_OPS",
    currency: admin?.LocalCurrency ?? null,
    currencySource: admin?.LocalCurrency ? "CompanyService_GetAdminInfo.LocalCurrency" : null };
}

export async function readClosingIntegrity(closingId) {
  if (!/^[A-Za-z0-9_-]{1,30}$/.test(closingId)) throw new Error("Invalid ClosingId");
  const session = await openReadSession();
  try {
    const client = {
      async get(path) {
        const response = await session.get(path, { Prefer: "odata.maxpagesize=100" });
        if (!response.ok) throw new ServiceLayerError("SAP closing read rejected", response.status, response.code);
        return response.data;
      },
      async post() { throw new Error("SAP writes forbidden in local read-only preview"); },
      async patch() { throw new Error("SAP writes forbidden in local read-only preview"); }
    };
    const archive = new SapGgfClosingVersionRepository(client);
    await archive.assertAvailable();
    const repo = new SapGgfClosingRepository(client, { session: "local-preview" });
    const closing = await repo.get(closingId);
    if (closing?.postingBasis?.fifoLineage?.length) {
      const snapshot = await archive.get(closingId, closing.version);
      if (!snapshot || snapshot.postingHash !== closing.postingHash)
        throw new Error("FIFO closing version snapshot not reconciled");
    }
    const report = closing ? await repo.getIntegrity(closingId) : null;
    if (report?.status === "INTEGRITY_VIOLATION") {
      try {
        await appendFile(".local/ggf/closing-integrity-incidents.jsonl",
          JSON.stringify({ ...report, auditRecorded: true, auditLocation: "local-preview" }) + "\n",
          { mode: 0o600 });
        report.auditRecorded = true;
      } catch { report.auditRecorded = false; }
    }
    return report;
  } finally { await session.close(); }
}
