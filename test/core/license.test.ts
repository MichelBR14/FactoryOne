import { describe, expect, it } from "vitest";
import { FlagLicenseProvider, assertModuleEnabled } from "../../webapp/core/auth/License";

describe("FlagLicenseProvider", () => {
  it("núcleo está sempre habilitado", () => {
    expect(new FlagLicenseProvider({}).isEnabled("core")).toBe(true);
    expect(new FlagLicenseProvider({ core: false }).isEnabled("core")).toBe(true);
  });

  it("módulos só habilitam com a flag explícita", () => {
    const license = new FlagLicenseProvider({ ggf: true });
    expect(license.isEnabled("ggf")).toBe(true);
    expect(license.isEnabled("ind")).toBe(false);
  });

  it("assertModuleEnabled bloqueia módulo desabilitado", () => {
    const license = new FlagLicenseProvider({ ggf: true });
    expect(() => assertModuleEnabled(license, "ggf")).not.toThrow();
    expect(() => assertModuleEnabled(license, "ind")).toThrow(/não está habilitado/);
  });
});
