/* Service worker: the installed app opens offline with the last feed, and never runs stale app code when online.
 *
 *  - App shell + feed: network first, cache fallback. Each file is cached under one key (the feed URL never varies,
 *    so there is exactly one copy and offline mode gets the newest one). Precached on install so Privacy/Terms and
 *    the icons are there even if never visited.
 *  - Artwork (any https image): cache first, network fallback, capped at ART_MAX entries so the store stays small.
 *    Opaque cross-origin responses are fine here; they are only ever shown as <img>.
 *  - Updates: a new build installs and waits; the page shows "new version ready → reload" and posts SKIP_WAITING.
 *    (Without a previous worker there is nothing to wait for, so a first visit activates at once.)
 *  - Navigations are keyed by path only, so /?view=picks, /?q=… and the share target's query resolve to the cached shell.
 *  - The concert list, the Cleanup reports and the video list (concerts.json, duplicates.json, unavailable.json, videos.json) are cached like the feed: network first, so a fresh
 *    session never re-downloads an unchanged 460 KB report, and the tab still opens offline.
 *
 *  - Navigation preload: the browser starts the network request for a page before this worker has even woken,
 *    and the shell handler takes that response instead of fetching again.
 *
 * __APP_JS__, __STYLE_CSS__, __THEME_JS__ and __BUILD__ are filled in by build.mjs from each file's content hash. */
const BUILD = "__BUILD__";
const CACHE = "newmusic-" + BUILD;
const ART = "newmusic-art";                          // survives builds: artwork does not change with the app
const ART_MAX = 400;
const SHELL = ["/", "/index.html", "__APP_JS__", "__STYLE_CSS__", "__THEME_JS__", "/manifest.webmanifest", "/data/feed.json", "/data/catalog.json", "/data/concerts.json", "/data/duplicates.json", "/data/unavailable.json", "/data/videos.json",
  "/privacy.html", "/terms.html", "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png", "/icons/favicon-32.png"];
const SHELL_SET = new Set(SHELL);

self.addEventListener("install", e => {
  // best effort: a missing legal page must not block the app from installing
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(p => fetch(new Request(p, { cache: "reload" })).then(r => r.ok ? c.put(self.location.origin + p, r) : null)))));
});
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE && k !== ART).map(k => caches.delete(k)));
    if (self.registration.navigationPreload) { try { await self.registration.navigationPreload.enable(); } catch { /* optional */ } }
    await self.clients.claim();
  })());
});
self.addEventListener("message", e => {
  const d = e.data || {};
  if (d.type === "SKIP_WAITING") self.skipWaiting();
  if (d.type === "GET_BUILD" && e.source) e.source.postMessage({ type: "BUILD", build: BUILD });
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (!SHELL_SET.has(url.pathname)) return;                    // history/, feed.xml: straight from the network
    e.respondWith(shell(e, self.location.origin + url.pathname));   // one entry per file whatever the query string
  } else if (req.destination === "image" && url.protocol === "https:") {
    e.respondWith(artwork(req));
  }
});

/** @param {FetchEvent} e @param {string} key */
async function shell(e, key) {
  const req = e.request;
  try {
    const res = (await e.preloadResponse) || await fetch(req);
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)).catch(() => {}); }
    return res;
  } catch (err) {
    const hit = await caches.match(key);
    if (hit) return hit;
    if (req.mode === "navigate") { const home = await caches.match(self.location.origin + "/"); if (home) return home; }
    throw err;
  }
}
/** @param {Request} req */
async function artwork(req) {
  const c = await caches.open(ART);
  const hit = await c.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") { c.put(req, res.clone()).then(() => trim(c)).catch(() => {}); }
  return res;
}
/** Keep the artwork cache to ART_MAX entries, oldest first. @param {Cache} c */
async function trim(c) {
  const keys = await c.keys();
  if (keys.length <= ART_MAX) return;
  await Promise.all(keys.slice(0, keys.length - ART_MAX).map(k => c.delete(k)));
}
