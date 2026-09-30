import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["localhost", "127.0.0.1"].includes(url.hostname) && !url.pathname.startsWith("/b1s/")
      ? route.continue()
      : route.abort();
  });
});

async function capture(page, testInfo, name) {
  await expect
    .poll(() =>
      page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length)
    )
    .toBe(0);
  await page.mouse.move(0, 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath(name + ".png"),
    fullPage: true,
    animations: "disabled"
  });
}

for (const [device, viewport] of [
  ["desktop", { width: 1440, height: 1000 }],
  ["mobile", { width: 390, height: 844 }]
]) {
  test(`search, edit, add and delete the selected record: ${device}`, async ({
    page
  }, testInfo) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize(viewport);
    await page.goto("/index.html?mode=development#/ggf/classificacao");
    const classifications = page.locator('[id$="classifications"]');
    const classSearch = page.getByPlaceholder("Buscar classificação", { exact: true });
    await expect(classifications.getByText("FAB", { exact: true })).toBeVisible();
    await capture(page, testInfo, `classifications-list-${device}`);
    await classSearch.fill("inexistente");
    await expect(page.getByText("Nenhum registro encontrado", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Descrição", exact: true })).toHaveCount(0);
    await classSearch.fill("apoio");
    await classifications.getByText("APOIO", { exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Código", exact: true })).toHaveValue("APOIO");
    await capture(page, testInfo, `classifications-detail-${device}`);
    await page.getByRole("textbox", { name: "Descrição", exact: true }).fill("Apoio revisado");
    await page.getByRole("button", { name: "Salvar localmente" }).click();
    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("factoreone.development.ggf.config.v1"))
    );
    expect(saved.classifications).toEqual([
      { id: "FAB", name: "Fabricacao" },
      { id: "APOIO", name: "Apoio revisado" }
    ]);
    if (device === "mobile")
      await page.getByRole("button", { name: "Voltar à lista de classificações" }).click();
    await page.getByRole("button", { name: "Adicionar classificação" }).click();
    await page.getByRole("textbox", { name: "Código", exact: true }).fill("LOCAL");
    await page
      .getByRole("textbox", { name: "Descrição", exact: true })
      .fill("Nova classificação local");
    await page.getByRole("button", { name: "Excluir classificação", exact: true }).click();
    await expect(classifications.getByText("LOCAL", { exact: true })).toHaveCount(0);
    await expect(classifications.getByText("FAB", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Voltar ao menu GGF" }).click();
    await page.getByRole("button", { name: /^Rateios/ }).click();
    const accounts = page.locator('[id$="accounts"]');
    await expect(accounts.getByText("DEV-6101", { exact: true })).toBeVisible();
    await capture(page, testInfo, `allocations-list-${device}`);
    await page.getByPlaceholder("Buscar conta ou classificação").fill("6104");
    await accounts.getByText("DEV-6104", { exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Conta", exact: true })).toHaveValue("DEV-6104");
    await expect(page.getByRole("combobox", { name: "Classificação", exact: true })).toHaveText(
      "Apoio revisado"
    );
    await capture(page, testInfo, `allocations-detail-${device}`);
    await page.locator('[id$="accountCriterion"]').click();
    for (const name of [
      "Absorção por Custo Direto",
      "Quantidade produzida",
      "Horas apontadas",
      "Distribuição por Grupo de Recurso"
    ])
      await expect(page.getByRole("option", { name, exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("textbox", { name: "Descrição", exact: true }).fill("Manutenção revisada");
    await page.getByRole("button", { name: "Salvar localmente" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("factoreone.development.ggf.config.v1")).accounts[3]
              .name
        )
      )
      .toBe("Manutenção revisada");
    if (device === "mobile")
      await page.getByRole("button", { name: "Voltar à lista de contas" }).click();
    await page.getByRole("button", { name: "Adicionar conta", exact: true }).click();
    await page.getByRole("textbox", { name: "Conta", exact: true }).fill("LOCAL-TEST");
    await page.getByRole("button", { name: "Excluir conta", exact: true }).click();
    await expect(accounts.getByText("LOCAL-TEST", { exact: true })).toHaveCount(0);
    await expect(accounts.getByText("DEV-6101", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Salvar localmente" }).click();
    const final = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("factoreone.development.ggf.config.v1"))
    );
    expect(final.classifications).toHaveLength(2);
    expect(final.accounts).toHaveLength(4);
    expect(final.accounts[0].name).toBe("Energia");
    expect(final.accounts[3].name).toBe("Manutenção revisada");
    expect(final.groupShares.map((s) => s.percent)).toEqual(["60", "40"]);
    expect(errors).toEqual([]);
  });
}
