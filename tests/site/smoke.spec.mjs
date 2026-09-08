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
    await expect(page.locator("#q")).toHaveValue(`tag:"${t.toLowerCase()}"`);
    await expect.poll(() => cards.count()).toBeLessThan(total);
    // …as a chip, and the address follows; the chip's ✕ takes the term out again
    await expect(page.locator("#chips .qchip")).toHaveCount(1);
    expect(new URL(page.url()).searchParams.get("q")).toBe(`tag:"${t.toLowerCase()}"`);
    await page.locator("#chips .qchip").click();
    await expect(page.locator("#q")).toHaveValue("");
    await expect.poll(() => cards.count()).toBeGreaterThan(50);
    expect(new URL(page.url()).search).toBe(total > 60 ? "?shortlist=0" : "");   // "show all" above is part of the address; the search term is gone
  }
  // the sign-in button and settings unlock once the feed is in (they read feed.json)
  await expect(page.locator("#signin")).toBeEnabled();
  await expect(page.locator("#settings-btn")).toBeEnabled();
  // search narrows the list (debounced); every word must match; artist: aims at one field; accents are folded
  const first = await cards.first().locator(".artist").innerText();
  const before = await cards.count();
  await page.fill("#q", first.slice(0, Math.min(6, first.length)));
  await expect.poll(() => cards.count()).toBeLessThan(before);
  await page.fill("#q", `artist:"${first}"`);
  await expect.poll(() => cards.count()).toBeGreaterThan(0);
  expect(await cards.locator(".artist").allInnerTexts()).toEqual(expect.arrayContaining([first]));
  await page.fill("#q", `${first.slice(0, 4)} zzzz-nothing-has-this`);
  await expect.poll(() => cards.count()).toBe(0);
  await page.fill("#q", "");
  await expect.poll(() => cards.count()).toBeGreaterThan(50);
  // the artist name opens the artist sheet with everything by them
  await cards.first().locator(".artist").click();
  await expect(page.locator("#artist")).toBeVisible();
  await expect(page.locator("#artist-name")).toHaveText(first, { ignoreCase: true });   // the card uppercases the name in CSS; the sheet shows it as written
  expect(await page.locator("#artist .arow").count()).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(page.locator("#artist")).toBeHidden();
  // a first visit shows the intro card; ✕ dismisses it for good
  await expect(page.locator("#intro")).toBeVisible();
  await page.click("#intro-x");
  await expect(page.locator("#intro")).toBeHidden();
  await page.reload();
  await expect(page.locator("#meta")).not.toHaveText(/loading feed/, { timeout: 15_000 });
  await expect(page.locator("#intro")).toBeHidden();
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
  const current = await page.locator(".card.current").getAttribute("data-id");
  await page.keyboard.press("ArrowRight");   // seek, never a thumb: the card stays
  await expect(page.locator(`.card[data-id="${current}"]`)).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.keyboard.press("j");            // Esc kept the place: j moves on from the same card, not from the top
  await expect(page.locator(".card.current")).toHaveCount(1);
  expect(await page.locator(".card.current").getAttribute("data-id")).not.toBe(await page.locator("#list .card").first().getAttribute("data-id"));
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
  // the kept-from blog must also carry three playable, recent tracks beyond the four keeps: a flagged one, a replaced one, and one left for the ranking to score
  const usable = src => only(src).filter(i => i.youtube?.videoId && !(Number.isFinite(i.year) && i.year < new Date().getFullYear() - 1));
  const first = blogs.find(s => usable(s).length >= 7);
  const srcs = [first, ...blogs.filter(s => s !== first && only(s).length >= 4)].slice(0, 2);
  test.skip(!first || srcs.length < 2, "needs a blog with seven or more playable tracks of its own, and another with four, in the committed feed");
  const rated = {};
  only(srcs[0]).slice(0, 4).forEach((i, n) => { rated[i.id] = { decision: "up", at: Date.now() - n * 1000, videoId: i.youtube?.videoId, artist: i.artist, title: i.title, sources: i.sources, tags: i.tags, year: i.year }; });
  only(srcs[1]).slice(0, 3).forEach((i, n) => { rated[i.id] = { decision: "down", at: Date.now() - n * 1000, local: true, videoId: i.youtube?.videoId, artist: i.artist, title: i.title, sources: i.sources, tags: i.tags }; });
  // …and flagged one of the kept-from blog's videos as the wrong one (judges the pairing, not the song: no verdict for the learner)
  const flagged = only(srcs[0]).find(i => !rated[i.id] && i.youtube?.videoId);
  rated[flagged.id] = { decision: "wrong", at: Date.now() - 9000, local: true, videoId: flagged.youtube.videoId, artist: flagged.artist, title: flagged.title, sources: flagged.sources, tags: flagged.tags };
  // a flag whose video the build has since replaced is no flag: that card is back on its own
  const replaced = only(srcs[0]).find(i => !rated[i.id] && i.youtube?.videoId);
  rated[replaced.id] = { decision: "wrong", at: Date.now() - 9500, local: true, videoId: "old-video-id", artist: replaced.artist, title: replaced.title };
  await page.addInitScript(([r, hash]) => {
    localStorage.setItem("id:rated", JSON.stringify(r));
    localStorage.setItem("id:auth", JSON.stringify({ email: "curator@example.com", name: "Curator", hash }));
    localStorage.setItem("id:filters", JSON.stringify({ shortlist: false }));
  }, [rated, feed.google.curator_hashes[0]]);
  const errors = await open(page);
  await expect(page.locator("body")).toHaveClass(/curator/);
  // the Skipped tab lists the three local skips and the wrong-video flag (not the replaced one) and offers to restore them
  await page.click(".tab[data-view=skipped]");
  await expect(page.locator("#list .card")).toHaveCount(4);
  await expect(page.locator(`.card[data-id="${flagged.id}"] .status`)).toHaveText(/≠ wrong video/);
  await expect(page.locator(`.card[data-id="${replaced.id}"]`)).toHaveCount(0);
  await expect(page.locator("#restore-all")).toContainText("restore all");
  await expect(page.locator("#list .card .btn.restore").first()).toBeVisible();
  await page.locator("#list .card:not(:has(.status.wrong)) .btn.restore").first().click();
  await expect(page.locator("#list .card")).toHaveCount(3);
  // z takes back the last thumb from the keyboard, too (the restore above was not a thumb: nothing to undo)
  await page.locator("#meta").click();
  await page.keyboard.press("z");
  await expect(page.locator(".toast")).toContainText("Nothing to undo");
  // a track from the kept-from blog carries a learned bonus on its score (four keeps: a nudge, not yet a reason line)
  await page.click(".tab[data-view=feed]");
  const next = only(srcs[0]).find(i => !rated[i.id] && i.youtube?.videoId && !(Number.isFinite(i.year) && i.year < new Date().getFullYear() - 1));
  await page.fill("#q", next.title);
  const liked = page.locator(`.card[data-id="${next.id}"]`);
  await expect(liked).toBeVisible();
  await expect(liked.locator(".score")).toHaveAttribute("title", /\+ 0\.\d learned from your keeps and skips/);
  // the third verdict: ≠ on the card hides it as "wrong video" (free, no year needed), z brings it straight back
  await expect(liked.locator(".btn.wrong")).toBeVisible();
  await liked.locator(".btn.wrong").click();
  await expect(liked).toHaveCount(0);
  await expect(page.locator(".toast")).toContainText("wrong video");
  await page.locator("#meta").click();
  await page.keyboard.press("z");
  await expect(page.locator(`.card[data-id="${next.id}"]`)).toBeVisible();
  // the x key does the same from the keyboard
  await page.locator(`.card[data-id="${next.id}"]`).focus();
  await page.keyboard.press("x");
  await expect(page.locator(`.card[data-id="${next.id}"]`)).toHaveCount(0);
  await page.click("#settings-btn"); await page.click("#s-stats");
  await expect(page.locator("#stats-body")).toContainText("4 kept · 2 skipped");   // the flags judge no song: they count nowhere
  await expect(page.locator("#stats-body")).toContainText("3 cards flagged as the wrong video");
  await expect(page.locator("#stats-body")).toContainText("Keep rate by source");
  expect(errors).toEqual([]);
});

test("the third verdict: ≠ wrong video hides a card without judging the song, until the build swaps the video", async ({ browser }) => {
  const feed = await fetch("http://127.0.0.1:8765/data/feed.json").then(r => r.json());
  const playable = feed.items.filter(i => i.youtube && i.youtube.videoId && !(Number.isFinite(i.year) && i.year < new Date().getFullYear() - 1));
  const [flagged, replaced] = playable;
  const rated = {
    // flagged on another device: hidden while the build still pairs the track with that video
    [flagged.id]: { decision: "wrong", at: Date.now() - 9000, local: true, videoId: flagged.youtube.videoId, artist: flagged.artist, title: flagged.title, sources: flagged.sources, tags: flagged.tags },
    // flagged, and the build has since resolved the track to another upload: the flag is spent, the card is back
    [replaced.id]: { decision: "wrong", at: Date.now() - 9500, local: true, videoId: "old-video-id", artist: replaced.artist, title: replaced.title },
  };
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  await ctx.addInitScript(([r, hash]) => {
    localStorage.setItem("id:rated", JSON.stringify(r));
    localStorage.setItem("id:auth", JSON.stringify({ email: "curator@example.com", name: "Curator", hash }));
    localStorage.setItem("id:filters", JSON.stringify({ shortlist: false, onlyRecent: false }));
  }, [rated, feed.google.curator_hashes[0]]);
  const page = await ctx.newPage();
  const errors = await open(page);
  await expect(page.locator("body")).toHaveClass(/curator/);
  await expect(page.locator(`.card[data-id="${replaced.id}"]`)).toBeVisible();
  await expect(page.locator(`.card[data-id="${flagged.id}"]`)).toHaveCount(0);
  // every playable card carries the three verdicts; ≠ names what it does
  const first = page.locator("#list .card").first();
  await expect(first.locator(".thumbs .btn")).toHaveCount(3);
  await expect(first.locator(".btn.wrong")).toHaveText("≠");
  await expect(first.locator(".btn.wrong")).toHaveAttribute("title", /wrong video \(x\)/);
  // the Skipped tab lists the live flag as "wrong video" (not the spent one) and restores it
  await page.click(".tab[data-view=skipped]");
  await expect(page.locator("#list .card")).toHaveCount(1);
  await expect(page.locator(`.card[data-id="${flagged.id}"] .status`)).toHaveText(/≠ wrong video · \d+ d ago/);
  await expect(page.locator(`.card[data-id="${flagged.id}"] .status`)).toHaveClass(/wrong/);
  await page.locator(`.card[data-id="${flagged.id}"] .btn.restore`).click();
  await expect(page.locator("#list .card")).toHaveCount(0);
  // ≠ on a card: gone at once, free (no year needed, no sign-in refresh), with Undo in the toast and on z
  await page.click(".tab[data-view=feed]");
  const target = page.locator(`.card[data-id="${flagged.id}"]`);
  await expect(target).toBeVisible();
  const before = Number(await page.locator("#count-feed").innerText());   // the pill counts the whole list; the page is paged
  await target.locator(".btn.wrong").click();
  await expect(target).toHaveCount(0);
  await expect(page.locator(".toast")).toContainText(`≠ ${flagged.artist}`);
  await expect(page.locator(".toast")).toContainText("wrong video");
  await expect(page.locator("#count-feed")).toHaveText(String(before - 1));
  await page.locator("#meta").click();
  await page.keyboard.press("z");
  await expect(target).toBeVisible();
  await expect(page.locator("#count-feed")).toHaveText(String(before));
  // the x key does the same for the card the keyboard is on
  await target.focus();
  await page.keyboard.press("x");
  await expect(target).toHaveCount(0);
  const stored = await page.evaluate(id => JSON.parse(localStorage.getItem("id:rated") || "{}")[id], flagged.id);
  expect(stored.decision).toBe("wrong"); expect(stored.videoId).toBe(flagged.youtube.videoId); expect(stored.local).toBe(true);
  // the flags judge no song: the stats count them apart and they teach the ranking nothing
  await page.click("#settings-btn"); await page.click("#s-stats");
  await expect(page.locator("#stats-body")).toContainText("0 kept · 0 skipped");
  await expect(page.locator("#stats-body")).toContainText("2 cards flagged as the wrong video");
  expect(errors).toEqual([]);
  await ctx.close();
  // on the phone deck the same verdict is the ≠ button beside skip and keep
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  await phone.addInitScript(([hash]) => { localStorage.setItem("id:auth", JSON.stringify({ email: "curator@example.com", name: "Curator", hash })); localStorage.setItem("id:settings", JSON.stringify({ introDismissed: true, installDismissedAt: Date.now() })); }, [feed.google.curator_hashes[0]]);
  const pp = await phone.newPage();
  const perrors = await open(pp);
  await expect(pp.locator("body")).toHaveClass(/deck-mode/);
  const deckId = await pp.locator("#deck-card .dcard").getAttribute("data-id");
  await expect(pp.locator("#deck-wrong")).toBeVisible();
  for (const sel of ["#deck-wrong", "#deck-down", "#deck-up", "#deck-play"]) { const box = await pp.locator(sel).boundingBox(); expect(box.height, sel).toBeGreaterThanOrEqual(40); expect(box.x + box.width, sel).toBeLessThanOrEqual(390); }
  await pp.click("#deck-wrong");
  await expect(pp.locator(".toast")).toContainText("wrong video");
  await expect(pp.locator("#deck-card .dcard")).not.toHaveAttribute("data-id", deckId);
  expect(perrors).toEqual([]);
  await phone.close();
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
  const feed = await page.evaluate(() => fetch("data/feed.json").then(r => r.json()));
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
  await expect(page.locator("#meta")).not.toHaveText(/loading feed/, { timeout: 15_000 });
  expect(new URL(page.url()).search).toBe("?view=picks");   // the view is the address (shareable); the shortcut marker is gone
  await page.goto("/?new=1");
  await expect(page.locator("#only-new")).toBeChecked();
  // the share target: a YouTube link shared from another app opens on its card
  const shared = feed.items.find(i => i.youtube && i.youtube.videoId && !(Number.isFinite(i.year) && i.year < new Date().getFullYear() - 1));
  await page.goto(`/?url=${encodeURIComponent("https://music.youtube.com/watch?v=" + shared.youtube.videoId)}&title=x`);
  await expect(page.locator("#meta")).not.toHaveText(/loading feed/, { timeout: 15_000 });
  await expect(page.locator(`.card[data-id="${shared.id}"]`)).toHaveClass(/current/);
  expect(m.share_target.params.url).toBe("url");
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
  // offline: the controlled page reloads from the cache with the feed intact. "ready" resolves while the worker is
  // still activating, and it claims this page (controller set) from inside its activate step; a navigation handed to
  // a worker that is still activating can be dropped on a slow runner (net::ERR_ABORTED on the reload), so wait
  // until it is fully activated as well as controlling the page before pulling the network
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller && navigator.serviceWorker.controller.state === "activated"), { timeout: 15_000 }).toBeTruthy();
  await ctx.setOffline(true);
  await page.reload();
  await expect(page.locator("#meta")).toContainText("candidates", { timeout: 15_000 });
  await expect(page.locator("#offline")).toBeVisible();
  // the Cleanup reports are part of the shell now: answered from the cache too
  expect(await page.evaluate(() => fetch("/data/duplicates.json").then(r => r.ok).catch(() => false))).toBeTruthy();
  await ctx.setOffline(false);
  await expect(page.locator("#offline")).toBeHidden();
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
  // before the first Catalog build there is no catalog.json: the tab says so (the served site may well have one by now)
  await page.route("**/data/catalog.json", r => r.fulfill({ status: 404, body: "" }));
  let errors = await open(page);
  await page.click(".tab[data-view=catalog]");
  await expect(page.locator("#empty")).toContainText("No catalog yet");
  await page.unroute("**/data/catalog.json");
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

test("find year: an undated catalog card asks MusicBrainz and fills its year select", async ({ browser }) => {
  const feed = await fetch("http://127.0.0.1:8765/data/feed.json").then(r => r.json());
  const base = feed.items.find(i => i.youtube && i.youtube.videoId);
  const item = { ...base, id: "cat-undated", artist: "Chromeo", title: "Night By Night", display_title: "Night By Night", display: "Chromeo - Night By Night", year: null, year_source: "unknown", year_confidence: "low", year_evidence: [], release_date: null, sources: ["lastfm:top tracks"], plays: 120, loved: false, score: 5, reasons: ["120 plays"] };
  const cat = { generated_at: feed.generated_at, candidates: 1, count: 1, undated: 1, pending: 3, sources: ["lastfm:top tracks"], years: { 2010: { playlist: 5, candidates: 0 } }, items: [item] };
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  await ctx.addInitScript(([hash]) => { localStorage.setItem("id:auth", JSON.stringify({ email: "curator@example.com", name: "Curator", hash })); localStorage.setItem("id:filters", JSON.stringify({ onlyPlayable: false })); }, [feed.google.curator_hashes[0]]);
  const page = await ctx.newPage();
  await page.route("**/data/catalog.json", r => r.fulfill({ json: cat }));
  await page.route("https://musicbrainz.org/ws/2/recording*", r => r.fulfill({ json: { recordings: [
    { title: "Night By Night", "artist-credit": [{ name: "Chromeo" }], releases: [
      { title: "Business Casual", date: "2010-09-14", "release-group": { "primary-type": "Album", "first-release-date": "2010-09-14" } },
      { title: "Night By Night (Remixes)", date: "2010-06-01", "release-group": { "primary-type": "Single", "secondary-types": ["Remix"], "first-release-date": "2010-06-01" } },
      { title: "Now That's What I Call Indie", date: "2011-01-01", "release-group": { "primary-type": "Album", "secondary-types": ["Compilation"], "first-release-date": "2011-01-01" } }] },
    { title: "Night By Night", "artist-credit": [{ name: "Somebody Else" }], releases: [{ title: "Other", date: "1999-01-01", "release-group": { "first-release-date": "1999-01-01" } }] },
  ] } }));
  const errors = await open(page, "/?view=catalog");
  const card = page.locator('.card[data-id="cat-undated"]');
  await expect(card).toBeVisible();
  await expect(card.locator(".yearbadge")).toHaveText("year unknown");
  await expect(card.locator("a", { hasText: "discogs" })).toHaveAttribute("href", /discogs\.com\/search/);
  await expect(page.locator("#cat-year option").first()).toContainText("3 more being dated");
  await card.locator(".find-year").click();
  await expect(card.locator(".year")).toHaveValue("2010");          // the album, not the remix single, not the compilation, not the other artist
  await expect(card.locator(".yearbadge")).toHaveText("2010 · MusicBrainz");
  await expect(card.locator(".find-year")).toHaveText("2010 (1 release)");
  expect(errors).toEqual([]);
  await ctx.close();
});

test("the Cleanup tab: the duplicate report, filters, and the bulk button once a year is chosen", async ({ browser }) => {
  const feed = await fetch("http://127.0.0.1:8765/data/feed.json").then(r => r.json());
  test.skip(!feed.youtube.duplicates_count, "the committed feed reports no duplicates");
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  await ctx.addInitScript(([hash]) => { localStorage.setItem("id:auth", JSON.stringify({ email: "curator@example.com", name: "Curator", hash })); }, [feed.google.curator_hashes[0]]);
  const page = await ctx.newPage();
  const errors = await open(page);
  const tab = page.locator(".tab[data-view=cleanup]");
  await expect(tab).toBeVisible();
  await expect(page.locator("#count-cleanup")).toHaveText(String(feed.youtube.duplicates_count));
  await tab.click();
  await expect(page.locator("#cleanup")).toBeVisible();
  await expect(page.locator("#list .card")).toHaveCount(0);
  await expect(page.locator("#filters")).toBeHidden();
  await expect(page.locator("#cl-summary")).toContainText(`${feed.youtube.duplicates_count} duplicated songs`);
  await expect(page.locator("#cl-quota")).toContainText("removals possible today");
  await expect.poll(() => page.locator("#cl-dupes .dupe").count()).toBeGreaterThan(10);
  // a same-video duplicate offers to remove the extra copy; the bulk button waits for a kind and a year
  await expect(page.locator("#cl-dupe-bulk")).toBeHidden();
  await page.selectOption("#cl-dupe-kind", "same-video");
  const year = await page.locator("#cl-dupe-yr option").nth(1).getAttribute("value");
  await page.selectOption("#cl-dupe-yr", year);
  await expect(page.locator("#cl-dupe-bulk")).toBeVisible();
  await expect(page.locator("#cl-dupe-bulk")).toContainText(`extra copies in ${year}`);
  await expect(page.locator("#cl-dupes .dupe button[data-fix=extra]").first()).toBeVisible();
  // the filter narrows by title, and Settings points here too
  await page.fill("#cl-dupe-q", "zzzz-no-such-song");
  await expect(page.locator("#cl-dupes")).toContainText("nothing matches");
  await page.click("#settings-btn");
  await expect(page.locator("#s-dupes-summary")).toContainText("duplicated songs");
  await page.click("#s-cleanup");
  await expect(page.locator("#settings")).toBeHidden();
  await expect(page.locator("#cleanup")).toBeVisible();
  expect(errors).toEqual([]);
  await ctx.close();
});

test("Cleanup: tracks that will not stream here list their streamable counterpart and a swap", async ({ browser }) => {
  const feed = await fetch("http://127.0.0.1:8765/data/feed.json").then(r => r.json());
  const rows = [
    { year: "2021", playlistId: "PL2021", videoId: "dead1", position: 3, artist: "Jungle", title: "Keep Moving", alt: { videoId: "live1", title: "Keep Moving", album: "Loving In Stereo", videoType: "MUSIC_VIDEO_TYPE_ATV" }, pending: false },
    { year: "2016", playlistId: "PL2016", videoId: "dead2", position: 9, artist: "Roosevelt", title: "Lovers", alt: null, pending: false },
    { year: "2016", playlistId: "PL2016", videoId: "dead3", position: 1, artist: "Nobody", title: "Nothing", alt: null, pending: true },
  ];
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  await ctx.addInitScript(([hash]) => { localStorage.setItem("id:auth", JSON.stringify({ email: "curator@example.com", name: "Curator", hash })); }, [feed.google.curator_hashes[0]]);
  const page = await ctx.newPage();
  await page.route("**/data/feed.json", async r => { const j = await (await r.fetch()).json(); Object.assign(j.youtube, { unavailable_count: 3, unavailable_with_alt: 1, unavailable_pending: 1 }); await r.fulfill({ json: j }); });
  await page.route("**/data/unavailable.json", r => r.fulfill({ json: { count: 3, with_counterpart: 1, pending: 1, rows } }));
  const errors = await open(page);
  // the pills prove the feed (with its counts) and the catalog are both in before the tab is clicked: under
  // Playwright's request interception a report fetched while the catalog is still streaming can stall
  await expect(page.locator("#count-cleanup")).toHaveText(String((feed.youtube.duplicates_count || 0) + 3));
  await expect(page.locator("#count-catalog")).not.toHaveText("…", { timeout: 15_000 });
  await page.click(".tab[data-view=cleanup]");
  expect(errors).toEqual([]);   // a script error on the way would otherwise hide behind the next assertion's timeout
  const where = () => page.evaluate(() => ({ search: location.search, active: document.activeElement && document.activeElement.outerHTML.slice(0, 80), body: document.body.className, tab: document.querySelector(".tab.active")?.getAttribute("data-view"), cleanupHidden: document.querySelector("#cleanup").hidden, toast: document.querySelector(".toast")?.textContent || "" }));
  await expect.poll(async () => JSON.stringify(await where()), { timeout: 5000 }).toContain('"cleanupHidden":false');
  await expect(page.locator("#cl-summary")).toContainText("3 not streamable here (1 with a streamable counterpart, 1 still being searched)");
  await page.selectOption("#cl-dupe-kind", "unavailable");
  await expect(page.locator("#cl-dupes .dupe.unav")).toHaveCount(3);
  const first = page.locator('#cl-dupes .dupe[data-key="unav:PL2021:dead1"]');
  await expect(first.locator(".chip.ok")).toContainText("Keep Moving · audio");
  await expect(first.locator("button[data-swap]")).toHaveText("swap (100 units)");
  await expect(page.locator('#cl-dupes .dupe[data-key="unav:PL2016:dead2"]')).toContainText("no other upload found");
  await expect(page.locator('#cl-dupes .dupe[data-key="unav:PL2016:dead2"] button[data-drop]')).toBeVisible();
  await expect(page.locator('#cl-dupes .dupe[data-key="unav:PL2016:dead3"]')).toContainText("search pending");
  await expect(page.locator("#cl-dupe-bulk")).toBeHidden();
  await page.selectOption("#cl-dupe-yr", "2021");
  await expect(page.locator("#cl-dupe-bulk")).toHaveText("swap all 1 in 2021 for streamable uploads…");
  expect(errors).toEqual([]);
  await ctx.close();
});

test("a lapsed sign-in refreshes itself after the first tap, and the tap still counts", async ({ browser }) => {
  // a remembered curator with no token: the first interaction quietly asks Google for a new one, which opens a popup;
  // that must happen after the tap has done its work, or the popup swallows the tap (the tab never opened)
  const feed = await fetch("http://127.0.0.1:8765/data/feed.json").then(r => r.json());
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  await ctx.addInitScript(([hash]) => { localStorage.setItem("id:auth", JSON.stringify({ email: "curator@example.com", name: "Curator", hash })); }, [feed.google.curator_hashes[0]]);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push("pageerror: " + e.message)); page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  // a stand-in for accounts.google.com/gsi/client: the token client opens a popup on request, then reports it closed
  let popups = 0; ctx.on("page", () => popups++);
  await page.route("https://accounts.google.com/gsi/client", r => r.fulfill({ contentType: "application/javascript", body: `
    window.google = { accounts: { oauth2: { initTokenClient(cfg) { return { requestAccessToken() {
      const w = window.open("about:blank", "gis", "width=500,height=600");
      setTimeout(() => { try { if (w) w.close(); } catch {} cfg.error_callback && cfg.error_callback({ type: "popup_closed" }); }, 300);
    } }; } } } };` }));
  await page.goto("/index.html");
  await expect(page.locator("#meta")).not.toHaveText(/loading feed/, { timeout: 15_000 });
  await expect(page.locator("#count-catalog")).not.toHaveText("…", { timeout: 15_000 });
  await page.waitForFunction(() => !!(window.google && window.google.accounts));   // the sign-in script is in: the refresh will fire on this tap
  await page.click(".tab[data-view=cleanup]");
  await expect(page.locator("#cleanup")).toBeVisible();
  await expect.poll(() => popups).toBe(1);
  await expect(page.locator(".toast")).toContainText("sign-in needs a refresh");
  expect(errors).toEqual([]);
  await ctx.close();
});

test("a Keep verifies the playlist, adds the track, Undo removes it — and the API activity sheet shows each request", async ({ browser }) => {
  // a signed-in curator with a live token; every Google API answered here, so the whole flow runs without the network
  const feed = await fetch("http://127.0.0.1:8765/data/feed.json").then(r => r.json());
  const year = new Date().getFullYear();
  const target = feed.items.find(i => i.youtube && i.youtube.videoId && i.year === year);
  test.skip(!target || !feed.youtube.playlists[String(year)], "the committed feed has no playable track for this year");
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(([hash]) => {
    localStorage.setItem("id:auth", JSON.stringify({ email: "curator@example.com", name: "Curator", hash }));
    localStorage.setItem("id:settings", JSON.stringify({ introDismissed: true, installDismissedAt: Date.now(), deck: false, shortlistSize: 500 }));
    localStorage.setItem("id:filters", JSON.stringify({ q: "", sourcesOff: [], blogsOff: [], sort: "score", onlyNew: false, onlyPlayable: true, onlyKnown: false, onlyRecent: false, shortlist: false }));
    sessionStorage.setItem("id:token", JSON.stringify({ access_token: "test-token", expires_at: Date.now() + 3600e3 }));
  }, [feed.google.curator_hashes[0]]);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push("pageerror: " + e.message)); page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  await page.route("https://accounts.google.com/gsi/client", r => r.fulfill({ contentType: "application/javascript", body: "window.google = { accounts: { oauth2: { initTokenClient() { return { requestAccessToken() {} }; } } } };" }));
  /** @type {{method: string, path: string, params: Record<string, string>, body: any}[]} */
  const calls = [];
  await page.route("https://www.googleapis.com/**", async route => {
    const req = route.request(); const u = new URL(req.url()); const params = Object.fromEntries(u.searchParams);
    const body = req.postData() ? (() => { try { return JSON.parse(req.postData() || ""); } catch { return req.postData(); } })() : null;
    calls.push({ method: req.method(), path: u.pathname, params, body });
    if (u.pathname.startsWith("/drive/")) return route.fulfill({ json: { files: [] } });                  // no ratings mirror yet
    if (u.pathname === "/youtube/v3/playlistItems" && req.method() === "GET") return route.fulfill({ json: { items: [] } });   // the playlist does not hold it
    if (u.pathname === "/youtube/v3/playlistItems" && req.method() === "POST") return route.fulfill({ json: { id: "PLI-test-1", snippet: body.snippet } });
    if (u.pathname === "/youtube/v3/playlistItems" && req.method() === "DELETE") return route.fulfill({ status: 204, body: "" });
    return route.fulfill({ status: 404, json: { error: { message: "unexpected " + u.pathname } } });
  });
  await page.goto("/index.html");
  await expect(page.locator("#meta")).not.toHaveText(/loading feed/, { timeout: 15_000 });
  await expect(page.locator("body")).toHaveClass(/curator/);
  // on sign-in the site reads this year's playlist so that Keep never files a second copy
  await expect.poll(() => calls.filter(c => c.method === "GET" && c.path === "/youtube/v3/playlistItems" && c.params.playlistId === feed.youtube.playlists[String(year)]).length).toBeGreaterThan(0);
  const card = page.locator(`.card[data-id="${target.id}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.locator(".btn.up").click();
  await expect(page.locator(".toast")).toContainText(`${year} | Indie Discotheque`);
  const add = calls.find(c => c.method === "POST" && c.path === "/youtube/v3/playlistItems");
  expect(add.body.snippet.playlistId).toBe(feed.youtube.playlists[String(year)]);
  expect(add.body.snippet.resourceId.videoId).toBe(target.youtube.videoId);
  await expect(card).toBeHidden();
  // Undo takes the item out again: one DELETE by playlist item id
  await page.locator(".toast .btn", { hasText: "Undo" }).click();
  await expect.poll(() => calls.filter(c => c.method === "DELETE" && c.path === "/youtube/v3/playlistItems").length).toBe(1);
  expect(calls.find(c => c.method === "DELETE").params.id).toBe("PLI-test-1");
  await expect(card).toBeVisible();
  // the API activity sheet tells the same story in plain words, newest first, with the cost of each request
  await page.click("#settings-btn"); await page.click("#s-apilog");
  await expect(page.locator("#apilog")).toBeVisible();
  await expect(page.locator("#apilog-summary")).toContainText(/2 writes \(50 units each\)/);
  const rows = page.locator("#apilog .api-row");
  await expect(rows.first()).toContainText("DELETE");
  await expect(rows.first()).toContainText("Undo: remove the track the curator just took back");
  await expect(rows.nth(1)).toContainText("POST");
  await expect(rows.nth(1)).toContainText(`Keep: add the approved track to “${year} | Indie Discotheque”`);
  await expect(rows.nth(1)).toContainText(target.artist.slice(0, 12));
  await expect(rows.nth(1)).toContainText("50u");
  await expect(page.locator("#apilog .api-row.read").first()).toContainText(`Verify what “${year} | Indie Discotheque” already holds`);
  await page.click("#apilog-clear");
  await expect(page.locator("#apilog-summary")).toContainText("No YouTube API requests yet");
  expect(errors).toEqual([]);
  await ctx.close();
});

test("the ratings push survives a dropped connection: quiet retry, no re-upload when the repo already matches", async ({ browser }) => {
  // the push that feeds the build runs from a phone on a patchy connection: a failed one must say something useful,
  // keep the decisions, go up by itself when the network returns — and never re-upload 450 KB the repo already has
  const feed = await fetch("http://127.0.0.1:8765/data/feed.json").then(r => r.json());
  test.skip(!feed.repo, "the committed feed does not name its repository");
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(([hash]) => {
    localStorage.setItem("id:auth", JSON.stringify({ email: "curator@example.com", name: "Curator", hash }));
    localStorage.setItem("id:settings", JSON.stringify({ introDismissed: true, installDismissedAt: Date.now(), deck: false, ghToken: "github_pat_test" }));
    localStorage.setItem("id:rated", JSON.stringify({ abc123: { decision: "down", year: 2026, videoId: "v1", artist: "A Band", title: "A Song", at: 1 } }));
    sessionStorage.setItem("id:token", JSON.stringify({ access_token: "test-token", expires_at: Date.now() + 3600e3 }));
  }, [feed.google.curator_hashes[0]]);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push("pageerror: " + e.message)); page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  await page.route("https://accounts.google.com/gsi/client", r => r.fulfill({ contentType: "application/javascript", body: "window.google = { accounts: { oauth2: { initTokenClient() { return { requestAccessToken() {} }; } } } };" }));

  const { createHash } = await import("node:crypto");
  const blobSha = text => { const b = Buffer.from(text, "utf8"); return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest("hex"); };
  let offline = true, stored = null;                       // the repo's copy of data/ratings.json, once a PUT lands
  const calls = [];
  await page.route("https://api.github.com/**", async route => {
    const req = route.request(); const u = new URL(req.url());
    calls.push({ method: req.method(), path: u.pathname });
    if (offline) return route.abort("connectionfailed");
    if (req.method() === "GET") return route.fulfill({ json: stored ? [{ name: "ratings.json", type: "file", sha: blobSha(stored) }] : [] });
    stored = Buffer.from(JSON.parse(req.postData() || "{}").content, "base64").toString("utf8");
    return route.fulfill({ json: { content: { path: "data/ratings.json" }, commit: { sha: "deadbeef" } } });
  });
  await page.goto("/index.html");
  await expect(page.locator("#meta")).not.toHaveText(/loading feed/, { timeout: 15_000 });
  await expect(page.locator("body")).toHaveClass(/curator/);

  // a push with no connection: plain words, the decisions kept, and not one byte of "Failed to fetch"
  await page.click("#settings-btn");
  await page.click("#s-gh-push");
  await expect(page.locator(".toast")).toContainText("no connection to GitHub", { timeout: 20_000 });
  await expect(page.locator(".toast")).toContainText("when the connection is back");
  await expect(page.locator(".toast")).not.toContainText("Failed to fetch");
  await expect(page.locator("#s-gh-status")).toContainText("1 decisions still to reach " + feed.repo);
  expect(calls.length).toBeGreaterThan(1);                 // it tried more than once before giving up on this round

  // the network returns: the waiting sitting goes up on its own, with no tap
  offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => stored, { timeout: 20_000 }).not.toBeNull();
  expect(JSON.parse(stored).rated.abc123.decision).toBe("down");
  expect(JSON.parse(stored).count).toBe(1);
  // the file's sha came from the directory listing: the 450 KB file itself is never downloaded to find that out
  expect(calls.some(c => c.method === "GET" && c.path.endsWith("/contents/data"))).toBe(true);
  expect(calls.some(c => c.path.endsWith("/contents/data/ratings.json") && c.method === "GET")).toBe(false);

  // nothing rated since: the same decisions are recognised from the sha alone, so there is no second commit
  const puts = calls.filter(c => c.method === "PUT").length;
  await page.click("#s-gh-push");
  await expect(page.locator(".toast")).toContainText("already has these ratings", { timeout: 20_000 });
  expect(calls.filter(c => c.method === "PUT").length).toBe(puts);
  await expect(page.locator("#s-gh-status")).toContainText("1 decisions shared");
  expect(errors).toEqual([]);
  await ctx.close();
});
