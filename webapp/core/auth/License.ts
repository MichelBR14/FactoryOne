import type { ModuleCode } from "../config/product";

/**
 * Único ponto que decide se um módulo está habilitado. Os módulos consultam só esta interface,
 * então trocar a flag por licença real depois não exige mexer neles.
 */
export interface LicenseProvider {
  isEnabled(module: ModuleCode): boolean;
}

/** MVP: uma flag por módulo (futuramente lida da FBO_LIC). O núcleo está sempre habilitado. */
export class FlagLicenseProvider implements LicenseProvider {
  constructor(private readonly flags: Partial<Record<ModuleCode, boolean>>) {}

  isEnabled(module: ModuleCode): boolean {
    return module === "core" || this.flags[module] === true;
  }
}

export function assertModuleEnabled(license: LicenseProvider, module: ModuleCode): void {
  if (!license.isEnabled(module)) {
    throw new Error(`Módulo "${module}" não está habilitado`);
  }
}
