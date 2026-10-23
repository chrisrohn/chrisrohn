"use strict";
// move.html on the app's address: the other end of move-out.js. An old address sends what the phone kept there in
// parts, one top-level visit each (#id, i, n, from, go, then, p); this page keeps each part, asks the old address for
// the next one missing, and once all are here writes them in: settings (localStorage) and ride mode's routes, rides
// and a ride still being recorded (IndexedDB "fitness-ride"), never over anything this address already has. Then it
// tells the old address the move landed (#done) and the phone lands where it was headed.
//
// It only ever sends the phone back to an address in FROM ([app] moved_from in fitness/config.toml, filled in by
// fitness/build-app.mjs), and it only lands on this app's own pages.
(async () => {
  const FROM = ["__FROM__"];
  /** ride mode's database as ride.js creates it (version 1): store → keyPath, or null for out-of-line keys */
  const STORES = /** @type {Record<string, string | null>} */ ({ routes: "id", rides: "id", tracks: "id", chunks: null });
  const app = new URL("./", location.href).href;
  const h = new URLSearchParams(location.hash.slice(1));
  const id = h.get("id") || "", from = h.get("from") || "", i = Number(h.get("i")), n = Number(h.get("n"));
  const where = h.get("go") === "ride.html" ? "ride.html" : "", rest = h.get("then") || "";
  const land = () => location.replace(app + where + (/^[?#]/.test(rest) ? rest : ""));
  if (!FROM.includes(from) || !/^[0-9a-f]{16}$/.test(id) || !(Number.isInteger(n) && n >= 1 && n <= 500) || !(Number.isInteger(i) && i >= 0 && i < n)) { land(); return; }
  const back = (/** @type {Record<string, string>} */ q) => location.replace(from + "move.html#" + new URLSearchParams({ id, go: where, then: rest, ...q }));
  const say = (/** @type {string} */ t) => { const el = document.getElementById("note"); if (el) el.textContent = t; };

  const req = (/** @type {IDBRequest} */ r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const done = (/** @type {IDBTransaction} */ t) => new Promise((res, rej) => { t.oncomplete = () => res(undefined); t.onerror = t.onabort = () => rej(t.error); });
  const openDB = (/** @type {string} */ name, /** @type {(d: IDBDatabase) => void} */ make) => /** @type {Promise<IDBDatabase>} */ (new Promise((res, rej) => {
    const r = indexedDB.open(name);
    r.onupgradeneeded = () => make(r.result);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));

  try {
    // the parts so far, kept here between visits
    const inbox = await openDB("fitness-move-in", d => d.createObjectStore("parts"));
    let t = inbox.transaction("parts", "readwrite");
    t.objectStore("parts").put(h.get("p") || "", `${id}:${String(i).padStart(3, "0")}`);
    await done(t);
    t = inbox.transaction("parts", "readonly");
    const keys = /** @type {string[]} */ (await req(t.objectStore("parts").getAllKeys(IDBKeyRange.bound(`${id}:`, `${id}:￿`))));
    const have = new Set(keys.map(k => Number(k.slice(id.length + 1))));
    for (let k = 0; k < n; k++) if (!have.has(k)) { inbox.close(); back({ next: String(k) }); return; }
    say("Putting everything in its place…");
    const parts = /** @type {string[]} */ (await req(t.objectStore("parts").getAll(IDBKeyRange.bound(`${id}:`, `${id}:￿`))));
    const b64 = parts.join("").replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const got = JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text());

    // settings: only the app's own keys, never over one this address already has
    for (const [k, v] of Object.entries((got && got.ls) || {})) {
      try { if (/^fitness-[\w:-]+$/.test(k) && !k.startsWith("fitness-move") && typeof v === "string" && localStorage.getItem(k) == null) localStorage.setItem(k, v); } catch { /* full or private */ }
    }
    // ride mode's routes and rides: add() leaves a row this address already has alone
    const rows = (got && got.db) || {};
    const names = Object.keys(rows).filter(s => s in STORES && Array.isArray(rows[s]));
    if (names.length) {
      const db = await openDB("fitness-ride", d => { for (const [s, key] of Object.entries(STORES)) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, key ? { keyPath: key } : undefined); });
      const ok = names.filter(s => db.objectStoreNames.contains(s));
      if (ok.length) {
        const w = db.transaction(ok, "readwrite");
        for (const s of ok) {
          const store = w.objectStore(s);
          for (const row of rows[s]) {
            if (!Array.isArray(row) || row.length !== 2) continue;
            try {
              const q = store.keyPath ? store.add(row[1]) : store.add(row[1], row[0]);
              q.onerror = e => { e.preventDefault(); e.stopPropagation(); };   // already here: keep this address's copy
            } catch { /* a row that doesn't fit the store */ }
          }
        }
        await done(w);
      }
      db.close();
    }
    try { localStorage.setItem("fitness-moved", JSON.stringify({ from: new URL(from).host, at: Date.now(), push: h.get("push") === "1" })); } catch { /* private mode */ }
    t = inbox.transaction("parts", "readwrite");
    t.objectStore("parts").clear();
    await done(t);
    inbox.close();
    back({ done: id });
  } catch {
    land();   // a damaged or blocked move: the old address still has everything, and tries again next time
  }
})();
