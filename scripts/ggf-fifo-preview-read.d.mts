import type { previewFifoProduction } from "../webapp/modules/ggf/service/FifoProductionTrace";
import type { splitStockAndConsumed } from "../webapp/modules/ggf/service/StockConsumptionSplit";

export function readTechnicalFifoPreview(
  session: {
    get(path: string): Promise<{ ok: boolean; status: number; data?: unknown }>;
    readFifoLayers(item: string, warehouse: string): Promise<{ ok: boolean; status: number; data?: unknown }>;
  },
  preview: typeof previewFifoProduction,
  split: typeof splitStockAndConsumed
): Promise<{ origin: "sap"; technicalOnly: true; status: string; payload: null;
  example: { stockMinor: string; consumedMinor: string; consumedStatus: string };
  calculation: ReturnType<typeof splitStockAndConsumed> }>;
