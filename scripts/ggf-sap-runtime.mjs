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
