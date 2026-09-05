// @ts-check
/* Which year a card files into, and how the badge explains it. Pure: no DOM beyond the select it fills. */
import { state } from "./state.js";

/** @typedef {import("./types").FeedItem} FeedItem */

// The build already weighed every date it could find (catalogues, store dates, the YouTube album year); when it says
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
/** @param {HTMLSelectElement} ysel @param {FeedItem} it */
export function fillYearSelect(ysel, it) {
  const g = yearGuess(it);
  ysel.innerHTML = (g == null ? `<option value="">year?</option>` : "") + state._years.map(y => `<option value="${y}">${y}</option>`).join("");
  ysel.value = g == null ? "" : String(g); ysel.classList.toggle("unknown", g == null);
}
/** @type {Record<string, string>} */
export const YEAR_SOURCE = { musicbrainz: "verified: MusicBrainz's earliest release of this exact recording (identified via ListenBrainz)", "musicbrainz-search": "verified: earliest MusicBrainz release matching artist + title", "musicbrainz-isrc": "verified: earliest MusicBrainz release sharing this track's ISRC", discogs: "verified: Discogs master (original issue) year", deezer: "earliest release on Deezer", itunes: "earliest release on Apple Music", "release-date": "the release date the source itself stated", "ytmusic-year": "the release year YouTube Music states on the artist page", isrc: "from the ISRC registration year only", youtube: "from the YouTube album only", "feed-date": "from the blog post date only — check it", unknown: "no release date found anywhere — pick the year yourself" };
/** The badge text: verified year, unverified guess, reissue notice, or "year unknown". @param {FeedItem} it */
export function yearBadge(it) {
  const conf = it.year_confidence || "low";
  let text = it.original_year ? `reissue? originally ${it.original_year}`
    : it.year_source === "unknown" ? (yearGuess(it) == null ? "year unknown" : `${yearGuess(it)}? · unverified`)
    : (conf === "high" ? `${yearOf(it)} ✓` : conf === "medium" ? `${yearOf(it)}` : `${yearOf(it)} ?`);
  if (Number.isFinite(it.year) && /** @type {number} */ (it.year) < new Date().getFullYear() - 1 && it.year_source !== "unknown") text += " · catalog";
  return { text, conf, title: (YEAR_SOURCE[it.year_source || ""] || "") + ((it.year_evidence || []).length ? "\n" + (it.year_evidence || []).join("\n") : "") };
}
/** @param {string} r */
export const isMatchReason = r => /^(you play |similar to |.* is in your playlists$)/.test(r);
/** @param {FeedItem} it */
export function matchLabel(it) {
  if (it.match_kind === "direct") return it.matched_artist === it.artist ? "you play them" : "you play " + it.matched_artist;
  if (it.match_kind === "saved") return it.matched_artist === it.artist ? "in your playlists" : it.matched_artist + " is in your playlists";
  if (it.match_kind === "similar") return (it.reasons || []).find(r => r.startsWith("similar to ")) || "similar artist";
  return "";
}
