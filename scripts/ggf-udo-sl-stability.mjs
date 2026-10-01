import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createLocalTestHttpsTransport } from "./ggf-local-test-https-transport.mjs";

const COMPANY = "SBODEMOBR2";
const UDO = "FBO_GGF_CVERS";
const KEYS = ["F1HL260929F.00001", "F1HL260929F.00002"];
const STABLE_KEY = "F1HL260929F";
const NAMES = ["FBO_GGF_CLOSE", "FBO_GGF_CLINE", "FBO_GGF_CLAIM", UDO, "FBO_GGF_PPLAN"];
const repeats = Number(process.argv[2] ?? 16);
if (!Number.isSafeInteger(repeats) || repeats < 2 || repeats > 50)
  throw new Error("Choose 2 to 50 independent sessions");

const env = parseEnv(await readFile(".env", "utf8"));
const origin = new URL(env.FBO_SL_URL);
const localCertificateException = process.env.FBO_SL_ALLOW_INVALID_CERTIFICATE === "1";
if (env.FBO_SL_COMPANY_DB !== COMPANY || !["dev", "test"].includes(env.FBO_ENV) ||
    origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash ||
    origin.username || origin.password || (env.FBO_SL_VERIFY_TLS?.toLowerCase() === "false" && !localCertificateException) ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
  throw new Error("HTTPS and authorized test company required; TLS bypass must be scoped locally");
const transport = localCertificateException ? createLocalTestHttpsTransport(origin.origin) : fetch;
const base = `${origin.origin}/b1s/v2/`;
const evidenceDir = ".local/ggf";
await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
const fingerprint = value => createHash("sha256").update(value).digest("hex").slice(0, 12);
const detail = async response => {
  const body = await response.text();
  let error;
  if (!response.ok) {
    try {
      const parsed = JSON.parse(body);
      error = { code: String(parsed.error?.code ?? ""),
        message: String(parsed.error?.message?.value ?? parsed.error?.message ?? "").slice(0, 180) };
    } catch { error = { code: "UNPARSEABLE", message: "Non-JSON SAP error" }; }
  }
  return { status: response.status, error, body: response.ok ? body : undefined };
};
const sessions = [];
for (let index = 0; index < repeats; index++) {
  const sample = { at: new Date().toISOString(), session: `s${String(index + 1).padStart(2, "0")}` };
  let cookie, metadataBody;
  try {
    const login = await transport(base + "Login", { method: "POST", redirect: "error",
      signal: AbortSignal.timeout(20000), headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ CompanyDB: COMPANY, UserName: env.FBO_SL_USER,
        Password: env.FBO_SL_PASSWORD }) });
    sample.loginHttp = login.status;
    if (!login.ok) throw new Error(`Login HTTP ${login.status}`);
    const cookies = login.headers.getSetCookie().map(value => value.split(";")[0]);
    const session = cookies.find(value => value.startsWith("B1SESSION="));
    const route = cookies.find(value => value.startsWith("ROUTEID="));
    if (!session || !route) throw new Error("SAP session or route cookie missing");
    sample.routeFingerprint = fingerprint(route);
    sample.routeNode = /ROUTEID=\.node(\d+)$/.exec(route)?.[1] ?? null;
    cookie = `${session}; ${route}`;
    const get = async (path, accept = "application/json") => detail(await transport(base + path,
      { redirect: "error", signal: AbortSignal.timeout(30000), headers: { Cookie: cookie, Accept: accept } }));
    const metadata = await get("$metadata", "application/xml");
    metadataBody = metadata.body;
    sample.metadata = { path: "$metadata", http: metadata.status, error: metadata.error,
      length: metadata.body?.length ?? null,
      fingerprint: metadata.body ? fingerprint(metadata.body) : null,
      entityTypes: Object.fromEntries(NAMES.map(name => [name,
        metadata.body?.includes(`<EntityType Name="${name}"`) ?? false])) };
    const registered = await get(`UserObjectsMD('${UDO}')`);
    let registration;
    if (registered.body) {
      const row = JSON.parse(registered.body);
      registration = { Code: row.Code, Name: row.Name, TableName: row.TableName,
        ObjectType: row.ObjectType, CanFind: row.CanFind,
        CanCreateDefaultForm: row.CanCreateDefaultForm, ManageSeries: row.ManageSeries,
        ApplyAuthorization: row.ApplyAuthorization, CanDelete: row.CanDelete,
        ChildTables: row.ChildTables ?? null };
    }
    sample.registration = { path: `UserObjectsMD('${UDO}')`, http: registered.status,
      error: registered.error, properties: registration };
    sample.entities = {};
    for (const name of NAMES) {
      const entity = await get(`${name}/$count`);
      sample.entities[name] = { path: `${name}/$count`, http: entity.status,
        error: entity.error, count: entity.body ?? null };
    }
    const stable = await get(`FBO_GGF_CLOSE('${STABLE_KEY}')`);
    const stableRow = stable.body ? JSON.parse(stable.body) : null;
    sample.stable = { path: `FBO_GGF_CLOSE('${STABLE_KEY}')`, http: stable.status,
      error: stable.error, code: stableRow?.Code ?? null,
      version: stableRow?.U_Version ?? null, lineVersion: stableRow?.U_LineVersion ?? null };
    sample.versions = {};
    for (const key of KEYS) {
      const candidate = await get(`${UDO}('${key}')`);
      const row = candidate.body ? JSON.parse(candidate.body) : null;
      sample.versions[key] = { path: `${UDO}('${key}')`, http: candidate.status,
        error: candidate.error, code: row?.Code ?? null,
        version: row?.U_Version ?? null, postingHash: row?.U_PostingHash ?? null };
    }
  } catch (error) {
    sample.transportError = error?.cause?.code ?? error?.name ?? "REQUEST_FAILED";
  } finally {
    if (cookie) {
      try {
        const logout = await transport(base + "Logout", { method: "POST", redirect: "error",
          signal: AbortSignal.timeout(10000), headers: { Cookie: cookie } });
        sample.logoutHttp = logout.status;
      } catch (error) { sample.logoutError = error?.cause?.code ?? error?.name ?? "LOGOUT_FAILED"; }
    }
    sample.ok = sample.loginHttp === 200 && sample.metadata?.http === 200 &&
      NAMES.every(name => sample.metadata.entityTypes[name] && sample.entities?.[name]?.http === 200) &&
      sample.registration?.http === 200 && sample.stable?.http === 200 &&
      KEYS.every(key => sample.versions?.[key]?.http === 200 && sample.versions[key].code === key) &&
      sample.logoutHttp === 204 && !sample.transportError;
    if (!sample.ok) {
      if (metadataBody) {
        const path = `${evidenceDir}/udo-sl-failure-${Date.now()}-${sample.session}-metadata.xml`;
        await writeFile(path, metadataBody, { mode: 0o600 });
        sample.metadataSnapshot = path;
      }
      sample.nodeHealth = [];
      for (const node of [1, 2, 3, 4]) {
        try {
          const response = await transport(`${origin.origin}/ping/node/${node}`,
            { signal: AbortSignal.timeout(5000) });
          sample.nodeHealth.push({ node, http: response.status });
        } catch (error) {
          sample.nodeHealth.push({ node, error: error?.cause?.code ?? error?.name ?? "PING_FAILED" });
        }
      }
    }
    sessions.push(sample);
    console.log(JSON.stringify({ session: sample.session, node: sample.routeNode ?? null,
      route: sample.routeFingerprint ?? null,
      metadata: sample.metadata?.entityTypes?.[UDO] ?? null,
      versions: KEYS.map(key => sample.versions?.[key]?.http ?? null),
      stableHttp: sample.stable?.http ?? null, ok: sample.ok,
      error: sample.transportError ?? KEYS.map(key => sample.versions?.[key]?.error).find(Boolean) ?? null }));
  }
}
const file = `.local/ggf/udo-sl-stability-${new Date().toISOString().replaceAll(":", "-")}.json`;
await writeFile(file, JSON.stringify({ company: COMPANY, testedAt: new Date().toISOString(),
  method: "independent login, sticky ROUTEID, GET only", tlsVerified: !localCertificateException,
  localCertificateException, sessions }, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ evidence: file, sessions: sessions.length,
  ok: sessions.filter(row => row.ok).length,
  serviceNotFound: sessions.filter(row => KEYS.some(key =>
    row.versions?.[key]?.error?.message === "Service Not Found")).length }));
