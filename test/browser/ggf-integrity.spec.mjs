import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";

// Controlled UI evidence only. No POSTED record in SAP is read or altered by these cases.
const scenarios = [
  { label: "not-applicable", id: "F1TECHDRAFT", status: "NOT_APPLICABLE", closingStatus: "DRAFT",
    version: 1, sapDocEntry: null, sapDocNum: null, sapTransId: null },
  { label: "posted-valid", id: "F1TESTPOSTED", status: "VALID", closingStatus: "POSTED",
    version: 6, sapDocEntry: 25, sapDocNum: 5, sapTransId: 2278 },
  { label: "posted-violation", id: "F1TESTALTERED", status: "INTEGRITY_VIOLATION", closingStatus: "POSTED",
    version: 6, sapDocEntry: 25, sapDocNum: 5, sapTransId: 2278 },
  { label: "reopened-valid", id: "F1TESTREOPENED", status: "VALID", closingStatus: "REOPENED",
    version: 7, sapDocEntry: 25, sapDocNum: 5, sapTransId: 2278 }
];

for (const width of [1440, 390]) test(`closing integrity states and read-only details: ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.route("**/__ggf/closing-integrity?*", route => {
    expect(route.request().method()).toBe("GET");
    expect(route.request().headers()["x-factoryone-read"]).toBe("1");
    const id = new URL(route.request().url()).searchParams.get("closingId");
    const fixture = scenarios.find(item => item.id === id);
    expect(fixture).toBeDefined();
    return route.fulfill({ json: { ...fixture, closingId: fixture.id,
      detectedAt: "2026-09-28T15:00:00Z", originalHash: "a".repeat(64),
      persistedHash: "b".repeat(64), recalculatedHash: "c".repeat(64),
      divergentFields: fixture.status === "INTEGRITY_VIOLATION" ? ["Lines/content"] : [] } });
  });
  await page.goto("/index.html?mode=development&source=sap-read#/ggf/fechamento");
  const field = page.getByRole("textbox", { name: "ClosingId" });
  const inspect = page.getByRole("button", { name: "Verificar integridade" });
  const facts = page.locator('[id$="integrityFacts"]');
  await expect(field).toBeVisible();
  await expect(page.getByText("Integridade não aplicável")).toBeVisible();
  await expect(page.getByRole("button", { name: "Avançar" })).toBeDisabled();
  await mkdir(".local/ggf/visual", { recursive: true });

  for (const scenario of scenarios) {
    await field.fill(scenario.id);
    await inspect.click();
    await expect(facts.getByText(scenario.id, { exact: true })).toBeVisible();
    await expect(facts.getByText(scenario.closingStatus, { exact: true })).toBeVisible();
    await expect(facts.getByText(String(scenario.version), { exact: true })).toBeVisible();
    if (scenario.status === "VALID") {
      await expect(page.getByText("Integridade verificada")).toBeVisible();
      await expect(page.getByText("Fechamento alterado após contabilização. Operação bloqueada.")).toBeHidden();
    } else if (scenario.status === "INTEGRITY_VIOLATION") {
      await expect(page.getByText("Integridade violada")).toBeVisible();
      await expect(page.getByText("Fechamento alterado após contabilização. Operação bloqueada.")).toBeVisible();
      await expect(page.getByText("DocEntry 25 / DocNum 5")).toBeVisible();
      await expect(page.getByText(/28\/09\/2026/)).toBeVisible();
    } else {
      await expect(page.getByText("Integridade não aplicável")).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Avançar" })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.getByText("a".repeat(64)).count()).toBe(0);
    await page.screenshot({ path: `.local/ggf/visual/ggf-integrity-${scenario.label}-${width}.png` });
  }
});

test("metadata unavailable blocks closing inspection and a later retry can recover", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let reads = 0;
  await page.route("**/__ggf/closing-integrity?*", route => {
    reads++;
    return route.fulfill(reads === 1
      ? { status: 503, json: { code: "SAP_METADATA_UNAVAILABLE", postingBlocked: true } }
      : { json: { closingId: "F1HL260929F", version: 2, status: "NOT_APPLICABLE",
        closingStatus: "CALCULATED", sapDocEntry: null, sapDocNum: null,
        detectedAt: "2026-09-29T16:00:00Z", divergentFields: [] } });
  });
  await page.goto("/index.html?mode=development&source=sap-read#/ggf/fechamento");
  await page.getByRole("textbox", { name: "ClosingId" }).fill("F1HL260929F");
  const inspect = page.getByRole("button", { name: "Verificar integridade" });
  await inspect.click();
  await expect(page.getByText("Metadados SAP indisponíveis")).toBeVisible();
  await expect(page.getByText(/UDO de versões do fechamento/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Avançar" })).toBeDisabled();
  await expect(inspect).toBeEnabled();
  await mkdir(".local/ggf/visual", { recursive: true });
  await page.screenshot({ path: ".local/ggf/visual/ggf-metadata-unavailable-390.png" });
  await inspect.click();
  await expect(page.getByText("Integridade não aplicável")).toBeVisible();
  await expect(page.getByText("Metadados SAP indisponíveis")).toBeHidden();
  expect(reads).toBe(2);
});
