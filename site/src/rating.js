// @ts-check
/* Keep / skip / Undo. Optimistic: the card disappears at once; YouTube, the Drive mirror and the ratings file follow.
 * Offline, a keep is queued and filed the moment the network is back. */
import { state, persist, byId, skipsInYouTube, quotaLeft } from "./state.js";
import { $, toast } from "./dom.js";
import { isCurator, ensureToken, needSignIn } from "./auth.js";
import { yearGuess, yearOf } from "./years.js";
import { schedulePush } from "./sync.js";
import { titleFor, skippedTitle, playlistFor, skippedPlaylist, addToPlaylist, removePlaylistItem, playlistItemsFor, knownYear } from "./youtube.js";
import { render, deckOn, deckItem, focusCard } from "./render.js";
import { play, stopPlayer, playerActive, autoplayOn } from "./player.js";
import { credit } from "./feed.js";

const UP = "▲︎", DN = "▼︎";   // the same text-presentation triangles as the buttons

/** Move on from a card that just left the list: focus (and, if it was playing, play) the next one. @param {string} id @param {number} idx @param {boolean} wasPlaying */
function moveOn(id, idx, wasPlaying) {
  if (deckOn()) { const nxt = deckItem(); if (nxt && wasPlaying && autoplayOn() && nxt.youtube?.videoId) play(nxt.id); else if (wasPlaying && !nxt) stopPlayer(); }
  else if (state.view === "feed" || state.view === "catalog") { const next = state.order[idx] || state.order[idx - 1]; if (next) { focusCard(next); if (wasPlaying && autoplayOn() && byId(next)?.youtube?.videoId) play(next); } else if (wasPlaying) stopPlayer(); }
}

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
  const needsYouTube = decision === "up" || skipsInYouTube();
  const wasPlaying = state.playingId === id && playerActive(); const idx = state.order.indexOf(id);
  const base = { decision, year, videoId: vid, artist: it.artist, title: it.display_title || it.title, sources: it.sources || [], tags: it.tags || [], at: Date.now() };
  if (needsYouTube && !state.online) {
    // no network: remember the decision, hide the card, file it when the connection is back (see replayQueued)
    state.rated[id] = { ...base, queued: true, pending: true }; state.lastRated = id; persist(); render(); moveOn(id, idx, wasPlaying);
    toast(`${decision === "up" ? UP : DN} ${credit(it)} — queued, files when you are back online`, false, { label: "Undo", fn: () => undo(id) });
    return;
  }
  if (needsYouTube) { if (!(await ensureToken())) { needSignIn("Could not refresh your Google sign-in"); return; } }
  state.busy.add(id);
  // optimistic: hide it now, move focus to the next card
  // the card's sources and tags travel with the rating: the personal ranking and the stats learn from them later
  state.rated[id] = { ...base, pending: true }; state.lastRated = id;
  persist();
  render();
  moveOn(id, idx, wasPlaying);
  if (decision === "down" && !skipsInYouTube()) {
    // free: no YouTube quota. Synced across your devices through the Drive app-data file (and the ratings file).
    state.rated[id] = { ...state.rated[id], pending: false, local: true }; persist(); state.busy.delete(id); schedulePush();
    toast(`${DN} ${credit(it)}`, false, { label: "Undo", fn: () => undo(id) });
    return;
  }
  try {
    const pid = decision === "up" ? await playlistFor(String(year)) : await skippedPlaylist();
    if (decision === "up") {
      // never file the same video twice. This year's playlist was read a moment ago (refreshRecent), so the 1-unit
      // probe is only spent when that reading is stale or the target is another year
      const fresh = pid === (knownYear(year) || state.playlists[String(year)]) && String(year) === String(new Date().getFullYear()) && Date.now() - state.recentAt < 30 * 60e3;
      const present = fresh ? (state.recentVideos.has(vid) ? ["known"] : []) : await playlistItemsFor(pid, vid);
      if (present.length) {
        state.rated[id] = { ...state.rated[id], pending: false, duplicate: true, playlistId: pid };
        persist(); schedulePush(); state.busy.delete(id);
        toast(`Already in ${titleFor(year)} — ${credit(it)} was not added again`, false, { label: "Undo", fn: () => undo(id) });
        return;
      }
    }
    const itemId = await addToPlaylist(pid, vid);
    state.rated[id] = { ...state.rated[id], playlistItemId: itemId, playlistId: pid, pending: false };
    if (decision === "up") state.recentVideos.add(vid);
    persist(); schedulePush();
    const left = Math.floor(quotaLeft() / 50);
    toast((decision === "up" ? `${UP} ${credit(it)} → ${titleFor(year)}` : `${DN} ${credit(it)} → ${skippedTitle()}`) + (left < 40 ? ` · ${left} saves left today` : ""), false, { label: "Undo", fn: () => undo(id) });
  } catch (e) {
    delete state.rated[id]; persist(); render();
    const msg = /** @type {Error} */ (e).message;
    if (/sign-in needs a refresh/i.test(msg)) needSignIn(`Could not file ${credit(it)}`); else toast(`Could not file ${credit(it)}: ${msg}`, true);
  } finally { state.busy.delete(id); }
}
/** @param {string} id */
export async function undo(id) {
  const r = state.rated[id]; if (!r || r.decision === "undone") return;
  try {
    if (r.playlistItemId) await removePlaylistItem(r.playlistItemId);
    state.rated[id] = { decision: "undone", at: Date.now() };   // a tombstone: other devices un-hide it too
    if (state.lastRated === id) state.lastRated = null;
    persist(); render(); schedulePush(); toast("Undone");
  } catch (e) { toast("Undo failed: " + /** @type {Error} */ (e).message, true); }
}
/** The z key: take back the last thumb. */
export function undoLast() {
  const id = state.lastRated; const r = id && state.rated[id];
  if (!id || !r || r.decision === "undone") { toast("Nothing to undo"); return; }
  const it = byId(id);
  undo(id).then(() => { if (it) { if (deckOn()) { const i = state.order.indexOf(id); if (i >= 0) { state.deckIndex = i; render(); } } else focusCard(id); } });
}
/** Restore a batch of skips (the Skipped tab's "restore all"). Local skips are free; skips filed on YouTube cost a removal each. @param {string[]} ids */
export async function restoreAll(ids) {
  const filed = ids.filter(id => state.rated[id]?.playlistItemId).length;
  if (!ids.length) return;
  if (!confirm(`Restore ${ids.length} skipped track${ids.length === 1 ? "" : "s"} to the feed?${filed ? ` ${filed} of them sit in the Skipped playlist on YouTube: ${filed * 50} quota units to take them out.` : ""}`)) return;
  let n = 0;
  for (const id of ids) { const r = state.rated[id]; if (!r || r.decision !== "down") continue; try { if (r.playlistItemId) await removePlaylistItem(r.playlistItemId); state.rated[id] = { decision: "undone", at: Date.now() }; n++; } catch (e) { toast("Could not restore one: " + /** @type {Error} */ (e).message, true); break; } }
  persist(); render(); schedulePush(); toast(`Restored ${n}`);
}
/** Back online: file what was decided while offline, oldest first. */
export async function replayQueued() {
  const queued = Object.entries(state.rated).filter(([, r]) => r && r.queued && (r.decision === "up" || r.decision === "down")).sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
  if (!queued.length || !isCurator()) return;
  toast(`Back online — filing ${queued.length} queued rating${queued.length === 1 ? "" : "s"}`);
  for (const [id, r] of queued) {
    if (!byId(id)) { state.rated[id] = { ...r, queued: false, pending: false, local: r.decision === "down" }; continue; }   // the track left the feed: keep the decision, nothing to file
    delete state.rated[id];
    await rate(id, /** @type {"up" | "down"} */ (r.decision), typeof r.year === "number" ? r.year : undefined);
  }
  persist(); render();
}
