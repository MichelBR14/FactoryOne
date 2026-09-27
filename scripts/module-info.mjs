// Lê o nome do módulo no mta.yaml e devolve as pastas usadas pelo build (mesma convenção do wizard da SAP).
import fs from "node:fs";
import yaml from "js-yaml";

export function readModuleInfo() {
  const mta = yaml.load(fs.readFileSync("mta.yaml", "utf8"));
  const name = mta.modules[0].name;
  if (!/^[A-Za-z0-9_\-.]+$/.test(name)) {
    throw new Error(`Nome de módulo inválido no mta.yaml: ${name}`);
  }
  return { name, moduleDir: `${name}.module`, resourcesDir: "resources" };
}
