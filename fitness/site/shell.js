"use strict";
// The app shell: where the dashboard's data comes from, syncing it, installing the app, working offline, and the theme.
//
// Data, in order: inlined by `python -m fitness build` (a computer) → a phone link's #d=… (deflated JSON in the
// fragment, which browsers never send to a server) → your private GitHub repository, where the scheduled sync
// (.github/workflows/fitness-sync.yml) leaves fitness-data.json → the copy this device saved last time → nothing yet,
// which shows the welcome screen. The hosted page holds no one's data: it reaches the repository with a token kept in
// this device's storage (the only place the page's CSP lets it talk to is api.github.com), and whatever arrives is
// kept only here. It also hands ride mode its zones and sessions (same origin).
(() => {
  const $ = id => document.getElementById(id);
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); return true; } catch { return false; } },
  };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const standalone = () => matchMedia("(display-mode: standalone)").matches || /** @type {any} */ (navigator).standalone === true;
  const sleep = ms => new Promise(res => setTimeout(res, ms));
  const when = iso => new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  // ── offline ─────────────────────────────────────────────────────────────────────────────────────────────
  if ("serviceWorker" in navigator && window.isSecureContext && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => { /* still works online */ });
  }

  // ── install ─────────────────────────────────────────────────────────────────────────────────────────────
  let deferred = null;
  const installBtn = $("install");
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferred = e; if (installBtn) installBtn.hidden = standalone(); });
  window.addEventListener("appinstalled", () => { deferred = null; if (installBtn) installBtn.hidden = true; });
  if (installBtn) installBtn.addEventListener("click", async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice.catch(() => null);
    deferred = null; installBtn.hidden = true;
  });

  // ── theme: follows the device until a button is pressed, then that choice sticks (shared with ride mode) ──
  const themeBtns = [...document.querySelectorAll("[data-theme-pick]")], deviceDark = matchMedia("(prefers-color-scheme: dark)");
  const effective = () => document.documentElement.dataset.theme || (deviceDark.matches ? "dark" : "light");
  const paintTheme = () => themeBtns.forEach(b => b.setAttribute("aria-pressed", String(b.dataset.themePick === effective())));
  for (const b of themeBtns) b.addEventListener("click", () => { document.documentElement.dataset.theme = b.dataset.themePick; ls.set("fitness-theme", b.dataset.themePick); paintTheme(); });
  deviceDark.addEventListener("change", paintTheme);
  paintTheme();

  // ── data ────────────────────────────────────────────────────────────────────────────────────────────────
  const bytes = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  const inflate = async s => new Response(new Blob([bytes(s)]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
  const valid = d => !!d && typeof d === "object" && typeof d.today === "string" && !!d.now && Array.isArray(d.pmc);
  /** Make arriving data safe and phone-shaped: no QR or links baked for another host; ride mode reads this device's copy. */
  const adopt = d => ({ ...d, ride_qr: null, phone_href: null, ride_href: "ride.html" });
  function keep(d) {
    if (!ls.set("fitness-dashboard", JSON.stringify(d))) throw new Error("This browser won't store data (private mode?)");
    if (d.ride) ls.set("fitness-ride-config", JSON.stringify(d.ride));
  }
  /** Text from a pasted link, a pasted blob, or a data file → dashboard data. */
  async function parse(text) {
    const t = String(text || "").trim();
    if (t.startsWith("{")) return JSON.parse(t);
    const m = t.match(/[#&?]d=([A-Za-z0-9_-]+)/) || t.match(/^([A-Za-z0-9_-]{200,})$/);
    if (!m) throw new Error("That isn't a phone link or a data file from the dashboard");
    return JSON.parse(await inflate(m[1]));
  }

  // ── GitHub sync: your private repository's `state` branch, and its "Training sync" workflow ─────────────────
  const WORKFLOW = "training.yml", RAW = "application/vnd.github.raw+json";
  const TOKEN_URL = "https://github.com/settings/personal-access-tokens/new?" + new URLSearchParams({
    name: "Training app", description: "chrisrohn.com/fitness reads the sync's data and starts its runs", expires_in: "none", actions: "write", contents: "read" });
  /** @returns {{repo: string, token: string, branch?: string} | null} */
  const cloud = () => { try { const c = JSON.parse(ls.get("fitness-cloud") || "null"); return c && c.repo && c.token ? c : null; } catch { return null; } };
  let status = null, cloudProblem = "";

  const ghWhy = (code, what) => code === 401 ? "GitHub didn't accept the token: it's mistyped, expired or revoked."
    : code === 403 ? `The token isn't allowed to ${what}: give it Actions “Read and write” and Contents “Read-only” on the repository.`
    : code === 404 ? "GitHub can't find that repository with this token (check the name, and the token's repository access)."
    : code === 422 ? "GitHub refused to start the sync: is the workflow file at .github/workflows/training.yml on the default branch?"
    : `GitHub answered ${code}.`;
  /** GitHub's REST API for the sync repository, with this device's token. */
  async function gh(c, path, { method = "GET", body, accept = "application/vnd.github+json", what = "read it", allow404 = false } = {}) {
    let res;
    try {
      res = await fetch(`https://api.github.com/repos/${c.repo}${path}`, {
        method, cache: "no-store", body: body && JSON.stringify(body),
        headers: { Authorization: `Bearer ${c.token}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
      });
    } catch { throw new Error("Couldn't reach GitHub: no signal?"); }
    if (res.status === 404 && allow404) return null;
    if (!res.ok) throw new Error(ghWhy(res.status, what));
    return res.status === 204 ? null : accept === RAW ? res.text() : res.json();
  }
  const stateFile = async (c, name) => { const t = await gh(c, `/contents/${name}?ref=state`, { accept: RAW, allow404: true }); return t ? JSON.parse(t) : null; };
  /** The sync's latest status and data. */
  async function pull(c) {
    const [st, d] = await Promise.all([stateFile(c, "status.json"), stateFile(c, "fitness-data.json")]);
    status = st;
    return valid(d) ? adopt(d) : null;
  }
  const timeout = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error("GitHub is slow to answer: showing this device's copy"); })]);
  const problems = st => !st ? [] : [st.garmin && st.garmin.error && `Garmin: ${st.garmin.error}`, st.strava && st.strava.error && `Strava: ${st.strava.error}`, st.error && `Build: ${st.error}`].filter(Boolean);

  async function load() {
    const raw = ($("data") || { textContent: "" }).textContent.trim();
    if (raw.startsWith("{")) return { D: JSON.parse(raw), source: "build" };
    const frag = new URLSearchParams(location.hash.slice(1)).get("d");
    if (frag) {
      history.replaceState(null, "", location.pathname + location.search);
      try {
        const d = adopt(await parse("#d=" + frag));
        if (valid(d)) { keep(d); return { D: d, source: "link" }; }
      } catch (e) { cloudProblem = `That link couldn't be read: ${e.message}`; }
    }
    let saved = null;
    try { saved = JSON.parse(ls.get("fitness-dashboard") || "null"); } catch { /* none */ }
    const c = cloud();
    if (c) {
      try {
        const d = await timeout(pull(c), saved ? 8000 : 20000);
        if (d) { keep(d); return { D: d, source: "cloud" }; }
      } catch (e) { cloudProblem = e.message; }
    }
    if (valid(saved)) return { D: saved, source: c ? "cloud" : "saved" };
    return null;
  }

  // ── running the sync from the phone: dispatch the workflow, follow the run, then load what it wrote ─────────
  let busy = false;
  const bar = () => $("databar");
  function barHTML(html, cls = "") { const b = bar(); if (!b) return; b.hidden = false; b.innerHTML = `<div class="databar-in ${cls}">${html}</div>`; }
  function say(text) { const t = $("job-text"); if (t) t.textContent = text; else barHTML(`<span id="job-text" role="status">${esc(text)}</span>`); }

  /** Start the sync repository's workflow with `action`, follow the run, then reload with what it wrote. */
  async function job(action, label, { code = "", askCode = false } = {}) {
    const c = cloud();
    if (!c || busy) return;
    busy = true;
    const since = Date.now() - 60_000;   // the phone's clock and GitHub's can differ a little
    barHTML(`<span id="job-text" role="status">${esc(label)}…</span>${askCode ? `<label for="garmin-code" class="sr">Code from Garmin's email</label>
      <input id="garmin-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" placeholder="Code" maxlength="10">
      <button type="button" class="chip" data-action="send-code">Send code</button>` : ""}<a class="chip" id="job-run" href="https://github.com/${esc(c.repo)}/actions" target="_blank" rel="noopener">View run</a>`);
    try {
      await gh(c, `/actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", body: { ref: c.branch || "main", inputs: { action, code } }, what: "start the sync" });
      let run = null;
      for (let i = 0; i < 200; i++) {       // ~16 minutes: the first sync backfills a year of Garmin days
        await sleep(i < 3 ? 2500 : 5000);
        const runs = await gh(c, `/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=10`, { what: "see the sync's runs" });
        run = (runs.workflow_runs || []).find(r => r.display_title === action && Date.parse(r.created_at) >= since) || null;
        if (run) { const a = $("job-run"); if (a) a.setAttribute("href", run.html_url); }
        if (run && run.status === "completed") break;
        say(`${label}${run ? (run.status === "queued" ? " · waiting for a runner" : " · running") : " · starting"}…${i > 24 ? " (the first sync takes up to 15 minutes; you can close the app)" : ""}`);
      }
      if (!run || run.status !== "completed") throw new Error("Still running: it carries on in GitHub, and the app picks it up next time you open it.");
      const d = await pull(c);
      if (d) keep(d);
      const why = problems(status);
      if (run.conclusion !== "success" || why.length) throw new Error(why.join(" · ") || `The run ended: ${run.conclusion}.`);
      location.reload();
    } catch (e) {
      busy = false;
      barHTML(`<span class="bad" role="alert">${esc(e.message || String(e))}</span><button type="button" class="chip" data-action="settings">Settings</button>${$("app").querySelector(".welcome") ? "" : `<button type="button" class="chip" data-action="reload">Back</button>`}`);
    }
  }
  async function sendCode() {
    const c = cloud(), input = /** @type {HTMLInputElement | null} */ ($("garmin-code"));
    const code = input ? input.value.replace(/\D/g, "") : "";
    if (!c || code.length < 4) { if (input) input.focus(); return; }
    try {
      await gh(c, `/actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", body: { ref: c.branch || "main", inputs: { action: "garmin-code", code } }, what: "send the code" });
      if (input) { input.value = ""; input.placeholder = "Sent"; }
      say("Code sent: signing in to Garmin…");
    } catch (e) { say(e.message); }
  }
  /** Strava's authorize page; it comes back to this page with ?code=…&state=strava. */
  function connectStrava() {
    const id = status && status.strava && status.strava.client_id;
    if (!id) { barHTML(`<span class="bad" role="alert">Add the STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET secrets to the repository, then Sync now.</span>`); return; }
    location.assign("https://www.strava.com/oauth/authorize?" + new URLSearchParams({
      client_id: String(id), response_type: "code", redirect_uri: location.origin + location.pathname, approval_prompt: "auto",
      scope: "read,activity:read_all", state: "strava" }));
  }
  /** Back from Strava's authorize page: hand the one-time code to a connect-strava run. */
  function stravaReturn() {
    const q = new URLSearchParams(location.search);
    if (q.get("state") !== "strava" || !(q.has("code") || q.has("error"))) return null;
    history.replaceState(null, "", location.pathname + location.hash);
    if (q.has("error")) return "Strava wasn't connected (you pressed Cancel).";
    if (!(q.get("scope") || "").includes("activity:read_all")) return "Strava needs “View data about your private activities” ticked: Connect Strava again and leave it on.";
    return { code: q.get("code") || "" };
  }

  // ── the data sheet: GitHub sync settings, and importing by hand (a phone link or a data file) ───────────────
  const dlg = /** @type {HTMLDialogElement | null} */ ($("import"));
  function openSheet() {
    if (!dlg) return;
    const c = cloud();
    $("import-error").textContent = $("cloud-error").textContent = "";
    /** @type {HTMLTextAreaElement} */ ($("import-text")).value = "";
    /** @type {HTMLInputElement} */ ($("cloud-repo")).value = c ? c.repo : "";
    /** @type {HTMLInputElement} */ ($("cloud-token")).value = c ? c.token : "";
    $("cloud-forget").hidden = !c;
    $("cloud-new-token").setAttribute("href", TOKEN_URL);
    dlg.showModal();
  }
  async function take(text) {
    try {
      const d = adopt(await parse(text));
      if (!valid(d)) throw new Error("The data is incomplete");
      keep(d);
      location.reload();
    } catch (e) { $("import-error").textContent = e.message || String(e); }
  }
  async function saveCloud() {
    const repo = /** @type {HTMLInputElement} */ ($("cloud-repo")).value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/+$/, "");
    const token = /** @type {HTMLInputElement} */ ($("cloud-token")).value.trim();
    const err = $("cloud-error");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { err.textContent = "The repository is owner/name, e.g. you/training-data."; return; }
    if (!token) { err.textContent = "Paste the token."; return; }
    err.textContent = "Checking…";
    try {
      const info = await gh({ repo, token }, "", { what: "see the repository" });
      if (!info.private) throw new Error("That repository is public: your health data must only go to a private one.");
      if (!ls.set("fitness-cloud", JSON.stringify({ repo, token, branch: info.default_branch || "main" }))) throw new Error("This browser won't store the token (private mode?)");
      location.reload();
    } catch (e) { err.textContent = e.message; }
  }
  if (dlg) {
    $("import-go").addEventListener("click", e => { e.preventDefault(); take(/** @type {HTMLTextAreaElement} */ ($("import-text")).value); });
    $("import-paste").addEventListener("click", async e => {
      e.preventDefault();
      try { const t = await navigator.clipboard.readText(); /** @type {HTMLTextAreaElement} */ ($("import-text")).value = t; take(t); }
      catch { $("import-error").textContent = "This browser didn't allow reading the clipboard: long-press the box and Paste."; }
    });
    $("import-file").addEventListener("change", async () => {
      const f = /** @type {HTMLInputElement} */ ($("import-file")).files[0];
      if (f) take(await f.text());
    });
    $("cloud-save").addEventListener("click", saveCloud);
    $("cloud-forget").addEventListener("click", () => { ls.set("fitness-cloud", null); location.reload(); });
  }
  document.addEventListener("click", e => {
    const t = e.target instanceof Element ? e.target.closest("[data-action]") : null;
    if (!t) return;
    const act = /** @type {HTMLElement} */ (t).dataset.action;
    if (act === "import" || act === "settings") { e.preventDefault(); openSheet(); }
    if (act === "sync") job("sync", "Syncing Garmin and Strava");
    if (act === "connect-garmin") job("connect-garmin", "Signing in to Garmin. If Garmin emails you a code, enter it here", { askCode: true });
    if (act === "connect-strava") connectStrava();
    if (act === "send-code") sendCode();
    if (act === "reload") location.reload();
    if (act === "forget") {
      e.preventDefault();
      if (confirm("Remove the dashboard data from this device?")) { ls.set("fitness-dashboard", null); ls.set("fitness-ride-config", null); location.reload(); }
    }
  });
  document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target instanceof HTMLElement && e.target.id === "garmin-code") { e.preventDefault(); sendCode(); } });

  // the line under the masthead: how fresh this device's copy is, what needs doing, and the buttons that do it
  function connectButtons() {
    if (!status) return "";
    return (status.garmin && !status.garmin.connected ? `<button type="button" class="chip" data-action="connect-garmin">Connect Garmin</button>` : "")
      // Strava is optional (its API needs a paid subscription): offered only once its app's secrets are in the repository
      + (status.strava && status.strava.client_id && !status.strava.connected ? `<button type="button" class="chip" data-action="connect-strava">Connect Strava</button>` : "");
  }
  function databar(D, source) {
    if (!bar() || source === "build") return;
    const hours = (Date.now() - new Date(D.generated).getTime()) / 36e5;
    const stale = hours > 36 ? ` · ${Math.floor(hours / 24)} days old` : "";
    const issues = [cloudProblem, ...problems(status)].filter(Boolean);
    if (cloud()) {
      const synced = status && status.synced ? `Synced <b>${esc(when(status.synced))}</b>` : `Data from <b>${esc(when(D.generated))}</b>`;
      barHTML(`<span>${synced}${stale}</span>${issues.map(i => `<span class="bad">${esc(i)}</span>`).join("")}
        ${connectButtons()}<button type="button" class="chip" data-action="sync">Sync now</button><button type="button" class="chip" data-action="settings">Settings</button>`, stale ? "stale" : "");
    } else {
      barHTML(`<span>Data from <b>${esc(when(D.generated))}</b>${stale}</span>${issues.map(i => `<span class="bad">${esc(i)}</span>`).join("")}
        <button type="button" class="chip" data-action="settings">Update data</button>`, stale ? "stale" : "");
    }
  }

  function welcome() {
    const nav = document.querySelector(".bar nav");
    if (nav) nav.hidden = true;
    const seg = $("units-seg");
    if (seg) seg.hidden = true;
    const c = cloud();
    const g = status && status.garmin, s = status && status.strava;
    const item = (done, text, bad = "") => `<li class="${bad ? "bad" : done ? "done" : ""}">${text}${bad ? `: ${esc(bad)}` : ""}</li>`;
    const setup = c ? `<h3>Syncing from ${esc(c.repo)}</h3>
          <ul class="state mt-2">
            ${item(!!status, status ? `Sync has run (last ${esc(when(status.synced))})` : "Sync hasn't run yet", cloudProblem)}
            ${item(!!(g && g.connected), g && g.connected ? `Garmin connected · ${g.days} days` : "Garmin not connected", g && g.error)}
            ${s && (s.connected || s.client_id) ? item(!!s.connected, s.connected ? `Strava connected · ${s.activities} activities` : "Strava not connected", s.error) : ""}
            ${s && s.export ? item(true, `Strava history imported · ${s.export.rows} activities from ${esc(s.export.file)}`) : s && s.error && !s.client_id ? item(false, "Strava export", s.error) : ""}
          </ul>
          <p class="connect mt-4">${connectButtons()}<button type="button" class="chip big-chip" data-action="sync">Sync now</button><button type="button" class="chip big-chip" data-action="settings">Settings</button></p>
          <p class="sub mt-4">Connect Garmin first: the first sync brings in a year of days and rides, and takes up to 15 minutes. After that it runs on its own through the day, and whenever you open the app. Zwift and MyWoosh rides arrive through Garmin Connect once you link them there.</p>`
      : `<h3>Sync from GitHub</h3>
          <ol>
            <li>A private repository runs the sync: <a href="https://github.com/chrisrohn/chrisrohn/blob/main/fitness/README.md#cloud-sync-no-computer" target="_blank" rel="noopener">set it up</a> (about 10 minutes, all on the phone).</li>
            <li><a href="${esc(TOKEN_URL)}" target="_blank" rel="noopener">Create a token</a> for <i>only</i> that repository, with <b>Actions: Read and write</b> and <b>Contents: Read-only</b>.</li>
            <li>Tap <b>Connect GitHub</b> and paste the repository's name and the token.</li>
          </ol>
          <p class="connect mt-3"><button type="button" class="chip big-chip" data-action="settings">Connect GitHub</button> <a class="chip big-chip" href="ride.html">Open ride mode</a></p>
          <p class="sub mt-4">Your data stays in your private repository and on this device; this site never sees it.</p>`;
    $("app").innerHTML = `<section class="card welcome" id="today">
      <div class="head"><h2>Training &amp; Recovery</h2><p class="sub">Your call for the day, readiness, sleep, the season plan to race day, and ride mode on the bars.</p></div>
      <div class="grid">
        <div class="steps">${setup}</div>
        <div class="steps">
          <h3>Install the app</h3>
          ${standalone() ? `<p>Installed. Open it from your home screen; it works offline.</p>`
            : /iP(hone|ad|od)/.test(navigator.userAgent) ? `<p>In Safari, tap <b>Share</b>, then <b>Add to Home Screen</b>. It opens full screen and works offline.</p>`
            : `<p>Use <b>Install</b> in the top bar, or your browser's menu → <b>Install app</b>. It opens full screen and works offline.</p>`}
          <p class="sub mt-3">Have a phone link or data file instead? <button type="button" class="chip" data-action="import">Import by hand</button></p>
        </div>
      </div>
    </section>`;
  }

  // a phone link opened while the app is already showing is only a #hash change: start over and take it
  window.addEventListener("hashchange", () => { if (/^#(.*&)?d=/.test(location.hash)) location.reload(); });

  // wake up, open the app, get the day's call: when the last sync is older than FRESH_MS, opening the app (or coming
  // back to it) starts one, and the page reloads with last night's numbers when it lands (about two minutes). At most
  // one every AUTO_GAP_MS, and only once Garmin is connected; the scheduled runs keep it fresh in between.
  const FRESH_MS = 45 * 60_000, AUTO_GAP_MS = 20 * 60_000;
  function autoSync(st) {
    if (!cloud() || busy || !st || !st.synced || !(st.garmin && st.garmin.connected) || !navigator.onLine) return;
    if (Date.now() - Date.parse(st.synced) < FRESH_MS || Date.now() - Number(ls.get("fitness-autosync") || 0) < AUTO_GAP_MS) return;
    ls.set("fitness-autosync", String(Date.now()));
    job("sync", "Bringing in the latest from Garmin");
  }

  // back in the app after a while: pick up the newest sync without a reload of the whole page by hand
  let shown = "";
  document.addEventListener("visibilitychange", async () => {
    const c = cloud();
    if (document.visibilityState !== "visible" || !c || busy || !shown) return;
    try {
      const st = await stateFile(c, "status.json");
      if (st && st.synced && st.synced !== (status && status.synced)) location.reload();
      else autoSync(st);
    } catch { /* offline: keep what's showing */ }
  });

  window.addEventListener("DOMContentLoaded", async () => {
    const strava = stravaReturn();
    const got = await load();
    if (!got) welcome();
    else {
      shown = got.D.generated;
      databar(got.D, got.source);
      /** @type {any} */ (window).startDashboard(got.D, got.source);
    }
    if (typeof strava === "string") barHTML(`<span class="bad" role="alert">${esc(strava)}</span>`);
    else if (strava) job("connect-strava", "Connecting Strava", { code: strava.code });
    else if (got && got.source === "cloud" && !cloudProblem) autoSync(status);
  });
})();
