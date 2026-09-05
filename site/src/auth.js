// @ts-check
/* Sign in with Google (Google Identity Services, token flow). Identity is remembered; the hour-long access token is
 * re-requested silently when needed. */
import { state, persist, forgetAccount, SCOPES } from "./state.js";
import { $, esc, toast } from "./dom.js";
import { render } from "./render.js";
import { pullRatings } from "./sync.js";
import { refreshRecent, titleFor } from "./youtube.js";
import { noticeDupes } from "./dupes.js";

export const tokenValid = () => !!(state.auth && state.auth.access_token && state.auth.expires_at > Date.now() + 30e3);
// feed.json names the curator accounts as SHA-256 of the lower-cased address (older feeds carried the address itself)
/** @param {string | undefined} email */
export async function emailHash(email) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(email || "").trim().toLowerCase()));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const curators = () => { const g = (state.feed && state.feed.google) || {}; return [...(g.curator_hashes || []), ...(g.curators || []).map(e => e.toLowerCase())]; };
export const isSignedIn = () => !!(state.auth && state.auth.email);
export const isOwner = () => isSignedIn() && (curators().includes(state.auth?.hash || "") || curators().includes((state.auth?.email || "").toLowerCase()));
export const guestsAllowed = () => !!(state.feed && state.feed.google && state.feed.google.guests);
// "curator" = anyone allowed to rate: the owner, or a guest when guests are enabled. Guests file into their own library.
export const isCurator = () => isOwner() || (isSignedIn() && guestsAllowed());
export const role = () => isOwner() ? "curator" : (isCurator() ? "guest" : "listener");

export function applyMode() {
  const on = isCurator();
  document.body.classList.toggle("curator", on);
  document.body.classList.toggle("guest", on && !isOwner());
  noticeDupes();
  const badge = $(".mode"); if (badge) { badge.textContent = role(); badge.title = isOwner() ? "Curator: thumbs file into the Indie Discotheque year playlists on YouTube Music" : `Guest: thumbs file into your own “${titleFor("<year>")}” playlists`; }
  const who = $("#who");
  if (state.auth && state.auth.email) {
    who.hidden = false;
    who.innerHTML = `${state.auth.picture ? `<img src="${esc(state.auth.picture)}" alt="">` : ""}<span>${esc(state.auth.name || state.auth.email)}</span>` + (on ? "" : ` <span class="muted">(listener)</span>`);
    $("#signin").textContent = "Sign out";
  } else {
    who.hidden = true;
    $("#signin").textContent = "Sign in with Google";
  }
  const cid = state.feed && state.feed.google && state.feed.google.client_id;
  $("#signin").disabled = !state.ready || !cid;
  $("#signin").title = !state.ready ? "loading the feed…" : cid ? "" : "Google client ID not configured yet (see SETUP.md)";
}
function ensureGis() {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return resolve(undefined);
    const s = document.createElement("script"); s.src = "https://accounts.google.com/gsi/client"; s.async = true; s.defer = true;
    s.onload = () => resolve(undefined); s.onerror = () => reject(new Error("could not load Google sign-in")); document.head.appendChild(s);
  });
}
// One token client for the page, created as soon as we know the client id (and preloaded for a remembered account),
// so the only thing left in a tap handler is requestAccessToken — browsers block the Google popup if it opens late.
export async function ensureTokenClient() {
  const cid = state.feed?.google && state.feed.google.client_id;
  if (!cid) return null;
  if (state.tokenClient) return state.tokenClient;
  await ensureGis();
  if (state.tokenClient) return state.tokenClient;
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: cid, scope: SCOPES,
    callback: (/** @type {any} */ resp) => state.authCb && state.authCb(resp),
    error_callback: (/** @type {any} */ err) => state.authErrCb && state.authErrCb(err),
  });
  return state.tokenClient;
}
/** @param {{silent?: boolean}} [opts] @returns {Promise<boolean>} */
export async function signIn({ silent = false } = {}) {
  const cid = state.feed?.google && state.feed.google.client_id;
  if (!cid) { toast("Google client ID not configured yet — see SETUP.md", true); return false; }
  const client = await ensureTokenClient();
  if (state.signingIn) return state.signingIn;          // one popup at a time
  state.signingIn = new Promise(resolve => {
    const done = (/** @type {boolean} */ v) => { state.signingIn = null; state.authCb = state.authErrCb = null; resolve(v); };
    const fail = (/** @type {string} */ why) => {
      state.lastAuthError = { why, at: Date.now() }; console.warn("Google sign-in did not complete:", why);
      if (!silent) toast(/popup_closed/.test(why) ? "Sign-in cancelled" : "Sign-in failed: " + why, true);
      done(false);
    };
    state.authErrCb = (/** @type {any} */ err) => fail((err && (err.type || err.message)) || "unknown");
    state.authCb = async (/** @type {any} */ resp) => {
      if (resp.error) return fail(resp.error + (resp.error_description ? " — " + resp.error_description : ""));
      const prev = state.auth || { expires_at: 0 }; const prevEmail = prev.email;
      state.auth = { ...prev, access_token: resp.access_token, expires_at: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
      state.lastAuthError = null;
      try {
        const me = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + resp.access_token } }).then(r => r.json());
        if (me && me.email) Object.assign(state.auth, { email: me.email, name: me.name, picture: me.picture, hash: await emailHash(me.email) });
      } catch { /* identity stays as remembered */ }
      if (prevEmail && prevEmail !== state.auth.email) forgetAccount();   // a different Google account: none of the old state applies
      persist(); applyMode(); render();
      if (silent) { if (isCurator() && Date.now() - (state.sync.at || 0) > 60e3) pullRatings(); return done(true); }
      if (isOwner()) { toast(`Curator mode on — ${state.auth.email}`); pullRatings().then(() => refreshRecent()).catch(() => {}); }
      else if (isCurator()) { toast(`Signed in as a guest. Keep files into “${titleFor("<year>")}” in your own YouTube library.`); pullRatings().then(() => refreshRecent()).catch(() => {}); }
      else toast(`Signed in as ${state.auth.email || "?"}. Guest rating is off, so it's listen-only.`);
      done(true);
    };
    // prompt "" = no consent screen when Google already remembers this grant; the hint skips the account chooser
    client.requestAccessToken({ prompt: "", hint: state.auth && state.auth.email ? state.auth.email : undefined });
  });
  return state.signingIn;
}
// The refresh could not complete (popup blocked, closed, or consent needed): offer a Sign in button right in the
// toast, so the next tap is a fresh user gesture that the browser will let open the Google popup.
export function needSignIn(msg = "Google sign-in needs a refresh") {
  toast(msg + (state.lastAuthError ? ` (${state.lastAuthError.why})` : ""), true, { label: "Sign in", fn: () => signIn().catch(e => toast(e.message, true)) });
}
// Keep the hour-long token alive while you're actively using the site: any tap or key press with less than five
// minutes left refreshes it (at most once a minute), so rating never runs into an expired token.
export function keepAlive() {
  if (!isSignedIn() || state.signingIn || !(state.feed?.google && state.feed.google.client_id)) return;
  if (state.auth?.access_token && state.auth.expires_at > Date.now() + 5 * 60e3) return;
  if (Date.now() - (state.keepAliveAt || 0) < 60e3) return;
  state.keepAliveAt = Date.now();
  signIn({ silent: true }).then(ok => { if (!ok) needSignIn(); });
}
// Sign-out only forgets this device. It deliberately does NOT revoke the Google grant: revoking kills the tokens on
// your other devices too (and can even race a fresh sign-in on this one). Disconnecting the site for good is a
// Google-account action: https://myaccount.google.com/permissions
export function signOut() {
  state.auth = null; forgetAccount(); persist(); applyMode(); render(); toast("Signed out on this device");
}
// A valid token for the next few minutes, refreshing silently when it is about to lapse. Call it first thing in a
// click handler so the (auto-closing) Google popup is still allowed by the browser.
export async function ensureToken({ minutes = 3 } = {}) {
  if (state.auth && state.auth.access_token && state.auth.expires_at > Date.now() + minutes * 60e3) return true;
  if (!isSignedIn()) return false;
  return signIn({ silent: true });
}
/** @template T @param {(token: string) => Promise<T>} fn @returns {Promise<T>} */
export async function withAuth(fn) {
  if (!(await ensureToken({ minutes: 1 }))) { const ok = isSignedIn() ? false : await signIn(); if (!ok || !tokenValid()) throw new Error("Google sign-in needs a refresh"); }
  return fn(/** @type {string} */ (state.auth?.access_token));
}
