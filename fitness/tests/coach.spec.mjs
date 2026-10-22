// The Edge features ride mode added: a race plan for a finish time (Power Guide), the fuel tank and W′ (stamina),
// your own past rides as a ghost with climb records, going anywhere (home, a loop, a pin, what's nearby, places along
// a route) and weather alerts on the ride. BRouter, Overpass and Open-Meteo answer from the test.
import { test, expect } from "@playwright/test";
import { deflateRawSync } from "node:zlib";
import { watch, axe } from "./fixtures.mjs";

test.use({ baseURL: "http://127.0.0.1:8766" });

const LAT0 = 42.29, LON0 = -85.59, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110540;
const at = (e, n) => ({ lat: LAT0 + n / KY, lon: LON0 + e / KX });
const geo = (e, n) => { const p = at(e, n); return { latitude: p.lat, longitude: p.lon, accuracy: 5 }; };
// 3 km east, 1.5 km north up a 5 % climb, 3 km east again
const PTS = [];
for (let e = 0; e <= 3000; e += 20) PTS.push({ ...at(e, 0), ele: 250 });
for (let n = 20; n <= 1500; n += 20) PTS.push({ ...at(3000, n), ele: 250 + n * 0.05 });
for (let e = 3020; e <= 6000; e += 20) PTS.push({ ...at(e, 1500), ele: 325 });
const gpx = (name = "Barry-Roubaix short") => `<?xml version="1.0"?><gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>
${PTS.map(p => `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><ele>${p.ele}</ele></trkpt>`).join("\n")}</trkseg></trk></gpx>`;
const PLAN = { lthr: 160, max_hr: 185, rest_hr: 50, sex: "male", wheel_m: 2.1, fuel_every_min: 20, units: "metric", ftp: 250, weight_kg: 78, cp: 260, w_prime_kj: 18, days: [] };
const link = (plan = PLAN, q = "") => `/ride.html${q}#z=` + deflateRawSync(Buffer.from(JSON.stringify(plan))).toString("base64url");
const JSONH = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
const line = pts => ({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts.map(p => [p.lon, p.lat, 250]) } }] });
/** The outside world: no map tiles, weather (optionally with what's coming), a router and OpenStreetMap's places. */
async function world(page, { forecast = null, router = null, places = [] } = {}) {
  const calls = { router: [], overpass: [] };
  const ctx = page.context();
  await ctx.route("https://tiles.openfreemap.org/**", r => r.fulfill({ status: 404, headers: { "Access-Control-Allow-Origin": "*" }, body: "" }));
  await ctx.route("https://api.open-meteo.com/**", r => r.fulfill({ status: 200, headers: JSONH, body: JSON.stringify({ current: { temperature_2m: 14, apparent_temperature: 13, wind_speed_10m: 18, wind_direction_10m: 270, wind_gusts_10m: 25 }, hourly: { precipitation_probability: [10] }, ...(forecast ? forecast() : {}) }) }));
  await ctx.route("https://brouter.de/**", r => { calls.router.push(r.request().url()); return router ? r.fulfill({ status: 200, headers: JSONH, body: JSON.stringify(router(r.request().url())) }) : r.fulfill({ status: 503, body: "" }); });
  await ctx.route("https://overpass-api.de/**", r => { calls.overpass.push(r.request().postData() || ""); return r.fulfill({ status: 200, headers: JSONH, body: JSON.stringify({ elements: places }) }); });
  return calls;
}
const quiet = problems => problems.filter(p => !/Failed to load resource|status of (404|503)/.test(p));
async function loadRoute(page, name) {
  await page.locator("#tab-map").click();
  await page.locator("#btn-routes").click();
  await page.locator("#route-file").setInputFiles({ name: "race.gpx", mimeType: "application/gpx+xml", buffer: Buffer.from(gpx(name)) });
  await expect(page.locator("#route-msg")).toContainText("Loaded");
  await page.locator("#routes .actions button[value=close]").click();
}

test.describe("the coach on the bars", () => {
  test("the engine: pacing, stamina, ghosts, loops, places and weather alerts", async ({ page }) => {
    await page.goto("/ride.html");
    const r = await page.evaluate(pts => {
      const C = /** @type {any} */ (window).RideCore, route = C.analyze({ name: "t", points: pts });
      const secs = C.sections(route), opt = { ftp: 250, mass: 88, surface: "gravel" };
      const plan = C.pacePlan(route, { ...opt, target: 1500 }), fast = C.paceSuggest(route, opt), fastPlan = C.pacePlan(route, { ...opt, target: fast }), minuteLess = C.pacePlan(route, { ...opt, target: fast - 60 });
      const climb = plan.sections.find(s => s.kind === "climb"), flat = plan.sections.find(s => s.kind === "flat");
      const mid = C.paceAt(plan, (climb.from + climb.to) / 2);
      // a ride along the route at 8 m/s, stopping 60 s at 1 km (auto-paused: no samples), and one that went elsewhere
      const ride = [], t0 = 1.7e12;
      let t = t0;
      for (let d = 0; d <= route.total; d += 8) { const p = C.pointAt(route, d); ride.push([t, p.lat, p.lon, null, 140, 85, null, 8, d]); t += d === 1000 ? 61000 : 1000; }
      const g = C.ghostOf(route, ride), half = C.ghostOf(route, ride.slice(0, ride.length / 2)), other = C.ghostOf(route, ride.map(s => [s[0], s[1] + 0.01, s[2], ...s.slice(3)]));
      const tank = C.tank(75); for (let i = 0; i < 3600; i++) C.burn(tank, { watts: 200, pct: 80 }); C.eat(tank, 60);
      const easy = C.tank(75); for (let i = 0; i < 3600; i++) C.burn(easy, { watts: 120, pct: 48 });
      let wb = 18000; for (let i = 0; i < 60; i++) wb = C.wbal(wb, 460, 260, 18000); const spent = wb; for (let i = 0; i < 600; i++) wb = C.wbal(wb, 150, 260, 18000);
      const home = { lat: 42.73, lon: -84.55 }, loop = C.loopPoints(home, 40000, 270), leg = C.hav(home, loop[0]) + C.hav(loop[0], loop[1]) + C.hav(loop[1], loop[2]) + C.hav(loop[2], home);
      const places = C.fromOverpass({ elements: [{ type: "node", lat: 42.3, lon: -85.5, tags: { amenity: "drinking_water" } }, { type: "way", center: { lat: 42.31, lon: -85.51 }, tags: { amenity: "cafe", name: "Gull Lake Coffee", opening_hours: "Mo-Su 07:00-15:00" } },
        { type: "node", lat: 42.32, lon: -85.52, tags: { shop: "bicycle", name: "Village Cycle" } }, { type: "node", lat: 42.3, lon: -85.5, tags: { amenity: "bench" } }, { type: "node", lat: 42.3, lon: -85.5, tags: { amenity: "drinking_water" } }] });
      const now = 1.8e12, q = 15 * 60;
      const mk = (precip, wind = [10, 10, 10, 10, 10, 10, 10, 10], dir = [270, 270, 270, 270, 270, 270, 270, 270], codes = [1, 1, 1]) => ({ minutely_15: { time: precip.map((_, i) => now / 1000 + i * q), precipitation: precip, wind_speed_10m: wind, wind_direction_10m: dir }, hourly: { time: [now / 1000, now / 1000 + 3600, now / 1000 + 7200], weather_code: codes } });
      return { kinds: secs.map(s => s.kind), planTotal: plan.total, climbW: climb.watts, flatW: flat.watts, descentCap: plan.sections.every(s => s.speed <= 13.0001), mid: mid.i, midPlanned: mid.planned, climbEnd: climb.end, climbSecs: climb.secs,
        fast, fastIf: fastPlan.if, fastSustain: fastPlan.sustain, lessIf: minuteLess.if, lessSustain: minuteLess.sustain, slowIf: plan.if, round: C.hrPctFor(C.ftpPct(85)),
        ghostTotal: g && g.total, ghostCovered: g && g.covered, ghostAt1k: g && C.ghostAt(g, 1000), ghostAt2k: g && C.ghostAt(g, 2000), half, other, climbT: g && C.climbTimes(route, g),
        tank, easyBurned: easy.burned, spent, back: wb, loopLeg: leg, places, query: C.overpassQuery([home], 3000),
        rain: C.wxAlerts(mk([0, 0, 0.1, 0.6, 1.2, 0.8, 0, 0]), now), dry: C.wxAlerts(mk([0.8, 0.5, 0, 0, 0, 0, 0, 0]), now), none: C.wxAlerts(mk([0, 0, 0, 0, 0, 0, 0, 0]), now),
        wind: C.wxAlerts(mk([0, 0, 0, 0, 0, 0, 0, 0], [10, 12, 14, 20, 26, 28, 28, 28], [180, 190, 220, 260, 300, 310, 310, 310]), now), storm: C.wxAlerts(mk([0, 0, 0, 0, 0, 0, 0, 0], undefined, undefined, [3, 95, 3]), now) };
    }, PTS);
    expect(r.kinds).toEqual(["flat", "climb", "flat"]);
    expect(Math.abs(r.planTotal - 1500)).toBeLessThan(2);                                        // the plan adds up to the finish time
    expect(r.climbW).toBeGreaterThan(r.flatW);                                                   // harder up the climb
    expect(r.descentCap).toBe(true);                                                         // gravel descents held to 13 m/s
    expect(r.mid).toBe(1);
    expect(r.midPlanned).toBeCloseTo(r.climbEnd - r.climbSecs / 2, 0);
    expect(r.fastIf).toBeLessThanOrEqual(r.fastSustain + 0.01);                                  // the fastest you can hold, and no faster
    expect(r.lessIf).toBeGreaterThan(r.lessSustain);                                            // a minute faster is too much
    expect(r.round).toBeCloseTo(85, 5);
    expect(r.ghostCovered).toBeGreaterThan(0.95);
    expect(Math.abs(r.ghostAt1k - 125)).toBeLessThan(3);                                         // 1000 m at 8 m/s
    expect(Math.abs(r.ghostAt2k - 251)).toBeLessThan(4);                                         // the stop isn't on the clock
    expect(r.half).toBeNull();
    expect(r.other).toBeNull();
    expect(r.climbT[0]).toBeGreaterThan(100);
    expect(r.tank.full).toBe(488);
    expect(r.tank.burned).toBeGreaterThan(110);
    expect(r.tank.burned).toBeLessThan(140);
    expect(r.tank.eaten).toBe(60);
    expect(r.easyBurned).toBeLessThan(r.tank.burned / 2);                                        // easy riding burns mostly fat
    expect(r.spent).toBe(18000 - 200 * 60);
    expect(r.back).toBeGreaterThan(14000);
    expect(r.loopLeg / 1000 * 1.25).toBeGreaterThan(36);
    expect(r.loopLeg / 1000 * 1.25).toBeLessThan(44);
    expect(r.places.map(p => [p.kind, p.name])).toEqual([["water", "Drinking water"], ["food", "Gull Lake Coffee"], ["bike", "Village Cycle"]]);
    expect(r.places[1].hours).toBe("Mo-Su 07:00-15:00");
    expect(r.query).toContain("around:3000,42.73000,-84.55000");
    expect(r.rain.map(a => a.kind)).toEqual(["rain"]);
    expect(r.rain[0].text).toMatch(/^Rain in about 45 minutes, heavy\.$/);
    expect(r.dry[0].text).toMatch(/Rain easing in about 30 minutes/);
    expect(r.none).toEqual([]);
    expect(r.wind[0].kind).toBe("wind");
    expect(r.wind[0].text).toMatch(/from the northwest at 2\d km\/h/);
    expect(r.storm[0].kind).toBe("storm");
  });

  test("a race plan: the fastest finish you can hold, its sections, and the plan on the Workout screen as you ride", async ({ browser }) => {
    const ctx = await browser.newContext({ geolocation: geo(0, 0), permissions: ["geolocation"] });
    const page = await ctx.newPage();
    const problems = watch(page);
    await world(page);
    await page.goto(link());
    await loadRoute(page, "Barry-Roubaix short");
    await page.locator("#tab-ahead").click();
    await page.locator("#btn-pace").click();
    await expect(page.locator("#pc-surface")).toHaveValue("gravel");                            // from the route's name
    await page.locator("#pc-suggest").click();
    await expect(page.locator("#pc-time")).toHaveValue(/^0:\d\d$/);
    await expect(page.locator("#pc-sum")).toContainText("Holdable");
    await expect(page.locator("#pc-list li")).toHaveCount(3);
    await expect(page.locator("#pc-list li").nth(1)).toContainText("Climb");
    await expect(page.locator("#pc-list li").nth(1)).toContainText("bpm");
    expect(await axe(page)).toEqual([]);
    await page.locator("#pc-time").fill("0:08");                                                  // much too fast
    await page.locator("#pc-show").click();
    await expect(page.locator("#pc-sum")).toContainText("more than you can hold");
    await page.locator("#pc-time").fill("0:20");
    await page.locator("#pc-save").click();
    await expect(page.locator("#btn-pace")).toContainText("Race plan · 0:20");
    await expect(page.locator("#pace-tile")).toBeVisible();
    await page.locator("#tab-workout").click();
    await page.locator("#btn-start").click();
    for (const e of [10, 20, 30, 40]) { await ctx.setGeolocation(geo(e, 0)); await page.waitForTimeout(400); }
    await expect(page.locator("#step-name")).toContainText("Race plan · Flat 1/3");
    await expect(page.locator("#step-target")).toContainText("bpm");
    await expect(page.locator("#step-cue")).toContainText("left in this section");
    // the plan's clock against yours, once you've been on the route half a minute: 40 m in 40 s is behind a 20-minute plan
    await page.evaluate(() => { const S = /** @type {any} */ (window).__ride.S; S.routeT0 = S.elapsed - 40; });
    await expect(page.locator("#step-time")).toHaveText(/^\+\d+:\d\d$/);
    await expect(page.locator("#step-time")).toHaveClass(/behind/);
    await expect(page.locator("#step-cue")).toContainText("behind the plan");
    expect(quiet(problems)).toEqual([]);
    await ctx.close();
  });

  test("your past ride here is a ghost to race, and the climb says how you did against your best", async ({ browser }) => {
    const ctx = await browser.newContext({ geolocation: geo(0, 0), permissions: ["geolocation"] });
    const page = await ctx.newPage();
    const problems = watch(page);
    await world(page);
    await page.goto(link());
    // a ride kept on the phone from last week, along the same route at 6 m/s
    await page.evaluate(async pts => {
      const w = /** @type {any} */ (window).__ride, C = /** @type {any} */ (window).RideCore, route = C.analyze({ name: "x", points: pts }), samples = [];
      let t = Date.now() - 7 * 864e5;
      for (let d = 0; d <= route.total; d += 6) { const p = C.pointAt(route, d); samples.push([t, p.lat, p.lon, C.eleAt(route, d), 150, 85, null, 6, d]); t += 1000; }
      await w.DB.put("tracks", { id: "old1", samples });
      await w.DB.put("rides", { id: "old1", name: "Barry-Roubaix short · Oct 15", start: samples[0][0], end: t, elapsed: samples.length, moving: samples.length, dist: route.total, tss: 50, zones: [0, 0, 0, 0, 0], laps: [], startLL: [samples[0][1], samples[0][2]] });
    }, PTS);
    await loadRoute(page, "Barry-Roubaix short");
    await page.locator("#tab-ahead").click();
    await expect(page.locator("#ghost-tile")).toBeVisible();
    await expect(page.locator("#ghost-k")).toHaveText("Your best");
    await expect(page.locator("#ghost-delta")).toHaveText(/^0:1[0-9]:\d\d$|^0:\d\d$|^\d+:\d\d$/);
    await page.locator("#btn-start").click();
    for (const e of [10, 20, 30, 40, 50]) { await ctx.setGeolocation(geo(e, 0)); await page.waitForTimeout(400); }
    await expect(page.locator("#ghost-delta")).toHaveText(/^[−+]\d+:\d\d$/);
    const best = await page.evaluate(() => /** @type {any} */ (window).__ride.NAV.ghosts.climbBest[0]);
    expect(best).toBeGreaterThan(200);                                                           // 1.5 km at 6 m/s
    expect(quiet(problems)).toEqual([]);
    await ctx.close();
  });

  test("the fuel tank empties with the work and fills with what you eat; W′ when there's power", async ({ page }) => {
    const problems = watch(page);
    await world(page);
    await page.goto(link());
    await page.locator("#btn-start").click();
    await page.evaluate(() => { const w = /** @type {any} */ (window).__ride; w.live.power = 380; w.live.powerAt = Date.now() + 60000; w.live.hr = 165; w.live.hrAt = Date.now() + 60000; });
    await page.waitForTimeout(2500);
    await page.locator("#tab-data").click();
    await expect(page.locator("#d-fuel")).toHaveText(/^\d+%$/);
    await expect(page.locator("#d-fuel-s")).toContainText("g used");
    await expect(page.locator("#d-wbal-t")).toBeVisible();
    await expect(page.locator("#d-wbal")).not.toHaveText("100%");                                 // 380 W is over CP 260
    await page.evaluate(() => { const S = /** @type {any} */ (window).__ride.S; S.tank.left = S.tank.full * 0.39; });
    await page.locator("#tab-workout").click();
    await expect(page.locator("#suggest-text")).toContainText("Fuel tank at 40 percent");
    await expect(page.locator("#suggest-yes")).toBeHidden();                                    // nothing to undo
    await page.evaluate(() => { const S = /** @type {any} */ (window).__ride.S; S.fuelDue = true; });
    await page.waitForTimeout(1100);
    const before = await page.evaluate(() => /** @type {any} */ (window).__ride.S.tank.eaten);
    await page.locator("#fuel-ok").click();
    const after = await page.evaluate(() => /** @type {any} */ (window).__ride.S.tank.eaten);
    expect(after - before).toBe(20);
    expect(quiet(problems)).toEqual([]);
  });

  test("weather on the ride: rain coming is said before it gets here", async ({ browser }) => {
    const ctx = await browser.newContext({ geolocation: geo(0, 0), permissions: ["geolocation"] });
    const page = await ctx.newPage();
    const problems = watch(page);
    const now = Math.floor(Date.now() / 1000 / 900) * 900;
    await world(page, { forecast: () => ({ minutely_15: { time: [0, 1, 2, 3, 4, 5, 6, 7].map(i => now + i * 900), precipitation: [0, 0, 0, 0.4, 0.5, 0.2, 0, 0], wind_speed_10m: [12, 12, 12, 12, 12, 12, 12, 12], wind_direction_10m: [270, 270, 270, 270, 270, 270, 270, 270] },
      hourly: { time: [now, now + 3600, now + 7200], precipitation_probability: [10, 60, 20], weather_code: [2, 61, 3] } }) });
    await page.goto(link());
    await page.locator("#btn-start").click();
    await expect(page.locator("#suggest-text")).toContainText(/Rain in about \d+ minutes/, { timeout: 15000 });
    await expect(page.locator("#wx-src")).toContainText(/Rain in ~\d+ min/);
    expect(quiet(problems)).toEqual([]);
    await ctx.close();
  });

  test("going somewhere: home, a loop into the wind, a pin, what's nearby, and places along a route", async ({ browser }) => {
    const ctx = await browser.newContext({ geolocation: geo(0, 0), permissions: ["geolocation"] });
    const page = await ctx.newPage();
    const problems = watch(page);
    const cafe = at(1500, 40), water = at(4500, 1520);
    const calls = await world(page, {
      router: url => { const ll = new URL(url).searchParams.get("lonlats").split("|").map(s => s.split(",").map(Number)); const pts = []; for (let i = 0; i + 1 < ll.length; i++) for (let k = 0; k < 20; k++) pts.push({ lon: ll[i][0] + (ll[i + 1][0] - ll[i][0]) * k / 20, lat: ll[i][1] + (ll[i + 1][1] - ll[i][1]) * k / 20 }); pts.push({ lon: ll[ll.length - 1][0], lat: ll[ll.length - 1][1] }); return line(pts); },
      places: [{ type: "node", lat: cafe.lat, lon: cafe.lon, tags: { amenity: "cafe", name: "Gull Lake Coffee" } }, { type: "node", lat: water.lat, lon: water.lon, tags: { amenity: "drinking_water" } }],
    });
    await page.goto(link({ ...PLAN, units: "metric" }, "?page=map"));
    // places along a route come with it
    await loadRoute(page, "Gull Lake loop");
    await expect.poll(() => calls.overpass.length).toBeGreaterThan(0);
    expect(decodeURIComponent(calls.overpass[0])).toContain("around:150,");
    await page.locator("#tab-ahead").click();
    await expect(page.locator("#poi-list")).toContainText("Gull Lake Coffee");
    await expect(page.locator("#poi-list")).toContainText("Drinking water");
    await page.locator("#tab-map").click();
    // home: set here, ridden from somewhere else
    await page.locator("#btn-goto").click();
    await expect.poll(() => page.evaluate(() => !!(/** @type {any} */ (window).__ride.live.lastFix))).toBe(true);
    await page.locator("#go-sethome").click();
    await expect(page.locator("#go-msg")).toContainText("Home saved");
    await ctx.setGeolocation(geo(2000, -2000));
    await page.waitForTimeout(800);
    await page.locator("#go-home").click();
    await expect(page.locator("#goto")).toBeHidden();
    await expect(page.locator("#route-name")).toContainText("Home");
    expect(calls.router.pop()).toMatch(/lonlats=[^|]+\|[^|]+&/);                                  // from here to home
    // a 10 km loop, into the (west) wind first
    await page.locator("#btn-goto").click();
    await page.locator("#go-loop-n").fill("10");
    await page.locator("#go-loop").click();
    await expect(page.locator("#route-name")).toContainText("Loop 10 km");
    const loop = calls.router[calls.router.length - 1], ll = new URL(loop).searchParams.get("lonlats").split("|");
    expect(ll.length).toBe(5);
    expect(ll[0]).toBe(ll[4]);
    expect(Number(ll[2].split(",")[0])).toBeLessThan(Number(ll[0].split(",")[0]));            // the far point is west
    // what's nearby: a café, then the way to it
    await page.locator("#btn-goto").click();
    await page.locator("[data-near=food]").click();
    await expect(page.locator("#near-list li")).toHaveCount(1);
    await expect(page.locator("#near-list li")).toContainText("Gull Lake Coffee");
    await page.locator("#near-list button").click();
    await expect(page.locator("#route-name")).toContainText("Gull Lake Coffee");
    // a pin on the map (a long press there)
    await page.evaluate(([lat, lon]) => /** @type {any} */ (window).__ride.offerGo(lon, lat), [at(500, 500).lat, at(500, 500).lon]);
    await expect(page.locator("#mapgo")).toBeVisible();
    await page.locator("#mapgo-yes").click();
    await expect(page.locator("#route-name")).toContainText("To the pin");
    expect(quiet(problems)).toEqual([]);
    await ctx.close();
  });

  test("a ride saved as a route: ride it again later against itself", async ({ browser }) => {
    const ctx = await browser.newContext({ geolocation: geo(0, 0), permissions: ["geolocation"] });
    const page = await ctx.newPage();
    const problems = watch(page);
    await world(page);
    await page.goto(link());
    await page.locator("#btn-start").click();
    for (const e of [20, 40, 60, 80, 100, 120]) { await ctx.setGeolocation(geo(e, 0)); await page.waitForTimeout(500); }
    await page.locator("#btn-end").click();
    await page.locator("#ask-yes").click();   // the app's own confirmation sheet
    await page.locator("[data-export=route]").click();
    await expect(page.locator("#sum-sync")).toContainText("Saved as a route");
    const rows = await page.evaluate(async () => (await /** @type {any} */ (window).__ride.DB.all("routes")).map(r => ({ name: r.name, fromRide: !!r.fromRide, n: r.points.length })));
    expect(rows).toHaveLength(1);
    expect(rows[0].fromRide).toBe(true);
    expect(rows[0].n).toBeGreaterThan(1);
    expect(quiet(problems)).toEqual([]);
    await ctx.close();
  });
});
