// @ts-check
/* The YouTube embed, autoplay through the list (in order or shuffled), the queue, audition mode (start partway in,
 * move on after N seconds) and background play (the screen off or another app in front does not stop the music).
 * `state.playingId` is the track in the player; `state.currentId` is the card the keyboard is on — they part when
 * you browse while listening, and the player's own thumbs always judge what plays. */
import { state, byId, badVideo, markBadVideo, persist } from "./state.js";
import { $, $$, esc, sameName, toast } from "./dom.js";
import { visibleItems } from "./feed.js";
import { renderDeck, deckOn, deckItem, focusCard } from "./render.js";
import { matchLabel } from "./years.js";
import { scoreOf } from "./rank.js";
import { openLayer, closeLayer } from "./url.js";

export const autoplayOn = () => state.settings.autoplay !== false;
/* Shuffle is parked: the button stays out of the UI and the saved setting is ignored until this flips back on.
 * Everything else (the permutation, the toggle, the key) is wired and waiting. */
export const SHUFFLE_ENABLED = false;
export const shuffleOn = () => SHUFFLE_ENABLED && !!state.settings.shuffle;
/** Something is in the player (playing or paused). */
export const playerActive = () => !$("#player").hidden && !!state.playingId;

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
        if (e.data === YT.PlayerState.ENDED && autoplayOn()) { clearAudition(); nextTrack(); }
        if (e.data === YT.PlayerState.PLAYING) { userPaused = false; hidePaused = false; startAudition(); setPlaybackState("playing"); reflectPlaying(true); startPosition(); }
        if (e.data === YT.PlayerState.PAUSED) {
          // a pause that arrives with the page hidden, and none asked for here, is the browser's: ask for the track back
          if (document.visibilityState === "hidden" && !userPaused) { hidePaused = true; resumeInBackground(); } else userPaused = true;
          clearAudition(false); setPlaybackState("paused"); reflectPlaying(false); stopPosition();
        }
        if (e.data === YT.PlayerState.ENDED) { setPlaybackState("none"); reflectPlaying(false); stopPosition(); }
      },
      onError: (/** @type {any} */ e) => {
        const it = current(); const vid = it?.youtube?.videoId; const url = vid ? "https://music.youtube.com/watch?v=" + vid : null;
        // 100 = removed or private, 101/150 = the owner disallows embedding: remember it so autoplay steps over it next time
        if (vid && [100, 101, 150].includes(Number(e && e.data))) { markBadVideo(vid); $$(`.card[data-id="${CSS.escape(it.id)}"], .dcard[data-id="${CSS.escape(it.id)}"]`).forEach(c => c.classList.add("noembed")); }
        toast("Can't embed this one", true, url ? { label: "Open in YT Music", fn: () => window.open(url, "_blank", "noopener") } : undefined);
        if (autoplayOn()) nextTrack();   // keep the queue moving; a popup here would be blocked anyway
      },
    },
  });
};
const current = () => (state.playingId && byId(state.playingId)) || visibleItems().find(i => i.id === state.playingId);

/* Media Session: the lock screen, notification shade, headphone buttons and keyboard media keys drive the queue.
 * The top frame's session takes precedence over the YouTube iframe's, so the artwork and title shown are ours. */
const ms = () => ("mediaSession" in navigator ? navigator.mediaSession : null);
let msWired = false;
/** @type {any} */
let posTimer = null;
function wireMediaSession() {
  const s = ms(); if (!s || msWired) return; msWired = true;
  /** @param {MediaSessionAction} a @param {(d?: any) => void} fn */
  const on = (a, fn) => { try { s.setActionHandler(a, fn); } catch { /* not every browser knows every action */ } };
  on("play", () => { userPaused = false; if (state.playerReady) state.player.playVideo(); });
  on("pause", () => { userPaused = true; if (state.playerReady) state.player.pauseVideo(); });
  on("stop", stopPlayer);
  on("nexttrack", nextTrack);
  on("previoustrack", prevTrack);
  on("seekbackward", d => seek(-((d && d.seekOffset) || 10)));
  on("seekforward", d => seek((d && d.seekOffset) || 10));
  on("seekto", d => { if (state.playerReady && d && Number.isFinite(d.seekTime)) { state.player.seekTo(d.seekTime, true); updatePosition(); } });
}
/** The lock screen's scrubber: where the track is and how long it runs, refreshed every few seconds while playing. */
function updatePosition() {
  const s = ms(); if (!s || !state.playerReady || typeof s.setPositionState !== "function") return;
  const duration = Number(state.player.getDuration && state.player.getDuration()) || 0; const position = Number(state.player.getCurrentTime && state.player.getCurrentTime()) || 0;
  if (!duration) return;
  try { s.setPositionState({ duration, playbackRate: 1, position: Math.min(Math.max(0, position), duration) }); } catch { /* ignore */ }
}
function startPosition() { stopPosition(); updatePosition(); posTimer = setInterval(updatePosition, 5000); }
function stopPosition() { clearInterval(posTimer); posTimer = null; updatePosition(); }
/** @param {import("./types").FeedItem} it */
function announce(it) {
  const s = ms(); if (!s) return;
  const art = it.artwork || (it.youtube && it.youtube.thumbnail);
  try { s.metadata = new MediaMetadata({ title: it.display_title || it.title, artist: it.artist, album: it.release || "", artwork: art ? [{ src: art }] : [] }); } catch { /* ignore */ }
}
/** @param {"none" | "paused" | "playing"} st */
function setPlaybackState(st) { const s = ms(); if (s) { try { s.playbackState = st; } catch { /* ignore */ } } }
/* Background play. Phones pause the embed the moment the screen goes off or another app comes in front — the
 * browser's doing, not the listener's (Chrome on Android and Safari on iOS both pause a video the page can no longer
 * show, while both carry the audio on once it is playing again). So while ⚙ → "keep playing in the background" is
 * on, a pause that arrives with the page hidden, and none asked for here, is answered with play again — at once,
 * then a few more times with widening gaps, in case the browser pauses it back. The tries run out per stretch out of
 * sight rather than per pause, so a browser that insists is never fought forever. Where it does insist (an iPhone
 * asleep freezes the page before the answer goes out), the lock screen's play button brings the track back, and so
 * does coming back to the app within a few minutes. A pause the listener asked for — a button, a key, the lock
 * screen, a tap on the embed — is left alone. */
export const backgroundOn = () => state.settings.background !== false;
const RESUME_GAPS_MS = [0, 400, 1200, 3000];   // one stretch out of sight: now, then three more tries
const RETURN_RESUME_MS = 5 * 60e3;             // back within this long after a pause it did not ask for: carry on
let userPaused = false;   // the last pause was the listener's own, not the browser's
let hidePaused = false;   // the browser paused the player while the page was hidden, and it has not played since
let hiddenAt = 0; let resumeTries = 0;
/** @type {any} */
let resumeTimer = null;
function resumeInBackground() {
  if (!backgroundOn() || !state.playerReady || !state.playingId || userPaused || resumeTries >= RESUME_GAPS_MS.length) return;
  const gap = RESUME_GAPS_MS[resumeTries++];
  clearTimeout(resumeTimer);
  const go = () => { resumeTimer = null; if (!userPaused && state.playerReady && state.playingId && state.player.getPlayerState() !== YT.PlayerState.PLAYING) state.player.playVideo(); };
  if (gap) resumeTimer = setTimeout(go, gap); else go();
}
/** Hooks the page's coming and going: a fresh set of tries each time, and the track back on a prompt return. */
export function wireBackgroundPlay() {
  document.addEventListener("visibilitychange", () => {
    clearTimeout(resumeTimer); resumeTimer = null; resumeTries = 0;
    if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
    if (hidePaused && !userPaused && backgroundOn() && state.playerReady && state.playingId && Date.now() - hiddenAt < RETURN_RESUME_MS) { hidePaused = false; state.player.playVideo(); }
  });
}
function ensureApi() { if (window.YT && window.YT.Player) return; if ($("#yt-api")) return; const s = document.createElement("script"); s.id = "yt-api"; s.src = "https://www.youtube.com/iframe_api"; document.head.appendChild(s); }
/** @param {string | null | undefined} id */
export function play(id) {
  if (!id) return;
  const it = byId(id) || visibleItems().find(i => i.id === id); const vid = it?.youtube?.videoId; if (!it || !vid) return;
  state.currentId = id; state.playingId = id;
  $$(".card.current, .dcard.current").forEach(c => c.classList.remove("current"));
  const el = $(`.card[data-id="${CSS.escape(id)}"], .dcard[data-id="${CSS.escape(id)}"]`); if (el) el.classList.add("current");
  reflectPlaying(true);
  const was = $("#player").hidden;
  $("#player").hidden = false;
  if (was) openLayer("player", stopPlayer);
  renderNow(it);
  ensureApi(); wireMediaSession(); announce(it);
  clearAudition(); state.auditionArmed = null;
  userPaused = false; hidePaused = false; resumeTries = 0; clearTimeout(resumeTimer); resumeTimer = null;
  if (state.playerReady) state.player.loadVideoById(vid); else state.pendingVideo = vid;
}
/** ±seconds through the track (the arrow keys, the lock screen). @param {number} delta */
export function seek(delta) {
  if (!state.playerReady || !playerActive()) return;
  const dur = Number(state.player.getDuration && state.player.getDuration()) || 0;
  const to = Math.max(0, (Number(state.player.getCurrentTime()) || 0) + delta);
  state.player.seekTo(dur ? Math.min(to, dur - 1) : to, true); updatePosition(); holdAudition();
}
/** The play/pause buttons show the pause icon while something plays (an SVG pair switched by class). @param {boolean} on */
export function reflectPlaying(on) { $$("#deck-play, #p-toggle").forEach(b => b.classList.toggle("playing", on)); }
/** @param {string} id */
const lookup = id => byId(id) || visibleItems().find(x => x.id === id);

/* Shuffle: a fixed random permutation of the list on screen, remade when the list itself changes, so "next" and
 * "previous" stay consistent within one listen and every track comes round once. */
/** The sequence "next" walks: the list order, or its shuffled twin. */
function sequence() {
  if (!shuffleOn()) return state.order;
  const key = state.order.join("");
  if (state.shuffleFor !== key) {
    const arr = state.order.slice();
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    // the track playing (or the card you are on) leads, so the first "next" is a real jump and never a repeat
    const lead = state.playingId || state.currentId; if (lead && arr.includes(lead)) { arr.splice(arr.indexOf(lead), 1); arr.unshift(lead); }
    state.shuffleOrder = arr; state.shuffleFor = key;
  }
  return state.shuffleOrder;
}
export function toggleShuffle() {
  if (!SHUFFLE_ENABLED) return;
  state.settings.shuffle = !shuffleOn(); state.shuffleFor = ""; persist(); reflectShuffle();
  toast(shuffleOn() ? "Shuffle on — next plays a random track from the list" : "Shuffle off — next plays down the list");
  refreshNow();
}
export function reflectShuffle() { $$("#p-shuffle").forEach(b => { b.hidden = !SHUFFLE_ENABLED; b.classList.toggle("on", shuffleOn()); b.setAttribute("aria-pressed", String(shuffleOn())); b.title = shuffleOn() ? "shuffle on (s)" : "shuffle off (s)"; }); }
/** The next playable id in sequence from index `i` in the given direction, or null at the end. @param {number} i @param {number} delta */
function playableFrom(i, delta) {
  const seq = sequence();
  for (let j = i + delta; j >= 0 && j < seq.length; j += delta) { const id = seq[j]; const vid = lookup(id)?.youtube?.videoId; if (vid && !badVideo(vid)) return id; }
  return null;
}
/** What "next" would play: the following card in the deck, or the next playable row of the sequence. */
function upNext() {
  if (!state.playingId) return null;
  if (deckOn() && !shuffleOn()) return visibleItems()[state.deckIndex + 1] || null;
  const id = playableFrom(sequence().indexOf(state.playingId), 1); return id ? lookup(id) || null : null;
}
/** The bar's now-playing panel: the card's own facts (rank, match, release, tags, sources, score) and the one track that comes next.
 * @param {import("./types").FeedItem} it */
function renderNow(it) {
  const n = state.order.indexOf(it.id);
  $("#np-eyebrow").innerHTML = "now playing" + (n >= 0 ? ` <span class="muted">· No. ${String(n + 1).padStart(2, "0")} / ${state.order.length}${shuffleOn() ? " · shuffle" : ""}</span>` : "");
  const ml = it.match_kind ? matchLabel(it) : "";
  const rel = it.release && !sameName(it.release, it.title) ? ` <span class="muted">· ${esc(it.release)}</span>` : "";
  $("#now").innerHTML = `<b class="np-artist">${esc(it.artist)}${ml ? ` <span class="match ${esc(it.match_kind || "")}">${esc(ml)}</span>` : ""}</b><span class="np-sep"> - </span><span class="np-title">${esc(it.display_title || it.title)}${rel}</span>`;
  $("#np-spec").textContent = [it.release_type, it.release_date, (it.tags || []).slice(0, 4).join(", ")].filter(Boolean).join(" · ");
  $("#np-sources").innerHTML = (it.sources || []).map(s => { const [k, name] = s.split(":"); return `<span class="src ${esc(k)}" title="${esc(s)}">${esc(name || k)}</span>`; }).join("");
  $("#np-score").textContent = it.score ? scoreOf(it).toFixed(1) : "";
  const nx = upNext(); const b = $("#np-next"); b.hidden = !nx;
  if (nx) b.innerHTML = `<b>${esc(nx.artist)}</b><span>${esc(nx.display_title || nx.title)}</span>`;
  reflectShuffle();
}
/** After a re-render (a rating, a filter) the rank and the up-next line follow the new order. */
export function refreshNow() { const it = state.playingId ? current() : null; if (it && !$("#player").hidden) renderNow(it); }
/** Close the player. The card you were on stays current, so j/k carry on from there. */
export function stopPlayer() {
  clearAudition(); stopPosition(); userPaused = true; hidePaused = false; clearTimeout(resumeTimer); resumeTimer = null; if (state.playerReady) state.player.stopVideo();
  const was = !$("#player").hidden;
  $("#player").hidden = true; state.playingId = null; setPlaybackState("none"); reflectPlaying(false);
  if (was) closeLayer("player");
}

export const auditionOn = () => !!state.settings.audition;
export function clearAudition(hide = true) {
  clearTimeout(state.auditionTimer); clearInterval(state.auditionTick); state.auditionTimer = state.auditionTick = null;
  if (hide) { const bar = $("#audition-bar"); bar.hidden = true; $("i", bar).style.width = "0"; }
}
export function startAudition() {
  if (!auditionOn() || !state.playerReady || !state.playingId) return;
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
  state.auditionTimer = setTimeout(() => { clearAudition(); if (auditionOn() && state.playingId) nextTrack(); }, secs * 1000);
}
export function holdAudition() { if (state.auditionTimer) { clearAudition(); toast("Audition timer cancelled for this track"); } }
/** @param {number} delta */
export function step(delta) {
  if (deckOn() && !shuffleOn()) { const vis = visibleItems(); state.deckIndex = Math.max(0, Math.min(vis.length - 1, state.deckIndex + delta)); renderDeck(vis); const it = deckItem(); if (it?.youtube?.videoId && playerActive()) play(it.id); return; }
  const seq = sequence(); const from = state.playingId || state.currentId;
  const i = from ? seq.indexOf(from) : -1;
  const id = playableFrom(i < 0 ? -delta : i, delta); if (!id) return;
  if (playerActive() || !state.currentId) play(id); else state.currentId = id;   // browsing with the player closed: j/k just move
  if (deckOn()) { const vis = visibleItems(); const at = vis.findIndex(x => x.id === id); if (at >= 0) { state.deckIndex = at; renderDeck(vis); } } else focusCard(id);
}
export const nextTrack = () => step(1);
export const prevTrack = () => step(-1);
export function toggle() { if (!state.playerReady) return; const s = state.player.getPlayerState(); if (s === YT.PlayerState.PLAYING) { userPaused = true; state.player.pauseVideo(); } else { userPaused = false; state.player.playVideo(); } }
