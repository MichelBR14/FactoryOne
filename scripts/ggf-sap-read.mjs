import { writeFile, rm } from "node:fs/promises";
import { readSap } from "./ggf-sap-runtime.mjs";

const [start, end] = process.argv.slice(2);
if (!start || !end) throw new Error("Usage: npm run ggf:sap:read -- YYYY-MM-DD YYYY-MM-DD");
try {
  await rm(".local/ggf/read-report.json", { force: true });
  const report = await readSap({ start, end, branch: "", costCenter: "" });
  await writeFile(".local/ggf/read-report.json", JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify(
      {
        company: report.company,
        filter: report.filter,
        reads: report.reads,
        journal: report.journal,
        receipts: report.receipts,
        differences: report.differences,
        blockers: report.blockers
      },
      null,
      2
    )
  );
} catch {
  console.error(
    "SAP read failed; no partial result published. Check local configuration and source contracts."
  );
  process.exitCode = 1;
}
