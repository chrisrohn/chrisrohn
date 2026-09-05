// @ts-check
/* The feed: loading feed.json, the filter bar, and which items are visible in each view. */
import { state, persist, items, byId, decisionFor, reconcileRated, STALE_AFTER_MS } from "./state.js";
import { $, $$, esc, relTime, range } from "./dom.js";
import { isSignedIn, isOwner, isCurator, tokenValid, emailHash, applyMode, ensureTokenClient, keepAlive } from "./auth.js";
import { pullRatings } from "./sync.js";
import { refreshRecent } from "./youtube.js";
import { render } from "./render.js";

/** @typedef {import("./types").FeedItem} FeedItem */

export async function load() {
  // same URL every time: GitHub Pages answers 304 from the ETag when nothing changed, and the service worker keeps one copy
  const feed = await fetch("data/feed.json", { cache: "no-cache" }).then(r => r.ok ? r.json() : Promise.reject(new Error("feed.json " + r.status)));
  state.feed = feed;
  if (isSignedIn() && state.auth && !state.auth.hash) state.auth.hash = await emailHash(state.auth.email);   // accounts remembered before hashes existed
  reconcileRated();
  if (isOwner()) {
    for (const [y, pid] of Object.entries((feed.youtube && feed.youtube.playlists) || {})) state.playlists[y] = state.playlists[y] || pid;
    if (feed.youtube && feed.youtube.skipped_playlist_id) state.playlists.__skipped = state.playlists.__skipped || feed.youtube.skipped_playlist_id;
  }
  persist();
  fillYears();
  fillSources();
  renderMeta();
  state.ready = true; $("#settings-btn").disabled = false;
  applyMode();
  render();
  if (isCurator() && tokenValid()) pullRatings().then(() => refreshRecent()).catch(() => {});
  if (isSignedIn()) ensureTokenClient().catch(() => {});
  document.addEventListener("pointerdown", keepAlive, { capture: true, passive: true });
  document.addEventListener("keydown", keepAlive, { capture: true, passive: true });
}
export function renderMeta() {
  const f = /** @type {import("./types").Feed} */ (state.feed);
  const when = f.generated_at ? new Date(f.generated_at) : null;
  $("#meta").textContent = `${f.count} candidates · ${f.new_today} new today · built ${when ? relTime(when) : "?"} · profile: ${f.profile?.counts?.direct ?? "?"} artists + ${f.profile?.counts?.similar ?? "?"} similar`;
  const stale = $("#stale"); const age = when ? Date.now() - when.getTime() : 0;
  stale.hidden = !(when && age > STALE_AFTER_MS);
  if (!stale.hidden && when) stale.textContent = `This feed is ${Math.round(age / 86400e3)} days old — the daily build has not run since ${when.toLocaleDateString()}. Check the Discover workflow on GitHub.`;
  $("#lfm").href = "https://www.last.fm/user/" + (f.lastfm_user || "tt_discotheque");
  document.title = `${f.site_name || "Chris Rohn's New Music"} · ${f.new_today} new`;
}
function fillYears() { const f = state.feed; state._years = (f?.years && f.years.length) ? f.years : range(new Date().getFullYear(), 1979); }
/** @type {Record<string, string>} */
const SOURCE_LABELS = { listenbrainz: "ListenBrainz", musicbrainz: "MusicBrainz", "musicbrainz-label": "Labels", bandcamp: "Bandcamp", deezer: "Deezer", "deezer-editorial": "Deezer editorial", "deezer-related": "Deezer related", ytmusic: "Artist watch", youtube: "YouTube channels", radio: "Radio plays", rss: "Blogs", spotify: "Spotify" };
export function fillSources() {
  const box = $("#sources"); const names = state.feed?.sources || []; const off = new Set(state.filters.sourcesOff || []);
  const blogs = state.feed?.blogs || []; const boff = new Set(state.filters.blogsOff || []);
  const blogCount = blogs.filter(b => !boff.has(b)).length;
  box.innerHTML = names.map(s => `<label class="${off.has(s) ? "" : "on"}"><input type="checkbox" value="${esc(s)}" ${off.has(s) ? "" : "checked"}> ${esc(SOURCE_LABELS[s] || s)}</label>` +
      (s === "rss" && blogs.length ? `<button class="all pick" type="button" id="blogs-btn" title="choose which blogs">${blogCount}/${blogs.length} blogs ▾</button>` : "")).join("") +
    (names.length > 1 ? `<button class="all" type="button" data-all="1">all</button><button class="all" type="button" data-all="0">none</button>` : "");
  $$("input", box).forEach(cb => cb.addEventListener("change", () => { const set = new Set(state.filters.sourcesOff || []); cb.checked ? set.delete(cb.value) : set.add(cb.value); state.filters.sourcesOff = [...set]; cb.parentElement.classList.toggle("on", cb.checked); persist(); render(); }));
  $$("button.all[data-all]", box).forEach(b => b.addEventListener("click", () => { state.filters.sourcesOff = b.dataset.all === "1" ? [] : [...names]; persist(); fillSources(); render(); }));
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
/** @param {FeedItem} i */
const hay = i => [i.artist, i.display_title || i.title, i.release, ...(i.tags || []), ...(i.reasons || [])].join(" ").toLowerCase();
/** @param {FeedItem} i */
export const credit = i => i.display || `${i.artist} - ${i.display_title || i.title}`;
/** @param {NonNullable<import("./types").Feed["picks"]>[number]} p @param {number} i @returns {FeedItem} */
function pickAsItem(p, i) { return { id: "pick" + i, artist: p.artist, title: p.title, release: p.album, sources: [], tags: [], reasons: [], score: 0, youtube: p.videoId ? { videoId: p.videoId, thumbnail: p.thumbnail } : null, artwork: p.thumbnail, release_date: p.year ? String(p.year) : null, _pick: true, _year: p.year }; }

/** @param {string} [view] @returns {FeedItem[]} */
export function visibleItems(view = state.view) {
  const f = state.filters; const q = f.q.trim().toLowerCase();
  if (view === "picks") {
    const picks = (state.feed?.picks || []).map(pickAsItem);
    const mine = Object.entries(state.rated).filter(([, r]) => r.decision === "up").sort((a, b) => b[1].at - a[1].at)
      .map(([id, r]) => byId(id) || /** @type {FeedItem} */ ({ id, artist: r.artist || "", title: r.title || "", sources: [], tags: [], reasons: [], score: 0, youtube: { videoId: r.videoId || null }, release_date: String(r.year), _pick: true, _year: r.year }));
    const seen = new Set(); /** @type {FeedItem[]} */ const all = [];
    for (const it of [...mine, ...picks]) { const k = ((it.youtube && it.youtube.videoId) || it.id); if (seen.has(k)) continue; seen.add(k); all.push({ ...it, _pick: true, _year: it._year || (state.rated[it.id] && state.rated[it.id].year) }); }
    return all.filter(i => !q || hay(i).includes(q));
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
    score: (a, b) => b.score - a.score,
    date: (a, b) => String(b.release_date || "").localeCompare(String(a.release_date || "")) || b.score - a.score,
    seen: (a, b) => String(b.first_seen || "").localeCompare(String(a.first_seen || "")) || b.score - a.score,
    artist: (a, b) => a.artist.localeCompare(b.artist),
  };
  return list.sort(cmp[f.sort] || cmp.score);
}
