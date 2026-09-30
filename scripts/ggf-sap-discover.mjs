import { mkdir, writeFile, readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { connect } from "node:tls";
import { openReadSession } from "./ggf-sap-session.mjs";

const session = await openReadSession();
try {
  const origin = new URL(parseEnv(await readFile(".env", "utf8")).FBO_SL_URL);
  const tls = await new Promise((resolve, reject) => {
    const socket = connect({ host: origin.hostname, port: Number(origin.port || 443), servername: origin.hostname, rejectUnauthorized: true });
    socket.setTimeout(10000, () => socket.destroy(new Error("TLS timeout")));
    socket.once("error", () => reject(new Error("Strict TLS probe failed (details withheld)")));
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate();
      resolve({ tcpReachable: true, authorized: socket.authorized, protocol: socket.getProtocol(), validFrom: certificate.valid_from, validTo: certificate.valid_to, fingerprint256: certificate.fingerprint256 });
      socket.end();
    });
  });
  const metadata = await session.get("$metadata");
  const catalog = await session.get("?$format=json");
  await mkdir(".local/ggf", { recursive: true, mode: 0o700 });
  if (metadata.ok) await writeFile(".local/ggf/metadata.xml", metadata.data, { mode: 0o600 });
  if (catalog.ok)
    await writeFile(".local/ggf/catalog.json", JSON.stringify(catalog.data, null, 2), {
      mode: 0o600
    });
  const report = {
    capturedAt: new Date().toISOString(),
    ...session.info,
    tls,
    metadata: { status: metadata.status, contentType: metadata.contentType },
    catalog: { status: catalog.status, names: catalog.data?.value?.map((entry) => entry.name) }
  };
  await writeFile(".local/ggf/discovery.json", JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify(
      { ...report, catalog: { status: catalog.status, count: report.catalog.names?.length } },
      null,
      2
    )
  );
} finally {
  await session.close();
}
