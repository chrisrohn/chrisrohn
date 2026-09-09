// Smoke test for the static site. Builds it (build.mjs → dist/), serves dist/ with Python's http.server (the same
// files GitHub Pages deploys) and drives it in headless Chromium against the committed feed.json.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, chromium } from "@playwright/test";

/** Which Chromium to drive.
 *
 * Playwright downloads a browser build pinned to its own version (`npx playwright install chromium`, which is what
 * CI runs), and that is what this uses whenever it is there. Some environments — a preloaded container, a sandbox
 * with no network — instead ship one Chromium at PLAYWRIGHT_BROWSERS_PATH under a different revision, and every
 * test then fails with "Executable doesn't exist" and no way past it. So: PW_CHROMIUM if it is set, else the pinned
 * build, else the newest full Chromium sitting in that directory. On a machine with none of the three, Playwright's
 * own "run npx playwright install" message is still the answer, and still what you get.
 */
function browserPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  try { if (existsSync(chromium.executablePath())) return undefined; } catch { /* not installed at all: look below */ }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  return readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    .flatMap(d => ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-win/chrome.exe"].map(exe => join(root, d, exe)))
    .find(existsSync);
}
const executablePath = browserPath();

export default defineConfig({
  testDir: "tests/site",
  timeout: 30_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8765",
    headless: true,
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: "node build.mjs && python3 -m http.server -d dist 8765 --bind 127.0.0.1",
    url: "http://127.0.0.1:8765/index.html",
    reuseExistingServer: true,
    timeout: 20_000,
  },
});
