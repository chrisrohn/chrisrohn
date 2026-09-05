// @ts-check
/* Cards (list view, paged as you scroll) and the one-card deck (phones). */
import { state, items, byId, decisionFor, PAGE } from "./state.js";
import { $, $$, esc, safeUrl, sameName, canShare, shareTrack } from "./dom.js";
import { isCurator } from "./auth.js";
import { yearBadge, fillYearSelect, matchLabel, isMatchReason } from "./years.js";
import { titleFor } from "./youtube.js";
import { visibleItems } from "./feed.js";
import { rate } from "./rating.js";
import { play, toggle } from "./player.js";

/** @typedef {import("./types").FeedItem} FeedItem */

const isPhone = () => window.matchMedia("(max-width: 760px)").matches;
export const deckOn = () => (state.settings.deck == null ? isPhone() : !!state.settings.deck) && state.view === "feed";

/** @type {IntersectionObserver | null} */
let more = null;
/** @type {FeedItem[]} */
let lastVis = [];

export function render() {
  const list = $("#list"); const vis = visibleItems(); state.order = vis.map(i => i.id); lastVis = vis;
  document.body.classList.toggle("deck-mode", deckOn());
  const lt = $("#layout-toggle"); if (lt) lt.textContent = deckOn() ? "list view" : "card view";
  if (deckOn()) { list.innerHTML = ""; renderDeck(vis); }
  else {
    $("#deck").hidden = true;
    // keep as many cards as were already on screen (a rating re-renders the list and must not jump back to the top)
    const keep = state.rendered; list.innerHTML = ""; state.rendered = 0;
    appendCards(Math.max(PAGE, keep));
  }
  const empty = $("#empty"); empty.hidden = vis.length > 0;
  empty.textContent = state.view === "feed" ? (isCurator() ? "Nothing left to rate with these filters. Come back after tomorrow's build, or loosen the filters." : "Nothing matches these filters.") : "No picks yet.";
  // the pills show exactly what each tab would list right now: unrated tracks under the current filters, and
  // the library's recent picks plus everything you've thumbed up from this account
  const other = visibleItems(state.view === "feed" ? "picks" : "feed").length;
  $("#count-feed").textContent = state.view === "feed" ? vis.length : other;
  $("#count-picks").textContent = state.view === "picks" ? vis.length : other;
  $(".tab[data-view=feed]").title = `${items().filter(i => !decisionFor(i.id)).length} unrated in the whole feed · ${items().length} total`;
  $$(".tab").forEach(t => t.setAttribute("aria-selected", String(t.dataset.view === state.view)));
  $("#filters").classList.toggle("picks", state.view === "picks");
}
/** Render up to `count` cards of the current list; a sentinel at the end pulls in the next page. @param {number} count */
function appendCards(count) {
  const list = $("#list"); const tpl = $("#card-tpl"); const frag = document.createDocumentFragment();
  const to = Math.min(count, lastVis.length);
  for (let i = state.rendered; i < to; i++) { const el = card(lastVis[i], tpl); if (i < 8) { const im = /** @type {HTMLImageElement | null} */ (el.querySelector(".art img")); if (im) im.loading = "eager"; } frag.appendChild(el); }
  state.rendered = to;
  const old = $("#more-sentinel"); if (old) old.remove();
  list.appendChild(frag);
  if (to < lastVis.length) {
    const s = document.createElement("div"); s.id = "more-sentinel"; s.className = "more-sentinel"; s.textContent = `${lastVis.length - to} more…`; list.appendChild(s);
    if (!more) more = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) appendCards(state.rendered + PAGE); }, { rootMargin: "600px" });
    more.observe(s);
  }
}
/** Make sure the card for `id` exists in the list (it may sit beyond the rendered page). @param {string} id */
export function ensureRendered(id) {
  const i = state.order.indexOf(id);
  if (i >= 0 && i >= state.rendered && !deckOn()) appendCards(Math.ceil((i + 1) / PAGE) * PAGE);
}

/** @param {FeedItem[]} vis */
export function renderDeck(vis) {
  const deck = $("#deck"); const host = $("#deck-card");
  if (!vis.length) { deck.hidden = true; host.innerHTML = ""; return; }
  deck.hidden = false;
  state.deckIndex = Math.max(0, Math.min(state.deckIndex, vis.length - 1));
  const it = vis[state.deckIndex];
  $("#deck-count").textContent = `${state.deckIndex + 1} / ${vis.length}`;
  $("#deck-prev").disabled = state.deckIndex === 0;
  const el = $("#deck-tpl").content.firstElementChild.cloneNode(true);
  el.dataset.id = it.id;
  const yt = /** @type {Partial<import("./types").YouTubeMatch>} */ (it.youtube || {});
  const img = $("img", el); if (it.artwork || yt.thumbnail) { img.src = it.artwork || yt.thumbnail; dropIfDead(img); } else img.remove();
  if (!yt.videoId) $(".dplay", el).remove();
  $(".dartist", el).textContent = it.artist;
  $(".dtitle", el).textContent = it.display_title || it.title;
  $(".release", el).textContent = [it.release_type, it.release && !sameName(it.release, it.title) ? it.release : null].filter(Boolean).join(" · ");
  $(".date", el).textContent = it.release_date || "";
  const yb = $(".yearbadge", el); const badge = yearBadge(it); yb.classList.add(badge.conf); yb.title = badge.title; yb.textContent = badge.text;
  const why = [matchLabel(it)].filter(Boolean);
  for (const r of it.reasons || []) if (!isMatchReason(r)) why.push(r);
  $(".dwhy", el).textContent = why.join(" · ");
  $(".dtags", el).innerHTML = (it.tags || []).slice(0, 4).map(t => `<span class="tag">${esc(t)}</span>`).join("");
  $(".dsources", el).innerHTML = (it.sources || []).map(s => { const [k, n] = s.split(":"); return `<span class="src ${esc(k)}">${esc(n || k)}</span>`; }).join("");
  const links = [];
  if (yt.videoId) links.push(`<a href="https://music.youtube.com/watch?v=${esc(yt.videoId)}" target="_blank" rel="noopener">YT Music</a>`);
  for (const [k, u] of Object.entries(it.links || {})) if (safeUrl(u)) links.push(`<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener">${esc(k)}</a>`);
  $(".dlinks", el).innerHTML = links.join("");
  addShare($(".dlinks", el), it);
  fillYearSelect($(".year", el), it);
  $(".dart", el).addEventListener("click", () => { if (yt.videoId) { if (state.currentId === it.id && state.playerReady) toggle(); else play(it.id); } });
  attachSwipe(el, it, 110);
  if (state.currentId === it.id) el.classList.add("current");
  host.innerHTML = ""; host.appendChild(el);
  $("#deck-play").textContent = state.currentId === it.id && state.playerReady && state.player.getPlayerState && state.player.getPlayerState() === 1 ? "⏸\uFE0E" : "▶\uFE0E";
  $("#deck-play").disabled = !yt.videoId;
}
export const deckItem = () => { const id = $("#deck-card .dcard")?.dataset.id; return id ? byId(id) : null; };
export function deckYear() { const s = $("#deck-card .year"); return s && s.value ? +s.value : undefined; }

/** @param {FeedItem} it @param {HTMLTemplateElement} tpl @returns {HTMLElement} */
function card(it, tpl) {
  const el = /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (tpl.content.firstElementChild).cloneNode(true));
  el.dataset.id = it.id;
  const yt = /** @type {Partial<import("./types").YouTubeMatch>} */ (it.youtube || {});
  const art = $(".art", el); const img = $("img", art);
  if (it.artwork || yt.thumbnail) { img.src = it.artwork || yt.thumbnail; dropIfDead(img); } else img.remove();
  if (!yt.videoId) art.classList.add("unplayable");
  if (it.first_seen && it.first_seen === state.feed?.generated_at?.slice(0, 10) && !it._pick) el.classList.add("new");
  $(".artist", el).textContent = it.artist;
  const m = $(".match", el);
  if (it.match_kind) { m.textContent = matchLabel(it); m.classList.add(it.match_kind); } else m.remove();
  $(".title", el).textContent = it.display_title || it.title;
  $(".release", el).textContent = [it.release_type, it.release && !sameName(it.release, it.title) ? it.release : null].filter(Boolean).join(" · ");
  $(".date", el).textContent = it.release_date || "";
  const yb = $(".yearbadge", el);
  if (it._pick) yb.remove();
  else { const badge = yearBadge(it); yb.classList.add(badge.conf); yb.title = badge.title; yb.textContent = badge.text; }
  $(".reasons", el).textContent = (it.reasons || []).filter(r => !isMatchReason(r)).join(" · ");
  $(".tags", el).innerHTML = (it.tags || []).slice(0, 6).map(t => `<span class="tag">${esc(t)}</span>`).join("");
  $(".sources", el).innerHTML = (it.sources || []).map(s => { const [k, n] = s.split(":"); return `<span class="src ${esc(k)}" title="${esc(s)}">${esc(n || k)}</span>`; }).join("");
  const links = [];
  if (yt.videoId) links.push(`<a href="https://music.youtube.com/watch?v=${esc(yt.videoId)}" target="_blank" rel="noopener">YouTube Music</a>`);
  if (yt.playlistId) links.push(`<a href="https://music.youtube.com/playlist?list=${esc(yt.playlistId)}" target="_blank" rel="noopener">full release</a>`);
  if (!yt.videoId) links.push(`<a href="https://music.youtube.com/search?q=${encodeURIComponent(it.artist + " " + it.title)}" target="_blank" rel="noopener">search YT Music</a>`);
  for (const [k, u] of Object.entries(it.links || {})) if (safeUrl(u)) links.push(`<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener">${esc(k)}</a>`);
  links.push(`<a href="https://www.last.fm/music/${encodeURIComponent(it.artist)}" target="_blank" rel="noopener">last.fm</a>`);
  $(".links", el).innerHTML = links.join("");
  addShare($(".links", el), it);
  $(".score", el).textContent = it.score ? it.score.toFixed(1) : "";
  const ysel = $(".year", el);
  if (it._pick) { ysel.remove(); $(".thumbs", el).remove(); const st = document.createElement("div"); st.className = "status"; st.textContent = it._year ? `in ${titleFor(it._year)}` : ""; $(".side", el).appendChild(st); }
  else {
    fillYearSelect(ysel, it);
    $(".btn.up", el).addEventListener("click", (/** @type {Event} */ e) => { e.stopPropagation(); rate(it.id, "up", +ysel.value || undefined); });
    $(".btn.down", el).addEventListener("click", (/** @type {Event} */ e) => { e.stopPropagation(); rate(it.id, "down", +ysel.value || undefined); });
  }
  art.addEventListener("click", () => { if (yt.videoId) play(it.id); });
  el.addEventListener("dblclick", () => { if (yt.videoId) play(it.id); });
  if (!it._pick) attachSwipe(el, it);
  el.addEventListener("focus", () => { state.currentId = it.id; $$(".card.current").forEach(c => c.classList.remove("current")); el.classList.add("current"); });
  return el;
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
/** @param {HTMLElement} el @param {FeedItem} it @param {number} [threshold] */
function attachSwipe(el, it, threshold = 90) {
  let x0 = 0, y0 = 0, dx = 0, active = false;
  el.addEventListener("touchstart", e => { if (!isCurator()) return; const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; dx = 0; active = true; el.classList.add("swiping"); }, { passive: true });
  el.addEventListener("touchmove", e => {
    if (!active) return; const t = e.touches[0]; dx = t.clientX - x0;
    if (Math.abs(t.clientY - y0) > 40 && Math.abs(dx) < 30) { active = false; el.style.transform = ""; el.classList.remove("swipe-up", "swipe-down", "swiping"); return; }
    el.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
    el.classList.toggle("swipe-up", dx > 60); el.classList.toggle("swipe-down", dx < -60);
  }, { passive: true });
  const end = () => {
    if (!active) return; active = false; el.classList.remove("swiping");
    const ysel = $(".year", el); const year = ysel && ysel.value ? +ysel.value : undefined;
    if (dx > threshold) rate(it.id, "up", year); else if (dx < -threshold) rate(it.id, "down", year);
    el.style.transform = ""; el.classList.remove("swipe-up", "swipe-down");
  };
  el.addEventListener("touchend", end); el.addEventListener("touchcancel", end);
}
/** @param {string} id */
export function focusCard(id) { ensureRendered(id); const el = $(`.card[data-id="${CSS.escape(id)}"]`); if (el) { el.focus({ preventScroll: false }); el.scrollIntoView({ block: "center", behavior: "smooth" }); } }
