import { describe, expect, it } from "vitest";
import {
  ServiceLayerError,
  isSessionExpired,
  loginError,
  networkError,
  parseErrorBody,
  translateServiceLayerError
} from "../../../webapp/core/service/errors";

const body = (code: number, message: string) =>
  JSON.stringify({ error: { code, message: { lang: "en-us", value: message } } });

describe("parseErrorBody", () => {
  it("lê código e mensagem do formato do Service Layer", () => {
    expect(parseErrorBody(body(-2028, "Object does not exist"))).toEqual({
      code: -2028,
      message: "Object does not exist"
    });
  });

  it("aceita mensagem como texto simples", () => {
    const text = JSON.stringify({ error: { code: 5, message: "Falhou" } });
    expect(parseErrorBody(text)).toEqual({ code: 5, message: "Falhou" });
  });

  it("tolera corpo vazio, não-JSON ou sem `error`", () => {
    expect(parseErrorBody(undefined)).toEqual({});
    expect(parseErrorBody("")).toEqual({});
    expect(parseErrorBody("<html>502</html>")).toEqual({});
    expect(parseErrorBody("{}")).toEqual({});
    expect(parseErrorBody("null")).toEqual({});
  });
});

describe("isSessionExpired", () => {
  it("reconhece HTTP 401 e o código 301", () => {
    expect(isSessionExpired(401, "")).toBe(true);
    expect(isSessionExpired(400, body(301, "Invalid session"))).toBe(true);
    expect(isSessionExpired(400, body(-1, "Outro erro"))).toBe(false);
    expect(isSessionExpired(500, undefined)).toBe(false);
  });
});

describe("translateServiceLayerError", () => {
  it("sessão expirada", () => {
    const error = translateServiceLayerError(401, body(301, "Invalid session."));
    expect(error).toBeInstanceOf(ServiceLayerError);
    expect(error.message).toMatch(/sessão do Service Layer expirou/);
    expect(error.status).toBe(401);
    expect(error.code).toBe(301);
    expect(error.detail).toBe("Invalid session.");
  });

  it("403 e 404", () => {
    expect(translateServiceLayerError(403, "").message).toMatch(/permissão/);
    expect(translateServiceLayerError(404, "").message).toMatch(/não encontrado/);
  });

  it("400 inclui o texto original do Service Layer", () => {
    const error = translateServiceLayerError(400, body(-5002, "Period is locked"));
    expect(error.message).toBe("O SAP Business One recusou a requisição: Period is locked");
    expect(error.code).toBe(-5002);
  });

  it("400 sem corpo legível não deixa dois-pontos sobrando", () => {
    expect(translateServiceLayerError(400, "").message).toBe("O SAP Business One recusou a requisição");
  });

  it("5xx", () => {
    const error = translateServiceLayerError(502, "<html>Bad gateway</html>");
    expect(error.message).toBe("Erro interno no Service Layer (HTTP 502)");
  });

  it("aceita mensagens de outro idioma", () => {
    const en = {
      network: "n",
      sessionExpired: "expired",
      forbidden: "f",
      notFound: "nf",
      badRequest: (d?: string) => `bad ${d}`,
      server: (s: number) => `srv ${s}`,
      login: (d?: string) => `login ${d}`,
      unknown: (s: number) => `unk ${s}`
    };
    expect(translateServiceLayerError(401, "", en).message).toBe("expired");
    expect(translateServiceLayerError(400, body(1, "x"), en).message).toBe("bad x");
  });
});

describe("loginError / networkError", () => {
  it("login falho mostra o motivo do Service Layer", () => {
    const error = loginError(401, body(-1, "Invalid password"));
    expect(error.message).toBe("Falha no login do Service Layer: Invalid password");
    expect(error.status).toBe(401);
  });

  it("erro de rede tem status 0 e guarda a causa", () => {
    const error = networkError(new TypeError("fetch failed"));
    expect(error.status).toBe(0);
    expect(error.message).toMatch(/Não foi possível conectar/);
    expect(error.detail).toBe("fetch failed");
  });
});
