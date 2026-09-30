import { mkdir, writeFile } from "node:fs/promises";
import { captureRevaluation, exportRevaluationCsv } from "./ggf-revaluation-runtime.mjs";

try {
  const capture = await captureRevaluation(process.argv[2]);
  const dir = `.local/ggf/revaluation-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [name, data] of Object.entries({ capture, input: capture.input, preview: capture.preview, "document-simulation":capture.preview.documentSimulation, "future-payload": capture.preview.documentSimulation.payload }))
    await writeFile(`${dir}/${name}.json`, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await writeFile(`${dir}/preview.csv`, exportRevaluationCsv(capture.preview), { mode: 0o600 });
  console.log(JSON.stringify({ directory: dir, company: capture.connection.company, tlsVerified: capture.connection.tlsVerified,
    businessReads: capture.reads.length, businessWrites: 0, payloadReady: capture.preview.payloadReady,
    rows: capture.preview.rows.map(({ order, stock, currentCost, status }) => ({ order, stock, currentCost, status })) }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
