import { createServer } from "node:http";
import { readClosingIntegrity, readSap, readV2Absorption, readV2AbsorptionDistribution,
  readPersistedPostingPlan, readPostingExecution, persistBlockedPostingPlan, SapMetadataUnavailableError } from "./ggf-sap-runtime.mjs";

const port = Number(process.env.FBO_PREVIEW_PORT ?? 8082);
const ui5Port = Number(process.env.FBO_UI5_PORT ?? 8081);
if (![port, ui5Port].every(value => Number.isSafeInteger(value) && value >= 1024 && value <= 65535) ||
    port === ui5Port) throw new Error("Invalid local preview ports");
let reading = false;
const server = createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  const reply = (status, body) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body, (_key, value) => typeof value === "bigint" ? value.toString() : value));
  };
  const host = request.headers.host;
  if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(host))
    return reply(403, { error: "Local host required" });
  const url = new URL(request.url, `http://${host}`);
  const postingPlanPath = ["/__ggf/v2/posting-plan", "/__ggf/v2/posting-plan/persist"].includes(url.pathname);
  if (!["GET", "HEAD"].includes(request.method) && !(postingPlanPath && request.method === "POST"))
    return reply(405, { error: "Read only outside the blocked technical posting-plan snapshot" });
  if (url.pathname.startsWith("/__ggf/")) {
    if (url.pathname === "/__ggf/v2/execution") {
      if (request.method !== "GET" || request.headers["x-factoryone-read"] !== "1" ||
          (request.headers.origin && request.headers.origin !== `http://${host}`) ||
          (request.headers["sec-fetch-site"] && !["same-origin", "none"].includes(request.headers["sec-fetch-site"])))
        return reply(403, { error: "Same-origin explicit read opt-in required" });
      const executionId = url.searchParams.get("executionId");
      if ([...url.searchParams.keys()].some(key => key !== "executionId") ||
          url.searchParams.getAll("executionId").length !== 1 || !/^F1EX[a-f0-9]{40}$/.test(executionId ?? ""))
        return reply(400, { error: "Invalid ExecutionId" });
      if (reading) return reply(409, { error: "A SAP operation is already running" });
      reading = true;
      try {
        const result = await readPostingExecution(executionId);
        reply(result.execution ? 200 : 404, result);
      } catch (error) {
        reply(error?.code === "SAP_EXECUTION_METADATA_UNAVAILABLE" ? 503 : 502,
          { code: error?.code ?? "POSTING_EXECUTION_READ_FAILED", error: "Execution ledger was not verified from SAP" });
      } finally { reading = false; }
      return;
    }
    if (url.pathname === "/__ggf/v2/posting-plan" || url.pathname === "/__ggf/v2/posting-plan/persist") {
      const isPersist = url.pathname.endsWith("/persist");
      if ((isPersist && request.method !== "POST") || (!isPersist && request.method !== "GET"))
        return reply(405, { error: "Method not allowed" });
      const optIn = isPersist ? request.headers["x-factoryone-plan-write"] === "1"
        : request.headers["x-factoryone-read"] === "1";
      if (!optIn || (request.headers.origin && request.headers.origin !== `http://${host}`) ||
          (request.headers["sec-fetch-site"] && !["same-origin", "none"].includes(request.headers["sec-fetch-site"])))
        return reply(403, { error: "Same-origin explicit opt-in required" });
      if (isPersist) {
        let raw = "";
        for await (const chunk of request) {
          raw += chunk;
          if (raw.length > 60000) return reply(413, { error: "Technical snapshot exceeds preview limit" });
        }
        let draft;
        try { draft = JSON.parse(raw); } catch { return reply(400, { error: "Invalid posting plan snapshot" }); }
        if (reading) return reply(409, { error: "A SAP operation is already running" });
        reading = true;
        try {
          const result = await persistBlockedPostingPlan(draft);
          reply(200, result);
        } catch (error) {
          if (error?.code === "SAP_METADATA_UNAVAILABLE" || error instanceof SapMetadataUnavailableError)
            reply(503, { code: "SAP_METADATA_UNAVAILABLE", postingBlocked: true,
              error: "Metadados do plano GGF indisponíveis; snapshot não confirmado." });
          else if (error?.code === "POSTING_PLAN_WRITE_UNCERTAIN")
            reply(409, { code: error.code, postingBlocked: true,
              error: "Estado da gravação incerto. Releia o plano SAP antes de qualquer nova tentativa." });
          else if (error?.code === "POSTING_PLAN_VERSION_CONFLICT")
            reply(409, { code: error.code, postingBlocked: true, error: "A versão foi criada por outra sessão; releia o SAP." });
          else reply(502, { error: "O snapshot técnico não foi confirmado. Nenhum documento financeiro foi enviado." });
        } finally { reading = false; }
        return;
      }
      if ([...url.searchParams.keys()].some(key => key !== "closingId") ||
          url.searchParams.getAll("closingId").length !== 1 ||
          !/^[A-Za-z0-9_-]{1,30}$/.test(url.searchParams.get("closingId")))
        return reply(400, { error: "Invalid ClosingId" });
      if (reading) return reply(409, { error: "A SAP operation is already running" });
      reading = true;
      try {
        const result = await readPersistedPostingPlan(url.searchParams.get("closingId"));
        reply(200, result);
      } catch (error) {
        if (error?.code === "SAP_METADATA_UNAVAILABLE")
          reply(503, { code: "SAP_METADATA_UNAVAILABLE", postingBlocked: true,
            error: "Metadados do plano GGF indisponíveis; estado SAP não verificado." });
        else reply(502, { error: "Leitura do plano interrompida; estado SAP não verificado." });
      } finally { reading = false; }
      return;
    }
    if (!["/__ggf/read", "/__ggf/closing-integrity", "/__ggf/v2/absorption", "/__ggf/v2/distribution"].includes(url.pathname) || request.method !== "GET")
      return reply(404, { error: "Unknown read" });
    if (
      request.headers["x-factoryone-read"] !== "1" ||
      (request.headers.origin && request.headers.origin !== `http://${host}`) ||
      (request.headers["sec-fetch-site"] &&
        !["same-origin", "none"].includes(request.headers["sec-fetch-site"]))
    )
      return reply(403, { error: "Same-origin explicit opt-in required" });
    if (url.pathname === "/__ggf/closing-integrity") {
      if ([...url.searchParams.keys()].some(key => key !== "closingId") ||
          url.searchParams.getAll("closingId").length !== 1 ||
          !/^[A-Za-z0-9_-]{1,30}$/.test(url.searchParams.get("closingId")))
        return reply(400, { error: "Invalid ClosingId" });
      if (reading) return reply(409, { error: "A SAP read is already running" });
      reading = true;
      try {
        const report = await readClosingIntegrity(url.searchParams.get("closingId"));
        reply(report ? 200 : 404, report ?? { error: "Closing not found" });
      } catch (error) {
        if (error instanceof SapMetadataUnavailableError)
          return reply(503, { code: error.code, error: error.message, postingBlocked: true });
        reply(502, { error: "Closing integrity read interrupted; state not verified" });
      } finally { reading = false; }
      return;
    }
    if (["/__ggf/v2/absorption", "/__ggf/v2/distribution"].includes(url.pathname)) {
      const allowed = ["start", "end", "branch", "dim1", "dim2", "dim3", "dim4", "dim5", "mapping"];
      if ([...url.searchParams.keys()].some((key) => !allowed.includes(key)) ||
          ["start", "end", "mapping"].some((key) => url.searchParams.getAll(key).length !== 1) ||
          allowed.filter((key) => !["start", "end", "mapping"].includes(key)).some((key) => url.searchParams.getAll(key).length > 1) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("start")) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("end")) ||
          [url.searchParams.get("start"), url.searchParams.get("end")].some((value) => {
            const date = new Date(`${value}T00:00:00Z`);
            return !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value;
          }) ||
          ["branch", "dim1", "dim2", "dim3", "dim4", "dim5"].some((key) => (url.searchParams.get(key) ?? "").length > 50) ||
          url.search.length > 12000)
        return reply(400, { error: "Invalid V2 absorption scope" });
      let mapping;
      try { mapping = JSON.parse(url.searchParams.get("mapping")); }
      catch { return reply(400, { error: "Invalid explicit mapping" }); }
      if (!mapping || mapping.technicalHomologation !== true ||
          !Array.isArray(mapping.accounts) || mapping.accounts.length > 20 ||
          !Array.isArray(mapping.resources) || mapping.resources.length > 100 ||
          mapping.accounts.some((row) => !row || !/^[A-Za-z0-9._-]{1,30}$/.test(row.account) || !["MOD", "GGF"].includes(row.category)) ||
          mapping.resources.some((row) => !row || !/^[A-Za-z0-9._-]{1,30}$/.test(row.resource) || !Number.isInteger(row.component) || row.component < 1 || row.component > 10 || !["MOD", "GGF"].includes(row.category)))
        return reply(400, { error: "Invalid technical mapping" });
      if (url.pathname === "/__ggf/v2/distribution") {
        const settings = mapping.distribution ?? {};
        if (!settings || typeof settings !== "object" || Array.isArray(settings) ||
            Object.keys(settings).some((category) => !["MOD", "GGF"].includes(category)) ||
            Object.values(settings).some((setting) => !setting ||
              !["DIRECT_COST", "QUANTITY", "HOURS", "RESOURCE_GROUP"].includes(setting.criterion) ||
              !Array.isArray(setting.orderNumbers) || setting.orderNumbers.length > 20 ||
              setting.orderNumbers.some((number) => !/^\d{1,10}$/.test(number)) ||
              !Array.isArray(setting.groupShares ?? []) || (setting.groupShares ?? []).length > 20 ||
              (setting.groupShares ?? []).some((share) => !share ||
                !/^[A-Za-z0-9._-]{1,30}$/.test(share.group) ||
                typeof share.percent !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(share.percent) ||
                (share.basis !== undefined && !["HOURS", "RESOURCE_QUANTITY", "RESOURCE_VALUE"].includes(share.basis)))))
          return reply(400, { error: "Invalid category distribution settings" });
      }
      if (reading) return reply(409, { error: "A SAP read is already running" });
      reading = true;
      try {
        const read = url.pathname === "/__ggf/v2/distribution" ? readV2AbsorptionDistribution : readV2Absorption;
        const result = await read({
          filter: {
            start: url.searchParams.get("start"),
            end: url.searchParams.get("end"),
            branch: url.searchParams.get("branch") ?? "",
            dimensions: [1, 2, 3, 4, 5].map((n) => url.searchParams.get(`dim${n}`) ?? "")
          }, mapping
        });
        reply(200, result);
      } catch {
        reply(502, { error: "Leitura V2 interrompida. Nenhum dado parcial foi publicado." });
      } finally { reading = false; }
      return;
    }
    if (
      [...url.searchParams.keys()].some((key) => !["start", "end"].includes(key)) ||
      ["start", "end"].some(
        (key) =>
          url.searchParams.getAll(key).length !== 1 ||
          !/^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get(key))
      )
    )
      return reply(400, { error: "Invalid period" });
    if (reading) return reply(409, { error: "A SAP read is already running" });
    reading = true;
    try {
      const result = await readSap({
        start: url.searchParams.get("start"),
        end: url.searchParams.get("end"),
        branch: "",
        costCenter: ""
      });
      reply(200, result);
    } catch {
      reply(502, {
        error:
          "Leitura SAP interrompida. Nenhum resultado parcial publicado. Confira conexao, periodo e contrato de origem."
      });
    } finally {
      reading = false;
    }
    return;
  }
  // UI5 preview only; no SAP URL, cookie, credentials or request headers are proxied.
  if (url.pathname.startsWith("/b1s/") || url.pathname.includes("/."))
    return reply(404, { error: "Not found" });
  try {
    const upstream = await fetch(`http://127.0.0.1:${ui5Port}${url.pathname}${url.search}`, {
      redirect: "error",
      signal: AbortSignal.timeout(30000)
    });
    response.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream"
    });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    reply(502, { error: `Start UI5 preview on port ${ui5Port}` });
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Read-only SAP preview: http://localhost:${port}/index.html?mode=development&source=sap-read#/ggf/fechamento`
  )
);
