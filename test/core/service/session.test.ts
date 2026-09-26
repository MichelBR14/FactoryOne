import { describe, expect, it } from "vitest";
import { loadIntegrationConfig } from "../../../webapp/core/config/integration";
import { CredentialsSessionProvider } from "../../../webapp/core/service/SessionProvider";
import { ServiceLayerError } from "../../../webapp/core/service/errors";
import { LOGIN_OK, SL_ERROR, createFakeFetch } from "./fakeFetch";

const config = loadIntegrationConfig({
  FBO_ENV: "dev",
  FBO_SL_URL: "https://sl.exemplo.com:50000",
  FBO_SL_COMPANY_DB: "SBO_TESTE",
  FBO_SL_USER: "manager",
  FBO_SL_PASSWORD: "segredo"
});

describe("CredentialsSessionProvider", () => {
  it("faz login e devolve a sessão com ROUTEID", async () => {
    const fake = createFakeFetch(LOGIN_OK("abc-123", ".node2"));
    const session = await new CredentialsSessionProvider(config, fake.fetch).acquire();

    expect(session).toEqual({ kind: "cookie", sessionId: "abc-123", routeId: ".node2" });
    const [call] = fake.calls;
    expect(call?.url).toBe("https://sl.exemplo.com:50000/b1s/v2/Login");
    expect(call?.init.method).toBe("POST");
    expect(JSON.parse(call?.init.body ?? "{}")).toEqual({
      CompanyDB: "SBO_TESTE",
      UserName: "manager",
      Password: "segredo"
    });
  });

  it("funciona sem ROUTEID", async () => {
    const fake = createFakeFetch(LOGIN_OK("abc-123"));
    const session = await new CredentialsSessionProvider(config, fake.fetch).acquire();
    expect(session).toEqual({ kind: "cookie", sessionId: "abc-123", routeId: undefined });
  });

  it("traduz falha de login", async () => {
    const fake = createFakeFetch(SL_ERROR(401, -1, "Invalid password"));
    const provider = new CredentialsSessionProvider(config, fake.fetch);
    await expect(provider.acquire()).rejects.toThrow(/Falha no login do Service Layer: Invalid password/);
  });

  it("traduz erro de rede", async () => {
    const fake = createFakeFetch(new TypeError("fetch failed"));
    const provider = new CredentialsSessionProvider(config, fake.fetch);
    const error = await provider.acquire().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceLayerError);
    expect((error as ServiceLayerError).status).toBe(0);
  });

  it("rejeita resposta de login sem SessionId", async () => {
    const fake = createFakeFetch({ status: 200, body: { Version: "1" } });
    await expect(new CredentialsSessionProvider(config, fake.fetch).acquire()).rejects.toThrow(/SessionId/);
  });

  it("exige usuário e senha, sem chamar o servidor", async () => {
    const sso = loadIntegrationConfig({
      FBO_SL_URL: "https://sl.exemplo.com:50000",
      FBO_SL_COMPANY_DB: "SBO_TESTE"
    });
    const fake = createFakeFetch();
    await expect(new CredentialsSessionProvider(sso, fake.fetch).acquire()).rejects.toThrow(/FBO_SL_USER/);
    expect(fake.calls).toHaveLength(0);
  });
});
