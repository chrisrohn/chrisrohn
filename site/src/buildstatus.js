// @ts-check
/* What the Discover workflow is doing while the day's feed is late, said on the late-feed bar itself: building now
 * (and on which step, and about how long is left), queued for a runner, the last attempt failed, or no run has
 * started yet and which slot is next. So "has not landed yet" answers its own question — wait, or start one — and
 * the owner can start one from the bar (a workflow_dispatch with the ratings token, given Actions: read and write).
 *
 * Read from the public Actions API: no token needed on a public repository (60 requests an hour per address, so it
 * is read at most every few minutes and only while the bar is up and the tab in front); the owner's token, when
 * set, is sent along for its larger allowance and for a private repository. Any failure leaves the bar as it was. */
import { state } from "./state.js";
import { toast } from "./dom.js";
import { isOwner } from "./auth.js";

const API = "https://api.github.com";
const WORKFLOW = "discover.yml";
/** discover.yml's `schedule:` as [hour, minute] in UTC (GitHub cron has no time zone) — keep the two in step. */
export const SLOTS_UTC = [[6, 7], [8, 29], [10, 47]];
const POLL_MS = 3 * 60e3;          // while the bar is up: ≤ 40 unauthenticated reads an hour with the jobs call
const AFTER_DISPATCH_MS = 8e3;     // a dispatched run takes a few seconds to appear in the list
const TYPICAL_MIN = 25;            // when no finished build is in the listing to time one by

const repo = () => (state.feed && state.feed.repo) || "chrisrohn/chrisrohn";
const token = () => (isOwner() && state.settings.ghToken) || "";
const runsPage = () => `https://github.com/${repo()}/actions/workflows/${WORKFLOW}`;
/** @param {boolean} [write] */
const headers = (write = false) => ({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token() ? { Authorization: "Bearer " + token() } : {}), ...(write ? { "Content-Type": "application/json" } : {}) });

/** @typedef {{id: number, status: string, conclusion: string | null, event: string, html_url: string, created_at: string, updated_at: string, run_started_at?: string}} Run */
/** @typedef {{run: Run | null, last: Run | null, step: string, typical: number, at: number}} Status */

/** @type {Status | null} */ let cached = null;
/** @type {Promise<Status | null> | null} */ let inflight = null;
/** @type {any} */ let timer = null;
/** @type {HTMLElement | null} */ let bar = null;
let wired = false;

/** @param {string} url @param {RequestInit} [init] */
async function gh(url, init = {}) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15e3);
  try { return await fetch(url, { cache: "no-store", ...init, headers: { ...headers(), ...(init.headers || {}) }, signal: ac.signal }); }
  finally { clearTimeout(t); }
}
const mins = (/** @type {string} */ a, /** @type {string} */ b) => (new Date(b).getTime() - new Date(a).getTime()) / 60e3;
const hm = (/** @type {Date} */ d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const ago = (/** @type {Date} */ d) => { const m = Math.max(0, Math.round((Date.now() - d.getTime()) / 60e3)); return m < 1 ? "just now" : m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

/** The workflow's latest runs, the one under way (with its current step) and how long a real build usually takes.
 * @returns {Promise<Status | null>} */
async function read() {
  const r = await gh(`${API}/repos/${repo()}/actions/workflows/${WORKFLOW}/runs?branch=main&per_page=15`);
  if (!r.ok) return null;
  /** @type {Run[]} */ const runs = ((await r.json().catch(() => ({}))).workflow_runs) || [];
  const run = runs.find(x => x.status !== "completed") || null;
  const last = runs.find(x => x.status === "completed") || null;
  // a slot that found the feed already out ends in seconds: only runs long enough to have built count toward "usually"
  const took = runs.filter(x => x.conclusion === "success" && x.run_started_at).map(x => mins(/** @type {string} */ (x.run_started_at), x.updated_at)).filter(m => m > 4).sort((a, b) => a - b);
  const typical = took.length ? Math.round(took[Math.floor(took.length / 2)]) : TYPICAL_MIN;
  let step = "";
  if (run && run.status === "in_progress") {
    const j = await gh(`${API}/repos/${repo()}/actions/runs/${run.id}/jobs`).catch(() => null);
    const jobs = j && j.ok ? ((await j.json().catch(() => ({}))).jobs || []) : [];
    const job = jobs.find((/** @type {any} */ x) => x.status === "in_progress");
    const s = job && (job.steps || []).find((/** @type {any} */ x) => x.status === "in_progress");
    step = s ? s.name : job ? job.name : "";
  }
  return { run, last, step, typical, at: Date.now() };
}
/** @param {boolean} [force] */
function load(force = false) {
  if (!force && cached && Date.now() - cached.at < POLL_MS - 5e3) return Promise.resolve(cached);
  if (!inflight) inflight = read().catch(() => null).then(s => { inflight = null; if (s) cached = s; return s; });
  return inflight;
}

/** Today's scheduled slots as local times, earliest first. */
function slotsToday() {
  const d = new Date();
  return SLOTS_UTC.map(([h, m]) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m)));
}
const how = (/** @type {Run} */ r) => r.event === "schedule" ? "scheduled run" : r.event === "workflow_dispatch" ? "manual run" : "run";

/** The sentence for where things stand, and whether starting a run by hand is worth offering.
 * @param {Status} s @param {Date | null} built When the feed on screen was built. @returns {{text: string, offer: boolean, link: string}} */
export function describe(s, built) {
  const { run, last, step, typical } = s;
  if (run && run.status === "in_progress") {
    const started = new Date(run.run_started_at || run.created_at);
    const left = Math.round(typical - (Date.now() - started.getTime()) / 60e3);
    return { text: `Building now: the ${how(run)} started ${ago(started)}${step ? `, on “${step}”` : ""} · ${left > 1 ? `about ${left} min to go` : "should land any minute"}.`, offer: false, link: run.html_url };
  }
  if (run) return { text: `A ${how(run)} has been queued at GitHub since ${hm(new Date(run.created_at))}, waiting for a runner. It starts by itself.`, offer: false, link: run.html_url };
  const since = built ? built.getTime() : 0;
  const next = slotsToday().find(d => d.getTime() > Date.now());
  const missed = slotsToday().filter(d => d.getTime() <= Date.now() && d.getTime() > since);
  const nextText = next ? `The next scheduled slot is ${hm(next)}.` : "This morning's three slots are all due, and GitHub can start one hours late.";
  if (last && new Date(last.created_at).getTime() > since) {
    const when = hm(new Date(last.updated_at));
    if (last.conclusion === "success") return { text: `A ${how(last)} finished at ${when}: the feed should appear here within minutes. If this bar outlasts that, the run found nothing to build — start one.`, offer: true, link: last.html_url };
    const what = last.conclusion === "cancelled" || last.conclusion === "timed_out" ? "was cut short" : "failed";
    return { text: `The last attempt (${how(last)}, ${when}) ${what}. ${nextText}`, offer: true, link: last.html_url };
  }
  if (missed.length) return { text: `No run has started yet: GitHub has not fired the ${hm(missed[missed.length - 1])} slot (it holds scheduled runs back at busy times). ${nextText}`, offer: true, link: runsPage() };
  return { text: `Nothing is running. ${nextText}`, offer: true, link: runsPage() };
}

/** Start a build now (the owner, with a token that has Actions: read and write). */
async function dispatch(/** @type {HTMLButtonElement} */ btn) {
  btn.disabled = true; btn.textContent = "starting…";
  try {
    const r = await gh(`${API}/repos/${repo()}/actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", headers: headers(true), body: JSON.stringify({ ref: "main" }) });
    if (r.status === 204) {
      toast(`Build started — it usually takes about ${cached?.typical ?? TYPICAL_MIN} min, and this page picks it up on its own`);
      setTimeout(() => refresh(true), AFTER_DISPATCH_MS);
      return;
    }
    const why = r.status === 403 || r.status === 404 ? "the GitHub token in ⚙ needs Actions: read and write on " + repo() : r.status === 401 ? "the GitHub token was refused" : `GitHub said ${r.status}`;
    toast(`Could not start the build: ${why}. Opening the workflow page instead.`, true);
    window.open(runsPage(), "_blank", "noopener");
  } catch {
    toast("Could not reach GitHub to start the build", true);
  }
  btn.disabled = false; btn.textContent = "run it now";
}

/** Fill the status line from what is known now. */
function paint() {
  if (!bar || bar.hidden || !cached) return;
  let line = /** @type {HTMLElement | null} */ (bar.querySelector(".run"));
  if (!line) { line = document.createElement("span"); line.className = "run"; bar.append(" ", line); }
  const { text, offer, link } = describe(cached, state.feed?.generated_at ? new Date(state.feed.generated_at) : null);
  const a = document.createElement("a"); a.href = link; a.target = "_blank"; a.rel = "noopener"; a.textContent = link === runsPage() ? "workflow ↗" : "the run ↗";
  line.replaceChildren(text + " ", a);
  if (offer && isOwner()) {
    if (token()) {
      const b = document.createElement("button"); b.type = "button"; b.className = "btn ghost small"; b.textContent = "run it now";
      b.addEventListener("click", () => dispatch(b));
      line.append(" ", b);
    } else {
      const r = document.createElement("a"); r.href = runsPage(); r.target = "_blank"; r.rel = "noopener"; r.className = "btn ghost small"; r.textContent = "run it on GitHub ↗";
      r.title = "Run workflow → main. Or give the ⚙ GitHub token Actions: read and write, and start it from here.";
      line.append(" ", r);
    }
  }
}
/** @param {boolean} [force] */
function refresh(force = false) {
  clearTimeout(timer); timer = null;
  if (!bar || bar.hidden) return;
  if (document.visibilityState === "visible") load(force).then(paint);
  timer = setTimeout(() => refresh(), POLL_MS);
}

/** Called each time the late-feed bar is (re)drawn: show what is known at once, then keep it current while it is up.
 * @param {HTMLElement} el */
export function showBuildStatus(el) {
  bar = el;
  if (!wired) { wired = true; document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && bar && !bar.hidden) refresh(); }); }
  if (el.hidden) { clearTimeout(timer); timer = null; return; }
  paint(); refresh();
}
