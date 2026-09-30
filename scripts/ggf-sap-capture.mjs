import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

// Explicit manual real-read check, not part of the offline test suite. No traces or HAR.
await mkdir(".local/ggf", { recursive: true, mode: 0o700 });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", () => errors.push("browser error"));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.origin === "http://localhost:8082" && !url.pathname.startsWith("/b1s/")
      ? route.continue()
      : route.abort();
  });
  await page.goto(
    "http://localhost:8082/index.html?mode=development&source=sap-read#/ggf/fechamento",
    { waitUntil: "domcontentloaded", timeout: 90000 }
  );
  const read = page.getByRole("button", { name: "Conferir fontes SAP" });
  await read.waitFor({ timeout: 90000 });
  const responsePromise = page.waitForResponse((r) => r.url().includes("/__ggf/read?"), {
    timeout: 180000
  });
  await read.click();
  const response = await responsePromise;
  if (!response.ok()) throw new Error("Real read failed");
  await page.locator('[id$="sapReads"]').getByText("ProductionOrders").waitFor({ timeout: 30000 });
  if (await page.getByRole("button", { name: "Avançar" }).isEnabled())
    throw new Error("Unexpected allocation enabled");
  for (const [name, width, height] of [
    ["desktop", 1440, 1000],
    ["mobile", 390, 844]
  ]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `.local/ggf/sap-read-${name}.png` });
    await page.locator('[id$="sapReads"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.local/ggf/sap-sources-${name}.png` });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error("Horizontal overflow");
  }
  console.log(
    JSON.stringify({ realRead: true, desktop: true, mobile: true, advanceBlocked: true, errors })
  );
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
