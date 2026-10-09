/* Training & Recovery service worker: the installed app opens offline, at the trailhead or on a plane.
 *
 *  - Pages (the dashboard and ride mode): network first with a short timeout, then the cached copy, so a fresh build
 *    shows up when there's signal and the last one opens when there isn't. Keyed by path, never by query or #hash
 *    (the #hash is where a phone link carries its data; it never reaches here or the server).
 *  - Manifest and icons: cache first, refreshed in the background.
 *  - The cache name carries a hash of the app files, filled in at build time; an old cache is dropped on activate.
 *  - The dashboard's data lives in the page's own storage on this device, not in this cache. */
const CACHE = "fitness-__VERSION__";
const SHELL = ["./", "./index.html", "./ride.html", "./manifest.webmanifest", "./icons/icon.svg", "./icons/icon-192.png", "./icons/icon-512.png",
  "./icons/icon-maskable-512.png", "./icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(p => fetch(new Request(p, { cache: "reload" })).then(r => (r.ok ? c.put(p, r) : null))))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("fitness-") && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
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
