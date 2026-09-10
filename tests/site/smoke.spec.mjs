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
  await expect(page.locator(".toast")).toContainText(new RegExp(`≠ ${flagged.artist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*wrong video`));
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
  // theme.js collapses the page's media-qualified pair into the one media-less meta it owns, so a pinned choice
  // actually reaches the browser chrome (a media-qualified meta is matched against the device, never the pin)
  const themeColor = () => page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map(m => `${m.getAttribute("content")}${m.getAttribute("media") ? " @" + m.getAttribute("media") : ""}`));
  const iosBar = () => page.getAttribute('meta[name="apple-mobile-web-app-status-bar-style"]', "content");
  // fresh visit: following the device (light here), nothing pinned
  await expect(html).not.toHaveAttribute("data-theme");
  await expect(html).toHaveAttribute("data-scheme", "light");
  await bg("rgb(231, 227, 218)");
  expect(await themeColor()).toEqual(["#e7e3da"]);
  expect(await iosBar()).toBe("default");
  await expect(btn).toHaveAttribute("title", /system.*now light.*switch to light/);
  // system → light → dark, the button says where it is going next, the browser chrome follows
  await btn.click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await btn.click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(html).toHaveAttribute("data-scheme", "dark");
  await bg("rgb(28, 28, 26)");
  expect(await themeColor()).toEqual(["#1c1c1a"]);
  expect(await iosBar()).toBe("black-translucent");
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
  expect(await themeColor()).toEqual(["#1c1c1a"]);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).toHaveAttribute("data-scheme", "light");
  await bg("rgb(231, 227, 218)");
  expect(await themeColor()).toEqual(["#e7e3da"]);
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
  await expect(page.locator("#cl-dupe-kinds")).toContainText(/extra copy|two years|several uploads|versions/);
  await expect.poll(() => page.locator("#cl-dupes .dupe").count()).toBeGreaterThan(10);
  await expect(page.locator("#cl-dupe-shown")).toContainText(/\d+ songs/);
  // every song lays out its copies as rows: a keep radio, a thumbnail that plays, the year, the edition, the actions
  const song = page.locator("#cl-dupes .dupe").first();
  await expect(song.locator(".flag").first()).toBeVisible();
  expect(await song.locator(".drow").count()).toBeGreaterThan(1);
  const row = song.locator(".drow").first();
  await expect(row.locator(".keep")).toBeVisible();
  await expect(row.locator(".dthumb img")).toHaveAttribute("src", /i\.ytimg\.com\/vi\//);
  await expect(row.locator(".ded")).toBeVisible();
  await expect(row.locator("button[data-fix=one]")).toBeVisible();
  await expect(row.locator(".dmove option").first()).toHaveText("move to…");
  // choosing a copy arms "keep the chosen copy"; nothing is sent until that is pressed and confirmed
  await expect(song.locator("button[data-act=keep]")).toBeDisabled();
  await row.locator(".keep").check();
  await expect(song.locator("button[data-act=keep]")).toBeEnabled();
  await expect(song.locator("button[data-act=details]")).toHaveText("look up the copies");
  await expect(page.locator("#cl-dupe-lookup")).toBeVisible();
  // a same-video duplicate offers to keep one of its copies; the bulk button waits for a kind and a year
  await expect(page.locator("#cl-dupe-bulk")).toBeHidden();
  await page.selectOption("#cl-dupe-kind", "same-video");
  await expect(page.locator("#cl-dupes .dupe .flag.same-video").first()).toBeVisible();
  const year = await page.locator("#cl-dupes .dupe button[data-fix=extra]").first().getAttribute("data-year");   // a year that has an extra copy
  await page.selectOption("#cl-dupe-yr", year);
  await expect(page.locator("#cl-dupe-bulk")).toBeVisible();
  await expect(page.locator("#cl-dupe-bulk")).toContainText(`extra copies in ${year}`);
  await expect(page.locator("#cl-dupes .dupe button[data-fix=extra]").first()).toBeVisible();
  await expect(page.locator("#cl-dupes .dupe button[data-fix=extra]").first()).toContainText("keep one of ×");
  // the other views: two editions of a song show both edition tags; the sort menu reorders; the filter narrows by title
  await page.selectOption("#cl-dupe-yr", "");
  await page.selectOption("#cl-dupe-kind", "versions");
  await expect(page.locator("#cl-dupe-bulk")).toBeHidden();
  const versions = page.locator("#cl-dupes .dupe").first();
  expect(new Set(await versions.locator(".drow .ded").allTextContents()).size).toBeGreaterThan(1);
  await page.selectOption("#cl-dupe-sort", "artist");
  const artists = await page.locator("#cl-dupes .dupe .dname b").allTextContents();
  expect(artists.slice(0, 5)).toEqual([...artists.slice(0, 5)].sort((a, b) => a.localeCompare(b)));
  await page.fill("#cl-dupe-q", "zzzz-no-such-song");
  await expect(page.locator("#cl-dupes")).toContainText("nothing matches");
  await page.fill("#cl-dupe-q", "");
  // "looks fine" dismisses a song without a request; it moves to the dismissed view, the pill drops, and reopen brings it back
  await page.selectOption("#cl-dupe-kind", "");
  const before = Number(await page.locator("#count-cleanup").textContent());
  const first = page.locator("#cl-dupes .dupe").first(); const key = await first.getAttribute("data-key");
  await first.locator("button[data-act=ok]").click();
  await expect(page.locator(`#cl-dupes .dupe[data-key="${key}"]`)).toHaveCount(0);
  await expect(page.locator("#count-cleanup")).toHaveText(String(before - 1));
  await expect(page.locator(".toast")).toContainText("Dismissed");
  await page.selectOption("#cl-dupe-kind", "dismissed");
  await expect(page.locator(`#cl-dupes .dupe[data-key="${key}"]`)).toHaveClass(/dismissed/);
  await page.locator(`#cl-dupes .dupe[data-key="${key}"] button[data-act=reopen]`).click();
  await expect(page.locator(`#cl-dupes .dupe[data-key="${key}"]`)).toHaveCount(0);
  await expect(page.locator("#count-cleanup")).toHaveText(String(before));
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem("id:settings") || "{}")).dupesDone).toEqual([]);
  // the live scan and the audit have their own year menus, filled from the feed's years
  expect(await page.locator("#cl-dupe-year option").count()).toBeGreaterThan(10);
  expect(await page.locator("#cl-audit-year option").count()).toBeGreaterThan(10);
  await expect(page.locator("#cl-audit-summary")).toContainText("Nothing audited on this device yet");
  // Settings points here too
  await page.click("#settings-btn");
  await expect(page.locator("#s-dupes-summary")).toContainText("duplicated songs");
  await page.click("#s-cleanup");
  await expect(page.locator("#settings")).toBeHidden();
  await expect(page.locator("#cleanup")).toBeVisible();
  expect(errors).toEqual([]);
  await ctx.close();
});

test("Cleanup: a song's copies can be looked up, played in place, kept, removed or moved — each a verified, tapped request", async ({ browser }) => {
  const feed = await fetch("http://127.0.0.1:8765/data/feed.json").then(r => r.json());
  const y1 = Object.keys(feed.youtube.playlists).sort().reverse()[0], y0 = String(Number(y1) - 1);
  test.skip(!feed.youtube.playlists[y0], "the committed feed pins fewer than two year playlists");
  const P = feed.youtube.playlists;
  // one song, three copies: the audio track filed twice in y1 and once in y0, and the official video in y1 — verified as y0
  const report = { version: 2, checked_at: new Date().toISOString(), count: 1, kinds: { "same-video": 1, "cross-year": 1, "same-song": 1 }, duplicates: [{
    key: "song1", artist: "Roosevelt", title: "Lovers", kind: "same-video", kinds: ["same-video", "cross-year", "same-song"], years: [y1, y0], count: 4, uploads: 2, editions: ["original"], verified_year: Number(y0), verified_source: "MusicBrainz recording",
    entries: [{ year: y1, playlistId: P[y1], videoId: "audioA", position: 10, title: "Lovers", edition: "original", label: "", album: "Roosevelt", duration: 241, videoType: "MUSIC_VIDEO_TYPE_ATV" },
      { year: y1, playlistId: P[y1], videoId: "audioA", position: 40, title: "Lovers", edition: "original", label: "" },
      { year: y1, playlistId: P[y1], videoId: "videoB", position: 41, title: "Lovers (Official Video)", edition: "original", label: "Official Video", videoType: "MUSIC_VIDEO_TYPE_OMV" },
      { year: y0, playlistId: P[y0], videoId: "audioA", position: 3, title: "Lovers", edition: "original", label: "" }] }] };
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(([hash]) => {
    localStorage.setItem("id:auth", JSON.stringify({ email: "curator@example.com", name: "Curator", hash }));
    localStorage.setItem("id:settings", JSON.stringify({ introDismissed: true, installDismissedAt: Date.now(), deck: false }));
    sessionStorage.setItem("id:token", JSON.stringify({ access_token: "test-token", expires_at: Date.now() + 3600e3 }));
  }, [feed.google.curator_hashes[0]]);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push("pageerror: " + e.message)); page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  page.on("dialog", d => d.accept());
  await page.route("https://accounts.google.com/gsi/client", r => r.fulfill({ contentType: "application/javascript", body: "window.google = { accounts: { oauth2: { initTokenClient() { return { requestAccessToken() {} }; } } } };" }));
  await page.route("**/data/feed.json", async r => { const j = await (await r.fetch()).json(); Object.assign(j.youtube, { duplicates_count: 1, duplicates_kinds: report.kinds, unavailable_count: 0 }); await r.fulfill({ json: j }); });
  await page.route("**/data/duplicates.json", r => r.fulfill({ json: report }));
  const calls = [];
  // the playlists as YouTube would answer for them: two items of audioA in y1, one in y0, one of videoB in y1 — kept in step with every add and delete
  const held = { [`${P[y1]}|audioA`]: ["PLI-a1", "PLI-a2"], [`${P[y1]}|videoB`]: ["PLI-b1"], [`${P[y0]}|audioA`]: ["PLI-a0"] };
  const parse = t => { try { return JSON.parse(t || ""); } catch { return t; } };
  await page.route("https://www.googleapis.com/**", async route => {
    const req = route.request(); const u = new URL(req.url()); const params = Object.fromEntries(u.searchParams);
    const body = parse(req.postData()); calls.push({ method: req.method(), path: u.pathname, params, body });
    if (u.pathname.startsWith("/drive/") || u.pathname.startsWith("/upload/")) return route.fulfill({ json: { files: [], id: "drive-1" } });
    if (u.pathname === "/youtube/v3/videos") return route.fulfill({ json: { items: [
      { id: "audioA", snippet: { title: "Lovers", channelTitle: "Roosevelt - Topic", publishedAt: "2016-08-01T00:00:00Z" }, contentDetails: { duration: "PT4M1S" }, statistics: { viewCount: "1200000" }, status: { embeddable: true, uploadStatus: "processed" } },
      { id: "videoB", snippet: { title: "Roosevelt - Lovers (Official Video)", channelTitle: "Roosevelt", publishedAt: "2016-07-20T00:00:00Z" }, contentDetails: { duration: "PT4M20S", regionRestriction: { blocked: ["US"] } }, statistics: { viewCount: "300000" }, status: { embeddable: true, uploadStatus: "processed" } }] } });
    if (u.pathname === "/youtube/v3/playlistItems" && req.method() === "GET") return route.fulfill({ json: { items: (held[`${params.playlistId}|${params.videoId}`] || []).map(id => ({ id })) } });
    if (u.pathname === "/youtube/v3/playlistItems" && req.method() === "POST") { const k = `${body.snippet.playlistId}|${body.snippet.resourceId.videoId}`; (held[k] = held[k] || []).push("PLI-new"); return route.fulfill({ json: { id: "PLI-new" } }); }
    if (u.pathname === "/youtube/v3/playlistItems" && req.method() === "DELETE") { for (const k of Object.keys(held)) held[k] = held[k].filter(id => id !== params.id); return route.fulfill({ status: 204, body: "" }); }
    return route.fulfill({ status: 404, json: { error: { message: "unexpected " + u.pathname } } });
  });
  await page.goto("/index.html?view=cleanup");
  await expect(page.locator("#meta")).not.toHaveText(/loading feed/, { timeout: 15_000 });
  await expect(page.locator("#cleanup")).toBeVisible();
  const song = page.locator('#cl-dupes .dupe[data-key="song1"]');
  await expect(song).toBeVisible();
  await expect(song.locator(".flag")).toHaveText(["extra copy", "two years", "several uploads"]);
  await expect(song.locator("span.verified")).toContainText(`verified ${y0}`);
  await expect(song.locator(".drow")).toHaveCount(3);              // the two y1 rows of audioA fold into one ×2 row
  const a1 = song.locator(`.drow[data-vid=audioA][data-year="${y1}"]`), b1 = song.locator(`.drow[data-vid=videoB]`), a0 = song.locator(`.drow[data-vid=audioA][data-year="${y0}"]`);
  await expect(a1).toHaveClass(/wrong/); await expect(a0).not.toHaveClass(/wrong/);   // the catalogues say y0
  await expect(a1.locator(".dmeta")).toContainText("4:01 · audio track · Roosevelt · #11, #41 · ×2 copies");
  await expect(a1.locator("button[data-fix=extra]")).toHaveText("keep one of ×2");
  await expect(b1.locator(".dlabel")).toHaveText("Official Video");
  await expect(a1.locator(`.dmove option[value="${y0}"]`)).toHaveText(`${y0} ✓ verified`);
  await expect(song.locator("button[data-act=moveall]")).toHaveCount(0);   // one copy already sits in the verified year
  // look up the copies: one videos.list for both uploads, then the rows say what YouTube knows
  await song.locator("button[data-act=details]").click();
  await expect(b1.locator(".dmeta")).toContainText("4:20 · Roosevelt · 300K views · uploaded 2016-07 · #42 · ✗ blocked here");
  await expect(b1).toHaveClass(/dead/);
  await expect(a1.locator(".dmeta")).toContainText("1.2M views");
  expect(calls.filter(c => c.path === "/youtube/v3/videos").map(c => c.params.id)).toEqual(["audioA,videoB"]);
  await expect(song.locator("button[data-act=details]")).toHaveCount(0);
  // play in place: an embedded player under the song, the row lit; the same button closes it
  await b1.locator("button[data-act=play]").click();
  await expect(song.locator(".dupe-player iframe")).toHaveAttribute("src", /youtube-nocookie\.com\/embed\/videoB/);
  await expect(b1).toHaveClass(/playing/);
  await b1.locator("button[data-act=play]").click();
  await expect(song.locator(".dupe-player iframe")).toHaveCount(0);
  // keep one of ×2: verify which items hold the video (1 unit), delete the second only
  await a1.locator("button[data-fix=extra]").click();
  await expect(a1.locator(".dmeta")).not.toContainText("×2 copies");
  expect(calls.filter(c => c.method === "DELETE").map(c => c.params.id)).toEqual(["PLI-a2"]);
  await expect(song.locator(".flag")).toHaveText(["two years", "several uploads"]);   // the extra copy is solved, the rest remains
  // move the video copy to the verified year: verify the target does not hold it, add it there, remove it here
  await b1.locator(".dmove").selectOption(y0);
  await expect(song.locator(`.drow[data-vid=videoB][data-year="${y0}"] .dmeta`)).toContainText("moved here just now");
  const add = calls.find(c => c.method === "POST");
  expect(add.body.snippet.playlistId).toBe(P[y0]); expect(add.body.snippet.resourceId.videoId).toBe("videoB");
  expect(calls.filter(c => c.method === "DELETE").map(c => c.params.id)).toEqual(["PLI-a2", "PLI-b1"]);
  await expect(song.locator(".flag")).toHaveText(["two years", "several uploads"]);   // the audio track is still in both years; y0 now holds two uploads
  // keep the chosen copy: the y0 audio track stays, the y1 copy and the video just moved both go (a verify and a delete each)
  await a0.locator(".keep").check();
  await song.locator("button[data-act=keep]").click();
  await expect(page.locator(".toast")).toContainText("Kept one · removed 2");
  expect(calls.filter(c => c.method === "DELETE").map(c => c.params.id)).toEqual(["PLI-a2", "PLI-b1", "PLI-a1", "PLI-new"]);
  await expect(song).toHaveCount(0);   // one copy left, in the verified year: nothing left to solve, the song leaves the list
  await expect(page.locator("#count-cleanup")).toHaveText("0");
  // the marks that remember all this travel with the ratings
  const done = JSON.parse(await page.evaluate(() => localStorage.getItem("id:settings") || "{}")).dupesDone;
  expect(done).toEqual([`song1|${P[y1]}|audioA|one`, `song1|${P[y1]}|videoB|gone`, `song1|${P[y0]}|videoB|in|${y0}`, `song1|${P[y1]}|audioA|gone`, `song1|${P[y0]}|videoB|gone`]);
  expect(errors).toEqual([]);
  await ctx.close();
});

test("Cleanup: the playability audit finds deleted and blocked tracks, offers a replacement search, and removes a dead row by its item id", async ({ browser }) => {
  const feed = await fetch("http://127.0.0.1:8765/data/feed.json").then(r => r.json());
  const y = Object.keys(feed.youtube.playlists).sort().reverse()[0]; const pid = feed.youtube.playlists[y];
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(([hash]) => {
    localStorage.setItem("id:auth", JSON.stringify({ email: "curator@example.com", name: "Curator", hash }));
    localStorage.setItem("id:settings", JSON.stringify({ introDismissed: true, installDismissedAt: Date.now(), deck: false }));
    localStorage.setItem("id:rated", JSON.stringify({ kept1: { decision: "up", year: 2020, videoId: "gone1", artist: "Sébastien Tellier", title: "La Ritournelle", at: Date.now() } }));
    sessionStorage.setItem("id:token", JSON.stringify({ access_token: "test-token", expires_at: Date.now() + 3600e3 }));
  }, [feed.google.curator_hashes[0]]);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push("pageerror: " + e.message)); page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  page.on("dialog", d => d.accept());
  await page.route("https://accounts.google.com/gsi/client", r => r.fulfill({ contentType: "application/javascript", body: "window.google = { accounts: { oauth2: { initTokenClient() { return { requestAccessToken() {} }; } } } };" }));
  await page.route("**/data/feed.json", async r => { const j = await (await r.fetch()).json(); Object.assign(j.youtube, { duplicates_count: 0, duplicates_kinds: {}, unavailable_count: 0 }); await r.fulfill({ json: j }); });
  const calls = [];
  const parse = t => { try { return JSON.parse(t || ""); } catch { return t; } };
  await page.route("https://www.googleapis.com/**", async route => {
    const req = route.request(); const u = new URL(req.url()); const params = Object.fromEntries(u.searchParams);
    calls.push({ method: req.method(), path: u.pathname, params, body: parse(req.postData()) });
    if (u.pathname.startsWith("/drive/") || u.pathname.startsWith("/upload/")) return route.fulfill({ json: { files: [], id: "drive-1" } });
    if (u.pathname === "/youtube/v3/playlistItems" && req.method() === "GET" && !params.videoId) return route.fulfill({ json: { items: [
      { id: "PLI-1", snippet: { title: "Deleted video", position: 0, resourceId: { videoId: "gone1" } } },
      { id: "PLI-2", snippet: { title: "Jungle - Keep Moving (Official Video)", videoOwnerChannelTitle: "Jungle", position: 1, resourceId: { videoId: "blocked1" } } },
      { id: "PLI-3", snippet: { title: "Lovers", videoOwnerChannelTitle: "Roosevelt - Topic", position: 2, resourceId: { videoId: "fine1" } } }] } });
    if (u.pathname === "/youtube/v3/playlistItems" && req.method() === "GET") return route.fulfill({ json: { items: [] } });
    if (u.pathname === "/youtube/v3/videos") { const ids = params.id.split(","); return route.fulfill({ json: { items: [
      ...(ids.includes("blocked1") ? [{ id: "blocked1", snippet: { title: "Jungle - Keep Moving (Official Video)", channelTitle: "Jungle" }, contentDetails: { duration: "PT3M30S", regionRestriction: { blocked: ["US", "CA"] } }, statistics: { viewCount: "5000" }, status: { embeddable: true, uploadStatus: "processed" } }] : []),
      ...(ids.includes("fine1") ? [{ id: "fine1", snippet: { title: "Lovers", channelTitle: "Roosevelt - Topic" }, contentDetails: { duration: "PT4M1S" }, statistics: { viewCount: "10" }, status: { embeddable: true, uploadStatus: "processed" } }] : []),
      ...(ids.includes("alt1") ? [{ id: "alt1", snippet: { title: "Keep Moving", channelTitle: "Jungle - Topic", publishedAt: "2021-08-13T00:00:00Z" }, contentDetails: { duration: "PT3M31S" }, statistics: { viewCount: "2000000" }, status: { embeddable: true, uploadStatus: "processed" } }] : []),
      ...(ids.includes("alt2") ? [{ id: "alt2", snippet: { title: "Jungle - Keep Moving (Live)", channelTitle: "KEXP" }, contentDetails: { duration: "PT4M0S", regionRestriction: { allowed: ["GB"] } }, statistics: { viewCount: "900000" }, status: { embeddable: true, uploadStatus: "processed" } }] : [])] } }); }
    if (u.pathname === "/youtube/v3/search") return route.fulfill({ json: { items: [{ id: { videoId: "alt2" } }, { id: { videoId: "alt1" } }, { id: { videoId: "blocked1" } }] } });
    if (u.pathname === "/youtube/v3/playlistItems" && req.method() === "POST") return route.fulfill({ json: { id: "PLI-new" } });
    if (u.pathname === "/youtube/v3/playlistItems" && req.method() === "DELETE") return route.fulfill({ status: 204, body: "" });
    return route.fulfill({ status: 404, json: { error: { message: "unexpected " + u.pathname } } });
  });
  await page.goto("/index.html?view=cleanup");
  await expect(page.locator("#meta")).not.toHaveText(/loading feed/, { timeout: 15_000 });
  await expect(page.locator("#cleanup")).toBeVisible();
  await page.selectOption("#cl-audit-year", y);
  const n0 = calls.length;   // sign-in already read this year's playlist once (the duplicate guard); the audit's own reads start here
  await page.click("#cl-audit-one");
  await expect(page.locator("#cl-audit-status")).toContainText(`3 tracks, 2 cannot play in US (2 units)`);
  await expect(page.locator("#cl-audit-summary")).toContainText("1 year audited on this device · 2 tracks cannot play in US");
  await expect(page.locator("#cl-audit-done span").first()).toContainText(`${y} 2 ✗`);
  await expect(page.locator("#count-cleanup")).toHaveText("2");
  // the playlist was read once, every video checked once: two units for the year
  expect(calls.slice(n0).filter(c => c.path === "/youtube/v3/playlistItems").length).toBe(1);
  expect(calls.slice(n0).filter(c => c.path === "/youtube/v3/videos").map(c => c.params.id)).toEqual(["gone1,blocked1,fine1"]);
  // the findings sit under "not streamable here", with why — and the deleted video still has the name the site kept for it
  await page.locator(".toast .btn", { hasText: "Show" }).click();
  await expect(page.locator("#cl-dupe-kind")).toHaveValue("unavailable");
  const dead = page.locator(`#cl-dupes .dupe[data-key="unav:${pid}:gone1"]`), blocked = page.locator(`#cl-dupes .dupe[data-key="unav:${pid}:blocked1"]`);
  await expect(dead.locator(".flag.dead")).toHaveText("deleted video");
  await expect(dead.locator(".dname")).toContainText("Sébastien Tellier - La Ritournelle");
  await expect(blocked.locator(".flag.dead")).toHaveText("blocked here");
  await expect(blocked.locator(".dname")).toContainText("Jungle - Keep Moving");
  await expect(blocked).toContainText("no other upload found yet — the next build looks");
  // find a replacement now: one search (100 units), the results checked (1 unit), the audio track offered first and the one blocked here left out
  await blocked.locator("button[data-find]").click();
  await expect(blocked.locator(".dalt")).toHaveCount(1);
  await expect(blocked.locator(".dalt .ded")).toHaveText("audio track");
  await expect(blocked.locator(".dalt .dmeta")).toContainText("3:31 · Jungle - Topic · 2M views · uploaded 2021-08");
  const search = calls.find(c => c.path === "/youtube/v3/search");
  expect(search.params).toMatchObject({ q: "Jungle Keep Moving", type: "video", videoCategoryId: "10", regionCode: "US" });
  // use it: verify the playlist does not hold it, add it, and delete the dead row by the item id the audit already knows (no lookup)
  await blocked.locator("button[data-use=alt1]").click();
  await expect(page.locator(".toast")).toContainText(`Swapped · Jungle - Keep Moving (Official Video) → ${y} | Indie Discotheque`);
  expect(calls.find(c => c.method === "POST").body.snippet.resourceId.videoId).toBe("alt1");
  expect(calls.filter(c => c.method === "DELETE").map(c => c.params.id)).toEqual(["PLI-2"]);
  expect(calls.filter(c => c.path === "/youtube/v3/playlistItems" && c.method === "GET" && c.params.videoId).map(c => c.params.videoId)).toEqual(["alt1"]);
  await expect(blocked).toHaveCount(0);
  // the deleted row: nothing to search by on YouTube, so remove it — again by its item id
  await dead.locator("button[data-drop]").click();
  await expect(page.locator(".toast")).toContainText("Removed 1");
  expect(calls.filter(c => c.method === "DELETE").map(c => c.params.id)).toEqual(["PLI-2", "PLI-1"]);
  await expect(page.locator("#count-cleanup")).toHaveText("0");
  await expect(page.locator("#cl-dupes")).toBeEmpty();   // nothing left to list at all
  // what was found and is still there is what the ratings file carries to the build: nothing now, both rows are gone
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem("id:audit") || "{}")).years[y].dead).toEqual([]);
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

test("a feed built on an earlier day says the morning build is late, and an all-rated day says so instead of going blank", async ({ browser }) => {
  const live = await fetch("http://127.0.0.1:8765/data/feed.json").then(r => r.json());
  // the same feed, built the day before yesterday morning: what the site serves whenever the daily job is late
  const built = new Date(); built.setDate(built.getDate() - 1); built.setHours(6, 55, 0, 0);
  const feed = { ...live, generated_at: built.toISOString() };
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const page = await ctx.newPage();
  const morning = new Date(); morning.setHours(8, 30, 0, 0);   // read over coffee, whatever hour CI happens to run at
  await page.clock.setFixedTime(morning);
  await page.route("**/data/feed.json", r => r.fulfill({ json: feed }));

  // 1. late, but nothing is wrong upstream: the quiet bar, not the "something failed" one
  let errors = await open(page);
  const bar = page.locator("#stale");
  await expect(bar).toBeVisible();
  await expect(bar).toHaveClass(/waiting/);
  await expect(bar).toContainText("Today's build has not landed yet");
  await expect(bar).not.toContainText("days old");
  expect(errors).toEqual([]);

  // 2. …and every card of it rated: the reason, the counts, and the two tabs that still have something in them
  const rated = {};
  for (const i of feed.items) rated[i.id] = { decision: "down", local: true, at: Date.now(), videoId: i.youtube?.videoId, artist: i.artist, title: i.title };
  await ctx.addInitScript(([r, hash]) => {
    localStorage.setItem("id:rated", JSON.stringify(r));
    localStorage.setItem("id:auth", JSON.stringify({ email: "curator@example.com", name: "Curator", hash }));
  }, [rated, feed.google.curator_hashes[0]]);
  errors = await open(page);
  const empty = page.locator("#empty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText(`You have rated all ${feed.items.length} cards`);
  await expect(empty).toContainText("today's has not landed yet");
  await expect(empty.locator("button", { hasText: "what you skipped" })).toBeVisible();
  await empty.locator("button", { hasText: "what you skipped" }).click();
  await expect(page.locator("#list .card").first()).toBeVisible();
  expect(errors).toEqual([]);

  // 3. a full feed hidden behind the filters is a different sentence, and one button undoes it
  await ctx.addInitScript(() => localStorage.setItem("id:rated", "{}"));
  errors = await open(page, "/?q=zzzz-nothing-has-this");
  await expect(empty).toContainText(/unrated cards? (is|are) in this build/);
  await expect(empty).toContainText("the search");
  await empty.locator("button", { hasText: "clear the filters" }).click();
  await expect(page.locator("#q")).toHaveValue("");
  await expect.poll(() => page.locator("#list .card").count()).toBeGreaterThan(50);
  expect(errors).toEqual([]);
  await ctx.close();
});

test("a feed older than a day and a half is an alarm, not a late morning", async ({ browser }) => {
  const live = await fetch("http://127.0.0.1:8765/data/feed.json").then(r => r.json());
  // …at an hour when the morning's first build is not even due: a real breakage says so whatever the clock reads
  const night = new Date(); night.setHours(1, 15, 0, 0);
  const feed = { ...live, generated_at: new Date(night.getTime() - 4 * 86400e3).toISOString() };   // four days before the clock the page will see
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(night);
  await page.route("**/data/feed.json", r => r.fulfill({ json: feed }));
  const errors = await open(page);
  const bar = page.locator("#stale");
  await expect(bar).toBeVisible();
  await expect(bar).not.toHaveClass(/waiting/);
  await expect(bar).toContainText("4 days old");
  await expect(bar).toContainText("Discover workflow");
  expect(errors).toEqual([]);
  await ctx.close();
});
