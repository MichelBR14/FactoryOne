import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

export const AUTHORIZED_COMPANY = "SBODEMOBR2";

/** Local test tooling only. No credentials/cookies are returned to callers or logged. */
export async function openReadSession() {
  const env = parseEnv(await readFile(".env", "utf8"));
  return createReadSession(env);
}

/** Injectable transport for offline boundary tests; production calls use native verified fetch. */
export async function createReadSession(env, transport = fetch) {
  let origin;
  try {
    origin = new URL(env.FBO_SL_URL);
  } catch {
    throw new Error("Invalid local SAP origin");
  }
  if (env.FBO_SL_COMPANY_DB !== AUTHORIZED_COMPANY || !["dev", "test"].includes(env.FBO_ENV))
    throw new Error("SAP test company/environment guard rejected configuration");
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("This read-only tool requires a clean HTTPS origin");
  if (!env.FBO_SL_USER || !env.FBO_SL_PASSWORD) throw new Error("Local credentials are missing");
  // Always verify certificates. Never fall back to cleartext or NODE_TLS_REJECT_UNAUTHORIZED=0.
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new Error("Unsafe global TLS override rejected");
  const root = `${origin.origin}/b1s/v2/`;
  const login = await transport(root + "Login", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      CompanyDB: AUTHORIZED_COMPANY,
      UserName: env.FBO_SL_USER,
      Password: env.FBO_SL_PASSWORD
    })
  }).catch(() => {
    throw new Error("SAP login transport failed (details withheld)");
  });
  if (!login.ok) throw new Error(`SAP login rejected: HTTP ${login.status}`);
  const body = await login.json().catch(() => {
    throw new Error("Invalid SAP login response");
  });
  if (typeof body.SessionId !== "string" || !/^[\w-]+$/.test(body.SessionId))
    throw new Error("SAP login returned no session");
  const route = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("ROUTEID="));
  let cookie = `B1SESSION=${body.SessionId}${route ? `; ${route}` : ""}`;
  const safeInfo = {
    company: AUTHORIZED_COMPANY,
    version: /^\d+$/.test(String(body.Version)) ? String(body.Version) : "unknown",
    sessionTimeoutMinutes: Number.isFinite(body.SessionTimeout) ? body.SessionTimeout : undefined,
    basePath: "/b1s/v2",
    tlsVerified: true
  };
  return {
    info: safeInfo,
    async get(path, headers = {}) {
      if (!cookie) throw new Error("SAP read session is closed");
      if (
        typeof path !== "string" ||
        !path ||
        /[\\#\r\n]/.test(path) ||
        path.startsWith("/") ||
        /^[a-z]+:/i.test(path)
      )
        throw new Error("Non-relative SAP read path rejected");
      const url = new URL(path, root);
      if (
        url.origin !== origin.origin ||
        !url.pathname.startsWith("/b1s/v2/") ||
        /\/(Login|Logout)(?:\/|$)/i.test(url.pathname)
      )
        throw new Error("SAP read path outside allowed boundary");
      const response = await transport(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: { ...headers, Cookie: cookie }
      }).catch(() => {
        throw new Error("SAP read transport failed (details withheld)");
      });
      const text = await response.text().catch(() => {
        throw new Error("SAP response interrupted (details withheld)");
      });
      if (!response.ok) {
        let code;
        try {
          code = JSON.parse(text).error?.code;
        } catch {
          /* Body deliberately not logged. */
        }
        return {
          ok: false,
          status: response.status,
          code: typeof code === "number" || typeof code === "string" ? code : undefined
        };
      }
      const contentType = response.headers.get("content-type") ?? "";
      let data = text;
      if (contentType.includes("json")) {
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error("Invalid SAP JSON response");
        }
      }
      return { ok: true, status: response.status, contentType, data };
    },
    async readFifoLayers(itemCode, warehouseCode) {
      if (!cookie || !/^[A-Za-z0-9_-]{1,50}$/.test(itemCode) ||
          !/^[A-Za-z0-9_-]{1,20}$/.test(warehouseCode))
        throw new Error("Invalid FIFO read scope");
      const response = await transport(root + "MaterialRevaluationFIFOService_GetMaterialRevaluationFIFO", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
        headers: { Cookie: cookie, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ MaterialRevaluationFIFOParams: {
          ItemCode: itemCode, LocationCode: warehouseCode, LocationType: "64", ShowIssuedLayers: "tNO"
        } })
      }).catch(() => { throw new Error("SAP FIFO read action transport failed (details withheld)"); });
      const raw = await response.text().catch(() => { throw new Error("SAP FIFO read response interrupted"); });
      if (!response.ok) return { ok: false, status: response.status };
      let data;
      try { data = JSON.parse(raw); } catch { throw new Error("Invalid SAP FIFO JSON response"); }
      if (!Array.isArray(data?.Layers)) throw new Error("SAP FIFO layer response incomplete");
      return { ok: true, status: response.status, data };
    },
    async close() {
      if (!cookie) return;
      try {
        const response = await transport(root + "Logout", {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
          headers: { Cookie: cookie }
        }).catch(() => {
          throw new Error("SAP logout transport failed (details withheld)");
        });
        if (!response.ok) throw new Error(`SAP logout rejected: HTTP ${response.status}`);
      } finally {
        cookie = "";
      }
    }
  };
}
