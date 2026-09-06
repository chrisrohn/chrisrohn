// @ts-check
/* Duplicate songs in the year playlists: the daily build's report (data/duplicates.json) plus a live scan of one year. */
import { state, persist, quotaLeft, quotaText } from "./state.js";
import { $, $$, esc, relTime, toast } from "./dom.js";
import { schedulePush } from "./sync.js";
import { isOwner } from "./auth.js";
import { yt, titleFor, knownYear, playlistItemsFor, removePlaylistItem, addToPlaylist } from "./youtube.js";

/** @typedef {import("./types").Dupe} Dupe */
/** @typedef {import("./types").Unavailable} Unavailable */

// The daily build scans every year playlist; feed.json carries the counts, data/duplicates.json the full report,
// data/unavailable.json the greyed-out tracks with the streamable upload found for each.
const dupCount = () => (isOwner() && state.feed?.youtube && state.feed.youtube.duplicates_count) || 0;
const unavCount = () => (isOwner() && state.feed?.youtube && state.feed.youtube.unavailable_count) || 0;
async function loadUnavailable() {
  if (state.unavailable) return state.unavailable;
  try { const r = await fetch("/data/unavailable.json", { cache: "no-store" }); state.unavailable = r.ok ? (await r.json()).rows || [] : []; }
  catch { state.unavailable = []; }
  return /** @type {Unavailable[]} */ (state.unavailable);
}
/** @param {Unavailable} u */
const unavKey = u => `unav:${u.playlistId}:${u.videoId}`;
/** @param {Unavailable} u */
const unavOpen = u => !(state.settings.dupesDone || []).includes(unavKey(u));
export const openUnavailable = () => (state.unavailable || []).filter(unavOpen).length;
export function noticeDupes() {
  const stamp = (state.feed?.youtube || {}).duplicates_checked_at || "";
  if (!dupCount() || state.settings.dupesNoticed === stamp) return;
  state.settings.dupesNoticed = stamp; persist();
  setTimeout(() => toast(`⚠ ${dupCount()} duplicated songs in the year playlists${unavCount() ? ` · ${unavCount()} not streamable here` : ""}`, true, { label: "Review", fn: showCleanup }), 2500);
}
/** Switch to the Cleanup tab (from the toast, from Settings). */
export function showCleanup() { const tab = $(".tab[data-view=cleanup]"); if (tab) tab.click(); }
/** Duplicates still to deal with: the report minus what this account has already cleaned (synced across devices). */
export const openDupes = () => (state.dupes || []).filter(dupOpen).length;
export const dupesLoaded = () => state.dupes != null;
/** Everything the tab still lists: open duplicates plus greyed-out tracks not yet swapped. */
export const openCleanup = () => (dupesLoaded() ? openDupes() : dupCount()) + (state.unavailable ? openUnavailable() : unavCount());
async function loadDupes() {
  if (state.dupes) return state.dupes;
  try { const r = await fetch("/data/duplicates.json", { cache: "no-store" }); state.dupes = r.ok ? (await r.json()).duplicates || [] : []; }
  catch { state.dupes = []; }
  return /** @type {Dupe[]} */ (state.dupes);
}
/** @param {string} key @param {string} [vid] */
const dupeDone = (key, vid) => (state.settings.dupesDone || []).includes(key + ":" + (vid || ""));
/** @param {string} key @param {string} [vid] */
function markDupeDone(key, vid) { state.settings.dupesDone = [...(state.settings.dupesDone || []), key + ":" + (vid || "")].slice(-3000); schedulePush(); }
/** @param {Dupe} d */
const dupOpen = d => !d.entries.every(e => dupeDone(d.key, e.videoId));
/** @type {Record<string, string>} */
const KIND = { "same-video": "same video added twice", "cross-year": "same video in two years" };
/** @param {Dupe} d @param {import("./types").DupeEntry} e */
const wrongYear = (d, e) => d.verified_year && String(e.year) !== String(d.verified_year);
function dupeFilters() {
  return { kind: $("#cl-dupe-kind").value, year: $("#cl-dupe-yr").value, q: $("#cl-dupe-q").value.trim().toLowerCase() };
}
function filteredDupes() {
  const f = dupeFilters();
  return (state.dupes || []).filter(dupOpen).filter(d => (!f.kind || d.kind === f.kind) && (!f.year || d.years.includes(f.year)) && (!f.q || `${d.artist} ${d.title}`.toLowerCase().includes(f.q)));
}
/** The one-line state of play, for Settings and the tab's header. */
export function dupesSummary() {
  const yt0 = state.feed?.youtube || {}; const when = yt0.duplicates_checked_at ? relTime(new Date(yt0.duplicates_checked_at)) : "?";
  const unav = unavCount() ? ` · ${unavCount()} not streamable here (${yt0.unavailable_with_alt || 0} with a streamable counterpart${yt0.unavailable_pending ? `, ${yt0.unavailable_pending} still being searched` : ""})` : "";
  if (!dupCount()) return `Duplicate check: none found by the last build (${when})${unav}`;
  const done = dupesLoaded() ? dupCount() - openDupes() : 0;
  return `${dupCount()} duplicated songs in the year playlists (checked ${when})${done ? ` · ${done} cleaned since` : ""}${unav}`;
}
export async function renderDupes(reset = true) {
  const box = $("#cl-dupes"); if (!box) return;
  const yt0 = state.feed?.youtube || {};
  const sum = $("#s-dupes-summary"); if (sum) sum.textContent = dupesSummary();
  $("#cl-quota").textContent = quotaText() + ` · about ${Math.max(0, Math.floor((quotaLeft() - 500) / 51))} removals possible today`;
  const sel = $("#cl-dupe-year");
  if (!sel.options.length) { const cur = new Date().getFullYear(); sel.innerHTML = (state._years || []).map(y => `<option value="${y}" ${y === cur ? "selected" : ""}>${y}</option>`).join(""); }
  if (!dupCount() && !unavCount()) { box.innerHTML = ""; $("#cl-summary").textContent = dupesSummary(); return; }
  if (!dupesLoaded()) box.innerHTML = `<span class="muted">loading report…</span>`;
  const all = await loadDupes();
  if (unavCount()) await loadUnavailable();
  $("#cl-summary").textContent = dupesSummary();
  const pill = $("#count-cleanup"); if (pill) pill.textContent = String(openCleanup());
  if (dupeFilters().kind === "unavailable") { renderUnavailable(reset); return; }
  const ysel = $("#cl-dupe-yr");
  if (ysel.options.length <= 1) { const yrs = [...new Set([...all.flatMap(d => d.years), ...(state.unavailable || []).map(u => u.year)])].sort().reverse(); ysel.innerHTML = `<option value="">all years</option>` + yrs.map(y => `<option value="${y}">${y}</option>`).join(""); }
  const kinds = yt0.duplicates_kinds || {};
  $("#cl-dupe-kinds").textContent = Object.entries(kinds).map(([k, n]) => `${n} ${KIND[k] || k}`).concat(unavCount() ? [`${unavCount()} not streamable here`] : []).join(" · ");
  if (reset) state.dupePage = 1;
  const list = filteredDupes(); const shown = list.slice(0, 60 * state.dupePage);
  const f = dupeFilters();
  const bulk = $("#cl-dupe-bulk"); const bulkable = list.filter(d => d.kind === "same-video");
  bulk.hidden = !(f.kind === "same-video" && f.year && bulkable.length);
  bulk.textContent = `remove all ${bulkable.length} extra copies in ${f.year}…`;
  box.innerHTML = shown.map(d => `<div class="dupe" data-key="${esc(d.key)}">
      <div class="dupe-song"><b>${esc(d.artist)}</b> - ${esc(d.title)} <span class="muted">· ${KIND[d.kind] || d.kind} · ×${d.count}${d.verified_year ? ` · <span class="verified" title="${esc(d.verified_source || "")}">verified ${esc(d.verified_year)}</span>` : ""}</span></div>
      <div class="dupe-entries">${d.kind === "same-video"
        ? `<span class="chip">${esc(d.entries[0].year)} <a href="https://music.youtube.com/watch?v=${esc(d.entries[0].videoId)}&list=${esc(d.entries[0].playlistId)}" target="_blank" rel="noopener">▶\uFE0E</a></span><button class="btn ghost small" type="button" data-fix="extra" data-pid="${esc(d.entries[0].playlistId)}" data-vid="${esc(d.entries[0].videoId)}">remove the extra copy</button>`
        : d.entries.filter(e => !dupeDone(d.key, e.videoId)).map(e => `<span class="chip ${wrongYear(d, e) ? "wrong" : ""}" title="${wrongYear(d, e) ? "not the verified year" : ""}">${esc(e.year)} <a href="https://music.youtube.com/watch?v=${esc(e.videoId)}&list=${esc(e.playlistId)}" target="_blank" rel="noopener">▶\uFE0E</a> <button class="x" type="button" title="remove from ${esc(e.year)}" data-fix="one" data-pid="${esc(e.playlistId)}" data-vid="${esc(e.videoId)}" data-year="${esc(e.year)}">✕</button></span>`).join("")}</div>
    </div>`).join("") + (list.length > shown.length ? `<button class="btn ghost small" type="button" id="cl-dupe-more">show ${Math.min(60, list.length - shown.length)} more of ${list.length - shown.length}</button>` : "") + (list.length ? "" : `<span class="muted">nothing matches these filters</span>`);
  $$("button[data-fix]", box).forEach(b => b.addEventListener("click", () => fixDupe(b)));
  const more = $("#cl-dupe-more"); if (more) more.addEventListener("click", () => { state.dupePage++; renderDupes(false); });
}
/** The greyed-out tracks: each with the upload that streams here, and a swap. @param {boolean} reset */
function renderUnavailable(reset) {
  const box = $("#cl-dupes"); const f = dupeFilters();
  if (reset) state.dupePage = 1;
  const list = (state.unavailable || []).filter(unavOpen).filter(u => (!f.year || u.year === f.year) && (!f.q || `${u.artist} ${u.title}`.toLowerCase().includes(f.q)));
  const shown = list.slice(0, 60 * state.dupePage);
  const bulk = $("#cl-dupe-bulk"); const swappable = list.filter(u => u.alt);
  bulk.hidden = !(f.year && swappable.length);
  bulk.textContent = `swap all ${swappable.length} in ${f.year} for streamable uploads…`;
  box.innerHTML = shown.map(u => `<div class="dupe unav" data-key="${esc(unavKey(u))}">
      <div class="dupe-song"><b>${esc(u.artist)}</b> - ${esc(u.title)} <span class="muted">· not streamable here · ${esc(u.year)}</span></div>
      <div class="dupe-entries"><span class="chip wrong" title="the copy in the playlist, greyed out on YouTube Music">${esc(u.year)} <a href="https://music.youtube.com/watch?v=${esc(u.videoId)}&list=${esc(u.playlistId)}" target="_blank" rel="noopener">▶\uFE0E dead</a></span>
        ${u.alt ? `<span class="chip ok" title="${esc(u.alt.album || "")}">→ <a href="https://music.youtube.com/watch?v=${esc(u.alt.videoId)}" target="_blank" rel="noopener">▶\uFE0E ${esc(u.alt.title || "streamable upload")}</a>${u.alt.videoType === "MUSIC_VIDEO_TYPE_ATV" ? " · audio" : " · video"}</span><button class="btn ghost small" type="button" data-swap="1">swap (100 units)</button>`
        : u.pending ? `<span class="muted">counterpart search pending — the next build looks</span>`
        : `<span class="muted">no other upload found</span> <a href="https://music.youtube.com/search?q=${encodeURIComponent(u.artist + " " + u.title)}" target="_blank" rel="noopener">search YT Music</a> <button class="btn ghost small" type="button" data-drop="1" title="remove the dead copy from the playlist (50 units)">remove it</button>`}
      </div></div>`).join("") + (list.length > shown.length ? `<button class="btn ghost small" type="button" id="cl-dupe-more">show ${Math.min(60, list.length - shown.length)} more of ${list.length - shown.length}</button>` : "") + (list.length ? "" : `<span class="muted">nothing matches these filters</span>`);
  $$("button[data-swap], button[data-drop]", box).forEach(b => b.addEventListener("click", () => swapOne(b)));
  const more = $("#cl-dupe-more"); if (more) more.addEventListener("click", () => { state.dupePage++; renderDupes(false); });
}
/** Add the streamable upload to the playlist, then take out the dead copy (or just take it out). @param {HTMLButtonElement} btn */
async function swapOne(btn) {
  const key = /** @type {HTMLElement} */ (btn.closest(".dupe")).dataset.key || "";
  const u = (state.unavailable || []).find(x => unavKey(x) === key); if (!u) return;
  const swap = !!btn.dataset.swap;
  if (!confirm(swap ? `Swap “${u.artist} - ${u.title}” in ${titleFor(u.year)} for the streamable upload? (100 quota units: one add, one removal)` : `Remove the dead copy of “${u.artist} - ${u.title}” from ${titleFor(u.year)}? (50 quota units)`)) return;
  btn.disabled = true;
  try {
    const n = await swapTrack(u, swap);
    state.settings.dupesDone = [...(state.settings.dupesDone || []), key].slice(-3000); persist(); schedulePush();
    toast(swap ? `Swapped · ${u.artist} - ${u.title} → ${titleFor(u.year)}` : `Removed ${n} · ${u.artist} - ${u.title}`);
    renderDupes(false);
  } catch (e) { btn.disabled = false; toast("Could not swap: " + /** @type {Error} */ (e).message, true); }
}
/** @param {Unavailable} u @param {boolean} swap @returns {Promise<number>} removed copies */
async function swapTrack(u, swap) {
  if (swap && u.alt) {
    const present = await playlistItemsFor(u.playlistId, u.alt.videoId);
    if (!present.length) await addToPlaylist(u.playlistId, u.alt.videoId);   // never a second copy of the good one
  }
  return removeCopies(u.playlistId, u.videoId, false);
}
export async function bulkSwap() {
  const f = dupeFilters(); const list = (state.unavailable || []).filter(unavOpen).filter(u => u.alt && u.year === f.year);
  const afford = Math.max(0, Math.floor((quotaLeft() - 500) / 101));
  const todo = list.slice(0, Math.min(list.length, afford));
  if (!todo.length) { toast("Not enough YouTube quota left today for a bulk swap — try after midnight Pacific", true); return; }
  if (!confirm(`Swap ${todo.length} dead tracks in ${titleFor(f.year)} for streamable uploads${todo.length < list.length ? ` (${list.length - todo.length} more when quota allows)` : ""}?\nCost ≈ ${todo.length * 101} of ${quotaLeft()} quota units left today.`)) return;
  const bulk = $("#cl-dupe-bulk"); bulk.disabled = true;
  let done = 0, failed = 0;
  for (const [i, u] of todo.entries()) {
    bulk.textContent = `swapping… ${i + 1}/${todo.length}`;
    try { await swapTrack(u, true); state.settings.dupesDone = [...(state.settings.dupesDone || []), unavKey(u)].slice(-3000); done++; }
    catch (e) { failed++; if (/quota/i.test(/** @type {Error} */ (e).message)) break; }
    if (i % 10 === 9) persist();
  }
  persist(); schedulePush(); bulk.disabled = false;
  toast(`Swapped ${done}${failed ? ` · ${failed} failed` : ""}`);
  renderDupes(false);
}
/** @param {HTMLButtonElement} btn */
async function fixDupe(btn) {
  const row = /** @type {HTMLElement} */ (btn.closest(".dupe")); const key = row.dataset.key || ""; const { pid, vid, fix, year } = btn.dataset;
  const d = (state.dupes || []).find(x => x.key === key) || /** @type {Dupe} */ (/** @type {unknown} */ ({ artist: "", title: "", entries: [] }));
  const what = fix === "extra" ? `Remove the extra copy of “${d.artist} - ${d.title}” (keeps one)?` : `Remove “${d.artist} - ${d.title}” from ${year}? (50 quota units)`;
  if (!confirm(what)) return;
  btn.disabled = true;
  try {
    const n = await removeCopies(pid || "", vid || "", fix === "extra");
    if (fix === "extra") d.entries.forEach(e => markDupeDone(key, e.videoId)); else markDupeDone(key, vid);
    persist();
    toast(n ? `Removed ${n} · ${d.artist} - ${d.title}` : "Nothing to remove — already cleaned up");
    renderDupes(false);
  } catch (e) { btn.disabled = false; toast("Could not remove: " + /** @type {Error} */ (e).message, true); }
}
// delete every playlist item holding this video (keepFirst: leave one copy in place); returns how many went
/** @param {string} playlistId @param {string} videoId @param {boolean} keepFirst */
async function removeCopies(playlistId, videoId, keepFirst) {
  const ids = await playlistItemsFor(playlistId, videoId);
  const victims = keepFirst ? ids.slice(1) : ids;
  for (const i of victims) await removePlaylistItem(i);
  return victims.length;
}
export async function bulkRemoveExtras() {
  const f = dupeFilters(); const list = filteredDupes().filter(d => d.kind === "same-video" && d.years.includes(f.year));
  const cost = list.reduce((n, d) => n + 1 + 50 * (d.count - 1), 0);
  const afford = Math.max(0, Math.floor((quotaLeft() - 500) / 51));
  const todo = list.slice(0, Math.min(list.length, afford));
  if (!todo.length) { toast("Not enough YouTube quota left today for a bulk clean-up — try after midnight Pacific", true); return; }
  if (!confirm(`Remove the extra copies of ${todo.length} songs in ${titleFor(f.year)}${todo.length < list.length ? ` (${list.length - todo.length} more when quota allows)` : ""}?\nCost ≈ ${Math.min(cost, todo.length * 51)} of ${quotaLeft()} quota units left today. One copy of each song stays.`)) return;
  const bulk = $("#cl-dupe-bulk"); bulk.disabled = true;
  let removed = 0, failed = 0;
  for (const [i, d] of todo.entries()) {
    bulk.textContent = `removing… ${i + 1}/${todo.length}`;
    try { removed += await removeCopies(d.entries[0].playlistId, d.entries[0].videoId, true); d.entries.forEach(e => markDupeDone(d.key, e.videoId)); }
    catch (e) { failed++; if (/quota/i.test(/** @type {Error} */ (e).message)) break; }
    if (i % 10 === 9) persist();
  }
  persist(); bulk.disabled = false;
  toast(`Removed ${removed} extra copies${failed ? ` · ${failed} failed` : ""}`);
  renderDupes(false);
}
// Live scan of one year playlist (1 quota unit per 50 tracks): catches today's double-taps before the nightly build does.
/** @param {number} year */
export async function scanYear(year) {
  const pid = knownYear(year) || state.playlists[String(year)]; if (!pid) throw new Error("no playlist id for " + year);
  const status = $("#cl-dupe-status"); status.textContent = "scanning…";
  /** @type {Map<string, {id: string, videoId: string, title: string, artist: string}[]>} */
  const seen = new Map(); let pageToken, n = 0;
  do {
    const j = await yt("GET", "/playlistItems", { params: { part: "snippet", playlistId: pid, maxResults: 50, pageToken } });
    for (const it of j.items || []) {
      n++;
      const sn = it.snippet || {}; const v = sn.resourceId && sn.resourceId.videoId; if (!v) continue;
      const artist = (sn.videoOwnerChannelTitle || "").replace(/\s*-\s*Topic$/i, "");
      const g = seen.get(v) || []; g.push({ id: it.id, videoId: v, title: sn.title, artist }); seen.set(v, g);
    }
    pageToken = j.nextPageToken;
  } while (pageToken);
  const byVideo = [...seen.entries()].filter(([, g]) => g.length > 1);
  status.textContent = `${n} tracks in ${titleFor(year)} · ${byVideo.length} video${byVideo.length === 1 ? "" : "s"} added more than once`;
  const box = $("#cl-dupes-live");
  box.innerHTML = byVideo.map(([, g]) => `<div class="dupe"><div class="dupe-song"><b>${esc(g[0].artist)}</b> - ${esc(g[0].title)} <span class="muted">· same video · ×${g.length}</span></div>
    <div class="dupe-entries">${g.map((x, i) => `<span class="chip"><a href="https://music.youtube.com/watch?v=${esc(x.videoId)}&list=${esc(pid)}" target="_blank" rel="noopener">▶\uFE0E ${i + 1}</a> ${i ? `<button class="x" type="button" data-item="${esc(x.id)}" title="remove this copy">✕</button>` : "<span class=\"muted\">keep</span>"}</span>`).join("")}</div></div>`).join("") || `<span class="muted">No duplicates in ${esc(titleFor(year))} 🎉</span>`;
  $$("button[data-item]", box).forEach(b => b.addEventListener("click", async () => {
    if (!confirm("Remove this copy from the playlist? (50 quota units)")) return;
    b.disabled = true;
    try { await removePlaylistItem(b.dataset.item); b.closest(".chip").remove(); toast("Removed"); } catch (e) { b.disabled = false; toast(/** @type {Error} */ (e).message, true); }
  }));
}
