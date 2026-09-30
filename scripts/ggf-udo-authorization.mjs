import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { openHomologationSession } from "./ggf-homologation-session.mjs";

const CODES = ["FBO_GGF_CLOSE", "FBO_GGF_CLINE", "FBO_GGF_CLAIM"];
const NAMES = ["FactoryOne GGF closing", "FactoryOne GGF closing line", "FactoryOne GGF posting claim"];
const FILE = ".local/ggf/ggf-udo-authorization.json";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, stable(entry)]));
  return value;
}
const fingerprint = value => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const withoutAuthorization = ({ ApplyAuthorization, ...other }) => other;
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function readUdo(session, code, index) {
  const response = await session.get(`UserObjectsMD('${code}')`);
  assert(response.ok && response.data && typeof response.data === "object",
    `SAP UDO ${code} read failed: HTTP ${response.status}`);
  const row = response.data;
  assert(row.Code === code && row.Name === NAMES[index] && row.TableName === code &&
    row.ObjectType === "boud_MasterData" && row.CanDelete === "tNO" &&
    ["tNO", "tYES"].includes(row.ApplyAuthorization), `Unexpected UDO metadata for ${code}`);
  return row;
}

async function capture(session) {
  const rows = [];
  for (let i = 0; i < CODES.length; i++) rows.push(await readUdo(session, CODES[i], i));
  return rows;
}

async function save(evidence) {
  await mkdir(".local/ggf", { recursive: true, mode: 0o700 });
  await writeFile(FILE, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
}

async function run(mode) {
  assert(["plan", "apply", "verify"].includes(mode), "Choose plan, apply or verify");
  const evidence = mode === "plan" ? {
    companyDB: "SBODEMOBR2", mode: "UDO authorization metadata only", plannedAt: new Date().toISOString(),
    before: [], attempts: [], after: []
  } : JSON.parse(await readFile(FILE, "utf8"));
  assert(evidence.companyDB === "SBODEMOBR2" &&
    (mode === "plan" || evidence.before?.length === CODES.length),
    mode === "plan" ? "Internal evidence error" : "Run plan first; no baseline evidence found");
  const session = await openHomologationSession();
  try {
    if (mode === "plan") {
      evidence.before = await capture(session);
      assert(evidence.before.every(row => row.ApplyAuthorization === "tNO"),
        "At least one UDO is not tNO; inspect before applying");
      await save(evidence);
      return { mode, codes: evidence.before.map(row => ({ Code: row.Code, Name: row.Name,
        ApplyAuthorization: row.ApplyAuthorization, CanDelete: row.CanDelete,
        otherPropertiesHash: fingerprint(withoutAuthorization(row)) })), evidenceFile: FILE };
    }
    if (mode === "apply") {
      assert(evidence.attempts.length === 0, "Apply already attempted; verify instead of replaying");
      const current = await capture(session);
      for (let i = 0; i < CODES.length; i++)
        assert(fingerprint(current[i]) === fingerprint(evidence.before[i]),
          `UDO ${CODES[i]} changed after plan; abort before PATCH`);
      evidence.applyStartedAt = new Date().toISOString();
      await save(evidence);
      for (let i = 0; i < CODES.length; i++) {
        const code = CODES[i];
        const attempt = { Code: code, requestedAt: new Date().toISOString(),
          payload: { ApplyAuthorization: "tYES" } };
        evidence.attempts.push(attempt);
        await save(evidence);
        const result = await session.patchGgfUdoAuthorization(code, attempt.payload);
        attempt.httpStatus = result.status;
        attempt.sapCode = result.errorCode ?? null;
        attempt.sapMessage = result.errorMessage ?? null;
        attempt.completedAt = new Date().toISOString();
        await save(evidence);
        assert(result.ok, `SAP rejected ${code} authorization PATCH: HTTP ${result.status} ${result.errorCode ?? ""}`);
        const updated = await readUdo(session, code, i);
        assert(updated.ApplyAuthorization === "tYES", `${code} remained tNO after PATCH`);
        assert(fingerprint(withoutAuthorization(updated)) ===
          fingerprint(withoutAuthorization(evidence.before[i])),
          `${code} changed other metadata properties; stop and investigate`);
        evidence.after.push(updated);
        await save(evidence);
      }
    }
  } finally { await session.close(); }

  const fresh = await openHomologationSession();
  try {
    const rows = await capture(fresh);
    for (let i = 0; i < CODES.length; i++) {
      assert(rows[i].ApplyAuthorization === "tYES", `${CODES[i]} authorization not durable in new session`);
      assert(fingerprint(withoutAuthorization(rows[i])) ===
        fingerprint(withoutAuthorization(evidence.before[i])),
        `${CODES[i]} other properties differ from baseline`);
    }
    evidence.verifiedAt = new Date().toISOString();
    evidence.verifiedInNewSession = true;
    evidence.after = rows;
    await save(evidence);
    return { mode, verifiedInNewSession: true, results: rows.map((row, i) => ({
      Code: row.Code, Name: row.Name, ApplyAuthorization: row.ApplyAuthorization,
      otherPropertiesUnchanged: fingerprint(withoutAuthorization(row)) ===
        fingerprint(withoutAuthorization(evidence.before[i]))
    })), attempts: evidence.attempts.map(a => ({ Code: a.Code, httpStatus: a.httpStatus,
      sapCode: a.sapCode })), evidenceFile: FILE };
  } finally { await fresh.close(); }
}

try { console.log(JSON.stringify(await run(process.argv[2]), null, 2)); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
