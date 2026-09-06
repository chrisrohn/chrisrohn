// @ts-check
/* Cards (list view, paged as you scroll) and the one-card deck (phones).
 * Cards are keyed by id and reused between renders: a thumb, a filter or a keystroke moves the elements that are
 * still visible and builds only the new ones, instead of rebuilding every card on screen. */
import { state, items, byId, decisionFor, badVideo, persist, PAGE } from "./state.js";
import { $, $$, esc, safeUrl, sameName, canShare, shareTrack, copyText, permalink, buzz, announce } from "./dom.js";
import { isCurator, isSignedIn } from "./auth.js";
import { yearBadge, fillYearSelect, matchLabel, isMatchReason } from "./years.js";
import { titleFor } from "./youtube.js";
import { visibleItems, searchFor, credit, parseQuery, termText, dropTerm } from "./feed.js";
import { rate, undo, restoreAll } from "./rating.js";
import { play, toggle, refreshNow } from "./player.js";
import { personal, scoreOf } from "./rank.js";
import { addYearFinder, discogsSearch } from "./yearfind.js";
import { renderDupes, openCleanup } from "./dupes.js";
import { syncUrl } from "./url.js";
import { openArtist } from "./artist.js";

/** @typedef {import("./types").FeedItem} FeedItem */

const isPhone = () => window.matchMedia("(max-width: 760px)").matches;
export const deckOn = () => (state.settings.deck == null ? isPhone() : !!state.settings.deck) && (state.view === "feed" || state.view === "catalog");

/** @type {IntersectionObserver | null} */
let more = null;
/** @type {FeedItem[]} */
let lastVis = [];
/** Built cards by view + id; dropped with the feed they were built from. @type {Map<string, HTMLElement>} */
const cards = new Map();
let cardsFor = "";

export function render() {
  const list = $("#list"); const vis = visibleItems(); state.order = vis.map(i => i.id); lastVis = vis;
  const stamp = `${state.feed?.generated_at || ""}|${isCurator()}`; if (cardsFor !== stamp) { cards.clear(); cardsFor = stamp; }
  document.body.classList.toggle("deck-mode", deckOn());
  const lt = $("#layout-toggle"); if (lt) lt.textContent = deckOn() ? "list view" : "card view";
  if (deckOn()) { list.replaceChildren(); renderDeck(vis); }
  else {
    showDeck(false);
    // keep as many cards as were already on screen (a rating re-renders the list and must not jump back to the top)
    const keep = state.rendered; state.rendered = 0;
    appendCards(Math.max(PAGE, keep));
  }
  refreshNow();
  const cleanup = state.view === "cleanup"; $("#cleanup").hidden = !cleanup; if (cleanup) renderDupes(false);
  const empty = $("#empty"); empty.hidden = vis.length > 0 || cleanup;
  empty.replaceChildren(state.view === "feed" ? (isCurator() ? "Nothing left to rate with these filters. Come back after tomorrow's build, or loosen the filters." : "Nothing matches these filters.")
    : state.view === "skipped" ? "Nothing skipped from this feed."
    : state.view === "catalog" ? ({ idle: "Opening the catalog…", loading: "Loading the catalog…", missing: "No catalog yet — it appears after the next daily build, then grows for a couple of weeks as the lookups work through your Last.fm history.", failed: "Could not load the catalog." }[state.catalogState] || "Nothing here with these filters.")
    : "No picks yet.");
  if (state.view === "catalog" && state.catalogState === "failed") { const b = document.createElement("button"); b.type = "button"; b.className = "btn ghost small"; b.textContent = "Retry"; b.addEventListener("click", () => import("./feed.js").then(m => m.loadCatalog(true))); empty.append(" ", b); }
  // the pills show exactly what each tab would list right now: unrated tracks under the current filters (the
  // shortlist counted in full), the library's recent picks plus everything thumbed up, and this feed's skips
  const hidden = state.shortlistHidden; const full = (/** @type {string} */ v) => { const n = visibleItems(v).length; return v === state.view ? n + hidden : n + state.shortlistHidden; };
  const counts = { feed: full("feed"), picks: visibleItems("picks").length, skipped: isCurator() ? visibleItems("skipped").length : 0, catalog: state.catalog ? full("catalog") : 0,
    cleanup: openCleanup() };
  state.shortlistHidden = hidden;
  for (const [k, n] of Object.entries(counts)) { const el = $("#count-" + k); if (el) el.textContent = k === "catalog" && !state.catalog ? "…" : String(n); }
  $(".tab[data-view=feed]").title = `${items().filter(i => !decisionFor(i.id)).length} unrated in the whole feed · ${items().length} total`;
  $$(".tab").forEach(t => { const on = t.dataset.view === state.view; t.classList.toggle("active", on); t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1; });
  $("#filters").classList.toggle("picks", state.view === "picks" || state.view === "skipped");
  $("#filters").classList.toggle("cleanup", cleanup);
  $("#filters").classList.toggle("catalog", state.view === "catalog");
  renderChips();
  renderIntro();
  syncUrl();
  const name = { feed: "candidates", catalog: "catalog tracks", picks: "picks", skipped: "skipped tracks", cleanup: "cleanup items" }[state.view] || "items";
  announce(cleanup ? `Cleanup: ${counts.cleanup} to review` : `${vis.length}${state.shortlistHidden && (state.view === "feed" || state.view === "catalog") ? ` of ${vis.length + state.shortlistHidden}` : ""} ${name} shown`);
}
/** The active search terms as chips, each with its own ✕, so two tags combine and any one can go. */
function renderChips() {
  const box = $("#chips"); if (!box) return;
  const terms = state.view === "cleanup" ? [] : parseQuery(state.filters.q.trim());
  box.hidden = !terms.length;
  box.replaceChildren(...terms.map(t => {
    const b = document.createElement("button"); b.type = "button"; b.className = "chip qchip" + (t.not ? " not" : "");
    b.innerHTML = `${t.field ? `<span class="muted">${esc(t.field)}:</span>` : ""}${t.not ? "−" : ""}${esc(t.value)} <span class="x" aria-hidden="true">✕</span>`;
    b.title = `remove “${termText(t.field, t.value)}” from the search`; b.setAttribute("aria-label", b.title);
    b.addEventListener("click", () => dropTerm(t));
    return b;
  }), ...(terms.length > 1 ? [(() => { const c = document.createElement("button"); c.type = "button"; c.className = "linkish"; c.textContent = "clear all"; c.addEventListener("click", () => searchFor("", { add: false })); return c; })()] : []));
}
/** A one-time card for a first visit: what this is, how to listen, what signing in adds. */
function renderIntro() {
  const el = $("#intro"); if (!el) return;
  el.hidden = !!state.settings.introDismissed || isSignedIn() || state.view !== "feed" || !state.feed;
}
/** Render up to `count` cards of the current list; a sentinel at the end pulls in the next page. @param {number} count */
function appendCards(count) {
  const list = $("#list"); const tpl = $("#card-tpl");
  const to = Math.min(count, lastVis.length);
  const els = [];
  if (state.view === "skipped" && lastVis.length > 1 && isCurator()) els.push(restoreNote());
  for (let i = 0; i < to; i++) {
    const it = lastVis[i]; const key = `${state.view}|${it.id}`;
    let el = cards.get(key); if (!el) { el = card(it, tpl); cards.set(key, el); }
    else if (el.dataset.rv !== String(state.ratedVersion)) applyLearned(el, it);   // a thumb since: the learned bonus and its reasons move
    const im = /** @type {HTMLImageElement | null} */ (el.querySelector(".art img")); if (im && i < 8) im.loading = "eager";
    el.classList.toggle("current", state.currentId === it.id);
    els.push(el);
  }
  state.rendered = to;
  const tail = [];
  if (to < lastVis.length) {
    const s = document.createElement("div"); s.id = "more-sentinel"; s.className = "more-sentinel"; s.textContent = `${lastVis.length - to} more…`; tail.push(s);
    if (!more) more = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) appendCards(state.rendered + PAGE); }, { rootMargin: "600px" });
    more.observe(s);
  } else if ((state.view === "feed" || state.view === "catalog") && state.shortlistHidden) tail.push(showAllNote());
  list.replaceChildren(...els, ...tail);
}
/** The shortlist's tail: how many more the filters would allow, and a way to see them. */
function showAllNote() {
  const s = document.createElement("div"); s.id = "shortlist-note"; s.className = "more-sentinel shortlist-note";
  s.innerHTML = `shortlist: top ${lastVis.length} by score · <button type="button" class="linkish" id="show-all">show all ${lastVis.length + state.shortlistHidden}</button>`;
  $("#show-all", s).addEventListener("click", showAll);
  return s;
}
/** The Skipped tab's head: restore everything listed (or just today's) in one go. */
function restoreNote() {
  const s = document.createElement("div"); s.className = "more-sentinel restore-note";
  const today = Date.now() - 86400e3; const recent = lastVis.filter(i => (state.rated[i.id]?.at || 0) > today);
  s.innerHTML = `${lastVis.length} skipped · <button type="button" class="linkish" id="restore-all">restore all</button>${recent.length && recent.length < lastVis.length ? ` · <button type="button" class="linkish" id="restore-today">restore the last 24 h (${recent.length})</button>` : ""}`;
  $("#restore-all", s).addEventListener("click", () => restoreAll(lastVis.map(i => i.id)));
  const rt = $("#restore-today", s); if (rt) rt.addEventListener("click", () => restoreAll(recent.map(i => i.id)));
  return s;
}
export function showAll() { state.filters.shortlist = false; $("#shortlist").checked = false; persist(); render(); }
/** Make sure the card for `id` exists in the list (it may sit beyond the rendered page). @param {string} id */
export function ensureRendered(id) {
  const i = state.order.indexOf(id);
  if (i >= 0 && i >= state.rendered && !deckOn()) appendCards(Math.ceil((i + 1) / PAGE) * PAGE);
}

/** The deck's own parts come and go; the player inside it stays (an iframe moved in the DOM would reload and stop
 * the music), so the section itself is never hidden, only emptied of layout (.off). @param {boolean} on */
function showDeck(on) { $("#deck").classList.toggle("off", !on); $$("#deck-top, #deck-card, #deck-actions").forEach(el => { el.hidden = !on; }); }

/** @param {FeedItem[]} vis */
export function renderDeck(vis) {
  const host = $("#deck-card");
  if (!vis.length) { showDeck(false); host.replaceChildren(); return; }
  showDeck(true);
  state.deckIndex = Math.max(0, Math.min(state.deckIndex, vis.length - 1));
  const it = vis[state.deckIndex];
  const dc = $("#deck-count"); dc.replaceChildren(`${state.deckIndex + 1} / ${vis.length}`);
  if (state.shortlistHidden) { const b = document.createElement("button"); b.type = "button"; b.className = "linkish"; b.textContent = `+${state.shortlistHidden}`; b.title = `shortlist: the top ${vis.length} by score — show all ${vis.length + state.shortlistHidden}`; b.addEventListener("click", showAll); dc.append(" ", b); }
  $("#deck-prev").disabled = state.deckIndex === 0;
  const el = $("#deck-tpl").content.firstElementChild.cloneNode(true);
  el.dataset.id = it.id;
  el.setAttribute("aria-label", credit(it));
  const yt = /** @type {Partial<import("./types").YouTubeMatch>} */ (it.youtube || {});
  const img = $("img", el); if (it.artwork || yt.thumbnail) { img.src = it.artwork || yt.thumbnail; dropIfDead(img); } else img.remove();
  if (!yt.videoId) $(".dplay", el).remove();
  if (badVideo(yt.videoId)) el.classList.add("noembed");
  const da = $(".dartist", el); da.textContent = it.artist; da.title = `everything by ${it.artist}`;
  da.addEventListener("click", (/** @type {Event} */ e) => { e.stopPropagation(); openArtist(it.artist); });
  $(".dtitle", el).textContent = it.display_title || it.title;
  $(".release", el).textContent = [it.release_type, it.release && !sameName(it.release, it.title) ? it.release : null].filter(Boolean).join(" · ");
  $(".date", el).textContent = it.release_date || "";
  const yb = $(".yearbadge", el); const badge = yearBadge(it); yb.classList.add(badge.conf); yb.title = badge.title; yb.textContent = badge.text;
  const why = [matchLabel(it)].filter(Boolean);
  for (const r of it.reasons || []) if (!isMatchReason(r)) why.push(r);
  why.push(...personal(it).why);
  $(".dwhy", el).textContent = why.join(" · ");
  $(".dtags", el).replaceChildren(...(it.tags || []).slice(0, 4).map(tagButton));
  $(".dsources", el).innerHTML = (it.sources || []).map(s => { const [k, n] = s.split(":"); return `<span class="src ${esc(k)}">${esc(n || k)}</span>`; }).join("");
  const links = [];
  if (yt.videoId) links.push(`<a href="https://music.youtube.com/watch?v=${esc(yt.videoId)}" target="_blank" rel="noopener">YT Music</a>`);
  for (const [k, u] of Object.entries(it.links || {})) if (safeUrl(u)) links.push(`<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener">${esc(k)}</a>`);
  if (it.year == null && !it._pick) links.push(`<a href="${esc(discogsSearch(it))}" target="_blank" rel="noopener">discogs</a>`);
  $(".dlinks", el).innerHTML = links.join("");
  if (it.year == null && !it._pick && isCurator()) addYearFinder(el, it);
  if (!it._pick) addPermalink($(".dlinks", el), it);
  addShare($(".dlinks", el), it);
  fillYearSelect($(".year", el), it);
  $(".dart", el).addEventListener("click", () => { if (yt.videoId) { if (state.playingId === it.id && state.playerReady) toggle(); else play(it.id); } });
  attachSwipe(el, it, 110);
  if (state.playingId === it.id) el.classList.add("current");
  host.replaceChildren(el);
  $("#deck-play").classList.toggle("playing", state.playingId === it.id && state.playerReady && state.player.getPlayerState && state.player.getPlayerState() === 1);
  $("#deck-play").disabled = !yt.videoId;
}
export const deckItem = () => { const id = $("#deck-card .dcard")?.dataset.id; return id ? byId(id) : null; };
export function deckYear() { const s = $("#deck-card .year"); return s && s.value ? +s.value : undefined; }

/** A tag chip that adds itself to the search when pressed (so two tags combine). @param {string} t */
function tagButton(t) { const b = document.createElement("button"); b.type = "button"; b.className = "tag"; b.textContent = t; b.title = `add “${t}” to the search`; b.addEventListener("click", e => { e.stopPropagation(); searchFor(termText("tag", t)); }); return b; }

/** @param {FeedItem} it @param {HTMLTemplateElement} tpl @returns {HTMLElement} */
function card(it, tpl) {
  const el = /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (tpl.content.firstElementChild).cloneNode(true));
  el.dataset.id = it.id;
  el.setAttribute("aria-label", credit(it));
  const yt = /** @type {Partial<import("./types").YouTubeMatch>} */ (it.youtube || {});
  const art = $(".art", el); const img = $("img", art);
  if (it.artwork || yt.thumbnail) { img.src = it.artwork || yt.thumbnail; dropIfDead(img); } else img.remove();
  if (!yt.videoId) art.classList.add("unplayable");
  if (badVideo(yt.videoId)) { el.classList.add("noembed"); art.title = "YouTube would not embed this video here recently — open it in YT Music"; }
  if (it.first_seen && it.first_seen === state.feed?.generated_at?.slice(0, 10) && !it._pick) el.classList.add("new");
  const artist = $(".artist", el); artist.textContent = it.artist; artist.title = `everything by ${it.artist} (the artist sheet)`;
  artist.addEventListener("click", (/** @type {Event} */ e) => { e.stopPropagation(); openArtist(it.artist); });
  const m = $(".match", el);
  if (it.match_kind) { m.textContent = matchLabel(it); m.classList.add(it.match_kind); m.title = `why: open ${it.matched_artist && it.matched_artist !== it.artist ? it.matched_artist : it.artist}`; m.addEventListener("click", (/** @type {Event} */ e) => { e.stopPropagation(); openArtist(it.match_kind === "similar" ? it.artist : (it.matched_artist || it.artist)); }); } else m.remove();
  $(".title", el).textContent = it.display_title || it.title;
  $(".release", el).textContent = [it.release_type, it.release && !sameName(it.release, it.title) ? it.release : null].filter(Boolean).join(" · ");
  $(".date", el).textContent = it.release_date || "";
  const yb = $(".yearbadge", el);
  if (it._pick) yb.remove();
  else { const badge = yearBadge(it); yb.classList.add(badge.conf); yb.title = badge.title; yb.textContent = badge.text; }
  applyLearned(el, it);
  $(".tags", el).replaceChildren(...(it.tags || []).slice(0, 6).map(tagButton));
  $(".sources", el).innerHTML = (it.sources || []).map(s => { const [k, n] = s.split(":"); return `<span class="src ${esc(k)}" title="${esc(s)}">${esc(n || k)}</span>`; }).join("");
  const links = [];
  if (yt.videoId) links.push(`<a href="https://music.youtube.com/watch?v=${esc(yt.videoId)}" target="_blank" rel="noopener">YouTube Music</a>`);
  if (yt.playlistId) links.push(`<a href="https://music.youtube.com/playlist?list=${esc(yt.playlistId)}" target="_blank" rel="noopener">full release</a>`);
  if (!yt.videoId) links.push(`<a href="https://music.youtube.com/search?q=${encodeURIComponent(it.artist + " " + it.title)}" target="_blank" rel="noopener">search YT Music</a>`);
  for (const [k, u] of Object.entries(it.links || {})) if (safeUrl(u)) links.push(`<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener">${esc(k)}</a>`);
  links.push(`<a href="https://www.last.fm/music/${encodeURIComponent(it.artist)}" target="_blank" rel="noopener">last.fm</a>`);
  if (it.year == null && !it._pick) links.push(`<a href="${esc(discogsSearch(it))}" target="_blank" rel="noopener">discogs</a>`);
  $(".links", el).innerHTML = links.join("");
  if (it.year == null && !it._pick && !it._skipped && isCurator()) addYearFinder(el, it);
  if (!it._pick) addPermalink($(".links", el), it);
  addShare($(".links", el), it);
  const ysel = $(".year", el);
  if (it._pick) { ysel.remove(); $(".thumbs", el).remove(); const st = document.createElement("div"); st.className = "status"; st.textContent = it._year ? `in ${titleFor(it._year)}` : ""; $(".side", el).appendChild(st); }
  else if (it._skipped) {
    ysel.remove(); $(".thumbs", el).remove();
    const r = decisionFor(it.id); const st = document.createElement("div"); st.className = "status"; st.textContent = r?.at ? `skipped ${Math.max(0, Math.round((Date.now() - r.at) / 86400e3))} d ago${r.local ? "" : " · on YouTube"}` : "skipped";
    const b = document.createElement("button"); b.type = "button"; b.className = "btn restore"; b.textContent = "restore"; b.title = r?.playlistItemId ? "Take it out of the Skipped playlist (50 quota units) and back into the feed" : "Back into the feed";
    b.addEventListener("click", e => { e.stopPropagation(); undo(it.id); });
    $(".side", el).append(st, b);
  } else {
    fillYearSelect(ysel, it);
    $(".btn.up", el).addEventListener("click", (/** @type {Event} */ e) => { e.stopPropagation(); rate(it.id, "up", +ysel.value || undefined); });
    $(".btn.down", el).addEventListener("click", (/** @type {Event} */ e) => { e.stopPropagation(); rate(it.id, "down", +ysel.value || undefined); });
  }
  art.addEventListener("click", () => { if (yt.videoId) play(it.id); });
  el.addEventListener("dblclick", () => { if (yt.videoId) play(it.id); });
  if (!it._pick && !it._skipped) attachSwipe(el, it);
  el.addEventListener("focus", () => { state.currentId = it.id; $$(".card.current").forEach(c => c.classList.remove("current")); el.classList.add("current"); });
  return el;
}
/** The parts of a card that this account's ratings change: the score and the "you keep …" reasons. @param {HTMLElement} el @param {FeedItem} it */
function applyLearned(el, it) {
  const p = it._pick ? { adj: 0, why: [] } : personal(it);
  const why = (it.reasons || []).filter(r => !isMatchReason(r)); why.push(...p.why);
  $(".reasons", el).textContent = why.join(" · ");
  const sc = $(".score", el);
  sc.textContent = it.score ? scoreOf(it).toFixed(1) : "";
  sc.title = p.adj ? `build score ${it.score.toFixed(1)} ${p.adj > 0 ? "+" : "−"} ${Math.abs(p.adj).toFixed(1)} learned from your keeps and skips` : "relevance score";
  el.dataset.rv = String(state.ratedVersion);
}
/** Artwork URLs come from many CDNs and some die: show the plain tile rather than a broken-image glyph. @param {HTMLImageElement} img */
function dropIfDead(img) { img.addEventListener("error", () => img.remove(), { once: true }); }
/** A "share" control at the end of the links, only where the browser has a share sheet. @param {HTMLElement} host @param {FeedItem} it */
function addShare(host, it) {
  if (!canShare()) return;
  const b = document.createElement("button"); b.type = "button"; b.className = "share"; b.textContent = "share"; b.title = "share this track";
  b.addEventListener("click", e => { e.stopPropagation(); shareTrack(it); });
  host.appendChild(b);
}
/** The card's own address on this site (?t=<id>), copied to the clipboard. @param {HTMLElement} host @param {FeedItem} it */
function addPermalink(host, it) {
  const b = document.createElement("button"); b.type = "button"; b.className = "share"; b.textContent = "link"; b.title = "copy a link to this card";
  b.addEventListener("click", e => { e.stopPropagation(); copyText(permalink(it.id)); });
  host.appendChild(b);
}
export { permalink };
/** Swipe right to keep, left to skip: pointer events, so a finger, a pen or a trackpad drag all count (a mouse does
 * not: a drag to select text must not file a track). A short buzz marks the decision on phones. @param {HTMLElement} el @param {FeedItem} it @param {number} [threshold] */
function attachSwipe(el, it, threshold = 90) {
  let x0 = 0, y0 = 0, dx = 0, active = false, id = -1;
  const reset = () => { active = false; id = -1; el.style.transform = ""; el.classList.remove("swipe-up", "swipe-down", "swiping"); };
  el.addEventListener("pointerdown", e => {
    if (!isCurator() || e.pointerType === "mouse" || !e.isPrimary) return;
    x0 = e.clientX; y0 = e.clientY; dx = 0; active = true; id = e.pointerId; el.classList.add("swiping");
  });
  el.addEventListener("pointermove", e => {
    if (!active || e.pointerId !== id) return; dx = e.clientX - x0;
    if (Math.abs(e.clientY - y0) > 40 && Math.abs(dx) < 30) { reset(); return; }   // a scroll, not a swipe
    if (Math.abs(dx) > 12 && !el.hasPointerCapture(id)) { try { el.setPointerCapture(id); } catch { /* ignore */ } }
    el.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
    el.classList.toggle("swipe-up", dx > 60); el.classList.toggle("swipe-down", dx < -60);
  });
  const end = (/** @type {PointerEvent} */ e) => {
    if (!active || e.pointerId !== id) return; active = false; el.classList.remove("swiping");
    const ysel = $(".year", el); const year = ysel && ysel.value ? +ysel.value : undefined;
    if (dx > threshold) { buzz(); rate(it.id, "up", year); } else if (dx < -threshold) { buzz(); rate(it.id, "down", year); }
    reset();
  };
  el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
}
/** @param {string} id */
export function focusCard(id) { ensureRendered(id); const el = $(`.card[data-id="${CSS.escape(id)}"]`); if (el) { el.focus({ preventScroll: false }); el.scrollIntoView({ block: "center", behavior: "smooth" }); } }
