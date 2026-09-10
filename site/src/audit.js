// @ts-check
/* The playability audit: which tracks in a year playlist cannot play in the region the playlists are listened to
 * in (the US), by asking YouTube itself. The daily build's scan reads the playlists through YouTube Music, which
 * drops deleted and private videos silently and only greys out what a label withdrew, so it never sees a track
 * the uploader took down. This audit reads the playlist through the Data API (1 unit per 50 rows), then asks
 * videos.list about every video in it (1 unit per 50): a video the answer leaves out is deleted or private, one
 * whose regionRestriction excludes the region is blocked, one whose upload was rejected is dead. About 2 units per
 * 50 tracks, so a 1,800-track year costs 72 and the whole library fits in a day's quota.
 *
 * Findings are kept on this device (id:audit), listed under "not streamable here" on the Cleanup tab, and pushed
 * to the build with the ratings file (github.js: `unplayable`), so the next build searches for a playable upload
 * of each — free — and the tab can swap it in. A replacement can also be found now, from the tab, with one
 * search.list call (100 units). */
import { state, LS, quotaLeft, allItems } from "./state.js";
import { $, esc, relTime, toast } from "./dom.js";
import { yt, titleFor, knownYear, videoDetails } from "./youtube.js";
import { editionOf } from "./editions.js";

/** @typedef {import("./types").AuditRow} AuditRow */
/** @typedef {import("./types").Audit} Audit */

/** @returns {Audit} */
export const audit = () => { if (!state.audit) state.audit = /** @type {Audit} */ (LS.get("id:audit", { years: {} })); return state.audit; };
function save() { LS.set("id:audit", audit()); }
export const region = () => (state.feed?.youtube && state.feed.youtube.region) || "US";
/** @type {Record<string, string>} */
export const WHY = { deleted: "deleted video", private: "private video", blocked: "blocked here", rejected: "upload rejected", dead: "not playable" };

/** Every playable-here failure found so far, newest year first. @returns {AuditRow[]} */
export function auditRows() { return Object.values(audit().years).flatMap(y => y.dead).sort((a, b) => b.year.localeCompare(a.year) || (a.position - b.position)); }
/** What the site knows a video is, from the cards it showed and the keeps it filed — the only name a deleted video still has. @param {string} vid */
export function knownTrack(vid) {
  for (const it of allItems()) if (it.youtube && it.youtube.videoId === vid) return { artist: it.artist, title: it.title };
  for (const r of Object.values(state.rated)) if (r.videoId === vid && r.artist) return { artist: r.artist, title: r.title || "" };
  for (const p of state.feed?.picks || []) if (p.videoId === vid) return { artist: p.artist, title: p.title };
  return null;
}
/** The (artist, title) a playlist row names: the audio track's channel is "Artist - Topic", a video's title carries the credit. @param {any} sn */
export function creditOf(sn) {
  const channel = String(sn.videoOwnerChannelTitle || ""); const topic = /\s-\sTopic$/.test(channel);
  let artist = channel.replace(/\s*-\s*Topic$/i, ""), title = String(sn.title || "");
  if (!topic) { const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(title); if (m) { artist = m[1].trim(); title = m[2].trim(); } }
  return { artist, title, topic };
}

/** Audit one year: the playlist as it is now, every video checked with YouTube. @param {number | string} year @param {(msg: string) => void} [progress] */
export async function auditYear(year, progress = () => {}) {
  year = String(year);
  const pid = knownYear(year) || state.playlists[year]; if (!pid) throw new Error("no playlist id for " + year);
  /** @type {{ itemId: string, videoId: string, position: number, title: string, artist: string, hint: string }[]} */ const rows = [];
  let pageToken, pages = 0;
  do {
    progress(`${titleFor(year)}: reading page ${pages + 1}…`);
    const j = await yt("GET", "/playlistItems", { params: { part: "snippet", playlistId: pid, maxResults: 50, pageToken }, why: `Audit: read “${titleFor(year)}” to check which of its tracks can play in ${region()}`, detail: pages ? `page ${pages + 1}` : undefined });
    for (const it of j.items || []) {
      const sn = it.snippet || {}; const v = sn.resourceId && sn.resourceId.videoId; if (!v) continue;
      const c = creditOf(sn); const t = String(sn.title || "");
      rows.push({ itemId: it.id, videoId: v, position: sn.position ?? rows.length, title: c.title, artist: c.artist, hint: /^private video$/i.test(t) ? "private" : /^deleted video$/i.test(t) ? "deleted" : "" });
    }
    pageToken = j.nextPageToken;
  } while (pageToken && ++pages < 100);
  progress(`${titleFor(year)}: checking ${rows.length} videos with YouTube…`);
  const info = await videoDetails(rows.map(r => r.videoId), { why: `Audit: ask YouTube whether the tracks of “${titleFor(year)}” can play in ${region()} (deleted, private, blocked)`, detail: `${rows.length} videos` }, true);
  /** @type {AuditRow[]} */ const dead = [];
  for (const r of rows) {
    const i = info[r.videoId]; if (!i) continue;
    const why = i.missing ? (r.hint || "deleted") : i.blocked ? "blocked" : i.rejected ? "rejected" : "";
    if (!why) continue;
    // a deleted video has no name left on YouTube: the site's own records may still know it
    const known = i.missing ? knownTrack(r.videoId) : null;
    const title = i.missing ? (known ? known.title : "") : (i.title && !i.topic ? creditOf({ title: i.title, videoOwnerChannelTitle: i.channel }).title : r.title);
    const artist = i.missing ? (known ? known.artist : "") : (i.topic ? i.channel.replace(/\s*-\s*Topic$/i, "") : creditOf({ title: i.title, videoOwnerChannelTitle: i.channel }).artist || r.artist);
    dead.push({ year, playlistId: pid, videoId: r.videoId, itemId: r.itemId, position: r.position, artist, title: editionOf(title).core ? title : "", why, at: Date.now() });
  }
  audit().years[year] = { at: Date.now(), tracks: rows.length, dead, units: Math.ceil(rows.length / 50) * 2 || 1 };
  save();
  return audit().years[year];
}
/** Audit every year with a pinned playlist, skipping the ones done in the last day; stops when the quota runs dry. @param {(msg: string) => void} progress */
export async function auditAll(progress) {
  const years = (state._years || []).map(String).filter(y => knownYear(y) || state.playlists[y]);
  let done = 0, skipped = 0, found = 0;
  for (const y of years) {
    const prev = audit().years[y];
    if (prev && Date.now() - prev.at < 24 * 3600e3) { skipped++; continue; }
    if (quotaLeft() < 200) { toast(`Stopped before ${y}: YouTube quota nearly used up for today — the rest tomorrow`, true); break; }
    try { const r = await auditYear(y, progress); done++; found += r.dead.length; }
    catch (e) { toast(`${y}: ${/** @type {Error} */ (e).message}`, true); if (/quota/i.test(/** @type {Error} */ (e).message)) break; }
  }
  return { done, skipped, found };
}
/** Forget a finding once the row is gone from the playlist (swapped or removed). @param {string} playlistId @param {string} videoId */
export function auditDrop(playlistId, videoId) {
  for (const y of Object.values(audit().years)) { const n = y.dead.length; y.dead = y.dead.filter(r => !(r.playlistId === playlistId && r.videoId === videoId)); if (y.dead.length !== n) save(); }
}
/** Estimated cost of auditing a year: two reads per 50 tracks (the catalog knows the playlist sizes). @param {string} year */
export function auditCost(year) { const n = state.catalog?.years?.[year]?.playlist || audit().years[year]?.tracks || 0; return n ? Math.ceil(n / 50) * 2 : null; }
/** The audit's own summary lines under the Cleanup tab. */
export function renderAudit() {
  const box = $("#cl-audit-done"); if (!box) return;
  const ys = Object.entries(audit().years).sort((a, b) => b[0].localeCompare(a[0]));
  const total = ys.reduce((n, [, y]) => n + y.dead.length, 0);
  $("#cl-audit-summary").textContent = ys.length ? `${ys.length} year${ys.length === 1 ? "" : "s"} audited on this device · ${total} track${total === 1 ? "" : "s"} cannot play in ${region()}` : `Nothing audited on this device yet.`;
  box.innerHTML = ys.map(([y, r]) => `<span class="${r.dead.length ? "dead" : "ok"}" title="${r.tracks} tracks · ${r.units} units · ${new Date(r.at).toLocaleString()}">${esc(y)} ${r.dead.length ? r.dead.length + " ✗" : "✓"} <i>${esc(relTime(new Date(r.at)))}</i></span>`).join("");
}

/** Other uploads of the song that can play here, from one search.list call (100 units) checked with videos.list (1 unit).
 * @param {string} artist @param {string} title @param {string} avoid @returns {Promise<import("./types").Replacement[]>} */
export async function findReplacements(artist, title, avoid) {
  const q = `${artist} ${editionOf(title).core}`.trim();
  const j = await yt("GET", "/search", { params: { part: "snippet", q, type: "video", videoCategoryId: "10", maxResults: 8, regionCode: region(), safeSearch: "none" }, why: `Cleanup: search YouTube for another upload of a track that cannot play in ${region()} (100 units)`, detail: q });
  const ids = (j.items || []).map((/** @type {any} */ it) => it.id && it.id.videoId).filter((/** @type {string} */ v) => v && v !== avoid);
  if (!ids.length) return [];
  const info = await videoDetails(ids, { why: "Cleanup: check the search results can play here and what they are (length, channel, views)", detail: q });
  return ids.map(v => ({ videoId: v, ...info[v] })).filter(r => !r.missing && !r.blocked)
    // the audio track first, then the official channel, then by plays
    .sort((a, b) => Number(b.topic) - Number(a.topic) || Number(/vevo|official/i.test(b.channel)) - Number(/vevo|official/i.test(a.channel)) || (b.views || 0) - (a.views || 0));
}
