"use strict";
// The app shell: where the dashboard's data comes from, installing the app, working offline, and the theme.
//
// Data, in order: inlined by `python -m fitness build` (your own computer) → a phone link's #d=… (deflated JSON in
// the fragment, which browsers never send to a server) → the copy this device saved last time → nothing yet, which
// shows the welcome screen. Hosted on chrisrohn.com/fitness/ the page itself holds no one's data; whatever arrives
// is kept only in this device's storage, and it also hands ride mode its zones and sessions (same origin).
(() => {
  const $ = id => document.getElementById(id);
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); return true; } catch { return false; } },
  };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const standalone = () => matchMedia("(display-mode: standalone)").matches || /** @type {any} */ (navigator).standalone === true;

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
  /** Make imported data safe and phone-shaped: no QR or links baked for another host; ride mode reads this device's copy. */
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

  async function load() {
    const raw = ($("data") || { textContent: "" }).textContent.trim();
    if (raw.startsWith("{")) return { D: JSON.parse(raw), source: "build" };
    const frag = new URLSearchParams(location.hash.slice(1)).get("d");
    if (frag) {
      history.replaceState(null, "", location.pathname + location.search);
      try {
        const d = adopt(await parse("#d=" + frag));
        if (valid(d)) { keep(d); return { D: d, source: "link" }; }
      } catch (e) { notice(`That link couldn't be read: ${e.message}`); }
    }
    try {
      const d = JSON.parse(ls.get("fitness-dashboard") || "null");
      if (valid(d)) return { D: d, source: "saved" };
    } catch { /* fall through to the welcome screen */ }
    return null;
  }

  // ── importing on the phone: paste the link (iPhone home-screen apps keep their own storage) or pick the file ──
  const dlg = $("import");
  function openImport() {
    if (!dlg) return;
    $("import-error").textContent = "";
    $("import-text").value = "";
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
  if (dlg) {
    $("import-go").addEventListener("click", e => { e.preventDefault(); take($("import-text").value); });
    $("import-paste").addEventListener("click", async e => {
      e.preventDefault();
      try { $("import-text").value = await navigator.clipboard.readText(); take($("import-text").value); }
      catch { $("import-error").textContent = "This browser didn't allow reading the clipboard: long-press the box and Paste."; }
    });
    $("import-file").addEventListener("change", async () => {
      const f = $("import-file").files[0];
      if (f) take(await f.text());
    });
  }
  document.addEventListener("click", e => {
    const t = e.target instanceof Element ? e.target.closest("[data-action]") : null;
    if (!t) return;
    if (t.dataset.action === "import") { e.preventDefault(); openImport(); }
    if (t.dataset.action === "forget") {
      e.preventDefault();
      if (confirm("Remove the dashboard data from this device?")) { ls.set("fitness-dashboard", null); ls.set("fitness-ride-config", null); location.reload(); }
    }
  });

  function notice(text) {
    const bar = $("databar");
    if (!bar) return;
    bar.hidden = false;
    bar.innerHTML = `<div class="databar-in"><span>${esc(text)}</span></div>`;
  }

  // the line under the masthead: how old this device's copy is, and how to refresh it
  function databar(D, source) {
    const bar = $("databar");
    if (!bar || source === "build") return;
    const made = new Date(D.generated);
    const hours = (Date.now() - made.getTime()) / 36e5;
    const when = made.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    bar.hidden = false;
    bar.innerHTML = `<div class="databar-in${hours > 36 ? " stale" : ""}"><span>Data from <b>${esc(when)}</b>${hours > 36 ? ` · ${Math.floor(hours / 24)} days old` : ""}</span>
      <button type="button" class="chip" data-action="import">Update data</button><button type="button" class="chip" data-action="forget">Remove</button></div>`;
  }

  function welcome() {
    const nav = document.querySelector(".bar nav");
    if (nav) nav.hidden = true;
    for (const id of ["units-seg"]) { const el = $(id); if (el) el.hidden = true; }
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) && !standalone();
    $("app").innerHTML = `<section class="card welcome" id="today">
      <div class="head"><h2>Training &amp; Recovery</h2><p class="sub">Your call for the day, readiness, sleep, the season plan to race day, and ride mode on the bars.</p></div>
      <div class="grid">
        <div class="steps">
          <h3>Put your dashboard on this phone</h3>
          <ol>
            <li>On your computer, run <code>python -m fitness run</code> and open the dashboard.</li>
            <li>Under <b>Today → Phone app</b>, tap <b>Copy phone link</b> (or save the data file to iCloud Drive or Google Drive).</li>
            <li>Here, tap <b>Import data</b> and paste the link or pick the file.</li>
          </ol>
          <p class="mt-3"><button type="button" class="chip big-chip" data-action="import">Import data</button> <a class="chip big-chip" href="ride.html">Open ride mode</a></p>
          <p class="sub mt-4">Your data never touches this server: the link carries it after the <b>#</b>, which browsers keep to themselves, and it's stored only on this device.</p>
        </div>
        <div class="steps">
          <h3>Install the app</h3>
          ${standalone() ? `<p>Installed. Open it from your home screen; it works offline.</p>`
            : ios ? `<p>In Safari, tap <b>Share</b>, then <b>Add to Home Screen</b>. It opens full screen and works offline.</p><p class="sub mt-2">Installed apps on iPhone keep their own storage: import your data <i>inside</i> the app after installing.</p>`
            : `<p>Use <b>Install</b> in the top bar, or your browser's menu → <b>Install app</b> / <b>Add to Home screen</b>. It opens full screen and works offline.</p>`}
        </div>
      </div>
    </section>`;
  }

  // a phone link opened while the app is already showing is only a #hash change: start over and take it
  window.addEventListener("hashchange", () => { if (/^#(.*&)?d=/.test(location.hash)) location.reload(); });

  window.addEventListener("DOMContentLoaded", async () => {
    const got = await load();
    if (!got) { welcome(); return; }
    databar(got.D, got.source);
    /** @type {any} */ (window).startDashboard(got.D, got.source);
  });
})();
