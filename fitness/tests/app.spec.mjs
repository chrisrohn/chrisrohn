// The installable app (/fitness/, written by fitness/build-app.mjs from fitness/site): the hosted shell holds no one's
// data, shows the welcome screen until data arrives, takes a phone link's #d= or a pasted/picked data file, keeps it
// on the device (and hands ride mode its plan), passes axe under its CSP, and opens offline once installed.
import { test, expect } from "@playwright/test";
import { deflateRawSync } from "node:zlib";
import { DATA, watch, axe } from "./fixtures.mjs";

const phoneLink = d => "/fitness/#d=" + deflateRawSync(Buffer.from(JSON.stringify(d))).toString("base64url");

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
    await page.locator("#databar [data-action=settings]").click();
    page.once("dialog", d => d.accept());
    await page.locator("#import [data-action=forget]").click();
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

  test("says what the plan did about a session that didn't happen", async ({ page }) => {
    const moved = { ...DATA, plan: { ...DATA.plan, adjustments: ["Saturday's long ride didn't happen: it's on today instead."] } };
    await page.goto(phoneLink(moved));
    await expect(page.locator(".adjusted")).toContainText("Saturday's long ride didn't happen: it's on today instead.");
    expect(await axe(page)).toEqual([]);
  });

  test("today's call comes with a Plan B and the next seven days, each one opening to its session", async ({ page }) => {
    const days = DATA.plan.days.map((d, i) => i === 0 ? { ...d, role: "endurance", level: "moderate", title: "Endurance", alt: "Rain or short on time: 1h00 Z2 on Zwift." } : d);
    await page.goto(phoneLink({ ...DATA, plan: { ...DATA.plan, days }, now: { ...DATA.now, last_night: null } }));
    await expect(page.locator(".plan-b")).toContainText("Rain or short on time");
    await expect(page.locator(".overnight")).toContainText("Last night isn't in yet");
    const week = page.locator(".week-ahead li");
    await expect(week).toHaveCount(7);
    await expect(week.first()).toContainText("Today");
    await week.nth(1).locator("summary").click();
    await expect(week.nth(1).locator("details p").first()).toHaveText(DATA.plan.days[1].session);
    expect(await axe(page)).toEqual([]);
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
