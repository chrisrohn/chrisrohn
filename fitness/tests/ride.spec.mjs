// Ride mode (/fitness/ride.html, written by fitness/build-ride.mjs from fitness/site): it loads clean under its own CSP, passes axe, takes
// its plan from a #z= link without ever executing what the link carries, and its settings sheet works under
// form-action 'none'.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { deflateRawSync } from "node:zlib";

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
const link = plan => "/fitness/ride.html#z=" + deflateRawSync(Buffer.from(JSON.stringify(plan))).toString("base64url");

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
    await page.goto("/fitness/ride.html");
    await expect(page.locator("#btn-start")).toBeVisible();
    expect(await page.locator('meta[name="robots"]').getAttribute("content")).toBe("noindex, nofollow");
    const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    expect(policy).toMatch(/^default-src 'none'; script-src 'sha256-[^']+' 'sha256-[^']+';/);
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
    expect(r.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join(", ")}`)).toEqual([]);
    expect(problems).toEqual([]);
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
    await page.goto("/fitness/ride.html#z=not-a-plan");                                  // junk is ignored, the saved plan stays
    await expect(page.locator("#day option")).toHaveCount(2);
    expect(problems).toEqual([]);
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
});
