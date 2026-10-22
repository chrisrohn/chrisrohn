// Ride mode beyond a loaded route, the way a head unit does it: the climbs on the road ahead with no route (the road
// followed through the map tiles, its heights from a stand-in elevation API), the wind's cost on your line, the Data
// screen's fields chosen and sized on the bars, and the way back to the start. Every outside service is a stand-in.
import { test, expect } from "@playwright/test";
import { deflateRawSync } from "node:zlib";
import { watch, axe } from "./fixtures.mjs";
import { encodeTile } from "./mvt.mjs";

test.use({ baseURL: "http://127.0.0.1:8766" });

const LAT0 = 42.29, LON0 = -85.59, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110540;
const at = (e, n) => ({ lat: LAT0 + n / KY, lon: LON0 + e / KX });
const geo = (e, n) => { const p = at(e, n); return { latitude: p.lat, longitude: p.lon, accuracy: 5 }; };
const link = (plan = {}) => "/ride.html#z=" + deflateRawSync(Buffer.from(JSON.stringify({ lthr: 160, max_hr: 185, rest_hr: 50, units: "metric", days: [], ...plan }))).toString("base64url");
const JSONH = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
// the ground: flat at 250 m, then Hill Road climbs 72 m between 1500 and 2700 m north (6%), then flat again
const ground = n => 250 + Math.min(1200, Math.max(0, n - 1500)) * 0.06;

/** Weather (wind from `windFrom` at `wind` km/h), heights from `ground`, and no map server beyond what's cached. */
async function world(page, { wind = 0, windFrom = 0 } = {}) {
  const calls = { elevation: 0, router: [] };
  await page.context().route("https://tiles.openfreemap.org/**", route => route.fulfill({ status: 404, headers: { "Access-Control-Allow-Origin": "*" }, body: "" }));
  await page.context().route("https://api.open-meteo.com/**", route => {
    const u = new URL(route.request().url());
    if (u.pathname === "/v1/elevation") {
      calls.elevation++;
      const lat = (u.searchParams.get("latitude") || "").split(",").map(Number);
      return route.fulfill({ status: 200, headers: JSONH, body: JSON.stringify({ elevation: lat.map(la => ground((la - LAT0) * KY)) }) });
    }
    return route.fulfill({ status: 200, headers: JSONH, body: JSON.stringify({ current: { temperature_2m: 12, apparent_temperature: 11, wind_speed_10m: wind, wind_direction_10m: windFrom, wind_gusts_10m: wind }, hourly: { precipitation_probability: [0, 0, 0] } }) });
  });
  await page.context().route("https://brouter.de/**", route => { calls.router.push(route.request().url()); return route.fulfill({ status: 503, body: "" }); });
  return calls;
}
/** The map on the phone: Hill Road north from the start, a side street east off it at 800 m, all cached like a saved map. */
async function roads(page) {
  const z = 14, line = (name, cls, pts) => ({ name, cls, coords: pts.map(([e, n]) => { const p = at(e, n); return [p.lon, p.lat]; }) });
  const list = [line("Hill Road", "tertiary", [[0, -500], [0, 800], [5, 1500], [0, 2700], [0, 6500]]), line("Elm Street", "minor", [[0, 800], [1500, 820]])];
  const tile = (lat, lon) => { const n = 2 ** z, x = Math.floor((lon + 180) / 360 * n), s = Math.sin(lat * Math.PI / 180); return [x, Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n)]; };
  const [x0, y0] = tile(at(-2000, 8000).lat, at(-2000, 8000).lon), [x1, y1] = tile(at(2000, -2000).lat, at(2000, -2000).lon), tiles = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    const body = encodeTile(z, x, y, { transportation: list.map(r => ({ props: { class: r.cls }, coords: r.coords })), transportation_name: list.map(r => ({ props: { class: r.cls, name: r.name }, coords: r.coords })) });
    tiles.push({ url: `https://tiles.openfreemap.org/planet/test/${z}/${x}/${y}.pbf`, body: Array.from(body) });
  }
  await page.evaluate(async ts => {
    const c = await caches.open("fitness-tiles"), J = { "Content-Type": "application/json" };
    await c.put("https://tiles.openfreemap.org/styles/liberty", new Response(JSON.stringify({ version: 8, sources: { openmaptiles: { type: "vector", url: "https://tiles.openfreemap.org/planet" } }, layers: [] }), { headers: J }));
    await c.put("https://tiles.openfreemap.org/planet", new Response(JSON.stringify({ tiles: ["https://tiles.openfreemap.org/planet/test/{z}/{x}/{y}.pbf"] }), { headers: J }));
    for (const t of ts) await c.put(t.url, new Response(new Uint8Array(t.body)));
  }, tiles);
}
/** A fix at (east, north) m, riding at 6 m/s on a heading. */
async function ride(page, ctx, e, n, heading = 0) {
  await ctx.setGeolocation(geo(e, n));
  await page.evaluate(({ p, heading }) => {
    const w = /** @type {any} */ (window).__ride;
    Object.assign(w.live, { gpsSpeed: 6, gpsAt: Date.now(), heading });
    w.onFix({ lat: p.lat, lon: p.lon, t: Date.now() });
  }, { p: at(e, n), heading });
  await page.waitForTimeout(150);
}
const quiet = problems => problems.filter(p => !/Failed to load resource|status of (404|503)/.test(p));

test.describe("beyond the route", () => {
  test("no route: the climb on the road ahead, from the map and the heights, on Ahead, Workout and in the voice", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 870 }, geolocation: geo(0, 0), permissions: ["geolocation"] });
    const page = await ctx.newPage();
    const problems = watch(page);
    const calls = await world(page);
    await page.goto(link());
    await roads(page);
    await page.evaluate(() => { const w = /** @type {any} */ (window); w.__said = []; speechSynthesis.speak = u => w.__said.push(u.text); });
    await page.locator("#btn-start").click();
    for (const n of [0, 20, 40]) await ride(page, ctx, 0, n);                                     // north on Hill Road, past nothing yet
    await expect.poll(() => page.evaluate(() => !!(/** @type {any} */ (window).__ride.FREE.route)), { timeout: 15000 }).toBe(true);
    const free = await page.evaluate(() => { const F = /** @type {any} */ (window).__ride.FREE; return { name: F.route.name, total: F.route.total, climbs: F.route.climbs.map(c => ({ start: c.start, len: c.len, gain: c.gain, grade: c.grade })) }; });
    expect(free.name).toBe("Hill Road");                                                         // straight on at Elm Street, not off east
    expect(free.total).toBeGreaterThan(4000);
    expect(free.climbs).toHaveLength(1);
    expect(free.climbs[0].start).toBeGreaterThan(1300);
    expect(free.climbs[0].start).toBeLessThan(1700);
    expect(free.climbs[0].gain).toBeGreaterThan(60);
    expect(calls.elevation).toBeGreaterThan(0);
    await page.locator("#tab-ahead").click();
    await expect(page.locator("#free")).toBeVisible();
    await expect(page.locator("#free-k")).toContainText("Road ahead · Hill Road");
    await expect(page.locator("#free-climb-k")).toContainText("Next climb · 1 of 1");
    await expect(page.locator("#free-list li")).toHaveCount(1);
    await expect(page.locator("#free-list")).toContainText(/at (5\.\d|6\.\d)%/);
    expect(await axe(page)).toEqual([]);
    await page.locator("#tab-workout").click();
    await expect(page.locator("#climbstrip")).toBeVisible();                                   // under 2 km out: the strip
    await expect(page.locator("#cs-k")).toHaveText("Climb ahead");
    for (const n of [1200, 1260, 1320]) await ride(page, ctx, 0, n);                             // 300 m before its foot: said
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__said.join(" | "))).toMatch(/Climb in .+ at [56] percent/);
    for (const n of [1700, 1800]) await ride(page, ctx, 0, n);                                   // on it: to the top
    await expect(page.locator("#cs-k")).toHaveText("Climbing");
    await expect(page.locator("#cs-main")).toContainText("to the top");
    await page.locator("#tab-data").click();
    await expect(page.locator("#d-grade")).toContainText(/^[56]\.\d%$/);                         // the grade under you, with no route
    expect(quiet(problems)).toEqual([]);
    await ctx.close();
  });

  test("climbs ahead can be filtered by category, or turned off", async ({ browser }) => {
    const ctx = await browser.newContext({ geolocation: geo(0, 0), permissions: ["geolocation"] });
    const page = await ctx.newPage();
    await world(page);
    await page.goto(link());
    await roads(page);
    await page.click("#btn-settings");
    await page.locator("#s-freeride").selectOption("cat3");                                     // a 72 m, 6% climb scores under Cat 3
    await page.click("#s-save");
    await page.locator("#btn-start").click();
    for (const n of [0, 20, 40]) await ride(page, ctx, 0, n);
    await expect.poll(() => page.evaluate(() => !!(/** @type {any} */ (window).__ride.FREE.route)), { timeout: 15000 }).toBe(true);
    await page.locator("#tab-ahead").click();
    await expect(page.locator("#free-list")).toContainText("No climbs");
    await expect(page.locator("#climbstrip")).toBeHidden();
    await page.click("#btn-settings");
    await page.locator("#s-freeride").selectOption("off");
    await page.click("#s-save");
    await page.locator("#tab-workout").click();
    await page.locator("#tab-ahead").click();
    await expect(page.locator("#free-note")).toContainText("off (Settings)");
    await ctx.close();
  });

  test("the wind's cost on your line: drag, watts, time lost, and a line in the ride's summary", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 870 }, geolocation: geo(0, 0), permissions: ["geolocation"] });
    const page = await ctx.newPage();
    const problems = watch(page);
    await world(page, { wind: 25, windFrom: 0 });                                                // 25 km/h from the north
    await page.goto(link());
    await page.locator("#btn-start").click();
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__ride.wx.src)).toBe("Live");
    for (const n of [0, 30, 60, 90]) await ride(page, ctx, 0, n, 0);                             // riding north: into it
    await expect(page.locator("#wx-rel")).toContainText("Headwind");
    await expect(page.locator("#wx-cost")).toHaveText(/^\+\d+% drag · ≈\d+ W$/);
    const head = await page.evaluate(() => /** @type {any} */ (window).__ride.windNow());
    expect(head.drag).toBeGreaterThan(0.5);                                                    // 16 km/h at rider height on 21.6 km/h: well over half again
    expect(head.watts).toBeGreaterThan(40);
    for (const n of [120, 150]) await ride(page, ctx, 0, n, 180);                                // turned south: it pushes
    await expect(page.locator("#wx-cost")).toHaveText(/^−\d+% drag · saves ≈\d+ W$/);
    await page.locator("#tab-data").click();
    await expect(page.locator("#d-wind")).toHaveText(/^[+−]\d+%$/);
    await expect(page.locator("#d-wind-s")).toContainText("drag · saves ≈");
    await page.evaluate(() => Object.assign(/** @type {any} */ (window).__ride.S, { elapsed: 1800, windSecs: 1500, windSec: 290, windHead: 900, windTail: 300 }));
    await page.locator("#btn-end").click();
    await page.locator("#ask-yes").click();
    await expect(page.locator("#sum-body .did")).toContainText(/Wind \(estimated from the forecast\): it cost you about [45] min; headwind 6\d% of the time, tailwind 2\d%/);
    expect(quiet(problems)).toEqual([]);
    await ctx.close();
  });

  test("the fields: chosen, ordered and sized on the bars, and kept", async ({ page }) => {
    const problems = watch(page);
    await world(page);
    await page.goto(link());
    await expect(page.locator("#w-tiles .rtile")).toHaveCount(6);
    await expect(page.locator("#w-tiles .k").first()).toHaveText("Time");
    await page.locator("#tab-data").click();
    await expect(page.locator("#data-grid")).toHaveAttribute("data-cols", "2");
    await page.locator('button[data-cols="3"]').click();                                       // zoom out: three a row
    await expect(page.locator("#data-grid")).toHaveAttribute("data-cols", "3");
    await expect(page.locator('button[data-cols="3"]')).toHaveAttribute("aria-pressed", "true");
    await page.locator("#btn-fields").click();
    await expect(page.locator("#fields")).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.locator('#fl-workout [data-slot="5"]').selectOption("wind");                     // the sixth Workout field: the wind
    await page.locator('#fl-data [data-show="maxhr"]').uncheck();                                // no Max HR on Data
    await page.locator('#fl-data [data-move="speed"][data-by="-1"]').click();                   // Speed before Distance
    await expect(page.locator('#fl-data [data-move="speed"][data-by="-1"]')).toBeFocused();
    await page.locator('#fl-data [data-show="climb"]').check();                                   // and the climb, at the end
    await page.locator("#fields button[value=close]").click();
    const order = await page.locator("#data-grid .rtile").evaluateAll(els => els.map(e => /** @type {HTMLElement} */ (e).dataset.f));
    expect(order.slice(0, 4)).toEqual(["time", "moving", "speed", "dist"]);
    expect(order).not.toContain("maxhr");
    expect(order[order.length - 1]).toBe("climb");
    await page.reload();                                                                       // kept on the phone
    await page.locator("#tab-data").click();
    await expect(page.locator("#data-grid")).toHaveAttribute("data-cols", "3");
    await expect(page.locator("#d-maxhr")).toHaveCount(0);
    await page.locator("#tab-workout").click();
    await expect(page.locator("#w-tiles .k").last()).toHaveText("Wind");
    await page.locator("#tab-data").click();
    await page.locator("#btn-fields").click();
    await page.locator("#fl-reset").click();
    await page.locator("#fields button[value=close]").click();
    await expect(page.locator("#data-grid")).toHaveAttribute("data-cols", "2");
    await expect(page.locator("#d-maxhr")).toHaveCount(1);
    expect(quiet(problems)).toEqual([]);
  });

  test("back to the start: your own track reversed, turn by turn, or the quickest way", async ({ browser }) => {
    const ctx = await browser.newContext({ geolocation: geo(0, 0), permissions: ["geolocation"] });
    const page = await ctx.newPage();
    const calls = await world(page);
    await page.goto(link());
    await page.locator("#btn-start").click();
    await page.locator("#tab-map").click();
    await page.locator("#btn-goto").click();
    await page.locator("#go-retrace").click();
    await expect(page.locator("#go-msg")).toContainText("Nothing to retrace yet");
    await page.locator("#goto button[value=close]").click();
    // an L: 1 km east, then 600 m north, with the heights along it
    await page.evaluate(({ pts }) => {
      const w = /** @type {any} */ (window).__ride, s = w.samples(), t0 = Date.now() - pts.length * 1000;
      pts.forEach((p, i) => s.push([t0 + i * 1000, p.lat, p.lon, p.ele, null, null, null, 6, i * 20]));
    }, { pts: [...Array.from({ length: 51 }, (_, i) => ({ ...at(i * 20, 0), ele: 250 })), ...Array.from({ length: 30 }, (_, i) => ({ ...at(1000, (i + 1) * 20), ele: 250 + (i + 1) }))] });
    await ride(page, ctx, 1000, 600, 0);
    await page.locator("#btn-goto").click();
    await page.locator("#go-retrace").click();
    await expect(page.locator("#route-name")).toContainText("Retrace to the start");
    const r = await page.evaluate(() => { const R = /** @type {any} */ (window).__ride.NAV.route; return { total: R.total, first: R.pts[0], last: R.pts[R.pts.length - 1], turns: R.turns.map(t => t.kind) }; });
    expect(r.total).toBeGreaterThan(1500);
    expect(r.total).toBeLessThan(1700);
    expect(Math.abs(r.first.lat - at(1000, 600).lat)).toBeLessThan(0.0005);                    // from where you are…
    expect(Math.abs(r.last.lon - at(0, 0).lon)).toBeLessThan(0.0005);                          // …to where you started
    expect(r.turns).toContain("right");                                                        // south, then right (west) at the corner
    await page.locator("#btn-goto").click();
    await page.locator("#go-start").click();                                                   // the quickest way asks the router for the start
    await expect.poll(() => calls.router.length).toBeGreaterThan(0);
    const start = at(0, 0);
    expect(calls.router[calls.router.length - 1]).toContain(`${start.lon.toFixed(6)},${start.lat.toFixed(6)}`);
    await ctx.close();
  });

  test("the road ahead holds through a stray fix, finds you afresh on a rebuild, keeps its bends, and says each climb once", async ({ browser }) => {
    const ctx = await browser.newContext({ geolocation: geo(0, 0), permissions: ["geolocation"] });
    const page = await ctx.newPage();
    const problems = watch(page);
    await world(page);
    await page.goto(link());
    await roads(page);
    await page.evaluate(() => { const w = /** @type {any} */ (window); w.__said = []; speechSynthesis.speak = u => w.__said.push(u.text); });
    await page.locator("#btn-start").click();
    for (const n of [0, 20, 40]) await ride(page, ctx, 0, n);
    await expect.poll(() => page.evaluate(() => !!(/** @type {any} */ (window).__ride.FREE.route)), { timeout: 15000 }).toBe(true);
    // the road's own shape, not 100 m chords across it: the bend at 1500 m north is in the line
    const bend = await page.evaluate(p => { const C = /** @type {any} */ (window).RideCore, r = /** @type {any} */ (window).__ride.FREE.route; return Math.min(...r.pts.map(q => C.hav(q, p))); }, at(5, 1500));
    expect(bend).toBeLessThan(2);
    // one wild fix 120 m off (trees, a tall building) doesn't throw the road away; 8 s off it does
    await ride(page, ctx, 120, 300);
    expect(await page.evaluate(() => !!(/** @type {any} */ (window).__ride.FREE.route))).toBe(true);
    for (const n of [320, 340]) await ride(page, ctx, 0, n);
    expect(await page.evaluate(() => /** @type {any} */ (window).__ride.FREE.offSince)).toBe(0);
    // a rebuild 1 km on: you're found at the start of the new road, not 1 km up it
    for (const n of [900, 1000]) await ride(page, ctx, 0, n);
    const before = await page.evaluate(() => /** @type {any} */ (window).__ride.FREE.route);
    await page.evaluate(() => { const F = /** @type {any} */ (window).__ride.FREE; F.tried = 0; F.at = 0; });
    await ride(page, ctx, 0, 1010);
    await expect.poll(() => page.evaluate(b => /** @type {any} */ (window).__ride.FREE.route !== b, before), { timeout: 15000 }).toBe(true);
    expect(await page.evaluate(() => /** @type {any} */ (window).__ride.FREE.st.along)).toBeLessThan(100);
    // a full height cache is emptied before it's asked, not after: the rebuild still has its heights
    await page.evaluate(() => { const w = /** @type {any} */ (window).__ride; for (let i = 0; i < 20001; i++) w.heights.set(`x${i}`, 0); w.FREE.tried = 0; w.FREE.at = 0; });
    const prev = await page.evaluate(() => /** @type {any} */ (window).__ride.FREE.route);
    await ride(page, ctx, 0, 1020);
    await expect.poll(() => page.evaluate(b => /** @type {any} */ (window).__ride.FREE.route !== b, prev), { timeout: 15000 }).toBe(true);
    expect(await page.evaluate(() => /** @type {any} */ (window).__ride.FREE.why)).toBe("");
    // the climb is called out once, rebuilds and all
    for (const n of [1200, 1260, 1320]) await ride(page, ctx, 0, n);
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__said.filter(t => /^Climb in/.test(t)).length)).toBe(1);
    await page.evaluate(() => { const F = /** @type {any} */ (window).__ride.FREE; F.tried = 0; F.at = 0; });
    const third = await page.evaluate(() => /** @type {any} */ (window).__ride.FREE.route);
    await ride(page, ctx, 0, 1330);
    await expect.poll(() => page.evaluate(b => /** @type {any} */ (window).__ride.FREE.route !== b, third), { timeout: 15000 }).toBe(true);
    for (const n of [1340, 1360, 1380]) await ride(page, ctx, 0, n);
    expect(await page.evaluate(() => /** @type {any} */ (window).__said.filter(t => /^Climb in/.test(t)).length)).toBe(1);
    // and a turn off it, held: the road ahead goes, for the new one to be found
    await page.evaluate(() => { /** @type {any} */ (window).__ride.FREE.offSince = Date.now() - 9000; });
    await ride(page, ctx, 300, 1380, 90);
    expect(await page.evaluate(() => /** @type {any} */ (window).__ride.FREE.route)).toBeNull();
    expect(quiet(problems)).toEqual([]);
    await ctx.close();
  });

  test("the wind's ledger stays out of it where the model's speed limits bind", async ({ page }) => {
    await page.goto("/ride.html");
    const r = await page.evaluate(() => {
      const C = /** @type {any} */ (window).RideCore;
      return { fastDown: C.windCost(15, 3, -0.06, { surface: "gravel" }), flat: C.windCost(8, 3, 0, { surface: "gravel" }), tail: C.windCost(8, -3, 0, { surface: "gravel" }) };
    });
    expect(r.fastDown.vCalm).toBeNull();                                                         // past gravel's 13 m/s descent cap
    expect(r.fastDown.watts).toBeGreaterThan(0);                                                 // the headwind still costs watts
    expect(r.flat.vCalm).toBeGreaterThan(8);                                                     // into it: slower than calm air
    expect(r.tail.vCalm).toBeLessThan(8);                                                        // with it: faster
  });
});
