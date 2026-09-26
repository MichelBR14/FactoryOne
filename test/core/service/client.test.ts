import { describe, expect, it } from "vitest";
import { loadIntegrationConfig } from "../../../webapp/core/config/integration";
import { ServiceLayerClient } from "../../../webapp/core/service/ServiceLayerClient";
import {
  CredentialsSessionProvider,
  type SessionProvider
} from "../../../webapp/core/service/SessionProvider";
import { ServiceLayerError } from "../../../webapp/core/service/errors";
import { LOGIN_OK, SL_ERROR, createFakeFetch } from "./fakeFetch";

const env = {
  FBO_ENV: "dev",
  FBO_SL_URL: "https://sl.exemplo.com:50000",
  FBO_SL_COMPANY_DB: "SBO_TESTE",
  FBO_SL_USER: "manager",
  FBO_SL_PASSWORD: "segredo"
};

function setup(handlers: Parameters<typeof createFakeFetch>, overrides: Record<string, string> = {}) {
  const config = loadIntegrationConfig({ ...env, ...overrides });
  const fake = createFakeFetch(...handlers);
  let n = 0;
  const client = new ServiceLayerClient({
    config,
    session: new CredentialsSessionProvider(config, fake.fetch),
    fetch: fake.fetch,
    newId: () => `id${++n}`
  });
  return { client, fake, config };
}

describe("sessão", () => {
  it("faz login uma vez e reutiliza a sessão com cookies", async () => {
    const { client, fake } = setup([LOGIN_OK("S1", ".node1"), { body: { a: 1 } }, { body: { b: 2 } }]);

    expect(await client.get("Items")).toEqual({ a: 1 });
    expect(await client.get("Orders")).toEqual({ b: 2 });

    expect(fake.calls.map((c) => c.url)).toEqual([
      "https://sl.exemplo.com:50000/b1s/v2/Login",
      "https://sl.exemplo.com:50000/b1s/v2/Items",
      "https://sl.exemplo.com:50000/b1s/v2/Orders"
    ]);
    expect(fake.calls[1]?.init.headers.Cookie).toBe("B1SESSION=S1; ROUTEID=.node1");
    expect(fake.calls[2]?.init.headers.Cookie).toBe("B1SESSION=S1; ROUTEID=.node1");
  });

  it("chamadas simultâneas compartilham um único login", async () => {
    const { client, fake } = setup([LOGIN_OK("S1"), { body: {} }, { body: {} }, { body: {} }]);
    await Promise.all([client.get("A"), client.get("B"), client.get("C")]);
    expect(fake.calls.filter((c) => c.url.endsWith("/Login"))).toHaveLength(1);
  });

  it("falha de login não fica em cache: a próxima chamada tenta de novo", async () => {
    const { client } = setup([SL_ERROR(401, -1, "Invalid password"), LOGIN_OK("S2"), { body: { ok: true } }]);
    await expect(client.get("Items")).rejects.toThrow(/Falha no login/);
    expect(await client.get("Items")).toEqual({ ok: true });
  });
});

describe("renovação de sessão", () => {
  it("em 401 faz novo login e reenvia a requisição uma vez", async () => {
    const { client, fake } = setup([
      LOGIN_OK("S1"),
      SL_ERROR(401, 301, "Invalid session."),
      LOGIN_OK("S2"),
      { body: { ok: true } }
    ]);

    expect(await client.get("Items")).toEqual({ ok: true });
    expect(fake.calls).toHaveLength(4);
    expect(fake.calls[1]?.init.headers.Cookie).toBe("B1SESSION=S1");
    expect(fake.calls[3]?.init.headers.Cookie).toBe("B1SESSION=S2");
    expect(fake.calls[3]?.url).toBe(fake.calls[1]?.url);
  });

  it("reconhece o código 301 mesmo com status diferente de 401", async () => {
    const { client } = setup([
      LOGIN_OK("S1"),
      SL_ERROR(400, 301, "Invalid session."),
      LOGIN_OK("S2"),
      { body: { ok: true } }
    ]);
    expect(await client.get("Items")).toEqual({ ok: true });
  });

  it("reenvia o corpo de uma escrita após renovar", async () => {
    const { client, fake } = setup([
      LOGIN_OK("S1"),
      SL_ERROR(401, 301, "Invalid session."),
      LOGIN_OK("S2"),
      { status: 201, body: { DocEntry: 5 } }
    ]);
    expect(await client.post("Orders", { CardCode: "C1" })).toEqual({ DocEntry: 5 });
    expect(fake.calls[3]?.init.body).toBe('{"CardCode":"C1"}');
  });

  it("não entra em laço: segundo 401 seguido vira erro", async () => {
    const { client, fake } = setup([
      LOGIN_OK("S1"),
      SL_ERROR(401, 301, "Invalid session."),
      LOGIN_OK("S2"),
      SL_ERROR(401, 301, "Invalid session.")
    ]);
    await expect(client.get("Items")).rejects.toThrow(/sessão do Service Layer expirou/);
    expect(fake.calls).toHaveLength(4);
  });

  it("requisições simultâneas expiradas compartilham a mesma renovação", async () => {
    const { client, fake } = setup([
      LOGIN_OK("S1"),
      SL_ERROR(401, 301, "Invalid session."),
      SL_ERROR(401, 301, "Invalid session."),
      LOGIN_OK("S2"),
      { body: { n: 1 } },
      { body: { n: 2 } }
    ]);
    const [a, b] = await Promise.all([client.get("A"), client.get("B")]);
    expect([a, b]).toEqual([{ n: 1 }, { n: 2 }]);
    expect(fake.calls.filter((c) => c.url.endsWith("/Login"))).toHaveLength(2);
  });
});

describe("requisições e erros", () => {
  it("devolve undefined para 204", async () => {
    const { client } = setup([LOGIN_OK("S1"), { status: 204 }]);
    expect(await client.patch("Items('A1')", { Foo: 1 })).toBeUndefined();
  });

  it("envia JSON e Accept, e normaliza a barra inicial", async () => {
    const { client, fake } = setup([LOGIN_OK("S1"), { status: 201, body: {} }]);
    await client.post("/JournalEntries", { Memo: "x" });
    const call = fake.calls[1];
    expect(call?.url).toBe("https://sl.exemplo.com:50000/b1s/v2/JournalEntries");
    expect(call?.init.headers["Content-Type"]).toBe("application/json");
    expect(call?.init.headers.Accept).toBe("application/json");
  });

  it("traduz erros do Service Layer", async () => {
    const { client } = setup([LOGIN_OK("S1"), SL_ERROR(400, -5002, "Period is locked")]);
    const error = await client.post("JournalEntries", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceLayerError);
    expect((error as ServiceLayerError).message).toBe("O SAP Business One recusou a requisição: Period is locked");
    expect((error as ServiceLayerError).code).toBe(-5002);
  });

  it("traduz falha de rede", async () => {
    const { client } = setup([LOGIN_OK("S1"), new TypeError("fetch failed")]);
    await expect(client.get("Items")).rejects.toThrow(/Não foi possível conectar/);
  });

  it("rejeita resposta que não é JSON", async () => {
    const { client } = setup([LOGIN_OK("S1"), { body: "<html>" }]);
    await expect(client.get("Items")).rejects.toThrow(/JSON/);
  });
});

describe("trava de escrita", () => {
  const prod = { FBO_ENV: "prod" };

  it("com sessão por credenciais, bloqueia escrita em prod antes de tocar no servidor", async () => {
    const { client, fake } = setup([LOGIN_OK("S1")], prod);
    await expect(client.post("Orders", {})).rejects.toThrow(/bloqueada/);
    await expect(client.batch([{ changeset: [{ method: "POST", path: "Orders", body: {} }] }])).rejects.toThrow(
      /bloqueada/
    );
    expect(fake.calls.filter((c) => !c.url.endsWith("/Login"))).toHaveLength(0);
  });

  it("leituras continuam liberadas em prod", async () => {
    const { client } = setup([LOGIN_OK("S1"), { body: { ok: true } }], prod);
    expect(await client.get("Items")).toEqual({ ok: true });
  });

  it("sessão do Web Client (SSO) não passa pela trava e usa os cookies do browser", async () => {
    const config = loadIntegrationConfig({
      FBO_ENV: "prod",
      FBO_SL_URL: env.FBO_SL_URL,
      FBO_SL_COMPANY_DB: env.FBO_SL_COMPANY_DB
    });
    const sso: SessionProvider = { acquire: async () => ({ kind: "host" }) };
    const fake = createFakeFetch({ status: 201, body: { DocEntry: 1 } });
    const client = new ServiceLayerClient({ config, session: sso, fetch: fake.fetch });

    expect(await client.post("Orders", {})).toEqual({ DocEntry: 1 });
    expect(fake.calls[0]?.init.credentials).toBe("include");
    expect(fake.calls[0]?.init.headers.Cookie).toBeUndefined();
  });
});

describe("$batch", () => {
  const batchReply = (parts: string[], boundary = "b_1") => ({
    status: 200,
    headers: { "Content-Type": `multipart/mixed;boundary=${boundary}` },
    body: [...parts, `--${boundary}--`, ""].join("\r\n")
  });

  const okChangeset = [
    "--b_1",
    "Content-Type: multipart/mixed; boundary=cs_1",
    "",
    "--cs_1",
    "Content-Type: application/http",
    "Content-Transfer-Encoding: binary",
    "Content-ID: 1",
    "",
    "HTTP/1.1 201 Created",
    "Content-Type: application/json",
    "",
    '{"JdtNum":10}',
    "--cs_1--"
  ].join("\r\n");

  it("envia o changeset e devolve os resultados", async () => {
    const { client, fake } = setup([LOGIN_OK("S1"), batchReply([okChangeset])]);

    const results = await client.batch([
      { changeset: [{ method: "POST", path: "JournalEntries", body: { Memo: "x" } }] }
    ]);

    expect(results).toEqual([expect.objectContaining({ status: 201, contentId: "1", body: { JdtNum: 10 } })]);

    const call = fake.calls[1];
    expect(call?.url).toBe("https://sl.exemplo.com:50000/b1s/v2/$batch");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers["Content-Type"]).toBe("multipart/mixed;boundary=batch_id1");
    expect(call?.init.body).toContain("POST /b1s/v2/JournalEntries HTTP/1.1");
    expect(call?.init.body).toContain("--changeset_id2--");
  });

  const failedChangeset = [
    "--b_1",
    "Content-Type: multipart/mixed; boundary=cs_1",
    "",
    "--cs_1",
    "Content-Type: application/http",
    "",
    "HTTP/1.1 400 Bad Request",
    "Content-Type: application/json",
    "",
    '{"error":{"code":-5002,"message":{"lang":"en-us","value":"Period is locked"}}}',
    "--cs_1--"
  ].join("\r\n");

  it("lança o erro traduzido quando um changeset falha", async () => {
    const { client } = setup([LOGIN_OK("S1"), batchReply([failedChangeset])]);
    await expect(
      client.batch([{ changeset: [{ method: "POST", path: "JournalEntries", body: {} }] }])
    ).rejects.toThrow("O SAP Business One recusou a requisição: Period is locked");
  });

  it("com throwOnError=false devolve todos os resultados, inclusive o erro", async () => {
    const { client } = setup([LOGIN_OK("S1"), batchReply([okChangeset, failedChangeset])]);
    const results = await client.batch(
      [
        { changeset: [{ method: "POST", path: "JournalEntries", body: {} }] },
        { changeset: [{ method: "POST", path: "MaterialRevaluation", body: {} }] }
      ],
      { throwOnError: false }
    );
    expect(results.map((r) => r.status)).toEqual([201, 400]);
    expect(results[1]?.error?.code).toBe(-5002);
  });

  it("renova a sessão também no $batch", async () => {
    const { client, fake } = setup([
      LOGIN_OK("S1"),
      SL_ERROR(401, 301, "Invalid session."),
      LOGIN_OK("S2"),
      batchReply([okChangeset])
    ]);
    const results = await client.batch([{ changeset: [{ method: "POST", path: "JournalEntries", body: {} }] }]);
    expect(results).toHaveLength(1);
    expect(fake.calls[3]?.init.headers.Cookie).toBe("B1SESSION=S2");
    expect(fake.calls[3]?.init.body).toBe(fake.calls[1]?.init.body);
  });

  it("erro HTTP do $batch inteiro vira ServiceLayerError", async () => {
    const { client } = setup([LOGIN_OK("S1"), { status: 500, body: "boom" }]);
    await expect(client.batch([{ method: "GET", path: "Items" }])).rejects.toThrow(/Erro interno/);
  });

  it("resposta sem boundary é rejeitada", async () => {
    const { client } = setup([LOGIN_OK("S1"), { status: 200, body: "x" }]);
    await expect(client.batch([{ method: "GET", path: "Items" }])).rejects.toThrow(/boundary/);
  });

  it("batch só de leitura passa pela trava em prod", async () => {
    const { client } = setup([LOGIN_OK("S1"), batchReply([])], { FBO_ENV: "prod" });
    await expect(client.batch([{ method: "GET", path: "Items" }], { throwOnError: false })).resolves.toEqual([]);
  });
});
