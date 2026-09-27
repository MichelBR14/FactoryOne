import { MODULES, type ModuleCode } from "../config/product";
import type { LicenseProvider } from "./License";

export interface ModuleStatus {
  code: ModuleCode;
  enabled: boolean;
}

/** Estado de cada módulo da suíte, na ordem de `MODULES`, segundo a licença. */
export function listModuleStatus(license: LicenseProvider): ModuleStatus[] {
  return MODULES.map((code) => ({ code, enabled: license.isEnabled(code) }));
}
