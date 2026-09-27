// Empacota <módulo>.module em resources/<idDoApp>.zip, como o index.js do wizard da SAP.
// Diferença deliberada: qualquer erro encerra com código diferente de zero (o do wizard só registra e segue).
import fs from "node:fs";
import archiver from "archiver";
import { readModuleInfo } from "./module-info.mjs";

const { moduleDir, resourcesDir } = readModuleInfo();

const manifestPath = `${moduleDir}/manifest.json`;
if (!fs.existsSync(manifestPath)) {
  throw new Error(`${manifestPath} não existe.`);
}
const appId = JSON.parse(fs.readFileSync(manifestPath, "utf8"))["sap.app"]?.id;
if (!appId) {
  throw new Error(`${manifestPath} sem sap.app.id.`);
}
if (!fs.existsSync(`${moduleDir}/WebClientExtension.json`)) {
  throw new Error(`${moduleDir}/WebClientExtension.json não existe.`);
}

fs.mkdirSync(resourcesDir, { recursive: true });
const target = `${resourcesDir}/${appId.replaceAll(".", "")}.zip`;

await new Promise((resolve, reject) => {
  const output = fs.createWriteStream(target);
  const archive = archiver("zip");
  output.on("close", () => {
    console.log(`${target}: ${archive.pointer()} bytes`);
    resolve();
  });
  archive.on("error", reject);
  archive.pipe(output);
  archive.directory(moduleDir, false);
  archive.finalize();
});
