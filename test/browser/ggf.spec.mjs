import { test, expect } from "@playwright/test";

let forbiddenRequests = [];

test.beforeEach(async ({ page }) => {
  forbiddenRequests = [];
  // The browser suite must never contact SAP, even if a regression adds a request.
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname.startsWith("/b1s/")) {
      forbiddenRequests.push(url.href);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
});

test.afterEach(() => expect(forbiddenRequests).toEqual([]));

test("controller clears the entire result and isolates concurrent success, errors and busy", async ({
  page
}) => {
  await page.goto("/index.html?mode=development#/ggf/fechamento");
  await page.getByRole("button", { name: "Apurar e calcular" }).click();
  await expect(page.getByRole("button", { name: "Avançar" })).toBeEnabled();
  const buttonId = await page.getByRole("button", { name: "Apurar e calcular" }).getAttribute("id");
  const states = await page.evaluate(async (buttonId) => {
    let view = sap.ui.getCore().byId(buttonId);
    while (view && typeof view.getController !== "function") view = view.getParent();
    const controller = view.getController();
    const model = view.getModel("ggf");
    const result = controller.session.result;
    const queue = [];
    // Exercise the controller's guard independently of the session's own stale-response guard.
    controller.session.calculate = () =>
      new Promise((resolve, reject) => queue.push({ resolve, reject }));
    const capture = () =>
      Object.fromEntries(
        [
          "busy",
          "calculated",
          "error",
          "step",
          "total",
          "distributed",
          "difference",
          "snapshotId",
          "orders",
          "traces",
          "accountMemory",
          "costComponents",
          "balances",
          "groupBases",
          "criterionTotals"
        ].map((key) => [key, structuredClone(model.getProperty(`/${key}`))])
      );
    const newer = { ...result, snapshot: { ...result.snapshot, id: "LATEST" } };
    const states = {};

    const failed = controller.onCalculate();
    states.clearedOnStart = capture();
    queue.shift().reject(new Error("active failure"));
    await failed;
    states.activeFailure = capture();

    const a = controller.onCalculate();
    const b = controller.onCalculate();
    queue.shift().resolve(result);
    await a;
    states.oldSuccessWhileBusy = capture();
    queue.shift().resolve(newer);
    await b;
    states.latestSuccess = capture();

    const c = controller.onCalculate();
    const d = controller.onCalculate();
    queue.shift().reject(new Error("obsolete failure"));
    await c;
    states.oldErrorWhileBusy = capture();
    queue.shift().resolve(newer);
    await d;

    const e = controller.onCalculate();
    const f = controller.onCalculate();
    const obsoleteError = queue.shift();
    queue.shift().resolve(newer);
    await f;
    obsoleteError.reject(new Error("late obsolete failure"));
    await e;
    states.oldErrorAfterSuccess = capture();

    const g = controller.onCalculate();
    const h = controller.onCalculate();
    const obsoleteSuccess = queue.shift();
    queue.shift().reject(new Error("newest failure"));
    await h;
    obsoleteSuccess.resolve(result);
    await g;
    states.oldSuccessAfterFailure = capture();

    const edited = controller.onCalculate();
    controller.onEdit();
    queue.shift().reject(new Error("failure after edit"));
    await edited;
    states.afterEdit = capture();
    return states;
  }, buttonId);
  const empty = {
    calculated: false,
    step: "1",
    total: "",
    distributed: "",
    difference: "",
    snapshotId: "",
    orders: [],
    traces: [],
    accountMemory: [],
    costComponents: [],
    balances: [],
    groupBases: [],
    criterionTotals: []
  };
  expect(states.clearedOnStart).toMatchObject({
    ...empty,
    busy: true,
    error: ""
  });
  expect(states.activeFailure).toMatchObject({ ...empty, busy: false });
  expect(states.activeFailure.error).toContain("active failure");
  for (const state of [states.oldSuccessWhileBusy, states.oldErrorWhileBusy]) {
    expect(state).toMatchObject({ ...empty, busy: true, error: "" });
  }
  for (const state of [states.latestSuccess, states.oldErrorAfterSuccess]) {
    expect(state).toMatchObject({
      calculated: true,
      busy: false,
      error: "",
      snapshotId: "LATEST",
      total: "4000.00",
      distributed: "4000.00",
      difference: "0.00"
    });
    expect(state.orders).toHaveLength(3);
  }
  expect(states.oldSuccessAfterFailure).toMatchObject({
    ...empty,
    busy: false
  });
  expect(states.oldSuccessAfterFailure.error).toContain("newest failure");
  expect(states.afterEdit).toEqual({ ...empty, busy: false, error: "" });
});

test("local wizard, export, invalid percentages, persistence and stale results", async ({
  page
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/index.html?mode=development#/ggf/fechamento");
  await expect(
    page.getByText("Modo de desenvolvimento | Dados fictícios locais | SAP desconectado")
  ).toBeVisible();
  await page.getByRole("button", { name: "Apurar e calcular" }).click();
  await expect(page.getByRole("button", { name: "Avançar" })).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("periodo-desktop.png"),
    fullPage: true
  });
  await page.getByRole("button", { name: "Avançar" }).click();
  await expect(page.locator('[id$="orderBases"]').getByText("DEV-PROD-A")).toBeVisible();
  await page.getByRole("button", { name: "Avançar" }).click();
  await expect(page.getByRole("button", { name: "Confirmar contabilização" })).toBeDisabled();
  await expect(page.getByText("4000.00", { exact: true })).toHaveCount(2);
  await expect(page.getByText("0.00", { exact: true }).first()).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("distribuicao-desktop.png"),
    fullPage: true
  });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Exportar CSV" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("GGF-DEVELOPMENT-2026-09-01.csv");
  await download.saveAs(testInfo.outputPath(download.suggestedFilename()));
  await page.getByRole("button", { name: "Voltar ao menu GGF" }).click();
  await page.getByRole("button", { name: /^Rateios/ }).click();
  const percentage = page.locator('[id$="shares"]').getByRole("textbox").first();
  await percentage.fill("50");
  await page.getByRole("button", { name: "Validar configuração" }).click();
  await expect(page.getByText(/devem estar entre 0 e 100 e somar exatamente 100%/)).toBeVisible();
  await page.getByRole("button", { name: "Voltar ao menu GGF" }).click();
  await page.getByRole("button", { name: /^Assistente de fechamento/ }).click();
  await expect(page.getByRole("button", { name: "Avançar" })).toBeDisabled();
  await page.getByRole("button", { name: "Apurar e calcular" }).click();
  await expect(page.getByText(/devem estar entre 0 e 100 e somar exatamente 100%/)).toBeVisible();
  await page.getByRole("button", { name: "Voltar ao menu GGF" }).click();
  await page.getByRole("button", { name: /^Rateios/ }).click();
  await percentage.fill("60");
  await page.getByRole("button", { name: "Salvar localmente" }).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("factoreone.development.ggf.config.v1")))
    .toContain('"percent":"60"');
  await page.reload();
  await page.getByRole("button", { name: "Voltar ao menu GGF" }).click();
  await page.getByRole("button", { name: /^Assistente de fechamento/ }).click();
  await page.getByRole("button", { name: "Apurar e calcular" }).click();
  await expect(page.getByRole("button", { name: "Avançar" })).toBeEnabled();
  const start = page.getByRole("textbox", {
    name: "Data inicial",
    exact: true
  });
  const end = page.getByRole("textbox", { name: "Data final", exact: true });
  await start.fill("01/10/2026");
  await start.press("Tab");
  await expect(page.getByRole("button", { name: "Avançar" })).toBeDisabled();
  await end.fill("31/10/2026");
  await end.press("Tab");
  await expect(end).toHaveValue("31/10/2026");
  await page.getByRole("button", { name: "Apurar e calcular" }).click();
  await expect(page.getByText(/Base de rateio indisponível para o período/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Avançar" })).toBeDisabled();
  expect(errors).toEqual([]);
});

test("mobile layout and normal mode remain usable and explicit", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/index.html?mode=development#/ggf/fechamento");
  await page.getByRole("button", { name: "Apurar e calcular" }).click();
  await expect(page.getByRole("button", { name: "Avançar" })).toBeEnabled();
  await page.getByRole("button", { name: "Avançar" }).click();
  await page.screenshot({
    path: testInfo.outputPath("bases-mobile.png"),
    fullPage: true
  });
  await page.getByRole("button", { name: "Avançar" }).click();
  await expect(page.getByRole("button", { name: "Confirmar contabilização" })).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("distribuicao-mobile.png"),
    fullPage: true
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await page.getByRole("button", { name: "Voltar ao menu GGF" }).click();
  await page.getByRole("button", { name: /^Rateios/ }).click();
  await page.screenshot({
    path: testInfo.outputPath("configuracao-mobile.png"),
    fullPage: true
  });
  await page.goto("/index.html#/ggf/fechamento");
  await expect(page.getByText(/GGF indisponível neste ambiente/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Apurar e calcular" })).toHaveCount(0);
});
