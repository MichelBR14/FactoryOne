// Technical preview of the built entry descriptor, never a screenshot of an installed SAP tile.
import { chromium } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { readModuleInfo } from "../../scripts/module-info.mjs";

const { moduleDir } = readModuleInfo();
const descriptor = JSON.parse(await readFile(`${moduleDir}/WebClientExtension.json`, "utf8"));
assert.deepEqual(descriptor, {
  tiles: [
    {
      text: "FactoryOne",
      enableTitleHeader: false,
      subtitle: "Suíte industrial",
      linkmethod: "ExistingWindow",
      size: "1x1",
      icon: "sap-icon://customize",
      image: ""
    }
  ]
});
await mkdir("docs/navigation", { recursive: true });
const browser = await chromium.launch({ headless: true });
const blocked = [];
try {
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["mobile", { width: 390, height: 844 }]
  ]) {
    const page = await browser.newPage({ viewport });
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== "localhost" || url.pathname.startsWith("/b1s/")) {
        blocked.push(url.href);
        return route.abort();
      }
      return route.continue();
    });
    await page.goto("http://localhost:8081/index.html?mode=development");
    await page.getByRole("heading", { name: "Módulos", exact: true }).waitFor();
    await page.evaluate(async (tile) => {
      const [
        Page,
        VBox,
        Title,
        MessageStrip,
        GenericTile,
        TileContent,
        ImageContent,
        ObjectStatus
      ] = await new Promise((resolve) =>
        sap.ui.require(
          [
            "sap/m/Page",
            "sap/m/VBox",
            "sap/m/Title",
            "sap/m/MessageStrip",
            "sap/m/GenericTile",
            "sap/m/TileContent",
            "sap/m/ImageContent",
            "sap/m/ObjectStatus"
          ],
          (...controls) => resolve(controls)
        )
      );
      const root = document.createElement("div");
      root.id = "entry-contract-preview";
      root.style.height = "100%";
      document.body.replaceChildren(root);
      new Page({
        title: "Camada 1: contrato de entrada",
        content: [
          new VBox({
            items: [
              new Title({
                text: "Web Client SAP B1",
                level: "H1",
                wrapping: true
              }),
              new MessageStrip({
                text: "PRÉVIA TÉCNICA LOCAL. Não é uma captura do SAP. Tile instalado e abertura da extensão ainda não verificados.",
                type: "Warning",
                showIcon: true
              }).addStyleClass("sapUiSmallMarginTop sapUiSmallMarginBottom"),
              new GenericTile({
                header: tile.text,
                subheader: tile.subtitle,
                pressEnabled: false,
                frameType: "OneByOne",
                tileContent: [
                  new TileContent({
                    content: new ImageContent({ src: tile.icon })
                  })
                ]
              }).addStyleClass("sapUiSmallMarginBottom"),
              new ObjectStatus({
                title: "Fonte",
                text: "WebClientExtension.json gerado"
              }),
              new ObjectStatus({
                title: "Entrada",
                text: "Página inicial da extensão (sem url)"
              }),
              new ObjectStatus({ title: "Método", text: tile.linkmethod }),
              new ObjectStatus({ title: "Tamanho declarado", text: tile.size })
            ]
          }).addStyleClass("sapUiResponsiveContentPadding sapUiMediumMarginTop")
        ]
      }).placeAt(root.id);
    }, descriptor.tiles[0]);
    await page.getByText("PRÉVIA TÉCNICA LOCAL.", { exact: false }).waitFor();
    await page.screenshot({
      path: `docs/navigation/entry-contract-${name}.png`,
      fullPage: true,
      animations: "disabled"
    });
    await page.close();
  }
  assert.deepEqual(blocked, []);
  console.log("Entry descriptor verified; technical previews saved, no SAP connection.");
} finally {
  await browser.close();
}
