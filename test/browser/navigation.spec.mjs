import { test, expect } from "@playwright/test";

let forbidden = [];
test.beforeEach(async ({ page }) => {
  forbidden = [];
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname.startsWith("/b1s/")) {
      forbidden.push(url.href);
      return route.abort();
    }
    return route.continue();
  });
});
test.afterEach(() => expect(forbidden).toEqual([]));

async function inertTile(page, name) {
  const tile = page.getByRole("button", { name });
  expect(
    await tile.evaluate((element) => sap.ui.getCore().byId(element.id).getPressEnabled())
  ).toBe(false);
  const before = page.url();
  await tile.click();
  await tile.press("Enter");
  expect(page.url()).toBe(before);
}

async function capture(page, testInfo, name) {
  await expect
    .poll(() =>
      page.evaluate(
        () => [...document.getAnimations()].filter((a) => a.playState === "running").length
      )
    )
    .toBe(0);
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.activeElement?.blur());
  const activePage = page.locator(".sapMPage:visible");
  await activePage.evaluate((element) => sap.ui.getCore().byId(element.id).scrollTo(0, 0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath(name + ".png"),
    fullPage: true,
    animations: "disabled"
  });
  if (name === "ggf-menu-mobile") {
    await activePage.evaluate((element) => sap.ui.getCore().byId(element.id).scrollTo(9999, 0));
    await page.screenshot({
      path: testInfo.outputPath("ggf-menu-mobile-bottom.png"),
      fullPage: true,
      animations: "disabled"
    });
    await activePage.evaluate((element) => sap.ui.getCore().byId(element.id).scrollTo(0, 0));
  }
}

for (const [device, viewport] of [
  ["desktop", { width: 1440, height: 1000 }],
  ["mobile", { width: 390, height: 844 }]
]) {
  test(`FactoryOne and GGF hierarchy with all functional returns: ${device}`, async ({
    page
  }, testInfo) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize(viewport);
    await page.goto("/index.html?mode=development");
    await expect(page.getByRole("heading", { name: "Módulos", exact: true })).toBeVisible();
    await inertTile(page, /^Industrialização\/Produção Indisponível/);
    await inertTile(page, /^Qualidade Indisponível/);
    await capture(page, testInfo, `factoryone-${device}`);
    await page.getByRole("button", { name: /^GGF / }).click();
    await expect(page).toHaveURL(/#\/ggf$/);
    await expect(page.locator('[id$="ggfFunctions"] .sapMGT')).toHaveCount(5);
    await inertTile(page, /^Custo Indireto Em desenvolvimento/);
    await inertTile(page, /^Relatórios Em desenvolvimento/);
    await capture(page, testInfo, `ggf-menu-${device}`);
    await page.getByRole("button", { name: /^Assistente de fechamento/ }).click();
    await expect(page).toHaveURL(/#\/ggf\/fechamento$/);
    await expect(page.getByText("Etapa 1 de 3", { exact: true })).toBeVisible();
    await capture(page, testInfo, `assistant-${device}`);
    await page.getByRole("button", { name: "Apurar e calcular" }).click();
    await page.getByRole("button", { name: "Avançar" }).click();
    await page.getByRole("button", { name: "Avançar" }).click();
    await expect(page.getByRole("button", { name: "Confirmar contabilização" })).toBeDisabled();
    await page.getByRole("button", { name: "Voltar ao menu GGF" }).click();
    await page.getByRole("button", { name: "Voltar ao FactoryOne" }).click();
    await expect(page.getByRole("heading", { name: "Módulos", exact: true })).toBeVisible();

    await page.getByRole("button", { name: /^GGF / }).click();
    await page.getByRole("button", { name: /^Classificação/ }).click();
    await expect(page).toHaveURL(/#\/ggf\/classificacao$/);
    await expect(page.getByRole("heading", { name: "Classificação", exact: true })).toBeVisible();
    await expect(page.locator('[id$="accounts"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Apurar e calcular" })).toHaveCount(0);
    await capture(page, testInfo, `classifications-${device}`);
    await page.locator('[id$="classifications"]').getByText("FAB", { exact: true }).click();
    const classificationName = page.getByRole("textbox", { name: "Descrição", exact: true });
    await classificationName.fill("Classificação local alterada");
    await expect(page.getByText("Alterações não salvas", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Salvar localmente" }).click();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("factoreone.development.ggf.config.v1")))
      .toContain("Classificação local alterada");
    await page.getByRole("button", { name: "Voltar ao menu GGF" }).click();
    await page.getByRole("button", { name: "Voltar ao FactoryOne" }).click();
    await page.getByRole("button", { name: /^GGF / }).click();
    await page.getByRole("button", { name: /^Rateios/ }).click();
    await expect(page).toHaveURL(/#\/ggf\/rateios$/);
    await expect(page.getByRole("heading", { name: "Rateios", exact: true })).toBeVisible();
    await expect(page.locator('[id$="classifications"]')).toHaveCount(0);
    await expect(page.locator('[id$="accounts"]')).toBeVisible();
    await expect(page.locator('[id$="shares"]')).toBeVisible();
    await capture(page, testInfo, `allocations-${device}`);
    await page.getByRole("button", { name: "Voltar ao menu GGF" }).click();
    await page.getByRole("button", { name: "Voltar ao FactoryOne" }).click();
    await page.getByRole("button", { name: /^GGF / }).click();
    await page.getByRole("button", { name: /^Assistente de fechamento/ }).click();
    await expect(page.getByText("Etapa 1 de 3", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Avançar" })).toBeDisabled();
    await page.getByRole("button", { name: "Apurar e calcular" }).click();
    await expect(page.getByRole("button", { name: "Avançar" })).toBeEnabled();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "GGF", exact: true })).toBeVisible();
    await page.goForward();
    await expect(page.getByText("Etapa 1 de 3", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Avançar" })).toBeDisabled();
    expect(errors).toEqual([]);
  });
}

test("direct function links return to GGF and production mode never enables demo functions", async ({
  page
}) => {
  for (const route of ["classificacao", "rateios", "fechamento"]) {
    await page.goto(`/index.html?mode=development#/ggf/${route}`);
    await page.getByRole("button", { name: "Voltar ao menu GGF" }).click();
    await expect(page).toHaveURL(/#\/ggf$/);
    await page.getByRole("button", { name: "Voltar ao FactoryOne" }).click();
    await expect(page.getByRole("heading", { name: "Módulos", exact: true })).toBeVisible();
  }
  await page.goto("/index.html#/ggf");
  await expect(
    page.getByText("Indisponível: integração SAP não validada", { exact: true }).first()
  ).toBeVisible();
  await inertTile(page, /^Assistente de fechamento/);
  await page.goto("/index.html#/ggf/rateios");
  await expect(page.getByText(/GGF indisponível neste ambiente/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Salvar localmente" })).toHaveCount(0);
});

test("leaving the assistant invalidates pending work before returning to stage one", async ({
  page
}) => {
  await page.goto("/index.html?mode=development#/ggf/fechamento");
  await page.getByRole("button", { name: "Apurar e calcular" }).click();
  await expect(page.getByRole("button", { name: "Avançar" })).toBeEnabled();
  const id = await page.getByRole("button", { name: "Apurar e calcular" }).getAttribute("id");
  await page.evaluate((id) => {
    let view = sap.ui.getCore().byId(id);
    while (typeof view.getController !== "function") view = view.getParent();
    const controller = view.getController();
    const old = controller.session.result;
    controller.session.calculate = () =>
      new Promise((resolve) => {
        window.finishStale = () => resolve(old);
      });
    window.pendingClosing = controller.onCalculate();
  }, id);
  await page.getByRole("button", { name: "Voltar ao menu GGF" }).click();
  await page.getByRole("button", { name: /^Assistente de fechamento/ }).click();
  await page.evaluate(async () => {
    window.finishStale();
    await window.pendingClosing;
  });
  await expect(page.getByText("Etapa 1 de 3", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Avançar" })).toBeDisabled();
  await expect(page.getByText("4000.00", { exact: true })).toHaveCount(0);
});
