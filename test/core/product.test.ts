import { describe, expect, it } from "vitest";
import { documentRef, tableName } from "../../webapp/core/config/product";

describe("tableName", () => {
  it("monta o nome das UDTs com o prefixo FBO_", () => {
    expect(tableName("core", "SETUP")).toBe("FBO_SETUP");
    expect(tableName("ggf", "RULE1")).toBe("FBO_GGF_RULE1");
  });

  it("rejeita nome acima do limite", () => {
    expect(() => tableName("ggf", "NOME_MUITO_LONGO_DEMAIS")).toThrow(/excede/);
  });
});

describe("documentRef", () => {
  it("monta a referência de documento", () => {
    expect(documentRef("ggf", 2026, "09")).toBe("FO-GGF-2026-09");
  });
});
