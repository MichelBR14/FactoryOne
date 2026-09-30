import { test, expect } from "@playwright/test";

// Entirely simulated contract response. This suite never contacts SAP or the real gateway.
const report = {
  origin: "sap",
  company: "SBODEMOBR2",
  allocationReady: false,
  postingBlocked: true,
  filter: { start: "2026-09-01", end: "2026-09-30", branch: "", costCenter: "" },
  capturedAt: "TEST RESPONSE",
  reads: [{ entity: "ProductionOrders", pages: 1, rows: 0, count: 0 }],
  journal: { debit: "0.000000", credit: "0.000000", difference: "0.000000" },
  differences: [],
  accounts: [],
  blockers: ["TEST: Nenhuma ordem de producao disponivel."]
};
test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "localhost" || url.port !== "8081" || url.pathname.startsWith("/b1s/"))
      return route.abort();
    if (url.pathname === "/__ggf/read") {
      expect(route.request().headers()["x-factoryone-read"]).toBe("1");
      return route.fulfill({ json: report });
    }
    return route.continue();
  });
});
for (const width of [1440, 390])
  test(`explicit SAP read mode isolates fixtures at ${width}px`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/index.html?mode=development&source=sap-read");
    await page.getByRole("button", { name: /^GGF/ }).click();
    const classification = page.getByRole("button", { name: /^Classificação/ });
    await expect(classification).toContainText("Indisponível");
    await classification.click();
    await expect(page).toHaveURL(/#\/ggf$/);
    await page.getByRole("button", { name: /^Assistente de fechamento/ }).click();
    await expect(page.getByText(/leitura real da SBODEMOBR2/)).toBeVisible();
    await expect(page.getByText(/Dados fictícios locais/)).toHaveCount(0);
    await page.getByRole("button", { name: "Conferir fontes SAP" }).click();
    await expect(page.getByText(/TEST: Nenhuma ordem/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Avançar" })).toBeDisabled();
    await expect(page.locator('[id$="sapReads"]').getByText("ProductionOrders")).toBeVisible();
    expect(
      await page.evaluate(() => localStorage.getItem("factoreone.development.ggf.config.v1"))
    ).toBeNull();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page.getByRole("textbox", { name: "Data inicial", exact: true }).fill("01/07/2026");
    await page.getByRole("textbox", { name: "Data inicial", exact: true }).press("Tab");
    await expect(page.getByText("TEST RESPONSE")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

test("SAP gateway failure never falls back to demo data", async ({ page }) => {
  await page.route("**/__ggf/read?*", (route) =>
    route.fulfill({ status: 502, json: { error: "Test outage" } })
  );
  await page.goto("/index.html?mode=development&source=sap-read#/ggf/fechamento");
  await page.getByRole("button", { name: "Conferir fontes SAP" }).click();
  await expect(page.getByText(/Leitura real indisponível/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Avançar" })).toBeDisabled();
  await expect(page.getByText("DEV-PROD-A")).toHaveCount(0);
});

test("rejects a diagnostic report from the previous company", async ({ page }) => {
  await page.route("**/__ggf/read?*", route => route.fulfill({ json: { ...report, company: "SBO_DEMO_ECOMMERCE" } }));
  await page.goto("/index.html?mode=development&source=sap-read#/ggf/fechamento");
  await page.getByRole("button", { name: "Conferir fontes SAP" }).click();
  await expect(page.getByText(/Leitura real indisponível/)).toBeVisible();
  await expect(page.getByText("TEST RESPONSE")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Avançar" })).toBeDisabled();
});

test("SAP read revisions isolate stale errors and clear the diagnostic report", async ({ page }) => {
  await page.goto("/index.html?mode=development&source=sap-read#/ggf/fechamento");
  const button = page.getByRole("button", { name: "Conferir fontes SAP" });
  await button.waitFor();
  const id = await button.getAttribute("id");
  const states = await page.evaluate(async ({ id, report }) => {
    let view = sap.ui.getCore().byId(id);
    while (view && typeof view.getController !== "function") view = view.getParent();
    const controller = view.getController(), model = view.getModel("ggf");
    const original = window.fetch, queue = [];
    window.fetch = () => new Promise((resolve, reject) => queue.push({ resolve, reject }));
    const capture = () => ({ busy: model.getProperty("/busy"), report: model.getProperty("/sapReport"), error: model.getProperty("/error"), calculated: model.getProperty("/calculated") });
    try {
      const older = controller.onCalculate(), latest = controller.onCalculate();
      queue.shift().reject(new Error("obsolete"));
      await older;
      const whileBusy = capture();
      queue.shift().resolve(new Response(JSON.stringify(report), { headers: { "Content-Type": "application/json" } }));
      await latest;
      const success = capture();
      const failed = controller.onCalculate();
      const cleared = capture();
      queue.shift().reject(new Error("active read failure"));
      await failed;
      return { whileBusy, success, cleared, failed: capture() };
    } finally { window.fetch = original; }
  }, { id, report });
  expect(states.whileBusy).toEqual({ busy: true, report: null, error: "", calculated: false });
  expect(states.success.report).toEqual(report);
  expect(states.cleared).toEqual({ busy: true, report: null, error: "", calculated: false });
  expect(states.failed).toMatchObject({ busy: false, report: null, calculated: false });
  expect(states.failed.error).toContain("active read failure");
});
