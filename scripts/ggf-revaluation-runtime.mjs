import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { openReadSession } from "./ggf-sap-session.mjs";
import { readTechnicalFifoPreview } from "./ggf-fifo-preview-read.mjs";

await mkdir(".local/ggf", { recursive: true, mode: 0o700 });
const output = ".local/ggf/revaluation-runtime.mjs";
await build({ stdin: { contents: `export { readRevaluationInput } from "./webapp/modules/ggf/repository/SapRevaluationSource.ts";
export { previewRevaluation } from "./webapp/modules/ggf/service/RevaluationPreview.ts";
export { simulateMaterialRevaluation, pendingPayloadEvidence } from "./webapp/modules/ggf/service/MaterialRevaluationPayload.ts";
export { exportRevaluationCsv } from "./webapp/modules/ggf/service/revaluationExport.ts";
export { previewFifoProduction } from "./webapp/modules/ggf/service/FifoProductionTrace.ts";`, resolveDir: process.cwd() },
  outfile: output, platform: "node", format: "esm", bundle: true });
const { readRevaluationInput, previewRevaluation, exportRevaluationCsv, simulateMaterialRevaluation,
  pendingPayloadEvidence, previewFifoProduction } = await import(pathToFileURL(resolve(output)).href);
export { exportRevaluationCsv };

export async function captureRevaluation(allocationFile) {
  if (!allocationFile) throw new Error("An explicit approved SAP allocation JSON is required");
  const contents = await readFile(allocationFile, "utf8");
  const report = JSON.parse(contents);
  if (report.company !== "SBODEMOBR2" || report.postingBlocked !== true || report.result?.snapshot?.origin !== "sap")
    throw new Error("Only a reconciled SBODEMOBR2 read-only allocation is accepted");
  const session = await openReadSession();
  const reads = [];
  try {
    const client = { async get(path) {
      const response = await session.get(path);
      if (!response.ok) throw new Error(`SAP preview GET rejected: HTTP ${response.status}`);
      // AdminInfo also contains company details unrelated to valuation. Do not persist those.
      const data = path === "CompanyService_GetAdminInfo"
        ? Object.fromEntries(["ContinuousStockManagement", "PriceSystem", "LocalCurrency"].map(k => [k, response.data[k]]))
        : response.data;
      reads.push({ method: "GET", path, time: new Date().toISOString(), data });
      return data;
    }};
    const input = await readRevaluationInput(client, report.result, report.functionalGgfApproved !== true);
    const approvedPreview = previewRevaluation(input);
    const documentSimulation = simulateMaterialRevaluation(approvedPreview, pendingPayloadEvidence(approvedPreview));
    let fifoTechnicalTrace=null,fifoTechnicalError=null;
    try { fifoTechnicalTrace=await readTechnicalFifoPreview(session,previewFifoProduction); }
    catch { fifoTechnicalError="Rastreabilidade FIFO técnica indisponível nesta leitura."; }
    return { connection: session.info, allocationFile, allocationSha256: createHash("sha256").update(contents).digest("hex"),
      input, preview: {...approvedPreview, payload:documentSimulation.payload,
        payloadReady:documentSimulation.status==="APTO", documentSimulation,
        fifoTechnicalTrace,fifoTechnicalError}, reads };
  } finally { await session.close(); }
}
