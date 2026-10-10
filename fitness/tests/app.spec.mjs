// The installable app (/fitness/, written by fitness/build-app.mjs from fitness/site): the hosted shell holds no one's
// data, shows the welcome screen until data arrives, takes a phone link's #d= or a pasted/picked data file, keeps it
// on the device (and hands ride mode its plan), passes axe under its CSP, and opens offline once installed.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
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
    const plain = t => (t || "").replace(/\u2060/g, "").replace(/\u00a0/g, " ");   // the page's word joiners keep "4–5" on one line
    await expect.poll(async () => plain(await week.nth(1).locator("details p").first().textContent())).toBe(DATA.plan.days[1].session);
    expect(await axe(page)).toEqual([]);
  });

  test("race day, the bike and today's weather: all there, and nothing that needs the sync without it", async ({ page }) => {
    const problems = watch(page);
    const weather = { summary: "41°F to 58°F, dry, wind up to 12 mph", ride: { when: "5:00 PM–6:00 PM", line: "52°F, dry, wind 9 mph W", kit: "Arm and knee warmers, a vest", verdict: "dry", lights: null } };
    const days = DATA.plan.days.map((d, i) => i < 7 ? { ...d, wx: { hi: 14, lo: 5, pop: i === 2 ? 70 : 10, mm: 0, code: i === 2 ? 63 : 1, wind: 20 } } : d);
    await page.goto(phoneLink({ ...DATA, now: { ...DATA.now, weather }, plan: { ...DATA.plan, days } }));
    await expect(page.locator(".weather")).toContainText("Best window · 5:00 PM–6:00 PM");
    await expect(page.locator(".weather")).toContainText("Wear: Arm and knee warmers");
    await expect(page.locator(".week-ahead li").nth(2).locator(".wx")).toContainText("70%");
    await expect(page.locator("#race .race-day").first()).toContainText("Race morning");
    await expect(page.locator("#bike .upkeep li").first()).toBeVisible();
    await expect(page.locator("#bike")).toContainText("Re-drip the chain");
    await expect(page.locator("#bike [data-action=service]").first()).toBeHidden();      // no sync to log it with
    await expect(page.locator(".bar nav a[href='#race']")).toBeVisible();
    expect(await axe(page)).toEqual([]);
    expect(problems).toEqual([]);
  });

  test("shopping, the inside of the rides, tonight's bedtime, weight and a trainer workout file", async ({ page }) => {
    const problems = watch(page);
    const kitchen = { from: DATA.today, to: DATA.today, pudding: 6, veggie: 5, pudding_days: ["Mon"], veggie_days: ["Mon"], chicken: false,
      buy: [{ item: "Frozen broccoli", amount: "2.8 lb (≈ 4 × 12 oz bags)" }], check: [{ item: "Chia seeds", amount: "12 tbsp (5 oz)" }], prep: ["Pudding jars (6): …"] };
    const rides = { decoupling: [{ date: DATA.today, name: "Long ride", pct: 4.2, minutes: 130, by: "speed", indoor: false }],
      latest: { date: DATA.today, name: "Long ride", pct: 4.2, minutes: 130, by: "speed", indoor: false, verdict: "holding: the aerobic engine lasts this long" },
      sessions: [{ date: DATA.today, title: "Key session", expected: 36, actual: 30, pct: 83, bpm: 150 }], hint: null, traced: 12 };
    const trainer = { ...DATA.plan.days[1], indoor: true, title: "Trainer workout", steps: [{ name: "Warm-up", min: 10, zone: "z2", lo: 81, hi: 89, cue: "" }, { name: "Threshold 1/3", min: 12, zone: "thr", lo: 95, hi: 100, cue: "Smooth" }] };
    const days = DATA.plan.days.map((d, i) => i === 1 ? trainer : d);
    await page.goto(phoneLink({ ...DATA, fuel: { ...DATA.fuel, kitchen }, rides, weight: null, plan: { ...DATA.plan, days },
      now: { ...DATA.now, bedtime: { bed: "9:45 PM", wake: "6:00 AM", need: 8, reasons: ["tomorrow's key session"], workday: true, ride_in: true } } }));
    await page.locator(".kitchen summary").click();
    await expect(page.locator(".kitchen")).toContainText("Frozen broccoli");
    await expect(page.locator(".kitchen")).toContainText("12 tbsp");
    await expect(page.locator("#training")).toContainText("Aerobic decoupling");
    await expect(page.locator("#training")).toContainText("30 of 36 planned minutes at 150+ bpm");
    await expect(page.locator(".tonight")).toContainText("Lights out by 9:45 PM: up around 6:00 AM for the ride in");
    await expect(page.locator(".fuel")).toContainText("Weigh in now and then");
    await page.locator(".week-ahead li").nth(1).locator("summary").click();
    const [file] = await Promise.all([page.waitForEvent("download"), page.locator("[data-zwo]").click()]);
    expect(file.suggestedFilename()).toMatch(/trainer-workout\.zwo$/);
    const xmlText = readFileSync(await file.path(), "utf8");
    expect(xmlText).toContain('<SteadyState Duration="720" Power="0.97">');
    expect(xmlText).toContain('<Warmup Duration="600"');
    expect(await axe(page)).toEqual([]);
    expect(problems).toEqual([]);
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
