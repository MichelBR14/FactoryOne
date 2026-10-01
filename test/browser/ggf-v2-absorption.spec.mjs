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
  },
  distribution: {
    technicalHomologation: true,
    totalDifferenceCents: "-916600", totalAllocatedCents: "-616600", residualCents: "-300000",
    warnings: ["Tarifa atual sem histórico mensal comprovado."],
    categories: [
      { category: "MOD", criterion: "DIRECT_COST", status: "BLOCKED_NO_ACCOUNT", differenceCents: "-300000", allocatedCents: "0", residualCents: "-300000", blocker: "Nenhuma conta real foi mapeada explicitamente para MOD." },
      { category: "GGF", criterion: "DIRECT_COST", status: "CALCULATED_TECHNICAL", differenceCents: "-616600", allocatedCents: "-616600", residualCents: "0", blocker: "" }
    ],
    orders: [{ orderNumber: "76", item: "C00003", itemDescription: "Produto", producedQuantity: "1", quantityUnit: "UN", standardModCents: "300000", standardGgfCents: "150000", modAdjustmentCents: "0", ggfAdjustmentCents: "-616600", totalAdjustmentCents: "-616600", originalCostCents: "550058", costAfterAbsorptionCents: "-66542", bases: [{ category: "GGF", criterion: "DIRECT_COST", group: "", base: "550058", totalBase: "571823", basisUnit: "SAP_LOCAL", basisDecimals: 2, participationPercent: "96.19", amountCents: "-616600", roundingMinor: "0", sourceRefs: ["203", "77/0"] }], directCostComponents: [] }]
  },
  stockConsumption: {
    currency: "R$", currencySource: "CompanyService_GetAdminInfo.LocalCurrency",
    orders: [{ orderNumber: "76", item: "C00003", producedQuantity: "1", ggfAdjustmentCents: "-616600", modAdjustmentCents: "0",
      valuationMethod: "bis_MovingAverage", unit: "UN", quantityOnStock: 0,
      accountingDetermination: { origin: "SAP_ADVANCED_GL_ACCOUNT_DETERMINATION", inventoryAccount: null, verified: false, refs: ["Items.GLMethod", "Warehouses.StockAccount"] },
      warehouses: [{ code: "01", quantity: 0, available: 0 }], status: "BLOCKED_AMBIGUOUS_TRACE",
      reason: "Saldo atual agregado; saídas posteriores não reconciliadas." }],
    fifoScenario: { origin: "sap", technicalOnly: true, status: "FIFO_PARTIALLY_CONSUMED", order: "83", item: "F1GGF26P01", unit: "UN",
      produced: "10.000000", consumed: "6.000000", remaining: "4.000000",
      receipt: { docEntry: 122, docNum: 77, line: 0, date: "2026-09-29", quantity: 10 },
      issues: [{ docEntry: 90, docNum: 40, line: 0, date: "2026-09-29", quantity: 6 }],
      calculation: { status: "STOCK_REVALUATION_CANDIDATE", totalStockCents: "4000", totalConsumedCents: "6000", reason: "Rastreio FIFO reconciliado; CPV pendente de regra." },
      example: { ggfTotalMinor: "10000" },
      payload: null }
  }
};

for (const width of [1440, 390]) test(`GGF V2 reconciliation read-only at ${width}px`, async ({ page }) => {
  const errors = [];
  let savedPlan = null;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width, height: 900 });
  await page.route("**/__ggf/v2/distribution?*", (route) => {
    expect(route.request().method()).toBe("GET");
    expect(route.request().headers()["x-factoryone-read"]).toBe("1");
    return route.fulfill({ json: response });
  });
  await page.route("**/__ggf/v2/posting-plan**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      expect(request.headers()["x-factoryone-read"]).toBe("1");
      return route.fulfill({ json: { source: "SAP", integrityVerified: true, versions: savedPlan ? [savedPlan] : [], latest: savedPlan } });
    }
    expect(request.url()).toMatch(/\/__ggf\/v2\/posting-plan\/persist$/);
    expect(request.method()).toBe("POST");
    expect(request.headers()["x-factoryone-plan-write"]).toBe("1");
    const draft = request.postDataJSON();
    expect(draft.status).toBe("BLOCKED");
    expect(draft.postingBlocked).toBe(true);
    expect(draft.documents.every((document) => document.payload === null)).toBe(true);
    savedPlan = { ...draft, version: 1, createdAt: "2026-09-30T20:00:00.000Z", postingHash: "a".repeat(64) };
    return route.fulfill({ json: { source: "SAP", integrityVerified: true, versions: [savedPlan], latest: savedPlan } });
  });
  const executionId = `F1EX${"b".repeat(40)}`;
  await page.route("**/__ggf/v2/execution?*", (route) => {
    expect(route.request().method()).toBe("GET");
    expect(route.request().headers()["x-factoryone-read"]).toBe("1");
    return route.fulfill({ json: { source: "SAP", integrityVerified: true, execution: {
      executionId, identity: { closingId: "TECH_LEDGER", closingVersion: 2, postingPlanVersion: 1,
        postingHash: "c".repeat(64) }, status: "POSTING_UNCERTAIN", startedAt: "2026-10-01T10:00:00Z",
      totalExpected: "30000", totalPosted: "10000", totalReconciled: "10000", documents: [
        { sequence: 1, documentType: "MaterialRevaluation", plannedAmount: "10000", currency: "BRL",
          status: "RECONCILED", attemptCount: 1, requestHash: "d".repeat(64), sapDocEntry: 22, sapDocNum: 23,
          sapTransId: 24, reconciliationStatus: "MATCHED", sanitizedError: null },
        { sequence: 2, documentType: "JournalEntry.CPV", plannedAmount: "10000", currency: "BRL",
          status: "UNCERTAIN", attemptCount: 1, requestHash: "e".repeat(64), sapDocEntry: null, sapDocNum: null,
          sapTransId: null, reconciliationStatus: "NO_MATCH", sanitizedError: "RECONCILIATION_NOT_UNIQUE" },
        { sequence: 3, documentType: "JournalEntry.Closing", plannedAmount: "10000", currency: "BRL",
          status: "PENDING", attemptCount: 0, requestHash: null, sapDocEntry: null, sapDocNum: null,
          sapTransId: null, reconciliationStatus: "NOT_RUN", sanitizedError: null }
      ] } } });
  });
  await page.goto("/index.html?mode=development&source=sap-read#/ggf/fechamento");
  await page.getByRole("button", { name: "GGF V2 / Apuração" }).click();
  await expect(page).toHaveURL(/#\/ggf\/v2\/apuracao$/);
  await page.locator("textarea").first().fill(JSON.stringify({
    accounts: [{ account: "4.01.01.04.07", category: "GGF" }],
    resources: [{ resource: "R300007", component: 1, category: "MOD" }, { resource: "R300007", component: 2, category: "GGF" }],
    technicalHomologation: true
  }));
  await page.getByRole("button", { name: "Consultar e conciliar" }).click();
  await expect(page.getByText("Homologação técnica", { exact: true })).toBeVisible();
  await expect(page.getByText("R$ -4.666,00").or(page.getByText("-R$ 4.666,00"))).toBeVisible();
  await expect(page.getByText("Conta técnica")).toBeVisible();
  await expect(page.getByText("5. Estoque x Consumido")).toBeVisible();
  await expect(page.getByText("Rastreio ambíguo")).toBeVisible();
  await expect(page.getByText("Cenário FIFO técnico independente · OP 83")).toBeVisible();
  await page.getByText("Cenário FIFO técnico independente · OP 83").click();
  await expect(page.getByText("R$ 40,00")).toBeVisible();
  await expect(page.getByText("R$ 60,00")).toBeVisible();
  await expect(page.getByText("Consumo sem classificação contábil")).toBeVisible();
  await expect(page.getByText("6. Prévia Contábil")).toBeVisible();
  await expect(page.getByText("7. Plano de Contabilização")).toBeVisible();
  await expect(page.getByText("Bloqueado", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("Ordem 2 · JournalEntry.CPV", { exact: true })).toBeVisible();
  await expect(page.getByText(/não cria claim nem documento financeiro/)).toBeVisible();
  await expect(page.getByText("Prévia técnica somente leitura. Não cria MaterialRevaluation nem Journal Entry.")).toBeVisible();
  await page.getByText("A. Estoque · MaterialRevaluation").click();
  await expect(page.getByText("Payload", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("null", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("SAP_ADVANCED_GL_ACCOUNT_DETERMINATION · não resolvida")).toBeVisible();
  await expect(page.getByText("R$ -9.166,00").or(page.getByText("-R$ 9.166,00")).first()).toBeVisible();
  await expect(page.getByText("Tarifa atual sem histórico mensal comprovado.").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Dados fictícios locais");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expect(page.getByText("7. Plano de Contabilização")).toBeVisible();
  await expect(page.getByText("Hash funcional conferido na releitura; disponível na auditoria técnica.")).toBeVisible();
  await expect(page.getByText(/Hash conferido após releitura SAP/)).toBeVisible();
  await expect(page.getByText("Bloqueado", { exact: true }).last()).toBeVisible();
  await page.locator("#executionIdInput-inner").fill(executionId);
  await page.getByRole("button", { name: "Consultar SAP" }).click();
  await expect(page.getByText("Resultado da contabilização precisa ser reconciliado antes de continuar.")).toBeVisible();
  await expect(page.getByText("Incerto; exige conciliação")).toBeVisible();
  await expect(page.getByText("22 / 23 / 24")).toBeVisible();
  await page.getByRole("button", { name: "Voltar ao menu GGF" }).last().click();
  await expect(page).toHaveURL(/#\/ggf$/);
  expect(errors).toEqual([]);
});
