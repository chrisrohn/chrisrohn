// @ts-check
/* Auto-clean: the Cleanup tab's backlog worked through with the YouTube quota the Feed leaves over.
 *
 * One plan covers everything the tab can fix: extra copies trimmed, each song cut to its best copy (the playable
 * audio track in the verified year, else the earliest), videos swapped for their audio track, dead tracks swapped
 * for a streamable upload, songs left only with editions (original + remix) marked fine, and — when asked — songs
 * moved to their verified year, editions collapsed to the original, dead tracks without a replacement removed.
 * The plan runs best value first and stops when only the reserve kept back for the Feed is left; it is worked out
 * afresh from the reports and the synced marks every time, so the next run (tomorrow, or the evening run) picks up
 * exactly where this one stopped. It runs while the site is open: the YouTube sign-in lives in the browser. */
import { state, persist, quotaLeft, quotaLimit, ptDay } from "./state.js";
import { $, $$, esc, toast } from "./dom.js";
import { isOwner, tokenValid } from "./auth.js";
import { titleFor, videoDetails } from "./youtube.js";
import { YEAR_FREE, kindsOf, EDITION_NAME } from "./editions.js";
import { audit, auditDrop } from "./audit.js";
import { READ, WRITE, EDITION_RANK, cleanupHooks, loadReports, viewOf, unavailableRows, unavOpen, unavKey, isVideoRow, mark, removeRow, moveRow, swapTrack, readingOf, freshReading, moveYears, renderDupes, renderLive } from "./dupes.js";

/** @typedef {import("./types").Dupe} Dupe */
/** @typedef {import("./types").Unavailable} Unavailable */
/** @typedef {import("./types").AutoCleanOpts} Opts */
/** @typedef {import("./types").AutoClean} Config */
/** @typedef {import("./dupes.js").Row} Row */
/** @typedef {{ kind: "dismiss" | "trim" | "remove" | "move" | "swap" | "drop", d?: Dupe, r?: Row, u?: Unavailable, year?: string, use?: string, pid: string, cost: number }} Op */
/** @typedef {{ cat: Cat, label: string, ops: Op[], cost: number }} Job */
/** @typedef {"dismiss" | "extra" | "audio" | "streamable" | "dupes" | "versions" | "moves" | "dead"} Cat */

/** What each kind of fix is called, in the order a run takes them: free first, then the safest and the most fixes per
 * unit (a removal is 51, a swap 102), so a short day still clears the most from the list. */
/** @type {Record<Cat, string>} */
const CAT = { dismiss: "marked fine (only editions left)", extra: "extra copies trimmed", audio: "videos swapped for the audio track", dupes: "songs cut to one copy", streamable: "dead tracks swapped for a streamable upload", versions: "songs cut to one edition", moves: "songs moved to their verified year", dead: "dead tracks removed" };
const ORDER = /** @type {Cat[]} */ (Object.keys(CAT));
/** @type {Opts} */
const DEFAULT_OPTS = { lookup: true, extra: true, dupes: true, audio: true, streamable: true, versionsOk: true, moves: false, versions: false, dead: false };
/** @returns {Config} */
export function config() {
  const c = state.settings.autoClean;
  if (c && c.opts) { c.opts = { ...DEFAULT_OPTS, ...c.opts }; return c; }
  state.settings.autoClean = { opts: { ...DEFAULT_OPTS }, reserve: 500, evening: false, at: "22:00" };
  return state.settings.autoClean;
}

// ------------------------------------------------------------------ the plan
/** @param {Set<string>} dead @param {Row} r */
function isDead(dead, r) { const i = state.videoInfo[r.videoId]; return !r.avail || !!(i && (i.blocked || i.missing)) || dead.has(`${r.pid}|${r.videoId}`); }
/** The copy that stays: one that plays here, in the verified year when the catalogues know it, the audio track over
 * the video, the earliest year, then the copy filed first. With `byEdition` the original edition comes before all of that.
 * @param {Dupe} d @param {Row[]} rows @param {Set<string>} dead @param {boolean} byEdition */
export function keeperOf(d, rows, dead, byEdition) {
  const vy = d.verified_year ? String(d.verified_year) : "";
  /** @param {Row} r */
  const score = r => { const i = state.videoInfo[r.videoId]; return [isDead(dead, r) ? 1 : 0, byEdition ? EDITION_RANK[r.edition] ?? 9 : 0, vy && !YEAR_FREE.has(r.edition) && r.year !== vy ? 1 : 0, r.videoType === "MUSIC_VIDEO_TYPE_ATV" || (i && i.topic) ? 0 : 1, Number(r.year) || 9999, r.positions.length ? Math.min(...r.positions) : 1e9]; };
  return rows.map(r => ({ r, s: score(r) })).sort((a, b) => { for (let i = 0; i < a.s.length; i++) if (a.s[i] !== b.s[i]) return a.s[i] - b.s[i]; return a.r.videoId.localeCompare(b.r.videoId); })[0].r;
}
/** What one song needs, as ops run in order. @param {Dupe} d @param {Opts} o @param {Set<string>} dead @param {string} scope a year, or "" for all @returns {Job | null} */
function planSong(d, o, dead, scope) {
  const v = viewOf(d); if (!v.open) return null;
  const rows = v.rows;
  /** @type {Op[]} */ const ops = [];
  /** @type {Set<Row>} */ const removed = new Set();
  /** @type {Set<Row>} */ const trimmed = new Set();
  /** @type {Map<Row, string>} */ const moved = new Map();
  /** @param {Row} r */
  const inScope = r => !scope || r.year === scope;
  /** @type {Map<string, Row[]>} */ const groups = new Map();
  for (const r of rows) { const k = o.versions ? "all" : r.edition; groups.set(k, [...(groups.get(k) || []), r]); }
  const vy = d.verified_year ? String(d.verified_year) : "";
  let cat = /** @type {Cat} */ ("dismiss");
  for (const g of groups.values()) {
    const k = keeperOf(d, g, dead, o.versions);
    if (o.dupes || o.versions) for (const r of g) if (r !== k && inScope(r)) { ops.push({ kind: "remove", d, r, pid: r.pid, cost: READ + WRITE * r.copies }); removed.add(r); if (cat !== "versions") cat = r.edition !== k.edition ? "versions" : "dupes"; }
    if (o.extra) for (const r of g) if (!removed.has(r) && r.copies > 1 && inScope(r)) { ops.push({ kind: "trim", d, r, pid: r.pid, cost: READ + WRITE * (r.copies - 1) }); trimmed.add(r); if (cat === "dismiss") cat = "extra"; }
    const left = g.filter(r => !removed.has(r));
    if (o.moves && vy && left.length === 1 && left[0] === k && !YEAR_FREE.has(k.edition) && k.year !== vy && inScope(k) && moveYears().includes(vy)) {
      ops.push({ kind: "move", d, r: k, year: vy, pid: k.pid, cost: READ + WRITE + READ + WRITE * (trimmed.has(k) ? 1 : k.copies) }); moved.set(k, vy); if (cat === "dismiss" || cat === "extra") cat = "moves";
    }
  }
  if (o.versionsOk && !d.live) {
    const rest = rows.filter(r => !removed.has(r)).map(r => ({ ...r, copies: trimmed.has(r) ? 1 : r.copies, year: moved.get(r) || r.year, playlistId: moved.has(r) ? `y${moved.get(r)}` : r.pid }));
    const k = kindsOf(rest);
    if (k.length === 1 && k[0] === "versions") ops.push({ kind: "dismiss", d, pid: "", cost: 0 });
  }
  if (!ops.length) return null;
  return { cat, label: `${d.artist} - ${d.title}`, ops, cost: ops.reduce((n, op) => n + op.cost, 0) };
}
/** Every job for the songs and tracks in scope, best value first. @param {Opts} o @param {string} scope @param {Dupe[]} [songs] the live scan's songs instead of the report */
export function plan(o, scope, songs) {
  const deadRows = unavailableRows().filter(u => !isVideoRow(u));
  const dead = new Set(deadRows.map(u => `${u.playlistId}|${u.videoId}`));
  /** @type {Job[]} */ const jobs = [];
  for (const d of songs || state.dupes || []) { const j = planSong(d, o, dead, scope); if (j) jobs.push(j); }
  if (!songs) {
    const gone = new Set(jobs.flatMap(j => j.ops.filter(op => op.kind === "remove" && op.r).map(op => `${op.pid}|${/** @type {Row} */ (op.r).videoId}`)));
    for (const u of unavailableRows().filter(unavOpen)) {
      if (scope && u.year !== scope) continue;
      if (gone.has(`${u.playlistId}|${u.videoId}`)) continue;   // the song's own clean-up takes this copy out anyway
      const name = u.artist || u.title ? `${u.artist} - ${u.title}` : `row #${(u.position || 0) + 1} of ${titleFor(u.year)}`;
      const removal = u.itemId ? WRITE : READ + WRITE;
      if (u.alt && (isVideoRow(u) ? o.audio : o.streamable)) jobs.push({ cat: isVideoRow(u) ? "audio" : "streamable", label: name, ops: [{ kind: "swap", u, use: u.alt.videoId, pid: u.playlistId, cost: READ + WRITE + removal }], cost: READ + WRITE + removal });
      else if (!isVideoRow(u) && !u.alt && !u.pending && o.dead) jobs.push({ cat: "dead", label: name, ops: [{ kind: "drop", u, pid: u.playlistId, cost: removal }], cost: removal });
    }
  }
  jobs.sort((a, b) => ORDER.indexOf(a.cat) - ORDER.indexOf(b.cat) || (a.ops[0].pid || "").localeCompare(b.ops[0].pid || "") || a.cost - b.cost);
  return jobs;
}
/** Songs and copies in scope that YouTube has not been asked about this session. @param {string} scope */
function unlooked(scope) {
  const vids = new Set();
  for (const d of state.dupes || []) { const v = viewOf(d); if (!v.open || (scope && !v.rows.some(r => r.year === scope))) continue; for (const r of v.rows) if (!state.videoInfo[r.videoId]) vids.add(r.videoId); }
  return [...vids];
}
/** @param {Job[]} jobs */
function tally(jobs) {
  /** @type {Partial<Record<Cat, { n: number, units: number }>>} */ const by = {};
  for (const j of jobs) { const t = by[j.cat] || (by[j.cat] = { n: 0, units: 0 }); t.n++; t.units += j.cost; }
  return by;
}
/** How much of a plan today's quota covers after the reserve. @param {Job[]} jobs @param {number} budget */
function fits(jobs, budget) { let units = 0, n = 0; for (const j of jobs) { if (units + j.cost > budget) continue; units += j.cost; n++; } return { n, units }; }

// ------------------------------------------------------------------ the run
/** @type {{ on: boolean, stop: boolean, done: number, failed: number, total: number, startLeft: number, cats: Partial<Record<Cat, number>> }} */
const run = { on: false, stop: false, done: 0, failed: 0, total: 0, startLeft: 0, cats: {} };
export const autoCleanRunning = () => run.on;
export function stopAutoClean() { if (run.on) { run.stop = true; status("stopping after this fix…"); } }
/** @param {string} msg */
function status(msg) { const s = $("#cl-auto-status"); if (s) s.textContent = msg; }
/** Tracks per year playlist, for whether reading it whole is cheaper than one lookup per fix. @param {string} year */
const pagesOf = year => { const n = state.catalog?.years?.[year]?.playlist || audit().years[year]?.tracks || 2000; return Math.ceil(n / 50); };
/** @param {Op} op */
async function doOp(op) {
  const d = /** @type {Dupe} */ (op.d), r = /** @type {Row} */ (op.r);
  switch (op.kind) {
    case "dismiss": mark(`${d.key}|ok`); return;
    case "trim": await removeRow(d, r, true, `Auto-clean: remove the extra copy of a song added twice to “${titleFor(r.year)}” (one copy stays)`); return;
    case "remove": await removeRow(d, r, false, `Auto-clean: remove a duplicate copy from “${titleFor(r.year)}” (the best copy of the song stays)`); break;
    case "move": await moveRow(d, r, /** @type {string} */ (op.year)); return;
    case "swap": case "drop": {
      const u = /** @type {Unavailable} */ (op.u);
      await swapTrack(u, op.use || "");
      mark(unavKey(u)); auditDrop(u.playlistId, u.videoId);
      for (const s of state.dupes || []) if (s.entries.some(e => e.playlistId === u.playlistId && e.videoId === u.videoId)) mark(`${s.key}|${u.playlistId}|${u.videoId}|gone`);
      return;
    }
  }
  // a removed copy that was also listed as not playing here is dealt with too
  const u = unavailableRows().find(x => x.playlistId === r.pid && x.videoId === r.videoId);
  if (u) { mark(unavKey(u)); auditDrop(u.playlistId, u.videoId); }
}
/** Spend what is left of today's quota, down to the reserve, on the plan. @param {{ auto?: boolean, live?: boolean }} [how] */
export async function runAutoClean({ auto = false, live = false } = {}) {
  if (run.on) return;
  if (!isOwner()) { toast("Auto-clean edits the Indie Discotheque playlists: sign in as the curator first", true); return; }
  const c = config(); const o = live ? { ...c.opts, versionsOk: false, audio: false, streamable: false, dead: false, lookup: false } : c.opts;
  const scope = live ? "" : $("#cl-dupe-yr")?.value || "";
  Object.assign(run, { on: true, stop: false, done: 0, failed: 0, total: 0, startLeft: quotaLeft() }); run.cats = {};
  ui();
  /** @type {string} */ let stopped = "";
  try {
    status("reading the reports…");
    if (!live) await loadReports();
    const budget = () => quotaLeft() - c.reserve;
    if (o.lookup) {
      const vids = unlooked(scope); const cost = Math.ceil(vids.length / 50);
      if (vids.length && cost <= budget()) { status(`asking YouTube about ${vids.length.toLocaleString()} copies (${cost} units) so the best copy stays…`); await videoDetails(vids, { why: "Auto-clean: look up every copy (playable here, audio track or video) to choose the one that stays", detail: `${vids.length} videos` }); }
    }
    const songs = live ? state.liveDupes || [] : undefined;
    const jobs = plan(o, scope, songs);
    run.total = jobs.length;
    /** @type {Map<string, number>} */ const perPid = new Map();
    for (const j of jobs) for (const op of j.ops) if (op.pid && op.kind !== "swap" && op.kind !== "drop") perPid.set(op.pid, (perPid.get(op.pid) || 0) + 1);
    let skipped = 0, sinceRender = 0;
    for (const [i, j] of jobs.entries()) {
      if (run.stop) { stopped = "stopped"; break; }
      if (j.cost && j.cost > budget()) { skipped++; if (budget() < READ + WRITE) { stopped = "quota"; break; } continue; }
      status(`${i + 1} of ${jobs.length.toLocaleString()} · ${CAT[j.cat]} · ${j.label}`);
      bar(i / jobs.length);
      try {
        for (const op of j.ops) {
          // many fixes in one playlist: read it whole once (1 unit per 50 tracks) instead of one lookup per fix
          if (op.r && !live && !freshReading(op.pid) && (perPid.get(op.pid) || 0) >= pagesOf(op.r.year) && pagesOf(op.r.year) <= budget()) await readingOf(op.pid, op.r.year);
          await doOp(op);
          if (op.pid) perPid.set(op.pid, (perPid.get(op.pid) || 1) - 1);
        }
        run.done++; run.cats[j.cat] = (run.cats[j.cat] || 0) + 1;
      } catch (e) {
        run.failed++; const msg = /** @type {Error} */ (e).message;
        if (/quota/i.test(msg)) { stopped = "quota"; break; }
        if (/sign-in|sign in|session expired/i.test(msg)) { stopped = "sign-in"; break; }
        if (run.failed >= 10 && run.failed > run.done) { stopped = "errors: " + msg; break; }
      }
      if (++sinceRender >= 25) { sinceRender = 0; live ? renderLive() : renderDupes(false); }
    }
    if (!stopped && skipped) stopped = "quota";
    const left = Math.max(0, jobs.length - run.done - run.failed);
    c.last = { at: Date.now(), done: run.done, failed: run.failed, units: Math.max(0, run.startLeft - quotaLeft()), left, ...(stopped ? { stopped } : {}) };
    persist();
    const what = ORDER.filter(k => run.cats[k]).map(k => `${run.cats[k]} ${CAT[k]}`).join(" · ") || "nothing to do";
    const tail = stopped === "quota" ? ` · ${left.toLocaleString()} left for another day` : stopped === "sign-in" ? " · stopped: sign in again to carry on" : stopped === "stopped" ? ` · stopped, ${left.toLocaleString()} left` : stopped ? ` · stopped (${stopped})` : "";
    status(`${auto ? "Evening run: " : ""}${what}${run.failed ? ` · ${run.failed} failed` : ""} (${c.last.units.toLocaleString()} units)${tail}`);
    toast(`Auto-clean: ${run.done.toLocaleString()} fixed${run.failed ? ` · ${run.failed} failed` : ""}${tail}`, !!run.failed && !run.done);
  } catch (e) {
    status(""); toast("Auto-clean stopped: " + /** @type {Error} */ (e).message, true);
  } finally {
    run.on = false; bar(null);
    live ? renderLive() : renderDupes(false);
    ui();
  }
}
/** @param {number | null} f */
function bar(f) { const b = /** @type {HTMLProgressElement | null} */ ($("#cl-auto-bar")); if (!b) return; b.hidden = f == null; if (f != null) b.value = f; }

// ------------------------------------------------------------------ the evening run
/** The run is due when the chosen local time has passed within the current quota day and today has not run yet.
 * @param {Date} [now] */
export function eveningDue(now = new Date()) {
  const c = config(); if (!c.evening || c.lastDay === ptDay(now)) return false;
  const [h, m] = (c.at || "22:00").split(":").map(Number);
  const t = new Date(now); t.setHours(h || 0, m || 0, 0, 0); if (t > now) t.setDate(t.getDate() - 1);
  return ptDay(t) === ptDay(now);
}
function eveningCheck() {
  if (run.on || !isOwner() || !state.online || !eveningDue()) return;
  const c = config();
  if (!tokenValid()) {
    // the sign-in has lapsed and a fresh one needs a tap: ask once a day
    if (c.promptDay === ptDay()) return;
    c.promptDay = ptDay(); persist();
    toast("Evening clean-up is due: tap Start to spend what is left of today's quota", false, { label: "Start", fn: () => { config().lastDay = ptDay(); persist(); runAutoClean({ auto: true }); } });
    return;
  }
  c.lastDay = ptDay(); persist();
  toast("Evening clean-up: spending what is left of today's quota on the Cleanup list", false, { label: "Stop", fn: stopAutoClean });
  runAutoClean({ auto: true });
}
/** When the quota resets, in the viewer's own time. */
function resetLocal() {
  const now = new Date(); const pt = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const next = new Date(now.getTime() + ((24 * 60 - (pt.getHours() * 60 + pt.getMinutes())) * 60e3));
  return next.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// ------------------------------------------------------------------ the panel
let estTimer = 0;
/** The estimate under the buttons, redrawn whenever the tab is (debounced: the plan walks every song). */
function estimate() {
  clearTimeout(estTimer);
  estTimer = window.setTimeout(() => {
    const est = $("#cl-auto-est"); if (!est || run.on) return;
    if (!isOwner()) { est.textContent = "Sign in as the curator to clean up automatically."; return; }
    if (state.dupes == null && !state.unavailable) { est.textContent = "Open the list once to load the reports, then the plan is costed here."; return; }
    const c = config(); const scope = $("#cl-dupe-yr")?.value || "";
    const jobs = plan(c.opts, scope); const total = jobs.reduce((n, j) => n + j.cost, 0);
    const budget = Math.max(0, quotaLeft() - c.reserve); const f = fits(jobs, budget);
    const daily = Math.max(1, quotaLimit() - c.reserve);
    const go = /** @type {HTMLButtonElement} */ ($("#cl-auto-go"));
    go.disabled = !jobs.length || (!f.n && jobs.some(j => j.cost > 0));
    go.textContent = jobs.length ? `Use what's left today: ${f.n.toLocaleString()} of ${jobs.length.toLocaleString()} fixes` : "Nothing to fix";
    est.textContent = jobs.length
      ? `${jobs.length.toLocaleString()} fixes${scope ? ` in ${scope}` : ""}, ≈${total.toLocaleString()} units in all · ${quotaLeft().toLocaleString()} left today, ${c.reserve.toLocaleString()} kept back for the Feed → ${f.n.toLocaleString()} fixes now (≈${f.units.toLocaleString()} units)${f.n < jobs.length ? ` · the rest takes about ${Math.max(1, Math.ceil((total - f.units) / daily))} more day${Math.ceil((total - f.units) / daily) === 1 ? "" : "s"} of unused quota` : ""}`
      : `Nothing for these settings${scope ? ` in ${scope}` : ""}: the list is clean, or only needs the fixes that are switched off.`;
    const last = c.last; const l = $("#cl-auto-last");
    if (l) l.textContent = last ? `Last run ${new Date(last.at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}: ${last.done.toLocaleString()} fixed${last.failed ? `, ${last.failed} failed` : ""}, ${last.units.toLocaleString()} units` : "";
    if (!$("#cl-auto-plan")?.hidden) preview(jobs, budget);
  }, 60);
}
/** The plan, by kind of fix and song by song (the first 150). @param {Job[]} jobs @param {number} budget */
function preview(jobs, budget) {
  const box = $("#cl-auto-plan"); if (!box) return;
  const by = tally(jobs); let units = 0;
  const today = new Set(); for (const j of jobs) { if (units + j.cost > budget) continue; units += j.cost; today.add(j); }
  /** @param {Op} op */
  const line = op => op.kind === "dismiss" ? "mark fine" : op.kind === "trim" ? `trim ×${op.r?.copies} in ${op.r?.year}` : op.kind === "remove" ? `remove ${op.r?.year} ${EDITION_NAME[op.r?.edition || ""] || ""}${op.r?.videoType === "MUSIC_VIDEO_TYPE_ATV" ? " audio" : ""}` : op.kind === "move" ? `move ${op.r?.year} → ${op.year}` : op.kind === "swap" ? `swap in ${op.u?.year}` : `remove dead copy in ${op.u?.year}`;
  box.innerHTML = `<ul class="cl-auto-tally">${ORDER.filter(k => by[k]).map(k => `<li><b>${(by[k]?.n || 0).toLocaleString()}</b> ${esc(CAT[k])} <span class="muted">≈${(by[k]?.units || 0).toLocaleString()} units</span></li>`).join("")}</ul>`
    + `<ol class="cl-auto-list">${jobs.slice(0, 150).map(j => `<li class="${today.has(j) ? "" : "later"}"><span class="flag">${esc(j.cat)}</span> ${esc(j.label)} <span class="muted">${esc(j.ops.map(line).join(", "))}${j.cost ? ` · ${j.cost} units` : " · free"}${today.has(j) ? "" : " · another day"}</span></li>`).join("")}</ol>`
    + (jobs.length > 150 ? `<p class="muted">…and ${(jobs.length - 150).toLocaleString()} more.</p>` : "");
}
function ui() {
  const go = /** @type {HTMLButtonElement | null} */ ($("#cl-auto-go")); if (!go) return;
  const stop = $("#cl-auto-stop"); stop.hidden = !run.on; go.hidden = run.on;
  $$("#cl-auto input, #cl-auto select").forEach(el => { /** @type {HTMLInputElement} */ (el).disabled = run.on; });
  const live = /** @type {HTMLButtonElement | null} */ ($("#cl-live-auto")); if (live) live.disabled = run.on;
  if (!run.on) estimate();
}
/** The panel's controls, wired once. */
export function wireAutoClean() {
  const c = config();
  $$("#cl-auto input[data-opt]").forEach(el => {
    const box = /** @type {HTMLInputElement} */ (el); const k = /** @type {keyof Opts} */ (box.dataset.opt);
    box.checked = !!c.opts[k];
    box.addEventListener("change", () => { config().opts[k] = box.checked; persist(); estimate(); });
  });
  const reserve = /** @type {HTMLSelectElement} */ ($("#cl-auto-reserve"));
  reserve.value = String(c.reserve); if (reserve.value !== String(c.reserve)) { reserve.value = "500"; c.reserve = 500; }
  reserve.addEventListener("change", () => { config().reserve = Number(reserve.value) || 0; persist(); estimate(); });
  const evening = /** @type {HTMLInputElement} */ ($("#cl-auto-evening")), at = /** @type {HTMLInputElement} */ ($("#cl-auto-at"));
  evening.checked = !!c.evening; at.value = c.at || "22:00";
  const resetNote = () => { $("#cl-auto-reset").textContent = `The quota resets at ${resetLocal()} your time; the evening run needs the site open in a tab.`; };
  evening.addEventListener("change", () => { const cc = config(); cc.evening = evening.checked; if (evening.checked && eveningDue()) cc.lastDay = ptDay(); persist(); toast(evening.checked ? `Every evening at ${at.value} the Cleanup list gets what is left of the day's quota (from tomorrow)` : "Evening clean-up off"); });
  at.addEventListener("change", () => { config().at = at.value || "22:00"; persist(); });
  $("#cl-auto-go").addEventListener("click", () => {
    const cc = config(); const left = Math.max(0, quotaLeft() - cc.reserve);
    if (!confirm(`Spend up to ${left.toLocaleString()} of the ${quotaLeft().toLocaleString()} YouTube units left today on the Cleanup list${$("#cl-dupe-yr")?.value ? ` (${$("#cl-dupe-yr").value} only)` : ""}, keeping ${cc.reserve.toLocaleString()} back for the Feed?\n\nCopies are removed for good (re-adding is up to you); every request is listed under ⚙ → API activity. Stop any time.`)) return;
    runAutoClean();
  });
  $("#cl-auto-stop").addEventListener("click", stopAutoClean);
  $("#cl-auto-preview").addEventListener("click", () => { const p = $("#cl-auto-plan"); p.hidden = !p.hidden; $("#cl-auto-preview").textContent = p.hidden ? "Preview the plan" : "Hide the plan"; estimate(); });
  $("#cl-live-auto").addEventListener("click", () => {
    if (!confirm(`Clean ${titleFor(state.liveYear || "")} as scanned: one copy of each song stays (extra copies trimmed${config().opts.versions ? ", one edition kept" : ""}). Up to ${Math.max(0, quotaLeft() - config().reserve).toLocaleString()} units.`)) return;
    runAutoClean({ live: true });
  });
  cleanupHooks.onRender = () => { resetNote(); estimate(); };
  window.setInterval(eveningCheck, 60e3);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") eveningCheck(); });
  window.setTimeout(eveningCheck, 8000);   // after the feed and the sign-in have settled
}
