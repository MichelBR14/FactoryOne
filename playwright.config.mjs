import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  testDir: "./test/browser",
  outputDir: join(tmpdir(), "factoryone-browser-results"),
  timeout: 90000,
  expect: { timeout: 30000 },
  workers: 1,
  use: { baseURL: "http://localhost:8081", viewport: { width: 1440, height: 1000 }, screenshot: "only-on-failure" },
  webServer: { command: "npm start -- --port 8081", url: "http://localhost:8081/index.html", reuseExistingServer: true, timeout: 240000 }
});
