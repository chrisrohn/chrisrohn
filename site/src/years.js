// @ts-check
/* Which year a card files into, and how the badge explains it. Pure: no DOM beyond the select it fills. */
import { state } from "./state.js";

/** @typedef {import("./types").FeedItem} FeedItem */

// The build already weighed every date it could find (catalogues, store dates, the YouTube album year, the release
// date YouTube Music states for the upload); when it says
// "unknown" the only date left is the day a blog or channel mentioned the track, and that is not a release year.
// null here makes the card show "year?" and Keep asks you to pick. Picks carry their playlist year in _year.
/** @param {FeedItem} it @returns {number | null} */
export const yearGuess = it => {
  if (Number.isFinite(it.year)) return /** @type {number} */ (it.year);
  if (it._pick) { const y = parseInt(String(it._year || it.release_date || ""), 10); return Number.isFinite(y) ? y : null; }
  return null;
};
/** @param {FeedItem} it */
export const yearOf = it => yearGuess(it) ?? new Date().getFullYear();
/** The year playlist nearest a year: that year when it has one, else the closest there is (the later on a tie), so a
 * song from before the first playlist (or after the last) files into the nearest instead of failing. Unchanged while
 * the feed's year list is not in. @param {number} y @returns {number} */
export function nearestYear(y) {
  const ys = (state._years || []).map(Number).filter(Number.isFinite);
  if (!ys.length || ys.includes(y)) return y;
  return ys.reduce((b, c) => { const dc = Math.abs(c - y), db = Math.abs(b - y); return dc < db || (dc === db && c > b) ? c : b; });
}
/** The release a card belongs to: the original when the build found an earlier one (a reissue, a remaster, a new
 * upload of an old recording), else its own year; null when unknown. @param {FeedItem} it @returns {number | null} */
export const originalYear = it => {
  const g = yearGuess(it); if (g == null) return null;
  const o = Number(it.original_year);
  return Number.isFinite(o) && o > 0 && o < g ? o : g;
};
/** The year playlist a card files into: the playlist nearest its original release. @param {FeedItem} it @returns {number | null} */
export const fileYear = it => { const o = originalYear(it); return o == null ? null : nearestYear(o); };
/** @param {HTMLSelectElement} ysel @param {FeedItem} it */
export function fillYearSelect(ysel, it) {
  const g = fileYear(it);
  ysel.innerHTML = (g == null ? `<option value="">year?</option>` : "") + state._years.map(y => `<option value="${y}">${y}</option>`).join("");
  ysel.value = g == null ? "" : String(g); ysel.classList.toggle("unknown", g == null);
}
/** @type {Record<string, string>} */
export const YEAR_SOURCE = { musicbrainz: "verified: MusicBrainz's earliest release of this exact recording (identified via ListenBrainz)", "musicbrainz-search": "verified: earliest MusicBrainz release matching artist + title", "musicbrainz-isrc": "verified: earliest MusicBrainz release sharing this track's ISRC", discogs: "verified: Discogs master (original issue) year", deezer: "earliest release on Deezer", itunes: "earliest release on Apple Music", "release-date": "the release date the source itself stated", "ytmusic-year": "the release year YouTube Music states on the artist page", isrc: "from the ISRC registration year only", youtube: "from the YouTube album only", "ytmusic-date": "from the release date YouTube Music states for this upload only — the catalogues have no date", "feed-date": "from the blog post date only — check it", reissue: "a remaster / reissue: its own date is the reissue's, and no catalogue knows the original yet — find year asks MusicBrainz, or pick the original year yourself", anniversary: "the anniversary edition's year minus its anniversary (a catalogue date replaces it when one is found)", unknown: "no release date found anywhere — find year asks MusicBrainz, or pick the year yourself", pending: "not looked up yet — the next build will; Keep asks for the year meanwhile" };
/** The badge text: verified year, unverified guess, reissue notice, or "year unknown". @param {FeedItem} it */
export function yearBadge(it) {
  const conf = it.year_confidence || "low";
  const mark = conf === "high" ? " ✓" : conf === "medium" ? "" : " ?";
  let text = it.reissue_year && it.original_year ? `${it.original_year}${mark} · reissue ${it.reissue_year}`
    : it.original_year ? `reissue? originally ${it.original_year}`
    : it.year_source === "reissue" ? `reissue${it.reissue_year ? " " + it.reissue_year : ""} · year?`
    : it.year_source === "pending" ? "year pending"
    : it.year_source === "unknown" ? (yearGuess(it) == null ? "year unknown" : `${yearGuess(it)}? · unverified`)
    : (conf === "high" ? `${yearOf(it)} ✓` : conf === "medium" ? `${yearOf(it)}` : `${yearOf(it)} ?`);
  // an older year the build pulled in on purpose says so; anything else old in the feed is a warning (radio and
  // recommendations surface catalogue too), and in the Catalog tab an older year is the point
  // where it files when that is not the year named: the original, or the nearest year with a playlist
  const named = it.original_year ? originalYear(it) : yearGuess(it), files = fileYear(it);
  if (files != null && files !== named) text += ` · files in ${files}`;
  if (it.backfill) text += " · filling in";
  else if (Number.isFinite(it.year) && /** @type {number} */ (it.year) < new Date().getFullYear() - 1 && it.year_source !== "unknown" && !it.reissue_year && it.plays == null) text += " · catalog";
  return { text, conf, title: (YEAR_SOURCE[it.year_source || ""] || "") + ((it.year_evidence || []).length ? "\n" + (it.year_evidence || []).join("\n") : "") };
}
/** @param {string} r */
export const isMatchReason = r => /^(you play |similar to |a top .* act on Last\.fm$|a top genre act on Last\.fm$|.* is in your playlists$)/.test(r);
/** @param {FeedItem} it */
export function matchLabel(it) {
  if (it.match_kind === "direct") return it.matched_artist === it.artist ? "you play them" : "you play " + it.matched_artist;
  if (it.match_kind === "saved") return it.matched_artist === it.artist ? "in your playlists" : it.matched_artist + " is in your playlists";
  if (it.match_kind === "similar") return (it.reasons || []).find(r => r.startsWith("similar to ")) || "similar artist";
  // a top act of a genre you play, from Last.fm's tag charts: the reason names the tags
  if (it.match_kind === "genre") return (it.reasons || []).find(r => r.startsWith("a top ")) || "your genres";
  return "";
}
