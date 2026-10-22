// What ride mode does beyond the road: a smart trainer (a Tacx Flow Smart over its FE-C Bluetooth bridge) driven in ERG,
// heart-rate ERG and route-grade modes; the way back to a route found offline from the map tiles on the phone; the
// battery forecast and saver; and the ride sent to the training sync by itself. The trainer, the tiles, the battery and
// GitHub are all stand-ins from the test.
import { test, expect } from "@playwright/test";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { watch } from "./fixtures.mjs";
import { encodeTile } from "./mvt.mjs";

test.use({ baseURL: "http://127.0.0.1:8766" });

const LAT0 = 42.29, LON0 = -85.59, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110540;
const at = (e, n) => ({ lat: LAT0 + n / KY, lon: LON0 + e / KX });
const geo = (e, n) => { const p = at(e, n); return { latitude: p.lat, longitude: p.lon, accuracy: 5 }; };
// 3 km east along Main Street, then 1.5 km north up Gull Road at ~5 %
function gpx() {
  const pts = [];
  for (let e = 0; e <= 3000; e += 20) pts.push({ ...at(e, 0), ele: 250 });
  for (let n = 20; n <= 1500; n += 20) pts.push({ ...at(3000, n), ele: 250 + n * 0.05 });
  return `<?xml version="1.0"?><gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Gull Lake</name><trkseg>
${pts.map(p => `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><ele>${p.ele}</ele></trkpt>`).join("\n")}</trkseg></trk></gpx>`;
}
const today = new Date();
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const step = (name, min, zone, lo, hi, cue = "") => ({ name, min, zone, lo, hi, cue });
const PLAN = { lthr: 160, max_hr: 185, rest_hr: 50, sex: "male", wheel_m: 2.096, fuel_every_min: 20, units: "metric", ftp: 250, weight_kg: 78,
  days: [{ date: iso(today), title: "Sweet spot", session: "Sweet spot", minutes: 60, load: 70, indoor: true,
    steps: [step("Warm-up", 10, "z2", 81, 89), step("Sweet spot 1/2", 12, "ss", 92, 97), step("Easy", 5, "z1", 0, 81), step("Sweet spot 2/2", 12, "ss", 92, 97), step("Cool-down", 10, "z1", 0, 81)] }] };
const link = plan => "/ride.html#z=" + deflateRawSync(Buffer.from(JSON.stringify(plan))).toString("base64url");
const JSONH = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
async function world(page) {
  await page.context().route("https://tiles.openfreemap.org/**", r => r.fulfill({ status: 404, headers: { "Access-Control-Allow-Origin": "*" }, body: "" }));
  await page.context().route("https://api.open-meteo.com/**", r => r.fulfill({ status: 200, headers: JSONH, body: JSON.stringify({ current: { temperature_2m: 12, apparent_temperature: 11, wind_speed_10m: 10, wind_direction_10m: 90, wind_gusts_10m: 15 }, hourly: {} }) }));
  await page.context().route("https://brouter.de/**", r => r.fulfill({ status: 503, body: "" }));   // no router: no signal out there
}
const quiet = problems => problems.filter(p => !/Failed to load resource|status of (404|503)/.test(p));

/** A Tacx Flow Smart as Web Bluetooth would show it: the FE-C bridge service, its notify and write characteristics. */
const fakeTacx = () => {
  const RX = "6e40fec2-b5a3-f393-e0a9-e50e24dcca9e", TX = "6e40fec3-b5a3-f393-e0a9-e50e24dcca9e", SVC = "6e40fec1-b5a3-f393-e0a9-e50e24dcca9e";
  const bt = { writes: [], requested: null };
  const ch = (uuid, properties) => {
    const t = new EventTarget();
    const write = async v => { bt.writes.push(Array.from(v instanceof Uint8Array ? v : new Uint8Array(v.buffer || v))); };
    return Object.assign(t, { uuid, properties, startNotifications: async () => t, writeValueWithoutResponse: write, writeValueWithResponse: write });
  };
  const rx = ch(RX, { notify: true }), tx = ch(TX, { writeWithoutResponse: true, write: true });
  bt.emit = page => {
    const m = [0xA4, 9, 0x4E, 5, ...page];
    m.push(m.reduce((a, b) => a ^ b, 0));
    rx.value = new DataView(new Uint8Array(m).buffer);
    rx.dispatchEvent(new Event("characteristicvaluechanged"));
  };
  const server = { getPrimaryService: async u => { if (u !== SVC) throw new Error("no such service"); return { getCharacteristic: async c => (c === RX ? rx : tx) }; } };
  const device = Object.assign(new EventTarget(), { id: "tacx-flow", name: "Tacx Flow 21345", gatt: { connected: true, connect: async () => server, disconnect() {} } });
  Object.defineProperty(navigator, "bluetooth", { configurable: true, value: { requestDevice: async o => { bt.requested = o; return device; }, getDevices: async () => [] } });
  /** @type {any} */ (window).__bt = bt;
};
/** FE-C page 16 (speed, m/s) and page 25 (power, cadence, the ERG limit flags). */
const page16 = mps => { const v = Math.round(mps * 1000); return [0x10, 25, 0, 0, v & 0xFF, v >> 8, 0xFF, 0x30]; };
const page25 = (w, cad, flags = 0) => [0x19, 1, cad, 0, 0, w & 0xFF, (w >> 8) & 0x0F, flags];
const pedal = (page, mps, w, cad, flags = 0) => page.evaluate(([a, b]) => { const bt = /** @type {any} */ (window).__bt; bt.emit(a); bt.emit(b); }, [page16(mps), page25(w, cad, flags)]);
const sent = (page, pageNo) => page.evaluate(n => /** @type {any} */ (window).__bt.writes.filter(w => w[4] === n), pageNo);

test.describe("beyond the road", () => {
  test("the trainer protocol: FE-C pages, FTMS data, ERG watts and heart-rate ERG", async ({ page }) => {
    await page.goto("/ride.html");
    const r = await page.evaluate(() => {
      const C = /** @type {any} */ (window).RideCore;
      const pw = Array.from(C.fecPower(200)), gr = Array.from(C.fecGrade(5)), user = Array.from(C.fecUser(78, 9, 2.096));
      const xor = m => m.slice(0, 12).reduce((a, b) => a ^ b, 0);
      const msg = page => { const m = [0xA4, 9, 0x4E, 5, ...page]; m.push(0); return new DataView(new Uint8Array(m).buffer); };
      const p16 = C.parseFec(msg([0x10, 25, 0, 0, 0x6C, 0x20, 0xFF, 0x30])), p25 = C.parseFec(msg([0x19, 1, 88, 0, 0, 0xF4, 0x01, 0x01]));
      const ibd = new DataView(new Uint8Array([0x44, 0x00, 0x10, 0x0E, 0xB4, 0x00, 0xC8, 0x00]).buffer);   // speed 36 km/h, cadence 90, 200 W
      const s = { name: "SS", min: 12, zone: "ss", lo: 92, hi: 97 };
      let w = 150;
      for (let i = 0; i < 6; i++) w = C.hrErg(w, 140, 147, 155, 25);                            // under the band: up
      const up = w;
      for (let i = 0; i < 3; i++) w = C.hrErg(w, 162, 147, 155, 25);                            // over it: down, quicker
      return { pw, gr, user, okPw: xor(pw) === pw[12], p16, p25, ibd: C.parseBikeData(ibd), ftms: Array.from(C.ftms.power(200)), sim: Array.from(C.ftms.grade(-2.5)),
        erg: C.ergWatts(s, 250, 1), ergEasy: C.ergWatts(s, 250, 0.95), noFtp: C.ergWatts(s, 0), up, down: w, wait: C.hrErg(150, 120, 147, 155, 5) };
    });
    expect(r.pw.slice(0, 5)).toEqual([0xA4, 9, 0x4F, 5, 0x31]);
    expect(r.pw[10] | (r.pw[11] << 8)).toBe(800);                                              // 200 W in quarter watts
    expect(r.okPw).toBe(true);
    expect(r.gr[4]).toBe(0x33);
    expect(r.gr[9] | (r.gr[10] << 8)).toBe(20500);                                             // +5 % from −200 %, in 0.01 %
    expect(r.gr[11]).toBe(80);                                                                  // Crr 0.004
    expect(r.user[4]).toBe(0x37);
    expect(r.user[5] | (r.user[6] << 8)).toBe(7800);
    expect(r.p16).toMatchObject({ page: 16, speed: 8.3, hr: null });
    expect(r.p25).toMatchObject({ page: 25, cadence: 88, power: 500, limit: "slow" });
    expect(r.ibd).toEqual({ speed: 10, cadence: 90, power: 200, hr: null });
    expect(r.ftms).toEqual([0x05, 200, 0]);
    expect(r.sim).toEqual([0x11, 0, 0, 0x06, 0xFF, 40, 51]);                                    // −250 (0.01 %) as int16
    expect(r.erg).toBeGreaterThan(215);
    expect(r.erg).toBeLessThan(235);
    expect(r.ergEasy).toBeLessThan(r.erg);
    expect(r.noFtp).toBeNull();
    expect(r.up).toBeGreaterThan(150);
    expect(r.down).toBeLessThan(r.up - 20);
    expect(r.wait).toBe(150);                                                                   // 20 s between nudges
  });

  test("a Tacx Flow on the trainer: ERG watts per step, speed and power recorded, and the gear hint at low wheel speed", async ({ page }) => {
    const problems = watch(page);
    await world(page);
    await page.addInitScript(fakeTacx);
    await page.goto(link(PLAN));
    await page.locator("#btn-trainer").click();
    await expect(page.locator("#btn-trainer")).toHaveClass(/on/);
    const req = await page.evaluate(() => /** @type {any} */ (window).__bt.requested);
    expect(req.filters.some(f => f.namePrefix === "Tacx")).toBe(true);
    expect((await sent(page, 0x37)).length).toBe(1);                                            // rider weight for the brake's feel
    await page.locator("#btn-start").click();
    for (let i = 0; i < 4; i++) { await pedal(page, 8.3, 160, 88); await page.waitForTimeout(500); }
    const erg = await sent(page, 0x31);
    expect(erg.length).toBeGreaterThan(0);
    const watts = (erg[erg.length - 1][10] | (erg[erg.length - 1][11] << 8)) / 4;
    const want = await page.evaluate(() => { const C = /** @type {any} */ (window).RideCore, w = /** @type {any} */ (window).__ride; return C.ergWatts(w.S.plan[0], 250, 1); });
    expect(watts).toBe(want);
    await expect(page.locator("#step-target")).toContainText(`ERG ${want} W`);
    await expect(page.locator("#t-speed")).toContainText("29.9");                               // 8.3 m/s from the trainer
    await expect(page.locator("#t-cad")).toContainText("160");
    const st = await page.evaluate(() => { const w = /** @type {any} */ (window).__ride; return { dist: w.S.dist, rows: w.samples().slice(-2) }; });
    expect(st.dist).toBeGreaterThan(8);
    expect(st.rows[1][6]).toBe(160);
    expect(st.rows[1][1]).toBeNull();                                                           // indoors: no track
    // the next step: new watts at once
    await page.locator("#btn-skip").click();
    await pedal(page, 8.3, 160, 88);
    await page.waitForTimeout(1300);
    const ss = await sent(page, 0x31), w2 = (ss[ss.length - 1][10] | (ss[ss.length - 1][11] << 8)) / 4;
    expect(w2).toBeGreaterThan(watts);
    // a wheel too slow for the watts: the trainer flags it, the screen says which gear
    for (let i = 0; i < 3; i++) { await pedal(page, 3, 120, 60, 1); await page.waitForTimeout(400); }
    await expect(page.locator("#step-cue")).toContainText("harder gear");
    await page.evaluate(() => { /** @type {any} */ (window).__ride.S.elapsed = 30; });
    await page.locator("#btn-end").click();
    await page.locator("#ask-yes").click();   // the app's own confirmation sheet
    await expect.poll(async () => { const last = (await sent(page, 0x33)).pop(); return last && (last[9] | (last[10] << 8)); }).toBe(20000);   // flat road again at the end
    expect(quiet(problems)).toEqual([]);
  });

  test("no FTP: heart-rate ERG holds the band and remembers the watts; a route on the trainer sets its grade", async ({ page }) => {
    const problems = watch(page);
    await world(page);
    await page.addInitScript(fakeTacx);
    await page.goto(link({ ...PLAN, ftp: 0, days: [{ ...PLAN.days[0], steps: [step("Endurance", 4, "z2", 81, 89), step("Cool-down", 10, "z1", 0, 81)] }] }));
    await page.locator("#btn-trainer").click();
    await expect(page.locator("#btn-trainer")).toHaveClass(/on/);
    await page.locator("#btn-start").click();
    await pedal(page, 8, 130, 85);
    await expect(page.locator("#step-target")).toContainText("HR-ERG 135 W");                    // a first guess for Z2
    // heart rate under the band for a while: the watts come up (the controller waits out the first minute and the lag)
    await page.evaluate(() => { const w = /** @type {any} */ (window).__ride; w.S.stepStart = w.S.elapsed - 200; w.TR.since = 30; w.live.hr = 120; w.live.hrAt = Date.now() + 60000; });
    await expect.poll(async () => page.evaluate(() => /** @type {any} */ (window).__ride.TR.watts)).toBeGreaterThan(135);
    const held = await page.evaluate(() => /** @type {any} */ (window).__ride.TR.watts);
    await page.evaluate(() => { /** @type {any} */ (window).__ride.TR.stepSecs = 400; });
    await page.locator("#btn-skip").click();
    await page.waitForTimeout(1300);
    const learned = await page.evaluate(() => JSON.parse(localStorage.getItem("fitness-ride-erg") || "{}"));
    expect(learned["85"]).toBe(held);                                                           // the Z2 watts, for next time
    await page.locator("#btn-end").click();
    await page.locator("#ask-yes").click();   // the app's own confirmation sheet
    await page.locator("#summary button[value=close]").click();

    // a free ride along a route, indoors: the grade under you, your place moved by the wheel
    await page.goto(link({ ...PLAN, days: [] }).replace("ride.html", "ride.html?page=workout"));   // a new page, not just a new #fragment
    await page.locator("#tab-map").click();
    await page.locator("#btn-routes").click();
    await page.locator("#route-file").setInputFiles({ name: "gull.gpx", mimeType: "application/gpx+xml", buffer: Buffer.from(gpx()) });
    await expect(page.locator("#route-msg")).toContainText("Loaded");
    await page.locator("#routes .actions button[value=close]").click();
    await page.locator("#btn-trainer").click();
    await expect(page.locator("#btn-trainer")).toHaveClass(/on/);
    await page.locator("#btn-start").click();
    await page.evaluate(() => { /** @type {any} */ (window).__ride.TR.along = 2990; });          // jump to the foot of the climb
    for (let i = 0; i < 4; i++) { await pedal(page, 6, 220, 80); await page.waitForTimeout(450); }
    await page.evaluate(() => { const w = /** @type {any} */ (window).__ride; if (w.TR.along < 3000) w.TR.along = 3050; });
    await page.waitForTimeout(1200);
    const g = (await sent(page, 0x33)).map(m => ((m[9] | (m[10] << 8)) - 20000) / 100);
    expect(Math.max(...g)).toBeGreaterThanOrEqual(4.5);                                         // Gull Road's 5 %
    const nav = await page.evaluate(() => { const w = /** @type {any} */ (window).__ride; return { along: w.NAV.st.along, off: w.NAV.st.offCourse, virtual: w.TR.virtual }; });
    expect(nav.virtual).toBe(true);
    expect(nav.off).toBe(false);
    expect(nav.along).toBeGreaterThan(2990);
    await page.locator("#tab-workout").click();
    await expect(page.locator("#step-target")).toContainText("Trainer grade");
    expect(quiet(problems)).toEqual([]);
  });

  test("no signal: the way back comes from the map tiles on the phone, forward and around the blocked road", async ({ browser }) => {
    const ctx = await browser.newContext({ geolocation: geo(1000, 0), permissions: ["geolocation"] });
    const page = await ctx.newPage();
    const problems = watch(page);
    await world(page);
    await page.goto("/ride.html?page=map#z=" + deflateRawSync(Buffer.from(JSON.stringify({ ...PLAN, days: [] }))).toString("base64url"));
    // the roads: Main Street (the route), a parallel Bank Street 300 m south, Oak, Mill and Gull joining them
    const z = 14, line = (name, cls, pts) => ({ name, cls, coords: pts.map(([e, n]) => { const p = at(e, n); return [p.lon, p.lat]; }) });
    const roads = [line("Main Street", "minor", [[-600, 0], [1000, 0], [2000, 0], [3000, 0], [3600, 0]]), line("Bank Street", "minor", [[-600, -300], [1000, -300], [2000, -300], [3000, -300], [3600, -300]]),
      line("Oak Street", "minor", [[1000, -300], [1000, 0]]), line("Mill Street", "minor", [[2000, -300], [2000, 0]]), line("Gull Road", "tertiary", [[3000, -300], [3000, 0], [3000, 1600]]),
      line("I-94", "motorway", [[-600, -150], [3600, -150]])];
    const tile = (lat, lon) => { const n = 2 ** z, x = Math.floor((lon + 180) / 360 * n), s = Math.sin(lat * Math.PI / 180); return [x, Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n)]; };
    const [x0, y0] = tile(at(-800, 1800).lat, at(-800, 1800).lon), [x1, y1] = tile(at(3800, -600).lat, at(3800, -600).lon), tiles = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const body = encodeTile(z, x, y, { transportation: roads.map(r => ({ props: { class: r.cls }, coords: r.coords })), transportation_name: roads.map(r => ({ props: { class: r.cls, name: r.name }, coords: r.coords })) });
      tiles.push({ url: `https://tiles.openfreemap.org/planet/test/${z}/${x}/${y}.pbf`, body: Array.from(body) });
    }
    await page.evaluate(async list => {
      const c = await caches.open("fitness-tiles"), J = { "Content-Type": "application/json" };
      await c.put("https://tiles.openfreemap.org/styles/liberty", new Response(JSON.stringify({ version: 8, sources: { openmaptiles: { type: "vector", url: "https://tiles.openfreemap.org/planet" } }, layers: [] }), { headers: J }));
      await c.put("https://tiles.openfreemap.org/planet", new Response(JSON.stringify({ tiles: ["https://tiles.openfreemap.org/planet/test/{z}/{x}/{y}.pbf"] }), { headers: J }));
      for (const t of list) await c.put(t.url, new Response(new Uint8Array(t.body)));
    }, tiles);
    await page.locator("#btn-routes").click();
    await page.locator("#route-file").setInputFiles({ name: "gull.gpx", mimeType: "application/gpx+xml", buffer: Buffer.from(gpx()) });
    await expect(page.locator("#route-msg")).toContainText("Loaded");
    await page.locator("#routes .actions button[value=close]").click();
    await page.locator("#btn-start").click();
    for (const e of [1005, 1010, 1015, 1020]) { await ctx.setGeolocation(geo(e, 0)); await page.waitForTimeout(350); }
    // Main Street is closed past Oak: down Oak and east on Bank Street, riding on
    for (const [e, n] of [[1000, -100], [1000, -300], [1150, -300], [1300, -300], [1400, -300]]) { await ctx.setGeolocation(geo(e, n)); await page.waitForTimeout(350); }
    await page.evaluate(() => { const w = /** @type {any} */ (window).__ride; w.live.gpsSpeed = 6; w.live.gpsAt = Date.now(); w.live.heading = 90; });
    await expect.poll(() => page.evaluate(() => !!(/** @type {any} */ (window).__ride.NAV.detour)), { timeout: 15000 }).toBe(true);
    const d = await page.evaluate(() => {
      const w = /** @type {any} */ (window).__ride, r = w.NAV.detour.route;
      return { turns: r.turns.map(t => ({ kind: t.kind, name: t.name, src: t.src })), end: r.pts[r.pts.length - 1], target: w.NAV.detour.target.along, total: r.total };
    });
    expect(d.turns[0]).toMatchObject({ kind: "left", name: "Mill Street", src: "offline" });   // forward to Mill, not back up Oak
    expect(d.target).toBeGreaterThan(1900);
    expect(d.total).toBeLessThan(1500);
    await expect(page.locator("#nb-what")).toContainText("Mill Street");
    expect(quiet(problems)).toEqual([]);
    await ctx.close();
  });

  test("the battery: how long it lasts at this ride's drain, and the saver when that's short of the ride", async ({ page }) => {
    const problems = watch(page);
    await world(page);
    await page.addInitScript(() => {
      const b = Object.assign(new EventTarget(), { level: 0.31, charging: false });
      /** @type {any} */ (navigator).getBattery = async () => b;
      /** @type {any} */ (window).__battery = b;
    });
    await page.goto(link(PLAN));
    const fc = await page.evaluate(() => {
      const C = /** @type {any} */ (window).RideCore, t = 1.7e12, m = 60e3;
      return { draining: C.batteryForecast([[t, 0.5, false], [t + 10 * m, 0.47, false], [t + 20 * m, 0.44, false]], t + 20 * m),
        charged: C.batteryForecast([[t, 0.5, false], [t + 10 * m, 0.47, false], [t + 11 * m, 0.47, true], [t + 12 * m, 0.48, false]], t + 12 * m),
        steady: C.batteryForecast([[t, 0.5, false], [t + 30 * m, 0.495, false]], t + 30 * m) };
    });
    expect(fc.draining.perHour).toBeCloseTo(0.18, 2);
    expect(fc.draining.hours).toBeCloseTo(2.17, 1);
    expect(fc.charged).toBeNull();
    expect(fc.steady).toBeNull();
    await page.locator("#btn-start").click();
    // 60 % an hour, down to 31 %: under half an hour left, and the session has 49 minutes
    await page.evaluate(() => { const w = /** @type {any} */ (window).__ride, now = Date.now(); w.live.battery = { level: 0.31, charging: false }; w.batt.log = [[now - 20 * 60e3, 0.51, false], [now - 10 * 60e3, 0.41, false], [now, 0.31, false]]; w.batt.at = 0; });
    await expect(page.locator("#suggest-text")).toContainText("battery saver is on");
    await expect(page.locator("body")).toHaveClass(/saver/);
    await page.locator("#tab-data").click();
    await expect(page.locator("#d-batt-left")).toContainText("short of the ride");
    await page.locator("#tab-workout").click();
    await page.locator("#suggest-yes").click();                                                 // Undo
    await expect(page.locator("body")).not.toHaveClass(/saver/);
    await page.evaluate(() => { /** @type {any} */ (window).__ride.batt.at = 0; });
    await page.waitForTimeout(1500);
    await expect(page.locator("body")).not.toHaveClass(/saver/);                                 // a no is a no for this ride
    expect(quiet(problems)).toEqual([]);
  });

  test("the ride goes to the training sync by itself, and stops being sent once the sync lists it", async ({ page }) => {
    const problems = watch(page);
    await world(page);
    const gh = { dispatches: [], have: [] };
    const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST", "Content-Type": "application/json" };
    await page.context().route("https://api.github.com/**", async route => {
      const req = route.request(), u = new URL(req.url());
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      if (u.pathname.endsWith("/contents/status.json")) return gh.have.length ? route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ rides: gh.have }) }) : route.fulfill({ status: 404, headers: CORS, body: "{}" });
      if (u.pathname.endsWith("/actions/workflows/training.yml/dispatches")) { gh.dispatches.push({ auth: req.headers().authorization, body: JSON.parse(req.postData() || "{}") }); return route.fulfill({ status: 204, headers: CORS, body: "" }); }
      return route.fulfill({ status: 404, headers: CORS, body: "{}" });
    });
    await page.goto(link(PLAN));
    await page.evaluate(() => localStorage.setItem("fitness-cloud", JSON.stringify({ repo: "me/training-data", token: "github_pat_test", branch: "main" })));
    await page.locator("#btn-start").click();
    await page.evaluate(() => { const w = /** @type {any} */ (window).__ride; w.S.elapsed = 1800; w.S.moving = 1750; w.S.dist = 12000; w.live.hr = 142; w.live.hrAt = Date.now() + 5000; });
    await page.waitForTimeout(2500);
    await page.locator("#btn-end").click();
    await page.locator("#ask-yes").click();   // the app's own confirmation sheet
    await expect.poll(() => gh.dispatches.length).toBe(1);
    const { auth, body } = gh.dispatches[0];
    expect(auth).toBe("Bearer github_pat_test");
    expect(body.ref).toBe("main");
    expect(body.inputs.action).toBe("service");
    expect(body.inputs.code.length).toBeLessThan(60000);
    const ride = JSON.parse(inflateRawSync(Buffer.from(body.inputs.code.replace(/^ride:/, ""), "base64url")).toString());
    expect(ride).toMatchObject({ v: 1, name: expect.stringContaining("Sweet spot"), elapsed: expect.any(Number), dist: expect.any(Number), step: 5 });
    expect(ride.s.hr.some(h => h === 142)).toBe(true);
    await expect(page.locator("#sum-sync")).toContainText("Sent to the training sync");
    // it's in GitHub's queue: not sent again on the next look
    await page.evaluate(() => /** @type {any} */ (window).__ride.sendRides());
    expect(gh.dispatches.length).toBe(1);
    // the sync has it: off the list, and the ride says so
    gh.have = [ride.id];
    await page.evaluate(() => /** @type {any} */ (window).__ride.sendRides());
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__ride.outbox().length)).toBe(0);
    await page.locator("#summary button[value=close]").click();
    await page.locator("#tab-laps").click();
    await page.locator("#btn-rides").click();
    await page.locator("#ride-list [data-open]").click();
    await expect(page.locator("#sum-sync")).toContainText("In the training sync");
    expect(quiet(problems)).toEqual([]);
  });
});
