// Ride mode at a glance: every screen carries what the others know. The workout (step, time left, heart rate against
// the target) rides along on Map, Ahead, Data and Laps; the next turn is in view on every screen; the app's word and the
// eat-and-drink prompt reach you wherever you are; the Workout screen fits a phone mid-ride, route, climb and all. And
// the numbers ride mode works from are the training sync's, so its zones and targets match the dashboard's.
import { test, expect } from "@playwright/test";
import { deflateRawSync } from "node:zlib";
import { watch, axe } from "./fixtures.mjs";

test.use({ baseURL: "http://127.0.0.1:8766" });

const LAT0 = 42.29, LON0 = -85.59, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110540;
const at = (e, n) => ({ lat: LAT0 + n / KY, lon: LON0 + e / KX });
const geo = (e, n) => { const p = at(e, n); return { latitude: p.lat, longitude: p.lon, accuracy: 5 }; };
const PTS = [];
for (let e = 0; e <= 3000; e += 20) PTS.push({ ...at(e, 0), ele: 250 });
for (let n = 20; n <= 1500; n += 20) PTS.push({ ...at(3000, n), ele: 250 + n * 0.05 });
for (let e = 3020; e <= 6000; e += 20) PTS.push({ ...at(e, 1500), ele: 325 });
const GPX = `<?xml version="1.0"?><gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
<wpt lat="${at(3000, 0).lat}" lon="${at(3000, 0).lon}"><name>Left</name><desc>Turn left onto Gull Rd</desc><type>Left</type></wpt>
<wpt lat="${at(3000, 1500).lat}" lon="${at(3000, 1500).lon}"><name>Right</name><desc>Turn right onto Ridge Rd</desc><type>Right</type></wpt>
<trk><name>Gull Lake loop</name><trkseg>${PTS.map(p => `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><ele>${p.ele}</ele></trkpt>`).join("")}</trkseg></trk></gpx>`;

const today = new Date();
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const step = (name, min, zone, lo, hi, cue = "") => ({ name, min, zone, lo, hi, cue });
const PLAN = { lthr: 160, max_hr: 185, rest_hr: 50, sex: "male", wheel_m: 2.29, fuel_every_min: 20, units: "metric", ftp: 250, weight_kg: 78,
  days: [{ date: iso(today), title: "VO2", session: "VO2", minutes: 40, load: 60, indoor: false,
    steps: [step("Warm-up", 15, "z2", 81, 89), step("VO2 1/2", 4, "z5", 100, 106), step("Easy", 4, "z1", 0, 81), step("VO2 2/2", 4, "z5", 100, 106), step("Cool-down", 10, "z1", 0, 81)] }] };
const link = (plan, q = "") => `/ride.html${q}#z=` + deflateRawSync(Buffer.from(JSON.stringify(plan))).toString("base64url");
const JSONH = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
async function world(page) {
  await page.context().route("https://tiles.openfreemap.org/**", r => r.fulfill({ status: 404, headers: { "Access-Control-Allow-Origin": "*" }, body: "" }));
  await page.context().route("https://api.open-meteo.com/**", r => r.fulfill({ status: 200, headers: JSONH, body: JSON.stringify({
    current: { temperature_2m: 12, apparent_temperature: 11, wind_speed_10m: 20, wind_direction_10m: 90, wind_gusts_10m: 25 }, hourly: { precipitation_probability: [0, 0, 0] } }) }));
  await page.context().route("https://overpass-api.de/**", r => r.fulfill({ status: 503, body: "" }));
}
const quiet = problems => problems.filter(p => !/Failed to load resource|status of (404|503)/.test(p));
/** A strap on the chest: heart rate (and cadence) streaming as long as the page is open. */
const strap = (page, hr) => page.evaluate(h => { const r = /** @type {any} */ (window).__ride; setInterval(() => { r.live.hr = h; r.live.hrAt = Date.now(); r.live.cad = 90; r.live.cadAt = Date.now(); }, 250); }, hr);

/** Riding the route with a workout: a route loaded, Start, onto the first effort with HR on target. */
async function riding(page, ctx) {
  await world(page);
  await page.goto(link(PLAN));
  await page.locator("#tab-map").click();
  await page.locator("#btn-routes").click();
  await page.locator("#route-file").setInputFiles({ name: "gull.gpx", mimeType: "application/gpx+xml", buffer: Buffer.from(GPX) });
  await expect(page.locator("#route-msg")).toContainText("Loaded");
  await page.locator("#routes .actions button[value=close]").click();
  await page.locator("#tab-workout").click();
  await page.locator("#btn-start").click();
  await strap(page, 164);
  for (const e of [1000, 1010, 1020, 1030]) { await ctx.setGeolocation(geo(e, 0)); await page.waitForTimeout(300); }
  await page.locator("#btn-skip").click();                                                       // into VO2 1/2
  await page.evaluate(() => { const S = /** @type {any} */ (window).__ride.S; S.stepStart = S.elapsed - 60; });
}

test.describe("ride mode at a glance", () => {
  test("the workout rides along on every screen, and a tap on it is the Workout screen", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 869 }, isMobile: true, hasTouch: true, geolocation: geo(1000, 0), permissions: ["geolocation"] });
    const page = await ctx.newPage();
    const problems = watch(page);
    await riding(page, ctx);
    await expect(page.locator("#dock")).toBeHidden();                                            // the Workout screen is the big version
    await expect(page.locator("#step-left")).toHaveText("left in step");
    await expect(page.locator("#hr-status")).toHaveText("On target", { timeout: 5000 });
    for (const t of ["map", "ahead", "data", "laps"]) {
      await page.locator(`#tab-${t}`).click();
      await expect(page.locator("#dock"), t).toBeVisible();
      await expect(page.locator("#dk-k")).toContainText("VO2 1/2");
      await expect(page.locator("#dk-time")).toHaveText(/^[23]:\d\d$/);                           // 4 min, a minute in
      await expect(page.locator("#dk-hr")).toHaveText("164");
      await expect(page.locator("#dk-sub")).toContainText("target 160–170");
      await expect(page.locator("#dk-st")).toHaveText("✓");
      await expect(page.locator("#dock")).toHaveAttribute("data-zone", "5");
    }
    expect(await axe(page)).toEqual([]);
    await page.locator("#dock").click();
    await expect(page.locator("#tab-workout")).toHaveAttribute("aria-selected", "true");
    expect(quiet(problems)).toEqual([]);
    await ctx.close();
  });

  test("where you're going is on every screen: the next turn, slim until it comes up", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 869 }, isMobile: true, hasTouch: true, geolocation: geo(1000, 0), permissions: ["geolocation"] });
    const page = await ctx.newPage();
    await riding(page, ctx);
    for (const t of ["workout", "data", "laps"]) {
      await page.locator(`#tab-${t}`).click();
      await expect(page.locator("#navbanner"), t).toBeVisible();
      await expect(page.locator("#navbanner")).toHaveClass(/slim/);                               // 2 km out: one line
      await expect(page.locator("#nb-what")).toHaveText(" Turn left onto Gull Rd");               // the file's cue, said once
    }
    await page.locator("#tab-map").click();
    await expect(page.locator("#navbanner")).not.toHaveClass(/slim/);                             // the map's banner is full size
    await page.locator("#tab-data").click();
    await expect(page.locator("#d-turn")).toHaveText(/^\d\.\d km$/);                              // and as fields on Data
    await expect(page.locator("#d-togo")).toContainText("km");
    await ctx.close();
  });

  test("mid-ride, the Workout screen fits the phone without scrolling: turn, climb, step, heart rate and fields", async ({ browser }) => {
    for (const [w, h] of [[412, 869], [390, 844], [360, 640]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, geolocation: geo(1000, 0), permissions: ["geolocation"] });
      const page = await ctx.newPage();
      await riding(page, ctx);
      for (const e of [2000, 2010, 2020]) { await ctx.setGeolocation(geo(e, 0)); await page.waitForTimeout(300); }   // 1 km from the climb: the strip
      await expect(page.locator("#climbstrip")).toBeVisible();
      await expect(page.locator("#navbanner")).toBeVisible();
      const fit = await page.evaluate(() => { const p = /** @type {HTMLElement} */ (document.getElementById("pages")); return p.scrollHeight - p.clientHeight; });
      expect(fit, `${w}×${h}`).toBeLessThanOrEqual(1);
      for (const id of ["#step-time", "#hr", "#hr-status", "#step-target"]) await expect(page.locator(id), `${id} at ${w}×${h}`).toBeInViewport();
      await ctx.close();
    }
  });

  test("the app's word and the eat-and-drink prompt reach you on any screen", async ({ page }) => {
    await world(page);
    await page.goto(link(PLAN, "?page=map"));
    await page.locator("#btn-start").click();
    await page.evaluate(() => { const S = /** @type {any} */ (window).__ride.S; S.elapsed = 25 * 60; S.fuelAt = 0; });
    await expect(page.locator("#fuel")).toBeVisible({ timeout: 4000 });
    await page.locator("#fuel-ok").click();
    await expect(page.locator("#fuel")).toBeHidden();
    await page.evaluate(() => { const r = /** @type {any} */ (window).__ride; r.S.missed = 1; r.rep.n = 60; r.rep.under = 60; r.S.step = 1; r.S.stepStart = r.S.elapsed; });
    await page.locator("#btn-skip").click();
    await expect(page.locator("#suggest-text")).toContainText("rest of the set is cut");
    await expect(page.locator("#suggest")).toBeInViewport();
  });
});

test.describe("ride mode's numbers are the training sync's", () => {
  test("LTHR and FTP follow the sync as it learns; a number you set stays yours until the sync learns a new one", async ({ page }) => {
    await page.goto("/ride.html");
    // settings saved before (the old shape kept every number, so they froze): the ones equal to the sync's follow it again
    await page.evaluate(() => localStorage.setItem("fitness-ride-prefs", JSON.stringify({ lthr: 160, max: 185, rest: 50, ftp: 250, weight: 78, voice: false })));
    await page.goto(link({ ...PLAN, lthr: 170 }, "?a=1"));                                        // the sync learned a higher LTHR
    await page.locator("#btn-start").click();
    await expect(page.locator("#step-target")).toContainText("138–151");                           // 81–89% of 170, not of 160
    await page.locator("#btn-start").click();                                                      // pause
    await page.click("#btn-settings");
    await expect(page.locator("#s-sync")).toContainText("LTHR 170");
    expect(await page.locator("#s-voice").isChecked()).toBe(false);                                // the rest of the settings kept
    await page.fill("#s-lthr", "165");                                                             // your own number
    await page.click("#s-save");
    await expect(page.locator("#step-target")).toContainText("134–147");
    await page.goto(link({ ...PLAN, lthr: 170 }, "?a=2"));                                         // the same sync: yours stays
    await page.locator("#btn-start").click();
    await expect(page.locator("#step-target")).toContainText("134–147");
    await page.locator("#btn-start").click();
    await page.click("#btn-settings");
    await expect(page.locator("#s-sync")).toContainText("yours instead: LTHR");
    await page.click("#s-follow");                                                                  // back to the sync's
    await expect(page.locator("#s-lthr")).toHaveValue("170");
    await page.click("#s-save");
    await expect(page.locator("#step-target")).toContainText("138–151");
    await page.click("#btn-settings");
    await page.fill("#s-lthr", "165");
    await page.click("#s-save");
    await page.goto(link({ ...PLAN, lthr: 172 }, "?a=3"));                                         // the sync learns a new one: it wins
    await page.locator("#btn-start").click();
    await expect(page.locator("#step-target")).toContainText("139–153");
  });

  test("no FTP of your own: the steps' watts come from the eFTP the sync learned", async ({ page }) => {
    await world(page);
    await page.goto(link({ ...PLAN, ftp: 0, eftp: 240 }));
    await page.locator("#btn-start").click();
    await page.locator("#btn-skip").click();                                                       // VO2: 100–106% of LTHR
    await expect(page.locator("#step-target")).toContainText("160–170");
    await expect(page.locator("#step-target")).toContainText(/\d{3}–\d{3} W/);
  });
});
