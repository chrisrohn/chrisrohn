/* Chris Rohn's New Music — client.
 * Reads data/feed.json (built daily by GitHub Actions). Anyone can listen.
 * Sign in with Google (one of the configured curator accounts) to get curator mode:
 *   👍 → added straight to "<year> Indie Discotheque" in YOUR YouTube library (YouTube Data API v3, from this browser)
 *   👎 → added to the unlisted "Skipped" playlist so it never comes back
 * Nothing is written anywhere until you press a thumb. Undo is available for a few seconds after each one.
 */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const YT_API = "https://www.googleapis.com/youtube/v3";
  const SCOPES = "openid email https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/drive.appdata";
  const DRIVE = "https://www.googleapis.com/drive/v3";
  const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  const SYNC_FILE = "newmusic-rated.json";

  const state = {
    feed: null,
    rated: LS.get("id:rated", {}),          // {id: {decision, year, videoId, artist, title, playlistItemId, at}} — local mirror of what this browser filed
    auth: LS.get("id:auth", null),          // {access_token, expires_at, email, name, picture}
    playlists: LS.get("id:playlists", {}),  // {"2026": "PL...", "__skipped": "PL..."} learned from your library
    settings: Object.assign({ audition: false, auditionSeconds: 30, auditionStart: 25, deck: null }, LS.get("id:settings", {})),   // deck: null = auto (phones)
    deckIndex: 0,    // {skipsInYouTube, audition, auditionSeconds, auditionStart}
    auditionTimer: null, auditionTick: null, auditionArmed: null,
    quota: LS.get("id:quota", { day: "", units: 0 }),  // rough count of YouTube API units spent today (resets midnight Pacific)
    filters: Object.assign({ q: "", sourcesOff: [], blogsOff: [], sort: "score", onlyNew: false, onlyPlayable: true, onlyKnown: false, onlyRecent: false }, LS.get("id:filters", {})),
    view: "feed",
    order: [],
    currentId: null,
    player: null, playerReady: false, pendingVideo: null,
    tokenClient: null,
    busy: new Set(),
    sync: LS.get("id:sync", { fileId: null, at: 0 }),   // Drive appDataFolder file that mirrors `rated` across devices
    syncTimer: null,
  };

  // ---------- data ----------
  async function load() {
    const bust = "?t=" + Math.floor(Date.now() / 60000);
    const feed = await fetch("data/feed.json" + bust).then(r => r.ok ? r.json() : Promise.reject(new Error("feed.json " + r.status)));
    state.feed = feed;
    // anything the daily build already saw in your playlists no longer needs local bookkeeping
    const ids = new Set(feed.items.map(i => i.id));
    for (const id of Object.keys(state.rated)) if (!ids.has(id) && Date.now() - (state.rated[id].at || 0) > 45 * 86400e3) delete state.rated[id];
    if (isOwner()) {
      for (const [y, pid] of Object.entries((feed.youtube && feed.youtube.playlists) || {})) state.playlists[y] = state.playlists[y] || pid;
      if (feed.youtube && feed.youtube.skipped_playlist_id) state.playlists.__skipped = state.playlists.__skipped || feed.youtube.skipped_playlist_id;
    }
    persist();
    fillYears();
    fillSources();
    renderMeta();
    applyMode();
    render();
    if (isCurator() && tokenValid()) { pullRatings(); refreshRecent().catch(() => {}); }
    if (isSignedIn()) ensureTokenClient().catch(() => {});
    document.addEventListener("pointerdown", keepAlive, { capture: true, passive: true });
    document.addEventListener("keydown", keepAlive, { capture: true, passive: true });
  }
  // another device may have rated things while this tab was in the background (only while the token is valid:
  // a background refresh would need a popup, which browsers block without a tap — the next 👍 refreshes it instead)
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && isCurator() && tokenValid() && Date.now() - (state.sync.at || 0) > 60e3) pullRatings(); });
  function persist() {
    LS.set("id:rated", state.rated);
    LS.set("id:auth", state.auth);
    LS.set("id:playlists", state.playlists);
    LS.set("id:filters", state.filters);
    LS.set("id:settings", state.settings);
    LS.set("id:quota", state.quota);
    LS.set("id:sync", state.sync);
  }

  // ---------- cross-device memory: ratings mirrored to a hidden per-app file in the signed-in account's Google Drive ----------
  async function drive(method, url, { params = {}, body, raw } = {}) {
    return withAuth(async token => {
      const u = new URL(url); for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
      const headers = { Authorization: "Bearer " + token }; if (body && !raw) headers["Content-Type"] = "application/json";
      const r = await fetch(u, { method, headers, body: raw ? body : (body ? JSON.stringify(body) : undefined) });
      if (!r.ok) {
        const j = await r.json().catch(() => ({})); const msg = (j.error && j.error.message) || r.statusText;
        if (r.status === 401) { state.auth.expires_at = 0; persist(); throw new Error("Google session expired — it will refresh on your next tap"); }
        if (r.status === 403 && /Drive API has not been used|not enabled|accessNotConfigured/i.test(msg)) throw new Error("Google Drive API is not enabled for this project — enable it once in the Google Cloud console (see SETUP.md) so ratings can sync across devices");
        if (r.status === 403 && /insufficient/i.test(msg)) throw new Error("Sign out and sign in again to grant the new 'app data' permission that syncs ratings across devices");
        throw new Error(msg);
      }
      return r;
    });
  }
  async function syncFileId() {
    if (state.sync.fileId) return state.sync.fileId;
    const r = await drive("GET", `${DRIVE}/files`, { params: { spaces: "appDataFolder", q: `name='${SYNC_FILE}'`, fields: "files(id,modifiedTime)", pageSize: 5 } });
    const j = await r.json(); const f = (j.files || [])[0];
    if (f) { state.sync.fileId = f.id; persist(); return f.id; }
    return null;
  }
  function mergeRated(remote) {
    let changed = false;
    for (const [id, r] of Object.entries(remote || {})) {
      const l = state.rated[id];
      if (!l || (r.at || 0) > (l.at || 0)) { state.rated[id] = { ...r, pending: false }; changed = true; }
    }
    return changed;
  }
  async function pullRatings() {
    if (!isCurator() || !tokenValid()) return;
    try {
      const id = await syncFileId(); if (!id) return;
      const r = await drive("GET", `${DRIVE}/files/${id}`, { params: { alt: "media" } });
      const data = await r.json().catch(() => null);
      if (data && data.rated && mergeRated(data.rated)) { persist(); render(); }
      state.sync.at = Date.now(); persist();
    } catch (e) { toast("Rating sync (pull) failed: " + e.message, true); }
  }
  function schedulePush() { clearTimeout(state.syncTimer); state.syncTimer = setTimeout(() => pushRatings().catch(() => {}), 1500); }
  async function pushRatings() {
    if (!isCurator()) return;
    // prune anything older than 90 days so the file stays small; the daily build hides old saves via the playlists anyway
    const cutoff = Date.now() - 90 * 86400e3;
    for (const [id, r] of Object.entries(state.rated)) if ((r.at || 0) < cutoff) delete state.rated[id];
    const payload = JSON.stringify({ version: 1, account: state.auth.email, updatedAt: new Date().toISOString(), rated: state.rated });
    try {
      let id = await syncFileId();
      if (id) {
        await drive("PATCH", `${DRIVE_UPLOAD}/files/${id}`, { params: { uploadType: "media" }, body: payload, raw: true });
      } else {
        const boundary = "nm" + Date.now();
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: SYNC_FILE, parents: ["appDataFolder"] })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n--${boundary}--`;
        const r = await withAuth(token => fetch(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": `multipart/related; boundary=${boundary}` }, body }));
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || r.statusText);
        id = (await r.json()).id; state.sync.fileId = id;
      }
      state.sync.at = Date.now(); persist();
    } catch (e) { toast("Rating sync (push) failed: " + e.message, true); }
  }
  const skipsInYouTube = () => state.settings.skipsInYouTube != null ? !!state.settings.skipsInYouTube : !!(state.feed && state.feed.youtube && state.feed.youtube.skips_in_youtube);
  // YouTube quota: 10,000 units/day, reset at midnight Pacific. Reads cost 1, writes cost 50.
  const ptDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  function spend(units) { if (state.quota.day !== ptDay()) state.quota = { day: ptDay(), units: 0 }; state.quota.units += units; persist(); }
  const quotaText = () => { const u = state.quota.day === ptDay() ? state.quota.units : 0; return `~${u.toLocaleString()} of 10,000 YouTube API units used today (${Math.floor((10000 - u) / 50)} more saves) · resets midnight Pacific`; };
  const items = () => (state.feed && state.feed.items) || [];
  const byId = id => items().find(i => i.id === id);
  const decisionFor = id => state.rated[id] || null;
  // best guess at the year; null when nothing anywhere says when this came out (the card then asks you to pick)
  const yearGuess = it => {
    if (Number.isFinite(it.year)) return it.year;
    const d = it.release_date || (it.youtube && it.youtube.year);
    const y = d ? parseInt(String(d).slice(0, 4), 10) : NaN;
    return Number.isFinite(y) ? y : null;
  };
  const yearOf = it => yearGuess(it) ?? new Date().getFullYear();
  function fillYearSelect(ysel, it) {
    const g = yearGuess(it);
    ysel.innerHTML = (g == null ? `<option value="">year?</option>` : "") + state._years.map(y => `<option value="${y}">${y}</option>`).join("");
    ysel.value = g == null ? "" : String(g); ysel.classList.toggle("unknown", g == null);
  }
  const YEAR_SOURCE = { musicbrainz: "verified: MusicBrainz's earliest release of this exact recording (identified via ListenBrainz)", "musicbrainz-search": "verified: earliest MusicBrainz release matching artist + title", "musicbrainz-isrc": "verified: earliest MusicBrainz release sharing this track's ISRC", discogs: "verified: Discogs master (original issue) year", deezer: "earliest release on Deezer", itunes: "earliest release on Apple Music", "release-date": "the release date the source itself stated", isrc: "from the ISRC registration year only", youtube: "from the YouTube album only", "feed-date": "from the blog post date only — check it", unknown: "no release date found anywhere — pick the year yourself" };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const sameName = (a, b) => String(a || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "") === String(b || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

  // ---------- auth (Google Identity Services, token flow) ----------
  const tokenValid = () => !!(state.auth && state.auth.access_token && state.auth.expires_at > Date.now() + 30e3);
  const curators = () => ((state.feed && state.feed.google && state.feed.google.curators) || []).map(e => e.toLowerCase());
  // identity = a remembered Google account. Access tokens only live an hour; they are re-requested silently when needed.
  const isSignedIn = () => !!(state.auth && state.auth.email);
  const isOwner = () => isSignedIn() && curators().includes(state.auth.email.toLowerCase());
  const guestsAllowed = () => !!(state.feed && state.feed.google && state.feed.google.guests);
  // "curator" = anyone allowed to rate: the owner, or a guest when guests are enabled. Guests file into their own library.
  const isCurator = () => isOwner() || (isSignedIn() && guestsAllowed());
  const role = () => isOwner() ? "curator" : (isCurator() ? "guest" : "listener");
  function applyMode() {
    const on = isCurator();
    document.body.classList.toggle("curator", on);
    document.body.classList.toggle("guest", on && !isOwner());
    noticeDupes();
    const badge = $(".mode"); if (badge) { badge.textContent = role(); badge.title = isOwner() ? "Curator: thumbs file into the Indie Discotheque year playlists" : `Guest: thumbs file into your own “${titleFor("<year>")}” playlists`; }
    const who = $("#who");
    if (state.auth && state.auth.email) {
      who.hidden = false;
      who.innerHTML = `${state.auth.picture ? `<img src="${esc(state.auth.picture)}" alt="">` : ""}<span>${esc(state.auth.name || state.auth.email)}</span>` +
        (on ? "" : ` <span class="muted">(listener)</span>`);
      $("#signin").textContent = "Sign out";
    } else {
      who.hidden = true;
      $("#signin").textContent = "Sign in with Google";
    }
    const cid = state.feed && state.feed.google && state.feed.google.client_id;
    $("#signin").disabled = !cid;
    $("#signin").title = cid ? "" : "Google client ID not configured yet (see SETUP.md)";
  }
  function ensureGis() {
    return new Promise((resolve, reject) => {
      if (window.google && google.accounts && google.accounts.oauth2) return resolve();
      const s = document.createElement("script"); s.src = "https://accounts.google.com/gsi/client"; s.async = true; s.defer = true;
      s.onload = resolve; s.onerror = () => reject(new Error("could not load Google sign-in")); document.head.appendChild(s);
    });
  }
  // One token client for the page, created as soon as we know the client id (and preloaded for a remembered account),
  // so the only thing left in a tap handler is requestAccessToken — browsers block the Google popup if it opens late.
  async function ensureTokenClient() {
    const cid = state.feed.google && state.feed.google.client_id;
    if (!cid) return null;
    if (state.tokenClient) return state.tokenClient;
    await ensureGis();
    if (state.tokenClient) return state.tokenClient;
    state.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: cid, scope: SCOPES,
      callback: resp => state.authCb && state.authCb(resp),
      error_callback: err => state.authErrCb && state.authErrCb(err),
    });
    return state.tokenClient;
  }
  async function signIn({ silent = false } = {}) {
    const cid = state.feed.google && state.feed.google.client_id;
    if (!cid) { toast("Google client ID not configured yet — see SETUP.md", true); return false; }
    const client = await ensureTokenClient();
    if (state.signingIn) return state.signingIn;          // one popup at a time
    state.signingIn = new Promise(resolve => {
      const done = v => { state.signingIn = null; state.authCb = state.authErrCb = null; resolve(v); };
      const fail = why => {
        state.lastAuthError = { why, at: Date.now() }; console.warn("Google sign-in did not complete:", why);
        if (!silent) toast(/popup_closed/.test(why) ? "Sign-in cancelled" : "Sign-in failed: " + why, true);
        done(false);
      };
      state.authErrCb = err => fail((err && (err.type || err.message)) || "unknown");
      state.authCb = async resp => {
        if (resp.error) return fail(resp.error + (resp.error_description ? " — " + resp.error_description : ""));
        const prev = state.auth || {}; const prevEmail = prev.email;
        state.auth = { ...prev, access_token: resp.access_token, expires_at: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
        state.lastAuthError = null;
        try {
          const me = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + resp.access_token } }).then(r => r.json());
          if (me && me.email) Object.assign(state.auth, { email: me.email, name: me.name, picture: me.picture });
        } catch {}
        if (prevEmail && prevEmail !== state.auth.email) { state.playlists = {}; state.rated = {}; }
        persist(); applyMode(); render();
        if (silent) { if (isCurator() && Date.now() - (state.sync.at || 0) > 60e3) pullRatings(); return done(true); }
        if (isOwner()) { toast(`Curator mode on — ${state.auth.email}`); refreshRecent().catch(() => {}); pullRatings(); }   // year playlists are pinned: no library listing needed
        else if (isCurator()) { toast(`Signed in as a guest. 👍 files into “${titleFor("<year>")}” in your own YouTube library.`); refreshRecent().catch(() => {}); pullRatings(); }
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
  function needSignIn(msg = "Google sign-in needs a refresh") {
    toast(msg + (state.lastAuthError ? ` (${state.lastAuthError.why})` : ""), true, { label: "Sign in", fn: () => signIn().catch(e => toast(e.message, true)) });
  }
  // Keep the hour-long token alive while you're actively using the site: any tap or key press with less than five
  // minutes left refreshes it (at most once a minute), so rating never runs into an expired token.
  function keepAlive() {
    if (!isSignedIn() || state.signingIn || !(state.feed.google && state.feed.google.client_id)) return;
    if (state.auth.access_token && state.auth.expires_at > Date.now() + 5 * 60e3) return;
    if (Date.now() - (state.keepAliveAt || 0) < 60e3) return;
    state.keepAliveAt = Date.now();
    signIn({ silent: true }).then(ok => { if (!ok) needSignIn(); });
  }
  // Sign-out only forgets this device. It deliberately does NOT revoke the Google grant: revoking kills the tokens on
  // your other devices too (and can even race a fresh sign-in on this one). Disconnecting the site for good is a
  // Google-account action: https://myaccount.google.com/permissions
  function signOut() {
    state.auth = null; state.playlists = {}; persist(); applyMode(); render(); toast("Signed out on this device");
  }
  // A valid token for the next few minutes, refreshing silently when it is about to lapse. Call it first thing in a
  // click handler so the (auto-closing) Google popup is still allowed by the browser.
  async function ensureToken({ minutes = 3 } = {}) {
    if (state.auth && state.auth.access_token && state.auth.expires_at > Date.now() + minutes * 60e3) return true;
    if (!isSignedIn()) return false;
    return signIn({ silent: true });
  }
  async function withAuth(fn) {
    if (!(await ensureToken({ minutes: 1 }))) { const ok = isSignedIn() ? false : await signIn(); if (!ok || !tokenValid()) throw new Error("Google sign-in needs a refresh"); }
    return fn(state.auth.access_token);
  }

  // ---------- YouTube Data API ----------
  async function yt(method, path, { params = {}, body, _retried = false } = {}) {
    return withAuth(async token => {
      const url = new URL(YT_API + path); for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
      const r = await fetch(url, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      spend(method === "GET" ? 1 : 50);
      if (r.status === 204) return {};
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = (j.error && j.error.message) || r.statusText;
        if (r.status === 401) {
          // token revoked or expired early: get a fresh one silently and retry once
          state.auth.expires_at = 0; persist();
          if (!_retried && await signIn({ silent: true })) return yt(method, path, { params, body, _retried: true });
          applyMode(); throw new Error("Google sign-in needs a refresh — tap the Sign in button in the message");
        }
        if (r.status === 403 && /quota/i.test(msg)) throw new Error(msg + " — daily YouTube API quota reached; try again after midnight Pacific");
        if (r.status === 403 && path.startsWith("/playlistItems") && method === "POST") throw new Error("YouTube refused to add to that playlist for this sign-in. Collaborative playlists can only be edited through the API by the channel that owns them (@indiedisco) — sign out and sign in again choosing that channel, or make the playlist owner account a curator.");
        throw new Error(msg);
      }
      return j;
    });
  }
  const pattern = () => isOwner()
    ? ((state.feed.youtube && state.feed.youtube.playlist_title_pattern) || "{year} Indie Discotheque")
    : ((state.feed.google && state.feed.google.guest_playlist_title_pattern) || "{year} Picks from chrisrohn.com");
  const titleFor = year => pattern().replace("{year}", year);
  const skippedTitle = () => (state.feed.youtube && state.feed.youtube.skipped_playlist_title) || "Skipped";
  const titleRegex = () => new RegExp("^" + pattern().split("{year}").map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(\\d{4})") + "$", "i");

  const normTitle = s => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  // "2024 Indie Discotheque", "Indie Discotheque 2024", "2024 - indie discotheque" all count
  function yearFromTitle(t) {
    const words = normTitle(pattern().replace("{year}", " ")).trim();
    const n = normTitle(t);
    if (!words || !n.includes(words)) return null;
    const m = /\b(19[5-9]\d|20\d\d)\b/.exec(n);
    return m ? m[1] : null;
  }
  async function loadLibraryPlaylists() {
    let pageToken; let n = 0; const all = [];
    do {
      const j = await yt("GET", "/playlists", { params: { part: "snippet,contentDetails", mine: "true", maxResults: 50, pageToken } });
      for (const p of j.items || []) {
        const t = (p.snippet.title || "").trim();
        all.push({ id: p.id, title: t, count: (p.contentDetails || {}).itemCount || 0, published: p.snippet.publishedAt, desc: p.snippet.description || "" });
        const y = yearFromTitle(t);
        if (y) { if (!state.playlists[y]) state.playlists[y] = p.id; }
        else if (normTitle(t) === normTitle(skippedTitle())) state.playlists.__skipped = p.id;
        n++;
      }
      pageToken = j.nextPageToken;
    } while (pageToken && n < 500);
    state.playlists.__loaded_at = Date.now();
    state.library = all;
    persist();
    checkOwnership();
    return all;
  }
  // The station playlists are collaborative: they belong to @indiedisco and are edited by collaborators. YouTube's
  // "mine=true" listing only shows playlists this channel OWNS, so not finding them there is expected — we file into
  // the ids the daily build discovered and let YouTube tell us if this sign-in may not edit them.
  function checkOwnership() {
    if (!isOwner() || !state.library) return;
    const known = Object.values((state.feed.youtube && state.feed.youtube.playlists) || {});
    if (!known.length) return;
    const mine = new Set(state.library.map(p => p.id));
    state.notOwner = known.every(id => !mine.has(id));
  }
  const knownYear = year => isOwner() ? (((state.feed.youtube && state.feed.youtube.playlists) || {})[String(year)] || null) : null;
  async function playlistFor(year) {
    year = String(year);
    // the daily build knows the station's year playlists by id (from the @indiedisco channel) — always use those
    const k = knownYear(year);
    if (k) { state.playlists[year] = k; persist(); return k; }
    if (isOwner()) {
      // Curators never create playlists: every Indie Discotheque year is pinned by id in discovery/config.yaml.
      toast(`No pinned playlist id for ${year}. Add it to youtube_music.playlists in config.yaml and run Discover.`, true);
      throw new Error("no pinned playlist for " + year);
    }
    if (!state.playlists[year] || !state.playlists.__loaded_at) await loadLibraryPlaylists();
    if (!state.playlists[year]) {
      const ok = confirm(`No playlist called “${titleFor(year)}” exists in this YouTube account (${state.auth.email}).\n\nCreate it now? (Cancel if it should already exist — then check the title spelling or the signed-in channel.)`);
      if (!ok) throw new Error("no playlist for " + year);
      const j = await yt("POST", "/playlists", { params: { part: "snippet,status" }, body: { snippet: { title: titleFor(year), description: "Filed from chrisrohn.com" }, status: { privacyStatus: "public" } } });
      state.playlists[year] = j.id; persist(); toast(`Created playlist “${titleFor(year)}”`);
    }
    return state.playlists[year];
  }
  async function skippedPlaylist() {
    if (!state.playlists.__skipped && !state.playlists.__loaded_at) await loadLibraryPlaylists();
    if (!state.playlists.__skipped) {
      const j = await yt("POST", "/playlists", { params: { part: "snippet,status" }, body: { snippet: { title: skippedTitle(), description: "Thumbs-down from chrisrohn.com. Keep unlisted; paste the ID into discovery/config.yaml → skipped_playlist_id." }, status: { privacyStatus: "unlisted" } } });
      state.playlists.__skipped = j.id; persist();
      toast(`Created unlisted “${skippedTitle()}” playlist. Paste its ID into config.yaml → skipped_playlist_id: ${j.id}`);
    }
    return state.playlists.__skipped;
  }
  async function addToPlaylist(playlistId, videoId) {
    const j = await yt("POST", "/playlistItems", { params: { part: "snippet" }, body: { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } } });
    return j.id;
  }
  async function removePlaylistItem(playlistItemId) { await yt("DELETE", "/playlistItems", { params: { id: playlistItemId } }); }
  // every playlist item holding this video (1 quota unit) — the duplicate guard and the cleanup tool both use it
  async function playlistItemsFor(playlistId, videoId) {
    const j = await yt("GET", "/playlistItems", { params: { part: "id", playlistId, videoId, maxResults: 50 } });
    return (j.items || []).map(i => i.id);
  }
  // ---------- duplicates ----------
  // The daily build scans every year playlist; feed.json carries the counts, data/duplicates.json the full report.
  const dupCount = () => (isOwner() && state.feed.youtube && state.feed.youtube.duplicates_count) || 0;
  function noticeDupes() {
    const stamp = (state.feed.youtube || {}).duplicates_checked_at || "";
    if (!dupCount() || state.settings.dupesNoticed === stamp) return;
    state.settings.dupesNoticed = stamp; persist();
    setTimeout(() => toast(`⚠ ${dupCount()} duplicated songs in the year playlists`, true, { label: "Review", fn: () => { $("#settings-btn").click(); $("#s-dupes-details").open = true; } }), 2500);
  }
  async function loadDupes() {
    if (state.dupes) return state.dupes;
    try { const r = await fetch("/data/duplicates.json", { cache: "no-store" }); state.dupes = r.ok ? (await r.json()).duplicates || [] : []; }
    catch { state.dupes = []; }
    return state.dupes;
  }
  const dupeDone = (key, vid) => (state.settings.dupesDone || []).includes(key + ":" + (vid || ""));
  function markDupeDone(key, vid) { state.settings.dupesDone = [...(state.settings.dupesDone || []), key + ":" + (vid || "")].slice(-3000); }
  const dupOpen = d => !d.entries.every(e => dupeDone(d.key, e.videoId));
  const KIND = { "same-video": "same video added twice", "cross-year": "same video in two years" };
  const wrongYear = (d, e) => d.verified_year && String(e.year) !== String(d.verified_year);
  function dupeFilters() {
    return { kind: $("#s-dupe-kind").value, year: $("#s-dupe-yr").value, q: $("#s-dupe-q").value.trim().toLowerCase() };
  }
  function filteredDupes() {
    const f = dupeFilters();
    return (state.dupes || []).filter(dupOpen).filter(d => (!f.kind || d.kind === f.kind) && (!f.year || d.years.includes(f.year)) && (!f.q || `${d.artist} ${d.title}`.toLowerCase().includes(f.q)));
  }
  async function renderDupes(reset = true) {
    const box = $("#s-dupes"); if (!box) return;
    const yt0 = state.feed.youtube || {};
    $("#s-dupes-summary").textContent = dupCount()
      ? `⚠ ${dupCount()} duplicated songs in the year playlists (checked ${yt0.duplicates_checked_at ? relTime(new Date(yt0.duplicates_checked_at)) : "?"})`
      : `Duplicate check: none found by the last build${yt0.duplicates_checked_at ? " (" + relTime(new Date(yt0.duplicates_checked_at)) + ")" : ""}`;
    const sel = $("#s-dupe-year");
    if (!sel.options.length) { const cur = new Date().getFullYear(); sel.innerHTML = (state._years || []).map(y => `<option value="${y}" ${y === cur ? "selected" : ""}>${y}</option>`).join(""); }
    if (!dupCount()) { box.innerHTML = ""; return; }
    box.innerHTML = `<span class="muted">loading report…</span>`;
    const all = await loadDupes();
    const ysel = $("#s-dupe-yr");
    if (ysel.options.length <= 1) { const yrs = [...new Set(all.flatMap(d => d.years))].sort().reverse(); ysel.innerHTML = `<option value="">all years</option>` + yrs.map(y => `<option value="${y}">${y}</option>`).join(""); }
    const kinds = yt0.duplicates_kinds || {};
    $("#s-dupe-kinds").textContent = Object.entries(kinds).map(([k, n]) => `${n} ${KIND[k] || k}`).join(" · ");
    if (reset) state.dupePage = 1;
    const list = filteredDupes(); const shown = list.slice(0, 60 * state.dupePage);
    const f = dupeFilters();
    const bulk = $("#s-dupe-bulk"); const bulkable = list.filter(d => d.kind === "same-video");
    bulk.hidden = !(f.kind === "same-video" && f.year && bulkable.length);
    bulk.textContent = `remove all ${bulkable.length} extra copies in ${f.year}…`;
    box.innerHTML = shown.map(d => `<div class="dupe" data-key="${esc(d.key)}">
        <div class="dupe-song"><b>${esc(d.artist)}</b> - ${esc(d.title)} <span class="muted">· ${KIND[d.kind] || d.kind} · ×${d.count}${d.verified_year ? ` · <span class="verified" title="${esc(d.verified_source || "")}">verified ${esc(d.verified_year)}</span>` : ""}</span></div>
        <div class="dupe-entries">${d.kind === "same-video"
          ? `<span class="chip">${esc(d.entries[0].year)} <a href="https://music.youtube.com/watch?v=${esc(d.entries[0].videoId)}&list=${esc(d.entries[0].playlistId)}" target="_blank" rel="noopener">▶</a></span><button class="btn ghost small" type="button" data-fix="extra" data-pid="${esc(d.entries[0].playlistId)}" data-vid="${esc(d.entries[0].videoId)}">remove the extra copy</button>`
          : d.entries.filter(e => !dupeDone(d.key, e.videoId)).map(e => `<span class="chip ${wrongYear(d, e) ? "wrong" : ""}" title="${wrongYear(d, e) ? "not the verified year" : ""}">${esc(e.year)} <a href="https://music.youtube.com/watch?v=${esc(e.videoId)}&list=${esc(e.playlistId)}" target="_blank" rel="noopener">▶</a> <button class="x" type="button" title="remove from ${esc(e.year)}" data-fix="one" data-pid="${esc(e.playlistId)}" data-vid="${esc(e.videoId)}" data-year="${esc(e.year)}">✕</button></span>`).join("")}</div>
      </div>`).join("") + (list.length > shown.length ? `<button class="btn ghost small" type="button" id="s-dupe-more">show ${Math.min(60, list.length - shown.length)} more of ${list.length - shown.length}</button>` : "") + (list.length ? "" : `<span class="muted">nothing matches these filters</span>`);
    $$("button[data-fix]", box).forEach(b => b.addEventListener("click", () => fixDupe(b)));
    const more = $("#s-dupe-more"); if (more) more.addEventListener("click", () => { state.dupePage++; renderDupes(false); });
  }
  const quotaLeft = () => 10000 - (state.quota.day === ptDay() ? state.quota.units : 0);
  async function fixDupe(btn) {
    const row = btn.closest(".dupe"); const key = row.dataset.key; const { pid, vid, fix, year } = btn.dataset;
    const d = (state.dupes || []).find(x => x.key === key) || {};
    const what = fix === "extra" ? `Remove the extra copy of “${d.artist} - ${d.title}” (keeps one)?` : `Remove “${d.artist} - ${d.title}” from ${year}? (50 quota units)`;
    if (!confirm(what)) return;
    btn.disabled = true;
    try {
      const n = await removeCopies(pid, vid, fix === "extra");
      if (fix === "extra") d.entries.forEach(e => markDupeDone(key, e.videoId)); else markDupeDone(key, vid);
      persist();
      toast(n ? `Removed ${n} · ${d.artist} - ${d.title}` : "Nothing to remove — already cleaned up");
      renderDupes(false);
    } catch (e) { btn.disabled = false; toast("Could not remove: " + e.message, true); }
  }
  // delete every playlist item holding this video (keepFirst: leave one copy in place); returns how many went
  async function removeCopies(playlistId, videoId, keepFirst) {
    const ids = await playlistItemsFor(playlistId, videoId);
    const victims = keepFirst ? ids.slice(1) : ids;
    for (const i of victims) await removePlaylistItem(i);
    return victims.length;
  }
  async function bulkRemoveExtras() {
    const f = dupeFilters(); const list = filteredDupes().filter(d => d.kind === "same-video" && d.years.includes(f.year));
    const cost = list.reduce((n, d) => n + 1 + 50 * (d.count - 1), 0);
    const afford = Math.max(0, Math.floor((quotaLeft() - 500) / 51));
    const todo = list.slice(0, Math.min(list.length, afford));
    if (!todo.length) { toast("Not enough YouTube quota left today for a bulk clean-up — try after midnight Pacific", true); return; }
    if (!confirm(`Remove the extra copies of ${todo.length} songs in ${titleFor(f.year)}${todo.length < list.length ? ` (${list.length - todo.length} more when quota allows)` : ""}?\nCost ≈ ${Math.min(cost, todo.length * 51)} of ${quotaLeft()} quota units left today. One copy of each song stays.`)) return;
    const bulk = $("#s-dupe-bulk"); bulk.disabled = true;
    let removed = 0, failed = 0;
    for (const [i, d] of todo.entries()) {
      bulk.textContent = `removing… ${i + 1}/${todo.length}`;
      try { removed += await removeCopies(d.entries[0].playlistId, d.entries[0].videoId, true); d.entries.forEach(e => markDupeDone(d.key, e.videoId)); }
      catch (e) { failed++; if (/quota/i.test(e.message)) break; }
      if (i % 10 === 9) persist();
    }
    persist(); bulk.disabled = false;
    toast(`Removed ${removed} extra copies${failed ? ` · ${failed} failed` : ""}`);
    renderDupes(false);
  }
  // Live scan of one year playlist (1 quota unit per 50 tracks): catches today's double-taps before the nightly build does.
  async function scanYear(year) {
    const pid = knownYear(year) || state.playlists[String(year)]; if (!pid) throw new Error("no playlist id for " + year);
    const status = $("#s-dupe-status"); status.textContent = "scanning…";
    const seen = new Map(); let pageToken, n = 0;
    do {
      const j = await yt("GET", "/playlistItems", { params: { part: "snippet", playlistId: pid, maxResults: 50, pageToken } });
      for (const it of j.items || []) {
        n++;
        const sn = it.snippet || {}; const v = sn.resourceId && sn.resourceId.videoId; if (!v) continue;
        const artist = (sn.videoOwnerChannelTitle || "").replace(/\s*-\s*Topic$/i, "");
        const g = seen.get(v) || []; g.push({ id: it.id, videoId: v, title: sn.title, artist }); seen.set(v, g);
      }
      pageToken = j.nextPageToken;
    } while (pageToken);
    const byVideo = [...seen.entries()].filter(([, g]) => g.length > 1);
    status.textContent = `${n} tracks in ${titleFor(year)} · ${byVideo.length} video${byVideo.length === 1 ? "" : "s"} added more than once`;
    const box = $("#s-dupes-live");
    box.innerHTML = byVideo.map(([k, g]) => `<div class="dupe"><div class="dupe-song"><b>${esc(g[0].artist)}</b> - ${esc(g[0].title)} <span class="muted">· same video · ×${g.length}</span></div>
      <div class="dupe-entries">${g.map((x, i) => `<span class="chip"><a href="https://music.youtube.com/watch?v=${esc(x.videoId)}&list=${esc(pid)}" target="_blank" rel="noopener">▶ ${i + 1}</a> ${i ? `<button class="x" type="button" data-item="${esc(x.id)}" title="remove this copy">✕</button>` : "<span class=\"muted\">keep</span>"}</span>`).join("")}</div></div>`).join("") || `<span class="muted">No duplicates in ${esc(titleFor(year))} 🎉</span>`;
    $$("button[data-item]", box).forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Remove this copy from the playlist? (50 quota units)")) return;
      b.disabled = true;
      try { await removePlaylistItem(b.dataset.item); b.closest(".chip").remove(); toast("Removed"); } catch (e) { b.disabled = false; toast(e.message, true); }
    }));
  }

  // Hide things rated from another device since the last daily build: read the newest entries of the current-year + skipped playlists.
  async function refreshRecent() {
    const y = String(new Date().getFullYear());
    const ids = [knownYear(y) || state.playlists[y], state.playlists.__skipped].filter(Boolean);
    const seen = new Set();
    for (const pid of ids) {
      const j = await yt("GET", "/playlistItems", { params: { part: "snippet", playlistId: pid, maxResults: 50 } }).catch(() => ({}));
      for (const it of j.items || []) seen.add(it.snippet.resourceId && it.snippet.resourceId.videoId);
    }
    let changed = false;
    for (const it of items()) if (it.youtube && seen.has(it.youtube.videoId) && !state.rated[it.id]) { state.rated[it.id] = { decision: "seen", at: Date.now() }; changed = true; }
    if (changed) { persist(); render(); }
  }

  // ---------- rating ----------
  async function rate(id, decision, year) {
    if (!isCurator()) return;
    if (state.busy.has(id)) return;
    const it = byId(id); if (!it) return;
    const vid = it.youtube && it.youtube.videoId;
    if (!vid) { toast("No YouTube match for this one — open it via the search link instead", true); return; }
    if (decision === "up" && !year && yearGuess(it) == null) {
      // nothing says when this came out — never guess "this year" on your behalf
      const sel = $(`.card[data-id="${CSS.escape(id)}"] .year, .dcard[data-id="${CSS.escape(id)}"] .year`);
      if (sel) { sel.focus(); sel.classList.add("attention"); setTimeout(() => sel.classList.remove("attention"), 1500); }
      toast(`Release year unknown for ${credit(it)} — pick the year playlist first (the YT Music link may show it)`, true);
      return;
    }
    year = year || yearOf(it);
    if (decision === "up" || skipsInYouTube()) { if (!(await ensureToken())) { needSignIn("Could not refresh your Google sign-in"); return; } }
    state.busy.add(id);
    // optimistic: hide it now, move focus to the next card
    state.rated[id] = { decision, year, videoId: vid, artist: it.artist, title: it.display_title || it.title, at: Date.now(), pending: true };
    persist();
    const wasCurrent = state.currentId === id; const idx = state.order.indexOf(id);
    render();
    if (deckOn()) { const nxt = deckItem(); if (nxt && wasCurrent && $("#autoplay").checked && nxt.youtube?.videoId) play(nxt.id); else if (wasCurrent && !nxt) stopPlayer(); if (nxt) render(); }
    else if (state.view === "feed") { const next = state.order[idx] || state.order[idx - 1]; if (next) { focusCard(next); if (wasCurrent && $("#autoplay").checked && byId(next)?.youtube?.videoId) play(next); } else if (wasCurrent) stopPlayer(); }
    if (decision === "down" && !skipsInYouTube()) {
      // free: no YouTube quota. Synced across your devices through the Drive app-data file.
      state.rated[id] = { ...state.rated[id], pending: false, local: true }; persist(); state.busy.delete(id); render(); schedulePush();
      toast(`👎 ${credit(it)}`, false, { label: "Undo", fn: () => undo(id) });
      return;
    }
    try {
      const pid = decision === "up" ? await playlistFor(String(year)) : await skippedPlaylist();
      if (decision === "up") {
        // never file the same video twice (1 quota unit to check)
        const present = await playlistItemsFor(pid, vid);
        if (present.length) {
          state.rated[id] = { ...state.rated[id], pending: false, duplicate: true, playlistId: pid };
          persist(); schedulePush(); state.busy.delete(id); render();
          toast(`Already in ${titleFor(year)} — ${credit(it)} was not added again`, false, { label: "Undo", fn: () => undo(id) });
          return;
        }
      }
      const itemId = await addToPlaylist(pid, vid);
      state.rated[id] = { ...state.rated[id], playlistItemId: itemId, playlistId: pid, pending: false };
      persist(); schedulePush();
      const left = Math.floor((10000 - (state.quota.day === ptDay() ? state.quota.units : 0)) / 50);
      toast((decision === "up" ? `👍 ${credit(it)} → ${titleFor(year)}` : `👎 ${credit(it)} → ${skippedTitle()}`) + (left < 40 ? ` · ${left} saves left today` : ""), false, { label: "Undo", fn: () => undo(id) });
    } catch (e) {
      delete state.rated[id]; persist(); render();
      if (/sign-in needs a refresh/i.test(e.message)) needSignIn(`Could not file ${credit(it)}`); else toast(`Could not file ${credit(it)}: ${e.message}`, true);
    } finally { state.busy.delete(id); render(); }
  }
  async function undo(id) {
    const r = state.rated[id]; if (!r) return;
    try {
      if (r.playlistItemId) await removePlaylistItem(r.playlistItemId);
      delete state.rated[id]; persist(); render(); schedulePush(); toast("Undone");
    } catch (e) { toast("Undo failed: " + e.message, true); }
  }

  // ---------- rendering ----------
  function renderMeta() {
    const f = state.feed;
    const when = f.generated_at ? new Date(f.generated_at) : null;
    $("#meta").textContent = `${f.count} candidates · ${f.new_today} new today · built ${when ? relTime(when) : "?"} · profile: ${f.profile?.counts?.direct ?? "?"} artists + ${f.profile?.counts?.similar ?? "?"} similar`;
    $("#lfm").href = "https://www.last.fm/user/" + (f.lastfm_user || "tt_discotheque");
    document.title = `${f.site_name || "Chris Rohn's New Music"} · ${f.new_today} new`;
  }
  function relTime(d) { const m = Math.round((Date.now() - d.getTime()) / 60000); if (m < 60) return m + " min ago"; const h = Math.round(m / 60); if (h < 36) return h + " h ago"; return Math.round(h / 24) + " d ago"; }
  function fillYears() { state._years = (state.feed.years && state.feed.years.length) ? state.feed.years : range(new Date().getFullYear(), 1979); }
  const range = (a, b) => { const r = []; for (let y = a; y >= b; y--) r.push(y); return r; };
  const SOURCE_LABELS = { listenbrainz: "ListenBrainz", musicbrainz: "MusicBrainz", "musicbrainz-label": "Labels", bandcamp: "Bandcamp", deezer: "Deezer", "deezer-editorial": "Deezer editorial", "deezer-related": "Deezer related", ytmusic: "Artist watch", youtube: "YouTube channels", radio: "Radio plays", rss: "Blogs", spotify: "Spotify" };
  function fillSources() {
    const box = $("#sources"); const names = state.feed.sources || []; const off = new Set(state.filters.sourcesOff || []);
    const blogs = state.feed.blogs || []; const boff = new Set(state.filters.blogsOff || []);
    const blogCount = blogs.filter(b => !boff.has(b)).length;
    box.innerHTML = names.map(s => `<label class="${off.has(s) ? "" : "on"}"><input type="checkbox" value="${esc(s)}" ${off.has(s) ? "" : "checked"}> ${esc(SOURCE_LABELS[s] || s)}</label>` +
        (s === "rss" && blogs.length ? `<button class="all pick" type="button" id="blogs-btn" title="choose which blogs">${blogCount}/${blogs.length} blogs ▾</button>` : "")).join("") +
      (names.length > 1 ? `<button class="all" type="button" data-all="1">all</button><button class="all" type="button" data-all="0">none</button>` : "");
    $$("input", box).forEach(cb => cb.addEventListener("change", () => { const set = new Set(state.filters.sourcesOff || []); cb.checked ? set.delete(cb.value) : set.add(cb.value); state.filters.sourcesOff = [...set]; cb.parentElement.classList.toggle("on", cb.checked); persist(); render(); }));
    $$("button.all[data-all]", box).forEach(b => b.addEventListener("click", () => { state.filters.sourcesOff = b.dataset.all === "1" ? [] : [...names]; persist(); fillSources(); render(); }));
    const bb = $("#blogs-btn"); if (bb) bb.addEventListener("click", openBlogPicker);
  }
  function openBlogPicker() {
    const blogs = state.feed.blogs || []; const boff = new Set(state.filters.blogsOff || []);
    const counts = {}; for (const it of items()) for (const s of it.sources || []) if (s.startsWith("rss:")) counts[s.slice(4)] = (counts[s.slice(4)] || 0) + 1;
    const body = $("#blogs-body");
    body.innerHTML = blogs.map(b => `<label class="chk"><input type="checkbox" value="${esc(b)}" ${boff.has(b) ? "" : "checked"}> ${esc(b)} <span class="muted">(${counts[b] || 0})</span></label>`).join("");
    $$("input", body).forEach(cb => cb.addEventListener("change", () => { const set = new Set(state.filters.blogsOff || []); cb.checked ? set.delete(cb.value) : set.add(cb.value); state.filters.blogsOff = [...set]; persist(); render(); }));
    $("#blogs-all").onclick = () => { state.filters.blogsOff = []; persist(); openBlogPicker(); render(); };
    $("#blogs-none").onclick = () => { state.filters.blogsOff = [...blogs]; persist(); openBlogPicker(); render(); };
    const dlg = $("#blogs"); if (!dlg.open) { dlg.showModal(); dlg.addEventListener("close", () => fillSources(), { once: true }); }
  }
  const sourceOn = s => {
    const fam = s.split(":")[0];
    if ((state.filters.sourcesOff || []).includes(fam)) return false;
    if (fam === "rss" && (state.filters.blogsOff || []).includes(s.slice(4))) return false;
    return true;
  };
  const hay = i => [i.artist, i.display_title || i.title, i.release, ...(i.tags || []), ...(i.reasons || [])].join(" ").toLowerCase();
  const credit = i => i.display || `${i.artist} - ${i.display_title || i.title}`;
  function pickAsItem(p, i) { return { id: "pick" + i, artist: p.artist, title: p.title, release: p.album, sources: [], tags: [], reasons: [], score: 0, youtube: p.videoId ? { videoId: p.videoId, thumbnail: p.thumbnail } : null, artwork: p.thumbnail, release_date: p.year ? String(p.year) : null, _pick: true, _year: p.year }; }

  function visibleItems(view = state.view) {
    const f = state.filters; const q = f.q.trim().toLowerCase();
    if (view === "picks") {
      const picks = (state.feed.picks || []).map(pickAsItem);
      const mine = Object.entries(state.rated).filter(([, r]) => r.decision === "up").sort((a, b) => b[1].at - a[1].at).map(([id, r]) => byId(id) || { id, artist: r.artist, title: r.title, sources: [], tags: [], reasons: [], score: 0, youtube: { videoId: r.videoId }, release_date: String(r.year), _pick: true, _year: r.year });
      const seen = new Set(); const all = [];
      for (const it of [...mine, ...picks]) { const k = ((it.youtube && it.youtube.videoId) || it.id); if (seen.has(k)) continue; seen.add(k); all.push({ ...it, _pick: true, _year: it._year || (state.rated[it.id] && state.rated[it.id].year) }); }
      return all.filter(i => !q || hay(i).includes(q));
    }
    let list = items().filter(i => !decisionFor(i.id));
    list = list.filter(i => {
      if (q && !hay(i).includes(q)) return false;
      if (!(i.sources || []).some(sourceOn)) return false;
      if (f.onlyNew && i.first_seen !== state.feed.generated_at?.slice(0, 10)) return false;
      if (f.onlyPlayable && !(i.youtube && i.youtube.videoId)) return false;
      if (f.onlyKnown && !i.match_kind) return false;
      if (f.onlyRecent && Number.isFinite(i.year) && i.year_source !== "unknown" && i.year < new Date().getFullYear() - 1) return false;
      return true;
    });
    const cmp = {
      score: (a, b) => b.score - a.score,
      date: (a, b) => String(b.release_date || "").localeCompare(String(a.release_date || "")) || b.score - a.score,
      seen: (a, b) => String(b.first_seen || "").localeCompare(String(a.first_seen || "")) || b.score - a.score,
      artist: (a, b) => a.artist.localeCompare(b.artist),
    }[f.sort] || ((a, b) => b.score - a.score);
    return list.sort(cmp);
  }

  const isPhone = () => window.matchMedia("(max-width: 760px)").matches;
  const deckOn = () => (state.settings.deck == null ? isPhone() : !!state.settings.deck) && state.view === "feed";
  function render() {
    const list = $("#list"); const vis = visibleItems(); state.order = vis.map(i => i.id);
    document.body.classList.toggle("deck-mode", deckOn());
    const lt = $("#layout-toggle"); if (lt) lt.textContent = deckOn() ? "list view" : "card view";
    if (deckOn()) { list.innerHTML = ""; renderDeck(vis); }
    else { $("#deck").hidden = true;
    list.innerHTML = ""; const tpl = $("#card-tpl"); const frag = document.createDocumentFragment();
    vis.forEach((it, i) => { const el = card(it, tpl); if (i < 8) { const im = el.querySelector(".art img"); if (im) im.loading = "eager"; } frag.appendChild(el); });
    list.appendChild(frag); }
    const empty = $("#empty"); empty.hidden = vis.length > 0;
    empty.textContent = state.view === "feed" ? (isCurator() ? "Nothing left to rate with these filters. Come back after tomorrow's build, or loosen the filters." : "Nothing matches these filters.") : "No picks yet.";
    // the pills show exactly what each tab would list right now: unrated tracks under the current filters, and
    // the station's recent picks plus everything you've thumbed up from this account
    $("#count-feed").textContent = state.view === "feed" ? vis.length : visibleItems("feed").length;
    $("#count-picks").textContent = state.view === "picks" ? vis.length : visibleItems("picks").length;
    $(".tab[data-view=feed]").title = `${items().filter(i => !decisionFor(i.id)).length} unrated in the whole feed · ${items().length} total`;
    $("#filters").classList.toggle("picks", state.view === "picks");
  }

  function renderDeck(vis) {
    const deck = $("#deck"); const host = $("#deck-card");
    if (!vis.length) { deck.hidden = true; host.innerHTML = ""; return; }
    deck.hidden = false;
    state.deckIndex = Math.max(0, Math.min(state.deckIndex, vis.length - 1));
    const it = vis[state.deckIndex];
    $("#deck-count").textContent = `${state.deckIndex + 1} / ${vis.length}`;
    $("#deck-prev").disabled = state.deckIndex === 0;
    const el = $("#deck-tpl").content.firstElementChild.cloneNode(true);
    el.dataset.id = it.id;
    const yt = it.youtube || {};
    const img = $("img", el); if (it.artwork || yt.thumbnail) img.src = it.artwork || yt.thumbnail; else img.remove();
    if (!yt.videoId) $(".dplay", el).remove();
    $(".dartist", el).textContent = it.artist;
    $(".dtitle", el).textContent = it.display_title || it.title;
    $(".release", el).textContent = [it.release_type, it.release && !sameName(it.release, it.title) ? it.release : null].filter(Boolean).join(" · ");
    $(".date", el).textContent = it.release_date || "";
    const yb = $(".yearbadge", el); const conf = it.year_confidence || "low"; yb.classList.add(conf); yb.title = (YEAR_SOURCE[it.year_source] || "") + ((it.year_evidence || []).length ? "\n" + it.year_evidence.join("\n") : "");
    yb.textContent = it.original_year ? `reissue? originally ${it.original_year}` : it.year_source === "unknown" ? (yearGuess(it) == null ? "year unknown" : `${yearGuess(it)}? · unverified`) : (conf === "high" ? `${yearOf(it)} ✓` : conf === "medium" ? `${yearOf(it)}` : `${yearOf(it)} ?`);
    if (Number.isFinite(it.year) && it.year < new Date().getFullYear() - 1 && it.year_source !== "unknown") yb.textContent += " · catalog";
    const why = [];
    if (it.match_kind === "direct") why.push(it.matched_artist === it.artist ? "you play them" : "you play " + it.matched_artist);
    else if (it.match_kind === "similar") why.push(it.reasons.find(r => r.startsWith("similar to ")) || "similar artist");
    for (const r of it.reasons || []) if (!r.startsWith("you play") && !r.startsWith("similar to")) why.push(r);
    $(".dwhy", el).textContent = why.join(" · ");
    $(".dtags", el).innerHTML = (it.tags || []).slice(0, 4).map(t => `<span class="tag">${esc(t)}</span>`).join("");
    $(".dsources", el).innerHTML = (it.sources || []).map(s => { const [k, n] = s.split(":"); return `<span class="src ${esc(k)}">${esc(n || k)}</span>`; }).join("");
    const links = [];
    if (yt.videoId) links.push(`<a href="https://music.youtube.com/watch?v=${esc(yt.videoId)}" target="_blank" rel="noopener">YT Music</a>`);
    for (const [k, u] of Object.entries(it.links || {})) links.push(`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(k)}</a>`);
    $(".dlinks", el).innerHTML = links.join(" · ");
    const ysel = $(".year", el); fillYearSelect(ysel, it);
    $(".dart", el).addEventListener("click", () => { if (yt.videoId) { if (state.currentId === it.id && state.playerReady) toggle(); else play(it.id); } });
    attachSwipe(el, it, 110);
    if (state.currentId === it.id) el.classList.add("current");
    host.innerHTML = ""; host.appendChild(el);
    $("#deck-play").textContent = state.currentId === it.id && state.playerReady && state.player.getPlayerState && state.player.getPlayerState() === 1 ? "⏸" : "▶";
    $("#deck-play").disabled = !yt.videoId;
  }
  const deckItem = () => { const id = $("#deck-card .dcard")?.dataset.id; return id ? byId(id) : null; };
  function deckYear() { const s = $("#deck-card .year"); return s ? +s.value : undefined; }

  function card(it, tpl) {
    const el = tpl.content.firstElementChild.cloneNode(true);
    el.dataset.id = it.id;
    const yt = it.youtube || {};
    const art = $(".art", el); const img = $("img", art);
    if (it.artwork || yt.thumbnail) img.src = it.artwork || yt.thumbnail; else img.remove();
    if (!yt.videoId) art.classList.add("unplayable");
    if (it.first_seen && it.first_seen === state.feed.generated_at?.slice(0, 10) && !it._pick) el.classList.add("new");
    $(".artist", el).textContent = it.artist;
    const m = $(".match", el);
    if (it.match_kind) { m.textContent = it.match_kind === "direct" ? "you play " + (it.matched_artist === it.artist ? "them" : it.matched_artist) : "similar to " + (it.reasons.find(r => r.startsWith("similar to ")) || "").slice(11); m.classList.add(it.match_kind); } else m.remove();
    $(".title", el).textContent = it.display_title || it.title;
    $(".release", el).textContent = [it.release_type, it.release && !sameName(it.release, it.title) ? it.release : null].filter(Boolean).join(" · ");
    $(".date", el).textContent = it.release_date || "";
    const yb = $(".yearbadge", el);
    if (it._pick) yb.remove();
    else {
      const conf = it.year_confidence || "low";
      yb.classList.add(conf);
      yb.title = (YEAR_SOURCE[it.year_source] || "") + ((it.year_evidence || []).length ? "\n" + it.year_evidence.join("\n") : "");
      yb.textContent = it.original_year ? `reissue? originally ${it.original_year}` : it.year_source === "unknown" ? (yearGuess(it) == null ? "year unknown" : `${yearGuess(it)}? · unverified`) : (conf === "high" ? `${yearOf(it)} ✓` : conf === "medium" ? `${yearOf(it)}` : `${yearOf(it)} ?`);
      if (Number.isFinite(it.year) && it.year < new Date().getFullYear() - 1 && it.year_source !== "unknown") yb.textContent += " · catalog";
    }
    $(".reasons", el).textContent = (it.reasons || []).filter(r => !r.startsWith("similar to") && !r.startsWith("you play")).join(" · ");
    $(".tags", el).innerHTML = (it.tags || []).slice(0, 6).map(t => `<span class="tag">${esc(t)}</span>`).join("");
    $(".sources", el).innerHTML = (it.sources || []).map(s => { const [k, n] = s.split(":"); return `<span class="src ${esc(k)}" title="${esc(s)}">${esc(n || k)}</span>`; }).join("");
    const links = [];
    if (yt.videoId) links.push(`<a href="https://music.youtube.com/watch?v=${esc(yt.videoId)}" target="_blank" rel="noopener">YouTube Music</a>`);
    if (yt.playlistId) links.push(`<a href="https://music.youtube.com/playlist?list=${esc(yt.playlistId)}" target="_blank" rel="noopener">full release</a>`);
    if (!yt.videoId) links.push(`<a href="https://music.youtube.com/search?q=${encodeURIComponent(it.artist + " " + it.title)}" target="_blank" rel="noopener">search YT Music</a>`);
    for (const [k, u] of Object.entries(it.links || {})) links.push(`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(k)}</a>`);
    links.push(`<a href="https://www.last.fm/music/${encodeURIComponent(it.artist)}" target="_blank" rel="noopener">last.fm</a>`);
    $(".links", el).innerHTML = links.join(" · ");
    $(".score", el).textContent = it.score ? it.score.toFixed(1) : "";
    const ysel = $(".year", el);
    if (it._pick) { ysel.remove(); $(".thumbs", el).remove(); const st = document.createElement("div"); st.className = "status"; st.textContent = it._year ? `in ${titleFor(it._year)}` : ""; $(".side", el).appendChild(st); }
    else {
      fillYearSelect(ysel, it);
      $(".btn.up", el).addEventListener("click", e => { e.stopPropagation(); rate(it.id, "up", +ysel.value); });
      $(".btn.down", el).addEventListener("click", e => { e.stopPropagation(); rate(it.id, "down", +ysel.value); });
    }
    art.addEventListener("click", () => { if (yt.videoId) play(it.id); });
    el.addEventListener("dblclick", () => { if (yt.videoId) play(it.id); });
    if (!it._pick) attachSwipe(el, it);
    el.addEventListener("focus", () => { state.currentId = it.id; $$(".card.current").forEach(c => c.classList.remove("current")); el.classList.add("current"); });
    return el;
  }
  function attachSwipe(el, it, threshold = 90) {
    let x0 = 0, y0 = 0, dx = 0, active = false;
    el.addEventListener("touchstart", e => { if (!isCurator()) return; const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; dx = 0; active = true; el.classList.add("swiping"); }, { passive: true });
    el.addEventListener("touchmove", e => {
      if (!active) return; const t = e.touches[0]; dx = t.clientX - x0;
      if (Math.abs(t.clientY - y0) > 40 && Math.abs(dx) < 30) { active = false; el.style.transform = ""; el.classList.remove("swipe-up", "swipe-down", "swiping"); return; }
      el.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
      el.classList.toggle("swipe-up", dx > 60); el.classList.toggle("swipe-down", dx < -60);
    }, { passive: true });
    const end = () => {
      if (!active) return; active = false; el.classList.remove("swiping");
      const ysel = $(".year", el); const year = ysel ? +ysel.value : undefined;
      if (dx > threshold) rate(it.id, "up", year); else if (dx < -threshold) rate(it.id, "down", year);
      el.style.transform = ""; el.classList.remove("swipe-up", "swipe-down");
    };
    el.addEventListener("touchend", end); el.addEventListener("touchcancel", end);
  }
  function focusCard(id) { const el = $(`.card[data-id="${CSS.escape(id)}"]`); if (el) { el.focus({ preventScroll: false }); el.scrollIntoView({ block: "center", behavior: "smooth" }); } }

  // ---------- player ----------
  window.onYouTubeIframeAPIReady = () => {
    state.player = new YT.Player("yt", {
      width: "220", height: "124", videoId: state.pendingVideo || undefined,
      playerVars: { autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1, origin: location.origin },
      events: {
        onReady: () => { state.playerReady = true; if (state.pendingVideo) { state.player.loadVideoById(state.pendingVideo); state.pendingVideo = null; } },
        onStateChange: e => {
          if (e.data === YT.PlayerState.ENDED && $("#autoplay").checked) { clearAudition(); nextTrack(); }
          if (e.data === YT.PlayerState.PLAYING) startAudition();
          if (e.data === YT.PlayerState.PAUSED) clearAudition(false);
        },
        onError: () => { toast("Can't embed this one – opening YouTube Music", true); const it = current(); if (it?.youtube?.videoId) window.open("https://music.youtube.com/watch?v=" + it.youtube.videoId, "_blank"); },
      },
    });
  };
  const current = () => byId(state.currentId) || visibleItems().find(i => i.id === state.currentId);
  function ensureApi() { if (window.YT && window.YT.Player) return; if ($("#yt-api")) return; const s = document.createElement("script"); s.id = "yt-api"; s.src = "https://www.youtube.com/iframe_api"; document.head.appendChild(s); }
  function play(id) {
    state.currentId = id; const it = current(); const vid = it?.youtube?.videoId; if (!vid) return;
    $$(".card.current, .dcard.current").forEach(c => c.classList.remove("current"));
    const el = $(`.card[data-id="${CSS.escape(id)}"], .dcard[data-id="${CSS.escape(id)}"]`); if (el) el.classList.add("current");
    const dp = $("#deck-play"); if (dp) dp.textContent = "⏸";
    $("#player").hidden = false;
    $("#now").innerHTML = `<b>${esc(it.artist)}</b> - ${esc(it.display_title || it.title)} ${it.release && !sameName(it.release, it.title) ? `<span class="muted">· ${esc(it.release)}</span>` : ""}`;
    ensureApi();
    clearAudition(); state.auditionArmed = null;
    if (state.playerReady) state.player.loadVideoById(vid); else state.pendingVideo = vid;
  }
  function stopPlayer() { clearAudition(); if (state.playerReady) state.player.stopVideo(); $("#player").hidden = true; state.currentId = null; }

  // ---------- audition mode: jump partway in, auto-advance after N seconds unless you intervene ----------
  const auditionOn = () => !!state.settings.audition;
  function clearAudition(hide = true) {
    clearTimeout(state.auditionTimer); clearInterval(state.auditionTick); state.auditionTimer = state.auditionTick = null;
    if (hide) { const bar = $("#audition-bar"); bar.hidden = true; $("i", bar).style.width = "0"; }
  }
  function startAudition() {
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
  function holdAudition() { if (state.auditionTimer) { clearAudition(); toast("Audition timer cancelled for this track"); } }
  function step(delta) {
    if (deckOn()) { const vis = visibleItems(); state.deckIndex = Math.max(0, Math.min(vis.length - 1, state.deckIndex + delta)); renderDeck(vis); const it = deckItem(); if (it?.youtube?.videoId && state.currentId) play(it.id); return; }
    const i = state.order.indexOf(state.currentId); let j = i < 0 ? 0 : i + delta;
    while (j >= 0 && j < state.order.length) { const id = state.order[j]; const it = byId(id) || visibleItems().find(x => x.id === id); if (it?.youtube?.videoId) { play(id); focusCard(id); return; } j += delta; }
  }
  const nextTrack = () => step(1); const prevTrack = () => step(-1);
  function toggle() { if (!state.playerReady) return; const s = state.player.getPlayerState(); if (s === YT.PlayerState.PLAYING) state.player.pauseVideo(); else state.player.playVideo(); }

  // ---------- misc ----------
  let toastTimer;
  function toast(msg, err = false, action) {
    let t = $(".toast"); if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
    t.textContent = msg; t.classList.toggle("err", err); t.style.display = "";
    if (action) { const b = document.createElement("button"); b.className = "btn ghost"; b.textContent = action.label; b.addEventListener("click", () => { t.style.display = "none"; action.fn(); }); t.appendChild(b); }
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.display = "none"; }, err ? 7000 : (action ? 8000 : 2600));
  }
  function exportCsv() {
    const rows = [["Title", "Artist", "Notation", "Year", "YouTube"], ...Object.values(state.rated).filter(d => d.decision === "up").map(d => [d.title, d.artist, `${d.artist} - ${d.title}`, d.year, d.videoId ? "https://music.youtube.com/watch?v=" + d.videoId : ""])];
    const csv = rows.map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = `new-music-approvals-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  }
  function currentYear(id = state.currentId) { const el = id && $(`.card[data-id="${CSS.escape(id)}"] .year, .dcard[data-id="${CSS.escape(id)}"] .year`); return el && el.value ? +el.value : undefined; }

  function wire() {
    $$(".tab").forEach(b => b.addEventListener("click", () => { state.view = b.dataset.view; $$(".tab").forEach(x => x.classList.toggle("active", x === b)); render(); }));
    const f = state.filters;
    $("#q").value = f.q; $("#sort").value = f.sort; $("#only-new").checked = f.onlyNew; $("#only-playable").checked = f.onlyPlayable; $("#only-known").checked = f.onlyKnown;
    $("#q").addEventListener("input", e => { f.q = e.target.value; persist(); render(); });
    $("#sort").addEventListener("change", e => { f.sort = e.target.value; persist(); render(); });
    $("#only-new").addEventListener("change", e => { f.onlyNew = e.target.checked; persist(); render(); });
    $("#only-playable").addEventListener("change", e => { f.onlyPlayable = e.target.checked; persist(); render(); });
    $("#only-known").addEventListener("change", e => { f.onlyKnown = e.target.checked; persist(); render(); });
    $("#only-recent").checked = f.onlyRecent;
    $("#only-recent").addEventListener("change", e => { f.onlyRecent = e.target.checked; persist(); render(); });
    $("#signin").addEventListener("click", () => { if (isSignedIn()) signOut(); else signIn().catch(e => toast(e.message, true)); });
    $("#p-next").addEventListener("click", nextTrack); $("#p-prev").addEventListener("click", prevTrack); $("#p-toggle").addEventListener("click", () => { holdAudition(); toggle(); });
    const aud = $("#audition"); aud.checked = auditionOn(); $("#audition-label").textContent = (state.settings.auditionSeconds || 30) + "s";
    aud.addEventListener("change", () => { state.settings.audition = aud.checked; persist(); if (aud.checked && state.playerReady && state.player.getPlayerState() === YT.PlayerState.PLAYING) startAudition(); else clearAudition(); });
    $("#s-aud-secs").value = state.settings.auditionSeconds || 30; $("#s-aud-start").value = state.settings.auditionStart ?? 25;
    $("#s-aud-secs").addEventListener("change", e => { state.settings.auditionSeconds = Math.max(10, +e.target.value || 30); $("#audition-label").textContent = state.settings.auditionSeconds + "s"; persist(); });
    $("#s-aud-start").addEventListener("change", e => { state.settings.auditionStart = Math.min(80, Math.max(0, +e.target.value || 0)); persist(); });
    $("#yt").addEventListener("click", holdAudition, true);
    if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("/sw.js").catch(() => {});
    $("#deck-up").addEventListener("click", () => { const it = deckItem(); if (it) rate(it.id, "up", deckYear()); });
    $("#deck-down").addEventListener("click", () => { const it = deckItem(); if (it) rate(it.id, "down", deckYear()); });
    $("#deck-play").addEventListener("click", () => { const it = deckItem(); if (!it?.youtube?.videoId) return; if (state.currentId === it.id && state.playerReady) { holdAudition(); toggle(); $("#deck-play").textContent = $("#deck-play").textContent === "⏸" ? "▶" : "⏸"; } else play(it.id); });
    $("#deck-next").addEventListener("click", () => { state.deckIndex++; render(); const it = deckItem(); if (it?.youtube?.videoId && state.currentId) play(it.id); });
    $("#deck-prev").addEventListener("click", () => { state.deckIndex = Math.max(0, state.deckIndex - 1); render(); });
    $("#layout-toggle").addEventListener("click", () => { state.settings.deck = !deckOn(); persist(); render(); });
    $("#deck-filters").addEventListener("click", () => document.body.classList.toggle("filters-open"));
    // keep the pinned deck buttons above the player bar whatever its height
    const playerEl = $("#player");
    const setPlayerH = () => document.documentElement.style.setProperty("--player-h", playerEl.hidden ? "0px" : playerEl.getBoundingClientRect().height + "px");
    new ResizeObserver(setPlayerH).observe(playerEl); new MutationObserver(setPlayerH).observe(playerEl, { attributes: true, attributeFilter: ["hidden"] }); setPlayerH();
    window.matchMedia("(max-width: 760px)").addEventListener("change", () => render());
    $("#p-up").addEventListener("click", () => state.currentId && rate(state.currentId, "up", currentYear()));
    $("#p-down").addEventListener("click", () => state.currentId && rate(state.currentId, "down", currentYear()));
    $("#settings-btn").addEventListener("click", () => {
      const yrs = [...new Set([...Object.keys(state.playlists).filter(k => !k.startsWith("__")), ...(isOwner() ? Object.keys((state.feed.youtube && state.feed.youtube.playlists) || {}) : [])])].sort();
      $("#s-playlists").textContent = `${yrs.length} year playlists known${yrs.length ? ` (${yrs[0]}–${yrs[yrs.length - 1]})` : ""}` + (state.playlists.__skipped ? ` · skipped playlist: ${state.playlists.__skipped}` : "") + (state.notOwner ? " · station playlists are collaborative (owned by @indiedisco); filing uses their known ids" : "");
      $("#s-quota").textContent = quotaText();
      const acct = $("#s-account"); if (acct && state.lastAuthError) acct.insertAdjacentHTML("beforeend", ` <span class="muted">Last sign-in problem: ${esc(state.lastAuthError.why)} (${relTime(new Date(state.lastAuthError.at))}).</span>`);
      $("#s-sync").textContent = state.sync.at ? `Ratings synced across your devices via Google Drive app data · last sync ${relTime(new Date(state.sync.at))} · ${Object.keys(state.rated).length} rated tracks remembered` : "Ratings not synced yet — sign in to sync across devices (uses a hidden app-data file in your Google Drive).";
      const g = $("#s-guests");
      if (isOwner()) {
        g.hidden = false;
        g.innerHTML = `Guest rating is <b>${guestsAllowed() ? "on" : "off"}</b> (other Google accounts ${guestsAllowed() ? "can rate into their own “" + esc((state.feed.google || {}).guest_playlist_title_pattern || "") + "” playlists" : "get a listen-only site"}). This is a site-wide switch, so it lives in the repo: <a href="https://github.com/chrisrohn/chrisrohn/edit/main/discovery/config.yaml" target="_blank" rel="noopener">edit config.yaml</a> → <code>google.guests: ${guestsAllowed() ? "false" : "true"}</code>. Takes effect at the next daily build (or run the Discover workflow).`;
      } else g.hidden = true;
      const fh = state.feed.feed_health || {};
      const rows = Object.entries(fh).sort((x, y) => (y[1].kept - x[1].kept) || x[0].localeCompare(y[0]));
      $("#s-feeds").innerHTML = rows.length ? rows.map(([n, h]) => `<span class="${h.ok ? (h.kept ? "ok" : "quiet") : "dead"}" title="${esc(h.error || "")}">${esc(n)} ${h.ok ? h.kept + "/" + h.entries : "✗"}</span>`).join("") : "<span class=\"muted\">no blog feed data yet</span>";
      $("#s-skips").checked = skipsInYouTube();
      renderDupes();
      $("#settings").showModal();
    });
    $("#s-dupe-scan").addEventListener("click", () => scanYear(+$("#s-dupe-year").value).catch(e => { $("#s-dupe-status").textContent = ""; toast(e.message, true); }));
    ["#s-dupe-kind", "#s-dupe-yr"].forEach(id => $(id).addEventListener("change", () => renderDupes()));
    $("#s-dupe-q").addEventListener("input", () => { clearTimeout(state.dupeQT); state.dupeQT = setTimeout(() => renderDupes(), 200); });
    $("#s-dupe-bulk").addEventListener("click", bulkRemoveExtras);
    $("#s-skips").addEventListener("change", e => { state.settings.skipsInYouTube = e.target.checked; persist(); });
    $("#s-export").addEventListener("click", exportCsv);
    $("#s-syncnow").addEventListener("click", () => pushRatings().then(() => pullRatings()).then(() => { $("#s-sync").textContent = `Synced just now · ${Object.keys(state.rated).length} rated tracks`; toast("Ratings synced"); }).catch(e => toast(e.message, true)));
    $("#s-reload").addEventListener("click", () => loadLibraryPlaylists().then(() => toast(`Playlists reloaded: ${Object.keys(state.playlists).filter(k => !k.startsWith("__")).length} year playlists found`)).catch(e => toast(e.message, true)));
    $("#s-clear").addEventListener("click", () => { if (confirm("Clear local state (sign-in, filters, local rating mirror)? Nothing in YouTube is touched.")) { ["id:rated", "id:auth", "id:playlists", "id:filters", "id:sync"].forEach(LS.del); location.reload(); } });
    document.addEventListener("keydown", e => {
      if (e.target.matches("input, select, textarea") || $("dialog[open]")) return;
      const id = deckOn() ? (deckItem()?.id || state.currentId) : (state.currentId || state.order[0]);
      switch (e.key) {
        case "j": case "ArrowDown": e.preventDefault(); state.currentId ? step(1) : focusCard(state.order[0]); break;
        case "k": case "ArrowUp": e.preventDefault(); step(-1); break;
        case " ": e.preventDefault(); if (state.playerReady && state.currentId) toggle(); else if (id) play(id); break;
        case "u": case "ArrowRight": if (id) rate(id, "up", currentYear(id)); break;
        case "d": case "ArrowLeft": if (id) rate(id, "down", currentYear(id)); break;
        case "o": { const it = byId(id); if (it?.youtube?.videoId) window.open("https://music.youtube.com/watch?v=" + it.youtube.videoId, "_blank"); break; }
        case "a": { const cb = $("#audition"); cb.checked = !cb.checked; cb.dispatchEvent(new Event("change")); toast(cb.checked ? `Audition mode on (${state.settings.auditionSeconds}s)` : "Audition mode off"); break; }
        case "/": e.preventDefault(); $("#q").focus(); break;
        case "Escape": stopPlayer(); break;
      }
    });
  }

  wire();
  load().catch(e => { $("#meta").textContent = "Feed not built yet — run the Discover workflow once. (" + e.message + ")"; $("#empty").hidden = false; $("#empty").textContent = "No feed yet."; });
})();
