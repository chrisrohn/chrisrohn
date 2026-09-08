/* Theme: system, light or dark. A classic script every page loads synchronously in <head>, before the first paint,
 * so a saved choice never flashes the other scheme. The choice lives in localStorage under id:theme ("light" or
 * "dark"; anything else means follow the device). It sets data-theme on <html> (style.css keys light-dark() off
 * it), keeps the theme-color metas honest for the browser chrome, wires every [data-theme-toggle] button, follows
 * the device while on "system", follows other tabs via the storage event, and exposes window.NewMusicTheme for the
 * app bundle (⚙ → Theme select, the t key). */
(() => {
  const KEY = "id:theme", ORDER = ["auto", "light", "dark"];
  const COLORS = { light: "#e7e3da", dark: "#1c1c1a" };   // --paper in each scheme; keep in step with style.css and the manifest
  const GLYPH = { auto: "◐︎", light: "☀︎", dark: "☾︎" };
  const NAME = { auto: "system", light: "light", dark: "dark" };
  const root = document.documentElement;
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  /** @returns {"auto" | "light" | "dark"} */
  const get = () => { try { const v = String(localStorage.getItem(KEY) || "").replace(/"/g, ""); return v === "light" || v === "dark" ? v : "auto"; } catch { return "auto"; } };
  /** @param {string} pref */
  const effective = pref => (pref === "auto" ? (mq.matches ? "dark" : "light") : pref);
  const next = () => ORDER[(ORDER.indexOf(get()) + 1) % ORDER.length];
  /** What a toggle does next, spelled out for the tooltip and screen readers. @param {string} pref */
  const describe = pref => `Theme: ${NAME[pref]}${pref === "auto" ? ` (following your device, now ${effective(pref)})` : ""} · switch to ${NAME[next()]}`;

  /* The browser chrome (Android's status bar in an installed app, the toolbar in a tab, iOS's status bar) follows
   * <meta name="theme-color">. The page ships a media-qualified pair for a no-JS visit, but media on a theme-color
   * meta is matched against the *device* scheme, so a choice pinned here could never reach it — and Chromium does
   * not reliably re-read a media-qualified meta when its content changes, which is why the strip above the header
   * stayed light. So once we are running there is exactly one theme-color meta, media-less and ours: the static
   * pair goes, and the survivor is re-inserted on every change so every engine, installed PWAs included, picks the
   * new colour up. iOS reads its status-bar style once at launch; keeping it in step means the next launch of a
   * pinned-dark app opens with a dark bar instead of a white one.
   * @param {"light" | "dark"} eff */
  function chrome(eff) {
    document.querySelectorAll('meta[name="theme-color"]:not([data-theme-color])').forEach(m => m.remove());
    let m = document.querySelector('meta[name="theme-color"][data-theme-color]');
    if (!m) { m = document.createElement("meta"); m.setAttribute("name", "theme-color"); m.setAttribute("data-theme-color", ""); }
    if (m.getAttribute("content") !== COLORS[eff] || !m.isConnected) {
      m.remove(); m.setAttribute("content", COLORS[eff]); (document.head || root).appendChild(m);
    }
    const ios = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (ios) ios.setAttribute("content", eff === "dark" ? "black-translucent" : "default");
  }

  function apply() {
    const pref = get(), eff = effective(pref);
    if (pref === "auto") delete root.dataset.theme; else root.dataset.theme = pref;
    root.dataset.scheme = eff;   // the scheme actually on screen, for anything that wants to know without a media query
    chrome(eff);
    document.querySelectorAll("[data-theme-toggle]").forEach(b => {
      b.textContent = GLYPH[pref]; b.setAttribute("title", describe(pref)); b.setAttribute("aria-label", describe(pref)); b.dataset.theme = pref;
    });
    document.dispatchEvent(new CustomEvent("themechange", { detail: { pref, scheme: eff } }));
  }
  /** @param {string} pref */
  function set(pref) {
    try { if (pref === "light" || pref === "dark") localStorage.setItem(KEY, pref); else localStorage.removeItem(KEY); } catch { /* storage may be unavailable */ }
    apply();
  }
  const cycle = () => { set(next()); return get(); };

  apply();
  mq.addEventListener("change", apply);
  window.addEventListener("storage", e => { if (e.key === KEY || e.key === null) apply(); });
  const wire = () => { document.querySelectorAll("[data-theme-toggle]").forEach(b => b.addEventListener("click", cycle)); apply(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire); else wire();

  window.NewMusicTheme = { KEY, get, set, cycle, effective: () => effective(get()), name: pref => NAME[pref || get()], glyph: pref => GLYPH[pref || get()] };
})();
