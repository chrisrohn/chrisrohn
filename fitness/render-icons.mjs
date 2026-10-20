// Renders the Training app's PNG icons from fitness/site/icons/*.svg in headless Chromium (Playwright, already a dev
// dependency), so the home-screen, maskable and Apple icons always match the SVGs:  node fitness/render-icons.mjs
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "site", "icons");
const OUT = [["icon.svg", "icon-192.png", 192], ["icon.svg", "icon-512.png", 512], ["icon.svg", "apple-touch-icon.png", 180],
  ["icon-maskable.svg", "icon-maskable-192.png", 192], ["icon-maskable.svg", "icon-maskable-512.png", 512]];
const exe = process.env.PW_CHROMIUM;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage();
for (const [svg, png, size] of OUT) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0}img{display:block;width:${size}px;height:${size}px}</style><img src="data:image/svg+xml;base64,${readFileSync(join(DIR, svg)).toString("base64")}">`);
  await page.locator("img").evaluate(i => i.decode());
  await page.screenshot({ path: join(DIR, png), clip: { x: 0, y: 0, width: size, height: size } });
  console.log(png, size);
}
await browser.close();
