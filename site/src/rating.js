// @ts-check
/* Keep / skip / Undo. Optimistic: the card disappears at once; YouTube and the Drive mirror follow. */
import { state, persist, byId, skipsInYouTube, quotaLeft } from "./state.js";
import { $, toast } from "./dom.js";
import { isCurator, ensureToken, needSignIn } from "./auth.js";
import { yearGuess, yearOf } from "./years.js";
import { schedulePush } from "./sync.js";
import { titleFor, skippedTitle, playlistFor, skippedPlaylist, addToPlaylist, removePlaylistItem, playlistItemsFor } from "./youtube.js";
import { render, deckOn, deckItem, focusCard } from "./render.js";
import { play, stopPlayer } from "./player.js";
import { credit } from "./feed.js";

const UP = "\u25B2\uFE0E", DN = "\u25BC\uFE0E";   // the same text-presentation triangles as the buttons

/** @param {string} id @param {"up" | "down"} decision @param {number | undefined} [year] */
export async function rate(id, decision, year) {
  if (!isCurator()) return;
  if (state.busy.has(id)) return;
  const it = byId(id); if (!it) return;
  const vid = it.youtube && it.youtube.videoId;
  if (!vid) { toast("No YouTube match for this one — open it via the search link instead", true); return; }
  if (decision === "up" && !year && yearGuess(it) == null) {
    // nothing says when this came out — never guess "this year" on your behalf
    const sel = $(`.card[data-id="${CSS.escape(id)}"] .year, .dcard[data-id="${CSS.escape(id)}"] .year`);
    if (sel) { sel.focus(); sel.classList.add("attention"); setTimeout(() => sel.classList.remove("attention"), 1500); }
    toast(`Release year unknown for ${credit(it)} — pick the year playlist first (the YT Music link may show it)`, true);
    return;
  }
  year = year || yearOf(it);
  if (decision === "up" || skipsInYouTube()) { if (!(await ensureToken())) { needSignIn("Could not refresh your Google sign-in"); return; } }
  state.busy.add(id);
  // optimistic: hide it now, move focus to the next card
  state.rated[id] = { decision, year, videoId: vid, artist: it.artist, title: it.display_title || it.title, at: Date.now(), pending: true };
  persist();
  const wasCurrent = state.currentId === id; const idx = state.order.indexOf(id);
  render();
  if (deckOn()) { const nxt = deckItem(); if (nxt && wasCurrent && $("#autoplay").checked && nxt.youtube?.videoId) play(nxt.id); else if (wasCurrent && !nxt) stopPlayer(); if (nxt) render(); }
  else if (state.view === "feed") { const next = state.order[idx] || state.order[idx - 1]; if (next) { focusCard(next); if (wasCurrent && $("#autoplay").checked && byId(next)?.youtube?.videoId) play(next); } else if (wasCurrent) stopPlayer(); }
  if (decision === "down" && !skipsInYouTube()) {
    // free: no YouTube quota. Synced across your devices through the Drive app-data file.
    state.rated[id] = { ...state.rated[id], pending: false, local: true }; persist(); state.busy.delete(id); render(); schedulePush();
    toast(`${DN} ${credit(it)}`, false, { label: "Undo", fn: () => undo(id) });
    return;
  }
  try {
    const pid = decision === "up" ? await playlistFor(String(year)) : await skippedPlaylist();
    if (decision === "up") {
      // never file the same video twice (1 quota unit to check)
      const present = await playlistItemsFor(pid, vid);
      if (present.length) {
        state.rated[id] = { ...state.rated[id], pending: false, duplicate: true, playlistId: pid };
        persist(); schedulePush(); state.busy.delete(id); render();
        toast(`Already in ${titleFor(year)} — ${credit(it)} was not added again`, false, { label: "Undo", fn: () => undo(id) });
        return;
      }
    }
    const itemId = await addToPlaylist(pid, vid);
    state.rated[id] = { ...state.rated[id], playlistItemId: itemId, playlistId: pid, pending: false };
    persist(); schedulePush();
    const left = Math.floor(quotaLeft() / 50);
    toast((decision === "up" ? `${UP} ${credit(it)} → ${titleFor(year)}` : `${DN} ${credit(it)} → ${skippedTitle()}`) + (left < 40 ? ` · ${left} saves left today` : ""), false, { label: "Undo", fn: () => undo(id) });
  } catch (e) {
    delete state.rated[id]; persist(); render();
    const msg = /** @type {Error} */ (e).message;
    if (/sign-in needs a refresh/i.test(msg)) needSignIn(`Could not file ${credit(it)}`); else toast(`Could not file ${credit(it)}: ${msg}`, true);
  } finally { state.busy.delete(id); render(); }
}
/** @param {string} id */
export async function undo(id) {
  const r = state.rated[id]; if (!r || r.decision === "undone") return;
  try {
    if (r.playlistItemId) await removePlaylistItem(r.playlistItemId);
    state.rated[id] = { decision: "undone", at: Date.now() };   // a tombstone: other devices un-hide it too
    persist(); render(); schedulePush(); toast("Undone");
  } catch (e) { toast("Undo failed: " + /** @type {Error} */ (e).message, true); }
}
