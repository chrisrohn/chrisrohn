// @ts-check
/* Chris Rohn's New Music — client entry point.
 * Reads data/feed.json (built daily by GitHub Actions). Anyone can listen.
 * Sign in with Google (one of the configured curator accounts) to get curator mode:
 *   👍 → added straight to "<year> | Indie Discotheque" (the library playlists) on YouTube Music (YouTube Data API v3, from this browser)
 *   👎 → added to the unlisted "Skipped" playlist so it never comes back
 * Nothing is written anywhere until you press a thumb. Undo is available for a few seconds after each one.
 */
import { state, persist } from "./state.js";
import { $, $$, toast } from "./dom.js";
import { isSignedIn, isCurator, tokenValid, signIn, signOut } from "./auth.js";
import { pullRatings } from "./sync.js";
import { load } from "./feed.js";
import { render, deckOn, deckItem, deckYear } from "./render.js";
import { rate } from "./rating.js";
import { play, toggle, nextTrack, prevTrack, holdAudition } from "./player.js";
import { wireSettings } from "./settings.js";
import { wireKeys, currentYear } from "./keys.js";
import { wirePwa, applyLaunchParams } from "./pwa.js";

function wire() {
  $$(".tab").forEach(b => b.addEventListener("click", () => { state.view = b.dataset.view; $$(".tab").forEach(x => x.classList.toggle("active", x === b)); render(); }));
  const f = state.filters;
  $("#q").value = f.q; $("#sort").value = f.sort; $("#only-new").checked = f.onlyNew; $("#only-playable").checked = f.onlyPlayable; $("#only-known").checked = f.onlyKnown; $("#only-recent").checked = f.onlyRecent;
  /** @type {any} */ let qTimer;
  $("#q").addEventListener("input", (/** @type {any} */ e) => { f.q = e.target.value; clearTimeout(qTimer); qTimer = setTimeout(() => { persist(); render(); }, 120); });
  $("#sort").addEventListener("change", (/** @type {any} */ e) => { f.sort = e.target.value; persist(); render(); });
  $("#only-new").addEventListener("change", (/** @type {any} */ e) => { f.onlyNew = e.target.checked; persist(); render(); });
  $("#only-playable").addEventListener("change", (/** @type {any} */ e) => { f.onlyPlayable = e.target.checked; persist(); render(); });
  $("#only-known").addEventListener("change", (/** @type {any} */ e) => { f.onlyKnown = e.target.checked; persist(); render(); });
  $("#only-recent").addEventListener("change", (/** @type {any} */ e) => { f.onlyRecent = e.target.checked; persist(); render(); });
  $("#signin").addEventListener("click", () => { if (isSignedIn()) signOut(); else signIn().catch(e => toast(e.message, true)); });
  $("#p-next").addEventListener("click", nextTrack); $("#p-prev").addEventListener("click", prevTrack); $("#p-toggle").addEventListener("click", () => { holdAudition(); toggle(); });
  $("#yt").addEventListener("click", holdAudition, true);
  $("#deck-up").addEventListener("click", () => { const it = deckItem(); if (it) rate(it.id, "up", deckYear()); });
  $("#deck-down").addEventListener("click", () => { const it = deckItem(); if (it) rate(it.id, "down", deckYear()); });
  $("#deck-play").addEventListener("click", () => { const it = deckItem(); if (!it?.youtube?.videoId) return; if (state.currentId === it.id && state.playerReady) { holdAudition(); toggle(); $("#deck-play").textContent = $("#deck-play").textContent.startsWith("⏸") ? "▶\uFE0E" : "⏸\uFE0E"; } else play(it.id); });
  $("#deck-next").addEventListener("click", () => { state.deckIndex++; render(); const it = deckItem(); if (it?.youtube?.videoId && state.currentId) play(it.id); });
  $("#deck-prev").addEventListener("click", () => { state.deckIndex = Math.max(0, state.deckIndex - 1); render(); });
  $("#layout-toggle").addEventListener("click", () => { state.settings.deck = !deckOn(); persist(); render(); });
  const toggleFilters = () => { const open = document.body.classList.toggle("filters-open"); $("#filters-more").textContent = open ? "hide filters ▴" : "filters ▾"; $("#filters-more").setAttribute("aria-expanded", String(open)); };
  $("#deck-filters").addEventListener("click", toggleFilters); $("#filters-more").addEventListener("click", toggleFilters);
  // keep the pinned deck buttons above the player bar whatever its height
  const playerEl = $("#player");
  const setPlayerH = () => document.documentElement.style.setProperty("--player-h", playerEl.hidden ? "0px" : playerEl.getBoundingClientRect().height + "px");
  new ResizeObserver(setPlayerH).observe(playerEl); new MutationObserver(setPlayerH).observe(playerEl, { attributes: true, attributeFilter: ["hidden"] }); setPlayerH();
  window.matchMedia("(max-width: 760px)").addEventListener("change", () => render());
  $("#p-up").addEventListener("click", () => state.currentId && rate(state.currentId, "up", currentYear()));
  $("#p-down").addEventListener("click", () => state.currentId && rate(state.currentId, "down", currentYear()));
  wireSettings();
  wireKeys();
  wirePwa();
  applyLaunchParams();   // after the controls are wired: ?view=picks, ?new=1, ?audition=1 from the app shortcuts
  // another device may have rated things while this tab was in the background (only while the token is valid:
  // a background refresh would need a popup, which browsers block without a tap — the next 👍 refreshes it instead)
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && isCurator() && tokenValid() && Date.now() - (state.sync.at || 0) > 60e3) pullRatings(); });
}

wire();
load().catch(e => { $("#meta").textContent = "Feed not built yet — run the Discover workflow once. (" + e.message + ")"; $("#empty").hidden = false; $("#empty").textContent = "No feed yet."; });
