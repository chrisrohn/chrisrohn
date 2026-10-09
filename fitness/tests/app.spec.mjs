// The installable app (/fitness/, written by fitness/build-app.mjs from fitness/site): the hosted shell holds no one's
// data, shows the welcome screen until data arrives, takes a phone link's #d= or a pasted/picked data file, keeps it
// on the device (and hands ride mode its plan), passes axe under its CSP, and opens offline once installed.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { execFileSync } from "node:child_process";
import { deflateRawSync } from "node:zlib";

/** A synthetic athlete's dashboard data, made by the same pipeline as `python -m fitness demo`. */
const DATA = JSON.parse(execFileSync("python3", ["-c", `
import json, sys, tempfile
from datetime import date
from pathlib import Path
from fitness import build, config, demo
from fitness.store import Store
cfg = config.load()
with tempfile.TemporaryDirectory() as tmp, Store(Path(tmp) / "d.db") as store:
    demo.populate(store, date.today(), days=200)
    data = build.assemble(cfg, store.days(), store.activities(), date.today())
sys.stdout.write(json.dumps(build.phone_data(data)))
`], { cwd: new URL("../..", import.meta.url), maxBuffer: 64 << 20 }).toString());
const phoneLink = d => "/fitness/#d=" + deflateRawSync(Buffer.from(JSON.stringify(d))).toString("base64url");

/** @param {import("@playwright/test").Page} page */
function watch(page) {
  const problems = [];
  page.on("pageerror", e => problems.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error" || /Content Security Policy/i.test(m.text())) problems.push(m.text()); });
  return problems;
}
/** @param {import("@playwright/test").Page} page */
async function axe(page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  return r.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join(", ")}`);
}

test.describe("installable app", () => {
  test("has a complete manifest whose icons all load", async ({ request }) => {
    const res = await request.get("/fitness/manifest.webmanifest");
    expect(res.ok()).toBe(true);
    const m = await res.json();
    expect(m).toMatchObject({ scope: "./", display: "standalone", short_name: "Training" });
    // an app's identity is its id resolved against the ORIGIN (not the manifest's folder): it must not collide with the
    // music app's at the site root, or the phone thinks this one is already installed
    const root = await (await request.get("/manifest.webmanifest")).json();
    const origin = "https://chrisrohn.com";
    expect(new URL(m.id, origin).href).toBe(`${origin}/fitness/`);
    expect(new URL(m.id, origin).href).not.toBe(new URL(root.id || root.start_url, origin).href);
    expect(m.start_url.startsWith("./")).toBe(true);
    expect(m.icons.map(i => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(m.icons.some(i => /maskable/.test(i.purpose || ""))).toBe(true);
    for (const src of [...m.icons.map(i => i.src), ...(m.shortcuts || []).map(s => s.url.split("?")[0])]) {
      expect((await request.get(new URL(src, "http://x/fitness/").pathname)).ok(), src).toBe(true);
    }
    const sw = await (await request.get("/fitness/sw.js")).text();
    expect(sw).not.toContain("__VERSION__");
    expect(sw).toMatch(/const CACHE = "fitness-[0-9a-f]{10}"/);
  });

  test("the hosted shell holds no data: welcome screen, clean CSP, passes axe", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const problems = watch(page);
    await page.goto("/fitness/");
    await expect(page.locator(".welcome")).toBeVisible();
    expect(await page.locator("#data").textContent()).not.toContain("{");
    const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    expect(policy).toMatch(/manifest-src 'self'; worker-src 'self'/);
    expect(await axe(page)).toEqual([]);
    await page.locator(".welcome [data-action=import]").click();
    await expect(page.locator("#import")).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.locator("#import-text").fill("not a link");
    await page.locator("#import-go").click();
    await expect(page.locator("#import-error")).toContainText("isn't a phone link");
    expect(problems).toEqual([]);
    await ctx.close();
  });

  test("a phone link brings the dashboard, keeps it on the device, and hands ride mode its plan", async ({ page }) => {
    const problems = watch(page);
    await page.goto(phoneLink(DATA));
    await expect(page.locator("#load")).toBeVisible();
    await expect(page.locator("#season")).toBeVisible();
    expect(new URL(page.url()).hash).toBe("");                                   // the data leaves the address bar at once
    await expect(page.locator("#databar")).toContainText("Data from");
    await page.reload();                                                         // kept on this device
    await expect(page.locator("#load")).toBeVisible();
    await page.goto("/fitness/ride.html");                                       // ride mode reads the same copy
    await expect(page.locator("#day option").first()).toContainText(DATA.ride.days[0].title);
    await page.goto("/fitness/");
    page.once("dialog", d => d.accept());
    await page.locator("#databar [data-action=forget]").click();
    await expect(page.locator(".welcome")).toBeVisible();
    await page.goto(phoneLink(DATA));                                            // a link opened while the app is up
    await expect(page.locator("#load")).toBeVisible();
    expect(problems).toEqual([]);
  });

  test("importing a data file inside the installed app (iPhone apps keep their own storage)", async ({ page }) => {
    await page.goto("/fitness/");
    await page.locator(".welcome [data-action=import]").click();
    await page.locator("#import-file").setInputFiles({ name: "fitness-data.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(DATA)) });
    await expect(page.locator("#load")).toBeVisible();
    await page.waitForLoadState("load");
    expect(await axe(page)).toEqual([]);
  });

  test("the music app's service worker leaves this app's offline cache alone", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/fitness/");
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter(k => k.startsWith("fitness-")).length)).toBe(1);
    await page.goto("/");                                                        // the music app's worker installs and activates
    await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return r.active && r.active.state; });
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).some(k => k.startsWith("newmusic-") && k !== "newmusic-art"))).toBe(true);
    expect(await page.evaluate(async () => (await caches.keys()).filter(k => k.startsWith("fitness-")).length)).toBe(1);
    await ctx.close();
  });

  test("opens offline once the service worker has it", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(phoneLink(DATA));
    await expect(page.locator("#load")).toBeVisible();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.reload();                                                         // now under the worker's control
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await ctx.setOffline(true);
    await page.reload();
    await expect(page.locator("#load")).toBeVisible();
    await page.goto("/fitness/ride.html");
    await expect(page.locator("#btn-start")).toBeVisible();
    await ctx.close();
  });
});
