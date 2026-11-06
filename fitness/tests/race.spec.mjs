// Race morning in ride mode: the course the sync sent is loaded by itself, with a plan to beat your record set from the
// race guide (build.race_guide); the race session runs on that plan, not a timer; the start, settling, each quarter
// against your record, and a warning while you ride over the plan.
import { test, expect } from "@playwright/test";
import { deflateRawSync } from "node:zlib";
import { watch, axe } from "./fixtures.mjs";

test.use({ baseURL: "http://127.0.0.1:8766" });

// a 7.5 km course: 3 km flat, a 1.5 km climb at ~5%, 3 km flat
const LAT0 = 44.72, LON0 = -85.21, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110540;
const at = (e, n) => ({ lat: LAT0 + n / KY, lon: LON0 + e / KX });
const geo = (e, n) => { const p = at(e, n); return { latitude: p.lat, longitude: p.lon, accuracy: 5 }; };
const PTS = [];
for (let e = 0; e <= 3000; e += 20) PTS.push([...Object.values(at(e, 0)), 250]);
for (let n = 20; n <= 1500; n += 20) PTS.push([...Object.values(at(3000, n)), 250 + n * 0.05]);
for (let e = 3020; e <= 6000; e += 20) PTS.push([...Object.values(at(e, 1500)), 325]);

const now = new Date(), pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const local = d => `${iso(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const step = (name, min, zone, lo, hi, cue = "") => ({ name, min, zone, lo, hi, cue });
const GUIDE = { gun: local(new Date(Date.now() - 10 * 60e3)), wave: 14, kind: "mtb", target_s: 1470, expected_s: 1560,
  pr: { date: "2025-11-01", secs: 1500, raw_secs: 1660, scaled: true, avg_hr: 158, ctl: 57.2 },
  settle: [147, 155], ceiling: 160, start_min: 6, fuel: { rate: 60, sips: "⅓ bottle every 20 min", top_up: 0 }, ctl: 55, tsb: 10 };
const plan = (days, guide = GUIDE) => ({ lthr: 160, max_hr: 185, rest_hr: 50, sex: "male", wheel_m: 2.29, fuel_every_min: 20, units: "metric", ftp: 0, weight_kg: 78,
  race: { name: "Iceman Cometh", date: iso(now), course: { id: "course-iceman-cometh-test", name: "Iceman Cometh 2026", points: PTS }, guide }, days });
const RACE_DAY = [
  { date: iso(now), title: "Race warm-up", session: "Before the gun", minutes: 20, load: 15, indoor: false, steps: [step("Easy spin", 12, "z2", 81, 89), step("Easy", 8, "z1", 0, 81)] },
  { date: iso(now), title: "Race day — Iceman Cometh · wave 14, 9:24 AM", session: "Race", minutes: 0, load: 0, indoor: false, steps: [], race: true },
];
const link = p => "/ride.html#z=" + deflateRawSync(Buffer.from(JSON.stringify(p))).toString("base64url");
const JSONH = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
async function world(page) {
  await page.context().route("https://tiles.openfreemap.org/**", r => r.fulfill({ status: 404, headers: { "Access-Control-Allow-Origin": "*" }, body: "" }));
  await page.context().route("https://api.open-meteo.com/**", r => r.fulfill({ status: 200, headers: JSONH, body: JSON.stringify({
    current: { temperature_2m: 3, apparent_temperature: 0, wind_speed_10m: 10, wind_direction_10m: 270, wind_gusts_10m: 15 }, hourly: { precipitation_probability: [0, 0, 0] } }) }));
  await page.context().route("https://overpass-api.de/**", r => r.fulfill({ status: 503, body: "" }));
}
const quiet = problems => problems.filter(p => !/Failed to load resource|status of (404|503)/.test(p));
const said = page => page.evaluate(() => /** @type {any} */ (window).__said.join(" | "));

test.describe("race morning", () => {
  test("the course is loaded with a plan to beat your record, and the race runs on it from the start to the finale", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 869 }, isMobile: true, hasTouch: true, geolocation: geo(0, 0), permissions: ["geolocation"] });
    const page = await ctx.newPage();
    const problems = watch(page);
    await world(page);
    await page.goto(link(plan(RACE_DAY)));
    await expect(page.locator("#day option:checked")).toContainText("Race day");                 // the gun is near: the race, not the warm-up
    await expect(page.locator("#step-name")).toHaveText("Iceman Cometh");                         // the course loaded itself, with the plan
    await expect(page.locator("#step-time")).toHaveText(/^2[45]:\d\d$/);                          // a new record: under 25:00
    await expect(page.locator("#step-left")).toHaveText("target · a new record");
    await expect(page.locator("#step-target")).toHaveText(/^Settle 147\u2060?–\u2060?155 bpm · under 160 until the last 15%$/);
    await expect(page.locator("#step-cue")).toContainText("Record pace here 25:00 (your 2025 ride at this course's length), ridden at 158 bpm");
    const row = await page.evaluate(() => /** @type {any} */ (window).__ride.DB.get("routes", "course-iceman-cometh-test"));
    expect(row.pace.target).toBe(1470);
    expect(row.pace.guide).toBe(iso(now));
    expect(row.pace.ftp).toBeGreaterThan(50);                                                     // calibrated to the record's heart rate
    await page.locator("#tab-ahead").click();
    await expect(page.locator("#btn-pace")).toContainText("Race plan");
    await page.locator("#btn-pace").click();
    await expect(page.locator("#pc-sum")).toContainText("set from your record here (25:00 pace at 158 bpm, 2025)");
    const bands = await page.locator("#pc-list li").allTextContents();
    const top = Math.max(...bands.map(t => +((t.match(/–(\d+) bpm/) || [])[1] || 0)));
    expect(top).toBeLessThanOrEqual(164);                                                          // the ceiling, +4 only in the finale
    expect(await axe(page)).toEqual([]);
    await page.locator("#pace button[value=close]").click();
    await page.locator("#tab-workout").click();

    // the gun: go for your place, then settle
    await page.evaluate(() => { const w = /** @type {any} */ (window); w.__said = []; speechSynthesis.speak = u => w.__said.push(u.text); });
    await page.locator("#btn-start").click();
    await page.evaluate(() => { const r = /** @type {any} */ (window).__ride; setInterval(() => { r.live.hr = 165; r.live.hrAt = Date.now(); }, 250); });
    for (const e of [10, 20, 30, 40]) { await ctx.setGeolocation(geo(e, 0)); await page.waitForTimeout(350); }
    await expect(page.locator("#step-name")).toContainText("The start");
    await expect(page.locator("#step-left")).toHaveText("then settle");
    await expect.poll(() => said(page)).toContain("Race on. Go hard for 6 minutes");
    expect(await page.evaluate(() => /** @type {any} */ (window).__ride.S.plan.length)).toBe(0);   // no timer on the race
    // seven minutes in, a third of the way, the last minute over the plan
    await page.evaluate(() => { const r = /** @type {any} */ (window).__ride; r.S.routeT0 = r.S.elapsed - 420; r.S.mine = [0, 10, 20, 30, 40, 50]; });
    await expect.poll(() => said(page)).toContain("Settle now: 147 to 155");
    await expect(page.locator("#step-name")).toContainText("Record pace");
    await expect(page.locator("#step-time")).toHaveText(/^\+\d+:\d\d$/);                           // 40 m in 7 minutes: well behind
    await expect(page.locator("#step-left")).toHaveText("behind record pace");
    await expect(page.locator("#step-cue")).toContainText("record pace 25:00");
    await page.locator("#tab-map").click();                                                       // and it rides along on the map
    await expect(page.locator("#dk-k")).toContainText("behind record pace");
    await expect(page.locator("#dk-time")).toHaveClass(/behind/);
    for (const e of [2600, 2610, 2620]) { await ctx.setGeolocation(geo(e, 0)); await page.waitForTimeout(350); }
    await expect.poll(() => said(page)).toMatch(/25 percent\. .*(ahead of|behind|right on) your record pace\. Finishing about/);
    await page.evaluate(() => { const r = /** @type {any} */ (window).__ride; r.S.paceHot = 59; r.S.hotSaidAt = 0; });
    await expect.poll(() => said(page), { timeout: 5000 }).toContain("Over the plan: 165");
    expect(await page.evaluate(() => /** @type {any} */ (window).__ride.S.autoPaused)).toBe(false);   // the race clock never pauses
    expect(quiet(problems)).toEqual([]);
    await ctx.close();
  });

  test("an older sync's race session (warm-up and one long step) runs on the plan too, and a plan you set yourself is kept", async ({ page }) => {
    await world(page);
    const old = [{ date: iso(now), title: "Race day — Iceman Cometh", session: "Race", minutes: 0, load: 0, indoor: false,
      steps: [step("Warm-up", 15, "z2", 81, 89), step("Race", 130, "race", 90, 96)] }];
    await page.goto(link(plan(old)));
    await expect(page.locator("#step-name")).toHaveText("Iceman Cometh");
    expect(await page.evaluate(() => /** @type {any} */ (window).__ride.S.plan.length)).toBe(0);   // no warm-up timer at the gun
    await page.evaluate(async () => { const r = /** @type {any} */ (window).__ride, row = await r.DB.get("routes", "course-iceman-cometh-test"); row.pace = { ...row.pace, target: 1800, mine: true }; await r.DB.put("routes", row); });
    await page.goto(link(plan(old, { ...GUIDE, target_s: 1400 })).replace("ride.html", "ride.html?again=1"));
    await expect(page.locator("#step-name")).toHaveText("Iceman Cometh");
    expect(await page.evaluate(async () => (await /** @type {any} */ (window).__ride.DB.get("routes", "course-iceman-cometh-test")).pace.target)).toBe(1800);
  });
});
