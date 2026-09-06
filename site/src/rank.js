// @ts-check
/* Personal ranking, learned in the browser from this account's keeps and skips — no API quota, nothing sent anywhere.
 *
 * The same maths as discovery/learn.py, on the ratings this device and its Drive mirror know: every rated track kept
 * the sources, tags and artist it had when it was rated, so each source, blog, tag and artist gets a smoothed keep
 * rate against the account's overall keep rate. Tracks that have sat unrated in the feed for a few days count as a
 * weak pass. The bounded log2 ratio is added to the build's score and drives the default sort. The build learns the
 * same thing from the playlists a few days later; here it is immediate, and it knows about local skips. */
import { state, items, decisionFor } from "./state.js";

/** @typedef {import("./types").FeedItem} FeedItem */
/** @typedef {{n: number, k: number, rate: number, adj: number}} Row */
/** @typedef {{outcomes: number, kept: number, skipped: number, passed: number, keep_rate: number, sources: Record<string, Row>, tags: Record<string, Row>, artists: Record<string, Row>}} Learned */

export const PERSONAL_WEIGHT = 1.0;
const GRACE_DAYS = 3, PASS_WEIGHT = 0.35, PRIOR = 8, MIN_EXPOSURES = 3, CAP = 1.5;

import { norm } from "./dom.js";
/** @param {{sources?: string[], tags?: string[], artist?: string}} o */
function features(o) {
  const sources = (o.sources || []).filter(Boolean);
  const fams = [...new Set(sources.map(s => s.split(":")[0]))];
  // blogs and radio stations are judged one by one (rss:Stereogum), the catalogue sources as a family (deezer)
  const per = sources.filter(s => s.includes(":")).concat(fams.filter(f => !sources.some(s => s.startsWith(f + ":"))));
  return { sources: per, tags: (o.tags || []).map(norm).filter(Boolean), artists: o.artist ? [norm(o.artist)] : [] };
}

/** @type {{version: string, learned: Learned} | null} */
let cache = null;
/** @type {Map<string, {adj: number, why: string[]}>} */
const perItem = new Map();
/** The ratings changed (a thumb, an undo, a sync): forget what was learned from them. */
export function invalidateRank() { cache = null; perItem.clear(); }

/** Every outcome this account knows: kept / skipped from the ratings, pass for tracks left unrated for a few days. */
function outcomes() {
  const out = [];
  for (const r of Object.values(state.rated)) {
    if (!r || r.decision === "undone" || r.decision === "seen") continue;
    out.push({ verdict: r.decision === "up" ? "kept" : "skipped", sources: r.sources || [], tags: r.tags || [], artist: r.artist || "" });
  }
  const today = state.feed?.generated_at ? new Date(state.feed.generated_at) : new Date();
  const cutoff = new Date(today.getTime() - GRACE_DAYS * 86400e3).toISOString().slice(0, 10);
  // only what was on screen can have been passed over: the feed is in build order, the shortlist is its top
  const shown = Math.max(Number(state.settings.shortlistSize) || 60, 80);
  for (const it of items().slice(0, shown)) if (!decisionFor(it.id) && it.first_seen && it.first_seen <= cutoff) out.push({ verdict: "pass", sources: it.sources || [], tags: it.tags || [], artist: it.artist });
  return out;
}

/** @returns {Learned} */
export function learnLocal() {
  const version = `${state.ratedVersion}|${state.feed?.generated_at || ""}`;
  if (cache && cache.version === version) return cache.learned;
  const outs = outcomes();
  const weight = { kept: 1, skipped: 1, pass: PASS_WEIGHT };
  const nAll = outs.reduce((a, o) => a + weight[o.verdict], 0);
  const kAll = outs.filter(o => o.verdict === "kept").length;
  /** @type {Learned} */
  const learned = { outcomes: outs.length, kept: kAll, skipped: outs.filter(o => o.verdict === "skipped").length, passed: outs.filter(o => o.verdict === "pass").length, keep_rate: 0, sources: {}, tags: {}, artists: {} };
  if (nAll > 0 && (kAll + learned.skipped) > 0) {
    const base = (kAll + 1) / (nAll + 2); learned.keep_rate = base;
    /** @type {Record<"sources" | "tags" | "artists", Record<string, number[]>>} */
    const counts = { sources: {}, tags: {}, artists: {} };
    for (const o of outs) {
      const w = weight[o.verdict], k = o.verdict === "kept" ? 1 : 0;
      for (const kind of /** @type {const} */ (["sources", "tags", "artists"])) for (const name of features(o)[kind]) { const row = counts[kind][name] || (counts[kind][name] = [0, 0, 0]); row[0] += w; row[1] += k; row[2] += 1; }
    }
    for (const kind of /** @type {const} */ (["sources", "tags", "artists"])) for (const [name, [n, k, shown]] of Object.entries(counts[kind])) {
      const rate = (k + PRIOR * base) / (n + PRIOR);
      learned[kind][name] = { n: shown, k, rate, adj: shown >= MIN_EXPOSURES ? Math.max(-CAP, Math.min(CAP, Math.log2(rate / base))) : 0 };
    }
  }
  cache = { version, learned };
  perItem.clear();
  return learned;
}

/** The personal adjustment for one card and the reasons it can show. @param {FeedItem} it */
export function personal(it) {
  const learned = learnLocal();
  const hit = perItem.get(it.id); if (hit) return hit;
  /** @type {{adj: number, why: string[]}} */
  const res = { adj: 0, why: [] };
  if (learned.keep_rate) {
    const f = features({ sources: it.sources, tags: it.tags, artist: it.artist });
    for (const kind of /** @type {const} */ (["sources", "tags", "artists"])) {
      const table = learned[kind]; const names = f[kind].filter(n => table[n] && table[n].adj);
      if (!names.length) continue;
      res.adj += names.reduce((a, n) => a + table[n].adj, 0) / names.length;
      const best = names.reduce((a, n) => Math.abs(table[n].adj) > Math.abs(table[a].adj) ? n : a, names[0]); const row = table[best]; const pct = Math.round(row.rate * 100);
      if (Math.abs(row.adj) < 0.5) continue;
      const label = best.includes(":") ? best.split(":").slice(1).join(":") : best;
      if (kind === "sources") res.why.push(row.adj > 0 ? `you keep ${pct}% from ${label}` : `you rarely keep ${label}`);
      else if (kind === "tags") res.why.push(row.adj > 0 ? `you keep ${pct}% of ${label}` : `you rarely keep ${label}`);
      else res.why.push(row.adj > 0 ? `you keep ${row.k} of ${row.n} by them` : `passed on them ${row.n} times`);
    }
    res.adj = Math.max(-CAP, Math.min(CAP, res.adj));
  }
  perItem.set(it.id, res);
  return res;
}
/** The build's score plus what this account has taught the site. @param {FeedItem} it */
export const scoreOf = it => it._pick ? it.score : it.score + PERSONAL_WEIGHT * personal(it).adj;

/** Keeps per ISO week for the stats panel, newest first. @param {number} weeks */
export function keepsByWeek(weeks = 8) {
  const now = Date.now(); const out = [];
  for (let w = 0; w < weeks; w++) {
    const to = now - w * 7 * 86400e3, from = to - 7 * 86400e3; let kept = 0, skipped = 0;
    for (const r of Object.values(state.rated)) { if (!r || !r.at || r.at < from || r.at >= to) continue; if (r.decision === "up") kept++; else if (r.decision === "down") skipped++; }
    out.push({ label: w === 0 ? "this week" : w === 1 ? "last week" : `${w} weeks ago`, kept, skipped });
  }
  return out;
}
