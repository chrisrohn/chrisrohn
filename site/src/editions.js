// @ts-check
/* Which edition of a song a playlist row is, and what problems a song's rows add up to. A port of
 * discovery/editions.py (edition_of) and discovery/profile.py (kinds_of) — keep the three in step. The site needs
 * them for the live playlist scan, for report items older than the rules, and to recompute a song's problems as
 * its copies are cleaned. */

/** Editions whose release year is their own, not the original song's: a verified year says nothing about them. */
export const YEAR_FREE = new Set(["remix", "live", "acoustic", "instrumental", "demo"]);
/** @type {Record<string, number>} */
const RANK = { remix: 7, live: 6, acoustic: 5, instrumental: 4, demo: 3, extended: 2, radio: 1, original: 0 };
/** @type {Record<string, string>} */
export const EDITION_NAME = { original: "original", radio: "radio edit", extended: "extended", remix: "remix", live: "live", acoustic: "acoustic", instrumental: "instrumental", demo: "demo" };

const TAIL_RE = /\s*(?:[([]([^()[\]]*)[)\]]|\s[-–—]\s*([^()[\]\-–—]{2,60}?))\s*$/;
const FEAT_TAIL_RE = /^(?:feat\.?|ft\.?|featuring|with)\s+(.+)$/i;
const PLAIN_RE = /^(?:official(?:\s+(?:music\s+)?(?:video|audio|visuali[sz]er|lyric\s+video|hd\s+video|version))?|(?:music|lyric|hd|hq|4k|full)\s+video|video|audio|visuali[sz]er|lyrics?|hq|hd|4k|explicit|clean|mono|stereo|(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?(?:\s+version)?|remastered\s+version|\d+(?:st|nd|rd|th)[\s-]anniversary(?:\s+(?:edition|version|remaster))?|anniversary\s+edition|deluxe(?:\s+(?:edition|version))?|expanded(?:\s+edition)?|bonus\s+track(?:\s+version)?|reissue|re-issue|original(?:\s+(?:mix|version))?|album\s+version|single|from\s+.{1,60}|taken\s+from\s+.{1,60}|out\s+now.*|new\s+single|premiere|official|prod\.?\s+by\s+.{1,40}|sped\s+up|slowed(?:\s+\+\s+reverb)?)$/i;
/** @type {[string, RegExp][]} */
const RULES = [
  ["live", /^(?:live(?:\s+(?:at|from|in|on|version|session|acoustic|\d{4}).*)?|.*\blive\s+(?:at|from|in|on|session|version)\b.*|.*\bsession\b.*|.*\blive$)$/i],
  ["acoustic", /^(?:acoustic(?:\s+version)?|unplugged|stripped(?:\s+(?:back|down))?|piano\s+version|.*\bacoustic\b.*)$/i],
  ["instrumental", /^(?:instrumental(?:\s+(?:mix|version))?|karaoke(?:\s+version)?|.*\binstrumental$)$/i],
  ["demo", /^(?:demo(?:\s+version)?|.*\bdemo$|rough\s+mix|early\s+version|alternate(?:\s+(?:take|version|mix))?|alt\.?\s+(?:take|version|mix))$/i],
  ["radio", /^(?:radio\s+(?:edit|mix|version)|single\s+(?:edit|version|mix)|(?:short|7"?|7\s*inch)\s+(?:edit|version|mix)|edit(?:ed)?(?:\s+version)?|album\s+edit|clean\s+edit)$/i],
  ["extended", /^(?:extended(?:\s+(?:mix|version|edit|club(?:\s+mix)?|play))?|(?:12"?|12\s*inch)\s+(?:mix|version|edit)|club\s+(?:mix|version|edit)|full\s+length(?:\s+version)?|long\s+version|original\s+extended(?:\s+mix)?|dub(?:\s+(?:mix|version))?)$/i],
  ["remix", /^(?:(.+?)\s+(?:remix|rmx|rework|re-work|re-edit|reedit|edit|dub|bootleg|flip|refix|rerub|version|mix|remake|vip|cover|revisions?|re-?write|rub|re-?recording|reprise|interpretation|reinterpretation|remodel|reconstruction|dubplate|treatment|take|extended(?:\s+(?:mix|remix|edit|play))?)|remix(?:\s+by\s+(.+))?|remixed\s+by\s+.+|(.+?)\s+remix\b.*|mix\s+by\s+(.+))$/i],
];
const YEAR_ONLY_RE = /^(?:19|20)\d\d$/;
/** @param {string} text */
const label = text => { const t = text.replace(/\s+/g, " ").replace(/^[\s\-–—]+|[\s\-–—]+$/g, ""); return t === t.toUpperCase() && t.length <= 4 ? t : t.split(" ").map(w => ((w === w.toUpperCase() && w.length > 1) || /^\d/.test(w)) ? w : w[0].toUpperCase() + w.slice(1)).join(" "); };

/** @typedef {{ core: string, edition: string, label: string, featuring: string[] }} Edition */
/** The song title without its suffixes, the edition those suffixes make it, and what they said. @param {string | null | undefined} title @returns {Edition} */
export function editionOf(title) {
  let t = String(title || "").replace(/\s+/g, " ").trim();
  /** @type {string[]} */ const labels = []; /** @type {string[]} */ let featuring = []; let edition = "original";
  for (let i = 0; i < 5; i++) {
    const m = TAIL_RE.exec(t); if (!m || m.index === 0) break;
    const chunk = (m[1] != null ? m[1] : m[2] || "").trim();
    if (!chunk) { t = t.slice(0, m.index).trimEnd(); continue; }
    const f = FEAT_TAIL_RE.exec(chunk);
    if (f) { featuring = f[1].split(/\s*(?:,|&|\band\b)\s*/).map(x => x.trim()).filter(Boolean).concat(featuring); t = t.slice(0, m.index).trimEnd(); continue; }
    if (YEAR_ONLY_RE.test(chunk) || PLAIN_RE.test(chunk)) { labels.unshift(label(chunk)); t = t.slice(0, m.index).trimEnd(); continue; }
    const rule = RULES.find(([, rx]) => rx.test(chunk)); const kind = rule ? rule[0] : null;
    if (kind == null && m[1] == null) break;   // a dashed tail that names no edition is part of the title
    if (kind != null && RANK[kind] > RANK[edition]) edition = kind;
    labels.unshift(label(chunk)); t = t.slice(0, m.index).trimEnd();
  }
  const m = /\s+(?:feat\.?|ft\.?|featuring)\s+(.+)$/i.exec(t);
  if (m) { featuring = m[1].split(/\s*(?:,|&|\band\b)\s*/).map(x => x.trim()).filter(Boolean).concat(featuring); t = t.slice(0, m.index).trimEnd(); }
  return { core: t.replace(/^[\s\-–—]+|[\s\-–—]+$/g, "") || String(title || "").trim(), edition, label: labels.join(" · "), featuring };
}
/** @param {string} s */
const normName = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, "and").replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim().replace(/^the /, "");
/** The (artist, core title) pair that makes two rows the same song, whatever their edition. @param {string} artist @param {string} title */
export const songKey = (artist, title) => `${normName(artist.replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i, ""))}|${normName(editionOf(title).core)}`;

export const KIND_ORDER = ["same-video", "cross-year", "same-song", "versions"];
/** What each problem is called on the tab. @type {Record<string, string>} */
export const KIND = { "same-video": "extra copy", "cross-year": "two years", "same-song": "several uploads", versions: "versions" };
/** @type {Record<string, string>} */
export const KIND_LONG = { "same-video": "the same video twice in one year playlist", "cross-year": "the same edition filed in two years", "same-song": "different uploads of the same edition", versions: "different editions (remix, edit, live…)" };
/** The problems a song's rows add up to, most mechanical first (the Python has the same rules).
 * @param {Array<{ playlistId?: string | null, year?: string, videoId: string, edition?: string, copies?: number }>} rows */
export function kindsOf(rows) {
  /** @type {Map<string, number>} */ const perPlaylist = new Map();
  /** @type {Map<string, Set<string>>} */ const years = new Map(); /** @type {Map<string, Set<string>>} */ const videos = new Map();
  for (const r of rows) {
    const pk = `${r.playlistId || r.year || ""}|${r.videoId}`; perPlaylist.set(pk, (perPlaylist.get(pk) || 0) + (r.copies || 1));
    const ed = r.edition || "original";
    if (!years.has(ed)) years.set(ed, new Set()); /** @type {Set<string>} */ (years.get(ed)).add(String(r.year || ""));
    if (!videos.has(ed)) videos.set(ed, new Set()); /** @type {Set<string>} */ (videos.get(ed)).add(r.videoId);
  }
  const out = [];
  if ([...perPlaylist.values()].some(n => n > 1)) out.push("same-video");
  if ([...years.values()].some(s => s.size > 1)) out.push("cross-year");
  if ([...videos.values()].some(s => s.size > 1)) out.push("same-song");
  if (videos.size > 1) out.push("versions");
  return out;
}
