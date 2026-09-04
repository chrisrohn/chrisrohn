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
  const SCOPES = "openid email https://www.googleapis.com/auth/youtube";

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
    if (isCurator()) refreshRecent().catch(() => {});
  }
  function persist() {
    LS.set("id:rated", state.rated);
    LS.set("id:auth", state.auth);
    LS.set("id:playlists", state.playlists);
    LS.set("id:filters", state.filters);
    LS.set("id:settings", state.settings);
    LS.set("id:quota", state.quota);
  }
  const skipsInYouTube = () => state.settings.skipsInYouTube != null ? !!state.settings.skipsInYouTube : !!(state.feed && state.feed.youtube && state.feed.youtube.skips_in_youtube);
  // YouTube quota: 10,000 units/day, reset at midnight Pacific. Reads cost 1, writes cost 50.
  const ptDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  function spend(units) { if (state.quota.day !== ptDay()) state.quota = { day: ptDay(), units: 0 }; state.quota.units += units; persist(); }
  const quotaText = () => { const u = state.quota.day === ptDay() ? state.quota.units : 0; return `~${u.toLocaleString()} of 10,000 YouTube API units used today (${Math.floor((10000 - u) / 50)} more saves) · resets midnight Pacific`; };
  const items = () => (state.feed && state.feed.items) || [];
  const byId = id => items().find(i => i.id === id);
  const decisionFor = id => state.rated[id] || null;
  const yearOf = it => {
    if (Number.isFinite(it.year)) return it.year;
    const d = it.release_date || (it.youtube && it.youtube.year);
    const y = d ? parseInt(String(d).slice(0, 4), 10) : NaN;
    return Number.isFinite(y) ? y : new Date().getFullYear();
  };
  const YEAR_SOURCE = { "musicbrainz-recording": "verified on MusicBrainz (earliest release of this recording)", deezer: "earliest release on Deezer", itunes: "earliest release on Apple Music", "release-date": "from the release date reported by the source", youtube: "from the YouTube album", "feed-date": "from the blog post date only — check it", unknown: "no release date found anywhere — pick the year yourself" };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- auth (Google Identity Services, token flow) ----------
  const tokenValid = () => !!(state.auth && state.auth.access_token && state.auth.expires_at > Date.now() + 30e3);
  const curators = () => ((state.feed && state.feed.google && state.feed.google.curators) || []).map(e => e.toLowerCase());
  const isSignedIn = () => tokenValid() && !!state.auth.email;
  const isOwner = () => isSignedIn() && curators().includes(state.auth.email.toLowerCase());
  const guestsAllowed = () => !!(state.feed && state.feed.google && state.feed.google.guests);
  // "curator" = anyone allowed to rate: the owner, or a guest when guests are enabled. Guests file into their own library.
  const isCurator = () => isOwner() || (isSignedIn() && guestsAllowed());
  const role = () => isOwner() ? "curator" : (isCurator() ? "guest" : "listener");
  function applyMode() {
    const on = isCurator();
    document.body.classList.toggle("curator", on);
    document.body.classList.toggle("guest", on && !isOwner());
    const badge = $(".mode"); if (badge) { badge.textContent = role(); badge.title = isOwner() ? "Curator: thumbs file into the Indie Discotheque year playlists" : `Guest: thumbs file into your own “${titleFor("<year>")}” playlists`; }
    const who = $("#who");
    if (state.auth && state.auth.email) {
      who.hidden = false;
      who.innerHTML = `${state.auth.picture ? `<img src="${esc(state.auth.picture)}" alt="">` : ""}<span>${esc(state.auth.name || state.auth.email)}</span>` +
        (on ? "" : (tokenValid() ? ` <span class="muted">(listener)</span>` : ` <span class="muted">(session expired)</span>`));
      $("#signin").textContent = tokenValid() ? "Sign out" : "Sign in again";
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
  async function signIn() {
    const cid = state.feed.google && state.feed.google.client_id;
    if (!cid) { toast("Google client ID not configured yet — see SETUP.md", true); return false; }
    await ensureGis();
    return new Promise(resolve => {
      state.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: cid, scope: SCOPES,
        callback: async resp => {
          if (resp.error) { toast("Sign-in failed: " + resp.error, true); return resolve(false); }
          const prevEmail = state.auth && state.auth.email;
          state.auth = { access_token: resp.access_token, expires_at: Date.now() + (resp.expires_in || 3600) * 1000 };
          try {
            const me = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + resp.access_token } }).then(r => r.json());
            Object.assign(state.auth, { email: me.email, name: me.name, picture: me.picture });
          } catch {}
          if (prevEmail && prevEmail !== state.auth.email) { state.playlists = {}; state.rated = {}; }
          persist(); applyMode(); render();
          if (isOwner()) { toast(`Curator mode on — ${state.auth.email}`); refreshRecent().catch(() => {}); }
          else if (isCurator()) { toast(`Signed in as a guest. 👍 files into “${titleFor("<year>")}” in your own YouTube library.`); refreshRecent().catch(() => {}); }
          else toast(`Signed in as ${state.auth.email || "?"}. Guest rating is off, so it's listen-only.`);
          resolve(true);
        },
      });
      state.tokenClient.requestAccessToken({ prompt: "", hint: state.auth && state.auth.email ? state.auth.email : undefined });
    });
  }
  function signOut() {
    try { if (state.auth && state.auth.access_token && window.google) google.accounts.oauth2.revoke(state.auth.access_token, () => {}); } catch {}
    state.auth = null; state.playlists = {}; persist(); applyMode(); render(); toast("Signed out");
  }
  async function withAuth(fn) {
    if (!tokenValid()) { const ok = await signIn(); if (!ok || !tokenValid()) throw new Error("not signed in"); }
    return fn(state.auth.access_token);
  }

  // ---------- YouTube Data API ----------
  async function yt(method, path, { params = {}, body } = {}) {
    return withAuth(async token => {
      const url = new URL(YT_API + path); for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
      const r = await fetch(url, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      spend(method === "GET" ? 1 : 50);
      if (r.status === 204) return {};
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = (j.error && j.error.message) || r.statusText;
        if (r.status === 401) { state.auth.expires_at = 0; persist(); applyMode(); }
        throw new Error(msg + (r.status === 403 && /quota/i.test(msg) ? " — daily YouTube API quota reached; try again after midnight Pacific" : ""));
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

  async function loadLibraryPlaylists() {
    const rx = titleRegex();
    let pageToken; let n = 0;
    do {
      const j = await yt("GET", "/playlists", { params: { part: "snippet", mine: "true", maxResults: 50, pageToken } });
      for (const p of j.items || []) {
        const t = (p.snippet.title || "").trim();
        const m = rx.exec(t);
        if (m) state.playlists[m[1]] = p.id;
        else if (t.toLowerCase() === skippedTitle().toLowerCase()) state.playlists.__skipped = p.id;
        n++;
      }
      pageToken = j.nextPageToken;
    } while (pageToken && n < 500);
    state.playlists.__loaded_at = Date.now();
    persist();
  }
  async function playlistFor(year) {
    if (!state.playlists[year] || !state.playlists.__loaded_at) await loadLibraryPlaylists();
    if (!state.playlists[year]) {
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

  // Hide things rated from another device since the last daily build: read the newest entries of the current-year + skipped playlists.
  async function refreshRecent() {
    const ids = [state.playlists[String(new Date().getFullYear())], state.playlists.__skipped].filter(Boolean);
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
    year = year || yearOf(it);
    state.busy.add(id);
    // optimistic: hide it now, move focus to the next card
    state.rated[id] = { decision, year, videoId: vid, artist: it.artist, title: it.display_title || it.title, at: Date.now(), pending: true };
    persist();
    const wasCurrent = state.currentId === id; const idx = state.order.indexOf(id);
    render();
    if (deckOn()) { const nxt = deckItem(); if (nxt && wasCurrent && $("#autoplay").checked && nxt.youtube?.videoId) play(nxt.id); else if (wasCurrent && !nxt) stopPlayer(); if (nxt) render(); }
    else if (state.view === "feed") { const next = state.order[idx] || state.order[idx - 1]; if (next) { focusCard(next); if (wasCurrent && $("#autoplay").checked && byId(next)?.youtube?.videoId) play(next); } else if (wasCurrent) stopPlayer(); }
    if (decision === "down" && !skipsInYouTube()) {
      // free: remembered in this browser only (no quota). Turn on "skips in YouTube" in ⚙ to sync across devices.
      state.rated[id] = { ...state.rated[id], pending: false, local: true }; persist(); state.busy.delete(id); render();
      toast(`👎 ${credit(it)}`, false, { label: "Undo", fn: () => undo(id) });
      return;
    }
    try {
      const pid = decision === "up" ? await playlistFor(String(year)) : await skippedPlaylist();
      const itemId = await addToPlaylist(pid, vid);
      state.rated[id] = { ...state.rated[id], playlistItemId: itemId, playlistId: pid, pending: false };
      persist();
      const left = Math.floor((10000 - (state.quota.day === ptDay() ? state.quota.units : 0)) / 50);
      toast((decision === "up" ? `👍 ${credit(it)} → ${titleFor(year)}` : `👎 ${credit(it)} → ${skippedTitle()}`) + (left < 40 ? ` · ${left} saves left today` : ""), false, { label: "Undo", fn: () => undo(id) });
    } catch (e) {
      delete state.rated[id]; persist(); render();
      toast(`Could not file ${credit(it)}: ${e.message}`, true);
    } finally { state.busy.delete(id); render(); }
  }
  async function undo(id) {
    const r = state.rated[id]; if (!r) return;
    try {
      if (r.playlistItemId) await removePlaylistItem(r.playlistItemId);
      delete state.rated[id]; persist(); render(); toast("Undone");
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

  function visibleItems() {
    const f = state.filters; const q = f.q.trim().toLowerCase();
    if (state.view === "picks") {
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
    for (const it of vis) frag.appendChild(card(it, tpl));
    list.appendChild(frag); }
    const empty = $("#empty"); empty.hidden = vis.length > 0;
    empty.textContent = state.view === "feed" ? (isCurator() ? "Nothing left to rate with these filters. Come back after tomorrow's build, or loosen the filters." : "Nothing matches these filters.") : "No picks yet.";
    $("#count-feed").textContent = items().filter(i => !decisionFor(i.id)).length;
    $("#count-picks").textContent = (state.feed.picks || []).length;
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
    $(".release", el).textContent = [it.release_type, it.release && it.release !== it.title ? it.release : null].filter(Boolean).join(" · ");
    $(".date", el).textContent = it.release_date || "";
    const yb = $(".yearbadge", el); const conf = it.year_confidence || "low"; yb.classList.add(conf); yb.title = YEAR_SOURCE[it.year_source] || "";
    yb.textContent = it.original_year ? `reissue? originally ${it.original_year}` : it.year_source === "unknown" ? "year unknown" : (conf === "high" ? `${yearOf(it)} ✓` : conf === "medium" ? `${yearOf(it)}` : `${yearOf(it)} ?`);
    if (Number.isFinite(it.year) && it.year < new Date().getFullYear() - 1 && it.year_source !== "unknown") yb.textContent += " · catalog";
    const why = [];
    if (it.match_kind === "direct") why.push(it.matched_artist === it.artist ? "you play them" : "you play " + it.matched_artist);
    else if (it.match_kind === "similar") why.push(it.reasons.find(r => r.startsWith("similar to ")) || "similar artist");
    for (const r of it.reasons || []) if (!r.startsWith("you play") && !r.startsWith("similar to")) why.push(r);
    $(".dwhy", el).textContent = why.join(" · ");
    $(".dtags", el).innerHTML = (it.tags || []).slice(0, 5).map(t => `<span class="tag">${esc(t)}</span>`).join("");
    $(".dsources", el).innerHTML = (it.sources || []).map(s => { const [k, n] = s.split(":"); return `<span class="src ${esc(k)}">${esc(n || k)}</span>`; }).join("");
    const links = [];
    if (yt.videoId) links.push(`<a href="https://music.youtube.com/watch?v=${esc(yt.videoId)}" target="_blank" rel="noopener">YT Music</a>`);
    for (const [k, u] of Object.entries(it.links || {})) links.push(`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(k)}</a>`);
    $(".dlinks", el).innerHTML = links.join(" · ");
    const ysel = $(".year", el); ysel.innerHTML = state._years.map(y => `<option value="${y}">${y}</option>`).join(""); ysel.value = yearOf(it);
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
    $(".release", el).textContent = [it.release_type, it.release && it.release !== it.title ? it.release : null].filter(Boolean).join(" · ");
    $(".date", el).textContent = it.release_date || "";
    const yb = $(".yearbadge", el);
    if (it._pick) yb.remove();
    else {
      const conf = it.year_confidence || "low";
      yb.classList.add(conf);
      yb.title = YEAR_SOURCE[it.year_source] || "";
      yb.textContent = it.original_year ? `reissue? originally ${it.original_year}` : it.year_source === "unknown" ? "year unknown" : (conf === "high" ? `${yearOf(it)} ✓` : conf === "medium" ? `${yearOf(it)}` : `${yearOf(it)} ?`);
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
      ysel.innerHTML = state._years.map(y => `<option value="${y}">${y}</option>`).join(""); ysel.value = yearOf(it);
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
    $("#now").innerHTML = `<b>${esc(it.artist)}</b> - ${esc(it.display_title || it.title)} ${it.release ? `<span class="muted">· ${esc(it.release)}</span>` : ""}`;
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
  function currentYear(id = state.currentId) { const el = id && $(`.card[data-id="${CSS.escape(id)}"] .year, .dcard[data-id="${CSS.escape(id)}"] .year`); return el ? +el.value : undefined; }

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
    $("#signin").addEventListener("click", () => { if (state.auth && tokenValid()) signOut(); else signIn().catch(e => toast(e.message, true)); });
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
      $("#s-playlists").textContent = Object.entries(state.playlists).filter(([k]) => !k.startsWith("__")).length + " year playlists known" + (state.playlists.__skipped ? ` · skipped playlist: ${state.playlists.__skipped}` : " · no skipped playlist yet");
      $("#s-quota").textContent = quotaText();
      const g = $("#s-guests");
      if (isOwner()) {
        g.hidden = false;
        g.innerHTML = `Guest rating is <b>${guestsAllowed() ? "on" : "off"}</b> (other Google accounts ${guestsAllowed() ? "can rate into their own “" + esc((state.feed.google || {}).guest_playlist_title_pattern || "") + "” playlists" : "get a listen-only site"}). This is a site-wide switch, so it lives in the repo: <a href="https://github.com/chrisrohn/chrisrohn/edit/main/discovery/config.yaml" target="_blank" rel="noopener">edit config.yaml</a> → <code>google.guests: ${guestsAllowed() ? "false" : "true"}</code>. Takes effect at the next daily build (or run the Discover workflow).`;
      } else g.hidden = true;
      const fh = state.feed.feed_health || {};
      const rows = Object.entries(fh).sort((x, y) => (y[1].kept - x[1].kept) || x[0].localeCompare(y[0]));
      $("#s-feeds").innerHTML = rows.length ? rows.map(([n, h]) => `<span class="${h.ok ? (h.kept ? "ok" : "quiet") : "dead"}" title="${esc(h.error || "")}">${esc(n)} ${h.ok ? h.kept + "/" + h.entries : "✗"}</span>`).join("") : "<span class=\"muted\">no blog feed data yet</span>";
      $("#s-skips").checked = skipsInYouTube();
      $("#settings").showModal();
    });
    $("#s-skips").addEventListener("change", e => { state.settings.skipsInYouTube = e.target.checked; persist(); });
    $("#s-export").addEventListener("click", exportCsv);
    $("#s-reload").addEventListener("click", () => loadLibraryPlaylists().then(() => toast("Playlists reloaded")).catch(e => toast(e.message, true)));
    $("#s-clear").addEventListener("click", () => { if (confirm("Clear local state (sign-in, filters, local rating mirror)? Nothing in YouTube is touched.")) { ["id:rated", "id:auth", "id:playlists", "id:filters"].forEach(LS.del); location.reload(); } });
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
