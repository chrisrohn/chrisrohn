// @ts-check
/* Duplicate songs in the year playlists: the daily build's report (data/duplicates.json) plus a live scan of one year. */
import { state, persist, quotaLeft } from "./state.js";
import { $, $$, esc, relTime, toast } from "./dom.js";
import { isOwner } from "./auth.js";
import { yt, titleFor, knownYear, playlistItemsFor, removePlaylistItem } from "./youtube.js";

/** @typedef {import("./types").Dupe} Dupe */

// The daily build scans every year playlist; feed.json carries the counts, data/duplicates.json the full report.
const dupCount = () => (isOwner() && state.feed?.youtube && state.feed.youtube.duplicates_count) || 0;
export function noticeDupes() {
  const stamp = (state.feed?.youtube || {}).duplicates_checked_at || "";
  if (!dupCount() || state.settings.dupesNoticed === stamp) return;
  state.settings.dupesNoticed = stamp; persist();
  setTimeout(() => toast(`⚠ ${dupCount()} duplicated songs in the year playlists`, true, { label: "Review", fn: () => { $("#settings-btn").click(); $("#s-dupes-details").open = true; } }), 2500);
}
async function loadDupes() {
  if (state.dupes) return state.dupes;
  try { const r = await fetch("/data/duplicates.json", { cache: "no-store" }); state.dupes = r.ok ? (await r.json()).duplicates || [] : []; }
  catch { state.dupes = []; }
  return /** @type {Dupe[]} */ (state.dupes);
}
/** @param {string} key @param {string} [vid] */
const dupeDone = (key, vid) => (state.settings.dupesDone || []).includes(key + ":" + (vid || ""));
/** @param {string} key @param {string} [vid] */
function markDupeDone(key, vid) { state.settings.dupesDone = [...(state.settings.dupesDone || []), key + ":" + (vid || "")].slice(-3000); }
/** @param {Dupe} d */
const dupOpen = d => !d.entries.every(e => dupeDone(d.key, e.videoId));
/** @type {Record<string, string>} */
const KIND = { "same-video": "same video added twice", "cross-year": "same video in two years" };
/** @param {Dupe} d @param {import("./types").DupeEntry} e */
const wrongYear = (d, e) => d.verified_year && String(e.year) !== String(d.verified_year);
function dupeFilters() {
  return { kind: $("#s-dupe-kind").value, year: $("#s-dupe-yr").value, q: $("#s-dupe-q").value.trim().toLowerCase() };
}
function filteredDupes() {
  const f = dupeFilters();
  return (state.dupes || []).filter(dupOpen).filter(d => (!f.kind || d.kind === f.kind) && (!f.year || d.years.includes(f.year)) && (!f.q || `${d.artist} ${d.title}`.toLowerCase().includes(f.q)));
}
export async function renderDupes(reset = true) {
  const box = $("#s-dupes"); if (!box) return;
  const yt0 = state.feed?.youtube || {};
  $("#s-dupes-summary").textContent = dupCount()
    ? `⚠ ${dupCount()} duplicated songs in the year playlists (checked ${yt0.duplicates_checked_at ? relTime(new Date(yt0.duplicates_checked_at)) : "?"})`
    : `Duplicate check: none found by the last build${yt0.duplicates_checked_at ? " (" + relTime(new Date(yt0.duplicates_checked_at)) + ")" : ""}`;
  const sel = $("#s-dupe-year");
  if (!sel.options.length) { const cur = new Date().getFullYear(); sel.innerHTML = (state._years || []).map(y => `<option value="${y}" ${y === cur ? "selected" : ""}>${y}</option>`).join(""); }
  if (!dupCount()) { box.innerHTML = ""; return; }
  box.innerHTML = `<span class="muted">loading report…</span>`;
  const all = await loadDupes();
  const ysel = $("#s-dupe-yr");
  if (ysel.options.length <= 1) { const yrs = [...new Set(all.flatMap(d => d.years))].sort().reverse(); ysel.innerHTML = `<option value="">all years</option>` + yrs.map(y => `<option value="${y}">${y}</option>`).join(""); }
  const kinds = yt0.duplicates_kinds || {};
  $("#s-dupe-kinds").textContent = Object.entries(kinds).map(([k, n]) => `${n} ${KIND[k] || k}`).join(" · ");
  if (reset) state.dupePage = 1;
  const list = filteredDupes(); const shown = list.slice(0, 60 * state.dupePage);
  const f = dupeFilters();
  const bulk = $("#s-dupe-bulk"); const bulkable = list.filter(d => d.kind === "same-video");
  bulk.hidden = !(f.kind === "same-video" && f.year && bulkable.length);
  bulk.textContent = `remove all ${bulkable.length} extra copies in ${f.year}…`;
  box.innerHTML = shown.map(d => `<div class="dupe" data-key="${esc(d.key)}">
      <div class="dupe-song"><b>${esc(d.artist)}</b> - ${esc(d.title)} <span class="muted">· ${KIND[d.kind] || d.kind} · ×${d.count}${d.verified_year ? ` · <span class="verified" title="${esc(d.verified_source || "")}">verified ${esc(d.verified_year)}</span>` : ""}</span></div>
      <div class="dupe-entries">${d.kind === "same-video"
        ? `<span class="chip">${esc(d.entries[0].year)} <a href="https://music.youtube.com/watch?v=${esc(d.entries[0].videoId)}&list=${esc(d.entries[0].playlistId)}" target="_blank" rel="noopener">▶</a></span><button class="btn ghost small" type="button" data-fix="extra" data-pid="${esc(d.entries[0].playlistId)}" data-vid="${esc(d.entries[0].videoId)}">remove the extra copy</button>`
        : d.entries.filter(e => !dupeDone(d.key, e.videoId)).map(e => `<span class="chip ${wrongYear(d, e) ? "wrong" : ""}" title="${wrongYear(d, e) ? "not the verified year" : ""}">${esc(e.year)} <a href="https://music.youtube.com/watch?v=${esc(e.videoId)}&list=${esc(e.playlistId)}" target="_blank" rel="noopener">▶</a> <button class="x" type="button" title="remove from ${esc(e.year)}" data-fix="one" data-pid="${esc(e.playlistId)}" data-vid="${esc(e.videoId)}" data-year="${esc(e.year)}">✕</button></span>`).join("")}</div>
    </div>`).join("") + (list.length > shown.length ? `<button class="btn ghost small" type="button" id="s-dupe-more">show ${Math.min(60, list.length - shown.length)} more of ${list.length - shown.length}</button>` : "") + (list.length ? "" : `<span class="muted">nothing matches these filters</span>`);
  $$("button[data-fix]", box).forEach(b => b.addEventListener("click", () => fixDupe(b)));
  const more = $("#s-dupe-more"); if (more) more.addEventListener("click", () => { state.dupePage++; renderDupes(false); });
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
  const bulk = $("#s-dupe-bulk"); bulk.disabled = true;
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
  const status = $("#s-dupe-status"); status.textContent = "scanning…";
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
  const box = $("#s-dupes-live");
  box.innerHTML = byVideo.map(([, g]) => `<div class="dupe"><div class="dupe-song"><b>${esc(g[0].artist)}</b> - ${esc(g[0].title)} <span class="muted">· same video · ×${g.length}</span></div>
    <div class="dupe-entries">${g.map((x, i) => `<span class="chip"><a href="https://music.youtube.com/watch?v=${esc(x.videoId)}&list=${esc(pid)}" target="_blank" rel="noopener">▶ ${i + 1}</a> ${i ? `<button class="x" type="button" data-item="${esc(x.id)}" title="remove this copy">✕</button>` : "<span class=\"muted\">keep</span>"}</span>`).join("")}</div></div>`).join("") || `<span class="muted">No duplicates in ${esc(titleFor(year))} 🎉</span>`;
  $$("button[data-item]", box).forEach(b => b.addEventListener("click", async () => {
    if (!confirm("Remove this copy from the playlist? (50 quota units)")) return;
    b.disabled = true;
    try { await removePlaylistItem(b.dataset.item); b.closest(".chip").remove(); toast("Removed"); } catch (e) { b.disabled = false; toast(/** @type {Error} */ (e).message, true); }
  }));
}
