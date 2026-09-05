// @ts-check
/* Small DOM and text helpers. */

/** @param {string} s @param {ParentNode} [el] @returns {any} */
export const $ = (s, el = document) => el.querySelector(s);
/** @param {string} s @param {ParentNode} [el] @returns {any[]} */
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
/** @param {unknown} s */
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);
// feed links come from blog RSS, the one input nobody vets: only http(s) may become an href
/** @param {unknown} u @returns {string | null} */
export const safeUrl = u => { const v = Array.isArray(u) ? u[0] : u; return typeof v === "string" && /^https?:\/\/\S+$/i.test(v.trim()) ? v.trim() : null; };
/** @param {unknown} a @param {unknown} b */
export const sameName = (a, b) => String(a || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "") === String(b || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
/** @param {Date} d */
export function relTime(d) { const m = Math.round((Date.now() - d.getTime()) / 60000); if (m < 60) return m + " min ago"; const h = Math.round(m / 60); if (h < 36) return h + " h ago"; return Math.round(h / 24) + " d ago"; }
/** @param {number} a @param {number} b */
export const range = (a, b) => { const r = []; for (let y = a; y >= b; y--) r.push(y); return r; };

/** The system share sheet, where there is one (phones, Safari, Chromium on Windows/ChromeOS); otherwise copy the link. */
export const canShare = () => typeof navigator.share === "function";
/** @param {import("./types").FeedItem} it */
export async function shareTrack(it) {
  const title = `${it.artist} - ${it.display_title || it.title}`;
  const url = it.youtube && it.youtube.videoId ? "https://music.youtube.com/watch?v=" + it.youtube.videoId : (safeUrl(Object.values(it.links || {})[0]) || location.origin);
  try { await navigator.share({ title, text: `${title} · via Chris Rohn's New Music`, url }); }
  catch (e) {
    if (/** @type {Error} */ (e).name === "AbortError") return;
    try { await navigator.clipboard.writeText(url); toast("Link copied"); } catch { toast("Could not share this one", true); }
  }
}

/** Copy a link or a line of text, with a toast either way. @param {string} text */
export async function copyText(text) { try { await navigator.clipboard.writeText(text); toast("Link copied"); } catch { toast("Could not copy — the link is " + text, true); } }

/** @type {any} */
let toastTimer;
/** @param {string} msg @param {boolean} [err] @param {{label: string, fn: () => void}} [action] */
export function toast(msg, err = false, action) {
  let t = $(".toast"); if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); t.setAttribute("aria-live", "polite"); document.body.appendChild(t); }
  t.textContent = msg; t.classList.toggle("err", err); t.style.display = "";
  if (action) { const b = document.createElement("button"); b.className = "btn ghost"; b.textContent = action.label; b.addEventListener("click", () => { t.style.display = "none"; action.fn(); }); t.appendChild(b); }
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.display = "none"; }, err ? 7000 : (action ? 8000 : 2600));
}
