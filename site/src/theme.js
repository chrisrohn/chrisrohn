// @ts-check
/* The app side of the theme switch. site/theme.js (a classic script in <head>) owns the preference and the header
 * toggle so Privacy and Terms get it too and nothing flashes before the bundle loads; this wires ⚙ → Theme and the
 * t key to it. */
import { $, toast } from "./dom.js";

const T = () => window.NewMusicTheme;

/** Cycle system → light → dark and say so (the t key). */
export function cycleTheme() {
  const t = T(); if (!t) return;
  const pref = t.cycle();
  toast(`${t.glyph(pref)} Theme: ${t.name(pref)}${pref === "auto" ? ` (${t.effective()}, following your device)` : ""}`);
}

export function wireTheme() {
  const t = T(), sel = $("#s-theme"); if (!t || !sel) return;
  sel.value = t.get();
  sel.addEventListener("change", () => t.set(sel.value));
  document.addEventListener("themechange", () => { sel.value = t.get(); });
}
