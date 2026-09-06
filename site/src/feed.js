// @ts-check
/* The feed: loading feed.json, the filter bar, and which items are visible in each view. */
import { state, persist, items, catalogItems, allItems, byId, reindex, decisionFor, reconcileRated, STALE_AFTER_MS } from "./state.js";
import { $, $$, esc, relTime, range, toast } from "./dom.js";
import { isSignedIn, isOwner, isCurator, tokenValid, emailHash, applyMode, ensureTokenClient, keepAlive } from "./auth.js";
import { pullRatings } from "./sync.js";
import { refreshRecent } from "./youtube.js";
import { render, deckOn, focusCard } from "./render.js";
import { scoreOf, invalidateRank } from "./rank.js";

/** @typedef {import("./types").FeedItem} FeedItem */

const REFRESH_AFTER_MS = 30 * 60e3;   // an app left open: look for a newer daily build when it comes back to the foreground
let loadedAt = 0;

// same URL every time: GitHub Pages answers 304 from the ETag when nothing changed, and the service worker keeps one copy
const fetchFeed = () => fetch("data/feed.json", { cache: "no-cache" }).then(r => r.ok ? r.json() : Promise.reject(new Error("feed.json " + r.status)));
/** @param {import("./types").Feed} feed */
function absorb(feed) {
  state.feed = feed; loadedAt = Date.now();
  hays.clear(); memo.clear(); invalidateRank(); reindex();
  reconcileRated();
  if (isOwner()) {
    for (const [y, pid] of Object.entries((feed.youtube && feed.youtube.playlists) || {})) state.playlists[y] = state.playlists[y] || pid;
    if (feed.youtube && feed.youtube.skipped_playlist_id) state.playlists.__skipped = state.playlists.__skipped || feed.youtube.skipped_playlist_id;
  }
  persist();
  fillYears();
  fillSources();
  renderMeta();
}

export async function load() {
  const feed = await fetchFeed();
  if (isSignedIn() && state.auth && !state.auth.hash) state.auth.hash = await emailHash(state.auth.email);   // accounts remembered before hashes existed
  absorb(feed);
  state.ready = true; $("#settings-btn").disabled = false;
  applyMode();
  render();
  openPermalink();
  if (isCurator() || state.view === "catalog") loadCatalog().catch(() => {});
  if (isCurator() && tokenValid()) pullRatings().then(() => refreshRecent()).catch(() => {});
  if (isSignedIn()) ensureTokenClient().catch(() => {});
  document.addEventListener("pointerdown", keepAlive, { capture: true, passive: true });
  document.addEventListener("keydown", keepAlive, { capture: true, passive: true });
}
/** A newer build than the one on screen? Swap it in without losing the place in the deck. Resolves true if it changed. */
export async function refreshFeed(force = false) {
  if (!state.ready || (!force && Date.now() - loadedAt < REFRESH_AFTER_MS)) return false;
  loadedAt = Date.now();
  const feed = await fetchFeed();
  if (feed.generated_at === state.feed?.generated_at) return false;
  const keep = deckOnId();
  absorb(feed);
  render();
  if (state.catalogState === "ready") loadCatalog(true).catch(() => {});
  if (keep) { const i = state.order.indexOf(keep); if (i >= 0) { state.deckIndex = i; render(); } }
  toast(`Feed updated · ${feed.new_today} new today`);
  return true;
}
/* The catalog (data/catalog.json): candidates for the earlier years, from your Last.fm history. Loaded the first
 * time the Catalog tab opens (a curator gets it straight away), and again when a newer build lands. */
export async function loadCatalog(force = false) {
  if (state.catalogState === "loading" || (state.catalogState === "ready" && !force)) return;
  state.catalogState = "loading"; render();
  try {
    const r = await fetch("data/catalog.json", { cache: "no-cache" });
    if (r.status === 404) { state.catalogState = "missing"; render(); return; }
    if (!r.ok) throw new Error("catalog.json " + r.status);
    const cat = await r.json();
    if (cat.generated_at !== state.catalog?.generated_at) { state.catalog = cat; memo.clear(); reindex(); reconcileRated(); }
    state.catalogState = "ready";
  } catch (e) { state.catalogState = "failed"; toast("Could not load the catalog: " + /** @type {Error} */ (e).message, true); }
  fillSources(); fillCatalogYears(); render();
}
/** The year select in the Catalog view: every playlist year with how full it is and how many candidates wait. */
export function fillCatalogYears() {
  const sel = $("#cat-year"); const cat = state.catalog; if (!sel || !cat) return;
  const years = Object.entries(cat.years || {}).sort((a, b) => Number(b[0]) - Number(a[0]));
  sel.innerHTML = `<option value="">all years · ${cat.count} candidates${cat.pending ? ` · ${cat.pending} more being dated` : ""}</option>` + (cat.undated ? `<option value="?">year unknown · ${cat.undated}</option>` : "") +
    years.map(([y, v]) => `<option value="${y}"${v.candidates ? "" : " disabled"}>${y} · ${v.playlist} in playlist · ${v.candidates} here</option>`).join("");
  sel.value = state.filters.catYear || "";
  if (sel.value !== (state.filters.catYear || "")) { state.filters.catYear = ""; sel.value = ""; }
}
/** ?t=<id> (a share, the RSS feed): put that card on screen — by searching for it if the filters would hide it. */
function openPermalink() {
  const id = state.focusId; if (!id) return; state.focusId = null;
  const it = byId(id); if (!it) { toast("That track is no longer in the feed", true); return; }
  if (state.view !== "feed") { state.view = "feed"; $$(".tab").forEach(x => x.classList.toggle("active", x.dataset.view === "feed")); render(); }
  if (!state.order.includes(id)) searchFor(`${it.artist} ${it.display_title || it.title}`);   // the search index joins the fields with spaces
  if (!state.order.includes(id)) { toast(`${credit(it)} is hidden by your filters`, true); return; }
  if (deckOn()) { state.deckIndex = state.order.indexOf(id); render(); } else focusCard(id);
}
/** The track showing in the deck, so a refresh can stay on it. */
function deckOnId() { const el = $("#deck-card .dcard"); return el ? /** @type {HTMLElement} */ (el).dataset.id : null; }

export function renderMeta() {
  const f = /** @type {import("./types").Feed} */ (state.feed);
  const when = f.generated_at ? new Date(f.generated_at) : null;
  $("#meta").textContent = `${f.count} candidates · ${f.new_today} new today · built ${when ? relTime(when) : "?"} · profile: ${f.profile?.counts?.direct ?? "?"} artists + ${f.profile?.counts?.similar ?? "?"} similar`;
  const stale = $("#stale"); const age = when ? Date.now() - when.getTime() : 0;
  stale.hidden = !(when && age > STALE_AFTER_MS);
  if (!stale.hidden && when) stale.textContent = `This feed is ${Math.round(age / 86400e3)} days old — the daily build has not run since ${when.toLocaleDateString()}. Check the Discover workflow on GitHub.`;
  $("#lfm").href = "https://www.last.fm/user/" + (f.lastfm_user || "tt_discotheque");
  const rev = $("#tb-rev"); if (rev && when) rev.textContent = when.toISOString().slice(0, 10);   // title block: revision = build date
  document.title = `${f.site_name || "Chris Rohn's New Music"} · ${f.new_today} new`;
}
function fillYears() { const f = state.feed; state._years = (f?.years && f.years.length) ? f.years : range(new Date().getFullYear(), 1979); }
/** @type {Record<string, string>} */
const SOURCE_LABELS = { listenbrainz: "ListenBrainz", musicbrainz: "MusicBrainz", "musicbrainz-label": "Labels", bandcamp: "Bandcamp", deezer: "Deezer", "deezer-editorial": "Deezer editorial", "deezer-related": "Deezer related", ytmusic: "Artist watch", youtube: "YouTube channels", radio: "Radio plays", rss: "Blogs", spotify: "Spotify",
  "lastfm:top tracks": "Most played", "lastfm:loved": "Loved", "lastfm:artist top": "Your artists' hits", "lastfm:similar top": "Similar artists' hits" };
/** The source chips: the feed's source families, or the catalog's Last.fm lists, whichever tab is open. */
export function fillSources() {
  const box = $("#sources"); const catalog = state.view === "catalog";
  const key = catalog ? "catSourcesOff" : "sourcesOff";
  const names = catalog ? (state.catalog?.sources || []) : (state.feed?.sources || []); const off = new Set(state.filters[key] || []);
  const blogs = catalog ? [] : (state.feed?.blogs || []); const boff = new Set(state.filters.blogsOff || []);
  const blogCount = blogs.filter(b => !boff.has(b)).length;
  box.innerHTML = names.map(s => `<label class="${off.has(s) ? "" : "on"}"><input type="checkbox" value="${esc(s)}" ${off.has(s) ? "" : "checked"}> ${esc(SOURCE_LABELS[s] || s.split(":").slice(1).join(":") || s)}</label>` +
      (s === "rss" && blogs.length ? `<button class="all pick" type="button" id="blogs-btn" title="choose which blogs">${blogCount}/${blogs.length} blogs ▾</button>` : "")).join("") +
    (names.length > 1 ? `<button class="all" type="button" data-all="1">all</button><button class="all" type="button" data-all="0">none</button>` : "");
  $$("input", box).forEach(cb => cb.addEventListener("change", () => { const set = new Set(state.filters[key] || []); cb.checked ? set.delete(cb.value) : set.add(cb.value); state.filters[key] = [...set]; cb.parentElement.classList.toggle("on", cb.checked); persist(); render(); }));
  $$("button.all[data-all]", box).forEach(b => b.addEventListener("click", () => { state.filters[key] = b.dataset.all === "1" ? [] : [...names]; persist(); fillSources(); render(); }));
  const bb = $("#blogs-btn"); if (bb) bb.addEventListener("click", openBlogPicker);
}
function openBlogPicker() {
  const blogs = state.feed?.blogs || []; const boff = new Set(state.filters.blogsOff || []);
  /** @type {Record<string, number>} */
  const counts = {}; for (const it of items()) for (const s of it.sources || []) if (s.startsWith("rss:")) counts[s.slice(4)] = (counts[s.slice(4)] || 0) + 1;
  const body = $("#blogs-body");
  body.innerHTML = blogs.map(b => `<label class="chk"><input type="checkbox" value="${esc(b)}" ${boff.has(b) ? "" : "checked"}> ${esc(b)} <span class="muted">(${counts[b] || 0})</span></label>`).join("");
  $$("input", body).forEach(cb => cb.addEventListener("change", () => { const set = new Set(state.filters.blogsOff || []); cb.checked ? set.delete(cb.value) : set.add(cb.value); state.filters.blogsOff = [...set]; persist(); render(); }));
  $("#blogs-all").onclick = () => { state.filters.blogsOff = []; persist(); openBlogPicker(); render(); };
  $("#blogs-none").onclick = () => { state.filters.blogsOff = [...blogs]; persist(); openBlogPicker(); render(); };
  const dlg = $("#blogs"); if (!dlg.open) { dlg.showModal(); dlg.addEventListener("close", () => fillSources(), { once: true }); }
}
/** @param {string} s */
const sourceOn = s => {
  const fam = s.split(":")[0];
  if ((state.filters.sourcesOff || []).includes(fam)) return false;
  if (fam === "rss" && (state.filters.blogsOff || []).includes(s.slice(4))) return false;
  return true;
};
/* Search text per item, built once per feed rather than per keystroke. */
/** @type {Map<string, string>} */
const hays = new Map();
/** @param {FeedItem} i */
const hay = i => { let h = hays.get(i.id); if (h == null) { h = [i.artist, i.display_title || i.title, i.release, ...(i.tags || []), ...(i.reasons || [])].join(" ").toLowerCase(); hays.set(i.id, h); } return h; };
/** @param {FeedItem} i */
export const credit = i => i.display || `${i.artist} - ${i.display_title || i.title}`;
/** @param {NonNullable<import("./types").Feed["picks"]>[number]} p @param {number} i @returns {FeedItem} */
function pickAsItem(p, i) { return { id: "pick" + i, artist: p.artist, title: p.title, release: p.album, sources: [], tags: [], reasons: [], score: 0, youtube: p.videoId ? { videoId: p.videoId, thumbnail: p.thumbnail } : null, artwork: p.thumbnail, release_date: p.year ? String(p.year) : null, _pick: true, _year: p.year }; }

/** A tag or an artist name on a card is a filter: the search box takes it, so it is visible and easy to clear. @param {string} text */
export function searchFor(text) {
  state.filters.q = text; $("#q").value = text; persist(); render();
  // on a phone the filter strip is folded away: unfold it so the search box (and how to clear it) is in view
  if (window.matchMedia("(max-width: 760px)").matches && !document.body.classList.contains("filters-open")) { document.body.classList.add("filters-open"); const b = $("#filters-more"); if (b) { b.textContent = "hide filters ▴"; b.setAttribute("aria-expanded", "true"); } }
}

/* The visible list is memoised on everything it depends on: filters, view, the feed build, the ratings and the
 * embed blacklist. A render asks for both tabs' lists (the pills), a keystroke re-asks with one thing changed. */
/** @type {Map<string, {list: FeedItem[], hidden: number}>} */
const memo = new Map();
/** @param {string} [view] @returns {FeedItem[]} */
export function visibleItems(view = state.view) { return computeVisible(view).list; }
/** @param {string} view */
function computeVisible(view) {
  const key = `${view}|${JSON.stringify(state.filters)}|${state.ratedVersion}|${state.feed?.generated_at || ""}|${state.catalog?.generated_at || ""}|${Object.keys(state.badVideos).length}`;
  const hit = memo.get(key); if (hit) { if (view === "feed") state.shortlistHidden = hit.hidden; return hit; }
  const res = { list: listFor(view), hidden: 0 };
  const f = state.filters;
  const sortKey = view === "catalog" ? f.catSort : f.sort;
  if ((view === "feed" || view === "catalog") && f.shortlist && (sortKey === "score" || !sortKey) && !f.q) {
    const n = Math.max(10, Number(state.settings.shortlistSize) || 60);
    if (res.list.length > n) { res.hidden = res.list.length - n; res.list = res.list.slice(0, n); }
  }
  if (view === "feed" || view === "catalog") state.shortlistHidden = res.hidden;
  if (memo.size > 8) memo.delete(/** @type {string} */ (memo.keys().next().value));
  memo.set(key, res);
  return res;
}
/** @param {string} view @returns {FeedItem[]} */
function listFor(view) {
  const f = state.filters; const q = f.q.trim().toLowerCase();
  if (view === "picks") {
    const picks = (state.feed?.picks || []).map(pickAsItem);
    const mine = Object.entries(state.rated).filter(([, r]) => r.decision === "up").sort((a, b) => b[1].at - a[1].at)
      .map(([id, r]) => byId(id) || /** @type {FeedItem} */ ({ id, artist: r.artist || "", title: r.title || "", sources: r.sources || [], tags: r.tags || [], reasons: [], score: 0, youtube: { videoId: r.videoId || null }, release_date: String(r.year), _pick: true, _year: r.year }));
    const seen = new Set(); /** @type {FeedItem[]} */ const all = [];
    for (const it of [...mine, ...picks]) { const k = ((it.youtube && it.youtube.videoId) || it.id); if (seen.has(k)) continue; seen.add(k); all.push({ ...it, _pick: true, _year: it._year || (state.rated[it.id] && state.rated[it.id].year) }); }
    return all.filter(i => !q || hay(i).includes(q));
  }
  if (view === "skipped") {
    // what this account thumbed down and is still in the feed or the catalog, newest skip first; Undo brings any back
    return allItems().filter(i => decisionFor(i.id)?.decision === "down" && (!q || hay(i).includes(q)))
      .sort((a, b) => (state.rated[b.id]?.at || 0) - (state.rated[a.id]?.at || 0)).map(i => ({ ...i, _skipped: true }));
  }
  if (view === "catalog") {
    const off = new Set(f.catSourcesOff || []); const y = f.catYear || "";
    const list = catalogItems().filter(i => {
      if (decisionFor(i.id)) return false;
      if (q && !hay(i).includes(q)) return false;
      if (off.size && !(i.sources || []).some(s => !off.has(s))) return false;
      if (f.onlyPlayable && !(i.youtube && i.youtube.videoId)) return false;
      if (y === "?" ? i.year != null : (y && String(i.year) !== y)) return false;
      return true;
    });
    /** @type {Record<string, (a: FeedItem, b: FeedItem) => number>} */
    const ccmp = {
      score: (a, b) => scoreOf(b) - scoreOf(a) || b.score - a.score,
      plays: (a, b) => (b.plays || 0) - (a.plays || 0) || scoreOf(b) - scoreOf(a),
      year: (a, b) => (b.year || 0) - (a.year || 0) || scoreOf(b) - scoreOf(a),
      artist: (a, b) => a.artist.localeCompare(b.artist),
    };
    return list.sort(ccmp[f.catSort] || ccmp.score);
  }
  const today = state.feed?.generated_at?.slice(0, 10); const lastYear = new Date().getFullYear() - 1;
  const list = items().filter(i => {
    if (decisionFor(i.id)) return false;
    if (q && !hay(i).includes(q)) return false;
    if (!(i.sources || []).some(sourceOn)) return false;
    if (f.onlyNew && i.first_seen !== today) return false;
    if (f.onlyPlayable && !(i.youtube && i.youtube.videoId)) return false;
    if (f.onlyKnown && !i.match_kind) return false;
    if (f.onlyRecent && Number.isFinite(i.year) && i.year_source !== "unknown" && /** @type {number} */ (i.year) < lastYear) return false;
    return true;
  });
  /** @type {Record<string, (a: FeedItem, b: FeedItem) => number>} */
  const cmp = {
    score: (a, b) => scoreOf(b) - scoreOf(a) || b.score - a.score,
    raw: (a, b) => b.score - a.score,
    date: (a, b) => String(b.release_date || "").localeCompare(String(a.release_date || "")) || b.score - a.score,
    seen: (a, b) => String(b.first_seen || "").localeCompare(String(a.first_seen || "")) || b.score - a.score,
    artist: (a, b) => a.artist.localeCompare(b.artist),
  };
  return list.sort(cmp[f.sort] || cmp.score);
}
