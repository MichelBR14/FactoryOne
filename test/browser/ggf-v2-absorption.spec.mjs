import { test, expect } from "@playwright/test";

const response = {
  source: {
    company: "SBODEMOBR2", capturedAt: "2026-09-30T12:00:00Z",
    filter: { start: "2026-09-01", end: "2026-09-30", branch: "", dimensions: ["", "", "", "", ""] }
  },
  report: {
    technicalHomologation: true,
    reconciliation: [
      { category: "MOD", realCents: "0", absorbedCents: "300000", differenceCents: "-300000", status: "OVERABSORPTION" },
      { category: "GGF", realCents: "-466600", absorbedCents: "150000", differenceCents: "-616600", status: "OVERABSORPTION" }
    ],
    accounts: [{ account: "4.01.01.04.07", accountName: "Conta técnica", category: "GGF", entries: [{ transId: "2254", document: "JE 2254", date: "2026-09-28", lineId: "2", debitCents: "0", creditCents: "450000", branch: "1", dimensions: ["", "", "", "", ""] }] }],
    resources: [{ resource: "R300007", description: "Recurso", producedItem: "C00003", itemDescription: "Produto", category: "MOD", component: 1, unit: "horas", quantityMicros: "1000000", unitCostCents: "300000", amountCents: "300000", movementCostCents: "450000", order: "76", document: "30", date: "2026-09-28" }],
    resourceCatalog: [{ resource: "R300007", description: "Recurso", type: "rtLabor", unit: "horas", evidence: "current master", components: [{ component: 1, unitCostCents: "300000" }] }],
    statuses: ["Homologação técnica", "Base indisponível"],
    completeness: [{ source: "JournalEntries", received: 90, expected: 90, control: "count" }],
    blockers: ["Tarifa atual sem histórico mensal comprovado."]
  }
};

for (const width of [1440, 390]) test(`GGF V2 reconciliation read-only at ${width}px`, async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width, height: 900 });
  await page.route("**/__ggf/v2/absorption?*", (route) => {
    expect(route.request().method()).toBe("GET");
    expect(route.request().headers()["x-factoryone-read"]).toBe("1");
    return route.fulfill({ json: response });
  });
  await page.goto("/index.html?mode=development&source=sap-read#/ggf/fechamento");
  await page.getByRole("button", { name: "GGF V2 / Apuração" }).click();
  await expect(page).toHaveURL(/#\/ggf\/v2\/apuracao$/);
  await page.locator("textarea").fill(JSON.stringify({
    accounts: [{ account: "4.01.01.04.07", category: "GGF" }],
    resources: [{ resource: "R300007", component: 1, category: "MOD" }, { resource: "R300007", component: 2, category: "GGF" }],
    technicalHomologation: true
  }));
  await page.getByRole("button", { name: "Consultar e conciliar" }).click();
  await expect(page.getByText("Homologação técnica", { exact: true })).toBeVisible();
  await expect(page.getByText("R$ -4.666,00").or(page.getByText("-R$ 4.666,00"))).toBeVisible();
  await expect(page.getByText("Conta técnica")).toBeVisible();
  await expect(page.getByText("Tarifa atual sem histórico mensal comprovado.")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Dados fictícios locais");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Voltar ao menu GGF" }).last().click();
  await expect(page).toHaveURL(/#\/ggf$/);
  expect(errors).toEqual([]);
});
