// @ts-check
/* YouTube Data API v3 from the browser: the year playlists, the Skipped playlist, adding and removing items. */
import { state, persist, spend, items, decisionFor, YT_API } from "./state.js";
import { toast } from "./dom.js";
import { withAuth, signIn, applyMode, isOwner, isCurator, tokenValid } from "./auth.js";
import { render } from "./render.js";

/** @param {string} method @param {string} path @param {{params?: Record<string, any>, body?: any, _retried?: boolean}} [opts] @returns {Promise<any>} */
export async function yt(method, path, { params = {}, body, _retried = false } = {}) {
  return withAuth(async token => {
    const url = new URL(YT_API + path); for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
    const r = await fetch(url, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    spend(method === "GET" ? 1 : 50);
    if (r.status === 204) return {};
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (j.error && j.error.message) || r.statusText;
      if (r.status === 401) {
        // token revoked or expired early: get a fresh one silently and retry once
        if (state.auth) state.auth.expires_at = 0; persist();
        if (!_retried && await signIn({ silent: true })) return yt(method, path, { params, body, _retried: true });
        applyMode(); throw new Error("Google sign-in needs a refresh — tap the Sign in button in the message");
      }
      if (r.status === 403 && /quota/i.test(msg)) throw new Error(msg + " — daily YouTube API quota reached; try again after midnight Pacific");
      if (r.status === 403 && path.startsWith("/playlistItems") && method === "POST") throw new Error("YouTube refused to add to that playlist for this sign-in. Collaborative playlists can only be edited through the API by the channel that owns them (@indiedisco) — sign out and sign in again choosing that channel, or make the playlist owner account a curator.");
      throw new Error(msg);
    }
    return j;
  });
}
const pattern = () => isOwner()
  ? ((state.feed?.youtube && state.feed.youtube.playlist_title_pattern) || "{year} | Indie Discotheque")
  : ((state.feed?.google && state.feed.google.guest_playlist_title_pattern) || "{year} Picks from chrisrohn.com");
/** @param {string | number} year */
export const titleFor = year => pattern().replace("{year}", String(year));
export const skippedTitle = () => (state.feed?.youtube && state.feed.youtube.skipped_playlist_title) || "Skipped";
/** @param {unknown} s */
const normTitle = s => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// "2024 Indie Discotheque", "Indie Discotheque 2024", "2024 - indie discotheque" all count
/** @param {string} t */
export function yearFromTitle(t) {
  const words = normTitle(pattern().replace("{year}", " ")).trim();
  const n = normTitle(t);
  if (!words || !n.includes(words)) return null;
  const m = /\b(19[5-9]\d|20\d\d)\b/.exec(n);
  return m ? m[1] : null;
}
export async function loadLibraryPlaylists() {
  let pageToken; let n = 0; const all = [];
  do {
    const j = await yt("GET", "/playlists", { params: { part: "snippet,contentDetails", mine: "true", maxResults: 50, pageToken } });
    for (const p of j.items || []) {
      const t = (p.snippet.title || "").trim();
      all.push({ id: p.id, title: t, count: (p.contentDetails || {}).itemCount || 0, published: p.snippet.publishedAt, desc: p.snippet.description || "" });
      const y = yearFromTitle(t);
      if (y) { if (!state.playlists[y]) state.playlists[y] = p.id; }
      else if (normTitle(t) === normTitle(skippedTitle())) state.playlists.__skipped = p.id;
      n++;
    }
    pageToken = j.nextPageToken;
  } while (pageToken && n < 500);
  state.playlists.__loaded_at = Date.now();
  state.library = all;
  persist();
  checkOwnership();
  return all;
}
// The Indie Discotheque playlists are collaborative: they belong to @indiedisco and are edited by collaborators. YouTube's
// "mine=true" listing only shows playlists this channel OWNS, so not finding them there is expected — we file into
// the ids the daily build discovered and let YouTube tell us if this sign-in may not edit them.
function checkOwnership() {
  if (!isOwner() || !state.library) return;
  const known = Object.values((state.feed?.youtube && state.feed.youtube.playlists) || {});
  if (!known.length) return;
  const mine = new Set(state.library.map(p => p.id));
  state.notOwner = known.every(id => !mine.has(id));
}
/** @param {string | number} year */
export const knownYear = year => isOwner() ? (((state.feed?.youtube && state.feed.youtube.playlists) || {})[String(year)] || null) : null;
/** @param {string | number} year */
export async function playlistFor(year) {
  year = String(year);
  // the daily build knows the library's year playlists by id (from the @indiedisco channel) — always use those
  const k = knownYear(year);
  if (k) { state.playlists[year] = k; persist(); return k; }
  if (isOwner()) {
    // Curators never create playlists: every Indie Discotheque year is pinned by id in discovery/config.yaml.
    toast(`No pinned playlist id for ${year}. Add it to youtube_music.playlists in config.yaml and run Discover.`, true);
    throw new Error("no pinned playlist for " + year);
  }
  if (!state.playlists[year] || !state.playlists.__loaded_at) await loadLibraryPlaylists();
  if (!state.playlists[year]) {
    const ok = confirm(`No playlist called “${titleFor(year)}” exists in this YouTube account (${state.auth?.email}).\n\nCreate it now? (Cancel if it should already exist — then check the title spelling or the signed-in channel.)`);
    if (!ok) throw new Error("no playlist for " + year);
    const j = await yt("POST", "/playlists", { params: { part: "snippet,status" }, body: { snippet: { title: titleFor(year), description: "Filed from chrisrohn.com" }, status: { privacyStatus: "public" } } });
    state.playlists[year] = j.id; persist(); toast(`Created playlist “${titleFor(year)}”`);
  }
  return state.playlists[year];
}
export async function skippedPlaylist() {
  if (!state.playlists.__skipped && !state.playlists.__loaded_at) await loadLibraryPlaylists();
  if (!state.playlists.__skipped) {
    const j = await yt("POST", "/playlists", { params: { part: "snippet,status" }, body: { snippet: { title: skippedTitle(), description: "Thumbs-down from chrisrohn.com. Keep unlisted; paste the ID into discovery/config.yaml → skipped_playlist_id." }, status: { privacyStatus: "unlisted" } } });
    state.playlists.__skipped = j.id; persist();
    toast(`Created unlisted “${skippedTitle()}” playlist. Paste its ID into config.yaml → skipped_playlist_id: ${j.id}`);
  }
  return state.playlists.__skipped;
}
/** @param {string} playlistId @param {string} videoId @returns {Promise<string>} */
export async function addToPlaylist(playlistId, videoId) {
  const j = await yt("POST", "/playlistItems", { params: { part: "snippet" }, body: { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } } });
  return j.id;
}
/** @param {string} playlistItemId */
export async function removePlaylistItem(playlistItemId) { await yt("DELETE", "/playlistItems", { params: { id: playlistItemId } }); }
// every playlist item holding this video (1 quota unit) — the duplicate guard and the cleanup tool both use it
/** @param {string} playlistId @param {string} videoId @returns {Promise<string[]>} */
export async function playlistItemsFor(playlistId, videoId) {
  const j = await yt("GET", "/playlistItems", { params: { part: "id", playlistId, videoId, maxResults: 50 } });
  return (j.items || []).map((/** @type {any} */ i) => i.id);
}
// Hide things filed from another device since the last daily build. playlistItems come back in playlist order and
// new saves are appended, so the whole playlist is paged (1 quota unit per 50 tracks) — the first page alone would
// only ever show the oldest saves of the year.
export async function refreshRecent() {
  if (!isCurator() || !tokenValid()) return;
  const y = String(new Date().getFullYear());
  const ids = [knownYear(y) || state.playlists[y], state.playlists.__skipped].filter(Boolean);
  const seen = new Set();
  for (const pid of ids) {
    let pageToken, pages = 0;
    do {
      const j = await yt("GET", "/playlistItems", { params: { part: "snippet", playlistId: pid, maxResults: 50, pageToken } }).catch(() => ({}));
      for (const it of j.items || []) seen.add(it.snippet.resourceId && it.snippet.resourceId.videoId);
      pageToken = j.nextPageToken;
    } while (pageToken && ++pages < 40);
  }
  let changed = false;
  for (const it of items()) if (it.youtube && seen.has(it.youtube.videoId) && !decisionFor(it.id)) { state.rated[it.id] = { decision: "seen", at: Date.now() }; changed = true; }
  if (changed) { persist(); render(); }
}
