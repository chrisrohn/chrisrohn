// A race's course (fitness/course.py, from the organizer's GPX in fitness/courses/): the race card's profile, hills and
// clock on the dashboard, and the line handed to ride mode, which keeps it as a route once, under its own id, and
// picks it on race morning. Built from the 2026 Iceman file at a fixed date, so the spec doesn't depend on today's.
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import { DATA, watch, axe } from "./fixtures.mjs";

test.use({ baseURL: "http://127.0.0.1:8766" });

const COURSE = JSON.parse(execFileSync("python3", ["-c", `
import json, sys
from datetime import datetime
from fitness import course, raceday
c = course.load("courses/iceman-2026.gpx")
plan = raceday.course_plan(c, units="imperial", settle="147–155 bpm", minutes=129, gun=datetime(2026, 11, 7, 9, 24), on_phone=True)
sys.stdout.write(json.dumps({"plan": plan, "share": course.share(c, "Bell's Iceman Cometh Challenge", 2026)}))
`], { cwd: new URL("../..", import.meta.url), maxBuffer: 16 << 20 }).toString());

const today = new Date();
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const phoneLink = d => "/#d=" + deflateRawSync(Buffer.from(JSON.stringify(d))).toString("base64url");
const rideLink = plan => "/ride.html#z=" + deflateRawSync(Buffer.from(JSON.stringify({ lthr: 160, max_hr: 185, rest_hr: 50, units: "imperial", days: [], ...plan }))).toString("base64url");

/** No outside service: map tiles, places and heights all answer "nothing here". @param {import("@playwright/test").Page} page */
async function offline(page) {
  const none = route => route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }, body: "{}" });
  for (const host of ["https://tiles.openfreemap.org/**", "https://overpass-api.de/**", "https://api.open-meteo.com/**", "https://brouter.de/**"]) await page.context().route(host, none);
}

test.describe("the race's course", () => {
  test("the race card draws the course: its profile with the hills, what it asks, the clock at each third", async ({ page }) => {
    const problems = watch(page);
    const race = { ...DATA.race_day[0], course: COURSE.plan };
    await page.goto(phoneLink({ ...DATA, race_day: [race, ...DATA.race_day.slice(1)] }));
    await page.locator("#tab-plan").click();
    const card = page.locator("#race .race-day").first().locator("section.course");
    await expect(card.locator("h3")).toContainText(`The course: 27.4 mi · 1,611 ft up · ${COURSE.plan.kicks} rises, 3 climbs`);
    await expect(card.locator("#c-course-0 svg")).toBeVisible();
    expect(await card.locator("#c-course-0 svg rect[style*='--s2']").count()).toBe(COURSE.plan.hills.length);   // each hill shaded
    await expect(card.locator("ul.checks li")).toHaveCount(COURSE.plan.notes.length);
    await expect(card).toContainText("back-loaded");
    await expect(card.locator("dl.timeline dt")).toHaveText(["9.1 mi", "18.3 mi", "27.4 mi"]);
    await card.locator("details.hills summary").click();
    await expect(card.locator("details.hills tbody tr")).toHaveCount(14);
    await expect(card.locator("details.hills tbody tr").last()).toContainText(COURSE.plan.hills[13].len);
    expect(COURSE.plan.hills[13].len).toMatch(/^\d+ yd$/);                                  // the wall before the line, in yards
    // the tooltip names the hill under the finger
    const last = COURSE.plan.hills[COURSE.plan.hills.length - 1], P = COURSE.plan.profile;
    const j = P.findIndex(p => p[0] >= last.start_km);
    await card.locator("#c-course-0").focus();
    for (let k = P.length - 1; k > j; k--) await page.keyboard.press("ArrowLeft");
    await expect(card.locator("#c-course-0 .tip")).toContainText("Hill");
    await page.keyboard.press("Escape");
    expect(await axe(page)).toEqual([]);
    expect(problems).toEqual([]);
  });

  test("ride mode keeps the course as a route once, and picks it only on race morning", async ({ page }) => {
    const problems = watch(page);
    await offline(page);
    const tomorrow = new Date(today.getTime() + 864e5);
    await page.goto(rideLink({ race: { name: "Bell's Iceman Cometh Challenge", date: iso(tomorrow), course: COURSE.share } }));
    await expect(page.locator("#btn-start")).toBeVisible();
    const routes = () => page.evaluate(async () => (await /** @type {any} */ (window).__ride.DB.all("routes")).map(r => ({ id: r.id, name: r.name, n: r.points.length, dist: r.dist })));
    await expect.poll(routes).toEqual([{ id: COURSE.share.id, name: "2026 Iceman", n: COURSE.share.points.length, dist: expect.any(Number) }]);
    const [r] = await routes();
    expect(Math.abs(r.dist / 1000 - COURSE.share.km)).toBeLessThan(0.2);                 // the thinned line keeps its length
    await expect(page.locator("#route-name")).toHaveText("No route loaded");                // not race day: nothing chosen for you

    // race morning: the same course isn't added twice, and it's the route
    await page.goto("about:blank");
    await page.goto(rideLink({ race: { name: "Bell's Iceman Cometh Challenge", date: iso(today), course: COURSE.share } }));
    await expect(page.locator("#route-name")).toContainText(/^2026 Iceman · 27\.[34] mi · 1,?0\d\d ft up$/);
    expect(await routes()).toHaveLength(1);

    // chosen once: clear it and reload, and it stays cleared
    await page.evaluate(() => /** @type {any} */ (window).__ride.useRoute(null));
    await page.goto("about:blank");
    await page.goto(rideLink({ race: { name: "Bell's Iceman Cometh Challenge", date: iso(today), course: COURSE.share } }));
    await expect(page.locator("#btn-start")).toBeVisible();
    await expect(page.locator("#route-name")).toHaveText("No route loaded");
    expect(problems).toEqual([]);
  });

  test("a course from a link is checked before it's kept: a bad id or junk points never become a route", async ({ page }) => {
    const problems = watch(page);
    await offline(page);
    const junk = { ...COURSE.share, id: "x\"><img src=x onerror=window.__pwned=1>", name: "<b>x</b>" };
    await page.goto(rideLink({ race: { name: "X", date: iso(today), course: junk } }));
    await expect(page.locator("#btn-start")).toBeVisible();
    const count = () => page.evaluate(async () => (await /** @type {any} */ (window).__ride.DB.all("routes")).length);
    expect(await count()).toBe(0);
    await page.goto("about:blank");
    await page.goto(rideLink({ race: { name: "X", date: iso(today), course: { id: "course-x-2026", name: "<b>x</b>", points: [["a", 1], [null, 2], [91, 0]] } } }));
    await expect(page.locator("#btn-start")).toBeVisible();
    expect(await count()).toBe(0);
    expect(await page.evaluate(() => /** @type {any} */ (window).__pwned)).toBeUndefined();
    expect(problems).toEqual([]);
  });
});
