import { describe, expect, it } from "vitest";
import { FlagLicenseProvider } from "../../webapp/core/auth/License";
import { listModuleStatus } from "../../webapp/core/auth/moduleStatus";
import { MODULES } from "../../webapp/core/config/product";

describe("listModuleStatus", () => {
  it("lista todos os módulos na ordem de MODULES", () => {
    const codes = listModuleStatus(new FlagLicenseProvider({})).map((m) => m.code);
    expect(codes).toEqual([...MODULES]);
  });

  it("só o núcleo fica habilitado quando não há flags", () => {
    const status = listModuleStatus(new FlagLicenseProvider({}));
    expect(status.filter((m) => m.enabled).map((m) => m.code)).toEqual(["core"]);
  });

  it("habilita o módulo cuja flag está ligada", () => {
    const status = listModuleStatus(new FlagLicenseProvider({ ggf: true }));
    expect(status.find((m) => m.code === "ggf")?.enabled).toBe(true);
    expect(status.find((m) => m.code === "ind")?.enabled).toBe(false);
  });
});
