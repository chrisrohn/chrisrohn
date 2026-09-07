// @ts-check
/* The API activity sheet: every YouTube Data API request this browser makes, as it happens, in plain words.
 * What the sheet shows is exactly what the site does with the API: read a playlist to verify what it holds, add the
 * track the curator approved, remove one they took back or that the cleanup found twice. Kept in this browser (the
 * last 400 calls), never sent anywhere; Copy / Download give the same rows as text or JSON for a compliance review. */
import { state, persist, LS, quotaText } from "./state.js";
import { $, esc, toast } from "./dom.js";

/** @typedef {import("./types").ApiEntry} ApiEntry */

const MAX = 400;
/** How each endpoint reads when the caller gave no reason of its own. @param {string} method @param {string} path @param {Record<string, any>} params */
export function describe(method, path, params) {
  const p = path.replace(/^\//, "");
  if (p === "playlists" && method === "GET") return "List the playlists in the signed-in YouTube library";
  if (p === "playlists" && method === "POST") return "Create a playlist in the signed-in YouTube library";
  if (p === "playlistItems" && method === "GET") return params.videoId ? "Verify whether this video is already in the playlist" : `Read the playlist's contents${params.pageToken ? " (next page)" : ""}`;
  if (p === "playlistItems" && method === "POST") return "Add the approved track to the playlist";
  if (p === "playlistItems" && method === "DELETE") return "Remove a track from the playlist";
  return `${method} ${p}`;
}
/** @param {Record<string, any>} params */
const shortParams = params => Object.entries(params).filter(([k, v]) => v != null && !["part", "maxResults", "mine"].includes(k)).map(([k, v]) => `${k}=${String(v).length > 40 ? String(v).slice(0, 37) + "…" : v}`).join(" ");

/** Record one request the moment YouTube answers (or refuses). @param {Omit<ApiEntry, "at">} e */
export function logApi(e) {
  state.apiLog.push({ ...e, at: Date.now() });
  if (state.apiLog.length > MAX) state.apiLog.splice(0, state.apiLog.length - MAX);
  LS.set("id:apilog", state.apiLog);
  if ($("#apilog")?.open) renderApiLog();
}
/** @param {Date} d */
const hms = d => d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
/** @param {ApiEntry} e */
const line = e => `${hms(new Date(e.at))}  ${e.method.padEnd(6)} ${e.path.padEnd(15)} ${String(e.status).padEnd(4)} ${String(e.units + "u").padEnd(4)} ${String(e.ms + "ms").padEnd(7)} ${e.why}${e.detail ? " · " + e.detail : ""}${e.error ? " · ERROR " + e.error : ""}`;
/** The rows the sheet shows: newest first, today's session in full. */
export function renderApiLog() {
  const rows = [...state.apiLog].reverse();
  const reads = state.apiLog.filter(e => e.method === "GET" && e.ok).length, writes = state.apiLog.filter(e => e.method !== "GET" && e.ok).length;
  $("#apilog-summary").textContent = rows.length ? `${rows.length} request${rows.length === 1 ? "" : "s"} remembered on this device · ${reads} read${reads === 1 ? "" : "s"} (1 unit each) · ${writes} write${writes === 1 ? "" : "s"} (50 units each) · ${quotaText()}` : "No YouTube API requests yet. Sign in as a curator and press Keep on a card: the requests appear here as they happen.";
  $("#apilog-rows").innerHTML = rows.length ? rows.map(e => `<div class="api-row ${e.ok ? (e.method === "GET" ? "read" : "write") : "fail"}">
      <span class="api-t">${esc(hms(new Date(e.at)))}</span>
      <span class="api-m">${esc(e.method)}</span>
      <span class="api-p" title="${esc(shortParams(e.params || {}))}">${esc(e.path)}${e.params && Object.keys(e.params).length ? `<small>${esc(shortParams(e.params))}</small>` : ""}</span>
      <span class="api-s" title="HTTP status · quota units · round trip">${esc(String(e.status))} · ${e.units}u · ${e.ms}ms</span>
      <span class="api-w">${esc(e.why)}${e.detail ? `<small>${esc(e.detail)}</small>` : ""}${e.error ? `<small class="err">${esc(e.error)}</small>` : ""}</span>
    </div>`).join("") : "";
}
export function openApiLog() { renderApiLog(); $("#apilog").showModal(); }
/** The same rows as plain text, oldest first, for a ticket or an email. */
export const apiLogText = () => [`YouTube Data API v3 requests made by ${location.host} in this browser (${state.auth?.email || "not signed in"})`, `exported ${new Date().toISOString()}`, "", ...state.apiLog.map(line)].join("\n");
export function wireApiLog() {
  $("#s-apilog").addEventListener("click", () => { $("#settings").close(); openApiLog(); });
  $("#apilog-copy").addEventListener("click", async () => { try { await navigator.clipboard.writeText(apiLogText()); toast("API activity copied"); } catch { toast("Could not copy", true); } });
  $("#apilog-download").addEventListener("click", () => {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify({ site: location.host, account: state.auth?.email || null, exported: new Date().toISOString(), requests: state.apiLog }, null, 2)], { type: "application/json" }));
    a.download = `youtube-api-activity-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  });
  $("#apilog-clear").addEventListener("click", () => { state.apiLog = []; LS.set("id:apilog", []); persist(); renderApiLog(); });
}
