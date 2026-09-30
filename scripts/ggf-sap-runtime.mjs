import { build } from "esbuild";
import { appendFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { openReadSession } from "./ggf-sap-session.mjs";

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

async function readStockConsumptionReview(session, distribution) {
  const reviews = [];
  for (const row of distribution.orders) {
    if (!/^[A-Za-z0-9._-]{1,50}$/.test(row.item)) {
      reviews.push({ orderNumber: row.orderNumber, item: row.item, status: "BLOCKED_AMBIGUOUS_TRACE",
        reason: "Código do item não pode ser consultado com segurança." });
      continue;
    }
    const response = await session.get(
      `Items('${row.item}')?$select=ItemCode,CostAccountingMethod,InventoryUOM,QuantityOnStock,ItemWarehouseInfoCollection,ManageBatchNumbers,ManageSerialNumbers`,
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
    const negative = Number(item.QuantityOnStock) < 0 || warehouses.some((warehouse) => Number(warehouse.quantity) < 0);
    reviews.push({
      orderNumber: row.orderNumber, item: row.item, producedQuantity: row.producedQuantity,
      modAdjustmentCents: row.modAdjustmentCents.toString(), ggfAdjustmentCents: row.ggfAdjustmentCents.toString(),
      valuationMethod: item.CostAccountingMethod ?? null,
      unit: item.InventoryUOM ?? null, quantityOnStock: item.QuantityOnStock ?? null,
      manageBatches: item.ManageBatchNumbers ?? null, manageSerials: item.ManageSerialNumbers ?? null,
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
  return { orders: reviews, fifoScenario, outflowCoverage: "INCOMPLETE_FOR_GENERAL_OPS" };
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
