// @ts-check
/* The YouTube embed, autoplay through the list, and audition mode (start partway in, move on after N seconds). */
import { state, byId, badVideo, markBadVideo } from "./state.js";
import { $, $$, esc, sameName, toast } from "./dom.js";
import { visibleItems } from "./feed.js";
import { renderDeck, deckOn, deckItem, focusCard } from "./render.js";
import { matchLabel } from "./years.js";
import { scoreOf } from "./rank.js";

window.onYouTubeIframeAPIReady = () => {
  state.player = new YT.Player("yt", {
    width: "356", height: "200", videoId: state.pendingVideo || undefined,
    playerVars: { autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1, origin: location.origin },
    events: {
      onReady: () => {
        state.playerReady = true;
        const frame = $("#yt iframe"); if (frame && !frame.title) frame.title = "YouTube player";
        if (state.pendingVideo) { state.player.loadVideoById(state.pendingVideo); state.pendingVideo = null; }
      },
      onStateChange: (/** @type {any} */ e) => {
        if (e.data === YT.PlayerState.ENDED && $("#autoplay").checked) { clearAudition(); nextTrack(); }
        if (e.data === YT.PlayerState.PLAYING) { startAudition(); setPlaybackState("playing"); reflectPlaying(true); }
        if (e.data === YT.PlayerState.PAUSED) { clearAudition(false); setPlaybackState("paused"); reflectPlaying(false); }
        if (e.data === YT.PlayerState.ENDED) { setPlaybackState("none"); reflectPlaying(false); }
      },
      onError: (/** @type {any} */ e) => {
        const it = current(); const vid = it?.youtube?.videoId; const url = vid ? "https://music.youtube.com/watch?v=" + vid : null;
        // 100 = removed or private, 101/150 = the owner disallows embedding: remember it so autoplay steps over it next time
        if (vid && [100, 101, 150].includes(Number(e && e.data))) { markBadVideo(vid); $$(`.card[data-id="${CSS.escape(it.id)}"], .dcard[data-id="${CSS.escape(it.id)}"]`).forEach(c => c.classList.add("noembed")); }
        toast("Can't embed this one", true, url ? { label: "Open in YT Music", fn: () => window.open(url, "_blank", "noopener") } : undefined);
        if ($("#autoplay").checked) nextTrack();   // keep the queue moving; a popup here would be blocked anyway
      },
    },
  });
};
const current = () => (state.currentId && byId(state.currentId)) || visibleItems().find(i => i.id === state.currentId);

/* Media Session: the lock screen, notification shade, headphone buttons and keyboard media keys drive the queue.
 * The top frame's session takes precedence over the YouTube iframe's, so the artwork and title shown are ours. */
const ms = () => ("mediaSession" in navigator ? navigator.mediaSession : null);
let msWired = false;
function wireMediaSession() {
  const s = ms(); if (!s || msWired) return; msWired = true;
  /** @param {MediaSessionAction} a @param {() => void} fn */
  const on = (a, fn) => { try { s.setActionHandler(a, fn); } catch { /* not every browser knows every action */ } };
  on("play", () => { if (state.playerReady) state.player.playVideo(); });
  on("pause", () => { if (state.playerReady) state.player.pauseVideo(); });
  on("stop", stopPlayer);
  on("nexttrack", nextTrack);
  on("previoustrack", prevTrack);
  on("seekbackward", () => { if (state.playerReady) state.player.seekTo(Math.max(0, state.player.getCurrentTime() - 10), true); });
  on("seekforward", () => { if (state.playerReady) state.player.seekTo(state.player.getCurrentTime() + 10, true); });
}
/** @param {import("./types").FeedItem} it */
function announce(it) {
  const s = ms(); if (!s) return;
  const art = it.artwork || (it.youtube && it.youtube.thumbnail);
  try { s.metadata = new MediaMetadata({ title: it.display_title || it.title, artist: it.artist, album: it.release || "", artwork: art ? [{ src: art }] : [] }); } catch { /* ignore */ }
}
/** @param {"none" | "paused" | "playing"} st */
function setPlaybackState(st) { const s = ms(); if (s) { try { s.playbackState = st; } catch { /* ignore */ } } }
function ensureApi() { if (window.YT && window.YT.Player) return; if ($("#yt-api")) return; const s = document.createElement("script"); s.id = "yt-api"; s.src = "https://www.youtube.com/iframe_api"; document.head.appendChild(s); }
/** @param {string | null | undefined} id */
export function play(id) {
  if (!id) return;
  state.currentId = id; const it = current(); const vid = it?.youtube?.videoId; if (!it || !vid) return;
  $$(".card.current, .dcard.current").forEach(c => c.classList.remove("current"));
  const el = $(`.card[data-id="${CSS.escape(id)}"], .dcard[data-id="${CSS.escape(id)}"]`); if (el) el.classList.add("current");
  reflectPlaying(true);
  $("#player").hidden = false;
  renderNow(it);
  ensureApi(); wireMediaSession(); announce(it);
  clearAudition(); state.auditionArmed = null;
  if (state.playerReady) state.player.loadVideoById(vid); else state.pendingVideo = vid;
}
/** The play/pause buttons show the pause icon while something plays (an SVG pair switched by class). @param {boolean} on */
export function reflectPlaying(on) { $$("#deck-play, #p-toggle").forEach(b => b.classList.toggle("playing", on)); }
/** @param {string} id */
const lookup = id => byId(id) || visibleItems().find(x => x.id === id);
/** The next playable id in list order from index `i` in the given direction, or null at the end. @param {number} i @param {number} delta */
function playableFrom(i, delta) {
  for (let j = i + delta; j >= 0 && j < state.order.length; j += delta) { const id = state.order[j]; const vid = lookup(id)?.youtube?.videoId; if (vid && !badVideo(vid)) return id; }
  return null;
}
/** What "next" would play: the following card in the deck, or the next playable row of the list. */
function upNext() {
  if (!state.currentId) return null;
  if (deckOn()) return visibleItems()[state.deckIndex + 1] || null;
  const id = playableFrom(state.order.indexOf(state.currentId), 1); return id ? lookup(id) || null : null;
}
/** The bar's now-playing panel: the card's own facts (rank, match, release, tags, sources, score) and what comes next.
 * @param {import("./types").FeedItem} it */
function renderNow(it) {
  const n = state.order.indexOf(it.id);
  $("#np-eyebrow").innerHTML = "now playing" + (n >= 0 ? ` <span class="muted">· No. ${String(n + 1).padStart(2, "0")} / ${state.order.length}</span>` : "");
  const ml = it.match_kind ? matchLabel(it) : "";
  const rel = it.release && !sameName(it.release, it.title) ? ` <span class="muted">· ${esc(it.release)}</span>` : "";
  $("#now").innerHTML = `<b class="np-artist">${esc(it.artist)}${ml ? ` <span class="match ${esc(it.match_kind || "")}">${esc(ml)}</span>` : ""}</b><span class="np-sep"> - </span><span class="np-title">${esc(it.display_title || it.title)}${rel}</span>`;
  $("#np-spec").textContent = [it.release_type, it.release_date, (it.tags || []).slice(0, 4).join(", ")].filter(Boolean).join(" · ");
  $("#np-sources").innerHTML = (it.sources || []).map(s => { const [k, name] = s.split(":"); return `<span class="src ${esc(k)}" title="${esc(s)}">${esc(name || k)}</span>`; }).join("");
  $("#np-score").textContent = it.score ? scoreOf(it).toFixed(1) : "";
  const nx = upNext(); const b = $("#np-next"); b.hidden = !nx;
  if (nx) b.innerHTML = `<b>${esc(nx.artist)}</b><span>${esc(nx.display_title || nx.title)}</span>`;
}
/** After a re-render (a rating, a filter) the rank and the up-next line follow the new order. */
export function refreshNow() { const it = state.currentId ? current() : null; if (it && !$("#player").hidden) renderNow(it); }
export function stopPlayer() { clearAudition(); if (state.playerReady) state.player.stopVideo(); $("#player").hidden = true; state.currentId = null; setPlaybackState("none"); reflectPlaying(false); }

export const auditionOn = () => !!state.settings.audition;
export function clearAudition(hide = true) {
  clearTimeout(state.auditionTimer); clearInterval(state.auditionTick); state.auditionTimer = state.auditionTick = null;
  if (hide) { const bar = $("#audition-bar"); bar.hidden = true; $("i", bar).style.width = "0"; }
}
export function startAudition() {
  if (!auditionOn() || !state.playerReady || !state.currentId) return;
  const vid = state.player.getVideoData && state.player.getVideoData().video_id;
  if (state.auditionArmed !== vid) {
    state.auditionArmed = vid;
    const dur = state.player.getDuration() || 0;
    const startAt = dur ? Math.min(dur - 10, dur * (Number(state.settings.auditionStart) || 0) / 100) : 0;
    if (startAt > 3) state.player.seekTo(startAt, true);
  }
  clearAudition(false);
  const secs = Math.max(10, Number(state.settings.auditionSeconds) || 30);
  const bar = $("#audition-bar"); bar.hidden = false; const fill = $("i", bar); const t0 = Date.now();
  state.auditionTick = setInterval(() => { fill.style.width = Math.min(100, (Date.now() - t0) / (secs * 10)) + "%"; }, 250);
  state.auditionTimer = setTimeout(() => { clearAudition(); if (auditionOn() && state.currentId) nextTrack(); }, secs * 1000);
}
export function holdAudition() { if (state.auditionTimer) { clearAudition(); toast("Audition timer cancelled for this track"); } }
/** @param {number} delta */
export function step(delta) {
  if (deckOn()) { const vis = visibleItems(); state.deckIndex = Math.max(0, Math.min(vis.length - 1, state.deckIndex + delta)); renderDeck(vis); const it = deckItem(); if (it?.youtube?.videoId && state.currentId) play(it.id); return; }
  const i = state.currentId ? state.order.indexOf(state.currentId) : -1;
  const id = playableFrom(i < 0 ? -delta : i, delta); if (id) { play(id); focusCard(id); }
}
export const nextTrack = () => step(1);
export const prevTrack = () => step(-1);
export function toggle() { if (!state.playerReady) return; const s = state.player.getPlayerState(); if (s === YT.PlayerState.PLAYING) state.player.pauseVideo(); else state.player.playVideo(); }
