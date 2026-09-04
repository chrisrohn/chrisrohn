/* Indie Discotheque discovery feed — client.
 * Reads data/feed.json (built daily by GitHub Actions) and data/decisions.json (your archive).
 * Thumbs are kept locally until you press "Sync approvals", which sends them to GitHub via
 * repository_dispatch; the workflow files 👍 tracks into "<year> Indie Discotheque" and archives both.
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
  const DEFAULT_REPO = (location.hostname.endsWith("github.io") ? location.hostname.split(".")[0] + "/" + (location.pathname.split("/")[1] || "") : "chrisrohn/chrisrohn").replace(/\/$/, "");

  const state = {
    feed: null,
    archive: {},                   // from data/decisions.json (server-side archive)
    local: LS.get("id:decisions", {}),   // pending decisions {id: {decision, year, videoId, artist, title, decided_at}}
    synced: LS.get("id:synced", {}),     // decisions already sent but maybe not yet rebuilt into feed.json
    settings: Object.assign({ repo: DEFAULT_REPO, token: "", year: null, syncDowns: false }, LS.get("id:settings", {})),
    filters: Object.assign({ q: "", sourcesOff: [], sort: "score", onlyNew: false, onlyPlayable: true, onlyKnown: false }, LS.get("id:filters", {})),
    view: "feed",
    order: [],                     // ids currently rendered
    currentId: null,
    player: null, playerReady: false, pendingVideo: null,
  };

  // A sign-in link (#curator=<token>) from another browser: store the token, then scrub it from the URL/history.
  (() => {
    const m = /[#&]curator=([^&]+)/.exec(location.hash || "");
    if (m) {
      try { state.settings.token = decodeURIComponent(m[1]); LS.set("id:settings", state.settings); } catch {}
      history.replaceState(null, "", location.pathname + location.search);
    }
  })();

  // ---------- data ----------
  async function load() {
    const bust = "?t=" + Math.floor(Date.now() / 60000);
    const [feed, dec] = await Promise.all([
      fetch("data/feed.json" + bust).then(r => r.ok ? r.json() : Promise.reject(new Error("feed.json " + r.status))),
      fetch("data/decisions.json" + bust).then(r => r.ok ? r.json() : { items: {} }).catch(() => ({ items: {} })),
    ]);
    state.feed = feed;
    state.archive = dec.items || {};
    // anything the server has archived no longer needs local bookkeeping
    for (const id of Object.keys(state.synced)) if (state.archive[id]) delete state.synced[id];
    for (const id of Object.keys(state.local)) if (state.archive[id]) delete state.local[id];
    persist();
    if (!state.settings.year) state.settings.year = (feed.years && feed.years[0]) || new Date().getFullYear();
    fillYears();
    fillSources();
    renderMeta();
    applyMode();
    render();
  }

  // Curator mode = a GitHub token is saved in THIS browser. Everyone else gets a read-only listening feed.
  const isCurator = () => !!(state.settings.token && state.settings.token.trim());
  function applyMode() {
    document.body.classList.toggle("curator", isCurator());
    if (!isCurator() && state.view === "queue") { state.view = "feed"; $$(".tab").forEach(x => x.classList.toggle("active", x.dataset.view === "feed")); }
  }

  function persist() {
    LS.set("id:decisions", state.local);
    LS.set("id:synced", state.synced);
    LS.set("id:settings", state.settings);
    LS.set("id:filters", state.filters);
  }

  const items = () => (state.feed && state.feed.items) || [];
  const byId = id => items().find(i => i.id === id);
  const decisionFor = id => state.local[id] || state.synced[id] || state.archive[id] || null;
  const yearOf = it => {
    const d = it.release_date || (it.youtube && it.youtube.year);
    const y = d ? parseInt(String(d).slice(0, 4), 10) : NaN;
    return Number.isFinite(y) ? y : (state.settings.year || new Date().getFullYear());
  };

  // ---------- rendering ----------
  function renderMeta() {
    const f = state.feed;
    const when = f.generated_at ? new Date(f.generated_at) : null;
    const rel = when ? relTime(when) : "?";
    $("#meta").textContent = `${f.count} candidates · ${f.new_today} new today · built ${rel} · profile: ${f.profile?.counts?.direct ?? "?"} artists + ${f.profile?.counts?.similar ?? "?"} similar`;
    $("#lfm").href = "https://www.last.fm/user/" + (f.lastfm_user || "tt_discotheque");
    document.title = `Chris Rohn's New Music · ${f.new_today} new`;
  }
  function relTime(d) {
    const m = Math.round((Date.now() - d.getTime()) / 60000);
    if (m < 60) return m + " min ago";
    const h = Math.round(m / 60);
    if (h < 36) return h + " h ago";
    return Math.round(h / 24) + " d ago";
  }
  function fillYears() {
    const years = (state.feed.years && state.feed.years.length) ? state.feed.years : range(new Date().getFullYear(), 1979);
    const sel = $("#s-year");
    sel.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join("");
    sel.value = state.settings.year;
    state._years = years;
  }
  const SOURCE_LABELS = { listenbrainz: "ListenBrainz", musicbrainz: "MusicBrainz", bandcamp: "Bandcamp", deezer: "Deezer", "deezer-editorial": "Deezer editorial", "deezer-related": "Deezer related", rss: "Blogs & radio", spotify: "Spotify" };
  function fillSources() {
    const box = $("#sources");
    const names = state.feed.sources || [];
    const off = new Set(state.filters.sourcesOff || []);
    box.innerHTML = names.map(s => `<label class="${off.has(s) ? "" : "on"}"><input type="checkbox" value="${esc(s)}" ${off.has(s) ? "" : "checked"}> ${esc(SOURCE_LABELS[s] || s)}</label>`).join("") +
      (names.length > 1 ? `<button class="all" type="button" data-all="1">all</button><button class="all" type="button" data-all="0">none</button>` : "");
    $$("input", box).forEach(cb => cb.addEventListener("change", () => {
      const set = new Set(state.filters.sourcesOff || []);
      cb.checked ? set.delete(cb.value) : set.add(cb.value);
      state.filters.sourcesOff = [...set]; cb.parentElement.classList.toggle("on", cb.checked); persist(); render();
    }));
    $$("button.all", box).forEach(b => b.addEventListener("click", () => { state.filters.sourcesOff = b.dataset.all === "1" ? [] : [...names]; persist(); fillSources(); render(); }));
  }
  const range = (a, b) => { const r = []; for (let y = a; y >= b; y--) r.push(y); return r; };

  function visibleItems() {
    const f = state.filters;
    const q = f.q.trim().toLowerCase();
    let list;
    if (state.view === "feed") {
      list = items().filter(i => !decisionFor(i.id));
    } else if (state.view === "queue") {
      list = Object.keys(state.local).map(id => byId(id) || fromDecision(id, state.local[id]));
    } else {
      const ids = new Set([...Object.keys(state.synced), ...Object.keys(state.archive)]);
      list = [...ids].map(id => byId(id) || fromDecision(id, state.synced[id] || state.archive[id]));
      if (!isCurator()) list = list.filter(i => (decisionFor(i.id) || {}).decision === "up");
      list.sort((a, b) => String(decisionFor(b.id)?.decided_at || "").localeCompare(String(decisionFor(a.id)?.decided_at || "")));
      return list.filter(i => !q || hay(i).includes(q));
    }
    list = list.filter(i => {
      if (q && !hay(i).includes(q)) return false;
      if (f.sourcesOff && f.sourcesOff.length && !(i.sources || []).some(s => !f.sourcesOff.includes(s.split(":")[0]))) return false;
      if (state.view === "feed") {
        if (f.onlyNew && i.first_seen !== state.feed.generated_at?.slice(0, 10)) return false;
        if (f.onlyPlayable && !(i.youtube && i.youtube.videoId)) return false;
        if (f.onlyKnown && !i.match_kind) return false;
      }
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
  const hay = i => [i.artist, i.title, i.release, ...(i.tags || []), ...(i.reasons || [])].join(" ").toLowerCase();
  const fromDecision = (id, d) => ({ id, artist: d.artist || "?", title: d.title || "?", sources: [], tags: [], reasons: [], score: 0, youtube: d.videoId ? { videoId: d.videoId } : null, release_date: d.year ? String(d.year) : null, _ghost: true });

  function render() {
    const list = $("#list");
    const vis = visibleItems();
    state.order = vis.map(i => i.id);
    list.innerHTML = "";
    const tpl = $("#card-tpl");
    const frag = document.createDocumentFragment();
    for (const it of vis) frag.appendChild(card(it, tpl));
    list.appendChild(frag);
    const empty = $("#empty");
    empty.hidden = vis.length > 0;
    empty.textContent = state.view === "feed" ? (isCurator() ? "Nothing left to rate with these filters. Come back after tomorrow's build, or loosen the filters." : "Nothing matches these filters.") : state.view === "queue" ? "No unsynced thumbs. Rate something in the feed." : "No picks yet.";
    $("#count-feed").textContent = items().filter(i => !decisionFor(i.id)).length;
    $("#count-queue").textContent = Object.keys(state.local).length;
    $("#count-archive").textContent = Object.keys(state.archive).length + Object.keys(state.synced).length;
    applyMode();
    const ups = Object.values(state.local).filter(d => d.decision === "up").length;
    const downs = Object.values(state.local).filter(d => d.decision === "down").length;
    const sync = $("#sync");
    sync.disabled = !(ups || downs);
    sync.textContent = ups || downs ? `Sync ${ups} 👍${downs ? ` · ${downs} 👎` : ""}` : "Sync approvals";
    $("#filters").style.display = state.view === "feed" ? "" : "";
  }

  function card(it, tpl) {
    const el = tpl.content.firstElementChild.cloneNode(true);
    el.dataset.id = it.id;
    const d = decisionFor(it.id);
    const yt = it.youtube || {};
    const art = $(".art", el);
    const img = $("img", art);
    if (it.artwork || yt.thumbnail) img.src = it.artwork || yt.thumbnail; else img.remove();
    if (!yt.videoId) art.classList.add("unplayable");
    if (it.first_seen && it.first_seen === state.feed.generated_at?.slice(0, 10) && !it._ghost) el.classList.add("new");
    $(".artist", el).textContent = it.artist;
    const m = $(".match", el);
    if (it.match_kind) { m.textContent = it.match_kind === "direct" ? "you play " + (it.matched_artist === it.artist ? "them" : it.matched_artist) : "similar to " + (it.reasons.find(r => r.startsWith("similar to ")) || "").slice(11); m.classList.add(it.match_kind); } else m.remove();
    $(".title", el).textContent = it.title;
    $(".release", el).textContent = [it.release_type, it.release && it.release !== it.title ? it.release : null].filter(Boolean).join(" · ");
    $(".date", el).textContent = it.release_date || "";
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
    ysel.innerHTML = state._years.map(y => `<option value="${y}">${y}</option>`).join("");
    ysel.value = d?.year || yearOf(it);
    ysel.addEventListener("change", () => { if (state.local[it.id]) { state.local[it.id].year = +ysel.value; persist(); } });
    if (d) {
      el.classList.add(d.decision === "up" ? "rated-up" : "rated-down");
      if (d.filed_at || d.synced) el.classList.add("filed");
      const st = document.createElement("div");
      st.className = "status";
      st.textContent = d.decision === "up" ? (d.filed_at ? `filed → ${d.year}` : d.synced ? "syncing…" : `👍 → ${d.year} (unsynced)`) : (state.archive[it.id] ? "archived 👎" : "👎 (unsynced)");
      $(".side", el).appendChild(st);
      if (!state.local[it.id]) { $(".undo", el).remove(); ysel.disabled = true; }
    }
    $(".btn.up", el).addEventListener("click", e => { e.stopPropagation(); rate(it.id, "up", +ysel.value); });
    $(".btn.down", el).addEventListener("click", e => { e.stopPropagation(); rate(it.id, "down", +ysel.value); });
    const undo = $(".undo", el); if (undo) undo.addEventListener("click", e => { e.stopPropagation(); unrate(it.id); });
    art.addEventListener("click", () => { if (yt.videoId) play(it.id); });
    el.addEventListener("dblclick", () => { if (yt.videoId) play(it.id); });
    el.addEventListener("focus", () => { state.currentId = it.id; $$(".card.current").forEach(c => c.classList.remove("current")); el.classList.add("current"); });
    return el;
  }
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- decisions ----------
  function rate(id, decision, year) {
    if (!isCurator()) return;
    const it = byId(id) || fromDecision(id, decisionFor(id) || {});
    state.local[id] = { decision, year: year || yearOf(it), videoId: it.youtube?.videoId || null, artist: it.artist, title: it.title, decided_at: new Date().toISOString() };
    delete state.synced[id];
    persist();
    toast(decision === "up" ? `👍 ${it.artist} – ${it.title} → ${state.local[id].year}` : `👎 ${it.artist} – ${it.title}`);
    const wasCurrent = state.currentId === id;
    const idx = state.order.indexOf(id);
    render();
    if (state.view === "feed") {
      const next = state.order[idx] || state.order[idx - 1];
      if (next) { focusCard(next); if (wasCurrent && $("#autoplay").checked && byId(next)?.youtube?.videoId) play(next); }
      else if (wasCurrent) stopPlayer();
    }
  }
  function unrate(id) { delete state.local[id]; persist(); render(); }
  function focusCard(id) { const el = $(`.card[data-id="${CSS.escape(id)}"]`); if (el) { el.focus({ preventScroll: false }); el.scrollIntoView({ block: "center", behavior: "smooth" }); } }

  // ---------- player ----------
  window.onYouTubeIframeAPIReady = () => {
    state.player = new YT.Player("yt", {
      width: "220", height: "124", videoId: state.pendingVideo || undefined,
      playerVars: { autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1, origin: location.origin },
      events: {
        onReady: () => { state.playerReady = true; if (state.pendingVideo) { state.player.loadVideoById(state.pendingVideo); state.pendingVideo = null; } },
        onStateChange: e => { if (e.data === YT.PlayerState.ENDED && $("#autoplay").checked) nextTrack(); },
        onError: () => { toast("Can't embed this one – opening YouTube Music", true); const it = byId(state.currentId); if (it?.youtube?.videoId) window.open("https://music.youtube.com/watch?v=" + it.youtube.videoId, "_blank"); },
      },
    });
  };
  function ensureApi() { if (window.YT && window.YT.Player) return; if ($("#yt-api")) return; const s = document.createElement("script"); s.id = "yt-api"; s.src = "https://www.youtube.com/iframe_api"; document.head.appendChild(s); }
  function play(id) {
    const it = byId(id) || fromDecision(id, decisionFor(id) || {});
    const vid = it.youtube?.videoId; if (!vid) return;
    state.currentId = id;
    $$(".card.current").forEach(c => c.classList.remove("current"));
    const el = $(`.card[data-id="${CSS.escape(id)}"]`); if (el) el.classList.add("current");
    $("#player").hidden = false;
    $("#now").innerHTML = `<b>${esc(it.artist)}</b> – ${esc(it.title)} ${it.release ? `<span class="muted">· ${esc(it.release)}</span>` : ""}`;
    ensureApi();
    if (state.playerReady) state.player.loadVideoById(vid); else state.pendingVideo = vid;
  }
  function stopPlayer() { if (state.playerReady) state.player.stopVideo(); $("#player").hidden = true; state.currentId = null; }
  function step(delta) {
    const i = state.order.indexOf(state.currentId);
    let j = i < 0 ? 0 : i + delta;
    while (j >= 0 && j < state.order.length) {
      const it = byId(state.order[j]);
      if (it?.youtube?.videoId) { play(state.order[j]); focusCard(state.order[j]); return; }
      j += delta;
    }
  }
  const nextTrack = () => step(1);
  const prevTrack = () => step(-1);
  function toggle() { if (!state.playerReady) return; const s = state.player.getPlayerState(); if (s === YT.PlayerState.PLAYING) state.player.pauseVideo(); else state.player.playVideo(); }

  // ---------- sync ----------
  async function syncDecisions() {
    const pending = Object.entries(state.local).map(([id, d]) => ({ id, ...d }));
    if (!pending.length) return;
    const ups = pending.filter(d => d.decision === "up");
    const downs = pending.filter(d => d.decision === "down");
    const body = $("#confirm-body");
    const byYear = {};
    for (const u of ups) (byYear[u.year] ||= []).push(u);
    body.innerHTML = `<p class="muted">${ups.length} track(s) will be added to your YouTube Music year playlists and ${downs.length} thumbs-down archived. Nothing else is touched.</p>` +
      `<div class="confirm-list">` + Object.keys(byYear).sort((a, b) => b - a).map(y => `<h4>${y} Indie Discotheque</h4>` + byYear[y].map(u => `<div><span>👍</span><span>${esc(u.artist)} – ${esc(u.title)}</span>${u.videoId ? "" : '<span class="muted">(no YouTube match – will be skipped)</span>'}</div>`).join("")).join("") +
      (downs.length ? `<h4>Archive 👎</h4>` + downs.map(u => `<div><span>👎</span><span>${esc(u.artist)} – ${esc(u.title)}</span></div>`).join("") : "") + `</div>` +
      (state.settings.token ? "" : `<p class="muted">No GitHub token set – open ⚙ Settings, or export the queue as CSV instead.</p>`);
    const dlg = $("#confirm");
    $("#confirm-ok").disabled = !state.settings.token;
    dlg.returnValue = "";
    dlg.showModal();
    await new Promise(r => dlg.addEventListener("close", r, { once: true }));
    if (dlg.returnValue !== "ok") return;
    const repo = state.settings.repo || DEFAULT_REPO;
    const chunks = [];
    for (let i = 0; i < pending.length; i += 150) chunks.push(pending.slice(i, i + 150));
    try {
      for (const chunk of chunks) {
        const r = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
          method: "POST",
          headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + state.settings.token, "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
          body: JSON.stringify({ event_type: "decisions", client_payload: { decisions: chunk, sent_at: new Date().toISOString() } }),
        });
        if (r.status !== 204) throw new Error(`GitHub said ${r.status}: ${(await r.text()).slice(0, 200)}`);
      }
      for (const d of pending) { state.synced[d.id] = { ...d, synced: true }; delete state.local[d.id]; }
      persist(); render();
      toast(`Sent ${pending.length} decision(s). GitHub is filing them now; the feed refreshes within a few minutes.`);
    } catch (e) {
      toast("Sync failed: " + e.message, true);
    }
  }

  function exportCsv() {
    const rows = [["Title", "Artist", "Album", "Year", "YouTube"], ...Object.values(state.local).filter(d => d.decision === "up").map(d => [d.title, d.artist, "", d.year, d.videoId ? "https://music.youtube.com/watch?v=" + d.videoId : ""])];
    const csv = rows.map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `indie-discotheque-approvals-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  let toastTimer;
  function toast(msg, err = false) {
    let t = $(".toast"); if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
    t.textContent = msg; t.classList.toggle("err", err); t.style.display = "";
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.display = "none"; }, err ? 6000 : 2600);
  }

  // ---------- wiring ----------
  function wire() {
    $$(".tab").forEach(b => b.addEventListener("click", () => { state.view = b.dataset.view; $$(".tab").forEach(x => x.classList.toggle("active", x === b)); render(); }));
    const f = state.filters;
    $("#q").value = f.q; $("#sort").value = f.sort; $("#only-new").checked = f.onlyNew; $("#only-playable").checked = f.onlyPlayable; $("#only-known").checked = f.onlyKnown;
    $("#q").addEventListener("input", e => { f.q = e.target.value; persist(); render(); });
    $("#sort").addEventListener("change", e => { f.sort = e.target.value; persist(); render(); });
    $("#only-new").addEventListener("change", e => { f.onlyNew = e.target.checked; persist(); render(); });
    $("#only-playable").addEventListener("change", e => { f.onlyPlayable = e.target.checked; persist(); render(); });
    $("#only-known").addEventListener("change", e => { f.onlyKnown = e.target.checked; persist(); render(); });
    $("#sync").addEventListener("click", syncDecisions);
    $("#p-next").addEventListener("click", nextTrack); $("#p-prev").addEventListener("click", prevTrack); $("#p-toggle").addEventListener("click", toggle);
    $("#p-up").addEventListener("click", () => state.currentId && rate(state.currentId, "up", currentYear()));
    $("#p-down").addEventListener("click", () => state.currentId && rate(state.currentId, "down", currentYear()));
    const s = state.settings;
    $("#s-repo").value = s.repo; $("#s-token").value = s.token; $("#s-hide-downs").checked = s.syncDowns;
    $("#settings-btn").addEventListener("click", () => $("#settings").showModal());
    $("#settings").addEventListener("close", () => { s.repo = $("#s-repo").value.trim() || DEFAULT_REPO; s.token = $("#s-token").value.trim(); s.year = +$("#s-year").value; s.syncDowns = $("#s-hide-downs").checked; persist(); applyMode(); render(); });
    $("#s-export").addEventListener("click", exportCsv);
    $("#s-link").addEventListener("click", async () => {
      const tok = ($("#s-token").value || state.settings.token || "").trim();
      if (!tok) { toast("Save a token first", true); return; }
      const url = location.origin + location.pathname + "#curator=" + encodeURIComponent(tok);
      try { await navigator.clipboard.writeText(url); toast("Sign-in link copied. Open it once in the other browser; it stores the token and removes it from the address bar."); }
      catch { prompt("Copy this link and open it in the other browser:", url); }
    });
    $("#s-clear").addEventListener("click", () => { if (confirm("Clear unsynced thumbs and local settings?")) { ["id:decisions", "id:synced", "id:settings", "id:filters"].forEach(LS.del); location.reload(); } });
    document.addEventListener("keydown", e => {
      if (e.target.matches("input, select, textarea") || $("dialog[open]")) return;
      const id = state.currentId || state.order[0];
      switch (e.key) {
        case "j": case "ArrowDown": e.preventDefault(); state.currentId ? step(1) : focusCard(state.order[0]); break;
        case "k": case "ArrowUp": e.preventDefault(); step(-1); break;
        case " ": e.preventDefault(); if (state.playerReady && state.currentId) toggle(); else if (id) play(id); break;
        case "u": case "ArrowRight": if (id) rate(id, "up", currentYear(id)); break;
        case "d": case "ArrowLeft": if (id) rate(id, "down", currentYear(id)); break;
        case "o": { const it = byId(id); if (it?.youtube?.videoId) window.open("https://music.youtube.com/watch?v=" + it.youtube.videoId, "_blank"); break; }
        case "/": e.preventDefault(); $("#q").focus(); break;
        case "Escape": stopPlayer(); break;
      }
    });
  }
  function currentYear(id = state.currentId) { const el = id && $(`.card[data-id="${CSS.escape(id)}"] .year`); return el ? +el.value : undefined; }

  wire();
  load().catch(e => { $("#meta").textContent = "Feed not built yet — run the Discover workflow once. (" + e.message + ")"; $("#empty").hidden = false; $("#empty").textContent = "No feed yet."; });
})();
