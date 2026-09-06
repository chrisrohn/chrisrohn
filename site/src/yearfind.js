// @ts-check
/* "find year": a one-tap MusicBrainz lookup from the browser for a card the build could not date.
 *
 * MusicBrainz's web service answers cross-origin requests, so the same question the build asks (the recordings that
 * match artist + title, and the earliest release of each) can be asked here on demand, one card at a time, at the
 * one-request-a-second pace MusicBrainz asks for. The answer goes into the card's year select, with the evidence in
 * the badge's tooltip, and Keep files it there. Nothing is written anywhere until the thumb. */
import { $, esc, toast } from "./dom.js";

/** @typedef {import("./types").FeedItem} FeedItem */

const MB = "https://musicbrainz.org/ws/2/recording";
const EXCLUDE = /compilation|live|dj-mix|remix|mixtape/i;
let last = 0;   // MusicBrainz asks for one request per second per client

/** @param {string} s */
const norm = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** @param {string} s */
const core = s => norm(String(s || "").replace(/\s*[([][^)\]]*[)\]]\s*$/g, "").replace(/\s+-\s+[^-]+$/, "").replace(/\s+(feat|ft)\.?\s.*$/i, ""));
/** @param {string} s */
const lucene = s => s.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, " ").replace(/\s+/g, " ").trim();

/** Every year MusicBrainz knows for recordings that match the card, earliest first. @param {FeedItem} it */
export async function findYears(it) {
  const wait = 1100 - (Date.now() - last); if (wait > 0) await new Promise(r => setTimeout(r, wait));
  last = Date.now();
  const title = it.display_title || it.title;
  const q = `artist:"${lucene(it.artist)}" AND recording:"${lucene(title)}"`;
  const r = await fetch(`${MB}?query=${encodeURIComponent(q)}&fmt=json&limit=15`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`MusicBrainz answered ${r.status}`);
  const data = await r.json();
  const ours = norm(it.artist), want = core(title);
  /** @type {{year: number, release: string, date: string}[]} */
  const found = [];
  for (const rec of data.recordings || []) {
    const credit = (rec["artist-credit"] || []).map((/** @type {any} */ c) => norm(c.name || c.artist?.name || "")).join(" ");
    if (!credit.includes(ours) && !ours.includes(credit)) continue;
    if (core(rec.title) !== want) continue;
    for (const rel of rec.releases || []) {
      const rg = rel["release-group"] || {}; const types = [...(rg["secondary-types"] || []), rg["primary-type"] || ""].join(" ");
      if (EXCLUDE.test(types)) continue;
      const date = rg["first-release-date"] || rel.date || ""; const y = parseInt(date.slice(0, 4), 10);
      if (Number.isFinite(y)) found.push({ year: y, release: rel.title || rg.title || "?", date });
    }
  }
  found.sort((a, b) => a.year - b.year || a.date.localeCompare(b.date));
  return found;
}

/** The control on a card with no year: ask MusicBrainz, fill the year select, explain in the badge. @param {HTMLElement} el @param {FeedItem} it */
export function addYearFinder(el, it) {
  const host = $(".links, .dlinks", el); if (!host) return;
  const b = document.createElement("button"); b.type = "button"; b.className = "share find-year"; b.textContent = "find year"; b.title = "ask MusicBrainz for this recording's earliest release";
  b.addEventListener("click", async e => {
    e.stopPropagation(); b.disabled = true; b.textContent = "asking…";
    try {
      const years = await findYears(it);
      const sel = $(".year", el); const badge = $(".yearbadge", el);
      if (!years.length) { b.textContent = "no match"; toast(`MusicBrainz has no dated release for ${it.artist} – ${it.display_title || it.title} — try the Discogs link`, true); return; }
      const best = years[0];
      if (sel) { sel.value = String(best.year); sel.classList.remove("unknown"); sel.classList.add("attention"); setTimeout(() => sel.classList.remove("attention"), 1500); }
      if (badge) { badge.textContent = `${best.year} · MusicBrainz`; badge.className = "yearbadge medium"; badge.title = years.slice(0, 8).map(y => `${y.year} · ${y.release}`).join("\n"); }
      b.textContent = `${best.year} (${years.length} release${years.length === 1 ? "" : "s"})`;
      toast(`${it.artist} – ${it.display_title || it.title}: earliest release ${best.year} (${esc(best.release)}) — Keep files it there`);
    } catch (err) { b.disabled = false; b.textContent = "find year"; toast("Year lookup failed: " + /** @type {Error} */ (err).message, true); }
  });
  host.appendChild(b);
}

/** A Discogs search for the card, for the ones nobody has catalogued. @param {FeedItem} it */
export const discogsSearch = it => `https://www.discogs.com/search/?q=${encodeURIComponent(`${it.artist} ${it.display_title || it.title}`)}&type=all`;
