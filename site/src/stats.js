// @ts-check
/* The Stats sheet: what this account keeps and skips (from the local ratings and their Drive mirror), and what the
 * daily build has learned from the playlists. Single-hue magnitude bars in the sheet's own ink; text stays text. */
import { state } from "./state.js";
import { $, esc } from "./dom.js";
import { isCurator } from "./auth.js";
import { learnLocal, keepsByWeek } from "./rank.js";

/** @typedef {import("./types").LearnedRow} LearnedRow */

/** @param {string} label @param {number} value @param {number} max @param {string} [note] */
const bar = (label, value, max, note = "") => `<div class="stat-row"><span class="stat-k">${esc(label)}</span><span class="stat-bar"><i style="width:${max ? Math.round(100 * value / max) : 0}%"></i></span><span class="stat-v">${esc(note || String(value))}</span></div>`;
/** Keep-rate rows for sources or tags, most-seen first, with the rate as the bar. @param {Record<string, LearnedRow>} table @param {number} top */
function rates(table, top = 12) {
  const rows = Object.entries(table).filter(([, r]) => r.n >= 3).sort((a, b) => b[1].n - a[1].n).slice(0, top);
  if (!rows.length) return `<p class="muted">Not enough rated tracks yet — a few days of keeps and skips and this fills in.</p>`;
  return rows.map(([name, r]) => bar(name.includes(":") ? name.split(":").slice(1).join(":") : name, r.rate, 1, `${Math.round(r.rate * 100)}% · ${r.k}/${r.n}`)).join("");
}

export function openStats() {
  const mine = learnLocal(); const weeks = keepsByWeek(8); const maxW = Math.max(1, ...weeks.map(w => w.kept + w.skipped));
  const topArtists = Object.entries(mine.artists).filter(([, r]) => r.k > 1).sort((a, b) => b[1].k - a[1].k || b[1].n - a[1].n).slice(0, 10);
  const acct = isCurator()
    ? `<p class="muted">${mine.kept} kept · ${mine.skipped} skipped · ${mine.passed} left unrated for a few days${mine.keep_rate ? ` · you keep about ${Math.round(mine.keep_rate * 100)}% of what you judge` : ""}. Every keep and skip remembered by this account counts; the personal ranking on the cards is learned from exactly this.</p>
       <h3>Keeps and skips by week</h3>${weeks.map(w => bar(w.label, w.kept + w.skipped, maxW, w.kept + w.skipped ? `${w.kept} kept · ${w.skipped} skipped` : "—")).join("")}
       <h3>Keep rate by source</h3>${rates(mine.sources)}
       <h3>Keep rate by tag</h3>${rates(mine.tags)}
       ${topArtists.length ? `<h3>Most kept artists</h3>${topArtists.map(([n, r]) => bar(n, r.k, topArtists[0][1].k, `${r.k} of ${r.n}`)).join("")}` : ""}`
    : `<p class="muted">Sign in as a curator to see what this account keeps and skips.</p>`;
  const b = state.feed?.learned;
  const build = b && b.outcomes
    ? `<p class="muted">Since ${esc(b.since || "?")} the build has watched ${b.outcomes} tracks it showed: ${b.kept} reached a year playlist, ${b.skipped} the Skipped playlist, base keep rate ${Math.round(b.keep_rate * 100)}%. Sources and tags below move tomorrow's scores (bounded, see <code>learn</code> in config.yaml).</p>
       <h3>Keep rate by source (build)</h3>${rates(b.sources)}<h3>Keep rate by tag (build)</h3>${rates(b.tags)}`
    : `<p class="muted">The daily build starts learning from the playlists once the feed has a few days of history behind it (tracks shown three or more days ago that did or did not reach a playlist). Nothing to show yet.</p>`;
  $("#stats-body").innerHTML = `<h3>This account</h3>${acct}<h3>The daily build</h3>${build}`;
  $("#stats").showModal();
}
