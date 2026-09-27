import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { PRODUCT_NAME, PRODUCT_VERSION } from "../../webapp/core/config/product";

// mta.yaml, manifest.json e package.json são estáticos e repetem o nome e a versão do produto.
// Este teste garante que continuam de acordo com product.ts (única fonte).

interface Mta {
  ID: string;
  version: string;
  modules: Array<{ name: string; type: string; path: string }>;
}

const read = (file: string) => readFileSync(file, "utf8");
const mta = yaml.load(read("mta.yaml")) as Mta;
const manifest = JSON.parse(read("webapp/manifest.json")) as {
  "sap.app": { id: string; applicationVersion: { version: string } };
};
const pkg = JSON.parse(read("package.json")) as { version: string };
const slug = PRODUCT_NAME.toLowerCase();

const keysOf = (file: string) =>
  read(file)
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => l.slice(0, l.indexOf("=")))
    .sort();

describe("empacotamento do Web Client", () => {
  it("usa a versão de product.ts em package.json, mta.yaml e manifest.json", () => {
    expect(pkg.version).toBe(PRODUCT_VERSION);
    expect(mta.version).toBe(PRODUCT_VERSION);
    expect(manifest["sap.app"].applicationVersion.version).toBe(PRODUCT_VERSION);
  });

  it("deriva IDs do nome do produto", () => {
    expect(mta.ID).toBe(`ext-${slug}`);
    expect(mta.modules[0]?.name).toBe(slug);
    expect(manifest["sap.app"].id).toBe(`${slug}.app`);
  });

  it("mantém o formato de módulo do wizard da FP 2608 (fiori-app, path raiz)", () => {
    expect(mta.modules).toHaveLength(1);
    expect(mta.modules[0]?.type).toBe("fiori-app");
    expect(mta.modules[0]?.path).toBe(".");
  });

  it("tem as mesmas chaves de i18n em pt_BR (padrão) e en", () => {
    expect(keysOf("webapp/i18n/i18n_en.properties")).toEqual(keysOf("webapp/i18n/i18n.properties"));
  });
});
