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
  // a first visit shows the shortlist (top 60 by score); the pill counts everything the filters allow
  const total = Number(await page.locator("#count-feed").innerText());
  expect(await cards.count()).toBe(Math.min(60, total));
  if (total > 60) {
    await expect(page.locator("#shortlist-note")).toContainText(`show all ${total}`);
    await page.click("#show-all");
    await expect(page.locator("#shortlist")).not.toBeChecked();
    // the full list is paged: 80 cards first, the rest as you scroll
    await expect.poll(() => cards.count()).toBe(Math.min(80, total));
    if (total > 80) {
      await page.locator("#more-sentinel").scrollIntoViewIfNeeded();
      await expect.poll(() => cards.count()).toBeGreaterThan(80);
    }
  }
  // a tag on a card is a filter: it lands in the search box and narrows the list
  const tag = page.locator("#list .card .tag").first();
  if (await tag.count()) {
    const t = await tag.innerText();
    await tag.click();
    await expect(page.locator("#q")).toHaveValue(t.toLowerCase());
    await expect.poll(() => cards.count()).toBeLessThan(total);
    await page.fill("#q", "");
    await expect.poll(() => cards.count()).toBeGreaterThan(50);
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
  // no thumbs, no Skipped tab for a listener; no fabricated years
  await expect(page.locator("#list .card .btn.up").first()).toBeHidden();
  await expect(page.locator(".tab[data-view=skipped]")).toBeHidden();
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
  // the stats sheet opens from ⚙ and, for a listener, explains what it would show
  await page.click("#s-stats");
  await expect(page.locator("#settings")).toBeHidden();
  await expect(page.locator("#stats")).toBeVisible();
  await expect(page.locator("#stats-body")).toContainText("The daily build");
  expect(errors).toEqual([]);
});

test("a card's permalink (?t=id) opens on that card, even past the shortlist", async ({ page }) => {
  const feed = await fetch("http://127.0.0.1:8765/data/feed.json").then(r => r.json());
  // a low-ranked playable, recent track: the shortlist would not show it, so the site has to search for it
  const playable = feed.items.filter(i => i.youtube && i.youtube.videoId && !(Number.isFinite(i.year) && i.year < new Date().getFullYear() - 1));
  const target = playable[playable.length - 1];
  const errors = await open(page, `/?t=${encodeURIComponent(target.id)}`);
  const card = page.locator(`.card[data-id="${target.id}"]`);
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/current/);
  await expect(page.locator("#q")).not.toHaveValue("");
  expect(errors).toEqual([]);
});

test("a rated track feeds the personal ranking and the stats", async ({ page }) => {
  // pretend this account kept four tracks from one blog and skipped three from another (the Drive mirror shape)
  const feed = await fetch("http://127.0.0.1:8765/data/feed.json").then(r => r.json());
  const blogs = [...new Set(feed.items.flatMap(i => i.sources || []).filter(s => s.startsWith("rss:")))];
  const only = src => feed.items.filter(i => (i.sources || []).includes(src) && !(i.sources || []).some(s => s !== src && blogs.includes(s)));
  const srcs = blogs.filter(s => only(s).length >= 4).slice(0, 2);
  test.skip(srcs.length < 2, "needs two blogs with four or more tracks of their own in the committed feed");
  const rated = {};
  only(srcs[0]).slice(0, 4).forEach((i, n) => { rated[i.id] = { decision: "up", at: Date.now() - n * 1000, videoId: i.youtube?.videoId, artist: i.artist, title: i.title, sources: i.sources, tags: i.tags, year: i.year }; });
  only(srcs[1]).slice(0, 3).forEach((i, n) => { rated[i.id] = { decision: "down", at: Date.now() - n * 1000, local: true, videoId: i.youtube?.videoId, artist: i.artist, title: i.title, sources: i.sources, tags: i.tags }; });
  await page.addInitScript(([r, hash]) => {
    localStorage.setItem("id:rated", JSON.stringify(r));
    localStorage.setItem("id:auth", JSON.stringify({ email: "curator@example.com", name: "Curator", hash }));
    localStorage.setItem("id:filters", JSON.stringify({ shortlist: false }));
  }, [rated, feed.google.curator_hashes[0]]);
  const errors = await open(page);
  await expect(page.locator("body")).toHaveClass(/curator/);
  // the Skipped tab lists the three local skips and offers to restore them
  await page.click(".tab[data-view=skipped]");
  await expect(page.locator("#list .card")).toHaveCount(3);
  await expect(page.locator("#list .card .btn.restore").first()).toBeVisible();
  await page.locator("#list .card .btn.restore").first().click();
  await expect(page.locator("#list .card")).toHaveCount(2);
  // a track from the kept-from blog carries a learned bonus on its score (four keeps: a nudge, not yet a reason line)
  await page.click(".tab[data-view=feed]");
  const next = only(srcs[0]).find(i => !rated[i.id] && i.youtube?.videoId && !(Number.isFinite(i.year) && i.year < new Date().getFullYear() - 1));
  await page.fill("#q", next.title);
  const liked = page.locator(`.card[data-id="${next.id}"]`);
  await expect(liked).toBeVisible();
  await expect(liked.locator(".score")).toHaveAttribute("title", /\+ 0\.\d learned from your keeps and skips/);
  await page.click("#settings-btn"); await page.click("#s-stats");
  await expect(page.locator("#stats-body")).toContainText("4 kept · 2 skipped");
  await expect(page.locator("#stats-body")).toContainText("Keep rate by source");
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

test("phone list view: compact header, folded filters, no broken artwork glyphs", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => localStorage.setItem("id:settings", JSON.stringify({ deck: false })));
  const page = await ctx.newPage();
  const errors = await open(page);
  await expect(page.locator("body")).not.toHaveClass(/deck-mode/);
  // the sticky header and the folded filter strip together leave most of the screen to the cards
  const top = await page.locator(".top").boundingBox(); const filters = await page.locator("#filters").boundingBox();
  expect(top.height + filters.height).toBeLessThan(220);
  await expect(page.locator("#sources")).toBeHidden();
  // phones get the install offer as a bar under the header, never a header button; ✕ dismisses it
  await expect(page.locator("#install-btn")).toBeHidden();
  await expect(page.locator("#install-bar")).toBeVisible();
  await page.click("#install-bar-x");
  await expect(page.locator("#install-bar")).toBeHidden();
  await page.click("#filters-more");
  await expect(page.locator("#sources")).toBeVisible();
  await expect(page.locator("#filters-more")).toHaveText(/hide/);
  // every tappable control clears the 40px touch-target floor
  for (const sel of ["#filters-more", "#layout-toggle", "#settings-btn", "#theme-btn", ".tab", "#signin"]) {
    const box = await page.locator(sel).first().boundingBox(); expect(box.height, sel).toBeGreaterThanOrEqual(40);
  }
  expect(errors).toEqual([]);
  await ctx.close();
});

test("manifest is installable: icons, screenshots and shortcuts all resolve", async ({ page, request }) => {
  await open(page);
  for (const p of ["/sw.js", "/manifest.webmanifest", "/feed.xml", "/data/duplicates.json", "/privacy.html", "/terms.html"]) {
    const r = await request.get(p); expect(r.ok(), p).toBeTruthy();
  }
  const m = await (await request.get("/manifest.webmanifest")).json();
  expect(m.id).toBe("/"); expect(m.display).toBe("standalone"); expect(m.start_url).toMatch(/^\//);
  expect(m.icons.some(i => i.sizes === "512x512" && /maskable/.test(i.purpose))).toBeTruthy();
  expect(m.screenshots.filter(s => s.form_factor === "narrow").length).toBeGreaterThanOrEqual(1);
  expect(m.screenshots.filter(s => s.form_factor === "wide").length).toBeGreaterThanOrEqual(1);
  expect(m.shortcuts.length).toBeGreaterThanOrEqual(2);
  const files = [...m.icons.map(i => i.src), ...m.screenshots.map(s => s.src), ...m.shortcuts.flatMap(s => (s.icons || []).map(i => i.src))];
  for (const f of new Set(files)) { const r = await request.get(f); expect(r.ok(), f).toBeTruthy(); }
  // the shortcut URLs land on the right tab / filter and leave a clean address
  await page.goto("/?view=picks&source=shortcut");
  await expect(page.locator(".tab[data-view=picks]")).toHaveClass(/active/);
  expect(new URL(page.url()).search).toBe("");
  await page.goto("/?new=1");
  await expect(page.locator("#only-new")).toBeChecked();
});

test("theme toggle: header button, ⚙ select and the t key switch, persist and follow the device", async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: "light" });
  const page = await ctx.newPage();
  const errors = await open(page);
  const html = page.locator("html"), btn = page.locator("#theme-btn");
  const bg = c => expect(page.locator("body")).toHaveCSS("background-color", c);   // retries through the .2s fade
  const themeColor = () => page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map(m => m.getAttribute("content")));
  // fresh visit: following the device (light here), nothing pinned
  await expect(html).not.toHaveAttribute("data-theme");
  await expect(html).toHaveAttribute("data-scheme", "light");
  await bg("rgb(231, 227, 218)");
  expect(await themeColor()).toEqual(["#e7e3da", "#1c1c1a"]);
  await expect(btn).toHaveAttribute("title", /system.*now light.*switch to light/);
  // system → light → dark, the button says where it is going next, the browser chrome follows
  await btn.click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await btn.click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(html).toHaveAttribute("data-scheme", "dark");
  await bg("rgb(28, 28, 26)");
  expect(await themeColor()).toEqual(["#1c1c1a", "#1c1c1a"]);
  await expect(btn).toHaveAttribute("title", /dark.*switch to system/);
  // the player and the footer sit on the same board as the page, in either scheme
  await expect(page.locator("footer")).toHaveCSS("background-color", "rgb(38, 38, 35)");
  await page.evaluate(() => { document.querySelector("#player").hidden = false; });
  await expect(page.locator("#player .player-meta")).toHaveCSS("background-color", "rgb(38, 38, 35)");
  await expect(page.locator("#player")).toHaveCSS("color", "rgb(235, 231, 220)");
  // dark is pinned: it survives a reload with no flash of light (theme.js runs in <head>) and a device on light
  await page.reload();
  expect(await page.evaluate(() => localStorage.getItem("id:theme"))).toBe("dark");
  await expect(html).toHaveAttribute("data-theme", "dark");
  await bg("rgb(28, 28, 26)");
  await expect(page.locator("#meta")).not.toHaveText(/loading feed/, { timeout: 15_000 });
  // ⚙ → Theme shows the same choice and can set it back to the device
  await page.click("#settings-btn");
  await expect(page.locator("#s-theme")).toHaveValue("dark");
  await page.selectOption("#s-theme", "auto");
  await expect(html).not.toHaveAttribute("data-theme");
  await bg("rgb(231, 227, 218)");
  await page.keyboard.press("Escape");
  // the t key cycles too, with a toast
  await page.locator("#meta").click();
  await page.keyboard.press("t");
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".toast")).toContainText(/Theme: light/);
  await page.keyboard.press("t");
  await expect(html).toHaveAttribute("data-theme", "dark");
  // "system" follows the device when it changes; a pinned choice does not
  await ctx.setOffline(false);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("t");   // → system
  await expect(html).not.toHaveAttribute("data-theme");
  await expect(html).toHaveAttribute("data-scheme", "dark");
  await bg("rgb(28, 28, 26)");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).toHaveAttribute("data-scheme", "light");
  await bg("rgb(231, 227, 218)");
  // the legal pages share the switch and the saved choice
  await page.keyboard.press("t"); await page.keyboard.press("t");   // → light → dark
  await page.goto("/privacy.html");
  await expect(html).toHaveAttribute("data-theme", "dark");
  await bg("rgb(28, 28, 26)");
  await page.click("#theme-btn");
  await expect(html).not.toHaveAttribute("data-theme");
  await bg("rgb(231, 227, 218)");
  await page.goto("/terms.html");
  await expect(page.locator("#theme-btn")).toBeVisible();
  await expect(html).not.toHaveAttribute("data-theme");
  expect(errors).toEqual([]);
  await ctx.close();
});

test("service worker installs, caches the shell and answers offline", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = await open(page);
  // 127.0.0.1 is a secure context, so the worker registers here just as it does on https
  const active = await page.evaluate(() => Promise.race([navigator.serviceWorker.ready.then(r => !!r.active), new Promise(r => setTimeout(() => r(false), 15_000))]));
  expect(active, "service worker active").toBeTruthy();
  // precache: the shell and the feed are in the build cache without a second visit
  await expect.poll(async () => page.evaluate(async () => {
    const keys = await caches.keys(); const c = await caches.open(keys.find(k => k.startsWith("newmusic-") && k !== "newmusic-art") || "");
    const need = ["/", "/style.css", "/theme.js", "/data/feed.json", "/privacy.html", "/manifest.webmanifest"];
    const hits = await Promise.all(need.map(p => c.match(location.origin + p)));
    return hits.filter(Boolean).length;
  }), { timeout: 15_000 }).toBe(6);
  // no install prompt from headless Chromium: the Install button falls back to the how-to sheet, and ⚙ names the build
  await page.click("#install-btn");
  await expect(page.locator("#install-help")).toBeVisible();
  expect(await page.locator("#install-steps li").count()).toBeGreaterThan(0);
  await page.click("#install-later");
  await page.keyboard.press("Escape");
  await expect(page.locator("#install-btn")).toBeHidden();   // "not now" sticks
  await page.click("#settings-btn");
  await expect(page.locator("#s-build")).toHaveText(/build [0-9a-f]{6,}/);
  await expect(page.locator("#s-update-btn")).toBeVisible();
  await page.keyboard.press("Escape");
  // offline: the controlled page reloads from the cache with the feed intact
  await ctx.setOffline(true);
  await page.reload();
  await expect(page.locator("#meta")).toContainText("candidates", { timeout: 15_000 });
  await ctx.setOffline(false);
  expect(errors.filter(e => !/Failed to load resource|net::ERR_INTERNET_DISCONNECTED/.test(e))).toEqual([]);
  await ctx.close();
});

/** A small catalog.json in the shape discovery/catalog.py writes, made from the committed feed's playable tracks. */
async function catalogFixture() {
  const feed = await fetch("http://127.0.0.1:8765/data/feed.json").then(r => r.json());
  const playable = feed.items.filter(i => i.youtube && i.youtube.videoId).slice(0, 40);
  const years = {};
  const items = playable.map((i, n) => {
    const year = n % 5 === 0 ? null : 1995 + (n % 20);
    if (year) years[year] = { playlist: 30 + n, candidates: (years[year]?.candidates || 0) + 1 };
    return { ...i, id: "cat" + i.id, year, year_source: year ? "musicbrainz-search" : "unknown", year_confidence: year ? "high" : "low", release_date: null, first_seen: feed.generated_at.slice(0, 10),
      sources: n % 3 ? ["lastfm:top tracks"] : ["lastfm:loved", "lastfm:artist top"], plays: 200 - n, loved: n % 3 === 0, score: 8 - n / 10, reasons: [`${200 - n} plays`] };
  });
  return { generated_at: feed.generated_at, candidates: 500, count: items.length, undated: items.filter(i => !i.year).length, sources: ["lastfm:artist top", "lastfm:loved", "lastfm:top tracks"], years, items };
}

test("the Catalog tab: earlier years with a year select, or a note until the first build", async ({ browser }) => {
  // the service worker would answer data/catalog.json itself, past the route below: keep it out of this test
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const page = await ctx.newPage();
  // before the daily job has ever built one, the tab explains itself instead of failing
  let errors = await open(page);
  await page.click(".tab[data-view=catalog]");
  await expect(page.locator("#empty")).toContainText("No catalog yet");
  expect(errors).toEqual([]);
  // with a catalog: cards, Last.fm source chips, and the year select narrows the list
  const cat = await catalogFixture();
  await page.route("**/data/catalog.json", route => route.fulfill({ json: cat }));
  errors = await open(page, "/?view=catalog");
  const cards = page.locator("#list .card");
  await expect.poll(() => cards.count()).toBe(cat.count);
  await expect(page.locator("#count-catalog")).toHaveText(String(cat.count));
  await expect(page.locator("#sources label").first()).toContainText(/Your artists|Loved|Most played/);
  await expect(page.locator("#cat-year")).toBeVisible();
  await expect(page.locator("#sort")).toBeHidden();
  await expect(cards.first().locator(".reasons")).toContainText("plays");
  const year = Object.keys(cat.years)[0];
  await page.selectOption("#cat-year", year);
  await expect.poll(() => cards.count()).toBe(cat.years[year].candidates);
  await expect(cards.first().locator(".yearbadge")).toContainText(year);
  await page.selectOption("#cat-year", "?");
  await expect.poll(() => cards.count()).toBe(cat.undated);
  await expect(cards.first().locator(".yearbadge")).toHaveText("year unknown");
  // back to the feed: the feed's own chips and sort return
  await page.click(".tab[data-view=feed]");
  await expect(page.locator("#sort")).toBeVisible();
  await expect(page.locator("#cat-year")).toBeHidden();
  await expect(page.locator("#sources label").first()).not.toContainText(/Most played/);
  expect(errors).toEqual([]);
  await ctx.close();
});
