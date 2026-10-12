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
    await expect(page.locator("#tab-today")).toBeVisible();
    expect(new URL(page.url()).hash).toBe("");                                   // the data leaves the address bar at once
    await page.locator("#tab-plan").click();
    await expect(page.locator("#season")).toBeVisible();
    await expect(page.locator("#databar")).toContainText("Data from");
    await page.reload();                                                         // kept on this device
    await expect(page.locator("#tab-today")).toBeVisible();
    await page.goto("/fitness/ride.html");                                       // ride mode reads the same copy
    await expect(page.locator("#day option").first()).toContainText(DATA.ride.days.find(d => d.steps && d.steps.length).title);   // rest days have no steps to ride
    await page.goto("/fitness/");
    await page.locator("#databar [data-action=settings]").click();
    page.once("dialog", d => d.accept());
    await page.locator("#import [data-action=forget]").click();
    await expect(page.locator(".welcome")).toBeVisible();
    await page.goto(phoneLink(DATA));                                            // a link opened while the app is up
    await expect(page.locator("#tab-today")).toBeVisible();
    expect(problems).toEqual([]);
  });

  test("importing a data file inside the installed app (iPhone apps keep their own storage)", async ({ page }) => {
    await page.goto("/fitness/");
    await page.locator(".welcome [data-action=import]").click();
    await page.locator("#import-file").setInputFiles({ name: "fitness-data.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(DATA)) });
    await expect(page.locator("#tab-today")).toBeVisible();
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
    await expect(page.locator("#today .adjusted")).toContainText("Saturday's long ride didn't happen: it's on today instead.");
    expect(await axe(page)).toEqual([]);
  });

  test("today's call comes with a Plan B and the next seven days, each one opening to its session", async ({ page }) => {
    const days = DATA.plan.days.map((d, i) => i === 0 ? { ...d, role: "endurance", level: "moderate", title: "Endurance", alt: "Rain or short on time: 1h00 Z2 on Zwift." } : d);
    await page.goto(phoneLink({ ...DATA, plan: { ...DATA.plan, days }, now: { ...DATA.now, last_night: null } }));
    await expect(page.locator(".plan-b")).toContainText("Rain or short on time");
    await expect(page.locator(".overnight")).toContainText("Last night isn't in yet");
    await page.locator(".tomorrow [data-tab=plan]").click();                   // tomorrow's line opens the week
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
    await page.locator("#tab-plan").click();
    await expect(page.locator("#race .race-day").first()).toContainText("Race morning");
    await page.locator("#tab-ride").click();
    await expect(page.locator("#bike .upkeep li").first()).toBeVisible();
    await expect(page.locator("#bike")).toContainText("Re-drip the chain");
    await expect(page.locator("#bike [data-action=service]").first()).toBeHidden();      // no sync to log it with
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
    await expect(page.locator(".fuel-line")).toContainText("Meals");
    await page.locator(".fuel-line [data-tab=fuel]").click();
    await page.locator(".kitchen summary").click();
    await expect(page.locator(".kitchen")).toContainText("Frozen broccoli");
    await expect(page.locator(".kitchen")).toContainText("12 tbsp");
    await expect(page.locator("#training")).toContainText("Aerobic decoupling");
    await expect(page.locator("#training")).toContainText("30 of 36 planned minutes at 150+ bpm");
    await expect(page.locator(".tonight")).toContainText("Lights out by 9:45 PM: up around 6:00 AM for the ride in");
    await expect(page.locator(".fuel")).toContainText("Weigh in now and then");
    await page.locator("#tab-plan").click();
    await page.locator(".week-ahead li").nth(1).locator("summary").click();
    const [file] = await Promise.all([page.waitForEvent("download"), page.locator("[data-zwo]").click()]);
    expect(file.suggestedFilename()).toMatch(/trainer-workout\.zwo$/);
    const xmlText = readFileSync(await file.path(), "utf8");
    expect(xmlText).toContain('<SteadyState Duration="720" Power="0.97">');
    expect(xmlText).toContain('<Warmup Duration="600"');
    expect(await axe(page)).toEqual([]);
    expect(problems).toEqual([]);
  });

  test("the right-hand numbers say the same thing as the call: direction, raw readings, the reason for the call", async ({ page }) => {
    const rd = { ...DATA.now.readiness, score: 63, components: { rhr: 65, bb_wake: 48, resp: 38, sleep: 82 },
      reasons: [{ tone: "bad", dir: "down", text: "Body Battery at wake 5 — 43.9 below your 60-day norm (48.9 ± 20.7)" },
                { tone: "bad", dir: "up", text: "Sleeping respiration 16 brpm — 2.0 above your 60-day norm (14.0 ± 0.7)" }] };
    const readiness = [...DATA.readiness.slice(0, -8), ...Array.from({ length: 7 }, (_, i) => ({ date: `x${i}`, score: 75 })), { date: DATA.today, score: 63 }];
    const markers = { ...DATA.markers, bb_wake: { ...DATA.markers.bb_wake, series: [...DATA.markers.bb_wake.series.slice(0, -1), { date: DATA.today, v: 5, mean: 48.9, sd: 20.7 }] } };
    const plan = { ...DATA.plan, adjustments: ["Today's long ride didn't happen."] };
    await page.goto(phoneLink({ ...DATA, readiness, markers, plan, now: { ...DATA.now, readiness: rd } }));
    const tile = page.locator("#panel-today .tile").filter({ hasText: "Readiness" });
    await expect(tile).toContainText("−12 vs 7-day avg");
    await expect(tile.locator(".tag")).toHaveText("▼");                                    // down, not a green "up"
    await expect(page.locator(".meter").filter({ hasText: "Body Battery at wake" }).locator(".raw")).toHaveText("5");
    await expect(page.locator(".reasons li").nth(1)).toHaveClass(/up/);                   // breathing rate: above normal, and bad
    const call = page.locator("#today .call");
    expect(await call.locator(".adjusted").evaluate(el => el.compareDocumentPosition(document.querySelector(".week-ahead")) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
    expect(await axe(page)).toEqual([]);
  });

  test("the morning check-in eases the call (never hardens it), skips the lifting and stays on the phone", async ({ page }) => {
    const problems = watch(page);
    const lift = { title: "Strength A · heavy", minutes: 35, detail: "After the ride: back squat or leg press 4 × 4–6 heavy" };
    const days = DATA.plan.days.map((d, i) => i === 0 ? { ...d, role: "key", level: "hard", commute: null, title: "Key session", session: "Sweet spot: 3 × 12 min", strength: lift } : d);
    const now = { ...DATA.now, readiness: { ...DATA.now.readiness, score: 82, illness: false }, base_call: { level: "hard", title: "Green light — key session", detail: "Recovered." } };
    await page.goto(phoneLink({ ...DATA, commute: null, plan: { ...DATA.plan, days }, now, strength: { done: [], ahead: [DATA.today], per_week_8: 1.5 } }));
    const call = page.locator("#today .call");
    await expect(call.locator(".title")).toHaveText("Key session");
    await expect(call.locator(".lift")).toContainText("Strength A · heavy · 35 min");
    await expect(call.locator(".lift")).toContainText("Strength this week: 0 of 1");
    await expect(call.locator(".checkin")).toHaveAttribute("open", "");
    expect(await axe(page)).toEqual([]);
    for (const [k, v] of [["legs", "5"], ["energy", "5"], ["stress", "4"], ["mood", "4"], ["sick", "none"]]) await call.locator(`[data-feel=${k}][data-v="${v}"]`).click();
    await expect(call.locator(".title")).toHaveText("Key session");                             // feeling great never adds to the plan
    await expect(call.locator(".checkin")).not.toHaveAttribute("open", "");                     // answered: folded away
    await expect(call.locator(".checkin summary")).toContainText("Legs fresh");
    await expect(page.locator("#panel-today .tile").filter({ hasText: "Readiness" })).toContainText("watch 82 · feel 98");
    await call.locator(".checkin summary").click();
    await call.locator("[data-feel=legs][data-v='1']").click();
    await expect(call.locator(".title")).toHaveText("Keep it easy");
    await expect(call.locator(".reasons li").first()).toContainText("Check-in: legs very sore");
    await expect(call.locator(".lift")).toContainText("Skip the lifting today");
    await call.locator("[data-feel=sick][data-v=below]").click();
    await expect(call.locator(".title")).toHaveText("Rest today");
    await expect(call.locator(".detail")).toContainText("symptoms below the neck");
    await expect(page.locator("[data-feel=sick][data-v=below]")).toHaveAttribute("aria-pressed", "true");
    await page.reload();                                                                       // kept on this device
    await expect(call.locator(".title")).toHaveText("Rest today");
    expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("fitness-checkin") || "{}")))).toHaveLength(1);
    await page.locator("#tab-body").click();
    await expect(page.locator("#recovery")).toContainText("How you felt");
    await page.locator("#tab-plan").click();
    await expect(page.locator(".week-ahead li").first()).toContainText("+ strength");
    expect(await axe(page)).toEqual([]);
    expect(problems).toEqual([]);
  });

  test("rides you rate sit beside their load, and three that felt hard say so on Today; the power curve and CP on Ride", async ({ page }) => {
    const problems = watch(page);
    const rides = Array.from({ length: 10 }, (_, i) => ({ id: `garmin:r${i}`, start: `${DATA.today}T0${i}:00:00`, name: `Ride ${i}`, kind: "road_biking",
      group: "ride", offroad: false, indoor: false, commute: false, leg: null, moving_s: 3600, distance_m: 30000, elev_m: 200, avg_hr: 140, np: null, load: 60, load_src: "hr" }));
    const rpe = Object.fromEntries(rides.map((r, i) => [r.id, i < 3 ? 8 : 4]));                // newest first: the last three felt hard
    await page.goto(phoneLink({ ...DATA, recent: rides, rpe, checkins: {} }));
    await expect(page.locator("#today .reasons li").first()).toContainText("Your last 3 rides felt 100% harder");
    await page.locator("#tab-ride").click();
    await expect(page.locator("#training")).toContainText("How rides felt");
    await expect(page.locator("[aria-label=\"Rated rides\"] tbody tr").first()).toContainText("harder than usual");
    await expect(page.locator("#training")).toContainText("Power-duration curve");
    expect(DATA.power && DATA.power.cp).toBeTruthy();                                         // the demo rides carry power
    await expect(page.locator("#training")).toContainText(`Critical power ${DATA.power.cp.cp} W`);
    await expect(page.locator("#c-power svg")).toBeVisible();
    expect(await axe(page)).toEqual([]);
    expect(problems).toEqual([]);
  });

  test("five tabs: Today first, a bar under the thumb on a phone, every old section link lands on its tab", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const problems = watch(page);
    await page.goto(phoneLink(DATA));
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveText([/^Today/, /^Plan/, /^Fuel/, /^Body/, /^Ride/]);
    await expect(page.locator("#tab-today")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#panel-today .call")).toBeVisible();
    await expect(page.locator("#panel-plan")).toBeHidden();
    const bar = await page.locator("#tabs").boundingBox();
    expect(bar && bar.y + bar.height).toBeGreaterThan(800);                        // along the bottom of the screen
    expect(await axe(page)).toEqual([]);
    for (const [id, inside] of [["plan", ".week-ahead"], ["fuel", "#fuel"], ["body", "#load"], ["ride", "#ride-mode"]]) {
      await page.locator(`#tab-${id}`).tap();
      await expect(page.locator(`#panel-${id} ${inside}`).first()).toBeVisible();
      await expect(page.locator("#panel-today")).toBeHidden();
      expect(new URL(page.url()).hash).toBe(`#${id}`);
      expect(await axe(page)).toEqual([]);
    }
    await page.locator("#tab-ride").focus();
    await page.keyboard.press("ArrowRight");                                      // wraps round to Today
    await expect(page.locator("#tab-today")).toBeFocused();
    await expect(page.locator("#panel-today")).toBeVisible();
    expect(new URL(page.url()).hash).toBe("");
    await page.goto("/fitness/#season");                                         // a section's own link opens its tab
    await expect(page.locator("#tab-plan")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#season")).toBeVisible();
    await page.evaluate(() => { location.hash = "#bike"; });
    await expect(page.locator("#tab-ride")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#bike")).toBeVisible();
    await page.reload();                                                          // the tab survives a reload
    await expect(page.locator("#tab-ride")).toHaveAttribute("aria-selected", "true");
    expect(problems).toEqual([]);
    await ctx.close();
  });

  test("a dot on the tab that has news: the plan changed, a bike job is due", async ({ page }) => {
    const moved = { ...DATA, plan: { ...DATA.plan, adjustments: ["Saturday's long ride didn't happen: it's on today instead."] } };
    await page.goto(phoneLink(moved));
    await expect(page.locator("#tab-plan .dot")).toHaveCount(1);
    await expect(page.locator("#tab-plan")).toContainText("the plan changed");
    await expect(page.locator("#tab-fuel .dot")).toHaveCount(0);
    const bar = await page.locator("#tabs").boundingBox();
    expect(bar && bar.y).toBeLessThan(200);                                       // a wide screen: the band's second tier
  });

  test("the Fuel tab: today's nutrients against the day's needs, and what food can't cover", async ({ page }) => {
    const problems = watch(page);
    expect(DATA.fuel.today.nutrients.rows.length).toBeGreaterThan(10);
    await page.goto(phoneLink(DATA));
    await page.locator("#tab-fuel").click();
    const table = page.locator("#panel-fuel table.nutrients");
    await expect(table).toBeVisible();
    await expect(table.locator("tr").filter({ hasText: "Vitamin B12" })).toBeVisible();
    await expect(page.locator("#panel-fuel .advice-list")).toContainText("Algae oil (EPA + DHA)");
    await expect(page.locator("#panel-fuel .meals").first()).toContainText("Gap fillers");
    await expect(page.locator("#panel-today table.nutrients")).toHaveCount(0);          // the full panel lives on Fuel only
    expect(await axe(page)).toEqual([]);
    expect(problems).toEqual([]);
  });

  test("opens offline once the service worker has it", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(phoneLink(DATA));
    await expect(page.locator("#tab-today")).toBeVisible();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.reload();                                                         // now under the worker's control
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await ctx.setOffline(true);
    await page.reload();
    await expect(page.locator("#tab-today")).toBeVisible();
    await page.goto("/fitness/ride.html");
    await expect(page.locator("#btn-start")).toBeVisible();
    await ctx.close();
  });
});
