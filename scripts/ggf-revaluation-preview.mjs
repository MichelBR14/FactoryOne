import { createServer } from "node:http";
import { captureRevaluation } from "./ggf-revaluation-runtime.mjs";

const allocationFile = process.argv[2];
if (!allocationFile) throw new Error("Pass the approved allocation JSON explicitly");
const port = 8083;
let reading = false;
createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  const reply = (status, body) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
  const host = request.headers.host;
  if (!["localhost:8083", "127.0.0.1:8083"].includes(host)) return reply(403, { error: "Local host required" });
  const url = new URL(request.url, `http://${host}`);
  if (!["GET", "HEAD"].includes(request.method)) return reply(405, { error: "Read only" });
  if (url.pathname.startsWith("/__ggf/")) {
    if (url.pathname !== "/__ggf/revaluation" || url.search || request.method !== "GET") return reply(404, { error: "Unknown read" });
    if (request.headers["x-factoryone-read"] !== "1" ||
        (request.headers.origin && request.headers.origin !== `http://${host}`) ||
        (request.headers["sec-fetch-site"] && !["same-origin", "none"].includes(request.headers["sec-fetch-site"])))
      return reply(403, { error: "Explicit same-origin read required" });
    if (reading) return reply(409, { error: "Leitura SAP em andamento." });
    reading = true;
    try { reply(200, (await captureRevaluation(allocationFile)).preview); }
    catch { reply(502, { error: "Leitura SAP interrompida. Nenhuma previa parcial ou demonstrativa foi publicada." }); }
    finally { reading = false; }
    return;
  }
  if (url.pathname.startsWith("/b1s/") || url.pathname.includes("/.")) return reply(404, { error: "Not found" });
  try {
    const upstream = await fetch(`http://127.0.0.1:8081${url.pathname}${url.search}`, { redirect: "error", signal: AbortSignal.timeout(30000) });
    response.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream" });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch { reply(502, { error: "UI5 preview on port 8081 required" }); }
}).listen(port, "127.0.0.1", () => console.log(`Read-only revaluation preview: http://localhost:${port}/index.html?mode=development&source=sap-read#/ggf/reavaliacao`));
