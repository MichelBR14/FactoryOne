import { describe, expect, it } from "vitest";
import {
  assertWriteAllowed,
  describeConfig,
  loadIntegrationConfig
} from "../../webapp/core/config/integration";

const base = {
  FBO_ENV: "dev",
  FBO_SL_URL: "https://servidor.exemplo.com:50000/",
  FBO_SL_COMPANY_DB: "SBO_TESTE",
  FBO_SL_USER: "manager",
  FBO_SL_PASSWORD: "segredo"
};

describe("loadIntegrationConfig", () => {
  it("lê e normaliza a configuração", () => {
    const config = loadIntegrationConfig(base);
    expect(config).toEqual({
      environment: "dev",
      serviceLayerUrl: "https://servidor.exemplo.com:50000",
      companyDb: "SBO_TESTE",
      userName: "manager",
      password: "segredo",
      verifyTls: true
    });
  });

  it("aceita SSO sem usuário e senha", () => {
    const config = loadIntegrationConfig({ ...base, FBO_SL_USER: "", FBO_SL_PASSWORD: "" });
    expect(config.userName).toBeUndefined();
    expect(config.password).toBeUndefined();
  });

  it("rejeita usuário sem senha e vice-versa", () => {
    expect(() => loadIntegrationConfig({ ...base, FBO_SL_PASSWORD: "" })).toThrow(/juntos/);
    expect(() => loadIntegrationConfig({ ...base, FBO_SL_USER: "" })).toThrow(/juntos/);
  });

  it("exige URL e banco da empresa", () => {
    expect(() => loadIntegrationConfig({ ...base, FBO_SL_URL: undefined })).toThrow(/FBO_SL_URL/);
    expect(() => loadIntegrationConfig({ ...base, FBO_SL_COMPANY_DB: " " })).toThrow(
      /FBO_SL_COMPANY_DB/
    );
  });

  it("rejeita ambiente desconhecido", () => {
    expect(() => loadIntegrationConfig({ ...base, FBO_ENV: "staging" })).toThrow(/FBO_ENV/);
  });

  it("sem FBO_ENV assume prod", () => {
    expect(loadIntegrationConfig({ ...base, FBO_ENV: undefined }).environment).toBe("prod");
  });

  it("FBO_SL_VERIFY_TLS=false desliga a verificação", () => {
    expect(loadIntegrationConfig({ ...base, FBO_SL_VERIFY_TLS: "false" }).verifyTls).toBe(false);
  });
});

describe("assertWriteAllowed", () => {
  it("libera dev e test, bloqueia prod", () => {
    expect(() => assertWriteAllowed(loadIntegrationConfig(base))).not.toThrow();
    expect(() =>
      assertWriteAllowed(loadIntegrationConfig({ ...base, FBO_ENV: "test" }))
    ).not.toThrow();
    expect(() =>
      assertWriteAllowed(loadIntegrationConfig({ ...base, FBO_ENV: "prod" }))
    ).toThrow(/bloqueada/);
  });
});

describe("describeConfig", () => {
  it("não expõe a senha", () => {
    expect(describeConfig(loadIntegrationConfig(base))).not.toContain("segredo");
  });
});
