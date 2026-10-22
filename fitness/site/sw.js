/* Training & Recovery service worker: the installed app opens offline, at the trailhead or on a plane.
 *
 *  - Pages (the dashboard and ride mode): network first with a short timeout, then the cached copy, so a fresh build
 *    shows up when there's signal and the last one opens when there isn't. Keyed by path, never by query or #hash
 *    (the #hash is where a phone link carries its data; it never reaches here or the server).
 *  - Manifest, icons, fonts and the map library: cache first, refreshed in the background.
 *  - Map tiles, fonts and sprites (OpenFreeMap): cache first in their own cache, which outlives app updates, so a
 *    route's map saved at home is there in the woods. The style and tile index: network first, then the saved copy.
 *  - A GPX shared to the app from another app (Android's share sheet posts it here): kept in an inbox cache, and
 *    ride mode opens to import it.
 *  - The cache name carries a hash of the app files, filled in at build time; an old cache is dropped on activate.
 *  - The dashboard's data lives in the page's own storage on this device, not in this cache. */
const CACHE = "fitness-__VERSION__";
const TILES = "fitness-tiles", INBOX = "fitness-inbox";
const SHELL = ["./", "./index.html", "./ride.html", "./manifest.webmanifest", "./icons/icon.svg", "./icons/icon-192.png", "./icons/icon-512.png",
  "./icons/icon-maskable-512.png", "./icons/apple-touch-icon.png", "./fonts/nimbus-sans-l-400.woff2", "./fonts/nimbus-sans-l-700.woff2"];
const LATER = ["./vendor/maplibre-gl.mjs", "./vendor/maplibre-gl-worker.mjs", "./vendor/maplibre-gl.css"];   // the map: cached at install, not required for it
const MAP_HOST = "tiles.openfreemap.org";

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    await Promise.allSettled(SHELL.map(p => fetch(new Request(p, { cache: "reload" })).then(r => (r.ok ? c.put(p, r) : null))));
    Promise.allSettled(LATER.map(p => fetch(new Request(p, { cache: "reload" })).then(r => (r.ok ? c.put(p, r) : null))));
  }).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("fitness-") && k !== CACHE && k !== TILES && k !== INBOX) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", e => {
  const req = e.request;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  if (req.method === "POST" && url.origin === scope.origin && url.pathname.endsWith("/ride.html") && url.searchParams.has("share")) { e.respondWith(share(req)); return; }
  if (req.method !== "GET") return;
  if (url.hostname === MAP_HOST) { e.respondWith(url.pathname.startsWith("/styles/") || /^\/[a-z]+$/.test(url.pathname) ? mapIndex(req) : tile(req)); return; }   // /styles/liberty, /planet: the index
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const key = new URL(url.pathname === scope.pathname ? "./" : url.pathname, scope).href;
  e.respondWith(req.mode === "navigate" || req.destination === "document" ? page(req, key) : asset(req, key));
});

/** @param {Request} req @param {string} key */
async function page(req, key) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, no) => setTimeout(() => no(new Error("slow")), 4000))]);
    if (res.ok) cache.put(key, res.clone());
    return res;
  } catch {
    return (await cache.match(key)) || (await cache.match(new URL("./", self.registration.scope).href)) || Response.error();
  }
}
/** @param {Request} req @param {string} key */
async function asset(req, key) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(key);
  const fresh = fetch(req).then(res => { if (res.ok) cache.put(key, res.clone()); return res; }).catch(() => null);
  return hit || (await fresh) || Response.error();
}
/** Tiles, glyphs, sprites: what's saved is used; what isn't is fetched and saved (the cache is trimmed past 12,000). @param {Request} req */
async function tile(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) { await cache.put(req.url, res.clone()); trim(cache); }
    return res;
  } catch { return new Response("", { status: 504 }); }
}
let trimming = false;
/** @param {Cache} cache */
async function trim(cache) {
  if (trimming || Math.random() > 0.02) return;
  trimming = true;
  try { const keys = await cache.keys(); for (const k of keys.slice(0, Math.max(0, keys.length - 12000))) await cache.delete(k); } finally { trimming = false; }
}
/** The style and the tile index change when OpenFreeMap rebuilds: fresh when online, the saved copy when not. @param {Request} req */
async function mapIndex(req) {
  const cache = await caches.open(TILES);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, no) => setTimeout(() => no(new Error("slow")), 5000))]);
    if (res.ok) await cache.put(req.url, res.clone());
    return res;
  } catch { return (await cache.match(req.url)) || new Response("", { status: 504 }); }
}
/** A route shared from another app: each file into the inbox, then ride mode opens and imports it. @param {Request} req */
async function share(req) {
  try {
    const form = await req.formData(), cache = await caches.open(INBOX);
    let n = 0;
    for (const f of form.getAll("route")) {
      if (typeof f === "string") continue;
      await cache.put(`./inbox/${Date.now()}-${n++}`, new Response(f, { headers: { "x-name": encodeURIComponent(f.name || "route.gpx"), "Content-Type": f.type || "application/octet-stream" } }));
    }
  } catch { /* nothing usable: ride mode opens anyway */ }
  return Response.redirect(new URL("./ride.html?inbox=1", self.registration.scope).href, 303);
}

// ── the morning notification: the sync pushes the day's call (encrypted end to end; see fitness/webpush.py) ──
self.addEventListener("push", e => {
  /** @type {{title?: string, body?: string, tag?: string, url?: string}} */
  let m;
  try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(m.title || "Training", {
    body: m.body || "", tag: m.tag || "today", renotify: true, icon: "icons/icon-192.png",
    data: { url: new URL(m.url || "./#today", self.registration.scope).href },
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil((async () => {
    for (const c of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
      if (c.url.startsWith(self.registration.scope) && "focus" in c) { await c.focus(); return c.navigate(url).catch(() => null); }
    }
    return self.clients.openWindow(url);
  })());
});
