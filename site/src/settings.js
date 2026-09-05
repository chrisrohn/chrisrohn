// @ts-check
/* The ⚙ dialog: account, quota, sync, duplicates, feed health, audition settings. */
import { state, persist, quotaText, skipsInYouTube, clearLocalState } from "./state.js";
import { $, esc, relTime, toast } from "./dom.js";
import { isOwner, guestsAllowed } from "./auth.js";
import { pushRatings, pullRatings } from "./sync.js";
import { loadLibraryPlaylists } from "./youtube.js";
import { renderDupes, scanYear, bulkRemoveExtras } from "./dupes.js";
import { startAudition, clearAudition, auditionOn } from "./player.js";

function exportCsv() {
  const rows = [["Title", "Artist", "Notation", "Year", "YouTube"], ...Object.values(state.rated).filter(d => d.decision === "up").map(d => [d.title, d.artist, `${d.artist} - ${d.title}`, d.year, d.videoId ? "https://music.youtube.com/watch?v=" + d.videoId : ""])];
  const csv = rows.map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = `new-music-approvals-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
}
function openSettings() {
  const feed = state.feed; if (!feed) return;
  const yrs = [...new Set([...Object.keys(state.playlists).filter(k => !k.startsWith("__")), ...(isOwner() ? Object.keys((feed.youtube && feed.youtube.playlists) || {}) : [])])].sort();
  $("#s-playlists").textContent = `${yrs.length} year playlists known${yrs.length ? ` (${yrs[0]}–${yrs[yrs.length - 1]})` : ""}` + (state.playlists.__skipped ? ` · skipped playlist: ${state.playlists.__skipped}` : "") + (state.notOwner ? " · the Indie Discotheque playlists are collaborative (owned by @indiedisco); filing uses their known ids" : "");
  $("#s-quota").textContent = quotaText();
  $("#s-auth-problem").textContent = state.lastAuthError ? `Last sign-in problem: ${state.lastAuthError.why} (${relTime(new Date(state.lastAuthError.at))}).` : "";
  $("#s-sync").textContent = state.sync.at ? `Ratings synced across your devices via Google Drive app data · last sync ${relTime(new Date(state.sync.at))} · ${Object.keys(state.rated).length} rated tracks remembered` : "Ratings not synced yet — sign in to sync across devices (uses a hidden app-data file in your Google Drive).";
  const g = $("#s-guests");
  if (isOwner()) {
    g.hidden = false;
    g.innerHTML = `Guest rating is <b>${guestsAllowed() ? "on" : "off"}</b> (other Google accounts ${guestsAllowed() ? "can rate into their own “" + esc((feed.google || {}).guest_playlist_title_pattern || "") + "” playlists" : "get a listen-only site"}). This is a site-wide switch, so it lives in the repo: <a href="https://github.com/chrisrohn/chrisrohn/edit/main/discovery/config.yaml" target="_blank" rel="noopener">edit config.yaml</a> → <code>google.guests: ${guestsAllowed() ? "false" : "true"}</code>. Takes effect at the next daily build (or run the Discover workflow).`;
  } else g.hidden = true;
  const fh = feed.feed_health || {};
  const rows = Object.entries(fh).sort((x, y) => (y[1].kept - x[1].kept) || x[0].localeCompare(y[0]));
  $("#s-feeds").innerHTML = rows.length ? rows.map(([n, h]) => `<span class="${h.ok ? (h.kept ? "ok" : "quiet") : "dead"}" title="${esc(h.error || "")}">${esc(n)} ${h.ok ? h.kept + "/" + h.entries : "✗"}</span>`).join("") : "<span class=\"muted\">no blog feed data yet</span>";
  $("#s-skips").checked = skipsInYouTube();
  renderDupes();
  $("#settings").showModal();
}
export function wireSettings() {
  $("#settings-btn").addEventListener("click", openSettings);
  const aud = $("#audition"); aud.checked = auditionOn(); $("#audition-label").textContent = (state.settings.auditionSeconds || 30) + "s";
  aud.addEventListener("change", () => { state.settings.audition = aud.checked; persist(); if (aud.checked && state.playerReady && state.player.getPlayerState() === YT.PlayerState.PLAYING) startAudition(); else clearAudition(); });
  $("#s-aud-secs").value = state.settings.auditionSeconds || 30; $("#s-aud-start").value = state.settings.auditionStart ?? 25;
  $("#s-aud-secs").addEventListener("change", (/** @type {any} */ e) => { state.settings.auditionSeconds = Math.max(10, +e.target.value || 30); $("#audition-label").textContent = state.settings.auditionSeconds + "s"; persist(); });
  $("#s-aud-start").addEventListener("change", (/** @type {any} */ e) => { state.settings.auditionStart = Math.min(80, Math.max(0, +e.target.value || 0)); persist(); });
  $("#s-dupe-scan").addEventListener("click", () => scanYear(+$("#s-dupe-year").value).catch(e => { $("#s-dupe-status").textContent = ""; toast(e.message, true); }));
  ["#s-dupe-kind", "#s-dupe-yr"].forEach(id => $(id).addEventListener("change", () => renderDupes()));
  $("#s-dupe-q").addEventListener("input", () => { clearTimeout(state.dupeQT); state.dupeQT = setTimeout(() => renderDupes(), 200); });
  $("#s-dupe-bulk").addEventListener("click", bulkRemoveExtras);
  $("#s-skips").addEventListener("change", (/** @type {any} */ e) => { state.settings.skipsInYouTube = e.target.checked; persist(); });
  $("#s-export").addEventListener("click", exportCsv);
  $("#s-syncnow").addEventListener("click", () => pushRatings().then(() => pullRatings()).then(() => { $("#s-sync").textContent = `Synced just now · ${Object.keys(state.rated).length} rated tracks`; toast("Ratings synced"); }).catch(e => toast(e.message, true)));
  $("#s-reload").addEventListener("click", () => loadLibraryPlaylists().then(() => toast(`Playlists reloaded: ${Object.keys(state.playlists).filter(k => !k.startsWith("__")).length} year playlists found`)).catch(e => toast(e.message, true)));
  $("#s-clear").addEventListener("click", () => { if (confirm("Clear local state (sign-in, filters, settings, local rating mirror)? Nothing in YouTube or Drive is touched.")) { clearLocalState(); location.reload(); } });
}
