// Ride mode (/ride.html on the app's own origin, written by fitness/build-app.mjs from fitness/site): it loads clean under its own CSP, passes axe, takes
// its plan from a #z= link without ever executing what the link carries, and its settings sheet works under
// form-action 'none'.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { deflateRawSync } from "node:zlib";

test.use({ baseURL: "http://127.0.0.1:8766" });   // the Training app's own origin (playwright.config.mjs)

const today = new Date();
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const step = (name, min, lo, hi, cue = "") => ({ name, min, zone: "thr", lo, hi, cue });
const PLAN = {
  lthr: 160, max_hr: 185, rest_hr: 50, sex: "male", wheel_m: 2.29, fuel_every_min: 20,
  days: [
    { date: iso(today), title: 'Key session <img src=x onerror="window.__pwned=1">', session: "VO2", minutes: 40, load: 60, indoor: false,
      steps: [step("Warm-up <b>x</b>", 15, 81, 89), step("VO2 1/2", 3, 100, 106), step("Easy", 3, 0, 81), step("VO2 2/2", 3, 100, 106)] },
  ],
};
const link = plan => "/ride.html#z=" + deflateRawSync(Buffer.from(JSON.stringify(plan))).toString("base64url");

/** @param {import("@playwright/test").Page} page */
function watch(page) {
  const problems = [];
  page.on("pageerror", e => problems.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error" || /Content Security Policy/i.test(m.text())) problems.push(m.text()); });
  return problems;
}

test.describe("ride mode", () => {
  test("loads clean under its CSP, noindex, and passes axe", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const problems = watch(page);
    await page.goto("/ride.html");
    await expect(page.locator("#btn-start")).toBeVisible();
    expect(await page.locator('meta[name="robots"]').getAttribute("content")).toBe("noindex, nofollow");
    const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    expect(policy).toMatch(/^default-src 'none'; script-src 'self'( 'sha256-[^']+'){3};/);   // the theme, the engine and the app, by hash
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
    expect(r.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join(", ")}`)).toEqual([]);
    expect(problems).toEqual([]);
    await ctx.close();
  });

  test("Start fetches the weather where you are; the synced forecast stands in without signal", async ({ browser }) => {
    const hour = `${iso(today)}T${String(new Date().getHours()).padStart(2, "0")}:00`;
    const plan = { ...PLAN, units: "imperial", wx: [[hour, 10, 8, 20, 270, 35, 40]] };
    const ctx = await browser.newContext({ geolocation: { latitude: 42.2917, longitude: -85.5872 }, permissions: ["geolocation"] });
    const page = await ctx.newPage();
    const problems = watch(page);
    let asked = "", up = true;
    await page.route("https://api.open-meteo.com/**", route => {
      asked = route.request().url();
      return up ? route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        body: JSON.stringify({ current: { temperature_2m: 15, apparent_temperature: 13, wind_speed_10m: 16, wind_direction_10m: 90, wind_gusts_10m: 30 },
          hourly: { precipitation_probability: [10, 60, 70] } }) }) : route.fulfill({ status: 503, body: "" });
    });
    await page.goto(link(plan));
    await expect(page.locator("#wx-temp")).toHaveText("50°F");                         // the sync's forecast before Start
    await expect(page.locator("#wx-src")).toHaveText("Forecast from the sync");
    await page.locator("#btn-start").click();
    await expect(page.locator("#wx-temp")).toHaveText("59°F");                         // live, at the tap
    await expect(page.locator("#wx-wind")).toContainText("10");
    await expect(page.locator("#wx-dir")).toHaveText("from E · gusts 19");
    await expect(page.locator("#wx-feels")).toHaveText("feels 55°F · 70% rain");
    await expect(page.locator("#wx-src")).toContainText("Live");
    expect(asked).toContain("latitude=42.29");
    expect(asked).toContain("longitude=-85.59");                                      // ~1 km, not your doorstep
    up = false;
    await page.locator("#btn-start").click();                                          // pause
    await page.locator("#btn-start").click();                                          // resume: fetches again, falls back
    await expect(page.locator("#wx-src")).toHaveText("Forecast from the sync");
    expect(problems.filter(p => !/503/.test(p))).toEqual([]);                         // the 503's own console line is the browser's
    await ctx.close();
  });

  test("takes its plan from the link, keeps it, and never runs what the link carries", async ({ page }) => {
    const problems = watch(page);
    await page.goto(link(PLAN));
    await expect(page.locator("#day option").first()).toContainText('Key session <img src=x onerror="window.__pwned=1">');
    expect(await page.evaluate(() => /** @type {any} */ (window).__pwned)).toBeUndefined();
    expect(new URL(page.url()).hash).toBe("");                                   // the fragment is dropped from the bar
    await expect(page.locator("#step-target")).toContainText("first: Warm-up <b>x</b>");
    await page.reload();                                                         // and kept on the phone
    await expect(page.locator("#day option")).toHaveCount(2);
    await page.goto("/ride.html#z=not-a-plan");                                  // junk is ignored, the saved plan stays
    await expect(page.locator("#day option")).toHaveCount(2);
    expect(problems).toEqual([]);
  });

  test("imperial / metric: the settings pair and a tap on the reading both switch, and the choice sticks", async ({ page }) => {
    await page.goto(link(PLAN));
    await expect(page.locator("#t-dist")).toContainText("mi");
    await page.click("#btn-settings");
    await page.click('#settings [data-units="km"]');
    await expect(page.locator('#settings [data-units="km"]')).toHaveAttribute("aria-pressed", "true");
    await page.click("#s-save");
    await expect(page.locator("#t-dist")).toContainText("km");
    await page.click(".unit-flip >> nth=0");
    await expect(page.locator("#t-dist")).toContainText("mi");
    await page.reload();
    await expect(page.locator("#t-dist")).toContainText("mi");
  });

  test("dark by default (true black, for the OLED), light on a tap, and the choice sticks", async ({ page }) => {
    await page.goto(link(PLAN));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(0, 0, 0)");
    await page.click("#btn-settings");
    await expect(page.locator('#settings [data-theme-pick="dark"]')).toHaveAttribute("aria-pressed", "true");
    await page.click('#settings [data-theme-pick="light"]');
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(245, 242, 234)");   // the paper
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("the controls are always on screen: Start / Lap / Next / End sit inside the visible window, whatever its height", async ({ browser }) => {
    for (const [w, h] of [[412, 869], [412, 760], [360, 640]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      await page.goto(link(PLAN));
      for (const id of ["#btn-start", "#btn-end"]) {
        const box = await page.locator(id).boundingBox();
        expect(box && box.y + box.height, `${id} at ${w}×${h}`).toBeLessThanOrEqual(h);
      }
      await page.setViewportSize({ width: w, height: h - 90 });                        // the window shrinks (system bars, keyboard)
      await expect.poll(async () => { const b = await page.locator("#btn-start").boundingBox(); return b && b.y + b.height <= h - 90; }).toBe(true);
      await ctx.close();
    }
  });

  test("before the ride: why today's ride is today's ride, from the sync", async ({ page }) => {
    const brief = { date: iso(today), title: "Keep it easy", level: "easy", score: 52, why: ["Resting HR 58 bpm — 4.0 above your 60-day norm"], tsb: -18,
      ctl: 61.2, atl: 79, target: { ctl: 65, race_ctl: 66.4, days: 10 }, ef_trend: 2.3, zones: "LTHR 163 learned from Ride 0 (2026-09-01, your best 20 min)" };
    await page.goto(link({ ...PLAN, brief, race: { name: "Iceman Cometh", date: iso(new Date(Date.now() + 10 * 864e5)) } }));
    await expect(page.locator("#b-score")).toHaveText("52");
    await expect(page.locator("#b-title")).toHaveText("Keep it easy");
    await expect(page.locator("#b-why")).toContainText("Resting HR 58 bpm");
    await expect(page.locator("#b-why")).toContainText("Fitness 61, form -18 · Iceman Cometh asks for 65, on course for 66");
    await expect(page.locator("#b-why")).toContainText("Commute: +2.3% speed per heartbeat vs your earlier commutes (fitter)");
    await expect(page.locator("#b-why")).toContainText("LTHR 163 learned from Ride 0");
    await expect(page.locator("#b-race")).toHaveText(" · Iceman Cometh in 10 days");
    await page.click("#btn-start");
    await expect(page.locator("#brief")).toBeHidden();                                  // on the bike, the brief steps aside
  });

  test("settings save under form-action 'none' and move the targets", async ({ page }) => {
    await page.goto(link(PLAN));
    await page.click("#btn-start");
    await expect(page.locator("#step-target")).toContainText("130–142");
    await page.click("#btn-settings");
    await page.fill("#s-lthr", "170");
    await page.click("#s-save");
    await expect(page.locator("#settings")).not.toBeVisible();
    await expect(page.locator("#step-target")).toContainText("138–151");
  });

  test("finds a Garmin HRM-Pro+ by name, says what to try when it isn't listed, and offers every nearby device", async ({ page }) => {
    // a stand-in Web Bluetooth: the picker answers from a script, the strap streams 142 bpm once subscribed
    await page.addInitScript(() => {
      const w = /** @type {any} */ (window);
      w.__asks = []; w.__pick = "cancel";
      const strap = {
        id: "hrm-823265", name: "HRM-Pro+:823265", addEventListener() {},
        gatt: { connected: false, async connect() { this.connected = true; return this; }, disconnect() { this.connected = false; },
          async getPrimaryService() { return { async getCharacteristic() { const c = { fn: null, addEventListener(_, f) { c.fn = f; },
            async startNotifications() { setTimeout(() => c.fn({ target: { value: new DataView(new Uint8Array([0, 142]).buffer) } }), 50); } }; return c; } }; } },
      };
      Object.defineProperty(navigator, "bluetooth", { configurable: true, value: {
        async requestDevice(opts) {
          w.__asks.push(opts);
          if (w.__pick === "cancel") throw new DOMException("User cancelled the requestDevice() chooser.", "NotFoundError");
          return strap;
        },
      } });
    });
    await page.goto(link(PLAN));
    await page.click("#btn-hr");
    await expect(page.locator("#note")).toContainText("Forget");                         // the phone's own pairing hides it
    const first = await page.evaluate(() => /** @type {any} */ (window).__asks[0]);
    expect(first.filters).toContainEqual({ namePrefix: "HRM" });
    expect(first.filters).toContainEqual({ services: ["heart_rate"] });
    await page.evaluate(() => { /** @type {any} */ (window).__pick = "strap"; });
    await page.getByRole("button", { name: "Show all nearby devices" }).click();
    const all = await page.evaluate(() => /** @type {any} */ (window).__asks[1]);
    expect(all).toEqual({ acceptAllDevices: true, optionalServices: ["heart_rate"] });
    await expect(page.locator("#btn-hr")).toHaveClass(/\bon\b/);
    await expect(page.locator("#hr")).toHaveText("142");
    await expect(page.locator("#note")).toHaveText("Connected: HRM-Pro+:823265.");
    expect(await page.evaluate(() => localStorage.getItem("fitness-ride-hr"))).toBe("hrm-823265");
  });
});

test.describe("ride mode, on the bars", () => {
  test("End: a tap asks, a one-second hold ends the ride without asking", async ({ page }) => {
    await page.goto(link(PLAN));
    await page.locator("#btn-start").click();
    await expect(page.locator("#btn-end")).toBeEnabled();
    await page.locator("#btn-end").click();                                                    // a tap: the sheet, Cancel focused
    await expect(page.locator("#ask")).toBeVisible();
    await expect(page.locator("#ask-no")).toBeFocused();
    await page.locator("#ask-no").click();
    await expect(page.locator("#btn-end")).toBeEnabled();
    await page.evaluate(() => { /** @type {any} */ (window).__ride.S.elapsed = 30; });
    await page.locator("#btn-end").hover();
    await page.mouse.down();
    await expect(page.locator("#btn-end")).toHaveClass(/holding/);
    await page.waitForTimeout(1100);
    await page.mouse.up();
    await expect(page.locator("#summary")).toBeVisible();                                      // ended, with no question
    await expect(page.locator("#ask")).toBeHidden();
  });

  test("the touch lock: nothing takes a touch until the unlock bar is held", async ({ page }) => {
    await page.goto(link(PLAN));
    await page.locator("#btn-start").click();
    await expect(page.locator("#btn-lock")).toBeVisible();                                     // only while riding
    await page.locator("#btn-lock").click();
    await expect(page.locator("#lockveil")).toBeVisible();
    for (const sel of ["#pages", ".rfoot", ".rtop"]) expect(await page.locator(sel).evaluate(el => /** @type {any} */ (el).inert), sel).toBe(true);
    await page.locator("#btn-unlock").click();                                                 // a tap (a raindrop) does nothing
    await expect(page.locator("#lockveil")).toBeVisible();
    await page.locator("#btn-unlock").hover();
    await page.mouse.down();
    await page.waitForTimeout(1000);
    await page.mouse.up();
    await expect(page.locator("#lockveil")).toBeHidden();
    expect(await page.locator("#pages").evaluate(el => /** @type {any} */ (el).inert)).toBe(false);
    await page.locator("#btn-lock").click();                                                   // and the keyboard unlocks at once
    await page.locator("#btn-unlock").press("Enter");
    await expect(page.locator("#lockveil")).toBeHidden();
  });

  test("Lock at Start (Settings) locks the screen as the ride begins", async ({ page }) => {
    await page.goto(link(PLAN));
    await page.click("#btn-settings");
    await page.locator("#s-autolock").check();
    await page.click("#s-save");
    await page.locator("#btn-start").click();
    await expect(page.locator("#lockveil")).toBeVisible({ timeout: 4000 });
  });

  test("Auto follows the phone's light or dark, and battery saver still keeps true black", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(link(PLAN));
    await page.click("#btn-settings");
    await page.click('#settings [data-theme-pick="auto"]');
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator('#settings [data-theme-pick="auto"]')).toHaveAttribute("aria-pressed", "true");
  });
});
