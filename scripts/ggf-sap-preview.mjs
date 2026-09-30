import { createServer } from "node:http";
import { readClosingIntegrity, readSap, SapMetadataUnavailableError } from "./ggf-sap-runtime.mjs";

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
    response.end(JSON.stringify(body));
  };
  const host = request.headers.host;
  if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(host))
    return reply(403, { error: "Local host required" });
  const url = new URL(request.url, `http://${host}`);
  if (!["GET", "HEAD"].includes(request.method)) return reply(405, { error: "Read only" });
  if (url.pathname.startsWith("/__ggf/")) {
    if (!["/__ggf/read", "/__ggf/closing-integrity"].includes(url.pathname) || request.method !== "GET")
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
