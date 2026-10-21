// Ride mode as a cycling computer: routes in (GPX / TCX, picked, shared from another app), what's ahead (profile,
// climbs, turns, stops), turn-by-turn on the road with off course, wrong way and a BRouter detour back, the map under
// its CSP, recording with laps into FIT / GPX / TCX, and the workout tailored mid-ride. Every outside service is a
// stand-in here: OpenFreeMap, Open-Meteo and BRouter answer from the test.
import { test, expect } from "@playwright/test";
import { deflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { watch, axe } from "./fixtures.mjs";

test.use({ baseURL: "http://127.0.0.1:8766" });

// a 7.5 km route near Kalamazoo: 3 km east, LEFT onto a 1.5 km climb north at ~5%, RIGHT and 3 km east to the finish
const LAT0 = 42.29, LON0 = -85.59, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110540;
const at = (e, n) => ({ lat: LAT0 + n / KY, lon: LON0 + e / KX });
const geo = (e, n) => { const p = at(e, n); return { latitude: p.lat, longitude: p.lon, accuracy: 5 }; };
function course() {
  const pts = [];
  for (let e = 0; e <= 3000; e += 20) pts.push({ ...at(e, 0), ele: 250 });
  for (let n = 20; n <= 1500; n += 20) pts.push({ ...at(3000, n), ele: 250 + n * 0.05 });
  for (let e = 3020; e <= 6000; e += 20) pts.push({ ...at(e, 1500), ele: 325 });
  return pts;
}
const PTS = course();
const gpx = ({ cues = true, ele = true, name = "Gull Lake loop" } = {}) => `<?xml version="1.0"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
${cues ? `<wpt lat="${at(3000, 0).lat}" lon="${at(3000, 0).lon}"><name>Left</name><desc>Turn left onto Gull Rd</desc><type>Left</type></wpt>
<wpt lat="${at(3000, 1500).lat}" lon="${at(3000, 1500).lon}"><name>Right</name><desc>Turn right onto Ridge Rd</desc><type>Right</type></wpt>` : ""}
<wpt lat="${at(4500, 1505).lat}" lon="${at(4500, 1505).lon}"><name>Fire hall water</name><type>Water</type></wpt>
<trk><name>${name}</name><trkseg>
${PTS.map(p => `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${ele ? `<ele>${p.ele}</ele>` : ""}</trkpt>`).join("\n")}
</trkseg></trk></gpx>`;
const file = (body = gpx(), name = "gull-lake.gpx") => ({ name, mimeType: "application/gpx+xml", buffer: Buffer.from(body) });

const today = new Date();
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const step = (name, min, zone, lo, hi, cue = "") => ({ name, min, zone, lo, hi, cue });
const PLAN = { lthr: 160, max_hr: 185, rest_hr: 50, sex: "male", wheel_m: 2.29, fuel_every_min: 20, units: "metric", ftp: 250,
  days: [{ date: iso(today), title: "VO2", session: "VO2", minutes: 45, load: 60, indoor: false,
    steps: [step("Warm-up", 15, "z2", 81, 89), step("VO2 1/3", 4, "z5", 100, 106), step("Easy", 4, "z1", 0, 81), step("VO2 2/3", 4, "z5", 100, 106), step("Easy", 4, "z1", 0, 81), step("VO2 3/3", 4, "z5", 100, 106), step("Cool-down", 10, "z1", 0, 81)] }] };
const link = plan => "/ride.html#z=" + deflateRawSync(Buffer.from(JSON.stringify(plan))).toString("base64url");

const JSONH = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
/** The outside world: no map server (unless a style is given), calm weather, and a BRouter that knows one way back. */
async function world(page, { style = null, router = null } = {}) {
  const calls = { router: [], tiles: 0 };
  await page.context().route("https://tiles.openfreemap.org/**", route => {
    calls.tiles++;
    const u = new URL(route.request().url());
    if (style && u.pathname.startsWith("/styles/")) return route.fulfill({ status: 200, headers: JSONH, body: JSON.stringify(style) });
    return route.fulfill({ status: 404, headers: { "Access-Control-Allow-Origin": "*" }, body: "" });
  });
  await page.context().route("https://api.open-meteo.com/**", route => route.fulfill({ status: 200, headers: JSONH, body: JSON.stringify({
    current: { temperature_2m: 12, apparent_temperature: 11, wind_speed_10m: 20, wind_direction_10m: 90, wind_gusts_10m: 25 }, hourly: { precipitation_probability: [0, 0, 0] } }) }));
  await page.context().route("https://brouter.de/**", route => { calls.router.push(route.request().url()); return router ? route.fulfill({ status: 200, headers: JSONH, body: JSON.stringify(router) }) : route.fulfill({ status: 503, body: "" }); });
  return calls;
}
const quiet = problems => problems.filter(p => !/Failed to load resource|status of (404|503)/.test(p));
/** @param {import("@playwright/test").Page} page */
async function loadRoute(page, f = file()) {
  await page.locator("#tab-map").click();
  await page.locator("#btn-routes").click();
  await page.locator("#route-file").setInputFiles(f);
  await expect(page.locator("#route-msg")).toContainText("Loaded");
  await page.locator("#routes .actions button[value=close]").click();
}

test.describe("the cycling computer", () => {
  test("the engine: GPX and TCX in, distance, climbs, turns and stops, and the sun", async ({ page }) => {
    await page.goto("/ride.html");
    const r = await page.evaluate(([g1, g2]) => {
      const C = /** @type {any} */ (window).RideCore;
      const a = C.analyze(C.parseRoute(g1, "gull.gpx")), b = C.analyze(C.parseRoute(g2, "x.gpx"));
      const tcx = `<?xml version="1.0"?><TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Courses><Course><Name>Iceman</Name><Track>
        <Trackpoint><Position><LatitudeDegrees>44.7</LatitudeDegrees><LongitudeDegrees>-85.6</LongitudeDegrees></Position><AltitudeMeters>300</AltitudeMeters></Trackpoint>
        <Trackpoint><Position><LatitudeDegrees>44.71</LatitudeDegrees><LongitudeDegrees>-85.6</LongitudeDegrees></Position><AltitudeMeters>310</AltitudeMeters></Trackpoint></Track>
        <CoursePoint><Name>Aid 1</Name><Position><LatitudeDegrees>44.705</LatitudeDegrees><LongitudeDegrees>-85.6</LongitudeDegrees></Position><PointType>Food</PointType></CoursePoint></Course></Courses></TrainingCenterDatabase>`;
      const t = C.analyze(C.parseRoute(tcx, "iceman.tcx"));
      let bad = "";
      try { C.parseRoute("<html></html>", "x.html"); } catch (e) { bad = e.message; }
      const evil = C.parseRoute(g1.replace("<name>Gull Lake loop</name>", "<name>&lt;img src=x onerror=&quot;window.__pwned=1&quot;&gt;<![CDATA[<b>x</b>]]></name>"), "e.gpx");
      if (evil.name !== '<img src=x onerror="window.__pwned=1"><b>x</b>') bad = `markup changed: ${evil.name}`;   // read as text, never parsed as HTML
      const sun = C.sunTimes(new Date("2026-11-07T12:00:00-05:00"), 44.7, -85.6);
      return { name: a.name, total: Math.round(a.total), gain: Math.round(a.gain), climbs: a.climbs.map(c => ({ len: Math.round(c.len / 100) * 100, g: Math.round(c.grade * 100) })),
        turns: a.turns.map(x => [x.kind, x.name, Math.round(x.along / 100) * 100]), pois: a.pois.map(p => [p.kind, p.name]),
        derived: b.turns.map(x => [x.kind, Math.round(x.along / 100) * 100]), tcx: [t.name, t.pois[0].kind, t.pois[0].name, Math.round(t.total)], bad,
        sunset: new Date(sun.sunset).toISOString().slice(11, 16) };
    }, [gpx(), gpx({ cues: false })]);
    expect(r.name).toBe("Gull Lake loop");
    expect(r.total).toBeGreaterThan(7400); expect(r.total).toBeLessThan(7600);
    expect(r.gain).toBeGreaterThan(65); expect(r.gain).toBeLessThan(80);
    expect(r.climbs).toEqual([{ len: 1500, g: 5 }]);
    expect(r.turns).toEqual([["left", "Turn left onto Gull Rd", 3000], ["right", "Turn right onto Ridge Rd", 4500]]);   // the file's own cues
    expect(r.derived).toEqual([["left", 3000], ["right", 4500]]);                          // or read off the line
    expect(r.pois).toEqual([["water", "Fire hall water"]]);
    expect(r.tcx).toEqual(["Iceman", "food", "Aid 1", 1112]);
    expect(r.bad).toMatch(/GPX|TCX/);
    expect(r.sunset).toBe("22:25");                                                         // 5:25 pm EST at Iceman
  });

  test("the workout, tailored: one more rep, cut the set, fit the time, and quick workouts", async ({ page }) => {
    await page.goto("/ride.html");
    const r = await page.evaluate(() => {
      const C = /** @type {any} */ (window).RideCore;
      const v = C.quick("vo2", 60), names = s => s.map(x => x.name), mins = s => s.slice(1).reduce((a, x) => a + x.min, 0);
      return { vo2: names(v), more: names(C.addRep(v, 3)), cut: names(C.cutSet(v, 3)), fit: mins(C.fitTime(v, 1, 0, 30)), fitNames: names(C.fitTime(v, 1, 0, 30)),
        longer: names(C.fitTime(v, 0, 0, 90)), ftp: Math.round(C.ftpPct(97)) };
    });
    expect(r.vo2).toEqual(["Warm-up", "VO2 1/4", "Easy", "VO2 2/4", "Easy", "VO2 3/4", "Easy", "VO2 4/4", "Cool-down"]);
    expect(r.more).toEqual(["Warm-up", "VO2 1/5", "Easy", "VO2 2/5", "Easy", "VO2 3/5", "Easy", "VO2 4/5", "Easy", "VO2 5/5", "Cool-down"]);
    expect(r.cut).toEqual(["Warm-up", "VO2 1/4", "Easy", "VO2 2/4", "Cool-down"]);
    expect(r.fit).toBe(30);
    expect(r.fitNames.filter(n => n.startsWith("VO2")).length).toBe(3);                   // a rep dropped, the cool-down kept
    expect(r.longer).toContain("Endurance (added)");
    expect(r.ftp).toBeGreaterThan(92); expect(r.ftp).toBeLessThan(98);
  });

  test("rerouting looks forward: places on the route ahead in your direction, the blockage avoided, no U-turn start", async ({ page }) => {
    await page.goto("/ride.html");
    const r = await page.evaluate(([at0, kx, ky]) => {
      const C = /** @type {any} */ (window).RideCore, at = (e, n) => ({ lat: at0[0] + n / ky, lon: at0[1] + e / kx });
      const pts = []; for (let e = 0; e <= 3000; e += 20) pts.push({ ...at(e, 0), ele: 200 });
      const route = C.analyze({ name: "R", points: pts }), nav = C.navigator(route);
      let t = 0;
      for (const e of [900, 950, 1000]) nav.update(at(e, 0), 90, 6, t += 2000);        // on the route, then a locked gate at 1050
      const here = at(1500, 250);                                                      // 250 m north on a parallel road, eastbound
      const o = nav.rejoinOptions(here, 90);
      const line = ps => C.fromBRouter({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: ps.map(p => [p.lon, p.lat]) } }] });
      const uturn = line([here, at(1300, 250), at(1300, 0), at(1650, 0)]), ahead = line([here, at(1900, 250), at(1900, 0), at(2000, 0)]);
      const best = C.pickDetour(route, [{ detour: uturn, option: { along: 1650 } }, { detour: ahead, option: { along: 2000 } }], 90, o.minAlong);
      return { first: Math.round(o.options[0].along), all: o.options.map(x => x.along >= 1550), n: o.options.length, gate: Math.round(C.hav(o.avoid, at(1060, 0))),
        pick: best.option.along, url: C.brouterUrl(here, o.options[0], "trekking", undefined, [o.avoid]) };
    }, [[LAT0, LON0], KX, KY]);
    expect(r.n).toBe(3);
    expect(r.all).toEqual([true, true, true]);                                         // all ahead of where you are, none back at the gate
    expect(r.first).toBeGreaterThan(1550); expect(r.first).toBeLessThan(1800);
    expect(r.gate).toBeLessThan(5);                                                    // the spot you left becomes a no-go
    expect(r.url).toMatch(/&nogos=-85\.5\d+,42\.29\d*,40$/);
    expect(r.pick).toBe(2000);                                                         // the forward way back beats the U-turn
  });

  test("the commute check judges steady riding only: stop-and-go city riding gets no verdict", async ({ page }) => {
    await page.goto("/ride.html");
    const r = await page.evaluate(() => {
      const C = /** @type {any} */ (window).RideCore, model = { model: [100, 1.6] };      // usual HR = 100 + 1.6 × km/h
      const ride = (hr, steady) => Array.from({ length: 480 }, (_, i) => ({ t: 100 + i, hr, kmh: 25, steady }));
      return {
        hot: C.commuteCheck(ride(150, true), model, [], 580).verdict,                       // +10 on steady riding
        normal: C.commuteCheck(ride(143, true), model, [], 580).verdict,                    // +3
        fresh: C.commuteCheck(ride(133, true), model, [], 580).verdict,
        city: C.commuteCheck(ride(160, true), model, [200, 300, 400, 500], 580).verdict,     // 4 stops in 10 min
        lights: C.commuteCheck(ride(160, false), model, [], 580),                           // never steady: no verdict
        early: C.commuteCheck(ride(160, true), model, [], 300),                             // under 8 minutes in
      };
    });
    expect(r).toEqual({ hot: "hot", normal: "normal", fresh: "fresh", city: "city", lights: null, early: null });
  });

  test("a FIT file a decoder accepts: header, CRCs, records, laps, session", async ({ page }) => {
    await page.goto("/ride.html");
    const bytes = await page.evaluate(() => {
      const C = /** @type {any} */ (window).RideCore, t0 = Date.parse("2026-10-20T14:00:00Z"), samples = [];
      for (let i = 0; i < 120; i++) samples.push([t0 + i * 1000, 42.29 + i * 1e-4, -85.59, 250 + i * 0.1, 140, 88, 220, 8, i * 8]);
      return [...C.toFIT({ name: "t", start: t0, samples, laps: [{ start: t0, end: t0 + 59000 }, { start: t0 + 60000, end: t0 + 119000 }], tss: 9 })];
    });
    const b = Uint8Array.from(bytes), dv = new DataView(b.buffer);
    expect(String.fromCharCode(...b.slice(8, 12))).toBe(".FIT");
    expect(dv.getUint32(4, true)).toBe(b.length - 16);
    const crc = (arr) => { const T = [0, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400]; let c = 0; for (const x of arr) { let t = T[c & 15]; c = (c >> 4) & 0xFFF; c ^= t ^ T[x & 15]; t = T[c & 15]; c = (c >> 4) & 0xFFF; c ^= t ^ T[(x >> 4) & 15]; } return c; };
    expect(dv.getUint16(12, true)).toBe(crc(b.slice(0, 12)));
    expect(crc(b)).toBe(0);                                                                   // the file CRC closes over everything
    // walk the messages: count records (20), laps (19), sessions (18), activities (34)
    const defs = {}, seen = {};
    for (let o = 14; o < b.length - 2;) {
      const h = b[o++], local = h & 15;
      if (h & 0x40) { const g = dv.getUint16(o + 2, true), n = b[o + 4]; let size = 0; for (let i = 0; i < n; i++) size += b[o + 6 + i * 3]; defs[local] = { g, size }; o += 5 + n * 3; }
      else { seen[defs[local].g] = (seen[defs[local].g] || 0) + 1; o += defs[local].size; }
    }
    expect(seen).toMatchObject({ 0: 1, 20: 120, 19: 2, 18: 1, 34: 1 });
  });

  test("a route from a file: the map, then what's ahead — profile, the climb, turns and the water stop", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: geo(500, 0), permissions: ["geolocation"] });
    const page = await ctx.newPage();
    const problems = watch(page);
    await world(page);
    await page.goto(link(PLAN));
    await loadRoute(page);
    await expect(page.locator("#route-name")).toContainText(/^Gull Lake loop · 7\.5 km · 7\d m up$/);
    await expect(page.locator("#map, #crumb").first()).toBeAttached();
    await page.locator("#tab-ahead").click();
    await expect(page.locator("#ahead")).toBeVisible();
    await expect(page.locator("#climb-k")).toContainText("Next climb · 1 of 1");
    await expect(page.locator("#climb-sub")).toContainText(/1\.5 km at (4\.\d|5\.0)% \(max 5%\) · 7\d m up/);
    await expect(page.locator("#turn-list li").first()).toContainText("Turn left onto Gull Rd");
    await expect(page.locator("#poi-list")).toContainText("Fire hall water");
    expect(await axe(page)).toEqual([]);
    await page.reload();                                                                      // the route is kept, and chosen
    await expect(page.locator("#ahead")).toBeVisible();
    await page.locator("#tab-data").click();
    expect(await axe(page)).toEqual([]);
    await page.locator("#tab-laps").click();
    expect(await axe(page)).toEqual([]);
    await page.locator("#btn-rides").click();
    await expect(page.locator("#ride-list")).toContainText("No saved rides yet");
    expect(await axe(page)).toEqual([]);
    expect(quiet(problems)).toEqual([]);
    await ctx.close();
  });

  test("turn by turn: the next turn ahead, off course with the way back, a detour, and back on the route", async ({ browser }) => {
    const ctx = await browser.newContext({ geolocation: geo(2000, 0), permissions: ["geolocation"] });
    const page = await ctx.newPage();
    const problems = watch(page);
    // the way back BRouter finds: from 300 m south of the route, north to it, then RIGHT along it (a voice hint)
    const back = [at(2300, -300), at(2300, -150), at(2300, 0), at(2600, 0)];
    const calls = await world(page, { router: { type: "FeatureCollection", features: [{ type: "Feature", properties: { voicehints: [[2, 5, 0, 300, 90]] },
      geometry: { type: "LineString", coordinates: back.map(p => [p.lon, p.lat, 250]) } }] } });
    await page.goto("/ride.html");
    await page.evaluate(() => localStorage.setItem("fitness-ride-prefs", JSON.stringify({ reroute: false })));   // the Reroute button, not the automatic one
    await page.goto("/ride.html?page=map#z=" + deflateRawSync(Buffer.from(JSON.stringify({ ...PLAN, days: [] }))).toString("base64url"));   // metric
    await page.locator("#btn-routes").click();
    await page.locator("#route-file").setInputFiles(file());
    await expect(page.locator("#route-msg")).toContainText("Loaded");
    await page.locator("#routes .actions button[value=close]").click();
    await page.locator("#btn-start").click();
    for (const e of [2050, 2100, 2150, 2200]) { await ctx.setGeolocation(geo(e, 0)); await page.waitForTimeout(300); }
    await expect(page.locator("#navbanner")).toBeVisible();
    await expect(page.locator("#nb-what")).toContainText("Turn left onto Gull Rd");
    await expect(page.locator("#nb-dist")).toHaveText(/^(8\d0|7\d0) m$/);
    // off course: 300 m south for long enough, and the router asked for a way back
    await ctx.setGeolocation(geo(2300, -300));
    await expect(page.locator("#navbanner")).toHaveClass(/alert/, { timeout: 12000 });
    await expect(page.locator("#nb-what")).toContainText("Off course");
    await page.evaluate(() => { const w = /** @type {any} */ (window).__ride; w.live.gpsSpeed = 5; w.live.gpsAt = Date.now(); });
    await page.locator("#nb-action").click();
    await expect.poll(() => calls.router.length).toBeGreaterThan(0);
    expect(calls.router[0]).toContain("profile=trekking");
    await expect(page.locator("#nb-what")).toContainText("Turn right", { timeout: 5000 });     // the detour's own turn
    for (const p of [geo(2300, -150), geo(2300, 0), geo(2400, 0), geo(2500, 0)]) { await ctx.setGeolocation(p); await page.waitForTimeout(400); }
    await expect(page.locator("#nb-what")).toContainText("Gull Rd", { timeout: 8000 });         // back on the route, its next turn
    await expect(page.locator("#navbanner")).not.toHaveClass(/alert/);
    expect(quiet(problems)).toEqual([]);
    await ctx.close();
  });

  test("off course on the ride, it finds the way back by itself", async ({ browser }) => {
    const ctx = await browser.newContext({ geolocation: geo(1000, 0), permissions: ["geolocation"] });
    const page = await ctx.newPage();
    const back = [at(1500, -200), at(1500, 0), at(1800, 0)];
    const calls = await world(page, { router: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: back.map(p => [p.lon, p.lat]) } }] } });
    await page.goto("/ride.html?page=ahead");
    await page.locator("#btn-routes-2").click();
    await page.locator("#route-file").setInputFiles(file());
    await expect(page.locator("#route-msg")).toContainText("Loaded");
    await page.locator("#routes .actions button[value=close]").click();
    await page.locator("#btn-start").click();
    for (const e of [1005, 1010, 1015]) { await ctx.setGeolocation(geo(e, 0)); await page.waitForTimeout(400); }   // riding, ~12 m/s
    await ctx.setGeolocation(geo(1500, -200));                                                  // (a jump: its speed is ignored)
    await expect.poll(() => calls.router.length, { timeout: 15000 }).toBeGreaterThan(0);
    expect(calls.router[0]).toMatch(/lonlats=-85\.5\d+,42\.28\d+\|-85\.5\d+,42\.29\d+/);       // from here to the route ahead
    await ctx.close();
  });

  test("recording: laps, End, the summary, and FIT / GPX / TCX downloads; the ride is kept", async ({ browser }) => {
    const ctx = await browser.newContext({ geolocation: geo(0, 0), permissions: ["geolocation"], acceptDownloads: true });
    const page = await ctx.newPage();
    const problems = watch(page);
    await world(page);
    await page.goto(link({ ...PLAN, days: [] }));
    await page.locator("#btn-start").click();
    for (const e of [5, 10, 15]) { await ctx.setGeolocation(geo(e, 0)); await page.waitForTimeout(800); }
    await page.locator("#btn-lap").click();
    for (const e of [20, 25]) { await ctx.setGeolocation(geo(e, 0)); await page.waitForTimeout(800); }
    page.once("dialog", d => d.accept());
    await page.locator("#btn-end").click();
    await expect(page.locator("#summary")).toBeVisible();
    await expect(page.locator("#sum-body")).toContainText("laps");
    await expect(page.locator("#sum-body .did")).toContainText("What this ride did");
    expect(await axe(page)).toEqual([]);
    const get = async kind => { const [dl] = await Promise.all([page.waitForEvent("download"), page.locator(`[data-export=${kind}]`).click()]); return { name: dl.suggestedFilename(), body: readFileSync(await dl.path()) }; };
    const fit = await get("fit");
    expect(fit.name).toMatch(/\.fit$/);
    expect(fit.body.subarray(8, 12).toString()).toBe(".FIT");
    const g = await get("gpx");
    expect(g.body.toString()).toContain("<trkpt lat=\"42.29");
    const t = await get("tcx");
    expect(t.body.toString()).toContain("<Lap StartTime=");
    await page.locator("#summary button[value=close]").click();
    await page.locator("#tab-laps").click();
    await page.locator("#btn-rides").click();
    await expect(page.locator("#ride-list li")).toHaveCount(1);
    await page.locator("#ride-list [data-open]").click();
    await expect(page.locator("#summary")).toBeVisible();
    expect(quiet(problems)).toEqual([]);
    await ctx.close();
  });

  test("the app adjusts the session itself and says so, with Undo; the Change sheet is for when life changes the ride", async ({ page }) => {
    const problems = watch(page);
    await world(page);
    await page.goto(link(PLAN));
    await expect(page.locator("#w-easier, #w-harder")).toHaveCount(0);                     // no knobs: the app decides
    await page.locator("#btn-start").click();
    await expect(page.locator("#step-name")).toContainText("Warm-up  ·  1/7");
    await expect(page.locator("#step-target")).toContainText("130–142");
    await page.locator("#btn-skip").click();
    await expect(page.locator("#step-target")).toContainText("160–170");
    await expect(page.locator("#step-target")).toContainText("W");                              // FTP from the plan: a power target too
    // two reps where heart rate never reached the target: the rest of the set is cut, announced, and can be undone
    await page.evaluate(() => { const r = /** @type {any} */ (window).__ride; r.S.missed = 1; r.rep.n = 60; r.rep.under = 60; });
    await page.locator("#btn-skip").click();
    await expect(page.locator("#suggest-text")).toContainText("rest of the set is cut");
    expect(await page.evaluate(() => /** @type {any} */ (window).__ride.S.plan.map(s => s.name))).toEqual(["Warm-up", "VO2 1/3", "Easy", "Cool-down"]);
    await page.locator("#suggest-yes").click();                                                // Undo
    expect(await page.evaluate(() => /** @type {any} */ (window).__ride.S.plan.length)).toBe(7);
    await page.locator("#w-tailor").click();
    expect(await axe(page)).toEqual([]);
    await page.locator("[data-tl=rep]").click();
    await expect(page.locator("#step-name")).toContainText("Easy  ·  3/9");
    await page.locator("#w-tailor").click();
    await page.locator("#tl-left").fill("20");
    await page.locator("[data-tl=fit]").click();
    const left = await page.evaluate(() => { const S = /** @type {any} */ (window).__ride.S; return S.plan.slice(S.step).reduce((a, s) => a + s.min, 0) - (S.elapsed - S.stepStart) / 60; });
    expect(Math.round(left)).toBe(20);
    await page.locator("#w-tailor").click();
    await page.locator("#tl-kind").selectOption("threshold");
    await page.locator("#tl-min").fill("60");
    await page.locator("[data-tl=quick]").click();
    await expect(page.locator("#step-name")).toContainText("Warm-up");
    await expect(page.locator("#day")).toHaveValue("quick");
    expect(problems).toEqual([]);
  });

  test("a GPX shared from another app (Android's share sheet) lands in the route list", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await world(page);
    await page.goto("/ride.html");
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.reload();
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const held = await page.evaluate(async body => {
      const f = new FormData();
      f.append("route", new File([body], "shared ride.gpx", { type: "application/gpx+xml" }));
      await fetch("ride.html?share=1", { method: "POST", body: f });                         // what Android's share sheet sends
      return (await (await caches.open("fitness-inbox")).keys()).length;
    }, gpx({ name: "Shared from Komoot" }));
    expect(held).toBe(1);
    await page.goto("/ride.html?inbox=1");
    await expect(page.locator("#routes")).toBeVisible();
    await expect(page.locator("#route-list")).toContainText("Shared from Komoot");
    await expect(page.locator("#route-name")).toContainText("Shared from Komoot");
    await ctx.close();
  });

  test("the map runs under the page's CSP (module, worker and all), or the drawn route stands in", async ({ browser }) => {
    const ctx = await browser.newContext({ geolocation: geo(500, 0), permissions: ["geolocation"] });
    const page = await ctx.newPage();
    const problems = watch(page);
    const style = { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#e7e3da" } }], glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf" };
    await world(page, { style });
    await page.goto("/ride.html");
    await loadRoute(page);
    await page.locator("#btn-start").click();
    await ctx.setGeolocation(geo(560, 0));
    await expect(page.locator(".maplibregl-canvas, #crumb:not([hidden])").first()).toBeVisible({ timeout: 15000 });
    const usedMap = await page.locator(".maplibregl-canvas").count();
    if (usedMap) await expect(page.locator(".me")).toBeAttached();
    await page.locator("#m-orient").click();
    await expect(page.locator("#m-orient")).toHaveText("N Up");
    expect(quiet(problems).filter(p => !/WebGL|GPU|context/i.test(p))).toEqual([]);              // no CSP violation from the map
    await ctx.close();
  });

  test("a route with no heights asks Open-Meteo for them", async ({ page }) => {
    await world(page);
    let asked = 0;
    await page.route("https://api.open-meteo.com/v1/elevation**", route => {
      asked++;
      const n = new URL(route.request().url()).searchParams.get("latitude").split(",").length;
      return route.fulfill({ status: 200, headers: JSONH, body: JSON.stringify({ elevation: Array.from({ length: n }, (_, i) => 200 + i) }) });
    });
    await page.goto("/ride.html?page=map");
    await page.locator("#btn-routes").click();
    await page.locator("#route-file").setInputFiles(file(gpx({ ele: false, name: "Flat file" })));
    await expect.poll(() => asked).toBeGreaterThan(0);
    await page.locator("#routes .actions button[value=close]").click();
    await expect(page.locator("#route-name")).toContainText(/\d+ ft up/, { timeout: 8000 });
  });
});
