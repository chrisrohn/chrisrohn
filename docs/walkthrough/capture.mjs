// Drives the built site through the compliance shot list (docs/youtube-api-compliance.md) and saves a screenshot per
// step plus the request log the API activity sheet keeps. Every Google API is answered locally, so it spends no quota
// and runs offline: `npm run walkthrough` builds the site, captures the shots and writes docs/youtube-api-walkthrough.pdf.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const OUT = process.argv[2] || "docs/walkthrough/shots";
mkdirSync(OUT, { recursive: true });
const PORT = 8768, BASE = `http://127.0.0.1:${PORT}`;
const server = spawn("python3", ["-m", "http.server", "-d", "dist", String(PORT), "--bind", "127.0.0.1"], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 800));
const feed = await fetch(BASE + "/data/feed.json").then(r => r.json());
const dupes = await fetch(BASE + "/data/duplicates.json").then(r => r.json());
const dupeVideos = new Set(dupes.duplicates.map(d => d.videoId));
const year = new Date().getFullYear();
const targets = feed.items.filter(i => i.youtube && i.youtube.videoId && i.year === year && i.artist.length < 24).slice(0, 3);
const unav = [{ year: "2021", playlistId: feed.youtube.playlists["2021"], videoId: "dead1", position: 3, artist: "Jungle", title: "Keep Moving", alt: { videoId: "live1", title: "Keep Moving", album: "Loving In Stereo", videoType: "MUSIC_VIDEO_TYPE_ATV" }, pending: false }];
const TILE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="#dcd8ce"/><path stroke="#141412" stroke-opacity=".18" d="M0 24h96M0 48h96M0 72h96M24 0v96M48 0v96M72 0v96"/></svg>`;
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, colorScheme: "light" });
await ctx.addInitScript(([hash]) => {
  localStorage.setItem("id:auth", JSON.stringify({ email: "chrisrohn@gmail.com", name: "Chris Rohn", hash }));
  localStorage.setItem("id:settings", JSON.stringify({ introDismissed: true, installDismissedAt: Date.now(), deck: false, shortlistSize: 500, autoplay: false }));
  localStorage.setItem("id:filters", JSON.stringify({ q: "", sourcesOff: [], blogsOff: [], sort: "score", onlyNew: false, onlyPlayable: true, onlyKnown: false, onlyRecent: false, shortlist: false }));
  sessionStorage.setItem("id:token", JSON.stringify({ access_token: "t", expires_at: Date.now() + 3600e3 }));
}, [feed.google.curator_hashes[0]]);
const page = await ctx.newPage();
page.on("dialog", d => d.accept());
await page.route(/^https?:\/\/(?!127\.0\.0\.1)(?!www\.googleapis\.com)(?!accounts\.google\.com)/, async route => {
  if (route.request().resourceType() !== "image") return route.abort();
  try { const r = await route.fetch({ timeout: 4000 }); await route.fulfill({ response: r }); } catch { await route.fulfill({ contentType: "image/svg+xml", body: TILE }); }
});
await page.route("https://accounts.google.com/gsi/client", r => r.fulfill({ contentType: "application/javascript", body: "window.google = { accounts: { oauth2: { initTokenClient() { return { requestAccessToken() {} }; } } } };" }));
await page.route("**/data/feed.json", async r => { const j = await (await r.fetch()).json(); Object.assign(j.youtube, { unavailable_count: 1, unavailable_with_alt: 1, unavailable_pending: 0 }); await r.fulfill({ json: j }); });
await page.route("**/data/unavailable.json", r => r.fulfill({ json: { count: 1, with_counterpart: 1, pending: 0, rows: unav } }));
// the YouTube Data API, answered here: playlists hold nothing new, a duplicate's video sits in two items, the dead upload in one
let n = 0;
await page.route("https://www.googleapis.com/**", async route => {
  const req = route.request(); const u = new URL(req.url()); const p = Object.fromEntries(u.searchParams);
  await new Promise(r => setTimeout(r, 140 + Math.random() * 160));
  if (u.pathname.startsWith("/drive/")) return route.fulfill({ json: { files: [] } });
  if (u.pathname.endsWith("/playlistItems") && req.method() === "GET") {
    if (p.videoId) return route.fulfill({ json: { items: dupeVideos.has(p.videoId) ? [{ id: "UExUVzVKWm5QakVfMQ" }, { id: "UExUVzVKWm5QakVfMg" }] : p.videoId === "dead1" ? [{ id: "UExUVzVKWm5QakVfZGVhZA" }] : [] } });
    return route.fulfill({ json: { items: [] } });
  }
  if (u.pathname.endsWith("/playlistItems") && req.method() === "POST") return route.fulfill({ json: { id: "UExUVzVKWm5QakVfb0" + (++n) } });
  if (u.pathname.endsWith("/playlistItems") && req.method() === "DELETE") return route.fulfill({ status: 204, body: "" });
  return route.fulfill({ status: 404, json: { error: { message: "unexpected " + u.pathname } } });
});
const shot = async (name, sel) => { await page.waitForTimeout(400); await (sel ? page.locator(sel).screenshot({ path: `${OUT}/${name}.png` }) : page.screenshot({ path: `${OUT}/${name}.png` })); console.log(`${OUT}/${name}.png`); };
const openLog = async () => { await page.click("#settings-btn"); await page.click("#s-apilog"); await page.waitForTimeout(300); };
const closeLog = async () => { await page.locator("#apilog button[value=ok]").click(); await page.waitForTimeout(200); };
await page.goto(BASE + "/index.html");
await page.waitForFunction(() => !/loading feed/.test(document.querySelector("#meta").textContent));
await page.waitForFunction(() => document.body.classList.contains("curator"));
await page.waitForTimeout(1800);
await page.locator(`.card[data-id="${targets[0].id}"]`).focus();
await shot("01-feed");
await page.click("#settings-btn"); await shot("02-settings", "#settings"); await page.click("#s-apilog"); await page.waitForTimeout(300);
await shot("03-activity-signin", "#apilog"); await closeLog();
const c0 = page.locator(`.card[data-id="${targets[0].id}"]`); await c0.scrollIntoViewIfNeeded(); await c0.locator(".btn.up").click();
await page.waitForSelector(".toast .btn"); await page.waitForTimeout(500); await shot("04-keep");
await openLog(); await shot("05-activity-add", "#apilog"); await closeLog();
const c1 = page.locator(`.card[data-id="${targets[1].id}"]`); await c1.scrollIntoViewIfNeeded();
await c1.locator(".year").selectOption(String(year - 1)); await page.waitForTimeout(300); await shot("06-year-select");
await c1.locator(".btn.up").click(); await page.waitForSelector(".toast .btn"); await page.waitForTimeout(700);
await openLog(); await shot("07-activity-verify-add", "#apilog"); await closeLog();
// undo: the z key takes back the last thumb (the toast's Undo button does the same for a few seconds)
await page.locator("#meta").click(); await page.keyboard.press("z"); await page.waitForSelector(".toast"); await page.waitForTimeout(400); await shot("08-undo");
await page.waitForTimeout(600); await openLog(); await shot("09-activity-undo", "#apilog"); await closeLog();
await page.click(".tab[data-view=cleanup]"); await page.waitForSelector("#cl-dupes .dupe");
await page.selectOption("#cl-dupe-kind", "same-video"); await page.waitForTimeout(400); await shot("10-cleanup");
await page.locator("#cl-dupes .dupe button[data-fix=extra]").first().click(); await page.waitForTimeout(1200);
await openLog(); await shot("11-activity-cleanup", "#apilog"); await closeLog();
await page.selectOption("#cl-dupe-kind", "unavailable"); await page.waitForSelector("#cl-dupes .dupe.unav"); await page.waitForTimeout(300); await shot("12-unavailable");
await page.locator("#cl-dupes .dupe.unav button[data-swap]").first().click(); await page.waitForTimeout(1500);
await openLog(); await shot("13-activity-swap", "#apilog");
const log = await page.evaluate(() => JSON.parse(localStorage.getItem("id:apilog") || "[]"));
writeFileSync(`${OUT}/apilog.json`, JSON.stringify({ site: "chrisrohn.com", account: "chrisrohn@gmail.com", exported: new Date().toISOString(), requests: log }, null, 2));
await browser.close(); server.kill();
