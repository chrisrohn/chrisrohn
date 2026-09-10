// @ts-check
/* The Cleanup tab: every song the year playlists hold more than once, with every copy laid out to compare, play,
 * keep, remove or move — plus the tracks that no longer stream here, and a live scan of one year.
 *
 * The daily build writes data/duplicates.json (one item per song: discovery/profile.py find_duplicates) and
 * data/unavailable.json; feed.json carries the counts. What you do here is remembered as marks in
 * settings.dupesDone (synced across devices with the ratings): "<key>|ok" dismisses a song as fine,
 * "<key>|<playlist>|<video>|gone" says that copy was removed, "…|one" that its extra copies were trimmed,
 * "…|in|<year>" that a move put it there. A song stays listed while the copies left still add up to a problem
 * (editions.js kindsOf), so removing one copy of three never hides the other two. */
import { state, persist, quotaLeft, quotaText } from "./state.js";
import { $, $$, esc, relTime, toast } from "./dom.js";
import { schedulePush } from "./sync.js";
import { isOwner } from "./auth.js";
import { yt, titleFor, knownYear, playlistItemsFor, removePlaylistItem, addToPlaylist, videoDetails } from "./youtube.js";
import { editionOf, songKey, kindsOf, KIND, KIND_LONG, KIND_ORDER, YEAR_FREE, EDITION_NAME } from "./editions.js";
import { stopPlayer, playerActive } from "./player.js";
import { auditRows, auditYear, auditAll, auditDrop, auditCost, renderAudit, findReplacements, creditOf, region, WHY } from "./audit.js";

/** @typedef {import("./types").Dupe} Dupe */
/** @typedef {import("./types").DupeEntry} DupeEntry */
/** @typedef {import("./types").Unavailable} Unavailable */
/** One copy of a song as the tab shows it: every playlist row holding this video in this playlist, folded together.
 * @typedef {{ pid: string, year: string, videoId: string, edition: string, label: string, title: string, copies: number, positions: number[],
 *   album?: string | null, duration?: number | null, videoType?: string | null, avail: boolean, itemIds?: string[], added?: boolean }} Row */
/** @typedef {{ rows: Row[], kinds: string[], dismissed: boolean, open: boolean }} View */

const PAGE = 60;
const READ = 1, WRITE = 50;
const RESERVE = 500;   // quota kept back for the day's keeps

// ------------------------------------------------------------------ the reports
const dupCount = () => (isOwner() && state.feed?.youtube && state.feed.youtube.duplicates_count) || 0;
const unavCount = () => (isOwner() && state.feed?.youtube && state.feed.youtube.unavailable_count) || 0;
async function loadUnavailable() {
  if (state.unavailable) return state.unavailable;
  try { const r = await fetch("/data/unavailable.json", { cache: "no-cache" }); state.unavailable = r.ok ? (await r.json()).rows || [] : []; }
  catch { state.unavailable = []; }
  return /** @type {Unavailable[]} */ (state.unavailable);
}
async function loadDupes() {
  if (state.dupes) return state.dupes;
  try { const r = await fetch("/data/duplicates.json", { cache: "no-cache" }); state.dupes = r.ok ? normalizeReport(await r.json()) : []; }
  catch { state.dupes = []; }
  return /** @type {Dupe[]} */ (state.dupes);
}
/** A version 1 report (one item per video, rows without titles) read as version 2 items, so a cached old file still works. @param {any} j @returns {Dupe[]} */
function normalizeReport(j) {
  const list = /** @type {Dupe[]} */ ((j && j.duplicates) || []);
  if (j && j.version >= 2) return list;
  return list.map(d => { const ed = editionOf(d.title); return { ...d, kinds: d.kinds || [d.kind], uploads: 1, editions: [ed.edition], entries: d.entries.map(e => ({ ...e, title: e.title || d.title, edition: e.edition || ed.edition, label: e.label || ed.label })) }; });
}
export const dupesLoaded = () => state.dupes != null;

// ------------------------------------------------------------------ what has been done (synced marks)
const marks = () => state.settings.dupesDone || [];
/** @type {{ ref: string[] | null, set: Set<string>, added: Map<string, { pid: string, vid: string, year: string }[]> }} */
const idx = { ref: null, set: new Set(), added: new Map() };
function index() {
  const m = marks(); if (idx.ref === m) return idx;
  idx.ref = m; idx.set = new Set(m); idx.added = new Map();
  for (const mk of m) { const p = mk.split("|"); if (p.length === 5 && p[3] === "in") { const list = idx.added.get(p[0]) || []; list.push({ pid: p[1], vid: p[2], year: p[4] }); idx.added.set(p[0], list); } }
  return idx;
}
/** @param {string} m */
const has = m => index().set.has(m);
/** @param {string[]} ms */
function mark(...ms) { const cur = marks(); const add = ms.filter(m => !cur.includes(m)); if (!add.length) return; state.settings.dupesDone = [...cur, ...add].slice(-4000); persist(); schedulePush(); }
/** @param {string} m */
function unmark(m) { state.settings.dupesDone = marks().filter(x => x !== m); persist(); schedulePush(); }
/** @param {{ playlistId: string, videoId: string }} u */
const unavKey = u => `unav:${u.playlistId}:${u.videoId}`;
/** @param {{ playlistId: string, videoId: string }} u */
const unavOpen = u => !has(unavKey(u));
/** Everything that will not play here: the build's greyed-out rows and the audit's findings, one row per playlist copy;
 * the build's row wins when both name the same copy (it may carry the counterpart), the audit's reason is kept. @returns {Unavailable[]} */
export function unavailableRows() {
  /** @type {Map<string, Unavailable>} */ const m = new Map();
  for (const u of state.unavailable || []) m.set(unavKey(u), { ...u, found: "build", why: u.why || "greyed" });
  for (const a of auditRows()) {
    const k = unavKey(a); const b = m.get(k);
    if (b) { b.why = a.why; b.itemId = a.itemId; b.at = a.at; if (!b.artist && a.artist) { b.artist = a.artist; b.title = a.title; } }
    else m.set(k, { year: a.year, playlistId: a.playlistId, videoId: a.videoId, position: a.position, artist: a.artist, title: a.title, alt: null, pending: false, why: a.why, found: "audit", at: a.at, itemId: a.itemId });
  }
  return [...m.values()].sort((a, b) => b.year.localeCompare(a.year) || (a.position || 0) - (b.position || 0));
}
export const openUnavailable = () => unavailableRows().filter(unavOpen).length;
/** The audit's findings still in the playlists, for the ratings file the build learns from (github.js). */
export const openAuditRows = () => auditRows().filter(unavOpen);

// ------------------------------------------------------------------ a song's copies, as they stand now
const EDITION_RANK = { original: 0, radio: 1, extended: 2, remix: 3, live: 4, acoustic: 5, instrumental: 6, demo: 7 };
/** @param {Dupe} d @returns {Row[]} */
function rowsOf(d) {
  /** @type {Map<string, Row>} */ const m = new Map();
  for (const e of d.entries) {
    const k = `${e.playlistId}|${e.videoId}`;
    let r = m.get(k);
    if (!r) {
      const ed = e.edition ? { edition: e.edition, label: e.label || "" } : editionOf(e.title || d.title);
      r = { pid: e.playlistId, year: String(e.year), videoId: e.videoId, edition: ed.edition, label: ed.label, title: e.title || d.title, copies: 0, positions: [], album: e.album, duration: e.duration, videoType: e.videoType, avail: e.avail !== false, itemIds: e.itemIds ? [] : undefined };
      m.set(k, r);
    }
    r.copies++; if (e.position != null && e.position >= 0) r.positions.push(e.position); if (e.itemIds && r.itemIds) r.itemIds.push(...e.itemIds);
  }
  /** @type {Row[]} */ const rows = [];
  for (const r of m.values()) {
    if (!d.live && has(`${d.key}|${r.pid}|${r.videoId}|gone`)) continue;
    if (!d.live && r.copies > 1 && has(`${d.key}|${r.pid}|${r.videoId}|one`)) { r.copies = 1; r.positions = r.positions.slice(0, 1); }
    rows.push(r);
  }
  for (const a of (d.live ? [] : index().added.get(d.key) || [])) {
    if (rows.some(r => r.pid === a.pid && r.videoId === a.vid) || has(`${d.key}|${a.pid}|${a.vid}|gone`)) continue;   // moved in, then removed again
    const src = [...m.values()].find(r => r.videoId === a.vid);
    rows.push({ edition: "original", label: "", title: d.title, album: null, duration: null, videoType: null, ...(src || {}), pid: a.pid, year: a.year, videoId: a.vid, copies: 1, positions: [], avail: true, added: true });
  }
  rows.sort((a, b) => b.year.localeCompare(a.year) || (EDITION_RANK[a.edition] ?? 9) - (EDITION_RANK[b.edition] ?? 9) || a.videoId.localeCompare(b.videoId));
  return rows;
}
/** @param {Dupe} d @returns {View} */
function viewOf(d) { const rows = rowsOf(d); const kinds = kindsOf(rows); const dismissed = !d.live && has(`${d.key}|ok`); return { rows, kinds, dismissed, open: !dismissed && kinds.length > 0 }; }
/** A copy filed in a year the catalogues say is not the song's — remixes, live takes and the like have their own year. @param {Dupe} d @param {Row} r */
const wrongYear = (d, r) => !!d.verified_year && !YEAR_FREE.has(r.edition) && r.year !== String(d.verified_year);
/** Every year-bound copy sits in the wrong year: the song wants moving, not trimming. @param {Dupe} d @param {Row[]} rows */
const misfiled = (d, rows) => !!d.verified_year && rows.some(r => !YEAR_FREE.has(r.edition)) && rows.filter(r => !YEAR_FREE.has(r.edition)).every(r => wrongYear(d, r));

/** @type {{ dupes: Dupe[] | null, marks: string[] | null, n: number }} */
const openCache = { dupes: null, marks: null, n: 0 };
/** Songs still to deal with: the report minus what this account has cleaned or dismissed (synced across devices). */
export function openDupes() {
  const list = state.dupes || [];
  if (openCache.dupes !== list || openCache.marks !== marks()) { openCache.dupes = list; openCache.marks = marks(); openCache.n = list.filter(d => viewOf(d).open).length; }
  return openCache.n;
}
/** Everything the tab still lists: open songs plus tracks that will not play here, not yet swapped or removed. */
export const openCleanup = () => (dupesLoaded() ? openDupes() : dupCount()) + (state.unavailable ? openUnavailable() : unavCount() + auditRows().filter(unavOpen).length);

export function noticeDupes() {
  const stamp = (state.feed?.youtube || {}).duplicates_checked_at || "";
  if (!dupCount() || state.settings.dupesNoticed === stamp) return;
  state.settings.dupesNoticed = stamp; persist();
  setTimeout(() => toast(`⚠ ${dupCount()} duplicated songs in the year playlists${unavCount() ? ` · ${unavCount()} not streamable here` : ""}`, true, { label: "Review", fn: showCleanup }), 2500);
}
/** Switch to the Cleanup tab (from the toast, from Settings). */
export function showCleanup() { const tab = $(".tab[data-view=cleanup]"); if (tab) tab.click(); }
/** The one-line state of play, for Settings and the tab's header. */
export function dupesSummary() {
  const yt0 = state.feed?.youtube || {}; const when = yt0.duplicates_checked_at ? relTime(new Date(yt0.duplicates_checked_at)) : "?";
  const audited = auditRows().length;
  const unav = unavCount() ? ` · ${unavCount()} not streamable here (${yt0.unavailable_with_alt || 0} with a streamable counterpart${yt0.unavailable_pending ? `, ${yt0.unavailable_pending} still being searched` : ""})` : "";
  const dead = audited ? ` · ${audited} found unplayable in ${region()} by your audit` : "";
  if (!dupCount()) return `Duplicate check: none found by the last build (${when})${unav}${dead}`;
  const done = dupesLoaded() ? dupCount() - openDupes() : 0;
  return `${dupCount()} duplicated songs in the year playlists (checked ${when})${done ? ` · ${done} cleaned or dismissed since` : ""}${unav}${dead}`;
}

// ------------------------------------------------------------------ filters
function filters() {
  return { kind: $("#cl-dupe-kind").value, year: $("#cl-dupe-yr").value, sort: ($("#cl-dupe-sort") || {}).value || "issue", q: $("#cl-dupe-q").value.trim().toLowerCase() };
}
/** @param {Dupe} d @param {View} v */
const severity = (d, v) => v.kinds.length ? Math.min(...v.kinds.map(k => KIND_ORDER.indexOf(k))) - (misfiled(d, v.rows) ? 0.5 : 0) : 9;
/** @returns {{ d: Dupe, v: View }[]} */
function filteredDupes() {
  const f = filters();
  let list = (state.dupes || []).map(d => ({ d, v: viewOf(d) }));
  list = f.kind === "dismissed" ? list.filter(x => x.v.dismissed) : list.filter(x => x.v.open);
  if (f.kind === "wrong-year") list = list.filter(x => x.v.rows.some(r => wrongYear(x.d, r)));
  else if (f.kind && f.kind !== "dismissed") list = list.filter(x => x.v.kinds.includes(f.kind));
  if (f.year) list = list.filter(x => x.v.rows.some(r => r.year === f.year));
  if (f.q) list = list.filter(x => `${x.d.artist} ${x.d.title} ${x.v.rows.map(r => r.label + " " + r.title).join(" ")}`.toLowerCase().includes(f.q));
  const by = { issue: (/** @type {any} */ a, /** @type {any} */ b) => severity(a.d, a.v) - severity(b.d, b.v) || b.d.years[0].localeCompare(a.d.years[0]),
    year: (/** @type {any} */ a, /** @type {any} */ b) => b.d.years[0].localeCompare(a.d.years[0]) || a.d.artist.localeCompare(b.d.artist),
    artist: (/** @type {any} */ a, /** @type {any} */ b) => a.d.artist.localeCompare(b.d.artist) || a.d.title.localeCompare(b.d.title),
    copies: (/** @type {any} */ a, /** @type {any} */ b) => b.v.rows.reduce((n, r) => n + r.copies, 0) - a.v.rows.reduce((n, r) => n + r.copies, 0) || a.d.artist.localeCompare(b.d.artist) };
  list.sort(by[f.sort] || by.issue);
  return list;
}

// ------------------------------------------------------------------ rendering
/** @param {number | null | undefined} s */
const mmss = s => s == null ? "" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
/** @param {number | null} n */
const views = n => n == null ? "" : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M views" : n >= 1e3 ? Math.round(n / 1e3) + "K views" : n + " views";
/** @type {Record<string, string>} */
const VTYPE = { MUSIC_VIDEO_TYPE_ATV: "audio track", MUSIC_VIDEO_TYPE_OMV: "official video", MUSIC_VIDEO_TYPE_UGC: "user upload", MUSIC_VIDEO_TYPE_OFFICIAL_SOURCE_MUSIC: "official upload", MUSIC_VIDEO_TYPE_PRIVATELY_OWNED_TRACK: "private track" };
/** The year playlists a copy can move to (the build's pinned ids). */
const moveYears = () => (state._years || []).map(String).filter(y => knownYear(y) || state.playlists[y]);
/** @param {Row} r @param {Dupe} d */
function rowHtml(r, d) {
  const info = state.videoInfo[r.videoId]; const wrong = wrongYear(d, r);
  const form = info ? (info.missing ? "gone from YouTube" : info.topic ? "audio track" : info.channel) : (r.videoType && VTYPE[r.videoType]) || "";
  const meta = [mmss(info ? info.seconds : r.duration), form, r.album, info ? views(info.views) : "", info && info.published ? "uploaded " + info.published.slice(0, 7) : "",
    r.positions.length ? "#" + r.positions.map(p => p + 1).join(", #") : "", r.copies > 1 ? `×${r.copies} copies` : "", !r.avail ? "✗ not streamable here" : "", info && info.blocked ? "✗ blocked here" : "", r.added ? "moved here just now" : ""].filter(Boolean);
  const years = moveYears().filter(y => y !== r.year);
  return `<div class="drow ${wrong ? "wrong" : ""} ${!r.avail || (info && (info.blocked || info.missing)) ? "dead" : ""} ed-${esc(r.edition)}" data-pid="${esc(r.pid)}" data-vid="${esc(r.videoId)}" data-year="${esc(r.year)}">
      <input type="radio" class="keep" name="keep-${esc(d.key)}" aria-label="keep this copy" title="keep this copy and remove the others">
      <button class="dthumb" type="button" data-act="play" title="play this copy here" aria-label="play this copy here"><img src="https://i.ytimg.com/vi/${esc(r.videoId)}/default.jpg" alt="" loading="lazy" width="120" height="90"><span>▶︎</span></button>
      <span class="dyear" title="${wrong ? `filed in ${esc(r.year)}, the catalogues say ${esc(d.verified_year)}` : titleFor(r.year)}">${esc(r.year)}${wrong ? " <b>≠</b>" : ""}</span>
      <span class="dwhat">
        <span class="dwhat-1"><span class="ded">${esc(EDITION_NAME[r.edition] || r.edition)}</span>${r.label ? ` <span class="dlabel">${esc(r.label)}</span>` : ""} <span class="dtitle" title="${esc(r.title)}">${esc(info && info.title ? info.title : r.title)}</span></span>
        <span class="dmeta">${meta.map(esc).join(" · ")}</span>
      </span>
      <span class="dact">
        ${r.copies > 1 ? `<button class="btn ghost small" type="button" data-fix="extra" data-pid="${esc(r.pid)}" data-vid="${esc(r.videoId)}" data-year="${esc(r.year)}" title="remove the extra ${r.copies - 1}, one stays (${(r.copies - 1) * WRITE + READ} units)">keep one of ×${r.copies}</button>` : ""}
        ${years.length ? `<select class="dmove" aria-label="move this copy to another year" title="move this copy to another year (${READ + WRITE + READ + WRITE * r.copies} units)"><option value="">move to…</option>${years.map(y => `<option value="${y}" ${d.verified_year && String(d.verified_year) === y ? "class=\"verified\"" : ""}>${y}${d.verified_year && String(d.verified_year) === y ? " ✓ verified" : ""}</option>`).join("")}</select>` : ""}
        <a class="dopen" href="https://music.youtube.com/watch?v=${esc(r.videoId)}&list=${esc(r.pid)}" target="_blank" rel="noopener" title="open on YouTube Music">↗</a>
        <button class="x" type="button" data-fix="one" data-pid="${esc(r.pid)}" data-vid="${esc(r.videoId)}" data-year="${esc(r.year)}" title="remove this copy from ${esc(titleFor(r.year))} (${READ + WRITE * r.copies} units)">✕</button>
      </span>
    </div>`;
}
/** @param {Dupe} d @param {View} v */
function itemHtml(d, v) {
  const rows = v.rows; const years = [...new Set(rows.map(r => r.year))]; const copies = rows.reduce((n, r) => n + r.copies, 0);
  const mis = misfiled(d, rows); const looked = rows.every(r => state.videoInfo[r.videoId]);
  const target = d.verified_year ? String(d.verified_year) : "";
  const canMove = mis && target && moveYears().includes(target);
  return `<div class="dupe ${d.live ? "live" : ""} ${v.dismissed ? "dismissed" : ""}" data-key="${esc(d.key)}">
      <div class="dupe-song">
        <span class="dname"><b>${esc(d.artist)}</b> - ${esc(d.title)}</span>
        <span class="flags">${v.kinds.map(k => `<span class="flag ${k}" title="${esc(KIND_LONG[k] || k)}">${esc(KIND[k] || k)}</span>`).join("")}<span class="muted">${copies} ${copies === 1 ? "copy" : "copies"} · ${rows.length === 1 ? "one upload" : `${new Set(rows.map(r => r.videoId)).size} uploads`} · ${years.join(", ")}</span></span>
        ${d.verified_year ? `<span class="verified" title="${esc(d.verified_source || "")}">verified ${esc(d.verified_year)}${d.verified_source ? ` · ${esc(d.verified_source)}` : ""}</span>` : ""}
        ${mis ? `<span class="misfiled">every copy is in the wrong year</span>` : ""}
      </div>
      <div class="dupe-rows">${rows.map(r => rowHtml(r, d)).join("")}</div>
      <div class="dupe-actions">
        <button class="btn ghost small" type="button" data-act="keep" disabled title="pick a copy with its radio button first">keep the chosen copy, remove the others</button>
        ${canMove ? `<button class="btn ghost small" type="button" data-act="moveall" title="add each upload to ${esc(titleFor(target))} and take every copy out of ${years.map(y => titleFor(y)).join(", ")}">move everything to ${esc(target)} (≈${moveAllCost(rows)} units)</button>` : ""}
        ${!looked ? `<button class="btn ghost small" type="button" data-act="details" title="ask YouTube about these uploads: length, channel, views, upload date, region (${Math.ceil(new Set(rows.map(r => r.videoId)).size / 50)} unit)">look up the copies</button>` : ""}
        ${d.live ? "" : v.dismissed ? `<button class="btn ghost small" type="button" data-act="reopen">reopen</button>` : `<button class="btn ghost small" type="button" data-act="ok" title="no change needed: keep every copy as it is and stop listing this song">looks fine · dismiss</button>`}
      </div>
      <div class="dupe-player" hidden></div>
    </div>`;
}
/** @param {Row[]} rows */
function moveAllCost(rows) { const vids = new Set(rows.map(r => r.videoId)); return vids.size * (READ + WRITE) + rows.reduce((n, r) => n + READ + WRITE * r.copies, 0); }
/** @param {HTMLElement} box @param {{ d: Dupe, v: View }[]} list @param {number} shown */
function renderItems(box, list, shown) {
  const page = list.slice(0, shown);
  box.innerHTML = page.map(x => itemHtml(x.d, x.v)).join("") + (list.length > shown ? `<button class="btn ghost small" type="button" data-act="more">show ${Math.min(PAGE, list.length - shown)} more of ${list.length - shown}</button>` : "") + (list.length ? "" : `<span class="muted">nothing matches these filters</span>`);
}
/** Redraw one song in place after something changed, keeping its player if one is open. @param {Dupe} d */
function refreshItem(d) {
  const el = $(`.dupe[data-key="${CSS.escape(d.key)}"]`); if (!el) return;
  const v = viewOf(d); const f = filters();
  if (!d.live && !(f.kind === "dismissed" ? v.dismissed : v.open)) { el.remove(); afterChange(); return; }
  const player = $(".dupe-player", el); const tmp = document.createElement("div"); tmp.innerHTML = itemHtml(d, v);
  const fresh = /** @type {HTMLElement} */ (tmp.firstElementChild);
  if (player && !player.hidden) { const slot = $(".dupe-player", fresh); slot.replaceWith(player); const vid = player.dataset.vid; const row = vid ? $(`.drow[data-vid="${CSS.escape(vid)}"]`, fresh) : null; if (row) row.classList.add("playing"); }
  el.replaceWith(fresh);
  if (d.live) afterChange();
}
/** Counts and summaries after any action. */
function afterChange() {
  const pill = $("#count-cleanup"); if (pill) pill.textContent = String(openCleanup());
  const sum = $("#s-dupes-summary"); if (sum) sum.textContent = dupesSummary();
  $("#cl-summary").textContent = dupesSummary();
  $("#cl-quota").textContent = quotaLine();
  const f = filters(); const list = filteredDupes(); updateBulk(f, list);
  $("#cl-dupe-shown").textContent = list.length ? `${list.length} song${list.length === 1 ? "" : "s"}` : "";
}
const quotaLine = () => quotaText() + ` · about ${Math.max(0, Math.floor((quotaLeft() - RESERVE) / (READ + WRITE)))} removals possible today`;

export async function renderDupes(reset = true) {
  const box = $("#cl-dupes"); if (!box) return;
  const yt0 = state.feed?.youtube || {};
  const sum = $("#s-dupes-summary"); if (sum) sum.textContent = dupesSummary();
  $("#cl-quota").textContent = quotaLine();
  const sel = $("#cl-dupe-year");
  if (!sel.options.length) { const cur = new Date().getFullYear(); sel.innerHTML = (state._years || []).map(y => `<option value="${y}" ${y === cur ? "selected" : ""}>${y}</option>`).join(""); }
  const asel = $("#cl-audit-year");
  if (asel && !asel.options.length) asel.innerHTML = sel.innerHTML;
  renderAudit();
  if (!dupCount() && !unavCount() && !auditRows().length) {
    box.innerHTML = ""; $("#cl-summary").textContent = dupesSummary(); $("#cl-dupe-shown").textContent = ""; $("#cl-dupe-bulk").hidden = true; $("#cl-dupe-lookup").hidden = true;
    const pill = $("#count-cleanup"); if (pill) pill.textContent = String(openCleanup());
    return;
  }
  if (!dupesLoaded() && dupCount()) box.innerHTML = `<span class="muted">loading report…</span>`;
  const all = dupCount() ? await loadDupes() : (state.dupes = state.dupes || []);   // the feed's count is the authority: no duplicates, no report to read
  if (unavCount()) await loadUnavailable();
  $("#cl-summary").textContent = dupesSummary();
  const pill = $("#count-cleanup"); if (pill) pill.textContent = String(openCleanup());
  const ysel = $("#cl-dupe-yr");
  if (ysel.options.length <= 1) { const yrs = [...new Set([...all.flatMap(d => d.years), ...unavailableRows().map(u => u.year)])].sort().reverse(); ysel.innerHTML = `<option value="">all years</option>` + yrs.map(y => `<option value="${y}">${y}</option>`).join(""); }
  const kinds = yt0.duplicates_kinds || {};
  $("#cl-dupe-kinds").textContent = Object.entries(kinds).sort((a, b) => KIND_ORDER.indexOf(a[0]) - KIND_ORDER.indexOf(b[0])).map(([k, n]) => `${n} ${KIND[k] || k}`).concat(openUnavailable() ? [`${openUnavailable()} not streamable here`] : []).join(" · ");
  if (reset) state.dupePage = 1;
  const f = filters();
  if (f.kind === "unavailable") { updateBulk(f, []); renderUnavailable(); return; }
  const list = filteredDupes();
  updateBulk(f, list);
  $("#cl-dupe-shown").textContent = list.length ? `${list.length} song${list.length === 1 ? "" : "s"}` : "";
  renderItems(box, list, PAGE * state.dupePage);
}
/** The bulk button for the filter in force: extra copies in a year, wrong-year copies of verified songs, dead tracks with a counterpart. @param {ReturnType<typeof filters>} f @param {{ d: Dupe, v: View }[]} list */
function updateBulk(f, list) {
  const bulk = $("#cl-dupe-bulk"); const look = $("#cl-dupe-lookup");
  const vids = new Set(list.slice(0, PAGE * state.dupePage).flatMap(x => x.v.rows.map(r => r.videoId)).filter(v => !state.videoInfo[v]));
  look.hidden = f.kind === "unavailable" || !vids.size; look.textContent = `look up the ${vids.size} copies shown (${Math.ceil(vids.size / 50)} unit${vids.size > 50 ? "s" : ""})`;
  if (f.kind === "unavailable") { const swappable = unavailableRows().filter(unavOpen).filter(u => u.alt && (!f.year || u.year === f.year)); bulk.hidden = !(f.year && swappable.length); bulk.textContent = `swap all ${swappable.length} in ${f.year} for streamable uploads…`; return; }
  if (f.kind === "same-video" && f.year) { const n = list.reduce((k, x) => k + x.v.rows.filter(r => r.year === f.year && r.copies > 1).length, 0); bulk.hidden = !n; bulk.textContent = `remove all ${n} extra copies in ${f.year}…`; return; }
  if (f.kind === "wrong-year" && f.year) { const n = list.reduce((k, x) => k + x.v.rows.filter(r => r.year === f.year && wrongYear(x.d, r)).length, 0); bulk.hidden = !n; bulk.textContent = `fix all ${n} wrong-year copies in ${f.year}…`; return; }
  bulk.hidden = true;
}

/** The tracks that will not play here: each with why, the upload that does (the build's counterpart or a search's), and a swap. */
function renderUnavailable() {
  const box = $("#cl-dupes"); const f = filters();
  const list = unavailableRows().filter(unavOpen).filter(u => (!f.year || u.year === f.year) && (!f.q || `${u.artist} ${u.title} ${u.why}`.toLowerCase().includes(f.q)));
  const shown = list.slice(0, PAGE * state.dupePage);
  $("#cl-dupe-shown").textContent = list.length ? `${list.length} track${list.length === 1 ? "" : "s"}` : "";
  box.innerHTML = shown.map(unavHtml).join("") + (list.length > shown.length ? `<button class="btn ghost small" type="button" data-act="more">show ${Math.min(PAGE, list.length - shown.length)} more of ${list.length - shown.length}</button>` : "") + (list.length ? "" : `<span class="muted">nothing matches these filters</span>`);
}
/** @param {Unavailable} u */
function unavHtml(u) {
  const why = u.why && u.why !== "greyed" ? WHY[u.why] || u.why : `greyed out on YouTube Music in ${region()}`;
  const name = u.artist || u.title ? `<b>${esc(u.artist)}</b> - ${esc(u.title)}` : `<span class="muted">no title left on YouTube</span> <span class="muted">(row #${(u.position || 0) + 1} of ${esc(titleFor(u.year))})</span>`;
  const q = `${u.artist} ${u.title}`.trim();
  return `<div class="dupe unav" data-key="${esc(unavKey(u))}">
      <div class="dupe-song"><span class="dname">${name}</span> <span class="flags"><span class="flag dead" title="${u.found === "audit" ? `found by your audit ${u.at ? relTime(new Date(u.at)) : ""}` : "found by the daily build's scan"}">${esc(why)}</span><span class="muted">${esc(u.year)}${u.found === "audit" ? " · audit" : ""}</span></span></div>
      <div class="dupe-entries"><span class="chip wrong" title="the copy in the playlist, which will not play here"><img class="cthumb" src="https://i.ytimg.com/vi/${esc(u.videoId)}/default.jpg" alt="" loading="lazy">${esc(u.year)} <a href="https://music.youtube.com/watch?v=${esc(u.videoId)}&list=${esc(u.playlistId)}" target="_blank" rel="noopener">▶︎ dead</a></span>
        ${u.alt ? `<span class="chip ok" title="${esc(u.alt.album || "")}"><img class="cthumb" src="https://i.ytimg.com/vi/${esc(u.alt.videoId)}/default.jpg" alt="" loading="lazy">→ <a href="https://music.youtube.com/watch?v=${esc(u.alt.videoId)}" target="_blank" rel="noopener">▶︎ ${esc(u.alt.title || "streamable upload")}</a>${u.alt.videoType === "MUSIC_VIDEO_TYPE_ATV" ? " · audio" : " · video"}</span><button class="btn ghost small" type="button" data-swap="1">swap (100 units)</button>`
        : u.pending ? `<span class="muted">counterpart search pending — the next build looks</span>`
        : q ? `<span class="muted">no other upload found${u.found === "audit" ? " yet — the next build looks" : ""}</span>` : ""}
        ${q ? `<a href="https://music.youtube.com/search?q=${encodeURIComponent(q)}" target="_blank" rel="noopener">search YT Music</a> <button class="btn ghost small" type="button" data-find="1" title="one YouTube search (100 units) plus a check that the results play here (1 unit)">find a replacement now (101 units)</button>` : `<span class="dsearch"><input type="text" placeholder="artist - title, if you know it" aria-label="artist and title to search for"><button class="btn ghost small" type="button" data-find="1" title="one YouTube search (100 units) plus a check that the results play here (1 unit)">find a replacement (101 units)</button></span>`}
        <button class="btn ghost small" type="button" data-drop="1" title="remove the dead copy from the playlist (${u.itemId ? "50" : "51"} units)">remove it</button>
      </div><div class="dalts" hidden></div></div>`;
}
/** @param {import("./types").Replacement} r @param {Unavailable} u */
const altHtml = (r, u) => `<div class="dalt" data-vid="${esc(r.videoId)}"><button class="dthumb" type="button" data-act="preview" title="play this upload here"><img src="https://i.ytimg.com/vi/${esc(r.videoId)}/default.jpg" alt="" loading="lazy" width="120" height="90"><span>▶︎</span></button>
    <span class="dwhat"><span class="dwhat-1"><span class="ded">${r.topic ? "audio track" : "video"}</span> <span class="dtitle" title="${esc(r.title)}">${esc(r.title)}</span></span><span class="dmeta">${[mmss(r.seconds), r.channel, views(r.views), r.published ? "uploaded " + r.published.slice(0, 7) : "", r.embeddable ? "" : "will not embed"].filter(Boolean).map(esc).join(" · ")}</span></span>
    <span class="dact"><a class="dopen" href="https://music.youtube.com/watch?v=${esc(r.videoId)}" target="_blank" rel="noopener" title="open on YouTube Music">↗</a><button class="btn ghost small" type="button" data-use="${esc(r.videoId)}" title="add this upload to ${esc(titleFor(u.year))} and remove the dead copy (${u.itemId ? "101" : "102"} units)">use this · swap</button></span></div>`;

// ------------------------------------------------------------------ actions on the report
/** @param {Dupe} d @param {Row} r */
const who = (d, r) => `${d.artist} - ${r.title || d.title}`;
/** Delete every playlist item holding this video in this playlist (keepFirst: leave one); returns how many went. A live
 * row knows its item ids; a report row asks YouTube first (1 unit) so a copy removed elsewhere is never removed twice.
 * @param {Dupe} d @param {Row} r @param {boolean} keepFirst @param {string} why */
async function removeRow(d, r, keepFirst, why) {
  const ids = r.itemIds && r.itemIds.length ? r.itemIds : await playlistItemsFor(r.pid, r.videoId, { why: "Cleanup: verify which playlist items hold this copy before removing any", detail: who(d, r) });
  const victims = keepFirst ? ids.slice(1) : ids;
  for (const i of victims) await removePlaylistItem(i, { why, detail: who(d, r) });
  if (d.live) { d.entries = d.entries.filter(e => !(e.playlistId === r.pid && e.videoId === r.videoId) || (keepFirst && e.itemIds && e.itemIds[0] === ids[0])); if (keepFirst) for (const e of d.entries) if (e.itemIds) e.itemIds = e.itemIds.filter(i => !victims.includes(i)); }
  else mark(`${d.key}|${r.pid}|${r.videoId}|${keepFirst ? "one" : "gone"}`);
  return victims.length;
}
/** Add this copy to another year (unless that playlist already holds the video), then take it out of this one.
 * @param {Dupe} d @param {Row} r @param {string} year */
async function moveRow(d, r, year) {
  const target = knownYear(year) || state.playlists[year]; if (!target) throw new Error(`no playlist id for ${year}`);
  const present = await playlistItemsFor(target, r.videoId, { why: `Cleanup: verify “${titleFor(year)}” does not already hold this upload before moving it there`, detail: who(d, r) });
  if (!present.length) await addToPlaylist(target, r.videoId, { why: `Cleanup: move this copy to “${titleFor(year)}”${d.verified_year && String(d.verified_year) === year ? " (the year the catalogues verified)" : ""}`, detail: who(d, r) });
  const n = await removeRow(d, r, false, `Cleanup: take the copy out of “${titleFor(r.year)}” after moving it to “${titleFor(year)}”`);
  if (d.live) d.entries.push({ year, playlistId: target, videoId: r.videoId, position: -1, title: r.title, edition: r.edition, label: r.label, album: r.album, duration: r.duration, videoType: r.videoType, itemIds: [] });
  else mark(`${d.key}|${target}|${r.videoId}|in|${year}`);
  return n;
}
/** @param {number} units */
function affordable(units) { if (quotaLeft() - units < 0) { toast(`Not enough YouTube quota left today (needs ${units}, ${quotaLeft()} left) — try after midnight Pacific`, true); return false; } return true; }
/** @param {HTMLElement} el */
const itemFor = el => { const key = /** @type {HTMLElement} */ (el.closest(".dupe")).dataset.key || ""; return [...(state.dupes || []), ...(state.liveDupes || [])].find(x => x.key === key) || null; };
/** @param {HTMLElement} el @param {Dupe} d */
const rowFor = (el, d) => { const re = /** @type {HTMLElement} */ (el.closest(".drow")); return rowsOf(d).find(r => r.pid === re.dataset.pid && r.videoId === re.dataset.vid) || null; };
/** @param {HTMLButtonElement} btn @param {() => Promise<void>} fn */
async function busy(btn, fn) { btn.disabled = true; try { await fn(); } catch (e) { btn.disabled = false; toast("Could not do that: " + /** @type {Error} */ (e).message, true); } }

/** Every click on the two lists: the row buttons, the song's own actions, and "show more". @param {MouseEvent} e */
async function onClick(e) {
  const t = /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (e.target).closest("button[data-act], button[data-fix], button[data-swap], button[data-drop], button[data-find], button[data-use]")); if (!t) return;
  if (t.dataset.swap || t.dataset.drop || t.dataset.use) { swapOne(/** @type {HTMLButtonElement} */ (t)); return; }
  if (t.dataset.find) { findOne(/** @type {HTMLButtonElement} */ (t)); return; }
  if (t.dataset.act === "preview") { previewHere(t); return; }
  if (t.dataset.act === "more") { state.dupePage++; renderDupes(false); return; }
  const d = itemFor(t); if (!d) return;
  const btn = /** @type {HTMLButtonElement} */ (t);
  if (t.dataset.fix) {
    const r = rowFor(t, d); if (!r) return;
    const extra = t.dataset.fix === "extra";
    const units = READ + WRITE * (extra ? r.copies - 1 : r.copies);
    if (!affordable(units)) return;
    if (!confirm(extra ? `Remove the extra ${r.copies - 1 === 1 ? "copy" : `${r.copies - 1} copies`} of “${who(d, r)}” in ${titleFor(r.year)}? One stays. (${units} quota units)` : `Remove “${who(d, r)}” from ${titleFor(r.year)}?${r.copies > 1 ? ` All ${r.copies} copies go.` : ""} (${units} quota units)`)) return;
    await busy(btn, async () => {
      const n = await removeRow(d, r, extra, extra ? `Cleanup: remove the extra copy of a song added twice to “${titleFor(r.year)}” (one copy stays)` : `Cleanup: remove this copy of the song from “${titleFor(r.year)}”`);
      toast(n ? `Removed ${n} · ${who(d, r)}` : "Nothing to remove — already cleaned up");
      refreshItem(d);
    });
    return;
  }
  switch (t.dataset.act) {
    case "play": { playHere(d, t); break; }
    case "details": { await busy(btn, async () => { await videoDetails(rowsOf(d).map(r => r.videoId), { detail: `${d.artist} - ${d.title}` }); refreshItem(d); afterChange(); }); break; }
    case "ok": { mark(`${d.key}|ok`); toast(`Dismissed · ${d.artist} - ${d.title}`, false, { label: "Undo", fn: () => { unmark(`${d.key}|ok`); renderDupes(false); } }); refreshItem(d); break; }
    case "reopen": { unmark(`${d.key}|ok`); refreshItem(d); break; }
    case "keep": {
      const el = /** @type {HTMLElement} */ (t.closest(".dupe")); const chosen = /** @type {HTMLInputElement | null} */ ($(".keep:checked", el)); if (!chosen) return;
      const keepRow = rowFor(chosen, d); if (!keepRow) return;
      const others = rowsOf(d).filter(r => r !== keepRow && !(r.pid === keepRow.pid && r.videoId === keepRow.videoId));
      const units = others.reduce((n, r) => n + READ + WRITE * r.copies, 0) + (keepRow.copies > 1 ? READ + WRITE * (keepRow.copies - 1) : 0);
      if (!affordable(units)) return;
      if (!confirm(`Keep “${who(d, keepRow)}” in ${titleFor(keepRow.year)} and remove the other ${others.length === 1 ? "copy" : `${others.length} copies`} (${others.map(r => `${r.year}: ${r.label || EDITION_NAME[r.edition]}`).join(", ")})?${keepRow.copies > 1 ? " Its own extra copies go too." : ""} (${units} quota units)`)) return;
      await busy(btn, async () => {
        let n = 0;
        for (const r of others) { btn.textContent = `removing… ${n + 1}/${others.length}`; n += await removeRow(d, r, false, `Cleanup: remove this copy, keeping the chosen one in “${titleFor(keepRow.year)}”`); }
        if (keepRow.copies > 1) n += await removeRow(d, keepRow, true, `Cleanup: remove the extra copy of the chosen upload in “${titleFor(keepRow.year)}” (one copy stays)`);
        toast(`Kept one · removed ${n} · ${d.artist} - ${d.title}`);
        refreshItem(d);
      });
      break;
    }
    case "moveall": {
      const rows = rowsOf(d); const year = String(d.verified_year || ""); const units = moveAllCost(rows);
      if (!affordable(units)) return;
      if (!confirm(`Move every copy of “${d.artist} - ${d.title}” to ${titleFor(year)} — ${new Set(rows.map(r => r.videoId)).size} upload${new Set(rows.map(r => r.videoId)).size === 1 ? "" : "s"} added there (unless already in), ${rows.length} cop${rows.length === 1 ? "y" : "ies"} taken out of ${[...new Set(rows.map(r => titleFor(r.year)))].join(", ")}? (≈${units} quota units)`)) return;
      await busy(btn, async () => {
        let n = 0;
        for (const [i, r] of rows.entries()) { btn.textContent = `moving… ${i + 1}/${rows.length}`; n += await moveRow(d, r, year); }
        toast(`Moved to ${year} · ${d.artist} - ${d.title} (${n} removed from the wrong year${n === 1 ? "" : "s"})`);
        refreshItem(d);
      });
      break;
    }
  }
}
/** The keep radios enable the song's keep button; the move menus move a copy. @param {Event} e */
async function onChange(e) {
  const t = /** @type {HTMLElement} */ (e.target);
  if (t.classList.contains("keep")) { const el = /** @type {HTMLElement} */ (t.closest(".dupe")); const b = /** @type {HTMLButtonElement} */ ($("button[data-act=keep]", el)); if (b) { b.disabled = false; b.title = ""; } return; }
  if (!t.classList.contains("dmove")) return;
  const sel = /** @type {HTMLSelectElement} */ (t); const year = sel.value; if (!year) return;
  const d = itemFor(sel); const r = d && rowFor(sel, d); if (!d || !r) { sel.value = ""; return; }
  const units = READ + WRITE + READ + WRITE * r.copies;
  if (!affordable(units)) { sel.value = ""; return; }
  if (!confirm(`Move “${who(d, r)}” from ${titleFor(r.year)} to ${titleFor(year)}?${d.verified_year && String(d.verified_year) === year ? " (the year the catalogues verified)" : d.verified_year ? ` The catalogues say ${d.verified_year}.` : ""} (≈${units} quota units: one add, ${r.copies} removal${r.copies === 1 ? "" : "s"})`)) { sel.value = ""; return; }
  sel.disabled = true;
  try { await moveRow(d, r, year); toast(`Moved to ${year} · ${who(d, r)}`); refreshItem(d); }
  catch (err) { sel.disabled = false; sel.value = ""; toast("Could not move: " + /** @type {Error} */ (err).message, true); }
}
/** Play a copy inside its song, so two uploads can be heard back to back without leaving the tab. @param {Dupe} d @param {HTMLElement} btn */
function playHere(d, btn) {
  const row = /** @type {HTMLElement} */ (btn.closest(".drow")); const vid = row.dataset.vid || "";
  embed(/** @type {HTMLElement} */ (btn.closest(".dupe")), row, vid, who(d, rowsOf(d).find(r => r.videoId === vid) || rowsOf(d)[0]), "play");
}
/** A replacement the search found, heard before it is used. @param {HTMLElement} btn */
function previewHere(btn) { const row = /** @type {HTMLElement} */ (btn.closest(".dalt")); embed(/** @type {HTMLElement} */ (btn.closest(".dupe")), row, row.dataset.vid || "", $(".dtitle", row)?.textContent || "", "preview"); }
/** One embedded player at a time, under the song it belongs to; a second tap on the same copy closes it.
 * @param {HTMLElement} el @param {HTMLElement} row @param {string} vid @param {string} title @param {string} act */
function embed(el, row, vid, title, act) {
  let slot = $(".dupe-player", el);
  if (!slot) { slot = document.createElement("div"); slot.className = "dupe-player"; slot.hidden = true; el.appendChild(slot); }
  const same = slot.dataset.vid === vid && !slot.hidden;
  $$(".dupe-player").forEach(p => { if (p !== slot || same) { p.innerHTML = ""; p.hidden = true; delete p.dataset.vid; } });
  $$(".drow.playing, .dalt.playing").forEach(r => r.classList.remove("playing"));
  if (same) return;
  if (playerActive()) stopPlayer();
  slot.dataset.vid = vid; slot.hidden = false; row.classList.add("playing");
  slot.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${esc(vid)}?autoplay=1&rel=0&playsinline=1" title="${esc(title)}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="eager"></iframe><button class="btn ghost small" type="button" data-act="${act}" title="close">✕ close</button>`;
  slot.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// ------------------------------------------------------------------ bulk
export async function bulkFix() {
  const f = filters(); const bulk = $("#cl-dupe-bulk");
  if (f.kind === "unavailable") { bulkSwap(); return; }
  if (!f.year) return;
  /** @type {{ d: Dupe, r: Row, op: "trim" | "remove" | "move" }[]} */ const todo = [];
  for (const { d, v } of filteredDupes()) for (const r of v.rows) {
    if (r.year !== f.year) continue;
    if (f.kind === "same-video" && r.copies > 1) todo.push({ d, r, op: "trim" });
    // a wrong-year copy goes when the verified year already has this edition, and moves there when it does not
    else if (f.kind === "wrong-year" && wrongYear(d, r)) todo.push({ d, r, op: v.rows.some(o => o.year === String(d.verified_year) && o.edition === r.edition) ? "remove" : "move" });
  }
  if (!todo.length) return;
  const cost = (/** @type {typeof todo[0]} */ t) => t.op === "trim" ? READ + WRITE * (t.r.copies - 1) : t.op === "remove" ? READ + WRITE * t.r.copies : READ + WRITE + READ + WRITE * t.r.copies;
  let units = 0; const doable = []; for (const t of todo) { if (units + cost(t) > quotaLeft() - RESERVE) break; units += cost(t); doable.push(t); }
  if (!doable.length) { toast("Not enough YouTube quota left today for a bulk clean-up — try after midnight Pacific", true); return; }
  const what = f.kind === "same-video" ? `Remove the extra copies of ${doable.length} songs in ${titleFor(f.year)}? One copy of each stays.` : `Fix ${doable.length} wrong-year copies in ${titleFor(f.year)}: ${doable.filter(t => t.op === "remove").length} removed (the verified year already has them), ${doable.filter(t => t.op === "move").length} moved to their verified year?`;
  if (!confirm(`${what}${doable.length < todo.length ? ` (${todo.length - doable.length} more when quota allows)` : ""}\nCost ≈ ${units} of ${quotaLeft()} quota units left today.`)) return;
  bulk.disabled = true;
  let done = 0, failed = 0;
  for (const [i, t] of doable.entries()) {
    bulk.textContent = `${t.op === "move" ? "moving" : "removing"}… ${i + 1}/${doable.length}`;
    try {
      if (t.op === "trim") await removeRow(t.d, t.r, true, `Cleanup: remove the extra copy of a song added twice to “${titleFor(f.year)}” (one copy stays)`);
      else if (t.op === "remove") await removeRow(t.d, t.r, false, `Cleanup: remove the copy filed in the wrong year from “${titleFor(f.year)}” (the verified year already holds the song)`);
      else await moveRow(t.d, t.r, String(t.d.verified_year));
      done++;
    } catch (e) { failed++; if (/quota/i.test(/** @type {Error} */ (e).message)) break; }
  }
  bulk.disabled = false;
  toast(`${f.kind === "same-video" ? "Trimmed" : "Fixed"} ${done}${failed ? ` · ${failed} failed` : ""}`);
  renderDupes(false);
}

// ------------------------------------------------------------------ not streamable here
/** @param {string} key */
const unavFor = key => unavailableRows().find(x => unavKey(x) === key) || null;
/** Add the upload that plays here to the playlist, then take out the dead copy (or just take it out). `use` names a
 * replacement the search found; without it the build's counterpart is used. @param {HTMLButtonElement} btn */
async function swapOne(btn) {
  const el = /** @type {HTMLElement} */ (btn.closest(".dupe")); const key = el.dataset.key || "";
  const u = unavFor(key); if (!u) return;
  const use = btn.dataset.use || (btn.dataset.swap && u.alt ? u.alt.videoId : "");
  const name = u.artist || u.title ? `${u.artist} - ${u.title}` : `the dead row #${(u.position || 0) + 1}`;
  const units = (use ? READ + WRITE : 0) + (u.itemId ? WRITE : READ + WRITE);
  if (!affordable(units)) return;
  if (!confirm(use ? `Swap “${name}” in ${titleFor(u.year)} for the upload that plays here? (${units} quota units: one add, one removal)` : `Remove the dead copy of “${name}” from ${titleFor(u.year)}? (${units} quota units)`)) return;
  btn.disabled = true;
  try {
    const n = await swapTrack(u, use);
    mark(key); auditDrop(u.playlistId, u.videoId);
    toast(use ? `Swapped · ${name} → ${titleFor(u.year)}` : `Removed ${n} · ${name}`);
    renderDupes(false);
  } catch (e) { btn.disabled = false; toast("Could not swap: " + /** @type {Error} */ (e).message, true); }
}
/** @param {Unavailable} u @param {string} use the upload to add first, if any @returns {Promise<number>} removed copies */
async function swapTrack(u, use) {
  const detail = u.artist || u.title ? `${u.artist} - ${u.title}` : `dead row #${(u.position || 0) + 1} of ${titleFor(u.year)}`;
  if (use) {
    const present = await playlistItemsFor(u.playlistId, use, { why: `Cleanup: verify “${titleFor(u.year)}” does not already hold the upload that plays here`, detail });
    if (!present.length) await addToPlaylist(u.playlistId, use, { why: `Cleanup: add the upload of this song that plays here to “${titleFor(u.year)}”`, detail });   // never a second copy of the good one
  }
  // the audit read the playlist itself and knows the row; the build's report needs one lookup first
  const ids = u.itemId ? [u.itemId] : await playlistItemsFor(u.playlistId, u.videoId, { why: "Cleanup: verify which playlist items hold this video before removing any", detail });
  for (const i of ids) await removePlaylistItem(i, { why: `Cleanup: remove the copy that will not play here from “${titleFor(u.year)}”`, detail });
  return ids.length;
}
/** One search (100 units) for other uploads of a dead track, checked to play here, offered under the row. @param {HTMLButtonElement} btn */
async function findOne(btn) {
  const el = /** @type {HTMLElement} */ (btn.closest(".dupe")); const key = el.dataset.key || "";
  const u = unavFor(key); if (!u) return;
  const typed = /** @type {HTMLInputElement | null} */ ($(".dsearch input", el)); let artist = u.artist, title = u.title;
  if (typed) { const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(typed.value.trim()); if (!m) { toast("Type it as artist - title first", true); typed.focus(); return; } artist = m[1].trim(); title = m[2].trim(); }
  if (!affordable(101)) return;
  if (!confirm(`Search YouTube for another upload of “${artist} - ${title}” that plays in ${region()}? (101 quota units)`)) return;
  await busy(btn, async () => {
    const found = await findReplacements(artist, title, u.videoId);
    const box = $(".dalts", el); box.hidden = false;
    box.innerHTML = found.length ? `<span class="muted">${found.length} upload${found.length === 1 ? "" : "s"} that play here — the audio track first:</span>` + found.map(r => altHtml(r, u)).join("") : `<span class="muted">nothing on YouTube plays here under that name — try another spelling, or remove the dead copy</span>`;
    btn.disabled = false;
  });
}
export async function bulkSwap() {
  const f = filters(); const list = unavailableRows().filter(unavOpen).filter(u => u.alt && u.year === f.year);
  const afford = Math.max(0, Math.floor((quotaLeft() - RESERVE) / (READ + WRITE + READ + WRITE)));
  const todo = list.slice(0, Math.min(list.length, afford));
  if (!todo.length) { toast("Not enough YouTube quota left today for a bulk swap — try after midnight Pacific", true); return; }
  if (!confirm(`Swap ${todo.length} dead tracks in ${titleFor(f.year)} for streamable uploads${todo.length < list.length ? ` (${list.length - todo.length} more when quota allows)` : ""}?\nCost ≈ ${todo.length * 102} of ${quotaLeft()} quota units left today.`)) return;
  const bulk = $("#cl-dupe-bulk"); bulk.disabled = true;
  let done = 0, failed = 0;
  for (const [i, u] of todo.entries()) {
    bulk.textContent = `swapping… ${i + 1}/${todo.length}`;
    try { await swapTrack(u, u.alt ? u.alt.videoId : ""); mark(unavKey(u)); auditDrop(u.playlistId, u.videoId); done++; }
    catch (e) { failed++; if (/quota/i.test(/** @type {Error} */ (e).message)) break; }
  }
  bulk.disabled = false;
  toast(`Swapped ${done}${failed ? ` · ${failed} failed` : ""}`);
  renderDupes(false);
}

// ------------------------------------------------------------------ live scan of one year
/** Read one year playlist as it is right now (1 unit per 50 tracks) and group it by song, the same way the daily
 * build does: catches today's double-taps and second uploads before the nightly report. @param {number} year */
export async function scanYear(year) {
  const pid = knownYear(year) || state.playlists[String(year)]; if (!pid) throw new Error("no playlist id for " + year);
  const status = $("#cl-dupe-status"); status.textContent = "scanning…";
  /** @type {(DupeEntry & { artist: string })[]} */ const rows = []; let pageToken, n = 0, pages = 0;
  do {
    const j = await yt("GET", "/playlistItems", { params: { part: "snippet", playlistId: pid, maxResults: 50, pageToken }, why: `Cleanup: scan “${titleFor(year)}” as it is right now for songs it holds more than once`, detail: pages ? `page ${pages + 1}` : undefined });
    for (const it of j.items || []) {
      n++;
      const sn = it.snippet || {}; const v = sn.resourceId && sn.resourceId.videoId; if (!v) continue;
      const { artist, title, topic } = creditOf(sn); const ed = editionOf(title);
      rows.push({ year: String(year), playlistId: pid, videoId: v, position: sn.position ?? n - 1, title, edition: ed.edition, label: ed.label, itemIds: [it.id], videoType: topic ? "MUSIC_VIDEO_TYPE_ATV" : null, artist });
    }
    pageToken = j.nextPageToken;
  } while (pageToken && ++pages < 100);
  /** @type {Map<string, Dupe>} */ const songs = new Map();
  for (const r of rows) {
    const k = "live:" + songKey(r.artist || "", r.title || "");
    let d = songs.get(k);
    if (!d) { d = { key: k, artist: r.artist || "", title: editionOf(r.title).core, kind: "", kinds: [], years: [String(year)], count: 0, entries: [], live: true }; songs.set(k, d); }
    if (r.edition === "original" && (r.title || "").length < (d.title.length + 1)) d.title = editionOf(r.title).core;
    d.count++; d.entries.push(r);
  }
  const items = [...songs.values()].filter(d => kindsOf(rowsOf(d)).length).map(d => { d.kinds = kindsOf(rowsOf(d)); d.kind = d.kinds[0]; return d; });
  items.sort((a, b) => KIND_ORDER.indexOf(/** @type {string[]} */ (a.kinds)[0]) - KIND_ORDER.indexOf(/** @type {string[]} */ (b.kinds)[0]) || a.artist.localeCompare(b.artist));
  state.liveDupes = items; state.liveYear = String(year);
  status.textContent = `${n} tracks in ${titleFor(year)} · ${items.length} song${items.length === 1 ? "" : "s"} held more than once (${Math.ceil(n / 50) || 1} unit${n > 50 ? "s" : ""})`;
  const box = $("#cl-dupes-live");
  if (!items.length) { box.innerHTML = `<span class="muted">No duplicates in ${esc(titleFor(year))} 🎉</span>`; return; }
  renderItems(box, items.map(d => ({ d, v: viewOf(d) })), items.length);
}

/** The tab's controls, wired once. */
export function wireCleanup() {
  $("#cl-dupes").addEventListener("click", onClick); $("#cl-dupes").addEventListener("change", onChange);
  $("#cl-dupes-live").addEventListener("click", onClick); $("#cl-dupes-live").addEventListener("change", onChange);
  $("#cl-dupe-scan").addEventListener("click", () => scanYear(+$("#cl-dupe-year").value).catch(e => { $("#cl-dupe-status").textContent = ""; toast(e.message, true); }));
  ["#cl-dupe-kind", "#cl-dupe-yr", "#cl-dupe-sort"].forEach(id => $(id).addEventListener("change", () => renderDupes()));
  $("#cl-dupe-q").addEventListener("input", () => { clearTimeout(state.dupeQT); state.dupeQT = setTimeout(() => renderDupes(), 200); });
  $("#cl-dupe-bulk").addEventListener("click", bulkFix);
  $("#cl-dupe-lookup").addEventListener("click", async () => {
    const b = /** @type {HTMLButtonElement} */ ($("#cl-dupe-lookup"));
    const vids = [...new Set(filteredDupes().slice(0, PAGE * state.dupePage).flatMap(x => x.v.rows.map(r => r.videoId)))];
    await busy(b, async () => { await videoDetails(vids, { detail: `${vids.length} copies shown on the Cleanup tab` }); renderDupes(false); });
  });
  const status = $("#cl-audit-status"); const one = /** @type {HTMLButtonElement} */ ($("#cl-audit-one")); const all = /** @type {HTMLButtonElement} */ ($("#cl-audit-all"));
  const costNote = () => { const y = $("#cl-audit-year").value; const c = auditCost(y); one.textContent = `Audit ${y}${c ? ` (≈${c} units)` : ""}`; };
  $("#cl-audit-year").addEventListener("change", costNote);
  const showUnavailable = () => { $("#cl-dupe-kind").value = "unavailable"; renderDupes(); };
  one.addEventListener("click", async () => {
    const y = $("#cl-audit-year").value; if (!y) return;
    const c = auditCost(y); if (c && !affordable(c)) return;
    one.disabled = all.disabled = true;
    try { const r = await auditYear(y, m => { status.textContent = m; }); status.textContent = `${titleFor(y)}: ${r.tracks} tracks, ${r.dead.length} cannot play in ${region()} (${r.units} units)`; toast(r.dead.length ? `${r.dead.length} unplayable in ${y} — listed under “not streamable here”` : `Everything in ${y} plays here 🎉`, false, r.dead.length ? { label: "Show", fn: showUnavailable } : undefined); }
    catch (e) { status.textContent = ""; toast(/** @type {Error} */ (e).message, true); }
    one.disabled = all.disabled = false; afterChange(); renderAudit(); if ($("#cl-dupe-kind").value === "unavailable") renderDupes(false);
  });
  all.addEventListener("click", async () => {
    if (!confirm(`Audit every year playlist not checked in the last day? About 2 units per 50 tracks — a whole library of 25,000 tracks is around 1,000 of today's ${quotaLeft()} left. It stops by itself when the quota runs low and picks up the rest another day.`)) return;
    one.disabled = all.disabled = true;
    const r = await auditAll(m => { status.textContent = m; });
    status.textContent = `${r.done} year${r.done === 1 ? "" : "s"} audited${r.skipped ? `, ${r.skipped} checked in the last day` : ""} · ${r.found} track${r.found === 1 ? "" : "s"} cannot play in ${region()}`;
    one.disabled = all.disabled = false; afterChange(); renderAudit(); if ($("#cl-dupe-kind").value === "unavailable") renderDupes(false);
    if (r.found) toast(`${r.found} unplayable tracks found — listed under “not streamable here”`, false, { label: "Show", fn: showUnavailable });
  });
  window.setTimeout(costNote, 0);
}
