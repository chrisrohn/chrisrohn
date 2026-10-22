"use strict";
// Shared by the dashboard (shell.js) and ride mode (ride.js), inlined first in each page's <head>:
//   theme  the one light / dark rule: battery saver's black, else the choice made here, else ("auto") the phone's;
//          applied at once, before anything paints, so a dark page never flashes white
//   ask    the themed confirm sheet (#ask in each page), resolved true for its yes button
self.FitnessUI = (() => {
  const deviceDark = matchMedia("(prefers-color-scheme: dark)");
  /** The stored choice: "light", "dark" or "auto" (dark when nothing's chosen yet). */
  const pref = () => { try { return localStorage.getItem("fitness-theme") || "dark"; } catch { return "dark"; } };
  /** The theme to show now. @param {boolean} [saver] battery saver on: always black */
  const theme = (saver = false) => { if (saver) return "dark"; const t = pref(); return t === "auto" ? (deviceDark.matches ? "dark" : "light") : t; };
  /** @param {boolean} [saver] */
  const apply = (saver = false) => { document.documentElement.dataset.theme = theme(saver); };
  apply();
  /** @param {string} title @param {string} text @param {string} yes @param {{danger?: boolean}} [opt] @returns {Promise<boolean>} */
  function ask(title, text, yes, { danger = false } = {}) {
    const $ = id => /** @type {HTMLElement} */ (document.getElementById(id));
    const d = /** @type {HTMLDialogElement | null} */ (document.getElementById("ask"));
    if (!d || typeof d.showModal !== "function") return Promise.resolve(confirm(`${title} ${text}`.trim()));
    $("ask-h").textContent = title; $("ask-p").textContent = text; $("ask-p").hidden = !text;
    const y = $("ask-yes"); y.textContent = yes; y.classList.toggle("danger", danger); y.classList.toggle("primary", !danger);
    d.returnValue = "";
    return new Promise(res => { d.addEventListener("close", () => res(d.returnValue === "yes"), { once: true }); d.showModal(); $("ask-no").focus(); });
  }
  return { deviceDark, pref, theme, apply, ask };
})();
