"use strict";
// An old address of the Training app (chrisrohn.github.io, chrisrohn.com/fitness/): everything this phone kept here
// goes to the app's new address, then the page forwards there. fitness/build-app.mjs fills in TO (the app) and BASE
// (this copy's path).
//
// Browser storage belongs to an address, so the settings (localStorage) and the routes, rides and a ride still being
// recorded (IndexedDB "fitness-ride") would otherwise stay behind. They travel in the #fragment, which never reaches a
// server: deflated, base64url, in parts of PART characters. Each part is a top-level visit to TO/move.html (move-in.js),
// which keeps it and sends the phone back here for the next one; after the last it writes everything in (never over
// what the new address already has) and comes back once more with #done, so a move that never landed is tried again.
// Once one has landed, this page forwards straight away until something here changes.
(async () => {
  const TO = "__APP_URL__", BASE = "__BASE__", PART = 900_000;
  const $ = (/** @type {string} */ id) => document.getElementById(id);
  const home = location.origin + BASE;
  const h = new URLSearchParams(location.hash.slice(1));
  const ls = {
    get(/** @type {string} */ k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(/** @type {string} */ k, /** @type {string | null} */ v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  const go = (/** @type {string} */ url) => { const a = /** @type {HTMLAnchorElement | null} */ ($("go")); if (a) a.href = url; location.replace(url); };
  const say = (/** @type {string} */ t) => { const n = $("note"); if (n) n.textContent = t; };
  /** where this visit was headed: ride mode or the dashboard, with its query and #fragment (an old QR link's plan) */
  const page = location.pathname.endsWith("/ride.html") ? "ride.html" : "";
  const target = (/** @type {string} */ where, /** @type {string} */ rest) => TO + (where === "ride.html" ? "ride.html" : "") + (/^[?#]/.test(rest) ? rest : "");

  // back from the new address
  if (h.has("done")) {
    if (/^[0-9a-f]{16}$/.test(h.get("done") || "")) ls.set("fitness-move-sent", h.get("done"));
    go(target(h.get("go") || "", h.get("then") || ""));
    return;
  }
  const next = h.has("next") ? Number(h.get("next")) : -1;
  // every part carries where to land, and the new address hands it back with each "next"
  const pg = next >= 0 ? h.get("go") || "" : page, then = next >= 0 ? h.get("then") || "" : location.search + location.hash;

  // the morning notification belongs to this address: note it was on, so the new one offers to turn it back on
  if (next < 0) {
    try { for (const r of await navigator.serviceWorker.getRegistrations()) if (new URL(r.scope).pathname.startsWith(BASE) && await r.pushManager.getSubscription()) ls.set("fitness-move-push", "1"); } catch { /* none */ }
  }
  // retire this address's offline copy (its sw.js steps aside too); its storage stays until the move has landed
  try { for (const r of await navigator.serviceWorker.getRegistrations()) if (new URL(r.scope).pathname.startsWith(BASE)) await r.unregister(); } catch { /* none */ }
  try { for (const k of await caches.keys()) if (k.startsWith("fitness-")) await caches.delete(k); } catch { /* none */ }

  const req = (/** @type {IDBRequest} */ r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  /** everything the app kept here, in a fixed order, so every visit packs it the same way */
  async function gather() {
    /** @type {{ v: number, ls: Record<string, string>, db: Record<string, [IDBValidKey, unknown][]> }} */
    const out = { v: 1, ls: {}, db: {} };
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith("fitness-") && !k.startsWith("fitness-move")) keys.push(k); }
      for (const k of keys.sort()) out.ls[k] = localStorage.getItem(k) || "";
    } catch { /* private mode */ }
    try {
      // open without creating: a phone that never used ride mode has no database, and this page must not make one
      const d = /** @type {IDBDatabase | null} */ (await new Promise(res => {
        const r = indexedDB.open("fitness-ride");
        r.onupgradeneeded = () => { if (r.transaction) r.transaction.abort(); };
        r.onsuccess = () => res(r.result); r.onerror = () => res(null);
      }));
      if (d) {
        const names = [...d.objectStoreNames].sort();
        if (names.length) {
          const t = d.transaction(names, "readonly");
          const all = await Promise.all(names.map(n => { const s = t.objectStore(n); return Promise.all([req(s.getAllKeys()), req(s.getAll())]); }));
          names.forEach((n, i) => { const [k, v] = all[i]; if (k.length) out.db[n] = k.map((key, j) => [key, v[j]]); });
        }
        d.close();
      }
    } catch { /* storage blocked: settings only */ }
    return out;
  }
  /** deflate-raw, base64url */
  async function pack(/** @type {unknown} */ obj) {
    const blob = await new Response(new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream("deflate-raw"))).blob();
    const url = String(await new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = () => rej(f.error); f.readAsDataURL(blob); }));
    return url.slice(url.indexOf(",") + 1).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  const digest = async (/** @type {string} */ s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join("");

  try {
    const data = await gather();
    if (!Object.keys(data.ls).length && !Object.keys(data.db).length) { go(target(pg, then)); return; }   // nothing here: just forward
    const packed = await pack(data), id = await digest(packed), n = Math.ceil(packed.length / PART);
    if (next < 0 && ls.get("fitness-move-sent") === id) { go(target(pg, then)); return; }   // already there, unchanged since
    const i = next >= 0 && next < n && h.get("id") === id ? next : 0;   // a part asked for again, or (if this phone's copy changed meanwhile) from the top
    say(n > 1 ? `Bringing this phone's rides, routes and settings along: part ${i + 1} of ${n}…` : "Bringing this phone's rides, routes and settings along…");
    const q = new URLSearchParams({ id, i: String(i), n: String(n), from: home, go: pg, then });
    if (ls.get("fitness-move-push") === "1") q.set("push", "1");
    q.set("p", packed.slice(i * PART, (i + 1) * PART));
    location.replace(TO + "move.html#" + q);
  } catch {
    go(target(pg, then));   // an old browser (no CompressionStream): the settings stay here, the app opens there
  }
})();
