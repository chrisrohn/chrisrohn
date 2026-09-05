/* Service worker: network first, cache fallback, so the installed app still opens offline with the last feed.
 * Only the app shell and the feed are cached, each under one key (the feed URL never varies, so there is exactly one
 * copy and offline mode gets the newest one). Never serves stale app code when the network is available. */
const CACHE = "newmusic-v2";
const SHELL = new Set(["/", "/index.html", "/app.js", "/style.css", "/manifest.webmanifest", "/data/feed.json", "/icons/icon-192.png", "/icons/icon-512.png"]);
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || !req.url.startsWith(self.location.origin)) return;
  const url = new URL(req.url);
  if (!SHELL.has(url.pathname)) return;          // duplicates.json, history/, feed.xml: straight from the network
  const key = url.origin + url.pathname;         // one entry per file whatever the query string
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.match(key).then(hit => hit || Response.error()))
  );
});
