import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MODULE_NAVIGATION, GGF_NAVIGATION } from "../../webapp/core/config/navigation";
import { MODULES, PRODUCT_NAME, PRODUCT_DISPLAY_NAME } from "../../webapp/core/config/product";

const manifest = JSON.parse(readFileSync("webapp/manifest.json", "utf8"));
const routing = manifest["sap.ui5"].routing;

describe("FactoryOne navigation contract", () => {
  it("keeps technical identity and licensing codes separate from display names and planned tiles", () => {
    expect(PRODUCT_NAME).toBe("FactoreOne");
    expect(PRODUCT_DISPLAY_NAME).toBe("FactoryOne");
    expect(manifest["sap.app"].id).toBe("factoreone.app");
    expect(MODULES).toEqual(["core", "ggf", "ind"]);
    expect(MODULE_NAVIGATION.map((m) => m.key)).toEqual(["ggf", "ind", "quality"]);
  });
  it("only routes implemented module menus and GGF functions", () => {
    expect(MODULE_NAVIGATION.filter((m) => m.route).map((m) => m.key)).toEqual(["ggf"]);
    expect(GGF_NAVIGATION).toHaveLength(5);
    expect(GGF_NAVIGATION.filter((f) => !f.route).map((f) => f.key)).toEqual([
      "indirect",
      "reports"
    ]);
    for (const entry of [...MODULE_NAVIGATION, ...GGF_NAVIGATION].filter((e) => e.route)) {
      expect(routing.routes.some((route: { name: string }) => route.name === entry.route)).toBe(
        true
      );
    }
  });
  it("keeps the root entry and separates the module menu from function URLs", () => {
    expect(routing.routes.find((r: { name: string }) => r.name === "main")).toMatchObject({
      pattern: "",
      target: ["main"]
    });
    expect(routing.targets.main.name).toBe("Home");
    expect(routing.targets.ggf.name).toBe("Menu");
    for (const pattern of ["ggf/fechamento", "ggf/classificacao", "ggf/rateios"]) {
      expect(routing.routes.some((r: { pattern: string }) => r.pattern === pattern)).toBe(true);
    }
  });
});
