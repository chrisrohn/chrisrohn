// @ts-check
/* Installed-app plumbing: the service worker and its "new version ready" prompt, the Install button (Chromium's
 * prompt where the browser offers one, a how-to sheet on iOS and elsewhere), the app shortcuts from the manifest
 * (?view=picks, ?new=1, ?audition=1) and a feed refresh when a long-open app comes back to the foreground.
 * Lock-screen controls live in player.js (Media Session) and the share sheet in dom.js. */
import { state, persist } from "./state.js";
import { $, $$, toast } from "./dom.js";
import { refreshFeed } from "./feed.js";

const DISMISS_MS = 14 * 86400e3;   // hide the header button this long after "not now"; ⚙ always offers it
/** @type {BeforeInstallPromptEvent | null} */
let deferred = null;
/** @type {ServiceWorkerRegistration | null} */
let reg = null;
let wantReload = false;

export const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || window.matchMedia("(display-mode: minimal-ui)").matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isAndroid = () => /Android/.test(navigator.userAgent);
const isSafari = () => /Safari/.test(navigator.userAgent) && !/Chrome|CriOS|Edg|FxiOS|OPR/.test(navigator.userAgent);
const isFirefox = () => /Firefox|FxiOS/.test(navigator.userAgent);
/** The content hash build.mjs put in the bundle's file name. */
export const build = () => (/** @type {HTMLScriptElement | null} */ ($('script[src*="app."]'))?.getAttribute("src") || "").match(/app\.([0-9a-f]+)\.js/)?.[1] || "dev";

/** Shortcuts and the start_url land here before the feed loads; the URL is cleaned so a reload does not re-apply them. */
export function applyLaunchParams() {
  const p = new URLSearchParams(location.search);
  if (![...p.keys()].length) return;
  if (p.get("view") === "picks") { state.view = "picks"; $$(".tab").forEach(x => x.classList.toggle("active", x.dataset.view === "picks")); }
  if (p.get("new") === "1") { state.filters.onlyNew = true; $("#only-new").checked = true; }
  if (p.get("audition") === "1") { state.settings.audition = true; const cb = $("#audition"); if (cb) cb.checked = true; }
  if (p.has("view") || p.has("new") || p.has("audition")) persist();
  history.replaceState(null, "", location.pathname);
}

export function wirePwa() {
  document.body.classList.toggle("standalone", isStandalone());
  window.matchMedia("(display-mode: standalone)").addEventListener("change", renderInstallUi);
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferred = e; renderInstallUi(); });
  window.addEventListener("appinstalled", () => { deferred = null; toast("Installed — open New Music from your home screen or app list"); renderInstallUi(); });
  $("#install-btn").addEventListener("click", install);
  $("#install-bar-btn").addEventListener("click", install);
  $("#install-bar-x").addEventListener("click", dismiss);
  $("#s-install-btn").addEventListener("click", install);
  $("#install-later").addEventListener("click", dismiss);
  $("#s-update-btn").addEventListener("click", checkForUpdate);
  $("#install-help").addEventListener("close", renderInstallUi);
  renderInstallUi();
  registerSw();
  // an app left open overnight: pick up the new daily feed (and a new build) when it comes back to the foreground
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { refreshFeed().catch(() => {}); if (reg) reg.update().catch(() => {}); } });
}

function dismiss() { state.settings.installDismissedAt = Date.now(); persist(); renderInstallUi(); }
async function install() {
  if (deferred) {
    const ev = deferred; deferred = null;
    try {
      await ev.prompt();
      const { outcome } = await ev.userChoice;
      if (outcome === "dismissed") { state.settings.installDismissedAt = Date.now(); persist(); }
    } catch { /* the prompt can only be used once; the how-to covers the rest */ }
    renderInstallUi();
    return;
  }
  showHowTo();
}
function showHowTo() {
  /** @type {string[]} */
  let steps;
  if (isIOS()) steps = ["Open this page in Safari (Chrome and Firefox on iPhone can install too, from their share menu).", "Tap the <b>Share</b> button — the square with an arrow at the bottom (iPhone) or top (iPad) of the screen.", "Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.", "New Music opens full-screen from its own icon and keeps the last feed for offline listening."];
  else if (isAndroid()) steps = ["Open the browser menu (<b>⋮</b>) in the top-right corner.", "Tap <b>Install app</b> (Chrome, Edge, Samsung Internet) or <b>Add to Home screen</b> (Firefox).", "Confirm. New Music appears with the other apps, with lock-screen play/pause/next while it plays."];
  else if (isFirefox()) steps = ["Firefox on the desktop does not install web apps. Use Chrome, Edge, Brave or Safari 17+ for that.", "On Android, Firefox can: menu → <b>Add to Home screen</b>."];
  else if (isSafari()) steps = ["In Safari 17 or newer on macOS Sonoma: <b>File → Add to Dock…</b>", "Confirm the name and icon. New Music opens in its own window, like any Mac app."];
  else steps = ["Look for the <b>install icon</b> at the right end of the address bar (a monitor with a down arrow) and click it.", "Or open the browser menu (<b>⋮</b>) → <b>Cast, save and share → Install page as app…</b> (Chrome) / <b>Apps → Install this site as an app</b> (Edge).", "New Music opens in its own window, with media keys driving play/pause and next/previous."];
  $("#install-steps").innerHTML = steps.map(s => `<li>${s}</li>`).join("");
  $("#install-help").showModal();
}
export function renderInstallUi() {
  const standalone = isStandalone(); document.body.classList.toggle("standalone", standalone);
  const dismissed = Date.now() - (state.settings.installDismissedAt || 0) < DISMISS_MS;
  const supported = !!deferred || isIOS() || isAndroid() || !isFirefox();
  // desktop: a button in the header; phones: a slim bar under it (the header has no room), either until "not now"
  $("#install-btn").hidden = standalone || dismissed || !supported;
  $("#install-bar").hidden = standalone || dismissed || !supported;
  $("#install-later").hidden = dismissed;
  $("#s-install-btn").hidden = standalone || !supported;
  $("#s-update-btn").hidden = !reg;
  $("#s-install-text").textContent = standalone
    ? "Running as an installed app: full-screen, offline with the last feed, lock-screen controls while it plays."
    : supported ? "Install as an app for a full-screen feed from its own icon, offline with the last feed, and lock-screen play/pause/next."
    : "This browser does not install web apps; Chrome, Edge, Brave and Safari do.";
  $("#s-build").textContent = `build ${build()}`;
}

async function registerSw() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  try {
    reg = await navigator.serviceWorker.register("/sw.js");
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const w = reg?.installing; if (!w) return;
      w.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) offerUpdate(w); });
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (wantReload) { wantReload = false; location.reload(); } });
    renderInstallUi();
  } catch { /* offline support is a bonus, never a blocker */ }
}
/** @param {ServiceWorker} w */
function offerUpdate(w) {
  toast("A new version of the site is ready", false, { label: "Reload", fn: () => { wantReload = true; w.postMessage({ type: "SKIP_WAITING" }); setTimeout(() => { if (wantReload) location.reload(); }, 1500); } });
}
async function checkForUpdate() {
  if (!reg) return;
  try {
    await reg.update();
    if (reg.waiting) offerUpdate(reg.waiting); else if (reg.installing) toast("Downloading a new version…"); else toast(`You are on the latest version (build ${build()})`);
  } catch (e) { toast("Could not check for updates: " + /** @type {Error} */ (e).message, true); }
}
