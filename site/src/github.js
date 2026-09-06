// @ts-check
/* Ratings back to the build: data/ratings.json in the site's repository, written from this browser through the
 * GitHub contents API with a fine-grained token (Contents: read and write, this one repository) that the curator
 * pastes into ⚙ once. Every keep and skip travels, so tomorrow's build learns from the free local skips too and
 * hides them on every device, without a YouTube quota unit. The token lives in this browser's localStorage and is
 * sent to api.github.com only; the file it writes holds ids, titles and decisions, never the account. */
import { state, persist } from "./state.js";
import { toast } from "./dom.js";
import { isOwner } from "./auth.js";

const API = "https://api.github.com";
const PATH = "data/ratings.json";
const repo = () => (state.feed && state.feed.repo) || "";
export const ghEnabled = () => isOwner() && !!state.settings.ghToken && !!repo();

/** The file's shape (the build reads `rated`: discovery/learn.py). */
export function ratingsPayload() {
  /** @type {Record<string, any>} */
  const rated = {};
  for (const [id, r] of Object.entries(state.rated)) {
    if (!r || r.pending || r.queued || (r.decision !== "up" && r.decision !== "down")) continue;
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
/** @param {string} b */
const unb64 = b => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, "")), c => c.charCodeAt(0)));

/** A push twenty seconds after the last thumb: one commit per sitting, not one per track. */
export function scheduleGhPush() {
  if (!ghEnabled()) return;
  clearTimeout(state.ghTimer); state.ghTimer = setTimeout(() => pushToGitHub().catch(() => {}), 20e3);
}
/** Write data/ratings.json (a no-op commit is skipped). Resolves true when the repo now matches. @param {{quiet?: boolean}} [opts] */
export async function pushToGitHub({ quiet = true } = {}) {
  if (!ghEnabled()) { if (!quiet) toast("Set a GitHub token in ⚙ first", true); return false; }
  if (!state.online) { if (!quiet) toast("Offline — the ratings push waits for the network", true); return false; }
  const headers = { Authorization: "Bearer " + state.settings.ghToken, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const url = `${API}/repos/${repo()}/contents/${PATH}`;
  const payload = ratingsPayload();
  try {
    let sha;
    const cur = await fetch(url, { headers, cache: "no-store" });
    if (cur.ok) {
      const j = await cur.json(); sha = j.sha;
      try { if (JSON.stringify(JSON.parse(unb64(j.content || "")).rated) === JSON.stringify(payload.rated)) { state.ghAt = Date.now(); persist(); if (!quiet) toast("The build already has these ratings"); return true; } } catch { /* rewrite it */ }
    } else if (cur.status !== 404) throw new Error(await reason(cur));
    const body = { message: `ratings: ${new Date().toISOString().slice(0, 10)} · ${payload.count} decisions [skip ci]`, content: b64(JSON.stringify(payload)), ...(sha ? { sha } : {}) };
    const r = await fetch(url, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(await reason(r));
    state.ghAt = Date.now(); persist();
    if (!quiet) toast(`Ratings pushed to ${repo()} · ${payload.count} decisions — the next build learns from them`);
    return true;
  } catch (e) {
    const msg = /** @type {Error} */ (e).message;
    toast("Ratings push to GitHub failed: " + msg, true);
    return false;
  }
}
/** @param {Response} r */
async function reason(r) {
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) return "the token was refused (expired or revoked?) — make a new fine-grained token with Contents: read and write on the repo";
  if (r.status === 403) return "the token may not write this repository (it needs Contents: read and write on " + repo() + ")" + (j.message ? ` · ${j.message}` : "");
  if (r.status === 404) return "repository not found for this token: check it is scoped to " + repo();
  if (r.status === 409 || r.status === 422) return "the file changed under us — try again";
  return (j && j.message) || r.statusText;
}
