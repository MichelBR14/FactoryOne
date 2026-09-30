import { test, expect } from "@playwright/test";

for (const [device, viewport] of [
  ["desktop", { width: 1440, height: 1000 }],
  ["mobile", { width: 390, height: 844 }]
]) {
  test(`account applicability, group basis and visible memory: ${device}`, async ({
    page
  }, testInfo) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if (
        !["localhost", "127.0.0.1"].includes(u.hostname) ||
        u.pathname.startsWith("/b1s/") ||
        u.pathname.startsWith("/__ggf/")
      )
        return route.abort();
      return route.continue();
    });
    await page.setViewportSize(viewport);
    await page.goto("/index.html?mode=development#/ggf/rateios");
    await page.locator('[id$="accounts"]').getByText("DEV-6101", { exact: true }).click();
    await page.getByRole("spinbutton", { name: "Percentual total aplicável (%)" }).fill("25");
    const groupSelect = page.locator('[id$="shares"]').getByRole("combobox").nth(2);
    await groupSelect.press("F4");
    await page.getByRole("option", { name: "Valor de recurso consumido", exact: true }).click();
    await page.getByRole("button", { name: "Salvar localmente" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("factoreone.development.ggf.config.v1"))?.groupShares[0]
              .basis
        )
      )
      .toBe("RESOURCE_VALUE");
    await page.getByRole("button", { name: "Voltar ao menu GGF" }).click();
    await page.getByRole("button", { name: /^Assistente de fechamento/ }).click();
    await page.getByRole("button", { name: "Apurar e calcular" }).click();
    await expect(page.getByRole("button", { name: "Avançar" })).toBeEnabled();
    const id = await page.getByRole("button", { name: "Apurar e calcular" }).getAttribute("id");
    await page.getByRole("button", { name: "Avançar" }).click();
    await page.getByRole("button", { name: "Avançar" }).click();
    await expect(page.getByRole("button", { name: "Confirmar contabilização" })).toBeDisabled();
    const panel = page.locator('[id$="tracePanel"]');
    await panel.getByRole("button").first().click();
    await expect(panel.getByText("Conciliação por conta", { exact: true })).toBeVisible();
    await expect(panel.getByText("Composição do custo direto", { exact: true })).toBeVisible();
    await expect(panel.getByText("Participação da OP (%)").first()).toBeVisible();
    const memory = await page.evaluate((id) => {
      let view = sap.ui.getCore().byId(id);
      while (view && !view.getController) view = view.getParent();
      const m = view.getModel("ggf");
      return {
        accounts: m.getProperty("/accountMemory"),
        total: m.getProperty("/total"),
        traces: m.getProperty("/traces"),
        components: m.getProperty("/costComponents")
      };
    }, id);
    expect(memory.total).toBe("3250.00");
    expect(memory.accounts[0]).toMatchObject({
      percent: "25",
      periodAmount: "1000.00",
      applicableAmount: "250.00",
      difference: "0.00"
    });
    expect(memory.traces.some((t) => t.basisKind === "RESOURCE_VALUE")).toBe(true);
    expect(memory.components).toHaveLength(6);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await expect
      .poll(() =>
        page.evaluate(
          () => document.getAnimations().filter((a) => a.playState === "running").length
        )
      )
      .toBe(0);
    await panel.getByText("Conciliação por conta", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`engine-memory-${device}.png`),
      fullPage: true
    });
    expect(errors).toEqual([]);
  });
}
