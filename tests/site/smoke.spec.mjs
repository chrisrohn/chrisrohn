// Loads the site against the committed feed.json and checks the things a visitor does first. Any uncaught error or
// console error fails the test, so a broken app.js can't reach GitHub Pages.
import { test, expect } from "@playwright/test";

const SITE_FILES = "/index.html";

async function open(page, path = SITE_FILES) {
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  // artwork and the YouTube player come from other hosts, which a sandboxed CI runner may not reach: only script errors count
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  await page.goto(path);
  await expect(page.locator("#meta")).not.toHaveText(/loading feed/, { timeout: 15_000 });
  return errors;
}

test("feed renders, filters work, controls unlock, no console errors", async ({ page }) => {
  const errors = await open(page);
  const feed = await page.evaluate(() => fetch("data/feed.json").then(r => r.json()));
  await expect(page.locator("#meta")).toContainText(`${feed.count} candidates`);
  // list view on a desktop viewport; deck mode on a phone
  const cards = page.locator("#list .card");
  expect(await cards.count()).toBeGreaterThan(50);
  // the list is paged: 80 cards first, the rest as you scroll; the pill counts everything that matches
  const total = Number(await page.locator("#count-feed").innerText());
  expect(await cards.count()).toBe(Math.min(80, total));
  if (total > 80) {
    await page.locator("#more-sentinel").scrollIntoViewIfNeeded();
    await expect.poll(() => cards.count()).toBeGreaterThan(80);
  }
  // the sign-in button and settings unlock once the feed is in (they read feed.json)
  await expect(page.locator("#signin")).toBeEnabled();
  await expect(page.locator("#settings-btn")).toBeEnabled();
  // search narrows the list (debounced)
  const first = await cards.first().locator(".artist").innerText();
  const before = await cards.count();
  await page.fill("#q", first.slice(0, Math.min(6, first.length)));
  await expect.poll(() => cards.count()).toBeLessThan(before);
  await page.fill("#q", "");
  await expect.poll(() => cards.count()).toBeGreaterThan(50);
  // no thumbs for a listener; no fabricated years
  await expect(page.locator("#list .card .btn.up").first()).toBeHidden();
  const unknown = feed.items.find(i => i.year_source === "unknown" && i.youtube);
  if (unknown) {
    const card = page.locator(`.card[data-id="${unknown.id}"]`);
    if (await card.count()) await expect(card.locator(".yearbadge")).toHaveText("year unknown");
  }
  // keyboard: j focuses the first card; a stray "u" with nothing current must not throw
  await page.locator("#meta").click();   // leave the search box, then drive the list from the keyboard
  await page.keyboard.press("u");
  await page.keyboard.press("j");
  await expect(page.locator(".card.current")).toHaveCount(1);
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("settings dialog opens and lists feed health", async ({ page }) => {
  const errors = await open(page);
  await page.click("#settings-btn");
  await expect(page.locator("#settings")).toBeVisible();
  expect(await page.locator("#s-feeds span").count()).toBeGreaterThan(10);
  await expect(page.locator("#s-quota")).toContainText("YouTube API units");
  expect(errors).toEqual([]);
});

test("phone viewport uses the deck", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = await open(page);
  await expect(page.locator("body")).toHaveClass(/deck-mode/);
  await expect(page.locator("#deck-card .dcard")).toHaveCount(1);
  await page.click("#deck-next");
  await expect(page.locator("#deck-count")).toContainText("2 /");
  expect(errors).toEqual([]);
  await ctx.close();
});

test("service worker and manifest are reachable", async ({ page, request }) => {
  await open(page);
  for (const p of ["/sw.js", "/manifest.webmanifest", "/feed.xml", "/data/duplicates.json"]) {
    const r = await request.get(p); expect(r.ok(), p).toBeTruthy();
  }
});
