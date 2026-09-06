// @ts-check
/* The artist sheet: everything the feed and the catalog hold by one act, what the profile makes of them, what you
 * have kept or skipped of theirs, and their neighbours in today's feed. Opened from the artist name on a card, from
 * the [you play X] / [similar to X] label, or a ?artist=<name> link. */
import { state, allItems, decisionFor } from "./state.js";
import { $, esc, sameName } from "./dom.js";
import { isCurator } from "./auth.js";
import { play } from "./player.js";
import { searchFor, credit } from "./feed.js";
import { matchLabel } from "./years.js";
import { scoreOf } from "./rank.js";
import { openLayer } from "./url.js";

/** @typedef {import("./types").FeedItem} FeedItem */

/** Names in a "similar to A, B" reason. @param {FeedItem} it */
const similarNames = it => (it.reasons || []).filter(r => r.startsWith("similar to ")).flatMap(r => r.slice(11).split(", ")).map(s => s.trim()).filter(Boolean);

/** @param {string} name */
export function openArtist(name) {
  const dlg = /** @type {HTMLDialogElement} */ ($("#artist")); if (!dlg || !name) return;
  const mine = allItems().filter(i => sameName(i.artist, name));
  const inFeed = mine.filter(i => !i.plays && i.plays == null), inCat = mine.filter(i => i.plays != null);
  const first = mine[0];
  const match = first && first.match_kind ? matchLabel(first) : "";
  /** @type {Set<string>} */
  const similar = new Set(mine.flatMap(similarNames));
  // acts the profile sees as this one's neighbours: their cards say "similar to <name>"
  /** @type {Map<string, number>} */
  const neighbours = new Map();
  for (const i of allItems()) if (!sameName(i.artist, name) && similarNames(i).some(n => sameName(n, name))) neighbours.set(i.artist, (neighbours.get(i.artist) || 0) + 1);
  const rated = Object.entries(state.rated).filter(([, r]) => r && sameName(r.artist, name) && (r.decision === "up" || r.decision === "down"));
  const kept = rated.filter(([, r]) => r.decision === "up").length, skipped = rated.length - kept;
  /** @param {FeedItem} i */
  const row = i => {
    const d = decisionFor(i.id); const yt = /** @type {Partial<import("./types").YouTubeMatch>} */ (i.youtube || {});
    const status = i._pick ? "kept" : d ? (d.decision === "up" ? "kept" : d.decision === "down" ? "skipped" : "") : "";
    return `<div class="arow${state.playingId === i.id ? " current" : ""}" data-id="${esc(i.id)}">
      <button type="button" class="btn small aplay" ${yt.videoId ? "" : "disabled"} title="${yt.videoId ? "play" : "no YouTube match"}" aria-label="play ${esc(credit(i))}">▶&#xFE0E;</button>
      <span class="atitle"><b>${esc(i.display_title || i.title)}</b>${i.release && !sameName(i.release, i.title) ? ` <span class="muted">· ${esc(i.release)}</span>` : ""}${i.year ? ` <span class="muted">· ${esc(i.year)}</span>` : ""}</span>
      <span class="aspec">${i.plays != null ? `${i.plays} plays` : (i.sources || []).map(s => s.split(":").slice(-1)[0]).slice(0, 3).join(", ")}</span>
      <span class="ascore">${i.score ? scoreOf(i).toFixed(1) : ""}</span>
      <span class="astatus ${status}">${status}</span>
    </div>`;
  };
  $("#artist-name").textContent = name;
  $("#artist-body").innerHTML = `
    <p class="muted">${match ? `<span class="match ${esc(first.match_kind || "")}">${esc(match)}</span> · ` : ""}${inFeed.length} in the feed${inCat.length ? ` · ${inCat.length} in the catalog` : ""}${isCurator() && rated.length ? ` · you kept ${kept} and skipped ${skipped} of theirs` : ""}</p>
    ${similar.size ? `<p class="muted">similar to ${[...similar].map(n => `<button type="button" class="linkish aopen" data-artist="${esc(n)}">${esc(n)}</button>`).join(", ")}</p>` : ""}
    ${neighbours.size ? `<p class="muted">neighbours in the feed: ${[...neighbours.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, c]) => `<button type="button" class="linkish aopen" data-artist="${esc(n)}">${esc(n)}</button>${c > 1 ? ` <span class="muted">×${c}</span>` : ""}`).join(", ")}</p>` : ""}
    <div class="alist">${mine.sort((a, b) => scoreOf(b) - scoreOf(a)).map(row).join("") || `<p class="muted">Nothing by them in the feed or the catalog right now.</p>`}</div>
    <div class="row">
      <button type="button" class="btn ghost small" id="artist-filter">only ${esc(name)} in the list</button>
      <a class="btn ghost small" href="https://www.last.fm/music/${encodeURIComponent(name)}" target="_blank" rel="noopener">last.fm</a>
      <a class="btn ghost small" href="https://music.youtube.com/search?q=${encodeURIComponent(name)}" target="_blank" rel="noopener">YT Music</a>
      <a class="btn ghost small" href="https://musicbrainz.org/search?query=${encodeURIComponent(name)}&type=artist&method=indexed" target="_blank" rel="noopener">MusicBrainz</a>
    </div>`;
  $("#artist-body").querySelectorAll(".aplay").forEach(b => b.addEventListener("click", () => { const id = /** @type {HTMLElement} */ (b.closest(".arow")).dataset.id; if (id) { play(id); $("#artist-body").querySelectorAll(".arow").forEach(r => r.classList.toggle("current", /** @type {HTMLElement} */ (r).dataset.id === id)); } }));
  $("#artist-body").querySelectorAll(".aopen").forEach(b => b.addEventListener("click", () => openArtist(/** @type {HTMLElement} */ (b).dataset.artist || "")));
  $("#artist-filter").addEventListener("click", () => { dlg.close(); searchFor(`artist:"${name}"`, { add: false }); });
  if (!dlg.open) dlg.showModal(); else openLayer(dlg.id, () => { if (dlg.open) dlg.close(); });
}
