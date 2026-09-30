import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["localhost", "127.0.0.1"].includes(url.hostname) && !url.pathname.startsWith("/b1s/")
      ? route.continue()
      : route.abort("blockedbyclient");
  });
});

async function assertLayout(page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.getAnimations().filter((animation) => animation.playState === "running").length
      )
    )
    .toBe(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const page = document.querySelector(".ggfPage");
        const boxes = [
          ...page.querySelectorAll("input, button, .sapMTitle, .sapMText, .sapMObjectNumber")
        ]
          .map((e) => ({ text: e.textContent, rect: e.getBoundingClientRect() }))
          .filter(({ rect: r }) => r.width && r.height);
        return boxes.filter(({ rect: r }) => r.left < -1 || r.right > innerWidth + 1);
      })
    )
    .toEqual([]);
  const footer = await page.locator(".ggfPage footer").boundingBox();
  expect(footer.y + footer.height).toBeLessThanOrEqual(page.viewportSize().height + 1);
}

for (const [name, viewport, theme] of [
  ["desktop", { width: 1440, height: 1000 }, "sap_horizon"],
  ["mobile", { width: 390, height: 844 }, "sap_horizon"],
  ["mobile-cozy", { width: 390, height: 844 }, "sap_horizon"],
  ["dark", { width: 1440, height: 1000 }, "sap_horizon_dark"],
  ["contrast", { width: 1440, height: 1000 }, "sap_horizon_hcb"]
]) {
  test(`Horizon layout, navigation and evidence: ${name}`, async ({ page }, testInfo) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.setViewportSize(viewport);
    await page.goto("/index.html?mode=development#/ggf/fechamento");
    await expect(page.getByRole("button", { name: "Apurar e calcular" })).toBeVisible();
    await page.evaluate(
      async ({ theme, mobile }) => {
        if (mobile) {
          document.body.classList.remove("sapUiSizeCompact");
          document.body.classList.add("sapUiSizeCozy");
        }
        const core = sap.ui.getCore();
        if (core.getConfiguration().getTheme() !== theme) {
          await new Promise((resolve) => {
            const changed = () => {
              core.detachThemeChanged(changed);
              resolve();
            };
            core.attachThemeChanged(changed);
            core.applyTheme(theme);
          });
        }
      },
      { theme, mobile: name === "mobile-cozy" }
    );
    await expect(page.getByRole("button", { name: "Avançar" })).toBeDisabled();
    await expect(page.getByText("Etapa 1 de 3", { exact: true })).toBeVisible();
    await expect(page.getByRole("tablist")).toHaveCount(0);
    await assertLayout(page);
    await page.screenshot({
      path: testInfo.outputPath(`after-initial-${name}.png`),
      fullPage: true
    });
    await page.getByRole("button", { name: "Apurar e calcular" }).click();
    await expect(page.getByRole("button", { name: "Avançar" })).toBeEnabled();
    await expect(page.locator('[id$="criterionSummary"] .ggfMetric')).toHaveCount(4);
    await assertLayout(page);
    await page.screenshot({
      path: testInfo.outputPath(`after-period-${name}.png`),
      fullPage: true
    });
    await page.getByRole("button", { name: "Avançar" }).click();
    await expect(page.getByText("Etapa 2 de 3", { exact: true })).toBeVisible();
    if (name === "desktop") {
      const progress = page.getByRole("navigation", {
        name: "Barra de progresso do assistente"
      });
      await progress
        .getByRole("listitem", {
          name: "Etapa 1 Período de apuração Ativa",
          exact: true
        })
        .press("Enter");
      await expect(page.getByText("Etapa 1 de 3", { exact: true })).toBeVisible();
      await progress
        .getByRole("listitem", {
          name: "Etapa 2 Custos por Ordem Ativa",
          exact: true
        })
        .press("Enter");
      await expect(page.getByText("Etapa 2 de 3", { exact: true })).toBeVisible();
    }
    await expect(page.locator('[id$="orderBases"]').getByText("DEV-PROD-A")).toBeVisible();
    await expect(page.getByRole("button", { name: "Exportar CSV" })).toBeVisible();
    await assertLayout(page);
    await page.screenshot({
      path: testInfo.outputPath(`after-orders-${name}.png`),
      fullPage: true
    });
    await page.getByRole("button", { name: "Avançar" }).click();
    await expect(page.getByText("Etapa 3 de 3", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirmar contabilização" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Exportar CSV" })).toBeVisible();
    await assertLayout(page);
    await page.screenshot({
      path: testInfo.outputPath(`after-distribution-${name}.png`),
      fullPage: true
    });
    await page.locator('[id$="tracePanel"] .sapMPanelWrappingDiv').click();
    await expect(page.locator('[id$="traceTable"]')).toBeVisible();
    await expect(page.locator('[id$="traceTable"] tbody tr').first()).toBeVisible();
    await page.getByRole("button", { name: "Voltar ao menu GGF" }).click();
    await page.getByRole("button", { name: /^Rateios/ }).click();
    await expect(page.getByText("Etapa 3 de 3", { exact: true })).toHaveCount(0);
    await assertLayout(page);
    await page.screenshot({
      path: testInfo.outputPath(`after-configuration-${name}.png`),
      fullPage: true
    });
    await page.getByRole("button", { name: "Voltar ao menu GGF" }).click();
    await page.getByRole("button", { name: /^Classificação/ }).click();
    await expect(page.locator('[id$="classifications"]')).toBeVisible();
    await expect(page.locator('[id$="accounts"]')).toHaveCount(0);
    await assertLayout(page);
    await page.getByRole("button", { name: "Voltar ao menu GGF" }).click();
    await page.getByRole("button", { name: /^Assistente de fechamento/ }).click();
    await expect(page.getByText("Etapa 1 de 3", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Avançar" })).toBeDisabled();
    await page.getByRole("button", { name: "Apurar e calcular" }).click();
    await page.getByRole("button", { name: "Avançar" }).click();
    await expect(page.locator('[id$="orderBases"]')).toBeVisible();
    await page
      .getByRole("toolbar", { name: "Ações de rodapé" })
      .getByRole("button", { name: "Voltar", exact: true })
      .click();
    await page.getByRole("textbox", { name: "Data inicial", exact: true }).fill("01/10/2026");
    await page.getByRole("textbox", { name: "Data inicial", exact: true }).press("Tab");
    await expect(page.getByRole("button", { name: "Avançar" })).toBeDisabled();
    await expect(page.getByText("Etapa 1 de 3", { exact: true })).toBeVisible();
    if (name === "desktop") {
      await expect(
        page.getByRole("listitem", {
          name: "Etapa 2 Custos por Ordem Inativa",
          exact: true
        })
      ).toBeVisible();
    }
    if (name.startsWith("mobile")) {
      await page.setViewportSize({ width: 320, height: 720 });
      await assertLayout(page);
      await page.getByRole("button", { name: "Voltar ao menu GGF" }).click();
      await page.getByRole("button", { name: /^Rateios/ }).click();
      await assertLayout(page);
    }
    expect(errors).toEqual([]);
  });
}
