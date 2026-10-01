import { Agent as HttpsAgent, request as httpsRequest } from "node:https";

/** Local homologation only: retains HTTPS encryption, but does not authenticate the server certificate. */
export function createLocalTestHttpsTransport(approvedOrigin, request = httpsRequest) {
  const expected = new URL(approvedOrigin);
  if (expected.protocol !== "https:" || expected.pathname !== "/" || expected.username || expected.password ||
      expected.search || expected.hash)
    throw new Error("Invalid local HTTPS test origin");
  const agent = new HttpsAgent({ rejectUnauthorized: false });
  return (input, options = {}) => new Promise((resolve, reject) => {
    let url;
    try { url = new URL(input); } catch { reject(new Error("Invalid local HTTPS request URL")); return; }
    if (url.origin !== expected.origin || url.protocol !== "https:" || options.redirect !== "error") {
      reject(new Error("Local HTTPS test transport rejected an off-origin or redirectable request"));
      return;
    }
    const req = request(url, {
      method: options.method ?? "GET", headers: options.headers ?? {},
      signal: options.signal, agent
    });
    req.on("error", reject);
    req.on("response", incoming => {
      const chunks = [];
      incoming.on("data", chunk => chunks.push(Buffer.from(chunk)));
      incoming.on("error", reject);
      incoming.on("end", () => {
        const headers = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          const name = incoming.rawHeaders[index];
          const value = incoming.rawHeaders[index + 1];
          if (name?.toLowerCase() === "set-cookie") headers.append(name, value);
          else if (name) headers.set(name, value);
        }
        const status = incoming.statusCode ?? 502;
        resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status, headers }));
      });
    });
    if (options.body != null) req.write(options.body);
    req.end();
  });
}
