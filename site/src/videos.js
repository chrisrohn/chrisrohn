// @ts-check
/* The Video tab: the official videos of the songs the library holds, reviewed one by one for the music-video playlist.
 *
 * The year playlists hold audio tracks; YouTube Music pairs most of them with an official video. Two things put a
 * video here: a song kept on the site whose card knows its video side (`youtube.video`, from the resolver — a Keep
 * brings the video the same day), and every row of every year playlist whose video the Videos workflow has found
 * (discovery/videos.py → data/videos.json, a batch a day until the whole library is asked). One video is one row
 * however many years hold the song. ▶ plays the video in place; ▲︎ adds it to the one music-video playlist
 * (feed.json → youtube.videos_playlist_id; 50 units, plus 1 to verify it is not there already unless the playlist
 * was read a moment ago); ▼︎ passes on it for free. Decisions are remembered per account (id:videos), mirrored
 * across devices with the ratings, and pushed to the build in the ratings file (`videos`), so the next report
 * leaves them out; the playlist itself is read (1 unit per 50 videos, at most every half hour) so what another
 * device or YouTube Music itself added is hidden too. */
import { state, persist, allItems, decisionFor, quotaLeft, quotaText } from "./state.js";
import { $, $$, esc, relTime, toast } from "./dom.js";
import { isCurator, isOwner, tokenValid, ensureToken, needSignIn } from "./auth.js";
import { yt, titleFor, addToPlaylist, removePlaylistItem, playlistItemsFor } from "./youtube.js";
import { schedulePush } from "./sync.js";
import { stopPlayer, playerActive } from "./player.js";
import { openArtist } from "./artist.js";

/** @typedef {import("./types").VideoRow} VideoRow */
/** @typedef {import("./types").VideoMark} VideoMark */

const PAGE = 40;
const READ = 1, WRITE = 50;
const RESERVE = 500;                  // quota kept back for the day's keeps
const HELD_EVERY_MS = 30 * 60e3;      // the music-video playlist is read again after this
const UP = "▲︎", DN = "▼︎";
/** @type {Record<string, string>} */
const KIND = { MUSIC_VIDEO_TYPE_OMV: "official video", MUSIC_VIDEO_TYPE_UGC: "upload", MUSIC_VIDEO_TYPE_OFFICIAL_SOURCE_MUSIC: "official upload", MUSIC_VIDEO_TYPE_PRIVATELY_OWNED_TRACK: "private upload" };

export const videosPlaylist = () => (state.feed?.youtube && state.feed.youtube.videos_playlist_id) || "";
export const VIDEOS_TITLE = "the music-video playlist";
export const videosLoaded = () => state.videos != null;

/* ---- loading ---- */
export async function loadVideos(force = false) {
  if (state.videosState === "loading" || (state.videosState === "ready" && !force)) return;
  state.videosState = "loading";
  try {
    const r = await fetch("data/videos.json", { cache: "no-cache" });
    if (r.status === 404) { state.videos = { generated_at: "", playlist_id: "", count: 0, pending: 0, rows: [] }; state.videosState = "missing"; }
    else {
      if (!r.ok) throw new Error("videos.json " + r.status);
      const v = await r.json();
      if (v.generated_at !== state.videos?.generated_at) { state.videos = v; memo.clear(); }
      state.videosState = "ready";
    }
  } catch (e) { state.videosState = "failed"; state.videos = state.videos || { generated_at: "", playlist_id: "", count: 0, pending: 0, rows: [] }; toast("Could not load the video list: " + /** @type {Error} */ (e).message, true); }
  import("./render.js").then(m => m.render()).catch(() => {});
  if (state.view === "videos" && isCurator() && tokenValid()) refreshHeld().catch(() => {});
}

/* ---- decisions (per account, synced) ---- */
/** @param {string} video */
export const videoMark = video => { const m = state.videoMarks[video]; return m && m.decision !== "undone" ? m : null; };
/** @param {string} video @param {VideoMark | null} m */
function setMark(video, m) { if (m) state.videoMarks[video] = m; else delete state.videoMarks[video]; state.videoVersion++; memo.clear(); persist(); }
/** Decisions that have outlived their purpose: undo tombstones after a month, optimistic entries whose request never came back. */
export function reconcileVideos() {
  const now = Date.now(); let changed = false;
  for (const [v, m] of Object.entries(state.videoMarks)) {
    if ((m.decision === "undone" && now - (m.at || 0) > 30 * 86400e3) || (m.pending && now - (m.at || 0) > 10 * 60e3)) { delete state.videoMarks[v]; changed = true; }
  }
  if (changed) { state.videoVersion++; memo.clear(); }
}

/* ---- the rows ---- */
/** @type {Map<string, VideoRow[]>} */
const memo = new Map();
/** Every video still to review: the library's report plus the songs kept on this account whose card knows its video,
 * one row per video, minus what is decided or already in the playlist. @returns {VideoRow[]} */
export function videoRows() {
  const key = `${state.videos?.generated_at || ""}|${state.feed?.generated_at || ""}|${state.catalog?.generated_at || ""}|${state.ratedVersion}|${state.videoVersion}|${state.mvAt}`;
  const hit = memo.get(key); if (hit) return hit;
  /** @type {Map<string, VideoRow>} */ const m = new Map();
  for (const r of (state.videos && state.videos.rows) || []) m.set(r.video, { ...r, from: "library" });
  for (const it of allItems()) {
    const v = it.youtube && it.youtube.video; if (!v) continue;
    const d = decisionFor(it.id); if (!d || d.decision !== "up") continue;   // only an approved song brings its video
    if (m.has(v)) continue;
    const year = String(d.year || it.year || "");
    m.set(v, { video: v, kind: it.youtube?.videoKind || null, own: false, videoId: it.youtube?.videoId || "", year, years: year ? [year] : [], playlistId: null, position: null,
      artist: it.artist, title: it.display_title || it.title, album: it.release || null, from: "feed", id: it.id, at: d.at || 0 });
  }
  const held = state.mvHeld;
  const out = [...m.values()].filter(r => !videoMark(r.video) && !(held && held.has(r.video)));
  if (memo.size > 6) memo.delete(/** @type {string} */ (memo.keys().next().value));
  memo.set(key, out);
  return out;
}
/** What the pill shows: every video still to review, or "…" before the report is in. */
export const videosCount = () => (isCurator() ? (videosLoaded() ? videoRows().length : null) : 0);

function filters() {
  return { from: ($("#vid-source") || {}).value || "", year: ($("#vid-year") || {}).value || "", sort: ($("#vid-sort") || {}).value || "year", q: (($("#vid-q") || {}).value || "").trim().toLowerCase() };
}
/** @returns {VideoRow[]} */
function filteredRows() {
  const f = filters();
  let list = videoRows();
  if (f.from) list = list.filter(r => r.from === f.from);
  if (f.year) list = list.filter(r => (r.years || [r.year]).includes(f.year));
  if (f.q) list = list.filter(r => `${r.artist} ${r.title} ${r.album || ""}`.toLowerCase().includes(f.q));
  /** @type {Record<string, (a: VideoRow, b: VideoRow) => number>} */
  const by = {
    year: (a, b) => (b.year || "").localeCompare(a.year || "") || (b.at || 0) - (a.at || 0) || (a.position ?? 0) - (b.position ?? 0) || a.artist.localeCompare(b.artist),
    kept: (a, b) => (b.at || 0) - (a.at || 0) || (b.year || "").localeCompare(a.year || "") || a.artist.localeCompare(b.artist),
    artist: (a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title),
  };
  return list.sort(by[f.sort] || by.year);
}

/* ---- rendering ---- */
/** The one-line state of play, for the tab's header and Settings. */
export function videosSummary() {
  const v = state.videos; const n = videosLoaded() ? videoRows().length : null;
  if (!isCurator()) return "";
  if (!videosPlaylist()) return "No music-video playlist is configured (youtube_music.videos_playlist_id in config.yaml): approvals have nowhere to go.";
  if (state.videosState === "missing" || !v || !v.generated_at) return `${n ?? 0} videos to review from what you kept · the library's own list appears after the first Videos workflow run`;
  const when = v.generated_at ? relTime(new Date(v.generated_at)) : "?";
  const fresh = allItems().filter(it => it.youtube?.video && decisionFor(it.id)?.decision === "up" && !videoMark(/** @type {string} */ (it.youtube?.video))).length;
  return `${n ?? "…"} videos to review (the library's list built ${when}: ${v.count} songs with a video${v.pending ? `, ${v.pending} rows still being asked` : ""}${v.in_playlist ? `, ${v.in_playlist} already in ${VIDEOS_TITLE}` : ""}${fresh ? `; ${fresh} from songs kept here` : ""})` + (state.mvAt ? ` · playlist read ${relTime(new Date(state.mvAt))}` : "");
}
const quotaLine = () => quotaText() + ` · about ${Math.max(0, Math.floor((quotaLeft() - RESERVE) / (READ + WRITE)))} approvals possible today`;
/** @param {VideoRow} r */
const who = r => `${r.artist} - ${r.title}`;
/** @param {VideoRow} r */
function rowHtml(r) {
  const years = (r.years && r.years.length ? r.years : [r.year]).filter(Boolean);
  const where = r.from === "feed" ? `kept here${r.at ? " " + relTime(new Date(r.at)) : ""}` : years.length ? `in ${years.map(y => titleFor(y)).join(", ")}` : "";
  const meta = [KIND[r.kind || ""] || (r.own ? "filed as the video" : "video"), r.own ? "the playlist row itself is the video" : "", r.album && r.album !== r.title ? r.album : "", where, r.position != null && r.position >= 0 ? `#${r.position + 1}` : ""].filter(Boolean);
  const units = held() ? WRITE : READ + WRITE;
  return `<div class="vrow ${r.from}" data-video="${esc(r.video)}">
      <button class="vthumb" type="button" data-act="play" title="watch it here" aria-label="watch it here"><img src="https://i.ytimg.com/vi/${esc(r.video)}/mqdefault.jpg" alt="" loading="lazy" width="320" height="180"><span>▶︎</span></button>
      <div class="vbody">
        <div class="vname"><button type="button" class="vartist" title="everything by ${esc(r.artist)}">${esc(r.artist)}</button> <span class="vsep">-</span> <span class="vtitle">${esc(r.title)}</span></div>
        <div class="vmeta">${meta.map(esc).join(" · ")}</div>
        <div class="vlinks"><a href="https://music.youtube.com/watch?v=${esc(r.video)}" target="_blank" rel="noopener">video on YouTube Music</a>${r.videoId && r.videoId !== r.video ? ` <a href="https://music.youtube.com/watch?v=${esc(r.videoId)}" target="_blank" rel="noopener">audio track</a>` : ""}</div>
      </div>
      <div class="vact">
        <button class="btn down" type="button" data-act="pass" title="pass: not for ${esc(VIDEOS_TITLE)} (free, remembered)" aria-label="pass on this video">${DN} pass</button>
        <button class="btn up" type="button" data-act="approve" title="add this video to ${esc(VIDEOS_TITLE)} (${units} units)" aria-label="add this video to the music-video playlist">${UP} add</button>
      </div>
      <div class="vplayer" hidden></div>
    </div>`;
}
export function renderVideos(reset = true) {
  const box = $("#vid-list"); if (!box) return;
  $("#vid-summary").textContent = videosSummary();
  $("#vid-quota").textContent = quotaLine();
  const s = $("#s-videos-summary"); if (s) s.textContent = videosSummary();
  const pill = $("#count-videos"); if (pill) { const n = videosCount(); pill.textContent = n == null ? "…" : String(n); }
  if (reset) state.videosPage = 1;
  const ysel = $("#vid-year");
  if (ysel && ysel.options.length <= 1) { const yrs = [...new Set(videoRows().flatMap(r => r.years && r.years.length ? r.years : [r.year]))].filter(Boolean).sort().reverse(); ysel.innerHTML = `<option value="">all years</option>` + yrs.map(y => `<option value="${esc(y)}">${esc(y)}</option>`).join(""); }
  const read = /** @type {HTMLButtonElement | null} */ ($("#vid-read")); if (read) read.textContent = state.mvAt ? `read ${VIDEOS_TITLE} again` : `read ${VIDEOS_TITLE} (hides what it already holds)`;
  if (!videosLoaded()) { box.innerHTML = `<span class="muted">${state.videosState === "loading" ? "loading the video list…" : "the video list has not loaded"}</span>`; return; }
  const list = filteredRows(); const shown = list.slice(0, PAGE * state.videosPage);
  $("#vid-shown").textContent = list.length ? `${list.length} video${list.length === 1 ? "" : "s"}` : "";
  const empty = videoRows().length ? `<span class="muted">nothing matches these filters</span>` : `<span class="muted">Nothing to review${state.videos?.pending ? ` yet — ${state.videos.pending} playlist rows are still being asked for their video, a batch a day` : ": every video of every song in the library is decided or already in the playlist 🎉"}. A song kept on the Feed or the Catalog whose card knows its video comes here the moment you keep it.</span>`;
  box.innerHTML = shown.map(rowHtml).join("") + (list.length > shown.length ? `<button class="btn ghost small" type="button" data-act="more">show ${Math.min(PAGE, list.length - shown.length)} more of ${list.length - shown.length}</button>` : "") + (list.length ? "" : empty);
}
/** Counts and summaries after any action, without redrawing the list. */
function afterChange() {
  const pill = $("#count-videos"); if (pill) { const n = videosCount(); pill.textContent = n == null ? "…" : String(n); }
  $("#vid-summary").textContent = videosSummary(); $("#vid-quota").textContent = quotaLine();
  const s = $("#s-videos-summary"); if (s) s.textContent = videosSummary();
  const list = filteredRows(); $("#vid-shown").textContent = list.length ? `${list.length} video${list.length === 1 ? "" : "s"}` : "";
}
/** Take a row out of the list in place (a decision), keeping the rest where it is. @param {string} video */
function dropRow(video) {
  const el = $(`#vid-list .vrow[data-video="${CSS.escape(video)}"]`); if (!el) { afterChange(); return; }
  const playing = !$(".vplayer", el).hidden; const next = /** @type {HTMLElement | null} */ (el.nextElementSibling);
  el.remove(); afterChange();
  if (!$("#vid-list .vrow")) renderVideos(false);
  else if (playing && next && next.classList.contains("vrow")) embed(next);   // reviewing in a row: the next video starts
}

/* ---- playing in place ---- */
/** One embedded player at a time, under the row it belongs to; a second tap on the same row closes it. @param {HTMLElement} row */
function embed(row) {
  const slot = $(".vplayer", row); const vid = row.dataset.video || "";
  const same = !slot.hidden;
  $$("#vid-list .vplayer").forEach(p => { p.innerHTML = ""; p.hidden = true; }); $$("#vid-list .vrow.playing").forEach(r => r.classList.remove("playing"));
  if (same) return;
  if (playerActive()) stopPlayer();
  slot.hidden = false; row.classList.add("playing");
  const title = $(".vname", row)?.textContent || "";
  slot.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${esc(vid)}?autoplay=1&rel=0&playsinline=1" title="${esc(title)}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="eager"></iframe>`;
  row.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
/** The row whose video is playing, else the first on the list. */
const currentRow = () => /** @type {HTMLElement | null} */ ($("#vid-list .vrow.playing") || $("#vid-list .vrow"));
/** Keys on the tab: j/k move the player down and up the list, space opens it, u approves, d passes, Esc closes. @param {string} key */
export function videoKey(key) {
  const cur = currentRow(); if (!cur) return false;
  const rowOf = (/** @type {string} */ v) => videoRows().find(r => r.video === v);
  switch (key) {
    case "j": case "ArrowDown": { const n = $("#vid-list .vrow.playing") ? cur.nextElementSibling : cur; if (n && n.classList.contains("vrow")) embed(/** @type {HTMLElement} */ (n)); return true; }
    case "k": case "ArrowUp": { const p = cur.previousElementSibling; if (p && p.classList.contains("vrow")) embed(/** @type {HTMLElement} */ (p)); return true; }
    case " ": embed(cur); return true;
    case "u": { const r = rowOf(cur.dataset.video || ""); if (r) approve(r); return true; }
    case "d": { const r = rowOf(cur.dataset.video || ""); if (r) pass(r); return true; }
    case "Escape": { const p = $("#vid-list .vrow.playing"); if (p) embed(p); return true; }
  }
  return false;
}

/* ---- decisions ---- */
/** @param {number} units */
function affordable(units) { if (quotaLeft() - units < 0) { toast(`Not enough YouTube quota left today (needs ${units}, ${quotaLeft()} left) — try after midnight Pacific`, true); return false; } return true; }
/** The playlist was read a moment ago: the 1-unit probe before an add is not needed. */
const held = () => !!state.mvHeld && Date.now() - state.mvAt < HELD_EVERY_MS;
/** @param {VideoRow} r */
async function approve(r) {
  if (!isCurator() || state.busy.has("mv:" + r.video)) return;
  const pid = videosPlaylist();
  if (!pid) { toast("No music-video playlist is configured — set youtube_music.videos_playlist_id in config.yaml and run Discover", true); return; }
  if (!isOwner()) { toast("Only the curator files into the music-video playlist", true); return; }
  const units = (held() ? 0 : READ) + WRITE;
  if (!affordable(units)) return;
  if (!state.online) { toast("Offline — approvals need the network", true); return; }
  if (!(await ensureToken())) { needSignIn("Could not refresh your Google sign-in"); return; }
  state.busy.add("mv:" + r.video);
  /** @type {VideoMark} */
  const base = { decision: "up", at: Date.now(), artist: r.artist, title: r.title, year: r.year || null, videoId: r.videoId || null };
  setMark(r.video, { ...base, pending: true }); dropRow(r.video);
  try {
    const present = held() ? (/** @type {Set<string>} */ (state.mvHeld).has(r.video) ? ["known"] : []) : await playlistItemsFor(pid, r.video, { why: `Video tab: verify ${VIDEOS_TITLE} does not already hold this video before adding it`, detail: who(r) });
    if (present.length) {
      setMark(r.video, { ...base, pending: false, duplicate: true, playlistId: pid }); schedulePush();
      toast(`Already in ${VIDEOS_TITLE} — ${who(r)} was not added again`, false, { label: "Undo", fn: () => undoVideo(r.video) });
      return;
    }
    const itemId = await addToPlaylist(pid, r.video, { why: `Video tab: add the approved video to ${VIDEOS_TITLE}`, detail: who(r) });
    setMark(r.video, { ...base, pending: false, playlistItemId: itemId, playlistId: pid });
    if (state.mvHeld) state.mvHeld.add(r.video);
    schedulePush();
    const left = Math.floor(quotaLeft() / WRITE);
    toast(`${UP} ${who(r)} → ${VIDEOS_TITLE}` + (left < 40 ? ` · ${left} adds left today` : ""), false, { label: "Undo", fn: () => undoVideo(r.video) });
  } catch (e) {
    setMark(r.video, null); renderVideos(false);
    const msg = /** @type {Error} */ (e).message;
    if (/sign-in needs a refresh/i.test(msg)) needSignIn(`Could not add ${who(r)}`); else toast(`Could not add ${who(r)}: ${msg}`, true);
  } finally { state.busy.delete("mv:" + r.video); }
}
/** @param {VideoRow} r */
function pass(r) {
  if (!isCurator()) return;
  setMark(r.video, { decision: "down", at: Date.now(), artist: r.artist, title: r.title, year: r.year || null, videoId: r.videoId || null, local: true });
  dropRow(r.video); schedulePush();
  toast(`${DN} ${who(r)} — passed`, false, { label: "Undo", fn: () => undoVideo(r.video) });
}
/** @param {string} video */
export async function undoVideo(video) {
  const m = state.videoMarks[video]; if (!m || m.decision === "undone") return;
  try {
    if (m.playlistItemId) await removePlaylistItem(m.playlistItemId, { why: `Undo: remove the video the curator just took back from ${VIDEOS_TITLE}`, detail: `${m.artist || ""} - ${m.title || ""}` });
    if (state.mvHeld && m.playlistItemId) state.mvHeld.delete(video);
    setMark(video, { decision: "undone", at: Date.now() });   // a tombstone: other devices un-hide it too
    schedulePush(); toast("Undone");
    if (state.view === "videos") renderVideos(false);
  } catch (e) { toast("Undo failed: " + /** @type {Error} */ (e).message, true); }
}

/* ---- the playlist as it is ---- */
/** Read the music-video playlist (1 unit per 50 videos) so what it already holds — added from another device, or in
 * YouTube Music itself — is hidden, and the next adds skip their probe. @param {boolean} [force] */
export async function refreshHeld(force = false) {
  const pid = videosPlaylist(); if (!pid || !isOwner() || !tokenValid() || !state.online) return;
  if (!force && held()) return;
  const seen = new Set(); let pageToken, pages = 0;
  do {
    const j = await yt("GET", "/playlistItems", { params: { part: "snippet", playlistId: pid, maxResults: 50, pageToken }, why: `Video tab: verify what ${VIDEOS_TITLE} already holds, so videos added elsewhere are hidden and an approval never adds a second copy`, detail: pages ? `page ${pages + 1}` : undefined });
    for (const it of j.items || []) seen.add(it.snippet && it.snippet.resourceId && it.snippet.resourceId.videoId);
    pageToken = j.nextPageToken;
  } while (pageToken && ++pages < 100);
  state.mvHeld = seen; state.mvAt = Date.now(); memo.clear();
  if (state.view === "videos") renderVideos(false); else afterChange();
}

/* ---- wiring ---- */
/** @param {MouseEvent} e */
function onClick(e) {
  const t = /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (e.target).closest("button[data-act], .vartist")); if (!t) return;
  if (t.classList.contains("vartist")) { openArtist(t.textContent || ""); return; }
  if (t.dataset.act === "more") { state.videosPage++; renderVideos(false); return; }
  const row = /** @type {HTMLElement} */ (t.closest(".vrow")); if (!row) return;
  const r = videoRows().find(x => x.video === row.dataset.video); if (!r) return;
  if (t.dataset.act === "play") embed(row);
  else if (t.dataset.act === "approve") approve(r);
  else if (t.dataset.act === "pass") pass(r);
}
export function wireVideos() {
  $("#vid-list").addEventListener("click", onClick);
  ["#vid-source", "#vid-year", "#vid-sort"].forEach(id => $(id).addEventListener("change", () => renderVideos()));
  $("#vid-q").addEventListener("input", () => { clearTimeout(state.videosQT); state.videosQT = setTimeout(() => renderVideos(), 200); });
  $("#vid-read").addEventListener("click", () => { const b = /** @type {HTMLButtonElement} */ ($("#vid-read")); b.disabled = true; refreshHeld(true).then(() => toast(`${VIDEOS_TITLE} holds ${state.mvHeld ? state.mvHeld.size : 0} videos — those are hidden here`)).catch(e => toast(e.message, true)).finally(() => { b.disabled = false; }); });
}
