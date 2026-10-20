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

  test("light / dark: paper by default, switches the moment it's tapped, and the choice sticks", async ({ page }) => {
    await page.goto(link(PLAN));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.click("#btn-settings");
    await page.click('#settings [data-theme-pick="dark"]');
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator('#settings [data-theme-pick="dark"]')).toHaveAttribute("aria-pressed", "true");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(20, 20, 20)");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
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
