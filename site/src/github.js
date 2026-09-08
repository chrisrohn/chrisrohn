// @ts-check
/* Ratings back to the build: data/ratings.json in the site's repository, written from this browser through the
 * GitHub contents API with a fine-grained token (Contents: read and write, this one repository) that the curator
 * pastes into ⚙ once. Every keep, skip and wrong-video flag travels, so tomorrow's build learns from the free local
 * skips too, hides them on every device, and resolves a flagged track again without the upload that was wrong —
 * all without a YouTube quota unit. The token lives in this browser's localStorage and is
 * sent to api.github.com only; the file it writes holds ids, titles and decisions, never the account.
 *
 * The push is built for a phone on a patchy connection, because that is where the rating happens:
 *  - Nothing is downloaded to find out whether a push is needed. The file's git blob SHA-1 is computed here and
 *    compared with the one in the (tiny) directory listing, so an unchanged sitting costs a few hundred bytes
 *    instead of the ~450 KB the file itself weighs — and a changed one uploads without downloading the old copy.
 *  - A dropped connection, a timeout, a 5xx or a rate limit is retried: three attempts per request, then whole
 *    pushes again on a widening delay, and at once when the network returns or the app comes back to the front.
 *  - The work outlives the tab: "there are ratings to push" is persisted, so a sitting closed mid-push goes up on
 *    the next visit rather than being lost.
 *  - A background push stays quiet. It only says something when the same failure has survived several attempts, and
 *    then in words that say what to do — never a bare "Failed to fetch". Terminal problems (a refused or
 *    under-scoped token) are said once, not on every retry. */
import { state, persist } from "./state.js";
import { toast } from "./dom.js";
import { isOwner } from "./auth.js";

const API = "https://api.github.com";
const PATH = "data/ratings.json";
const DIR = PATH.slice(0, PATH.lastIndexOf("/"));          // "data": its listing carries the file's sha, not its bytes
const NAME = PATH.slice(PATH.lastIndexOf("/") + 1);
const DEBOUNCE_MS = 20e3;                                  // one commit per sitting, not one per track
const TIMEOUT_MS = 60e3;                                   // a 450 KB upload on a phone is allowed to take its time
const ATTEMPTS = 3;                                        // per request, for the failures that pass on their own
const WAIT = [1200, 5000];                                 // between those attempts (jittered)
const RETRY = [30e3, 120e3, 480e3, 1800e3];                // between whole pushes while the network keeps refusing
const NOISE_AFTER = 3;                                     // consecutive quiet failures before the toast
const SAY_AGAIN_MS = 30 * 60e3;                            // the same terminal problem is not repeated sooner

const repo = () => (state.feed && state.feed.repo) || "";
export const ghEnabled = () => isOwner() && !!state.settings.ghToken && !!repo();
/** Decisions are waiting for the repository (a failed or never-finished push, remembered across reloads). */
export const ghPending = () => ghEnabled() && !!state.ghDirty;
/** What the last push ran into, in words worth showing in ⚙. */
export const ghProblem = () => state.ghErr;

/** The file's shape (the build reads `rated`: discovery/learn.py). */
export function ratingsPayload() {
  /** @type {Record<string, any>} */
  const rated = {};
  for (const [id, r] of Object.entries(state.rated)) {
    if (!r || r.pending || r.queued || (r.decision !== "up" && r.decision !== "down" && r.decision !== "wrong")) continue;
    rated[id] = { decision: r.decision, year: r.year ?? null, videoId: r.videoId || null, artist: r.artist || "", title: r.title || "", at: r.at || 0 };
  }
  return { version: 1, updatedAt: new Date().toISOString(), count: Object.keys(rated).length, rated };
}
/** @param {string} text */
function b64(text) {
  const bytes = new TextEncoder().encode(text); let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
/** Git's own object id for this content — `sha1("blob <bytes>\0" + content)` — so the repo's copy can be recognised
 * from the directory listing alone, without downloading it. @param {string} text */
async function blobSha(text) {
  const body = new TextEncoder().encode(text);
  const head = new TextEncoder().encode(`blob ${body.length}\0`);
  const buf = new Uint8Array(head.length + body.length); buf.set(head); buf.set(body, head.length);
  const d = await crypto.subtle.digest("SHA-1", buf);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** @param {number} ms */
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** The connection gave out (or never started): fetch rejects with a TypeError, our own timeout with an abort. */
const transient = (/** @type {any} */ e) => e instanceof TypeError || e?.name === "AbortError" || e?.name === "TimeoutError";
/** Marks a failure that is expected to pass on its own, so a background push can keep quiet about it. @param {Error} e */
const soft = e => Object.assign(e, { soft: true });

/** A fetch that gives up rather than hanging, and retries what tends to pass by itself.
 * @param {string} url @param {RequestInit} [init] @param {number} [attempts] @returns {Promise<Response>} */
async function ghFetch(url, init = {}, attempts = ATTEMPTS) {
  /** @type {any} */
  let last = soft(new Error("GitHub could not be reached"));
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(WAIT[Math.min(i - 1, WAIT.length - 1)] * (0.7 + Math.random() * 0.6));
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, { ...init, signal: ac.signal });
      // 5xx, a secondary rate limit, or the hourly limit spent: worth another go in a moment
      if (r.status >= 500 || r.status === 429 || (r.status === 403 && r.headers.get("x-ratelimit-remaining") === "0")) { last = soft(new Error(await reason(r))); continue; }
      return r;
    } catch (e) {
      if (!transient(e)) throw e;
      last = soft(new Error(/** @type {Error} */ (e).name === "AbortError" ? "GitHub did not answer in time" : "no connection to GitHub"));
    } finally { clearTimeout(timer); }
  }
  throw last;
}
/** @param {Record<string, string>} headers The file's blob sha in the repo, or null when it is not there yet. */
async function remoteSha(headers) {
  const r = await ghFetch(`${API}/repos/${repo()}/contents/${DIR}`, { headers, cache: "no-store" });
  if (r.status === 404) return null;                        // no data/ directory yet: the PUT creates the file
  if (!r.ok) throw new Error(await reason(r));
  const list = await r.json().catch(() => null);
  if (!Array.isArray(list)) throw new Error(await reason(r));
  const hit = list.find(f => f && f.name === NAME && f.type === "file");
  return hit ? String(hit.sha) : null;
}

/** A push twenty seconds after the last thumb: one commit per sitting, not one per track. */
export function scheduleGhPush() {
  if (!ghEnabled()) return;
  markDirty();
  clearTimeout(state.ghTimer); state.ghTimer = setTimeout(() => { state.ghTimer = null; pushToGitHub().catch(() => {}); }, DEBOUNCE_MS);
}
function markDirty() { if (!state.ghDirty) { state.ghDirty = true; persist(); } }
/** Try again in a moment: on the network coming back, the app returning, or a widening delay after a failure. @param {number} [ms] */
function scheduleRetry(ms) {
  clearTimeout(state.ghRetry);
  const wait = ms ?? RETRY[Math.min(Math.max(state.ghFails, 1) - 1, RETRY.length - 1)];
  state.ghRetry = setTimeout(() => { state.ghRetry = null; if (ghPending()) pushToGitHub().catch(() => {}); }, wait);
}
/** Push now if anything is waiting (called when the network or the app comes back). @param {number} [delay] */
export function flushGhPush(delay = 800) {
  if (!ghPending() || !state.online) return;
  clearTimeout(state.ghTimer); state.ghTimer = null;
  scheduleRetry(delay);
}
/** The last push of a sitting, and the retries that make a dropped connection a non-event. */
export function wireGhPush() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      // the tab is going away: get the sitting out if the debounce is still counting. It may not survive being
      // backgrounded — that is fine, ghDirty is persisted and the next visit finishes the job.
      if (ghEnabled() && state.ghTimer) { clearTimeout(state.ghTimer); state.ghTimer = null; pushToGitHub().catch(() => {}); }
    } else flushGhPush();
  });
  window.addEventListener("online", () => flushGhPush(1500));
  if (ghPending()) flushGhPush(3000);   // a sitting the last visit could not get out
}

/** Write data/ratings.json (a no-op commit is skipped). Resolves true when the repo now matches. @param {{quiet?: boolean}} [opts] @returns {Promise<boolean>} */
export function pushToGitHub({ quiet = true } = {}) {
  if (!ghEnabled()) { if (!quiet) toast("Set a GitHub token in ⚙ first", true); return Promise.resolve(false); }
  if (!state.online) {
    markDirty();
    if (!quiet) toast("Offline — the ratings push waits for the network", true);
    return Promise.resolve(false);
  }
  // one push at a time: a tap on "push now" joins the background one instead of racing it into a 409
  if (state.ghBusy) return state.ghBusy;
  const run = push(quiet).finally(() => { state.ghBusy = null; });
  state.ghBusy = run;
  return run;
}
/** @param {boolean} quiet */
async function push(quiet) {
  clearTimeout(state.ghRetry); state.ghRetry = null;
  const headers = { Authorization: "Bearer " + state.settings.ghToken, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const url = `${API}/repos/${repo()}/contents/${PATH}`;
  const payload = ratingsPayload();
  const text = JSON.stringify(payload);
  try {
    let sha = await remoteSha(headers);
    // the same decisions as last time (only `updatedAt` would differ): nothing to commit, and nothing uploaded
    if (sha && sha === await lastPushedSha(payload)) { done(); if (!quiet) toast("The build already has these ratings"); return true; }
    const body = () => JSON.stringify({ message: `ratings: ${new Date().toISOString().slice(0, 10)} · ${payload.count} decisions [skip ci]`, content: b64(text), ...(sha ? { sha } : {}) });
    let r = await ghFetch(url, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: body() });
    if (r.status === 409 || r.status === 422) {            // another device committed while we were uploading: take its sha and go again
      sha = await remoteSha(headers);
      r = await ghFetch(url, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: body() });
    }
    if (!r.ok) throw new Error(await reason(r));
    done(payload, await blobSha(text));
    if (!quiet) toast(`Ratings pushed to ${repo()} · ${payload.count} decisions — the next build learns from them`);
    return true;
  } catch (e) {
    fail(/** @type {any} */ (e), quiet);
    return false;
  }
}
/** The sha the repo would have if our last push is still the newest commit — a payload that only differs in its
 * timestamp must not become a commit. @param {ReturnType<typeof ratingsPayload>} payload */
async function lastPushedSha(payload) {
  return state.ghSha && state.ghSha.count === payload.count
    ? await blobSha(JSON.stringify({ ...payload, updatedAt: state.ghSha.updatedAt })) : "";
}
/** @param {{updatedAt: string, count: number}} [pushed] @param {string} [sha] The payload just committed and its blob sha. */
function done(pushed, sha) {
  state.ghAt = Date.now(); state.ghDirty = false; state.ghFails = 0; state.ghErr = null;
  if (pushed && sha) state.ghSha = { sha, updatedAt: pushed.updatedAt, count: pushed.count };
  persist();
}
/** Quiet about what will pass on its own; clear and once-only about what needs the curator. @param {any} e @param {boolean} quiet */
function fail(e, quiet) {
  const msg = e && e.message ? e.message : String(e);
  state.ghDirty = true; state.ghFails = (state.ghFails || 0) + 1; state.ghErr = msg; persist();
  if (e && e.soft) {
    scheduleRetry();
    // a background push says nothing until the same trouble has survived several tries
    if (!quiet) toast(`Ratings push held: ${msg} — it will go up by itself when the connection is back`, true);
    else if (state.ghFails === NOISE_AFTER) toast(`Ratings have not reached GitHub yet (${msg}) — they are kept here and pushed when the connection allows`, true);
    return;
  }
  scheduleRetry(RETRY[RETRY.length - 1]);                  // a token problem needs a hand, so try again rarely
  const repeat = state.ghSaid && state.ghSaid.msg === msg && Date.now() - state.ghSaid.at < SAY_AGAIN_MS;
  if (!quiet || !repeat) { state.ghSaid = { msg, at: Date.now() }; toast("Ratings push to GitHub failed: " + msg, true); }
}
/** @param {Response} r */
async function reason(r) {
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) return "the token was refused (expired or revoked?) — make a new fine-grained token with Contents: read and write on the repo";
  if (r.status === 403 && r.headers.get("x-ratelimit-remaining") === "0") return "GitHub's rate limit is spent for now";
  if (r.status === 403) return "the token may not write this repository (it needs Contents: read and write on " + repo() + ")" + (j.message ? ` · ${j.message}` : "");
  if (r.status === 404) return "repository not found for this token: check it is scoped to " + repo();
  if (r.status === 429) return "GitHub asked us to slow down";
  if (r.status >= 500) return `GitHub is having trouble (${r.status})`;
  return (j && j.message) || r.statusText || `HTTP ${r.status}`;
}
