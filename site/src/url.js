// @ts-check
/* The address bar as state, and the Back button as a way out.
 *
 * The view and the filters are readable and shareable (?view=catalog&year=2014&q=nu+disco); the site keeps the
 * address in step as you browse (replaceState, so filtering never piles up history) and reads it back on launch,
 * from an app shortcut or from a pasted link. What opens over the list (the player, a dialog) pushes one history
 * entry, so Back closes it instead of leaving the page: in the installed app on Android that is the difference
 * between "close the player" and "quit". */
import { state, persist } from "./state.js";
import { $, $$ } from "./dom.js";

const VIEWS = ["feed", "catalog", "picks", "skipped", "cleanup"];

/** The address for the state on screen. */
export function urlFor() {
  const p = new URLSearchParams(); const f = state.filters;
  if (state.view !== "feed") p.set("view", state.view);
  if (f.q) p.set("q", f.q);
  if (state.view === "feed") {
    if (f.sort && f.sort !== "score") p.set("sort", f.sort);
    if (f.onlyNew) p.set("new", "1");
    if (!f.onlyPlayable) p.set("playable", "0");
    if (f.onlyKnown) p.set("known", "1");
    if (!f.onlyRecent) p.set("recent", "0");
    if (!f.shortlist) p.set("shortlist", "0");
  }
  if (state.view === "catalog") {
    if (f.catYear) p.set("year", f.catYear);
    if (f.catSort && f.catSort !== "score") p.set("csort", f.catSort);
    if (!f.shortlist) p.set("shortlist", "0");
  }
  const s = p.toString();
  return location.pathname + (s ? "?" + s : "");
}
/** Keep the address in step with the screen. Called after every render. */
export function syncUrl() {
  const u = urlFor();
  if (location.pathname + location.search !== u) { try { history.replaceState(history.state, "", u); } catch { /* file:// and friends */ } }
}

/** Read the address into the state: the view and filters, plus one-off intents (?t=<id> a card, ?artist= a sheet,
 * ?share… from the share target, ?audition=1 from the app shortcut). Runs once, before the feed is in; the
 * one-off keys are dropped from the address so a reload does not re-apply them. */
export function applyLaunchParams() {
  const p = new URLSearchParams(location.search);
  if (![...p.keys()].length) return;
  const f = state.filters; let changed = false;
  const view = p.get("view");
  if (view && VIEWS.includes(view)) { state.view = view; $$(".tab").forEach(x => x.classList.toggle("active", x.dataset.view === view)); }
  const bool = (/** @type {string} */ k) => (p.has(k) ? p.get(k) !== "0" : null);
  const q = p.get("q"); if (q != null) { f.q = q; const box = $("#q"); if (box) box.value = q; changed = true; }
  const sort = p.get("sort"); if (sort && $(`#sort option[value="${sort}"]`)) { f.sort = sort; $("#sort").value = sort; changed = true; }
  const csort = p.get("csort"); if (csort && $(`#cat-sort option[value="${csort}"]`)) { f.catSort = csort; $("#cat-sort").value = csort; changed = true; }
  const year = p.get("year"); if (year != null) { f.catYear = year; changed = true; }
  for (const [k, key, el] of /** @type {const} */ ([["new", "onlyNew", "#only-new"], ["playable", "onlyPlayable", "#only-playable"], ["known", "onlyKnown", "#only-known"], ["recent", "onlyRecent", "#only-recent"], ["shortlist", "shortlist", "#shortlist"]])) {
    const v = bool(k); if (v == null) continue;
    f[key] = v; const cb = $(el); if (cb) cb.checked = v; changed = true;
  }
  if (p.get("audition") === "1") { state.settings.audition = true; const cb = $("#audition"); if (cb) cb.checked = true; changed = true; }
  if (p.get("t")) state.focusId = p.get("t");   // a card's own link (share, RSS): feed.js opens it once the feed is in
  if (p.get("artist")) state.shareIn = { ...(state.shareIn || {}), artist: p.get("artist") || undefined };
  // the share target (manifest.webmanifest): a link or some text handed over from another app
  if (p.has("share") || p.has("url") || p.has("text")) state.shareIn = { ...(state.shareIn || {}), url: p.get("url") || undefined, text: p.get("text") || undefined, title: p.get("title") || undefined };
  if (changed) persist();
  // the one-off keys go; the state keys are rewritten from the state itself by the first render
  try { history.replaceState(null, "", location.pathname); } catch { /* ignore */ }
}

/* ---- layers: what Back closes ---- */
/** @type {{name: string, close: () => void}[]} */
const layers = [];
/** Something opened over the list: one history entry, closed by Back. Idempotent per name. @param {string} name @param {() => void} close */
export function openLayer(name, close) {
  if (layers.some(l => l.name === name)) return;
  layers.push({ name, close });
  try { history.pushState({ ...(history.state || {}), layer: name, depth: layers.length }, "", location.href); } catch { /* ignore */ }
}
/** The layer closed by its own control (✕, Esc, Done): drop the history entry it pushed, so Back does not reopen the page under it. @param {string} name */
export function closeLayer(name) {
  const i = layers.findIndex(l => l.name === name); if (i < 0) return;
  const top = i === layers.length - 1;
  layers.splice(i, 1);
  if (top && history.state && history.state.layer === name) { try { history.back(); } catch { /* ignore */ } }
}
export const layerOpen = (/** @type {string} */ name) => layers.some(l => l.name === name);

export function wireLayers() {
  window.addEventListener("popstate", e => {
    const depth = (e.state && Number(e.state.depth)) || 0;
    while (layers.length > depth) { const l = layers.pop(); if (l) l.close(); }
  });
  // every <dialog>: showModal pushes a layer, close (Done, Esc, backdrop) pops it
  $$("dialog").forEach((/** @type {HTMLDialogElement} */ d) => {
    const orig = d.showModal.bind(d);
    d.showModal = () => { orig(); openLayer(d.id, () => { if (d.open) d.close(); }); };
    d.addEventListener("close", () => closeLayer(d.id));
  });
}
