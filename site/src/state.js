// @ts-check
/* Shared client state and its persistence. Identity, ratings, playlists, filters and settings live in localStorage;
 * the hour-long Google access token only in sessionStorage (per tab, gone when the tab closes). */

/** @typedef {import("./types").FeedItem} FeedItem */
/** @typedef {import("./types").Rated} Rated */
/** @typedef {import("./types").Feed} Feed */

const store = (/** @type {() => Storage} */ st) => ({
  /** @template T @param {string} k @param {T} d @returns {T} */
  get(k, d) { try { const v = st().getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  /** @param {string} k @param {unknown} v */
  set(k, v) { try { st().setItem(k, JSON.stringify(v)); } catch { /* storage may be unavailable */ } },
  /** @param {string} k */
  del(k) { try { st().removeItem(k); } catch { /* ignore */ } },
  /** @returns {string[]} */
  keys() { try { const s = st(); return Array.from({ length: s.length }, (_, i) => s.key(i) || "").filter(k => k.startsWith("id:")); } catch { return []; } },
});
export const LS = store(() => localStorage);
export const SS = store(() => sessionStorage);

export const YT_API = "https://www.googleapis.com/youtube/v3";
export const SCOPES = "openid email https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/drive.appdata";
export const DRIVE = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const SYNC_FILE = "newmusic-rated.json";
export const STALE_AFTER_MS = 36 * 3600e3;   // the build runs daily; older than this and something upstream failed
export const PENDING_MAX_MS = 10 * 60e3;      // an optimistic rating that never finished (tab closed mid-request)
export const PAGE = 80;                       // cards rendered at a time in list view; more appear as you scroll
export const BAD_VIDEO_MS = 30 * 86400e3;     // a video that would not embed is remembered this long, then tried again

/** @returns {import("./types").Auth | null} */
function loadAuth() {
  const a = /** @type {import("./types").Auth | null} */ (LS.get("id:auth", null)); if (!a) return null;
  const t = /** @type {{access_token: string, expires_at: number} | null} */ (SS.get("id:token", null));
  return { ...a, access_token: t ? t.access_token : undefined, expires_at: (t && t.expires_at) || 0 };
}

/** @type {import("./types").State} */
export const state = {
  feed: null,
  rated: LS.get("id:rated", {}),          // local mirror of what this account rated
  auth: loadAuth(),
  playlists: LS.get("id:playlists", {}),  // {"2026": "PL...", "__skipped": "PL...", "__loaded_at": ms}
  settings: Object.assign({ audition: false, auditionSeconds: 30, auditionStart: 25, deck: null, skipsInYouTube: null, dupesDone: [], shortlistSize: 60, autoplay: true, shuffle: false, introDismissed: false, ghToken: null }, LS.get("id:settings", {})),   // deck: null = auto (phones)
  badVideos: LS.get("id:badvideos", {}),   // videoId → when YouTube refused to embed it here (autoplay steps over these)
  badVersion: 0,                            // bumps whenever badVideos changes (a count can stay the same while an entry is swapped)
  ratedVersion: 0,                          // bumps whenever `rated` is persisted with a change: the personal ranking recomputes
  playingId: null, shuffleOrder: [], shuffleFor: "", lastRated: null, shareIn: null,
  deckIndex: 0,
  auditionTimer: null, auditionTick: null, auditionArmed: null,
  quota: LS.get("id:quota", { day: "", units: 0 }),   // YouTube API units spent today by this account's devices (resets midnight Pacific)
  // "new releases only" is on for a first visit: radio and recommendation sources surface catalogue too
  // "shortlist" keeps the day to the top N (⚙ sets N); "show all" on the list or the deck lifts it for that visit
  filters: Object.assign({ q: "", sourcesOff: [], blogsOff: [], sort: "score", onlyNew: false, onlyPlayable: true, onlyKnown: false, onlyRecent: true, shortlist: true, catYear: "", catSort: "score", catSourcesOff: [] }, LS.get("id:filters", {})),
  view: "feed",
  catalog: null,                            // data/catalog.json: earlier years' candidates, loaded when the Catalog tab is first opened
  catalogState: "idle",                     // idle | loading | ready | missing | failed
  index: new Map(),                         // id → item, across the feed and the catalog
  shortlistHidden: 0,                       // how many tracks the shortlist is holding back under the current filters
  focusId: null,                            // ?t=<id> from a permalink: focus that card once the feed is in
  order: [],
  currentId: null,
  rendered: 0,                                   // cards currently in the list (paged)
  player: null, playerReady: false, pendingVideo: null,
  tokenClient: null,
  busy: new Set(),
  sync: LS.get("id:sync", { fileId: null, at: 0 }),   // Drive appDataFolder file that mirrors `rated` across devices
  syncTimer: null, ghTimer: null, ghAt: 0,
  _years: [], dupes: null, unavailable: null, dupePage: 1, dupeQT: null, library: null, notOwner: false,
  signingIn: null, authCb: null, authErrCb: null, keepAliveAt: 0, lastAuthError: null, ready: false,
  online: typeof navigator === "undefined" || navigator.onLine !== false, recentAt: 0, recentVideos: new Set(),
};

/** The feed's items (what is new). @returns {FeedItem[]} */
export const items = () => (state.feed && state.feed.items) || [];
/** The catalog's items (earlier years), once loaded. @returns {FeedItem[]} */
export const catalogItems = () => (state.catalog && state.catalog.items) || [];
/** @returns {FeedItem[]} */
export const allItems = () => items().concat(catalogItems());
/** Rebuild the id index after either payload changes. */
export function reindex() { state.index = new Map(allItems().map(i => [i.id, i])); }
/** @param {string} id */
export const byId = id => state.index.get(id);
/** A rating that still counts: an "undone" record is a tombstone, not a decision. @param {string} id */
export const decisionFor = id => { const r = state.rated[id]; return r && r.decision !== "undone" ? r : null; };
/** YouTube refused to embed this video here recently (error 101/150): the feed keeps it, autoplay steps over it. @param {string | null | undefined} vid */
export const badVideo = vid => !!(vid && state.badVideos[vid] && Date.now() - state.badVideos[vid] < BAD_VIDEO_MS);
/** @param {string} vid */
export function markBadVideo(vid) { for (const [k, at] of Object.entries(state.badVideos)) if (Date.now() - at > BAD_VIDEO_MS) delete state.badVideos[k]; state.badVideos[vid] = Date.now(); state.badVersion++; persist(); }
export const skipsInYouTube = () => state.settings.skipsInYouTube != null ? !!state.settings.skipsInYouTube : !!(state.feed && state.feed.youtube && state.feed.youtube.skips_in_youtube);

// YouTube quota: 10,000 units/day, reset at midnight Pacific. Reads cost 1, writes cost 50. The count is per account
// (it travels in the Drive sync file), so it cannot see what guests spend on the same project.
export const ptDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
/** @param {number} units */
export function spend(units) { if (state.quota.day !== ptDay()) state.quota = { day: ptDay(), units: 0 }; state.quota.units += units; persist(); }
export const quotaUsed = () => (state.quota.day === ptDay() ? state.quota.units : 0);
export const quotaLeft = () => 10000 - quotaUsed();
export const quotaText = () => `~${quotaUsed().toLocaleString()} of 10,000 YouTube API units used today by your devices (${Math.floor(quotaLeft() / 50)} more saves) · resets midnight Pacific`;

// Local bookkeeping that has outlived its purpose: ratings the daily build now hides via the playlists, local skips
// after a year, undo tombstones after 30 days, and optimistic entries whose request never came back.
export function reconcileRated() {
  const now = Date.now(); const ids = new Set(allItems().map(i => i.id));
  for (const [id, r] of Object.entries(state.rated)) {
    const age = now - (r.at || 0);
    if (r.pending && !r.queued && age > PENDING_MAX_MS) { delete state.rated[id]; continue; }   // it never reached YouTube; let it show again (a queued one waits for the network)
    if (r.decision === "undone" && age > 30 * 86400e3) { delete state.rated[id]; continue; }
    if (r.decision === "down" && r.local && age > 365 * 86400e3) { delete state.rated[id]; continue; }
    if (!ids.has(id) && r.decision !== "down" && age > 45 * 86400e3) delete state.rated[id];
  }
}
/** @type {Record<string, string>} */
const written = {};
export function persist() {
  const keep = { "id:rated": state.rated, "id:auth": state.auth && { email: state.auth.email, name: state.auth.name, picture: state.auth.picture, hash: state.auth.hash },
    "id:playlists": state.playlists, "id:filters": state.filters, "id:settings": state.settings, "id:quota": state.quota, "id:sync": state.sync, "id:badvideos": state.badVideos };
  for (const [k, v] of Object.entries(keep)) { const j = JSON.stringify(v ?? null); if (written[k] !== j) { written[k] = j; LS.set(k, v ?? null); if (k === "id:rated") state.ratedVersion++; } }
  const tok = state.auth && state.auth.access_token ? { access_token: state.auth.access_token, expires_at: state.auth.expires_at } : null;
  const tj = JSON.stringify(tok); if (written["id:token"] !== tj) { written["id:token"] = tj; tok ? SS.set("id:token", tok) : SS.del("id:token"); }
}
export function clearLocalState() { for (const k of LS.keys()) LS.del(k); for (const k of SS.keys()) SS.del(k); }
// Everything that belongs to the signed-in account, so the next account never inherits hidden tracks or a Drive
// file it cannot open.
export function forgetAccount() {
  state.rated = {}; state.playlists = {}; state.sync = { fileId: null, at: 0 }; state.library = null; state.notOwner = false; state.lastAuthError = null;
  clearTimeout(state.syncTimer);
}
