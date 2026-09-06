// @ts-check
/* Chris Rohn's New Music — client entry point.
 * Reads data/feed.json (built daily by GitHub Actions). Anyone can listen.
 * Sign in with Google (one of the configured curator accounts) to get curator mode:
 *   keep → added straight to "<year> | Indie Discotheque" (the library playlists) on YouTube Music (YouTube Data API v3, from this browser)
 *   skip → added to the unlisted "Skipped" playlist so it never comes back
 * Nothing is written anywhere until you press a thumb. Undo is available for a few seconds after each one.
 */
import { state, persist } from "./state.js";
import { $, $$, toast } from "./dom.js";
import { isSignedIn, isCurator, tokenValid, signIn, signOut } from "./auth.js";
import { pullRatings } from "./sync.js";
import { load, loadCatalog, fillSources, refreshFeed } from "./feed.js";
import { render, deckOn, deckItem, deckYear } from "./render.js";
import { rate, replayQueued } from "./rating.js";
import { play, toggle, nextTrack, prevTrack, holdAudition, stopPlayer, playerActive, toggleShuffle, reflectShuffle, autoplayOn } from "./player.js";
import { wireSettings } from "./settings.js";
import { wireKeys, currentYear } from "./keys.js";
import { wirePwa } from "./pwa.js";
import { applyLaunchParams, wireLayers } from "./url.js";
import { pushToGitHub, ghEnabled } from "./github.js";

function wire() {
  const tabs = $$(".tab");
  /** @param {HTMLElement} b */
  const goTab = b => {
    const was = state.view; state.view = b.dataset.view || "feed"; tabs.forEach(x => x.classList.toggle("active", x === b));
    if ((was === "catalog") !== (state.view === "catalog")) fillSources();   // the chips are the feed's sources or the catalog's lists
    if (state.view === "catalog") loadCatalog().catch(() => {});
    state.deckIndex = 0; render();
  };
  tabs.forEach(b => b.addEventListener("click", () => goTab(b)));
  // a real tab list: the arrow keys move between tabs, Home/End jump, and only the open tab sits in the Tab order
  $(".tabs").addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => {
    const on = tabs.filter(t => !t.hidden && getComputedStyle(t).display !== "none"); const i = on.indexOf(/** @type {HTMLElement} */ (document.activeElement)); if (i < 0) return;
    const to = e.key === "ArrowRight" ? on[(i + 1) % on.length] : e.key === "ArrowLeft" ? on[(i - 1 + on.length) % on.length] : e.key === "Home" ? on[0] : e.key === "End" ? on[on.length - 1] : null;
    if (to) { e.preventDefault(); to.focus(); goTab(to); }
  });
  const f = state.filters;
  $("#q").value = f.q; $("#sort").value = f.sort; $("#only-new").checked = f.onlyNew; $("#only-playable").checked = f.onlyPlayable; $("#only-known").checked = f.onlyKnown; $("#only-recent").checked = f.onlyRecent; $("#shortlist").checked = f.shortlist;
  /** @type {any} */ let qTimer;
  $("#q").addEventListener("input", (/** @type {any} */ e) => { f.q = e.target.value; clearTimeout(qTimer); qTimer = setTimeout(() => { persist(); render(); }, 120); });
  $("#sort").addEventListener("change", (/** @type {any} */ e) => { f.sort = e.target.value; persist(); render(); });
  $("#only-new").addEventListener("change", (/** @type {any} */ e) => { f.onlyNew = e.target.checked; persist(); render(); });
  $("#only-playable").addEventListener("change", (/** @type {any} */ e) => { f.onlyPlayable = e.target.checked; persist(); render(); });
  $("#only-known").addEventListener("change", (/** @type {any} */ e) => { f.onlyKnown = e.target.checked; persist(); render(); });
  $("#only-recent").addEventListener("change", (/** @type {any} */ e) => { f.onlyRecent = e.target.checked; persist(); render(); });
  $("#shortlist").addEventListener("change", (/** @type {any} */ e) => { f.shortlist = e.target.checked; persist(); render(); });
  $("#cat-sort").value = f.catSort || "score";
  $("#cat-sort").addEventListener("change", (/** @type {any} */ e) => { f.catSort = e.target.value; persist(); render(); });
  $("#cat-year").addEventListener("change", (/** @type {any} */ e) => { f.catYear = e.target.value; state.deckIndex = 0; persist(); render(); });
  $("#signin").addEventListener("click", () => { if (isSignedIn()) signOut(); else signIn().then(() => { if (isCurator()) loadCatalog().catch(() => {}); }).catch(e => toast(e.message, true)); });
  $("#p-next").addEventListener("click", nextTrack); $("#p-prev").addEventListener("click", prevTrack); $("#p-toggle").addEventListener("click", () => { holdAudition(); toggle(); });
  $("#yt").addEventListener("click", holdAudition, true);
  // autoplay is a setting, not a checkbox that forgets itself on reload
  const ap = $("#autoplay"); ap.checked = autoplayOn(); ap.addEventListener("change", () => { state.settings.autoplay = ap.checked; persist(); });
  $("#p-shuffle").addEventListener("click", toggleShuffle); reflectShuffle();
  $("#deck-up").addEventListener("click", () => { const it = deckItem(); if (it) rate(it.id, "up", deckYear()); });
  $("#deck-down").addEventListener("click", () => { const it = deckItem(); if (it) rate(it.id, "down", deckYear()); });
  $("#deck-play").addEventListener("click", () => { const it = deckItem(); if (!it?.youtube?.videoId) return; if (state.playingId === it.id && state.playerReady) { holdAudition(); toggle(); } else play(it.id); });
  $("#deck-next").addEventListener("click", () => { state.deckIndex++; render(); const it = deckItem(); if (it?.youtube?.videoId && playerActive()) play(it.id); });
  $("#deck-prev").addEventListener("click", () => { state.deckIndex = Math.max(0, state.deckIndex - 1); render(); });
  $("#layout-toggle").addEventListener("click", () => { state.settings.deck = !deckOn(); persist(); render(); });
  const toggleFilters = () => { const open = document.body.classList.toggle("filters-open"); $("#filters-more").textContent = open ? "hide filters ▴" : "filters ▾"; $("#filters-more").setAttribute("aria-expanded", String(open)); };
  $("#deck-filters").addEventListener("click", toggleFilters); $("#filters-more").addEventListener("click", toggleFilters);
  // keep the pinned deck buttons above the player bar whatever its height, and the deck card above the buttons
  const playerEl = $("#player"), actionsEl = $("#deck-actions");
  const setPlayerH = () => {
    // in the phone deck the player sits in the card, not over the page: nothing needs to make room for it
    const floating = !playerEl.hidden && getComputedStyle(playerEl).position === "fixed";
    document.documentElement.style.setProperty("--player-h", floating ? playerEl.getBoundingClientRect().height + "px" : "0px");
    document.documentElement.style.setProperty("--actions-h", actionsEl.getBoundingClientRect().height + "px");
  };
  new ResizeObserver(setPlayerH).observe(playerEl); new ResizeObserver(setPlayerH).observe(actionsEl);
  new MutationObserver(setPlayerH).observe(playerEl, { attributes: true, attributeFilter: ["hidden"] }); setPlayerH();
  window.matchMedia("(max-width: 760px)").addEventListener("change", () => render());
  // the player's own thumbs judge what plays, whatever card the keyboard has wandered to
  $("#p-up").addEventListener("click", () => state.playingId && rate(state.playingId, "up", currentYear(state.playingId)));
  $("#p-down").addEventListener("click", () => state.playingId && rate(state.playingId, "down", currentYear(state.playingId)));
  $("#p-close").addEventListener("click", stopPlayer);
  $("#np-next").addEventListener("click", nextTrack);
  $("#intro-x").addEventListener("click", () => { state.settings.introDismissed = true; persist(); render(); });
  $("#intro-signin").addEventListener("click", () => $("#signin").click());
  $("#feed-retry").addEventListener("click", () => boot());
  wireOffline();
  wireLayers();
  wireSettings();
  wireKeys();
  wirePwa();
  applyLaunchParams();   // after the controls are wired: ?view=…, ?q=…, ?t=<id>, ?artist=, the share target and the app shortcuts
  // another device may have rated things while this tab was in the background (only while the token is valid:
  // a background refresh would need a popup, which browsers block without a tap — the next Keep refreshes it instead)
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && isCurator() && tokenValid() && Date.now() - (state.sync.at || 0) > 60e3) pullRatings(); });
  // the ratings file for the build: a last push when the tab goes away, if a thumb is still waiting
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && ghEnabled() && state.ghTimer) { clearTimeout(state.ghTimer); state.ghTimer = null; pushToGitHub().catch(() => {}); } });
}
/** Offline: say so, grey out what needs the network, and file what was queued when it comes back. */
function wireOffline() {
  const apply = () => {
    state.online = navigator.onLine !== false;
    document.body.classList.toggle("offline", !state.online);
    const bar = $("#offline"); if (bar) bar.hidden = state.online;
  };
  window.addEventListener("online", () => { apply(); toast("Back online"); refreshFeed().catch(() => {}); if (isCurator()) { replayQueued().catch(() => {}); if (tokenValid()) pullRatings(); } });
  window.addEventListener("offline", () => { apply(); toast("Offline — the last feed stays; keeps are queued and filed when you are back", true); });
  apply();
}

function boot() {
  $("#meta").textContent = "loading feed…"; $("#feed-failed").hidden = true;
  load().catch(e => { $("#meta").textContent = "The feed did not load. (" + e.message + ")"; $("#empty").hidden = false; $("#empty").textContent = state.online ? "No feed yet — run the Discover workflow once, or try again." : "Offline, and no feed cached yet."; $("#feed-failed").hidden = false; });
}
wire();
boot();
