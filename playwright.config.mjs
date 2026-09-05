// Smoke test for the static site. Builds it (build.mjs → dist/), serves dist/ with Python's http.server (the same
// files GitHub Pages deploys) and drives it in headless Chromium against the committed feed.json.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/site",
  timeout: 30_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8765",
    headless: true,
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  webServer: {
    command: "node build.mjs && python3 -m http.server -d dist 8765 --bind 127.0.0.1",
    url: "http://127.0.0.1:8765/index.html",
    reuseExistingServer: true,
    timeout: 20_000,
  },
});
