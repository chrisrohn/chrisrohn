// @ts-check
/* Keyboard: j/k move, space plays, u/d rate, o opens, a audition, / search, Esc stops. */
import { state, byId } from "./state.js";
import { $, toast } from "./dom.js";
import { rate } from "./rating.js";
import { deckOn, deckItem, focusCard } from "./render.js";
import { play, step, toggle, stopPlayer } from "./player.js";

/** The year chosen on the card for `id`, if any. @param {string | null} [id] */
export function currentYear(id = state.currentId) { const el = id && $(`.card[data-id="${CSS.escape(id)}"] .year, .dcard[data-id="${CSS.escape(id)}"] .year`); return el && el.value ? +el.value : undefined; }

export function wireKeys() {
  document.addEventListener("keydown", e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;   // Cmd+D bookmarks, Ctrl+A selects: never a thumb
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.matches("input, select, textarea") || $("dialog[open]")) return;
    // the card you are on; in list view nothing is "current" until you move to a card, so a stray key can't file the top track
    const id = deckOn() ? (deckItem()?.id || state.currentId) : state.currentId;
    switch (e.key) {
      case "j": case "ArrowDown": e.preventDefault(); state.currentId ? step(1) : focusCard(state.order[0]); break;
      case "k": case "ArrowUp": e.preventDefault(); step(-1); break;
      case " ": e.preventDefault(); if (state.playerReady && state.currentId) toggle(); else play(id || state.order[0]); break;
      case "u": case "ArrowRight": if (id) rate(id, "up", currentYear(id)); break;
      case "d": case "ArrowLeft": if (id) rate(id, "down", currentYear(id)); break;
      case "o": { const it = id ? byId(id) : null; if (it?.youtube?.videoId) window.open("https://music.youtube.com/watch?v=" + it.youtube.videoId, "_blank", "noopener"); break; }
      case "a": { const cb = $("#audition"); cb.checked = !cb.checked; cb.dispatchEvent(new Event("change")); toast(cb.checked ? `Audition mode on (${state.settings.auditionSeconds}s)` : "Audition mode off"); break; }
      case "/": e.preventDefault(); $("#q").focus(); break;
      case "Escape": stopPlayer(); break;
    }
  });
}
