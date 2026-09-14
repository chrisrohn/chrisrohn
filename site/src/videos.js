// @ts-check
/* The Video tab: the official videos of the songs the library holds, reviewed one by one for the music-video playlist.
 *
 * The year playlists hold audio tracks; YouTube Music pairs most of them with an official video. Two things put a
 * video here: a song kept on the site whose card knows its video side (`youtube.video`, from the resolver — a Keep
 * brings the video the same day), and every row of every year playlist whose video the Videos workflow has found
 * (discovery/videos.py → data/videos.json, a batch a day until the whole library is asked). One video is one card
 * however many years hold the song, drawn like a feed card (render.js) and playing the video itself in the site's
 * player: the list is the queue, so autoplay, j/k, space, the lock screen and the player's own thumbs work as they
 * do on the Feed and the Catalog. ▲︎ adds it to the one music-video playlist (feed.json → youtube.videos_playlist_id;
 * 50 units, plus 1 to verify it is not there already unless the playlist was read a moment ago); ▼︎ passes on it
 * for free; both come through rate() in rating.js, so the keys, the swipe and the player's thumbs all land here.
 * Decisions are remembered per account (id:videos), mirrored across devices with the ratings, and pushed to the
 * build in the ratings file (`videos`), so the next report leaves them out; the playlist itself is read (1 unit
 * per 50 videos, at most every half hour) so what another device or YouTube Music itself added is hidden too. */
import { state, persist, allItems, decisionFor, reindex, byId, quotaLeft, quotaText } from "./state.js";
import { $, esc, relTime, toast } from "./dom.js";
import { isCurator, isOwner, tokenValid, ensureToken, needSignIn } from "./auth.js";
import { yt, titleFor, addToPlaylist, removePlaylistItem, playlistItemsFor } from "./youtube.js";
import { schedulePush } from "./sync.js";
import { playerActive } from "./player.js";
import { cardFor } from "./render.js";
import { moveOn } from "./rating.js";

/** @typedef {import("./types").VideoRow} VideoRow */
/** @typedef {import("./types").VideoMark} VideoMark */
/** @typedef {import("./types").FeedItem} FeedItem */

const PAGE = 40;
const READ = 1, WRITE = 50;
const RESERVE = 500;                  // quota kept back for the day's keeps
const HELD_EVERY_MS = 30 * 60e3;      // the music-video playlist is read again after this
const UP = "▲︎", DN = "▼︎";
/** A video's card id in the shared index: never a feed id, so a kept song's card (the audio track) and its video card (the video) are two. */
export const VIDEO_ID = "video:";
/** @param {string} video */
export const videoItemId = video => VIDEO_ID + video;
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
let tracksKey = "";   // what state.videoTracks was built from (the reports, the feed, the catalog, the ratings)
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
  // every video as a card the player and the keys can read — decided ones too, so the one playing stays known
  // after its verdict (the feed keeps a rated card the same way); rebuilt only when the set of videos can have changed
  const tk = key.split("|").slice(0, 4).join("|");
  if (tk !== tracksKey) { tracksKey = tk; state.videoTracks = [...m.values()].map(asItem); reindex(); }
  if (memo.size > 6) memo.delete(/** @type {string} */ (memo.keys().next().value));
  memo.set(key, out);
  return out;
}
/** The playlist years a video is filed in. @param {VideoRow} r */
const yearsOf = r => (r.years && r.years.length ? r.years : [r.year]).filter(Boolean);
/** A video row as a card: the shape the feed's cards, the player and the keys read, playing the video itself. The
 * facts a feed card has no room for go where a card shows them — the kind of upload as the release type, the
 * album as the release, the playlist years as the badge, where it is from as the reasons and the source chip.
 * @param {VideoRow} r @returns {FeedItem} */
function asItem(r) {
  const years = yearsOf(r);
  const where = r.from === "feed" ? `kept here${r.at ? " " + relTime(new Date(r.at)) : ""}` : years.length ? `in ${years.map(y => titleFor(y)).join(", ")}` : "";
  const reasons = [r.own ? "the playlist row itself is the video" : "", where, r.position != null && r.position >= 0 ? `#${r.position + 1}` : ""].filter(Boolean);
  /** @type {Record<string, string>} */ const links = {};
  if (r.videoId && r.videoId !== r.video) links["audio track"] = `https://music.youtube.com/watch?v=${r.videoId}`;
  return { id: videoItemId(r.video), artist: r.artist, title: r.title, display_title: r.title, release: r.album || null, release_type: KIND[r.kind || ""] || (r.own ? "filed as the video" : "video"), release_date: null,
    sources: [r.from === "feed" ? "videos:kept here" : "videos:year playlists"], tags: [], reasons, links, score: 0,
    youtube: { videoId: r.video, thumbnail: `https://i.ytimg.com/vi/${r.video}/mqdefault.jpg` }, artwork: null,
    year: years.length ? Number(years[0]) : null, year_source: years.length ? "youtube" : "unknown", year_confidence: "low", _video: r };
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
/** @type {IntersectionObserver | null} */
let more = null;
export function renderVideos(reset = true) {
  const box = $("#vid-list"); if (!box) return;
  $("#vid-summary").textContent = videosSummary();
  $("#vid-quota").textContent = quotaLine();
  const s = $("#s-videos-summary"); if (s) s.textContent = videosSummary();
  const pill = $("#count-videos"); if (pill) { const n = videosCount(); pill.textContent = n == null ? "…" : String(n); }
  if (reset) state.videosPage = 1;
  const ysel = $("#vid-year");
  if (ysel && ysel.options.length <= 1) { const yrs = [...new Set(videoRows().flatMap(yearsOf))].sort().reverse(); ysel.innerHTML = `<option value="">all years</option>` + yrs.map(y => `<option value="${esc(y)}">${esc(y)}</option>`).join(""); }
  const read = /** @type {HTMLButtonElement | null} */ ($("#vid-read")); if (read) read.textContent = state.mvAt ? `read ${VIDEOS_TITLE} again` : `read ${VIDEOS_TITLE} (hides what it already holds)`;
  const empty = $("#vid-empty");
  if (!videosLoaded()) { box.replaceChildren(); state.order = []; empty.hidden = false; empty.textContent = state.videosState === "loading" ? "Loading the video list…" : "The video list has not loaded."; $("#vid-shown").textContent = ""; return; }
  const list = filteredRows(); const shown = list.slice(0, PAGE * state.videosPage);
  // the cards are the queue: space plays the first, j/k and autoplay walk on down the list, past the page shown
  state.order = list.map(r => videoItemId(r.video));
  $("#vid-shown").textContent = list.length ? `${list.length} video${list.length === 1 ? "" : "s"}` : "";
  const els = [];
  for (const r of shown) { const it = byId(videoItemId(r.video)); if (!it) continue; const el = cardFor(it); el.classList.toggle("current", state.currentId === it.id || state.playingId === it.id); els.push(el); }
  if (list.length > shown.length) {
    const sen = document.createElement("div"); sen.className = "more-sentinel"; sen.textContent = `${list.length - shown.length} more…`; els.push(sen);
    if (!more) more = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { state.videosPage++; renderVideos(false); } }, { rootMargin: "600px" });
    more.observe(sen);
  }
  box.replaceChildren(...els);
  empty.hidden = list.length > 0;
  if (!list.length) empty.textContent = videoRows().length ? "Nothing matches these filters." : `Nothing to review${state.videos?.pending ? ` yet — ${state.videos.pending} playlist rows are still being asked for their video, a batch a day` : ": every video of every song in the library is decided or already in the playlist 🎉"}. A song kept on the Feed or the Catalog whose card knows its video comes here the moment you keep it.`;
}
/** Counts and summaries after any action, without redrawing the list. */
function afterChange() {
  const pill = $("#count-videos"); if (pill) { const n = videosCount(); pill.textContent = n == null ? "…" : String(n); }
  $("#vid-summary").textContent = videosSummary(); $("#vid-quota").textContent = quotaLine();
  const s = $("#s-videos-summary"); if (s) s.textContent = videosSummary();
  const list = filteredRows(); $("#vid-shown").textContent = list.length ? `${list.length} video${list.length === 1 ? "" : "s"}` : "";
}
/** Make sure the card for `id` is on the page (it may sit beyond the page shown): the queue walks past it. @param {string} id */
export function ensureVideoRendered(id) {
  const i = state.order.indexOf(id);
  if (i >= 0 && i >= PAGE * state.videosPage) { state.videosPage = Math.ceil((i + 1) / PAGE); renderVideos(false); }
}
/** A card leaves the list the way a rated card leaves the feed: the list redraws around it, and focus (and the
 * player, if that video was playing and autoplay is on) move on to the next. @param {VideoRow} r */
function leave(r) {
  const id = videoItemId(r.video); const wasPlaying = state.playingId === id && playerActive(); const idx = state.order.indexOf(id);
  state.lastRated = id;   // the z key
  if (state.view === "videos") renderVideos(false); else afterChange();
  moveOn(id, idx, wasPlaying);
}

/* ---- decisions ---- */
/** A verdict on a video card, from wherever a feed card takes one — the card's thumbs, u/d, the swipe, the player's
 * own thumbs (rate() in rating.js hands video cards here). @param {FeedItem} it @param {"up" | "down" | "wrong"} decision */
export function rateVideo(it, decision) {
  const r = it._video; if (!r) return;
  if (decision === "wrong") { toast("A video has no wrong-video flag — pass on it instead", true); return; }
  if (decision === "up") approve(r); else pass(r);
}
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
  setMark(r.video, { ...base, pending: true }); leave(r);
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
  leave(r); schedulePush();
  toast(`${DN} ${who(r)} — passed`, false, { label: "Undo", fn: () => undoVideo(r.video) });
}
/** @param {string} video */
export async function undoVideo(video) {
  const m = state.videoMarks[video]; if (!m || m.decision === "undone") return;
  try {
    if (m.playlistItemId) await removePlaylistItem(m.playlistItemId, { why: `Undo: remove the video the curator just took back from ${VIDEOS_TITLE}`, detail: `${m.artist || ""} - ${m.title || ""}` });
    if (state.mvHeld && m.playlistItemId) state.mvHeld.delete(video);
    setMark(video, { decision: "undone", at: Date.now() });   // a tombstone: other devices un-hide it too
    if (state.lastRated === videoItemId(video)) state.lastRated = null;
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
export function wireVideos() {
  ["#vid-source", "#vid-year", "#vid-sort"].forEach(id => $(id).addEventListener("change", () => renderVideos()));
  $("#vid-q").addEventListener("input", () => { clearTimeout(state.videosQT); state.videosQT = setTimeout(() => renderVideos(), 200); });
  $("#vid-read").addEventListener("click", () => { const b = /** @type {HTMLButtonElement} */ ($("#vid-read")); b.disabled = true; refreshHeld(true).then(() => toast(`${VIDEOS_TITLE} holds ${state.mvHeld ? state.mvHeld.size : 0} videos — those are hidden here`)).catch(e => toast(e.message, true)).finally(() => { b.disabled = false; }); });
}
