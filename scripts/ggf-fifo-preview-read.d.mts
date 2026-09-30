import type { previewFifoProduction } from "../webapp/modules/ggf/service/FifoProductionTrace";

export function readTechnicalFifoPreview(
  session: {
    get(path: string): Promise<{ ok: boolean; status: number; data?: unknown }>;
    readFifoLayers(item: string, warehouse: string): Promise<{ ok: boolean; status: number; data?: unknown }>;
  },
  preview: typeof previewFifoProduction
): Promise<{ origin: "sap"; technicalOnly: true; status: string; payload: null;
  example: { stockMinor: string; consumedMinor: string; consumedStatus: string } }>;
