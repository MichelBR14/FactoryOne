// Gera o WebClientExtension.json (tile) dentro da pasta do módulo.
// O nome vem de product.ts (Node 24 lê TypeScript direto) e o subtítulo do i18n; nada é repetido à mão.
import fs from "node:fs";
import path from "node:path";
import { PRODUCT_NAME } from "../webapp/core/config/product.ts";
import { readModuleInfo } from "./module-info.mjs";

function readProperty(file, key) {
  const line = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`Chave ${key} não encontrada em ${file}`);
  return line.slice(key.length + 1).trim();
}

const { moduleDir } = readModuleInfo();
if (!fs.existsSync(moduleDir)) {
  throw new Error(`Pasta ${moduleDir} não existe; rode o build do UI5 antes.`);
}

// Formato dos tiles conforme o wizard do SAP B1 Web Client (1.5.0). O primeiro tile de um app Fiori
// é a página inicial e por isso não leva `url`.
const config = {
  tiles: [
    {
      text: PRODUCT_NAME,
      enableTitleHeader: false,
      subtitle: readProperty("webapp/i18n/i18n.properties", "tileSubtitle"),
      linkmethod: "ExistingWindow",
      size: "1x1",
      icon: "sap-icon://customize",
      image: ""
    }
  ]
};

fs.writeFileSync(path.join(moduleDir, "WebClientExtension.json"), `${JSON.stringify(config, null, 2)}\n`);
console.log(`WebClientExtension.json gerado em ${moduleDir}`);
