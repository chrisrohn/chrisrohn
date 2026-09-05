// Captures the manifest screenshots (the pictures Chrome and Android show in the install dialog) from the built
// site in dist/: two phone views (deck and list) and one desktop view. Run `npm run screenshots` after a visible
// redesign; it starts its own static server on port 8766. Artwork that cannot be fetched (no network) is replaced
// by a neutral grid tile in the site's own colours so the pictures never show a broken-image glyph.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PORT = 8766, BASE = `http://127.0.0.1:${PORT}`, OUT = "site/screenshots";
if (!existsSync("dist/index.html")) { console.error("run `npm run build` first"); process.exit(1); }
const server = spawn("python3", ["-m", "http.server", "-d", "dist", String(PORT), "--bind", "127.0.0.1"], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 800));
const TILE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="#dcd8ce"/><path stroke="#141412" stroke-opacity=".18" d="M0 24h96M0 48h96M0 72h96M24 0v96M48 0v96M72 0v96"/></svg>`;
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });

/** @param {string} name @param {object} ctxOpts @param {(page: import("@playwright/test").Page) => Promise<void>} [prep] */
async function shoot(name, ctxOpts, prep) {
  const ctx = await browser.newContext({ colorScheme: "light", serviceWorkers: "block", ...ctxOpts });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, async route => {
    if (route.request().resourceType() !== "image") return route.abort();
    try { const r = await route.fetch({ timeout: 4000 }); await route.fulfill({ response: r }); }
    catch { await route.fulfill({ contentType: "image/svg+xml", body: TILE }); }
  });
  const page = await ctx.newPage();
  await page.goto(BASE + "/index.html");
  await page.waitForFunction(() => !/loading feed/.test(document.querySelector("#meta").textContent));
  if (prep) await prep(page);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${name}.jpg`, type: "jpeg", quality: 82 });
  console.log(`${OUT}/${name}.jpg`);
  await ctx.close();
}
/** Saved settings for a shot: the install offer is dismissed (these pictures appear inside the install dialog). @param {object} extra */
const settings = extra => ({ storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: "id:settings", value: JSON.stringify({ installDismissedAt: Date.now(), ...extra }) }] }] } });
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
await shoot("phone-deck", { ...phone, ...settings({}) });
await shoot("phone-list", { ...phone, ...settings({ deck: false }) });
await shoot("desktop", { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, ...settings({}) }, async page => {
  await page.locator("#list .card").nth(1).focus();
});
await browser.close();
server.kill();
