"use strict";
// Ride mode: a cycling computer on the phone on your bars.
//   Workout  the day's session as timed steps with HR (and power) targets, tailored as you ride
//   Map      the route, where you are and where you've been, turn by turn, offline along a downloaded route
//   Ahead    the elevation profile, the next climb (ClimbPro-style), the turns, stops and the wind still to come
//   Data     every live figure, big;  Laps  manual, per-step and auto laps
// Sensors and smart trainers (FTMS, Tacx FE-C) over Web Bluetooth, position from the phone's GPS, routes from GPX / TCX
// files (or shared from any app), detours from BRouter, or offline from the map tiles on the phone. Rides are kept on
// this phone, export as FIT, GPX or TCX, and go to the training sync (when it's connected) to count in the plan.
(async () => {
  const C = /** @type {any} */ (window).RideCore;
  const $ = id => document.getElementById(id);
  // stops and places as transit-sign pictograms in the 1974 AIGA/DOT manner: a white mark on a black tile, drawn here
  // (emoji are coloured, differ by phone, and don't belong on a sign)
  const ST = 'stroke="currentColor" fill="none"';
  const KIND_PICTO = {
    water: `<path d="M12 3c3.6 5 6 8.3 6 11.3a6 6 0 0 1-12 0C6 11.3 8.4 8 12 3z"/>`,
    food: `<rect x="4.5" y="3" width="1.6" height="6"/><rect x="7.2" y="3" width="1.6" height="6"/><rect x="9.9" y="3" width="1.6" height="6"/><path d="M4.5 8.5h7v1a3 3 0 0 1-2.5 2.9V21H7v-8.6A3 3 0 0 1 4.5 9.5z"/><path d="M15 3c2.9 1 4 4.5 4 9h-2.2v9H15z"/>`,
    bike: `<g ${ST} stroke-width="1.8"><circle cx="6" cy="15.5" r="4"/><circle cx="18" cy="15.5" r="4"/><path d="M6 15.5L9.5 8.5h6.5L12 15.5H6M9.5 8.5L12 15.5M16 8.5l2 7M8 6.5h3.5M14.5 5.5H17"/></g>`,
    toilet: `<circle cx="6.5" cy="4.5" r="2"/><rect x="4.5" y="7.5" width="4" height="7"/><rect x="4.5" y="14" width="1.7" height="7"/><rect x="6.8" y="14" width="1.7" height="7"/><rect x="11.4" y="2" width="1.2" height="20"/><circle cx="17.5" cy="4.5" r="2"/><path d="M15.5 7.5h4l2 8h-8z"/><rect x="15.6" y="15" width="1.5" height="6"/><rect x="17.9" y="15" width="1.5" height="6"/>`,
    aid: `<rect x="9" y="3.5" width="6" height="17"/><rect x="3.5" y="9" width="17" height="6"/>`,
    summit: `<path d="M12 4l9 16H3z"/>`,
    valley: `<path d="M3 4h18l-9 16z"/>`,
    danger: `<path fill-rule="evenodd" d="M12 3l10 18H2zM11 9h2v6h-2zM11 16.5h2v2h-2z"/>`,
    sprint: `<path d="M14 2L5 13.5h6L9 22l10-12h-6l2-8z"/>`,
    finish: `<rect x="5" y="3" width="1.8" height="18"/><path d="M6.8 4H19l-3 4 3 4H6.8z"/>`,
    generic: `<circle cx="12" cy="12" r="4"/>`,
  };
  const picto = kind => `<svg class="picto tile" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${KIND_PICTO[kind] || KIND_PICTO.generic}</svg>`;
  // keep figures with their units so a cue never breaks "3 / min" on a phone-width line
  const nb = t => String(t ?? "").replace(/ × /g, "\u00a0×\u00a0").replace(/(\d) (?=(?:min|h|s|mi|km|ft|m|bpm|W|g|rpm|TSS|%)(?!\w))/g, "$1\u00a0")
    .replace(/(RPE|Z\d|\+|−|~) (?=[\d(])/g, "$1\u00a0").replace(/(\d)–(?=\d)/g, "$1\u2060–\u2060");   // word joiners keep 88–93 whole
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  /** A yes/no question in ride mode's own sheet: two full-width buttons a gloved thumb can hit on a moving bike, Cancel
   *  focused, so a bump or a stray Enter never ends a ride or deletes one. @returns {Promise<boolean>} */
  const UI = /** @type {any} */ (self).FitnessUI;   // common.js: the theme rule and the confirm sheet, shared with the dashboard
  /** A yes/no question in the app's own sheet; Cancel has the focus. @returns {Promise<boolean>} */
  const ask = (title, text, yes, opt = {}) => UI.ask(title, text, yes, opt);
  const jget = (k, d) => { try { return JSON.parse(ls.get(k) || "null") ?? d; } catch { return d; } };

  // ── config: a link from the dashboard (#z= deflate-raw, or #c= plain; base64url JSON) > inlined by the build >
  //    the last one saved on this phone. A fragment never reaches the server, and it's treated as untrusted text.
  const bytes = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  const inflate = async s => new Response(new Blob([bytes(s)]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
  let cfg = null;
  const frag = new URLSearchParams(location.hash.slice(1));
  if (frag.has("z") || frag.has("c")) {
    try {
      cfg = JSON.parse(frag.has("z") ? await inflate(frag.get("z")) : new TextDecoder().decode(bytes(frag.get("c"))));
      if (!cfg || typeof cfg !== "object" || !Array.isArray(cfg.days)) throw new Error("not a ride plan");
      ls.set("fitness-ride-config", JSON.stringify(cfg));
    } catch { cfg = null; }
    history.replaceState(null, "", location.pathname + location.search);
  }
  if (!cfg) { try { const t = $("ride-data").textContent.trim(); if (t.startsWith("{")) cfg = JSON.parse(t); } catch { cfg = null; } }
  if (!cfg) cfg = jget("fitness-ride-config", null);
  cfg = cfg || { lthr: 160, max_hr: 185, rest_hr: 55, sex: "male", days: [], wheel_m: 2.29, fuel_every_min: 20 };
  const prefs = jget("fitness-ride-prefs", {});
  const P = {
    lthr: prefs.lthr || cfg.lthr, max: prefs.max || cfg.max_hr, rest: prefs.rest || cfg.rest_hr, wheel: prefs.wheel || cfg.wheel_m || 2.29,
    fuel: prefs.fuel ?? cfg.fuel_every_min ?? 20, voice: prefs.voice ?? true, km: (ls.get("fitness-units") || (cfg.units === "metric" ? "km" : "mi")) === "km",
    ftp: prefs.ftp ?? cfg.ftp ?? 0, autoPause: prefs.autoPause ?? true, stepLap: prefs.stepLap ?? true, autoLap: prefs.autoLap ?? 0,
    climbs: prefs.climbs ?? true, reroute: prefs.reroute ?? true, profile: prefs.profile || "trekking", headingUp: prefs.headingUp ?? true,
    trainer: prefs.trainer || "auto", weight: prefs.weight || cfg.weight_kg || 75, upload: prefs.upload ?? true, saver: prefs.saver || "auto",
    autoLock: prefs.autoLock ?? false, freeride: prefs.freeride || "all",
  };
  const savePrefs = () => ls.set("fitness-ride-prefs", JSON.stringify({ lthr: P.lthr, max: P.max, rest: P.rest, wheel: P.wheel, fuel: P.fuel, voice: P.voice, ftp: P.ftp,
    autoPause: P.autoPause, stepLap: P.stepLap, autoLap: P.autoLap, climbs: P.climbs, reroute: P.reroute, profile: P.profile, headingUp: P.headingUp,
    trainer: P.trainer, weight: P.weight, upload: P.upload, saver: P.saver, autoLock: P.autoLock, freeride: P.freeride }));

  // ── formatting ──────────────────────────────────────────────────────────────────────────────────────────
  const clock = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`; };
  const distTxt = m => (P.km ? m / 1000 : m / 1609.344).toFixed(1);
  const speedTxt = mps => mps == null ? "—" : (P.km ? mps * 3.6 : mps * 2.23694).toFixed(1);
  const unitD = () => (P.km ? "km" : "mi"), unitS = () => (P.km ? "km/h" : "mph"), unitE = () => (P.km ? "m" : "ft");
  const eleTxt = m => String(Math.round(P.km ? m : m * 3.28084));
  /** A distance to a turn or a stop: feet / metres up close, tenths of a mile / km beyond. */
  const nearTxt = m => {
    if (P.km) return m < 950 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`;
    const ft = m * 3.28084;
    return ft < 1000 ? `${Math.max(50, Math.round(ft / 50) * 50)} ft` : `${(m / 1609.344).toFixed(1)} mi`;
  };
  const nearSay = m => {
    if (P.km) return m < 950 ? `${Math.max(10, Math.round(m / 50) * 50)} metres` : `${(m / 1000).toFixed(1)} kilometres`;
    const ft = m * 3.28084;
    return ft < 1000 ? `${Math.max(50, Math.round(ft / 100) * 100 || 50)} feet` : m < 1700 ? (m < 500 ? "a quarter mile" : m < 1000 ? "half a mile" : "one mile") : `${(m / 1609.344).toFixed(1)} miles`;
  };
  const bpm = pct => Math.round(P.lthr * pct / 100);
  const zoneOf = hr => { const p = hr / P.lthr * 100; return p < 81 ? 1 : p < 90 ? 2 : p < 94 ? 3 : p < 100 ? 4 : 5; };
  const ZNAME = ["", "Z1 recovery", "Z2 endurance", "Z3 tempo", "Z4 threshold", "Z5 VO2"];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const today = new Date(), iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const hhmm = t => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const compass = d => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(d / 45) % 8];
  const css = name => getComputedStyle(document.body).getPropertyValue(name).trim() || "#888";
  const face = (px, bold = false) => `${bold ? "700 " : ""}${px}px ${css("--font").replace(/^#888$/, "sans-serif")}`;   // canvas text in the page's Helvetica

  // ── storage on this phone: routes, rides and the ride being recorded (IndexedDB) ──────────────────────────
  const DB = (() => {
    let opening = null;
    const open = () => opening || (opening = new Promise((res, rej) => {
      const r = indexedDB.open("fitness-ride", 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("routes", { keyPath: "id" }); d.createObjectStore("rides", { keyPath: "id" }); d.createObjectStore("tracks", { keyPath: "id" }); d.createObjectStore("chunks"); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const run = async (store, mode, fn) => {
      const d = await open();
      return new Promise((res, rej) => { const t = d.transaction(store, mode), q = fn(t.objectStore(store)); t.oncomplete = () => res(q && "result" in q ? q.result : undefined); t.onerror = t.onabort = () => rej(t.error); });
    };
    return {
      put: (s, v, k) => run(s, "readwrite", o => (k === undefined ? o.put(v) : o.put(v, k))), get: (s, k) => run(s, "readonly", o => o.get(k)),
      all: s => run(s, "readonly", o => o.getAll()), del: (s, k) => run(s, "readwrite", o => o.delete(k)),
      range: (s, from, to) => run(s, "readonly", o => o.getAll(IDBKeyRange.bound(from, to))), delRange: (s, from, to) => run(s, "readwrite", o => o.delete(IDBKeyRange.bound(from, to))),
    };
  })();
  const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  // ── the day's session ───────────────────────────────────────────────────────────────────────────────────
  const daySel = $("day");
  const days = (cfg.days || []).filter(d => d.steps && d.steps.length);
  const paintDays = () => {
    const quick = S.quick ? `<option value="quick">${esc(S.quick.title)}</option>` : "";
    daySel.innerHTML = quick + days.map((d, i) => {
      const dt = new Date(d.date + "T12:00:00");
      const label = d.date === iso(today) ? "Today" : `${DOW[dt.getDay()]} ${MON[dt.getMonth()]} ${dt.getDate()}`;
      return `<option value="${i}">${label} · ${esc(d.title)}${d.minutes ? ` · ${Math.round(+d.minutes)} min` : ""}</option>`;
    }).join("") + `<option value="free">Free ride (no steps)</option>`;
  };
  const todayIdx = days.findIndex(d => d.date === iso(today));
  const dayOf = v => v === "quick" ? S.quick : v === "free" ? null : days[+v] || null;
  let planned = null;
  const pickDay = () => {
    planned = dayOf(daySel.value);
    S.plan = planned ? planned.steps.map(s => ({ ...s })) : [];
    S.step = 0; S.stepStart = S.elapsed; S.intensity = 1;
    render();
  };

  // ── ride state (saved every few seconds so a reload mid-ride picks up where it was) ───────────────────────
  const fresh = () => ({ running: false, paused: false, elapsed: 0, moving: 0, dist: 0, step: 0, stepStart: 0, hrSum: 0, hrSecs: 0, hrMax: 0, zones: [0, 0, 0, 0, 0],
    trimp: 0, cadSum: 0, cadSecs: 0, pwSum: 0, pwSecs: 0, fuelAt: 0, fuelDue: false, ended: false, plan: [], intensity: 1, quick: null, rideId: "", wallStart: 0, chunk: 0,
    laps: [], lapStart: 0, lapElapsed: 0, lapDist: 0, pauses: [], autoPaused: false, still: 0, ascent: 0, maxSpeed: 0, held: 0, missed: 0, hot: 0, loadOffered: false, navAlong: 0, battSaid: false, tgtSecs: 0, tgtOn: 0, workSecs: 0, workOn: 0,
    tank: null, fuelSaid: 0, wbal: null, wbalLow: false, routeT0: null, mine: [], ghostSaid: 0, paceSaid: -1, paceHot: 0, wxSaid: [], windSec: 0, windSecs: 0, windHead: 0, windTail: 0 });
  const S = fresh();
  const live = { heading: null, anchor: null, hr: null, hrAt: 0, cad: null, cadAt: 0, power: null, powerAt: 0, pw: [], wheelSpeed: null, wheelAt: 0, gpsSpeed: null, gpsAt: 0, lastFix: null, alt: null, battery: null };
  let samples = [];
  try {
    const saved = jget("fitness-ride-state", null);
    if (saved && saved.running && Date.now() - saved.savedAt < 12 * 3600e3) Object.assign(S, saved, { paused: true });
  } catch { /* fresh ride */ }
  paintDays();
  const savedDay = jget("fitness-ride-state", null);
  daySel.value = S.running && savedDay ? savedDay.day : todayIdx >= 0 ? String(todayIdx) : days.length && days[0].date > iso(today) ? "0" : "free";
  if (!daySel.value) daySel.value = "free";
  const save = () => ls.set("fitness-ride-state", JSON.stringify({ ...S, day: daySel.value, savedAt: Date.now() }));
  const steps = () => S.plan;

  // ── sound, voice, vibration, wake lock ──────────────────────────────────────────────────────────────────
  let audio = null;
  const beep = (freq = 880, ms = 160, n = 1) => {
    if (!audio) return;
    for (let i = 0; i < n; i++) {
      const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime + i * (ms + 90) / 1000;
      o.frequency.value = freq; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
      o.connect(g).connect(audio.destination); o.start(t); o.stop(t + ms / 1000 + 0.02);
    }
  };
  const say = (text, urgent = true) => { if (P.voice && "speechSynthesis" in window) { if (urgent) speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } };
  const buzz = pattern => { if (navigator.vibrate) navigator.vibrate(pattern); };
  let lock = null;
  const wake = async () => { try { if ("wakeLock" in navigator && document.visibilityState === "visible") lock = await navigator.wakeLock.request("screen"); } catch { lock = null; } };
  document.addEventListener("visibilitychange", () => { if (S.running && !S.paused && document.visibilityState === "visible") wake(); });
  if (typeof (/** @type {any} */ (navigator)).getBattery === "function") {
    /** @type {any} */ (navigator).getBattery().then(b => { const up = () => { live.battery = { level: b.level, charging: b.charging }; }; up(); b.addEventListener("levelchange", up); b.addEventListener("chargingchange", up); }).catch(() => {});
  }

  // ── Bluetooth sensors ───────────────────────────────────────────────────────────────────────────────────
  const note = $("note");
  const chip = (id, state) => { const c = $(id); c.classList.remove("on", "wait", "off"); if (state) c.classList.add(state); };
  const noBluetooth = () => {
    note.innerHTML = "This browser can't talk to Bluetooth sensors. <b>iPhone:</b> open this page in the free <b>Bluefy</b> browser (Safari and iOS Chrome don't support Web Bluetooth). <b>Android:</b> use Chrome. GPS, steps and cues work without it.";
  };
  const wheel = { revs: null, time: null }, crank = { revs: null, time: null };
  const onHr = dv => {
    const flags = dv.getUint8(0);
    const hr = flags & 1 ? dv.getUint16(1, true) : dv.getUint8(1);
    if (hr > 25 && hr < 240) { live.hr = hr; live.hrAt = Date.now(); }
  };
  const onCsc = dv => {
    const flags = dv.getUint8(0);
    let i = 1;
    const now = Date.now();
    if (flags & 1) {
      const revs = dv.getUint32(i, true), t = dv.getUint16(i + 4, true); i += 6;
      if (wheel.revs != null) {
        const dr = revs - wheel.revs, dt = ((t - wheel.time + 65536) % 65536) / 1024;
        if (dt > 0 && dr >= 0 && dr < 100) {
          live.wheelSpeed = dr * P.wheel / dt; live.wheelAt = now;
          if (S.running && !S.paused && !S.autoPaused && !trainerLive(now)) S.dist += dr * P.wheel;
        }
      }
      wheel.revs = revs; wheel.time = t;
    }
    if (flags & 2) {
      const revs = dv.getUint16(i, true), t = dv.getUint16(i + 2, true);
      if (crank.revs != null) {
        const dr = (revs - crank.revs + 65536) % 65536, dt = ((t - crank.time + 65536) % 65536) / 1024;
        if (dt > 0 && dr < 20) { live.cad = Math.round(dr / dt * 60); live.cadAt = now; }
      }
      crank.revs = revs; crank.time = t;
    }
  };
  const onPower = dv => {
    live.power = dv.getInt16(2, true); live.powerAt = Date.now();
    live.pw.push([live.powerAt, live.power]);
    while (live.pw.length && live.pw[0][0] < live.powerAt - 10000) live.pw.shift();
  };
  const pw10 = () => live.pw.length && Date.now() - live.powerAt < 4000 ? Math.round(live.pw.reduce((a, x) => a + x[1], 0) / live.pw.length) : null;

  // Garmin's straps (HRM-Pro, HRM-Pro Plus, HRM-Dual, HRM-Fit, HRM 600) are matched by name as well as by service,
  // so one that only names itself in its advertisement still shows; "Show all nearby devices" is the last resort.
  const SENSORS = {
    hr: { id: "btn-hr", label: "heart-rate strap", services: ["heart_rate"], prefixes: ["HRM", "Polar", "TICKR", "Wahoo", "COOSPO", "Garmin"] },
    csc: { id: "btn-csc", label: "cadence, speed or power sensor", services: ["cycling_speed_and_cadence", "cycling_power"], prefixes: ["CAD", "SPD", "Garmin", "Wahoo", "RPM"] },
    trainer: { id: "btn-trainer", label: "smart trainer", services: [C.FTMS.service, C.TACX.service, "cycling_power", "cycling_speed_and_cadence"],
      prefixes: ["Tacx", "KICKR", "Wahoo KICKR", "Elite", "Saris", "Zwift Hub", "Wattbike", "JetBlack", "Van Rysel", "Magene", "ThinkRider"] },
  };
  const hooked = new WeakSet();
  const helpHtml = kind => kind === "trainer"
    ? "<b>Trainer not in the list?</b> Pedal to wake it (a Tacx Flow sleeps when the wheel stops), and close Tacx Training, Zwift or any other app holding it. A <b>Tacx Flow Smart</b> (T2240) shows as <b>Tacx Flow</b> followed by a number. The older, non-smart Flow (T2200) has no Bluetooth: it pairs only with Tacx's own head unit, so no phone app can drive it. Android: give Chrome <b>Nearby devices</b> permission and keep Location on."
    : kind === "hr"
    ? "<b>Strap not in the list?</b> Wear it with the pads wet: it sleeps until it feels a heartbeat. If it shows in your phone's own Bluetooth settings, tap it there and choose <b>Forget</b> (or Unpair): a strap held by the phone stops advertising, so the browser never sees it. It takes only a couple of Bluetooth links at once, so close Garmin Connect, Zwift or any other app using it (the watch can stay on it over ANT+). Android: give Chrome <b>Nearby devices</b> permission and keep Location on."
    : "<b>Sensor not in the list?</b> Spin the crank or wheel to wake it. If it shows in your phone's own Bluetooth settings, choose <b>Forget</b> there, and close Garmin Connect, Zwift or any other app holding it. Android: give Chrome <b>Nearby devices</b> permission and keep Location on.";
  const help = (kind, lead = "") => {
    note.innerHTML = `${lead ? `${esc(lead)} ` : ""}${helpHtml(kind)} `;
    const all = document.createElement("button");
    all.type = "button"; all.className = "chip"; all.textContent = "Show all nearby devices";
    all.addEventListener("click", () => connect(kind, true));
    note.append(all);
  };

  async function subscribe(device, kind) {
    const server = await device.gatt.connect();
    const hook = async (svc, char, fn) => {
      try {
        const c = await (await server.getPrimaryService(svc)).getCharacteristic(char);
        c.addEventListener("characteristicvaluechanged", e => fn(e.target.value));
        await c.startNotifications();
        return true;
      } catch { return false; }
    };
    if (kind === "hr") return hook("heart_rate", "heart_rate_measurement", onHr);
    if (kind === "trainer") return hookTrainer(server, hook);
    const a = await hook("cycling_speed_and_cadence", "csc_measurement", onCsc);
    const b = await hook("cycling_power", "cycling_power_measurement", onPower);
    if (b) live.powerMeter = true;
    return a || b;
  }
  // one live sensor per kind; a connection that fails says why (and what to try) instead of just turning red
  const conn = { hr: null, csc: null, trainer: null };
  async function attach(device, kind, quiet = false) {
    const s = SENSORS[kind], name = device.name || `the ${s.label}`;
    if (conn[kind] === device && device.gatt.connected) { chip(s.id, "on"); return true; }   // already streaming: don't hook it twice
    chip(s.id, "wait");
    try {
      if (await subscribe(device, kind)) {
        const old = conn[kind];
        conn[kind] = device;
        if (old && old !== device && old.gatt.connected) old.gatt.disconnect();
        if (!hooked.has(device)) { hooked.add(device); device.addEventListener("gattserverdisconnected", () => retry(device, kind, 0)); }
        ls.set(`fitness-ride-${kind}`, device.id);
        $(s.id).title = name;
        chip(s.id, "on");
        if (!quiet) note.textContent = `Connected: ${name}.`;
        return true;
      }
      chip(s.id, conn[kind] && conn[kind].gatt.connected ? "on" : "off");
      if (!quiet) help(kind, `${name} connected but sends no ${kind === "hr" ? "heart rate" : kind === "trainer" ? "trainer data" : "cadence, speed or power"}.`);
    } catch (e) {
      chip(s.id, conn[kind] && conn[kind] !== device && conn[kind].gatt.connected ? "on" : "off");
      if (!quiet) help(kind, `Couldn't connect to ${name}${e && e.message ? ` (${e.message})` : ""}.`);
    }
    return false;
  }
  async function connect(kind, all = false) {
    if (!navigator.bluetooth) { noBluetooth(); return; }
    const s = SENSORS[kind];
    chip(s.id, "wait");
    let device;
    try {
      device = await navigator.bluetooth.requestDevice(all
        ? { acceptAllDevices: true, optionalServices: s.services }
        : { filters: [...s.services.map(x => ({ services: [x] })), ...s.prefixes.map(p => ({ namePrefix: p }))], optionalServices: s.services });
    } catch (e) {
      chip(s.id, conn[kind] && conn[kind].gatt.connected ? "on" : "off");
      const msg = (e && e.message) || String(e);
      help(kind, e && e.name === "NotFoundError" && /cancel/i.test(msg) ? "" : `Bluetooth: ${msg}.`);
      return;
    }
    attach(device, kind);
  }
  function retry(device, kind, n) {
    const s = SENSORS[kind];
    if (conn[kind] !== device) return;   // swapped for another sensor
    chip(s.id, "wait");
    if (n > 6) { chip(s.id, "off"); rejoin(device, kind); return; }
    setTimeout(async () => { if (!(await attach(device, kind, true))) retry(device, kind, n + 1); }, Math.min(16000, 1000 * 2 ** n));
  }
  // a sensor used here before comes back without the picker, as soon as it's heard (Chrome's getDevices and
  // watchAdvertisements; elsewhere a direct reconnect is tried once)
  function rejoin(device, kind) {
    if (typeof device.watchAdvertisements !== "function") { attach(device, kind, true); return; }
    const ctl = new AbortController();
    device.addEventListener("advertisementreceived", async () => {
      ctl.abort();
      if (!(await attach(device, kind, true))) setTimeout(() => rejoin(device, kind), 10000);
    }, { once: true });
    device.watchAdvertisements({ signal: ctl.signal }).catch(() => {});
  }
  $("btn-hr").addEventListener("click", () => connect("hr"));
  $("btn-csc").addEventListener("click", () => connect("csc"));
  $("btn-trainer").addEventListener("click", () => connect("trainer"));
  if (!navigator.bluetooth) noBluetooth();
  else if (typeof navigator.bluetooth.getDevices === "function") {
    navigator.bluetooth.getDevices().then(list => {
      for (const kind of ["hr", "csc", "trainer"]) {
        const d = list.find(x => x.id === ls.get(`fitness-ride-${kind}`));
        if (d) { conn[kind] = d; rejoin(d, kind); }
      }
    }).catch(() => {});
  }

  // ── smart trainer: a Tacx Flow Smart (FE-C over Bluetooth) or any FTMS trainer ─────────────────────────────
  //   ERG    a workout step's watts from FTP, or heart-rate ERG with no FTP: watts nudged to hold the step's HR band,
  //          and what held each band remembered for the next ride
  //   Route  on a free ride with a route loaded: the route's grade under you, your place on it moved by the wheel
  //   Read   speed, power and cadence only (the setting, or a trainer that takes no commands)
  const TR = { kind: "", write: null, queue: Promise.resolve(), mode: "", watts: 0, sentW: -1, sentG: null, sentAt: 0, key: "", since: 0, hrErg: false, stepSecs: 0,
    limit: null, limitAt: 0, limitSaid: "", calibrate: 0, virtual: false, along: 0, speedAt: 0, used: false };
  const ergLearn = jget("fitness-ride-erg", {});   // % of LTHR (5 % steps) → the watts that held it on earlier rides
  const trainerLive = (now = Date.now()) => !!conn.trainer && now - TR.speedAt < 3000;
  const send = bytes => { if (TR.write) TR.queue = TR.queue.then(() => TR.write(bytes)).catch(() => {}); return TR.queue; };
  function trainerData({ speed = null, power = null, cadence = null, hr = null }) {
    const now = Date.now();
    TR.used = true;
    if (speed != null) {
      if (TR.speedAt && S.running && !S.paused && !S.autoPaused) { const d = speed * Math.min(2, (now - TR.speedAt) / 1000); S.dist += d; if (TR.virtual) TR.along += d; }
      live.wheelSpeed = speed; live.wheelAt = now; TR.speedAt = now;
    }
    if (power != null && power >= 0) {
      live.power = power; live.powerAt = now; live.pw.push([now, power]);
      while (live.pw.length && live.pw[0][0] < now - 10000) live.pw.shift();
    }
    if (cadence != null) { live.cad = cadence; live.cadAt = now; }
    if (hr && !(conn.hr && now - live.hrAt < 4000)) { live.hr = hr; live.hrAt = now; }   // a strap wins
  }
  function onFec(dv) {
    const m = C.parseFec(dv);
    if (!m) return;
    if (m.page === 0x10) trainerData({ speed: m.speed, hr: m.hr });
    else if (m.page === 0x19) { trainerData({ power: m.power, cadence: m.cadence }); TR.limit = m.limit; TR.limitAt = Date.now(); TR.calibrate = m.calibrate; }
  }
  /** The trainer's services: Tacx FE-C first (a Flow Smart speaks it; FTMS only came with later firmware), then FTMS,
   *  then a plain power / speed service, read only. */
  async function hookTrainer(server, hook) {
    TR.write = null; TR.kind = ""; TR.sentW = -1; TR.sentG = null;
    try {
      const svc = await server.getPrimaryService(C.TACX.service);
      const rx = await svc.getCharacteristic(C.TACX.rx), tx = await svc.getCharacteristic(C.TACX.tx);
      rx.addEventListener("characteristicvaluechanged", e => onFec(e.target.value));
      await rx.startNotifications();
      TR.kind = "Tacx FE-C";
      TR.write = b => (tx.properties.writeWithoutResponse ? tx.writeValueWithoutResponse(b) : tx.writeValueWithResponse(b));
      send(C.fecUser(P.weight, 9, P.wheel));
      return true;
    } catch { /* not a Tacx bridge */ }
    try {
      const svc = await server.getPrimaryService(C.FTMS.service);
      const data = await svc.getCharacteristic(C.FTMS.data);
      data.addEventListener("characteristicvaluechanged", e => trainerData(C.parseBikeData(e.target.value)));
      await data.startNotifications();
      TR.kind = "FTMS (read only)";
      try {
        const cp = await svc.getCharacteristic(C.FTMS.control);
        cp.addEventListener("characteristicvaluechanged", () => {});
        await cp.startNotifications();
        TR.write = b => cp.writeValueWithResponse(b);
        await send(C.ftms.control()); await send(C.ftms.start());
        TR.kind = "FTMS";
      } catch { TR.write = null; }
      return true;
    } catch { /* no FTMS */ }
    const a = await hook("cycling_power", "cycling_power_measurement", onPower);
    const b = await hook("cycling_speed_and_cadence", "csc_measurement", onCsc);
    if (a || b) TR.kind = "power only";
    return a || b;
  }
  const stepPct = s => (s.lo > 0 ? (s.lo + s.hi) / 2 * (C.isWork(s) ? S.intensity : 1) : s.hi - 6);
  const learnKey = s => String(Math.round(stepPct(s) / 5) * 5);
  /** Once a second: what the trainer should be doing now, sent when it changes (and every 10 s, which Tacx expects). */
  function driveTrainer(now) {
    const on = conn.trainer && conn.trainer.gatt && conn.trainer.gatt.connected;
    if (!on) { TR.mode = ""; TR.virtual = false; return; }
    const st = steps(), s = S.running && S.step < st.length ? st[S.step] : null;
    const routeOk = !!(NAV.route && NAV.route.hasEle);
    const mode = !TR.write || P.trainer === "read" ? "read" : s && P.trainer !== "route" ? "erg" : routeOk && P.trainer !== "erg" ? "route" : "";
    // learn what held the heart-rate band when a step on heart-rate ERG ends
    const key = s ? `${S.step}:${s.name}:${S.intensity}` : "";
    if (key !== TR.key) {
      const prev = TR.key && st[+TR.key.split(":")[0]];
      if (prev && TR.hrErg && TR.stepSecs >= 180) { const k = learnKey(prev); ergLearn[k] = Math.round(ergLearn[k] ? ergLearn[k] * 0.6 + TR.watts * 0.4 : TR.watts); ls.set("fitness-ride-erg", JSON.stringify(ergLearn)); }
      TR.key = key; TR.since = 0; TR.stepSecs = 0; TR.limitSaid = "";
      if (s) { const w = C.ergWatts(s, P.ftp, S.intensity); TR.hrErg = w == null; TR.watts = w ?? (ergLearn[learnKey(s)] || C.ergGuess(stepPct(s))); }
    }
    const was = TR.mode;
    TR.mode = mode;
    const gpsMoving = now - live.gpsAt < 10000 && (live.gpsSpeed ?? 0) > 2.5;
    const virtual = mode === "route" && !gpsMoving && S.running;
    if (virtual && !TR.virtual) TR.along = NAV.st && !NAV.st.offCourse ? NAV.st.along : 0;
    TR.virtual = virtual;
    if (virtual) {   // your place on the route, moved by the trainer's wheel speed
      const p = C.pointAt(NAV.route, Math.min(TR.along, NAV.route.total));
      live.heading = p.brg;
      const fix = { lat: p.lat, lon: p.lon, t: now, acc: 3 };
      live.lastFix = fix; onFix(fix);
    }
    if (!S.running || S.paused || S.autoPaused) return;
    const stale = now - TR.sentAt > 10000;
    if (mode === "erg" && s) {
      TR.stepSecs++; TR.since++;
      if (TR.hrErg && !rolling() && S.elapsed - S.stepStart > 60) {
        const [lo, hi] = tgt(s), hr = live.hr && now - live.hrAt < 5000 ? live.hr : null, w = C.hrErg(TR.watts, hr, lo, hi, TR.since);
        if (w !== TR.watts) { TR.watts = w; TR.since = 0; }
      }
      if (stale || TR.watts !== TR.sentW || was !== "erg") { send(TR.kind === "Tacx FE-C" ? C.fecPower(TR.watts) : C.ftms.power(TR.watts)); TR.sentW = TR.watts; TR.sentAt = now; TR.sentG = null; }
      // a wheel-on trainer can't brake hard at a low wheel speed, or lightly at a high one: say which gear to find
      const lim = now - TR.limitAt < 5000 ? TR.limit : null;
      if ((lim === "slow" || lim === "fast") && TR.limitSaid !== lim && TR.stepSecs > 8) { TR.limitSaid = lim; say(lim === "slow" ? `Shift to a harder gear: the trainer can't hold ${TR.watts} watts at this wheel speed.` : `Shift to an easier gear for ${TR.watts} watts.`, false); }
    } else if (mode === "route") {
      const along = TR.virtual ? TR.along : NAV.st ? NAV.st.along : 0, g = Math.round((C.gradeAt(NAV.route, along) ?? 0) * 2) / 2;
      if (stale || TR.sentG == null || Math.abs(g - TR.sentG) >= 0.5) { send(TR.kind === "Tacx FE-C" ? C.fecGrade(g) : C.ftms.grade(g)); TR.sentG = g; TR.sentAt = now; TR.sentW = -1; }
    }
  }
  /** Back to a light, flat road when the ride ends or pauses for good. */
  const releaseTrainer = () => { if (TR.write) send(TR.kind === "Tacx FE-C" ? C.fecGrade(0) : C.ftms.grade(0)); TR.sentW = -1; TR.sentG = null; TR.virtual = false; };
  /** What the trainer is doing, as [label, value, unit] for the step card (null when it isn't steering). */
  const trainerLine = () => {
    if (!TR.mode || TR.mode === "read") return null;
    if (TR.mode === "erg") return [TR.hrErg ? "HR-ERG" : "ERG", String(Math.round(+TR.watts || 0)), "W"];
    return ["Trainer grade", TR.sentG == null ? "—" : `${TR.sentG > 0 ? "+" : ""}${(+TR.sentG).toFixed(1)}`, "%"];
  };
  /** A line of plain text with bold figures, built from text nodes: [text, bold, text, bold, …]. */
  const lineOf = (el, parts) => el.replaceChildren(...parts.map((t, i) => { if (i % 2 === 0) return String(t); const b = document.createElement("b"); b.textContent = String(t); return b; }));

  // ── GPS ─────────────────────────────────────────────────────────────────────────────────────────────────
  const hav = C.hav, bearing = C.bearing;
  let watch = null;
  const startGps = () => {
    if (!("geolocation" in navigator) || watch != null) return;
    chip("gps-chip", "wait");
    watch = navigator.geolocation.watchPosition(pos => {
      const c = pos.coords, fix = { lat: c.latitude, lon: c.longitude, t: pos.timestamp || Date.now(), acc: c.accuracy };
      chip("gps-chip", c.accuracy <= 30 ? "on" : "wait");
      if (c.accuracy > 50 || TR.virtual) return;   // on the trainer along a route, the wheel moves you, not the GPS
      const prev = live.lastFix;
      live.lastFix = fix;
      if (c.altitude != null && Number.isFinite(c.altitude)) live.alt = live.alt == null ? c.altitude : live.alt + 0.15 * (c.altitude - live.alt);
      // which way you're riding: the GPS course when it gives one, else every 25 m moved
      if (c.heading != null && !Number.isNaN(c.heading) && (c.speed ?? 0) > 2) live.heading = c.heading;
      else if (!live.anchor || hav(live.anchor, fix) > 25) { if (live.anchor) live.heading = bearing(live.anchor, fix); live.anchor = fix; }
      if (prev) {
        const d = hav(prev, fix), dt = (fix.t - prev.t) / 1000;
        const v = c.speed != null && c.speed >= 0 ? c.speed : dt > 0 ? d / dt : null;
        if (v != null && v > 33) { onFix(fix); return; }   // 120 km/h+: a GPS jump, not you
        live.gpsSpeed = v;
        live.gpsAt = Date.now();
        const wheelLive = Date.now() - live.wheelAt < 5000;   // a wheel sensor wins under tree cover
        if (S.running && !S.paused && !S.autoPaused && !wheelLive && d < 200 && (live.gpsSpeed ?? 0) > 0.8) S.dist += d;
      }
      onFix(fix);
    }, () => chip("gps-chip", "off"), { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  };
  const speedNow = (now = Date.now()) => now - live.wheelAt < 5000 ? live.wheelSpeed : now - live.gpsAt < 8000 ? live.gpsSpeed : null;

  // ── weather: conditions where you are, fetched from Open-Meteo when Start is tapped and every 30 minutes on the
  //    ride (only a ~1 km-rounded position leaves the phone); the last sync's hourly forecast when there's no signal
  const WX_EVERY = 15 * 60e3;   // often enough to say rain is coming before it's here
  const wx = { cur: null, src: "", at: 0, busy: false, alerts: [] };
  const tempTxt = c => P.km ? `${Math.round(c)}°C` : `${Math.round(c * 9 / 5 + 32)}°F`;
  const windTxt = kmh => String(Math.round(P.km ? kmh : kmh / 1.609344));
  const windU = () => (P.km ? "km/h" : "mph");
  const fromSync = () => {   // cfg.wx: [hour, temp, feels, wind, direction, gusts, rain chance] for the next day and a half
    const n = new Date(), key = `${iso(n)}T${String(n.getHours()).padStart(2, "0")}:00`;
    const r = (cfg.wx || []).find(x => x[0] === key);
    return r ? { temp: r[1], feels: r[2], wind: r[3], dir: r[4], gust: r[5], pop: r[6] } : null;
  };
  const here = () => new Promise(res => {
    if (live.lastFix && Date.now() - live.lastFix.t < 120e3) return res(live.lastFix);
    if (!("geolocation" in navigator)) return res(null);
    navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lon: p.coords.longitude }), () => res(null),
      { enableHighAccuracy: false, maximumAge: 300e3, timeout: 8000 });
  });
  const timed = (url, ms = 8000, init = {}) => { const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms); return fetch(url, { ...init, signal: ctl.signal }).finally(() => clearTimeout(t)); };
  async function refreshWx() {
    if (wx.busy) return;
    wx.busy = true;
    try {
      const p = await here();
      if (!p) throw new Error("no position");
      const q = new URLSearchParams({ latitude: p.lat.toFixed(2), longitude: p.lon.toFixed(2), timezone: "auto", wind_speed_unit: "kmh", forecast_hours: "3", timeformat: "unixtime",
        current: "temperature_2m,apparent_temperature,wind_speed_10m,wind_direction_10m,wind_gusts_10m", hourly: "precipitation_probability,weather_code",
        minutely_15: "precipitation,wind_speed_10m,wind_direction_10m", forecast_minutely_15: "10" });
      const r = await timed(`https://api.open-meteo.com/v1/forecast?${q}`, 8000, { cache: "no-store" });
      if (!r.ok) throw new Error(`weather ${r.status}`);
      const j = await r.json(), c = j.current || {};
      if (c.temperature_2m == null) throw new Error("no current weather");
      wx.cur = { temp: c.temperature_2m, feels: c.apparent_temperature ?? c.temperature_2m, wind: c.wind_speed_10m ?? 0, dir: c.wind_direction_10m ?? 0,
        gust: c.wind_gusts_10m ?? 0, pop: Math.max(0, ...((j.hourly && j.hourly.precipitation_probability) || []).filter(x => x != null)) };
      wx.src = "Live";
      wx.alerts = C.wxAlerts(j, Date.now());
      if (S.running) for (const a of wx.alerts) if (!S.wxSaid.includes(a.key)) { S.wxSaid = [...S.wxSaid, a.key].slice(-20); notice(a.text, a.kind === "storm"); }
    } catch {
      const s = fromSync();
      if (s) { wx.cur = s; wx.src = "Forecast"; }
    }
    wx.at = Date.now();
    wx.busy = false;
    render();
  }
  wx.cur = fromSync();
  if (wx.cur) wx.src = "Forecast";
  function paintWx(now) {
    const W = wx.cur;
    $("wxbar").hidden = !W;
    if (!W) return;
    $("wx-temp").textContent = tempTxt(W.temp);
    $("wx-feels").textContent = `feels ${tempTxt(W.feels)}${W.pop >= 30 ? ` · ${W.pop}% rain` : ""}`;
    $("wx-wind").innerHTML = `${windTxt(W.wind)}<small>${windU()}</small>`;
    $("wx-dir").textContent = `from ${compass(W.dir)}${W.gust >= W.wind + 10 ? ` · gusts ${windTxt(W.gust)}` : ""}`;
    const moving = live.heading != null && now - live.gpsAt < 8000 && (live.gpsSpeed ?? 0) > 2;
    // the arrow points where the wind blows: north-up when standing, turned to your direction of travel when riding
    $("wx-arrow").style.transform = `rotate(${(W.dir + 180 - (moving ? live.heading : 0) + 360) % 360}deg)`;
    if (moving && W.wind >= 3) $("wx-rel").textContent = windOn(W, live.heading);
    else $("wx-rel").textContent = W.wind < 3 ? "Calm" : "—";
    const wc = W.wind >= 3 ? windNow(now) : null;
    $("wx-cost").textContent = wc && Math.abs(wc.drag) >= 0.05 ? `${dragTxt(wc)} drag · ${wc.watts >= 0 ? "" : "saves "}≈${Math.abs(Math.round(wc.watts))} W` : "";
    const next = wx.alerts.find(a => a.at > now - 15 * 60e3);
    $("wx-src").textContent = next ? next.text.replace(/[.:].*$/, "").replace(/^Rain in about (\d+) minutes/, "Rain in ~$1 min") : wx.src === "Live" ? `Live · ${hhmm(wx.at)}` : "Forecast from the sync";
  }
  const windOn = (W, course) => {
    const along = W.wind * Math.cos((W.dir - course) * Math.PI / 180);
    const side = Math.sin((W.dir - course) * Math.PI / 180) > 0 ? "right" : "left";
    return Math.abs(along) < 0.35 * W.wind ? `Crosswind from the ${side}` : along > 0 ? `Headwind ${windTxt(along)} ${windU()}` : `Tailwind ${windTxt(-along)} ${windU()}`;
  };
  // ── the wind's cost, like Wahoo's AirDrag / AirBoost but estimated: the ACE measures the air with a sensor; the phone
  //    takes the forecast wind (10 m up, cut to rider height), turns it onto your direction of travel and works out
  //    the extra (or missing) drag, the watts it costs at your speed, and what it's done to your time so far.
  const surfaceOf = () => (P.profile === "fastbike" ? "road" : P.profile === "mtb" ? "mtb" : "gravel");
  /** @returns {{drag: number, watts: number, vCalm: number, head: number} | null} */
  function windNow(now = Date.now(), spd = speedNow(now)) {
    const W = wx.cur;
    if (!W || TR.virtual || trainerLive(now) || spd == null || spd < 2 || live.heading == null || now - live.gpsAt > 8000) return null;
    const head = W.wind / 3.6 * C.RIDER_WIND * Math.cos((W.dir - live.heading) * Math.PI / 180), gr = gradeNow();
    const c = C.windCost(spd, head, (gr ?? 0) / 100, { mass: P.weight + 11, surface: surfaceOf() });
    return c && { ...c, head };
  }
  const dragTxt = c => `${c.drag >= 0 ? "+" : "−"}${Math.abs(Math.round(c.drag * 100))}%`;
  const windSoFar = () => !S.windSecs ? "" : Math.abs(S.windSec) < 5 ? "even so far" : `${clock(Math.abs(S.windSec))} ${S.windSec > 0 ? "lost" : "gained"} so far`;

  // ── routes: GPX / TCX in, kept on this phone, one chosen for the ride ─────────────────────────────────────
  const NAV = { route: null, nav: null, st: null, detour: null, pace: null, ghosts: null, routing: false, lastReroute: 0, lastAt: 0, names: new Map(), offSaid: false, lastWrong: 0, avoid: [] };
  /** The road ahead when no route is loaded (Summit Freeride): the way you're most likely riding, from the map, with its
   *  heights and climbs; rebuilt as you go. */
  const FREE = { route: null, st: null, names: [], at: 0, tried: 0, busy: false, why: "", said: /** @type {[string, any][]} */ ([]), offSince: 0 };
  const saidNear = (kind, p) => FREE.said.some(([k, q]) => k === kind && hav(q, p) < 250);
  const routeMsg = $("route-msg");
  async function importFile(file) {
    const text = await file.text();
    const raw = C.parseRoute(text, file.name || "");
    const id = uid();
    const route = C.analyze({ ...raw, id });
    const row = C.storable(raw, { id, added: Date.now(), dist: route.total, gain: route.gain, climbs: route.climbs.length, turns: route.turns.length });
    await DB.put("routes", row);
    if (!route.hasEle) fillElevation(row).catch(() => {});   // no heights in the file: ask Open-Meteo (the rest works without)
    return row;
  }
  async function importFiles(files) {
    let last = null, n = 0;
    for (const f of files) {
      try { last = await importFile(f); n++; } catch (e) { routeMsg.textContent = `${f.name || "That file"}: ${(e && e.message) || e}`; }
    }
    if (last) { await useRoute(last.id); routeMsg.textContent = n > 1 ? `${n} routes loaded.` : `Loaded “${last.name}”.`; }
    await paintRoutes();
    return last;
  }
  /** The next race's course from the sync (build.ride_config → race.course, the organizer's GPX thinned to 1.5 m): kept as a
   *  route under its own id, so it's loaded once and its map saved for offline, and chosen on race morning (once: pick
   *  another route after that and it stays picked). The config can come from a link, so every point is checked. */
  async function raceCourse() {
    const race = cfg.race, c = race && race.course;
    if (!c || typeof c.id !== "string" || !/^course-[a-z0-9-]{1,80}$/.test(c.id) || !Array.isArray(c.points)) return;
    let row = await DB.get("routes", c.id).catch(() => null);
    if (!row) {
      const points = c.points.filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180)
        .map(p => ({ lat: p[0], lon: p[1], ele: Number.isFinite(p[2]) ? p[2] : null }));
      if (points.length < 2) return;
      const raw = { name: String(c.name || race.name || "Race course").slice(0, 80), points, marks: [] }, route = C.analyze({ ...raw, id: c.id });
      row = C.storable(raw, { id: c.id, added: Date.now(), dist: route.total, gain: route.gain, climbs: route.climbs.length, turns: route.turns.length, race: race.date });
      await DB.put("routes", row);
      if (navigator.onLine) downloadMap(route, true);
    } else if (!row.offline && navigator.onLine) downloadMap(C.analyze(C.unstore(row)), true);
    const key = "fitness-race-course-chosen";
    if (race.date === iso(today) && ls.get(key) !== race.date && !S.running && (!NAV.route || NAV.route.id !== c.id)) {
      await useRoute(c.id);
      ls.set(key, race.date);
      routeMsg.textContent = `Race morning: “${row.name}” is loaded.`;
    }
  }
  /** Heights for a route that came without them: Open-Meteo's elevation API, 100 points a call, every ~100 m. */
  async function fillElevation(row) {
    const pts = row.points, every = Math.max(1, Math.floor(pts.length / Math.max(2, Math.min(pts.length, Math.ceil((row.dist || 0) / 100)))));
    const pick = [];
    for (let i = 0; i < pts.length; i += every) pick.push(i);
    if (pick[pick.length - 1] !== pts.length - 1) pick.push(pts.length - 1);
    const heights = new Map();
    for (let k = 0; k < pick.length; k += 100) {
      const part = pick.slice(k, k + 100);
      const q = new URLSearchParams({ latitude: part.map(i => pts[i][0].toFixed(5)).join(","), longitude: part.map(i => pts[i][1].toFixed(5)).join(",") });
      const r = await timed(`https://api.open-meteo.com/v1/elevation?${q}`, 10000);
      if (!r.ok) throw new Error(`elevation ${r.status}`);
      const j = await r.json();
      part.forEach((i, n) => { if (j.elevation && Number.isFinite(j.elevation[n])) heights.set(i, j.elevation[n]); });
    }
    let a = 0;
    for (const b of pick) {
      if (!heights.has(b)) continue;
      for (let i = a; i <= b; i++) { const ea = heights.get(a) ?? heights.get(b), eb = heights.get(b); pts[i][2] = Math.round((ea + (eb - ea) * (b === a ? 0 : (i - a) / (b - a))) * 10) / 10; }
      a = b;
    }
    const route = C.analyze(C.unstore(row));
    Object.assign(row, { gain: route.gain, climbs: route.climbs.length });
    await DB.put("routes", row);
    if (NAV.route && NAV.route.id === row.id) await useRoute(row.id, true);
    paintRoutes();
  }
  async function useRoute(id, keepProgress = false) {
    const row = id ? await DB.get("routes", id).catch(() => null) : null;
    if (!row) { NAV.route = NAV.nav = NAV.st = NAV.detour = NAV.pace = NAV.ghosts = null; ls.set("fitness-ride-route", null); paintRouteBits(); mapRoute(); return; }
    const route = C.analyze(C.unstore(row));
    const along = keepProgress && NAV.nav ? NAV.nav.state.along : S.running ? S.navAlong : 0;
    NAV.route = route; NAV.nav = C.navigator(route, { startAlong: along }); NAV.st = NAV.nav.status(); NAV.detour = null; NAV.avoid = []; NAV.names.clear();
    ls.set("fitness-ride-route", id);
    addPlaces(route, row); loadPace(row); findGhosts(route).catch(() => {}); placesAlong(route, row);
    if (!keepProgress) { S.paceSaid = -1; S.ghostSaid = 0; if (!S.running || S.navAlong < 300) { S.routeT0 = null; S.mine = []; } }
    paintRouteBits();
    mapRoute();
    if (navigator.onLine) downloadMap(route, true);
  }
  function paintRouteBits() {
    const r = NAV.route;
    $("route-name").textContent = r ? `${r.name} · ${distTxt(r.total)} ${unitD()}${r.hasEle ? ` · ${eleTxt(r.gain)} ${unitE()} up` : ""}` : "No route loaded";
    $("ahead-empty").hidden = !!r; $("ahead").hidden = !r;
    renderAhead(true);
  }
  async function paintRoutes() {
    const rows = (await DB.all("routes").catch(() => [])).sort((a, b) => b.added - a.added);
    const cur = NAV.route && NAV.route.id;
    $("route-list").innerHTML = rows.length ? rows.map(r => `<li class="${r.id === cur ? "cur" : ""}">
      <div class="rl-main"><b>${esc(r.name)}</b><span>${distTxt(r.dist || 0)} ${unitD()}${r.gain ? ` · ${eleTxt(r.gain)} ${unitE()} up` : ""}${r.climbs ? ` · ${r.climbs} climb${r.climbs === 1 ? "" : "s"}` : ""}${r.offline ? " · map saved" : ""}</span></div>
      <div class="rl-btns">${r.id === cur ? `<span class="chip ghost">Riding</span>` : `<button type="button" class="chip primary" data-use="${esc(r.id)}">Ride it</button>`}
        <button type="button" class="chip" data-rev="${esc(r.id)}" aria-label="Reverse ${esc(r.name)}">Reverse</button>
        <button type="button" class="chip" data-get="${esc(r.id)}" aria-label="Download ${esc(r.name)} as GPX">GPX</button>
        <button type="button" class="chip" data-del="${esc(r.id)}" aria-label="Delete ${esc(r.name)}">Delete</button></div></li>`).join("")
      : `<li class="none">No routes yet.</li>`;
  }
  $("route-list").addEventListener("click", async e => {
    const b = /** @type {HTMLElement} */ (e.target).closest("button");
    if (!b) return;
    if (b.dataset.use) { await useRoute(b.dataset.use); routeMsg.textContent = "Route chosen."; }
    else if (b.dataset.rev) {
      const row = await DB.get("routes", b.dataset.rev), raw = C.reversed(C.unstore(row)), id = uid(), route = C.analyze({ ...raw, id });
      await DB.put("routes", C.storable(raw, { id, added: Date.now(), dist: route.total, gain: route.gain, climbs: route.climbs.length, turns: route.turns.length }));
      await useRoute(id); routeMsg.textContent = "Reversed copy made and chosen.";
    } else if (b.dataset.get) {
      const row = await DB.get("routes", b.dataset.get);
      download(new Blob([C.routeGPX(C.analyze(C.unstore(row)))], { type: "application/gpx+xml" }), `${slug(row.name)}.gpx`);
    } else if (b.dataset.del) {
      if (!await ask("Delete this route?", "It's removed from this phone; the file you loaded it from isn't touched.", "Delete")) return;
      await DB.del("routes", b.dataset.del);
      if (NAV.route && NAV.route.id === b.dataset.del) await useRoute(null);
    }
    paintRoutes();
  });
  $("route-file").addEventListener("change", async e => {
    const input = /** @type {HTMLInputElement} */ (e.target);
    if (input.files && input.files.length) await importFiles([...input.files]);
    input.value = "";
  });
  $("route-clear").addEventListener("click", async () => { await useRoute(null); paintRoutes(); routeMsg.textContent = "Riding without a route."; });
  const openRoutes = () => { routeMsg.textContent = ""; paintRoutes(); $("routes").showModal(); };
  $("btn-routes").addEventListener("click", openRoutes);
  $("btn-routes-2").addEventListener("click", openRoutes);
  // a route shared from another app (Android's share sheet → the service worker's inbox), or opened as a file (desktop)
  async function inbox() {
    if (!("caches" in window)) return;
    const cache = await caches.open("fitness-inbox"), keys = await cache.keys();
    const files = [];
    for (const k of keys) { const r = await cache.match(k); if (r) files.push(new File([await r.blob()], decodeURIComponent(r.headers.get("x-name") || "route.gpx"))); await cache.delete(k); }
    if (files.length) { await importFiles(files); openRoutes(); }
  }
  if (new URLSearchParams(location.search).has("inbox")) { inbox().catch(() => {}); history.replaceState(null, "", location.pathname); }
  const lq = /** @type {any} */ (window).launchQueue;
  if (lq && typeof lq.setConsumer === "function") lq.setConsumer(async p => { if (p.files && p.files.length) { await importFiles(await Promise.all(p.files.map(h => h.getFile()))); openRoutes(); } });
  document.addEventListener("dragover", e => e.preventDefault());
  document.addEventListener("drop", e => { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files.length) importFiles([...e.dataTransfer.files]).then(openRoutes); });

  // ── offline map: every tile along the route (zoom 8–14, ±800 m) into the phone's cache, plus the style and fonts ──
  const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
  const TILES = "fitness-tiles";
  async function downloadMap(route, quiet = false) {
    if (!("caches" in window) || !navigator.onLine) return;
    const row = await DB.get("routes", route.id).catch(() => null);
    if (!row || row.offline) return;
    try {
      const cache = await caches.open(TILES);
      const grab = async url => { if (await cache.match(url)) return true; const r = await timed(url, 15000, { mode: "cors" }); if (r.ok) { await cache.put(url, r.clone()); return true; } return false; };
      const style = await (await timed(STYLE_URL, 10000)).json();
      await cache.put(STYLE_URL, new Response(JSON.stringify(style), { headers: { "Content-Type": "application/json" } }));
      const src = Object.values(style.sources || {}).find(s => /** @type {any} */ (s).type === "vector" && /** @type {any} */ (s).url);
      if (!src) return;
      const tj = await (await timed(/** @type {any} */ (src).url, 10000)).json();
      await cache.put(/** @type {any} */ (src).url, new Response(JSON.stringify(tj), { headers: { "Content-Type": "application/json" } }));
      const tmpl = tj.tiles && tj.tiles[0];
      if (!tmpl) return;
      const extra = [];
      if (style.sprite) for (const s of [style.sprite, `${style.sprite}@2x`]) extra.push(`${s}.json`, `${s}.png`);
      const fonts = new Set();
      for (const l of style.layers || []) { const f = l.layout && l.layout["text-font"]; if (Array.isArray(f) && typeof f[0] === "string") fonts.add(f.join(",")); }
      if (style.glyphs) for (const f of fonts) for (const r of ["0-255", "256-511", "8192-8447"]) extra.push(style.glyphs.replace("{fontstack}", encodeURIComponent(f)).replace("{range}", r));
      const tiles = C.corridorTiles(route).map(t => tmpl.replace("{z}", t.z).replace("{x}", t.x).replace("{y}", t.y));
      const all = [...extra, ...tiles];
      let done = 0, ok = 0;
      try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
      const work = all.slice();
      const worker = async () => { while (work.length) { const u = work.shift(); try { if (await grab(u)) ok++; } catch { /* skip one */ } done++; if (!quiet && done % 25 === 0) routeMsg.textContent = `Saving the map for offline: ${Math.round(done / all.length * 100)}%`; } };
      await Promise.all([worker(), worker(), worker(), worker()]);
      if (ok >= all.length * 0.95) { row.offline = Date.now(); await DB.put("routes", row); }
      if (!quiet) routeMsg.textContent = `Map saved for offline: ${tiles.length} tiles along the route.`;
      paintRoutes();
    } catch { if (!quiet) routeMsg.textContent = "Couldn't save the map (no signal?). It still works online."; }
  }

  // ── your own past rides on this route: a ghost to race (your best and your last), and your times on its climbs ──
  const signed = s => `${Math.floor(Math.abs(s) / 60)}:${String(Math.round(Math.abs(s) % 60)).padStart(2, "0")}`;
  const aheadSay = s => { const a = Math.abs(Math.round(s)), m = Math.floor(a / 60), x = a % 60; return `${m ? `${m} minute${m === 1 ? "" : "s"}${x ? ` ${x}` : ""}` : `${x} second${x === 1 ? "" : "s"}`}`; };
  async function findGhosts(route) {
    NAV.ghosts = null;
    const rides = (await DB.all("rides").catch(() => [])).filter(r => !r.indoor).sort((a, b) => b.start - a.start).slice(0, 40), out = [];
    for (const r of rides) {
      if (r.startLL && hav({ lat: r.startLL[0], lon: r.startLL[1] }, route.pts[0]) > 1500) continue;   // started elsewhere: not this route
      const g = C.ghostOf(route, await rideSamples(r));
      if (g) out.push({ id: r.id, name: r.name, start: r.start, g, full: g.covered >= 0.95, climbs: C.climbTimes(route, g) });
      if (NAV.route !== route) return;   // another route was chosen meanwhile
    }
    if (!out.length) { renderAhead(true); return; }
    const full = out.filter(x => x.full).sort((a, b) => a.g.total - b.g.total);
    NAV.ghosts = { best: full[0] || null, last: out.slice().sort((a, b) => b.start - a.start)[0], n: out.length,
      climbBest: route.climbs.map((_, i) => { const ts = out.map(x => x.climbs[i]).filter(t => t != null); return ts.length ? Math.min(...ts) : null; }) };
    renderAhead(true);
  }
  /** Your ride clock on this route (from where you joined it near its start), and the clock at each 50 m passed. */
  function trackMine() {
    const st = NAV.st;
    if (!S.running || !NAV.route || !st || st.offCourse || NAV.detour) return;
    if (S.routeT0 == null) { if (st.along > 300) return; S.routeT0 = S.elapsed; S.mine = []; }
    const k = Math.floor(st.along / 50);
    while (S.mine.length <= k && S.mine.length < 20000) S.mine.push(Math.round(S.elapsed - S.routeT0));
  }
  const myClock = () => (S.routeT0 == null ? null : S.elapsed - S.routeT0);
  /** Your clock against a ghost's at the same place: + behind, − ahead. */
  const vsGhost = gh => { const me = myClock(), st = NAV.st; if (me == null || !gh || !st) return null; const t = C.ghostAt(gh.g, st.along); return t == null ? null : me - t; };
  const mineAt = along => { const i = Math.floor(along / 50); return i < S.mine.length ? S.mine[i] : null; };
  function climbDone(climb) {
    const i = NAV.route ? NAV.route.climbs.indexOf(climb) : -1, a = mineAt(climb.start), me = myClock();
    if (i < 0 || a == null || me == null) { say("Top of the climb.", false); return; }
    const t = me - a, best = NAV.ghosts && NAV.ghosts.climbBest[i];
    say(`Top. ${aheadSay(t)}${best ? (t < best - 1 ? `, ${aheadSay(best - t)} faster than your best: a new record` : `, ${aheadSay(t - best)} off your best`) : ""}.`, false);
    if (best && t < best - 1) { NAV.ghosts.climbBest[i] = t; beep(1320, 120, 3); }
  }
  /** Every quarter of the route: how you stand against your best. */
  function ghostCallout() {
    const G = NAV.ghosts, st = NAV.st;
    if (!G || !G.best || !st || !S.running) return;
    const q = Math.floor(st.frac * 4);
    if (q <= S.ghostSaid || q >= 4) return;
    S.ghostSaid = q;
    const d = vsGhost(G.best);
    if (d != null) say(`${q * 25} percent: ${aheadSay(d)} ${d <= 0 ? "ahead of" : "behind"} your best.`, false);
  }

  // ── the race plan: watts and heart rate for each section of the route, for a finish time (Power Guide) ─────────
  const parseHM = s => { const m = String(s || "").trim().match(/^(\d{1,2})(?::(\d{1,2}))?$/); return m ? (+m[1] * 60 + +(m[2] || 0)) * 60 : null; };
  const fmtHM = sec => { const m = Math.round(sec / 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };
  const paceOpts = surface => ({ ftp: ftpNow(), mass: P.weight + 10, surface });
  const hrBand = watts => { const pct = C.hrPctFor(watts / ftpNow() * 100); return [Math.round(P.lthr * pct / 100) - 4, Math.round(P.lthr * pct / 100) + 4]; };
  const KIND_NAME = { climb: "Climb", flat: "Flat", descent: "Descent" };
  async function loadPace(row) {
    NAV.pace = null;
    if (!row || !row.pace || !NAV.route || !NAV.route.hasEle) return;
    NAV.pace = C.pacePlan(NAV.route, { ...paceOpts(row.pace.surface), target: row.pace.target });
  }
  function paintPlan(plan) {
    const list = $("pc-list"), sum = $("pc-sum");
    if (!plan) { list.replaceChildren(); return; }
    const over = plan.if != null && plan.if > plan.sustain + 0.02;
    sum.textContent = `${fmtHM(plan.total)} at ${plan.base} W on the flat (normalised ${plan.np} W, ${Math.round((plan.if || 0) * 100)}% of ${ftpNow()} W FTP${P.ftp ? "" : " (estimated)"}). `
      + (over ? `That's more than you can hold for ${fmtHM(plan.total)} (about ${Math.round(plan.sustain * 100)}%): pick a slower time.` : `Holdable for that long (up to about ${Math.round(plan.sustain * 100)}%).`);
    sum.classList.toggle("warn", over);
    list.replaceChildren(...plan.sections.map((s, i) => {
      const li = document.createElement("li"), n = document.createElement("b"), what = document.createElement("span"), t = document.createElement("span");
      n.textContent = String(i + 1);
      const [lo, hi] = hrBand(s.watts);
      what.textContent = `${KIND_NAME[s.kind]} ${distTxt(s.len)} ${unitD()}${s.kind !== "flat" ? ` at ${(s.grade * 100).toFixed(1)}%` : ""} · ${s.watts > 20 ? `${s.watts} W · ${lo}–${hi} bpm` : "coast, eat, drink"} · ${speedTxt(s.speed)} ${unitS()}`;
      t.className = "t"; t.textContent = fmtHM(s.end);
      li.append(n, what, t);
      return li;
    }));
  }
  let draftPlan = null;
  const planFromDialog = () => {
    const target = parseHM(/** @type {HTMLInputElement} */ ($("pc-time")).value);
    if (!target || !NAV.route) return null;
    return C.pacePlan(NAV.route, { ...paceOpts(/** @type {HTMLSelectElement} */ ($("pc-surface")).value), target });
  };
  $("btn-pace").addEventListener("click", async () => {
    if (!NAV.route) return;
    if (!NAV.route.hasEle) { $("pc-sum").textContent = "This route has no heights yet (they're on their way from Open-Meteo): a plan needs them."; }
    const row = await DB.get("routes", NAV.route.id).catch(() => null);
    /** @type {HTMLSelectElement} */ ($("pc-surface")).value = row && row.pace ? row.pace.surface : /iceman|mtb|single|trail/i.test(NAV.route.name) ? "mtb" : /barry|roubaix|gravel/i.test(NAV.route.name) ? "gravel" : "road";
    /** @type {HTMLInputElement} */ ($("pc-time")).value = row && row.pace ? fmtHM(row.pace.target) : "";
    draftPlan = NAV.route.hasEle && row && row.pace ? planFromDialog() : null;
    if (NAV.route.hasEle) { $("pc-sum").textContent = draftPlan ? "" : "Type a finish time, or ask for the fastest you can hold."; paintPlan(draftPlan); }
    $("pace").showModal();
  });
  $("pc-suggest").addEventListener("click", () => {
    if (!NAV.route || !NAV.route.hasEle) return;
    const t = C.paceSuggest(NAV.route, paceOpts(/** @type {HTMLSelectElement} */ ($("pc-surface")).value));
    /** @type {HTMLInputElement} */ ($("pc-time")).value = fmtHM(t);
    draftPlan = planFromDialog(); paintPlan(draftPlan);
  });
  for (const id of ["pc-show", "pc-surface"]) $(id).addEventListener(id === "pc-show" ? "click" : "change", () => { if (NAV.route && NAV.route.hasEle) { draftPlan = planFromDialog(); if (draftPlan) paintPlan(draftPlan); else $("pc-sum").textContent = "A finish time like 4:30, please."; } });
  $("pc-save").addEventListener("click", async () => {
    draftPlan = planFromDialog();
    if (!draftPlan || !NAV.route) { $("pc-sum").textContent = "A finish time like 4:30, please."; return; }
    const row = await DB.get("routes", NAV.route.id);
    row.pace = { target: draftPlan.target, surface: draftPlan.surface };
    await DB.put("routes", row);
    NAV.pace = draftPlan; S.paceSaid = -1;
    $("pace").close(); renderAhead(true); render();
  });
  $("pc-clear").addEventListener("click", async () => {
    if (NAV.route) { const row = await DB.get("routes", NAV.route.id); if (row) { delete row.pace; await DB.put("routes", row); } }
    NAV.pace = null; $("pace").close(); renderAhead(true); render();
  });
  /** Where you are in the plan: the section, its targets, and your clock against the plan's (+ behind). */
  function paceNow() {
    const plan = NAV.pace, st = NAV.st, me = myClock();
    if (!plan || !st) return null;
    const at = C.paceAt(plan, st.along);
    return { ...at, delta: me == null || me < 30 ? null : me - at.planned, hr: hrBand(at.section.watts) };
  }
  /** On the ride: a word at each new section, and a warning when the first half is ridden too hot. */
  function paceCoach(now) {
    const p = paceNow();
    if (!p || !S.running || S.paused) return;
    const s = p.section;
    if (p.i !== S.paceSaid) {
      S.paceSaid = p.i; S.paceHot = 0;
      say(s.watts > 20 ? `${KIND_NAME[s.kind]}, ${nearSay(s.len)}: ${P.ftp && live.powerAt ? `${s.watts} watts` : `heart rate ${p.hr[0]} to ${p.hr[1]}`}${p.delta != null ? `. ${aheadSay(p.delta)} ${p.delta <= 0 ? "ahead of" : "behind"} the plan` : ""}.`
        : `${KIND_NAME[s.kind]}, ${nearSay(s.len)}: coast, eat and drink.`, false);
    }
    const w = now - live.powerAt < 4000 ? pw10() : null, hr = live.hr && now - live.hrAt < 5000 ? live.hr : null;
    const hot = (w != null && w > s.watts * 1.12 + 10) || (w == null && hr != null && hr > p.hr[1] + 5);
    S.paceHot = hot && !rolling() ? S.paceHot + 1 : 0;
    if (S.paceHot === 90 && NAV.st.frac < 0.6) say("Over the plan here: that's spent from the finish. Ease to the target.", false);
  }

  // ── going somewhere: home, a loop of a given length, a point on the map, and what's nearby ───────────────────
  const goMsg = $("go-msg");
  /** A new route from here through some points (BRouter; offline from the saved map when there's no signal), kept and ridden. */
  async function routeTo(points, name) {
    const fix = live.lastFix;
    if (!fix) { goMsg.textContent = "Waiting for a GPS fix: start the ride or step outside."; return null; }
    goMsg.textContent = "Finding the way…";
    let raw = null;
    try {
      const res = await timed(C.brouterVia([fix, ...points], P.profile), 20000);
      if (res.ok) { const j = await res.json(); raw = C.parseRoute(JSON.stringify(j), `${name}.geojson`); }
    } catch { /* no signal: try the saved map */ }
    if (!raw && points.length === 1) {
      const got = await offlineWays(fix, [{ ...points[0], along: 0 }], [], name);
      if (got[0] && got[0].detour) raw = { name, points: got[0].detour.pts.map(p => ({ lat: p.lat, lon: p.lon, ele: null })), marks: [] };
    }
    if (!raw) { goMsg.textContent = "No way found: no signal, and no saved map between here and there."; return null; }
    return adoptMade(raw, name);
  }
  /** A route made on the bars: kept on the phone and ridden from here (its start is where you are). */
  async function adoptMade(raw, name) {
    raw.name = name;
    const id = uid(), route = C.analyze({ ...raw, id });
    const row = C.storable(raw, { id, added: Date.now(), dist: route.total, gain: route.gain, climbs: route.climbs.length, turns: route.turns.length, made: true });
    await DB.put("routes", row);
    if (!route.hasEle) fillElevation(row).catch(() => {});
    S.navAlong = 0;   // a new route starts here, whatever the last one had reached
    await useRoute(id);
    goMsg.textContent = `${name}: ${distTxt(route.total)} ${unitD()}.`;
    say(`${name}. ${nearSay(route.total)}.`, false);
    return route;
  }
  const home = () => jget("fitness-ride-home", null);
  $("go-sethome").addEventListener("click", () => {
    const f = live.lastFix;
    if (!f) { goMsg.textContent = "No GPS fix yet: try again outside."; startGps(); return; }
    ls.set("fitness-ride-home", JSON.stringify({ lat: Math.round(f.lat * 1e5) / 1e5, lon: Math.round(f.lon * 1e5) / 1e5 }));
    goMsg.textContent = "Home saved on this phone.";
  });
  $("go-home").addEventListener("click", async () => {
    const h = home();
    if (!h) { goMsg.textContent = "Set home first: tap “Set home here” when you're there."; return; }
    if (await routeTo([h], "Home")) $("goto").close();
  });
  let loopTry = 0;
  async function makeLoop(again) {
    const f = live.lastFix;
    if (!f) { goMsg.textContent = "Waiting for a GPS fix."; startGps(); return; }
    const want = (+(/** @type {HTMLInputElement} */ ($("go-loop-n")).value) || 20) * (P.km ? 1000 : 1609.344);
    loopTry = again ? loopTry + 1 : 0;
    if (!wx.cur) await refreshWx();   // the wind decides which way round
    const into = wx.cur ? wx.cur.dir : 0, bearing = (into + [0, 40, -40, 80, -80][loopTry % 5] + 360) % 360;
    let scale = 1, route = null;
    for (let i = 0; i < 2; i++) {
      route = await routeTo([...C.loopPoints(f, want, bearing, scale), f], `Loop ${Math.round(want / (P.km ? 1000 : 1609.344))} ${unitD()}`);
      if (!route || Math.abs(route.total - want) / want < 0.2) break;
      scale *= want / route.total;   // roads went the long way round (or the short): once more, resized
    }
    if (route) $("goto").close();
  }
  // back to the start: the way you came, turn by turn (your own track, reversed: the climbs and all), or the quickest way
  $("go-retrace").addEventListener("click", async () => {
    if (samples.filter(x => x[1] != null).length < 20) { goMsg.textContent = "Nothing to retrace yet: your track starts when the ride does."; return; }
    let raw;
    try { raw = C.reversed(C.rideRoute("Retrace", samples)); } catch (e) { goMsg.textContent = (e && e.message) || String(e); return; }
    if (await adoptMade({ ...raw, marks: [] }, "Retrace to the start")) $("goto").close();
  });
  $("go-start").addEventListener("click", async () => {
    const first = samples.find(x => x[1] != null);
    if (!first) { goMsg.textContent = "No start yet: your track begins when the ride does."; return; }
    if (await routeTo([{ lat: first[1], lon: first[2] }], "Back to the start")) $("goto").close();
  });
  $("go-loop").addEventListener("click", () => makeLoop(false));
  $("go-loop-again").addEventListener("click", () => makeLoop(true));
  const OVERPASS = "https://overpass-api.de/api/interpreter";
  const overpass = async (q, ms = 25000) => { const r = await timed(OVERPASS, ms, { method: "POST", body: new URLSearchParams({ data: q }) }); if (!r.ok) throw new Error(`places ${r.status}`); return C.fromOverpass(await r.json()); };
  document.querySelectorAll("[data-near]").forEach(b => b.insertAdjacentHTML("afterbegin", picto(/** @type {HTMLElement} */ (b).dataset.near)));
  document.querySelectorAll("[data-near]").forEach(b => b.addEventListener("click", async () => {
    const kind = /** @type {HTMLElement} */ (b).dataset.near, f = live.lastFix, list = $("near-list");
    if (!f) { goMsg.textContent = "Waiting for a GPS fix."; startGps(); return; }
    goMsg.textContent = "Looking nearby…"; list.replaceChildren();
    let all;
    try { all = await overpass(C.overpassQuery([f], 3000)); } catch { goMsg.textContent = "Couldn't look (no signal?). Places along a route are saved with it."; return; }
    const found = all.filter(p => p.kind === kind).map(p => ({ ...p, d: hav(f, p) })).sort((a, b) => a.d - b.d).slice(0, 12);
    goMsg.textContent = found.length ? "" : "Nothing within 3 km in OpenStreetMap.";
    list.replaceChildren(...found.map(p => {
      const li = document.createElement("li"), main = document.createElement("div"), nm = document.createElement("b"), sub = document.createElement("span"), go = document.createElement("button");
      main.className = "rl-main"; nm.textContent = p.name; nm.insertAdjacentHTML("afterbegin", picto(kind)); sub.textContent = `${nearTxt(p.d)} ${compass(bearing(f, p))}${p.hours ? ` · ${p.hours}` : ""}`;
      main.append(nm, sub);
      go.type = "button"; go.className = "chip primary"; go.textContent = "Go";
      go.addEventListener("click", async () => { if (await routeTo([{ lat: p.lat, lon: p.lon }], p.name)) $("goto").close(); });
      const btns = document.createElement("div"); btns.className = "rl-btns"; btns.append(go);
      li.append(main, btns);
      return li;
    }));
  }));
  $("btn-goto").addEventListener("click", () => { goMsg.textContent = ""; $("go-loop-l").firstChild.nodeValue = `A loop of (${unitD()}) `; $("near-list").replaceChildren(); startGps(); $("goto").showModal(); });
  // a long press on the map: ride there
  let goPoint = null;
  function offerGo(lng, lat) {
    goPoint = { lat, lon: lng };
    const f = live.lastFix;
    $("mapgo-text").textContent = f ? `${nearTxt(hav(f, goPoint))} ${compass(bearing(f, goPoint))} as the crow flies` : "Ride here?";
    $("mapgo").hidden = false;
  }
  $("mapgo-no").addEventListener("click", () => { $("mapgo").hidden = true; goPoint = null; });
  $("mapgo-yes").addEventListener("click", async () => { if (!goPoint) return; $("mapgo").hidden = true; const r = await routeTo([goPoint], "To the pin"); if (!r) mapNote(goMsg.textContent); });
  /** Water, food, restrooms and bike shops within 150 m of the route, from OpenStreetMap: fetched once with a signal,
   *  kept with the route, and listed with its own stops on Ahead. */
  async function placesAlong(route, row) {
    if (!row || row.osmAt || !navigator.onLine || route.total > 400000) return;
    try {
      const found = await overpass(C.overpassQuery(C.thin(route, 300), 150), 40000);
      row.osm = found.map(p => [Math.round(p.lat * 1e5) / 1e5, Math.round(p.lon * 1e5) / 1e5, p.kind, p.name, p.hours]);
      row.osmAt = Date.now();
      await DB.put("routes", row);
      if (NAV.route === route) addPlaces(route, row);
    } catch { /* next time it's loaded with a signal */ }
  }
  function addPlaces(route, row) {
    if (!row || !Array.isArray(row.osm)) return;
    const have = new Set(route.pois.map(q => `${q.kind}:${Math.round(q.along / 50)}`));
    for (const [lat, lon, kind, name, hours] of row.osm) {
      const pr = C.project(route, { lat, lon });
      if (pr.off > 150 || have.has(`${kind}:${Math.round(pr.along / 50)}`)) continue;
      route.pois.push({ along: pr.along, off: pr.off, lat, lon, name: String(name || ""), desc: hours ? String(hours) : "", kind, src: "osm" });
    }
    route.pois.sort((a, b) => a.along - b.along);
    renderAhead(true); mapRoute();
  }

  // ── navigation: position on the route, turns, off course and detours ──────────────────────────────────────
  const KIND_WORD = { bike: "Bike shop", water: "Water", food: "Food", aid: "Aid station", summit: "Summit", danger: "Caution", toilet: "Restroom", sprint: "Sprint", valley: "Valley", finish: "Finish", generic: "" };
  const active = () => NAV.detour ? NAV.detour : NAV.route ? { route: NAV.route, nav: NAV.nav } : null;
  const turnText = t => {
    if (!t) return "";
    const nm = t.name || NAV.names.get(Math.round(t.along)) || "";
    return `${C.TURN_WORDS[t.kind] || "Turn"}${nm ? (/^(take|turn|onto|at)\b/i.test(nm) || t.src === "file" ? ` · ${nm}` : ` onto ${nm}`) : ""}`;
  };
  function onFix(fix) {
    NAV.lastAt = Date.now();
    if (!NAV.route) { freeOnFix(fix); paintMap(fix); return; }
    const v = speedNow() ?? 0, now = Date.now();
    NAV.st = NAV.nav.update(fix, live.heading, v, now);
    if (S.running) S.navAlong = NAV.st.along;
    if (NAV.detour) {
      const d = NAV.detour.nav.update(fix, live.heading, v, now);
      NAV.detour.st = d;
      if ((!NAV.st.offCourse && NAV.st.along >= NAV.detour.target.along - 300) || d.left < 25) {   // back on the route
        NAV.detour = null; say("Back on the route."); beep(990, 120, 2); mapDetour();
      } else if (d.offCourse && v > 1 && now - NAV.lastReroute > 30000 && P.reroute) reroute("rejoin");
    } else if (NAV.st.offCourse) {
      if (!NAV.offSaid) { NAV.offSaid = true; say("Off course."); beep(440, 250, 2); buzz([300, 120, 300]); }
      if (P.reroute && S.running && v > 1 && now - NAV.lastReroute > 30000) reroute("rejoin");   // offline too, from the saved map
    } else if (NAV.offSaid) { NAV.offSaid = false; say("Back on course."); beep(990, 120); }
    if (NAV.st.wrongWay && now - NAV.lastWrong > 30000) { NAV.lastWrong = now; say("Wrong way. Turn around."); buzz([500, 200, 500]); }
    if (S.running && !S.paused) {
      const A = active();
      for (const c of A ? A.nav.callouts(v) : []) {
        if (c.kind === "turn-soon") say(`In ${nearSay(c.dist)}, ${turnText(c.turn).replace(" · ", ", ")}.`, false);
        else if (c.kind === "turn-now") { say(`${C.TURN_WORDS[c.turn.kind] || "Turn"} now.`); beep(1100, 140, 2); buzz([150, 80, 150]); }
        else if (c.kind === "climb") say(`Climb in ${nearSay(c.dist)}: ${nearSay(c.climb.len).replace(/^a /, "")} at ${(c.climb.grade * 100).toFixed(0)} percent, ${eleTxt(c.climb.gain)} ${P.km ? "metres" : "feet"} up.`, false);
        else if (c.kind === "top") climbDone(c.climb);
        else if (c.kind === "poi") say(`${KIND_WORD[c.poi.kind] || "Waypoint"} in ${nearSay(c.dist)}${c.poi.name && c.poi.name !== KIND_WORD[c.poi.kind] ? `: ${c.poi.name}` : ""}.`, false);
        else if (c.kind === "arrive" && !NAV.detour) { say("You've reached the end of the route."); beep(660, 300, 2); }
      }
    }
    paintMap(fix);
  }
  /** A way back to the route (or to its start) from BRouter, followed turn by turn until you're on the route again.
   *  Back to the route looks forward (RideCore navigator.rejoinOptions): up to three places on the route ahead of you
   *  are routed at once, the spot where you left the route is a no-go (the locked gate stays locked), and the best way
   *  is the shortest that doesn't start with a U-turn (RideCore.pickDetour). */
  async function reroute(kind) {
    const fix = live.lastFix;
    if (NAV.routing || !NAV.route || !fix) return;
    NAV.routing = true; NAV.lastReroute = Date.now();
    paintBanner();
    const heading = (speedNow() ?? 0) > 1.5 ? live.heading : null;
    const name = kind === "start" ? "To the start" : "Back to the route";
    let options = [{ along: 0, ...C.pointAt(NAV.route, 0) }], minAlong = 0;
    if (kind !== "start") {
      const r = NAV.nav.rejoinOptions(fix, heading);
      options = r.options; minAlong = r.minAlong;
      if (r.avoid && !NAV.avoid.some(g => hav(g, r.avoid) < 30)) NAV.avoid = [...NAV.avoid, r.avoid].slice(-3);
    }
    const ask = async option => {
      try {
        const res = await timed(C.brouterUrl(fix, option, P.profile, undefined, kind === "start" ? [] : NAV.avoid), 15000);
        return res.ok ? { detour: C.fromBRouter(await res.json(), name), option } : { detour: null, option };
      } catch { return { detour: null, option }; }
    };
    let tries = navigator.onLine ? await Promise.all(options.map(ask)) : [];
    let offline = false;
    if (!tries.some(t => t.detour)) { tries = await offlineWays(fix, options, kind === "start" ? [] : NAV.avoid, name); offline = tries.some(t => t.detour); }
    const best = C.pickDetour(NAV.route, tries, heading, minAlong);
    if (best) {
      const d = best.detour;
      NAV.detour = { route: d, nav: C.navigator(d), target: best.option, kind };
      NAV.detour.st = NAV.detour.nav.update(fix, live.heading, speedNow() ?? 0);
      const t = d.turns[0], skip = best.option.along - (NAV.nav.state.lastOnAlong || 0);
      say(kind === "start" ? `Directions to the start: ${nearSay(d.total)}.`
        : `Rerouting ahead${offline ? " on the offline map" : ""}. ${nearSay(d.total)} to rejoin the route${skip > 400 ? `, ${nearSay(skip)} further along it` : ""}.${t ? ` First, in ${nearSay(t.along)}, ${turnText(t).replace(" · ", ", ")}.` : ""}`);
      mapDetour();
    } else {
      const back = NAV.nav.toRoute(fix);
      note.textContent = `No way back found (no signal, and no saved map here). The route is ${nearTxt(back.dist)} ${compass(back.brg)} of you.`;
      if (S.running) say(`The route is ${nearSay(back.dist)} to the ${({ N: "north", NE: "northeast", E: "east", SE: "southeast", S: "south", SW: "southwest", W: "west", NW: "northwest" })[compass(back.brg)]}.`, false);
    }
    NAV.routing = false;
    paintBanner(); renderAhead(true);
  }
  /** No signal: the way back from the map tiles already on the phone (a downloaded route's corridor, and every tile the
   *  map has shown), over their roads and paths, one-ways and the no-go where you left the route included. */
  async function offlineWays(fix, options, avoid, name) {
    const none = options.map(option => ({ detour: null, option }));
    try {
      const tmpl = await tileTemplate();
      if (!tmpl) return none;
      const cache = await caches.open(TILES), road = [], named = [];
      for (const t of C.tilesAround([fix, ...options], 400)) {
        const res = await cache.match(tmpl.replace("{z}", t.z).replace("{x}", t.x).replace("{y}", t.y));
        if (!res) continue;
        let buf = new Uint8Array(await res.arrayBuffer());
        if (buf[0] === 0x1f && buf[1] === 0x8b) buf = new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
        const got = C.mvtLines(buf, t.z, t.x, t.y);
        road.push(...got.transportation); named.push(...got.transportation_name);
      }
      if (!road.length) return none;
      const g = C.roadGraph(C.nameRoads(road, named), avoid.map(a => ({ lat: a.lat, lon: a.lon, r: a.r || 40 })));
      const ways = C.shortestWays(g, fix, options, Math.max(8000, 4 * Math.max(...options.map(o => hav(fix, o)))));
      return options.map((option, i) => ({ detour: ways[i] && ways[i].points.length > 1 ? C.fromWay(ways[i], name) : null, option }));
    } catch { return none; }
  }
  /** The vector tiles' URL pattern, from the style and TileJSON saved with the offline map. */
  async function tileTemplate() {
    if (!("caches" in window)) return null;
    const cache = await caches.open(TILES), sres = await cache.match(STYLE_URL);
    if (!sres) return null;
    const style = await sres.json(), src = Object.values(style.sources || {}).find(s => /** @type {any} */ (s).type === "vector" && /** @type {any} */ (s).url);
    const tres = src && await cache.match(/** @type {any} */ (src).url);
    if (!tres) return null;
    const tj = await tres.json();
    return tj.tiles && tj.tiles[0] || null;
  }
  function paintBanner() {
    paintBannerInner();
    document.body.classList.toggle("nav", !$("navbanner").hidden);
  }
  function paintBannerInner() {
    const b = $("navbanner"), A = active(), page = curPage();
    if (!A || !NAV.st) { b.hidden = true; return; }
    const st = NAV.detour ? NAV.detour.st || NAV.detour.nav.status() : NAV.st;
    const act = $("nb-action");
    act.hidden = true;
    b.className = "navbanner";
    if (NAV.routing) { $("nb-arrow").textContent = "⟳"; $("nb-dist").textContent = ""; $("nb-what").textContent = "Finding a way back…"; b.hidden = false; return; }
    if (!NAV.detour && NAV.st.offCourse && live.lastFix) {
      const back = NAV.nav.toRoute(live.lastFix);
      b.classList.add("alert");
      $("nb-arrow").textContent = "↑"; $("nb-arrow").style.transform = `rotate(${(back.brg - (live.heading ?? 0) + 360) % 360}deg)`;
      $("nb-dist").textContent = nearTxt(back.dist); $("nb-what").textContent = ` Off course · the route is ${compass(back.brg)}`;
      act.textContent = "Reroute"; act.hidden = false; act.dataset.kind = "rejoin";
      b.hidden = false; return;
    }
    $("nb-arrow").style.transform = "";
    if (!NAV.detour && NAV.st.wrongWay) { b.classList.add("alert"); $("nb-arrow").textContent = "⮌"; $("nb-dist").textContent = ""; $("nb-what").textContent = "Wrong way — turn around"; b.hidden = false; return; }
    if (!NAV.detour && NAV.st.along < 50 && live.lastFix && hav(live.lastFix, NAV.route.pts[0]) > 250 && !NAV.route.loop) {
      $("nb-arrow").textContent = "⚑"; $("nb-dist").textContent = nearTxt(hav(live.lastFix, NAV.route.pts[0])); $("nb-what").textContent = " to the start of the route";
      act.textContent = "Directions"; act.hidden = false; act.dataset.kind = "start"; b.hidden = false; return;
    }
    const t = st.turn, far = Math.max(400, 40 * (speedNow() || 5));
    if (t && (page === "map" || page === "ahead" || st.toTurn <= far)) {
      if (st.toTurn <= Math.max(40, 7 * (speedNow() || 5))) b.classList.add("now");
      $("nb-arrow").textContent = C.TURN_ARROWS[t.kind] || "↑"; $("nb-dist").textContent = nearTxt(st.toTurn); $("nb-what").textContent = ` ${turnText(t)}`;
      b.hidden = false; return;
    }
    if (page === "map" && st.left > 0) { $("nb-arrow").textContent = "⚑"; $("nb-dist").textContent = nearTxt(st.left); $("nb-what").textContent = NAV.detour ? " back to the route" : " to the finish"; b.hidden = false; return; }
    b.hidden = true;
  }
  $("nb-action").addEventListener("click", e => reroute(/** @type {HTMLElement} */ (e.currentTarget).dataset.kind === "start" ? "start" : "rejoin"));

  // ── the map: MapLibre with OpenFreeMap's vector tiles; a drawn breadcrumb when there's no WebGL or no tiles ─────
  const MAP = { map: null, lib: null, loading: false, ready: false, failed: false, follow: true, zoom: 0, marker: null, markerOn: false, lastCam: 0, lastDone: 0, lastTrail: 0 };
  const mapNote = t => { const m = $("mapnote"); m.hidden = !t; m.textContent = t || ""; };
  async function ensureMap() {
    if (MAP.map || MAP.loading || MAP.failed) return;
    MAP.loading = true;
    const giveUp = why => { MAP.failed = true; MAP.loading = false; $("map").hidden = true; $("crumb").hidden = false; mapNote(why); drawCrumb(); };
    try {
      const probe = document.createElement("canvas");
      if (!(probe.getContext("webgl2") || probe.getContext("webgl"))) return giveUp("This browser can't draw the full map; showing the route and your track.");
      if (!document.querySelector("link[data-maplibre]")) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "vendor/maplibre-gl.css"; l.dataset.maplibre = "1"; document.head.append(l); }
      const lib = await import("./vendor/maplibre-gl.mjs");
      MAP.lib = lib;
      const r = NAV.route, c = live.lastFix ? [live.lastFix.lon, live.lastFix.lat] : r ? [r.pts[0].lon, r.pts[0].lat] : [-84.5, 42.7];
      // the day style, or the same style turned dark (RideCore.nightStyle) when the app is dark
      let style = STYLE_URL;
      try { const res = await timed(STYLE_URL, 8000); if (res.ok) { const j = await res.json(); style = isDark() ? C.nightStyle(j) : j; } } catch { /* MapLibre tries the URL itself */ }
      const map = new lib.Map({ container: "map", style, center: c, zoom: r && !live.lastFix ? 11 : 14, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, maxPitch: 0, fadeDuration: 0, cooperativeGestures: false });
      MAP.map = map;
      const t = setTimeout(() => { if (!MAP.ready) { $("crumb").hidden = false; mapNote(navigator.onLine ? "The map is slow to load; showing the route meanwhile." : "No signal and no saved map here: showing the route and your track. Routes → a route's map saves itself when you load it online."); drawCrumb(); } }, 9000);
      map.on("error", () => { /* a missing tile offline is expected; the breadcrumb covers a missing style */ });
      map.on("load", () => {
        clearTimeout(t); MAP.ready = true; MAP.loading = false; $("crumb").hidden = true; mapNote("");
        for (const l of map.getStyle().layers || []) if (l["source-layer"] === "poi" || /^poi/.test(l.id)) map.setLayoutProperty(l.id, "visibility", "none");   // a bike screen, not a guidebook
        const add = (id, data) => map.addSource(id, { type: "geojson", data: data || { type: "FeatureCollection", features: [] } });
        add("route"); add("climbs"); add("done"); add("detour"); add("trail"); add("marks");
        const ink = css("--ink"), acc = css("--accent"), dark = isDark(), halo = dark ? "#000000" : "#ffffff", blue = dark ? "#5b8fe0" : "#1f5bb5";
        map.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": halo, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 5, 16, 12] } });
        map.addLayer({ id: "route-line", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": acc, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 7] } });
        map.addLayer({ id: "climb-line", type: "line", source: "climbs", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": ["step", ["get", "g"], "#fab219", 6, "#ec835a", 9, "#7a1f12"], "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 7] } });
        map.addLayer({ id: "done-line", type: "line", source: "done", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": dark ? "#5c5a56" : "#8a8780", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 7] } });
        map.addLayer({ id: "trail-line", type: "line", source: "trail", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": blue, "line-width": 3, "line-opacity": 0.9 } });
        map.addLayer({ id: "detour-line", type: "line", source: "detour", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": blue, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 7], "line-dasharray": [1.5, 1] } });
        map.addLayer({ id: "marks-dot", type: "circle", source: "marks", paint: { "circle-radius": ["case", ["==", ["get", "t"], "turn"], 4, 6], "circle-color": ["case", ["==", ["get", "t"], "turn"], halo, ink], "circle-stroke-color": ink, "circle-stroke-width": 2 } });
        map.addLayer({ id: "marks-label", type: "symbol", source: "marks", filter: ["!=", ["get", "t"], "turn"], minzoom: 12, layout: { "text-field": ["get", "label"], "text-size": 13, "text-offset": [0, 1.1], "text-anchor": "top", "text-font": ["Noto Sans Bold"] }, paint: { "text-color": ink, "text-halo-color": halo, "text-halo-width": 2 } });
        const el = document.createElement("div"); el.className = "me"; el.setAttribute("aria-hidden", "true");
        MAP.marker = new lib.Marker({ element: el, rotationAlignment: "map", pitchAlignment: "map" }).setLngLat(c);
        if (live.lastFix) { MAP.marker.addTo(map); MAP.markerOn = true; }
        mapRoute(); mapDetour(); paintMap(live.lastFix, true);
      });
      map.on("dragstart", () => { MAP.follow = false; $("m-center").classList.add("primary"); });
      map.on("contextmenu", e => offerGo(e.lngLat.lng, e.lngLat.lat));   // a long press: ride there
      map.on("idle", () => nameTurns());
    } catch { giveUp("The map couldn't start here; showing the route and your track."); }
  }
  const isDark = () => (document.documentElement.dataset.theme || "dark") === "dark";
  /** A theme change rebuilds the map in the other style (the route layers come back with it). */
  function restyleMap() {
    if (!MAP.map) return;
    MAP.map.remove();
    Object.assign(MAP, { map: null, ready: false, loading: false, failed: false, markerOn: false, marker: null });
    if (curPage() === "map") ensureMap();
  }
  const line = pts => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts.map(p => [p.lon, p.lat]) } });
  const set = (id, data) => { const s = MAP.map && MAP.ready && MAP.map.getSource(id); if (s) /** @type {any} */ (s).setData(data); };
  function mapRoute() {
    drawCrumb();
    if (!MAP.ready) return;
    const r = NAV.route;
    set("route", r ? line(r.pts) : { type: "FeatureCollection", features: [] });
    set("climbs", climbFeatures(r, r ? r.climbs : []));
    set("marks", { type: "FeatureCollection", features: r ? [...r.turns.map(t => { const p = C.pointAt(r, t.along); return { type: "Feature", properties: { t: "turn" }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } }; }),
      ...r.pois.map(p => ({ type: "Feature", properties: { t: p.kind, label: (p.name || KIND_WORD[p.kind] || "").slice(0, 40) }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } }))] : [] });
    if (r && !live.lastFix) MAP.map.fitBounds(r.bounds, { padding: 40, duration: 0 });
    if (!r) mapFree();
  }
  function mapDetour() { set("detour", NAV.detour ? line(NAV.detour.route.pts) : { type: "FeatureCollection", features: [] }); drawCrumb(); }
  function paintMap(fix, force = false) {
    if (curPage() !== "map") return;
    drawCrumb();
    if (!MAP.ready || !fix) return;
    const now = Date.now(), v = speedNow() ?? 0;
    MAP.marker.setLngLat([fix.lon, fix.lat]).setRotation(live.heading ?? 0);
    if (!MAP.markerOn) { MAP.marker.addTo(MAP.map); MAP.markerOn = true; }
    if (now - MAP.lastDone > 5000 && NAV.route && NAV.st) {
      MAP.lastDone = now;
      const r = NAV.route, upto = [];
      for (let i = 0; i < r.pts.length && r.cum[i] <= NAV.st.along; i++) upto.push(r.pts[i]);
      if (upto.length > 1) set("done", line(upto));
    }
    if (samples.length > 1 && now - MAP.lastTrail > 5000) MAP.lastTrail = now, set("trail", line(samples.filter((s, i) => s[1] != null && (i % 3 === 0 || i === samples.length - 1)).map(s => ({ lat: s[1], lon: s[2] }))));
    if (!MAP.follow || (!force && now - MAP.lastCam < (saver.on ? 5000 : 900))) return;
    MAP.lastCam = now;
    const st = NAV.detour ? NAV.detour.st : NAV.st;
    const near = st && st.toTurn != null && st.toTurn < 250 ? 0.6 : 0;
    const zoom = (v > 11 ? 14.6 : v > 7 ? 15.2 : v > 3 ? 15.8 : 16.2) + near + MAP.zoom;
    const h = $("map").clientHeight || 400;
    MAP.map.easeTo({ center: [fix.lon, fix.lat], bearing: P.headingUp && live.heading != null && v > 1.5 ? live.heading : P.headingUp ? MAP.map.getBearing() : 0, zoom, duration: force || saver.on ? 0 : 900, padding: { top: P.headingUp ? h * 0.35 : 0, bottom: 0, left: 0, right: 0 } });
  }
  /** Street names for the turns ahead from the map's own tiles (OpenMapTiles' transportation_name layer). */
  function nameTurns() {
    const A = active();
    if (!MAP.ready || !A || !A.route.turns.length) return;
    const st = NAV.detour ? NAV.detour.st : NAV.st, from = st ? st.along : 0;
    let feats;
    try { feats = MAP.map.querySourceFeatures("openmaptiles", { sourceLayer: "transportation_name" }); } catch { return; }
    if (!feats || !feats.length) return;
    for (const t of A.route.turns) {
      if (t.along < from || t.along > from + 4000 || t.name || NAV.names.has(Math.round(t.along))) continue;
      const p = C.pointAt(A.route, Math.min(A.route.total, t.along + 40));
      let best = null;
      for (const f of feats) {
        const nm = f.properties && (f.properties.name || f.properties["name:latin"] || f.properties.ref);
        if (!nm) continue;
        const g = f.geometry, lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
        for (const ln of lines) for (let i = 0; i + 1 < ln.length; i++) {
          const d = segDist(p, { lon: ln[i][0], lat: ln[i][1] }, { lon: ln[i + 1][0], lat: ln[i + 1][1] });
          if (d < 25 && (!best || d < best.d)) best = { d, nm };
        }
      }
      if (best) NAV.names.set(Math.round(t.along), String(best.nm));
    }
  }
  const segDist = (p, a, b) => {
    const kx = 111320 * Math.cos(p.lat * Math.PI / 180), ky = 110540;
    const ax = (a.lon - p.lon) * kx, ay = (a.lat - p.lat) * ky, bx = (b.lon - p.lon) * kx, by = (b.lat - p.lat) * ky, dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
    return Math.hypot(ax + t * dx, ay + t * dy);
  };
  /** The breadcrumb: the route, the detour and your track drawn to scale around you, heading up or north up. */
  function drawCrumb() {
    const cv = /** @type {HTMLCanvasElement} */ ($("crumb"));
    if (cv.hidden || curPage() !== "map") return;
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext("2d");
    if (!g) return;
    g.scale(dpr, dpr);
    g.fillStyle = css("--page"); g.fillRect(0, 0, W, H);
    const r = NAV.route, fix = live.lastFix || (r ? { lat: r.pts[0].lat, lon: r.pts[0].lon } : null);
    if (!fix) { g.fillStyle = css("--ink-2"); g.font = face(15); g.fillText("Waiting for GPS…", 16, 32); return; }
    const mpp = (r && !live.lastFix ? Math.max(r.total / Math.min(W, H) * 1.2, 2) : 4) / 2 ** MAP.zoom;
    const rot = P.headingUp && live.heading != null ? -live.heading * Math.PI / 180 : 0;
    const kx = 111320 * Math.cos(fix.lat * Math.PI / 180), ky = 110540, cx = W / 2, cy = P.headingUp && live.lastFix ? H * 0.65 : H / 2;
    const xy = p => { const x = (p.lon - fix.lon) * kx / mpp, y = -(p.lat - fix.lat) * ky / mpp; return [cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]; };
    const path = (pts, color, w, dash) => { if (pts.length < 2) return; g.beginPath(); pts.forEach((p, i) => { const [x, y] = xy(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.strokeStyle = color; g.lineWidth = w; g.lineJoin = "round"; g.lineCap = "round"; g.setLineDash(dash || []); g.stroke(); g.setLineDash([]); };
    if (r) {
      path(r.pts, css("--hair"), 10);
      path(r.pts, css("--accent"), 5);
      if (NAV.st) path(r.pts.filter((_, i) => r.cum[i] <= NAV.st.along), "#8a8780", 5);
      for (const t of r.turns) { const [x, y] = xy(C.pointAt(r, t.along)); g.beginPath(); g.arc(x, y, 4, 0, 7); g.fillStyle = css("--page"); g.fill(); g.strokeStyle = css("--ink"); g.lineWidth = 2; g.stroke(); }
    }
    const blue = isDark() ? "#5b8fe0" : "#1f5bb5";
    if (NAV.detour) path(NAV.detour.route.pts, blue, 5, [8, 6]);
    path(samples.filter(s => s[1] != null).map(s => ({ lat: s[1], lon: s[2] })), blue, 3);
    if (live.lastFix) {
      g.save(); g.translate(cx, cy); g.rotate(((live.heading ?? 0) * Math.PI / 180) + rot);
      g.beginPath(); g.moveTo(0, -13); g.lineTo(9, 10); g.lineTo(0, 5); g.lineTo(-9, 10); g.closePath();
      g.fillStyle = css("--ink"); g.fill(); g.strokeStyle = css("--page"); g.lineWidth = 2; g.stroke(); g.restore();
    }
    // north arrow and scale
    g.save(); g.translate(W - 24, 24); g.rotate(rot); g.fillStyle = css("--ink"); g.font = face(12, true); g.textAlign = "center"; g.fillText("N", 0, -8); g.beginPath(); g.moveTo(0, -4); g.lineTo(5, 8); g.lineTo(-5, 8); g.closePath(); g.fill(); g.restore();
    const bar = P.km ? [50, 100, 200, 500, 1000, 2000, 5000, 10000] : [30.48, 60.96, 152.4, 304.8, 402.3, 804.7, 1609.3, 3218.7, 8046.7];
    const len = bar.find(b => b / mpp > 60) || bar[bar.length - 1];
    g.fillStyle = css("--ink"); g.fillRect(16, H - 22, len / mpp, 3); g.font = face(12); g.textAlign = "left"; g.fillText(nearTxt(len), 16, H - 28);
  }
  $("m-center").addEventListener("click", () => { MAP.follow = true; MAP.zoom = 0; $("m-center").classList.remove("primary"); paintMap(live.lastFix, true); drawCrumb(); });
  const paintOrient = () => { $("m-orient").textContent = P.headingUp ? "▲ Up" : "N Up"; $("m-orient").setAttribute("aria-pressed", String(P.headingUp)); };
  $("m-orient").addEventListener("click", () => { P.headingUp = !P.headingUp; savePrefs(); paintOrient(); if (MAP.ready && !P.headingUp) MAP.map.easeTo({ bearing: 0, duration: 300 }); paintMap(live.lastFix, true); drawCrumb(); });
  $("m-zin").addEventListener("click", () => { MAP.zoom = Math.min(3, MAP.zoom + 1); if (MAP.ready && !MAP.follow) MAP.map.zoomIn(); paintMap(live.lastFix, true); drawCrumb(); });
  $("m-zout").addEventListener("click", () => { MAP.zoom = Math.max(-5, MAP.zoom - 1); if (MAP.ready && !MAP.follow) MAP.map.zoomOut(); paintMap(live.lastFix, true); drawCrumb(); });
  paintOrient();

  // ── what's ahead: profile, climb, turns, stops, wind ──────────────────────────────────────────────────────
  let aheadAt = 0;
  // climb colors as a bike computer shows them: flat in the ground's own grey, then yellow, orange, red and dark red
  const gradeColor = g => g >= 12 ? "#8e1b10" : g >= 9 ? css("--zc5") : g >= 6 ? css("--zc4") : g >= 3 ? "#f2c200" : css("--muted");
  function drawProfile(cv, r, from, to, at) {
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 320, H = cv.clientHeight || +cv.getAttribute("height");
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext("2d");
    if (!g || !r.prof) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, W, H);
    const e = r.prof.ele, step = r.prof.step, i0 = Math.max(0, Math.floor(from / step)), i1 = Math.min(e.length - 1, Math.ceil(to / step));
    let lo = Infinity, hi = -Infinity;
    for (let i = i0; i <= i1; i++) { lo = Math.min(lo, e[i]); hi = Math.max(hi, e[i]); }
    const span = Math.max(hi - lo, (to - from) * 0.02, 20), top = 14, bot = H - 16, ex = d => (d - from) / Math.max(1, to - from) * W, ey = v => bot - (v - lo) / span * (bot - top);
    for (let i = i0; i < i1; i++) {
      const gr = (e[i + 1] - e[i]) / step * 100;
      g.fillStyle = gradeColor(gr);
      g.beginPath(); g.moveTo(ex(i * step), bot); g.lineTo(ex(i * step), ey(e[i])); g.lineTo(ex((i + 1) * step), ey(e[i + 1])); g.lineTo(ex((i + 1) * step), bot); g.closePath(); g.fill();
    }
    g.strokeStyle = css("--ink"); g.lineWidth = 1.5; g.beginPath();
    for (let i = i0; i <= i1; i++) { const x = ex(i * step), y = ey(e[i]); if (i === i0) g.moveTo(x, y); else g.lineTo(x, y); }
    g.stroke();
    if (at != null && at >= from && at <= to) {
      const x = ex(at), y = ey(C.eleAt(r, at));
      g.fillStyle = css("--accent"); g.fillRect(x - 1.5, top - 6, 3, bot - top + 6);
      g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill(); g.strokeStyle = css("--page"); g.lineWidth = 2; g.stroke();
    }
    g.fillStyle = css("--ink-2"); g.font = face(11); g.textAlign = "left";
    g.fillText(`${eleTxt(hi)} ${unitE()}`, 2, 11); g.fillText(`${eleTxt(lo)} ${unitE()}`, 2, H - 3);
    g.textAlign = "right"; g.fillText(`${distTxt(to - from)} ${unitD()}`, W - 2, H - 3);
  }
  function renderAhead(force = false) {
    const r = NAV.route;
    if (!force && (curPage() !== "ahead" || Date.now() - aheadAt < (saver.on ? 10000 : 2000))) return;
    aheadAt = Date.now();
    $("free").hidden = $("free-note").hidden = !!r;
    if (!r) { renderFree(); return; }
    const st = NAV.st || NAV.nav.status(), at = st.along, v = avgSpeed();
    $("a-done").innerHTML = `${distTxt(at)}<small>${unitD()}</small>`; $("a-pct").textContent = `${Math.round(st.frac * 100)}% of ${distTxt(r.total)} ${unitD()}`;
    $("a-left").innerHTML = `${distTxt(st.left)}<small>${unitD()}</small>`;
    let gainLeft = 0;
    if (r.prof) { const e = r.prof.ele; let ref = C.eleAt(r, at); for (let i = Math.ceil(at / r.prof.step); i < e.length; i++) { if (e[i] - ref >= 3) { gainLeft += e[i] - ref; ref = e[i]; } else if (ref - e[i] >= 3) ref = e[i]; } }
    $("a-gain").textContent = r.hasEle ? `${eleTxt(gainLeft)} ${unitE()} still to climb` : "no heights in the file";
    const eta = v > 1 ? Date.now() + st.left / v * 1000 : null;
    $("a-eta").textContent = eta ? hhmm(eta) : "—";
    const p = live.lastFix || r.pts[0], sun = C.sunTimes(new Date(), p.lat, p.lon);
    $("a-sun").textContent = eta && eta > sun.sunset ? `after sunset (${hhmm(sun.sunset)}): lights` : `sunset ${hhmm(sun.sunset)}`;
    $("a-sun").classList.toggle("warn", !!eta && eta > sun.sunset);
    const cvA = /** @type {HTMLCanvasElement} */ ($("prof-all")), cvN = /** @type {HTMLCanvasElement} */ ($("prof-next"));
    cvA.parentElement.hidden = cvN.parentElement.hidden = !r.hasEle;
    const span = P.km ? 8000 : 8046.7;
    $("prof-next-k").textContent = `Next ${P.km ? "8 km" : "5 mi"}`;
    if (r.hasEle && curPage() === "ahead") { drawProfile(cvA, r, 0, r.total, at); drawProfile(cvN, r, at, Math.min(r.total, at + span), at); }
    // the climb: ClimbPro's two states, before it and on it
    paintClimbBox("climb", st.onClimb || st.climb, !!st.onClimb, at, r, st.grade, r.climbs);
    const A = active(), ast = NAV.detour ? NAV.detour.st || NAV.detour.nav.status() : st;
    const turns = A.route.turns.filter(t => t.along > ast.along).slice(0, 8);
    $("turn-list").innerHTML = turns.length ? turns.map(t => `<li><span class="ta" aria-hidden="true">${C.TURN_ARROWS[t.kind] || "↑"}</span><b class="num">${nearTxt(t.along - ast.along)}</b><span>${esc(turnText(t))}</span></li>`).join("") : `<li class="none">${A.route.turns.length ? "No more turns: straight to the finish." : "No turns in this file."}</li>`;
    const pois = r.pois.filter(q => q.along > at - 20).slice(0, 8);
    $("poi-wrap").hidden = !r.pois.length;
    $("poi-list").innerHTML = pois.map(q => `<li><span class="ta">${picto(q.kind)}<span class="sr">${esc(KIND_WORD[q.kind] || "Point")}:</span></span><b class="num">${nearTxt(Math.max(0, q.along - at))}</b><span>${esc(q.name)}${q.desc && q.desc !== q.name ? ` · ${esc(q.desc)}` : ""}</span></li>`).join("") || `<li class="none">None left.</li>`;
    $("wind-ahead").textContent = windAhead(r, at);
    paintRace();
  }
  /** Ahead's race tiles: the plan (ahead / behind, this section's target) and your best ride here. */
  function paintRace() {
    const p = paceNow(), G = NAV.ghosts, gh = G && (G.best || G.last);
    $("race-tiles").hidden = !p && !gh;
    $("btn-pace").textContent = NAV.pace ? `Race plan · ${fmtHM(NAV.pace.target)}` : "Race plan";
    $("pace-tile").hidden = !p;
    const tone = (el, d) => { el.classList.toggle("ahead", d != null && d <= 0); el.classList.toggle("behind", d != null && d > 0); };
    if (p) {
      $("pace-delta").textContent = p.delta == null ? fmtHM(NAV.pace.target) : `${p.delta <= 0 ? "−" : "+"}${signed(p.delta)}`;
      tone($("pace-delta"), p.delta);
      $("pace-sec").textContent = p.section.watts > 20 ? `${KIND_NAME[p.section.kind]}: ${p.hr[0]}–${p.hr[1]} bpm · ${p.section.watts} W` : `${KIND_NAME[p.section.kind]}: coast, eat`;
    }
    $("ghost-tile").hidden = !gh;
    if (gh) {
      const d = vsGhost(gh), when = new Date(gh.start).toLocaleDateString([], { month: "short", day: "numeric" });
      $("ghost-k").textContent = gh === G.best ? "Your best" : "Your last";
      $("ghost-delta").textContent = d == null ? fmtHM(gh.g.total) : `${d <= 0 ? "−" : "+"}${signed(d)}`;
      tone($("ghost-delta"), d);
      $("ghost-sub").textContent = `${when} · ${fmtHM(gh.g.total)}${G.n > 1 ? ` · ${G.n} rides here` : ""}`;
    }
  }
  // ── climbs ahead with no route (like Wahoo's Summit Freeride): the road you're on, followed through the map tiles
  //    (the same ones the offline rerouting reads) the way you're heading, its heights from Open-Meteo every 100 m,
  //    and the climbs on it called out like a route's; rebuilt every few kilometres, or when you turn off it ───────────
  const tileLines = new Map();   // decoded tiles, newest last (a few dozen kept)
  let tileUrl = "";
  async function tilePattern() {
    if (tileUrl) return tileUrl;
    tileUrl = (await tileTemplate().catch(() => null)) || "";
    if (!tileUrl && navigator.onLine) {
      try {
        const style = await (await timed(STYLE_URL, 8000)).json(), src = Object.values(style.sources || {}).find(x => /** @type {any} */ (x).type === "vector" && /** @type {any} */ (x).url);
        const tj = src ? await (await timed(/** @type {any} */ (src).url, 8000)).json() : null;
        tileUrl = (tj && tj.tiles && tj.tiles[0]) || "";
      } catch { tileUrl = ""; }
    }
    return tileUrl;
  }
  /** The road lines in the tiles around some places: from the phone's cache or the network, fetched all at once
   *  (a slow signal costs one wait, not one per tile), decoded once and kept. `key` names the set of tiles. */
  async function linesAround(points, tmpl) {
    const cache = "caches" in window ? await caches.open(TILES) : null, urls = C.tilesAround(points, 1200).map(t => ({ t, url: tmpl.replace("{z}", t.z).replace("{x}", t.x).replace("{y}", t.y) }));
    const got = await Promise.all(urls.map(async ({ t, url }) => {
      const have = tileLines.get(url);
      if (have) return have;
      try {
        let res = cache ? await cache.match(url) : null;
        if (!res && navigator.onLine) res = await timed(url, 8000).catch(() => null);
        if (!res || !res.ok) return null;
        let buf = new Uint8Array(await res.arrayBuffer());
        if (buf[0] === 0x1f && buf[1] === 0x8b) buf = new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
        const lines = C.mvtLines(buf, t.z, t.x, t.y);
        tileLines.set(url, lines);
        if (tileLines.size > 48) tileLines.delete(tileLines.keys().next().value);
        return lines;
      } catch { return null; }
    }));
    const road = [], named = [], key = [];
    got.forEach((g, k) => { if (g) { road.push(...g.transportation); named.push(...g.transportation_name); key.push(urls[k].url); } });
    return { road, named, key: key.join("|") };
  }
  /** The road graph of the last set of tiles, kept so a rebuild on the same tiles skips building it again. Each use
   *  gets a copy: placing you on it adds a node. */
  const graphMemo = { key: "", g: null };
  const copyGraph = g => ({ ...g, nodes: g.nodes.slice(), adj: g.adj.map(l => l.slice()) });
  const heights = new Map();   // "lat,lon" (4 decimals, ~10 m) → metres
  /** Ground heights for points, from Open-Meteo's elevation API (100 a call); null when they can't all be had. */
  async function heightsOf(pts) {
    if (heights.size > 20000) heights.clear();   // before asking, so this call's answers are all still here to read
    const key = p => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`, need = [...new Set(pts.map(key).filter(k => !heights.has(k)))];
    for (let i = 0; i < need.length; i += 100) {
      const part = need.slice(i, i + 100), q = new URLSearchParams({ latitude: part.map(k => k.split(",")[0]).join(","), longitude: part.map(k => k.split(",")[1]).join(",") });
      try {
        const r = await timed(`https://api.open-meteo.com/v1/elevation?${q}`, 10000);
        if (!r.ok) return null;
        const j = await r.json();
        part.forEach((k, n) => { if (j.elevation && Number.isFinite(j.elevation[n])) heights.set(k, j.elevation[n]); });
      } catch { return null; }
    }
    const out = pts.map(p => heights.get(key(p)));
    return out.every(Number.isFinite) ? out : null;
  }
  const offset = (p, brg, d) => ({ lat: p.lat + d * Math.cos(brg * Math.PI / 180) / 111320, lon: p.lon + d * Math.sin(brg * Math.PI / 180) / (111320 * Math.cos(p.lat * Math.PI / 180)) });
  async function freeBuild(fix) {
    const now = Date.now(), v = speedNow(now) ?? 0;
    if (FREE.busy || P.freeride === "off" || NAV.route || TR.virtual || live.heading == null || v < 2 || now - FREE.tried < 20000) return;
    FREE.busy = true; FREE.tried = now;
    try {
      const tmpl = await tilePattern();
      if (!tmpl) { FREE.why = "map"; return; }
      const heading = live.heading, { road, named, key } = await linesAround([fix, offset(fix, heading, 5000)], tmpl);
      if (!road.length) { FREE.why = "map"; return; }
      if (graphMemo.key !== key) { graphMemo.key = key; graphMemo.g = C.roadGraph(C.nameRoads(road, named)); }
      const way = C.roadAhead(copyGraph(graphMemo.g), fix, heading, 6000);
      if (!way) { FREE.why = "road"; FREE.route = null; FREE.st = null; return; }
      // heights every 100 m (one Open-Meteo call per 10 km), laid onto the road's own shape, so a hairpin stays a hairpin
      const flat = C.analyze({ name: "Road ahead", points: way.points.map(p => ({ ...p, ele: null })) }), pts = [];
      for (let d = 0; d < flat.total; d += 100) pts.push(C.pointAt(flat, d));
      pts.push(C.pointAt(flat, flat.total));
      const h = await heightsOf(pts);
      if (!h) { FREE.why = "heights"; return; }
      const eleAt = d => { const f = Math.min(h.length - 1, d / 100), i = Math.floor(f); return i >= h.length - 1 ? h[h.length - 1] : h[i] + (h[i + 1] - h[i]) * (f - i); };
      FREE.route = C.analyze({ name: (way.names[0] && way.names[0].name) || "Road ahead", points: flat.pts.map((p, i) => ({ lat: p.lat, lon: p.lon, ele: eleAt(flat.cum[i]) })) });
      FREE.names = way.names; FREE.at = now; FREE.why = ""; FREE.st = null; FREE.offSince = 0;   // a new road: find yourself on it from scratch
      freeOnFix(live.lastFix || fix, false);
      mapFree(); renderAhead(true);
    } catch { FREE.why = "map"; } finally { FREE.busy = false; }
  }
  /** Where you are on the road ahead, its next climb, the callouts, and whether it's time to look further. */
  function freeOnFix(fix, build = true) {
    const r = FREE.route;
    if (r) {
      const pr = C.project(r, fix, FREE.st ? FREE.st.along : null, 1500, 200), list = C.climbsWorth(r.climbs, P.freeride);
      const climb = list.find(c => c.end > pr.along) || null, on = climb && climb.start <= pr.along ? climb : null;
      FREE.st = { along: pr.along, off: pr.off, climb, onClimb: on, toClimb: climb && !on ? climb.start - pr.along : null, grade: C.gradeAt(r, pr.along) };
      // off it for 8 s (a turn onto another road, not one wild fix under trees): find the new road
      if (pr.off > 60) { FREE.offSince = FREE.offSince || Date.now(); if (Date.now() - FREE.offSince >= 8000) { FREE.st = null; FREE.route = null; FREE.offSince = 0; mapFree(); } }
      else FREE.offSince = 0;
      if (FREE.st && pr.off <= 60 && S.running && !S.paused && climb) {
        const top = C.pointAt(r, climb.end);   // the same climb across rebuilds: its top within 250 m of one already said
        if (!on && FREE.st.toClimb <= 300 && !saidNear("c", top)) { FREE.said.push(["c", top]); say(`Climb in ${nearSay(FREE.st.toClimb)}: ${nearSay(climb.len).replace(/^a /, "")} at ${(climb.grade * 100).toFixed(0)} percent, ${eleTxt(climb.gain)} ${P.km ? "metres" : "feet"} up.`, false); }
        if (on && climb.end - pr.along < 40 && !saidNear("t", top)) { FREE.said.push(["t", top]); say("Top of the climb.", false); beep(990, 120); }
      }
    }
    const st = FREE.st;
    if (build && (!FREE.route || (st && (st.along > FREE.route.total - 2500 || Date.now() - FREE.at > 180e3)))) freeBuild(fix);
  }
  /** The Ahead screen with no route: the next 5 miles' profile, the climb, and the climbs further on. */
  function renderFree() {
    const r = FREE.route, st = FREE.st;
    $("free").hidden = !r || !st;
    $("free-note").hidden = !!(r && st);
    if (!r || !st) {
      $("free-note").textContent = P.freeride === "off" ? "Climbs ahead without a route are off (Settings)."
        : FREE.why === "heights" ? "The road ahead is found, but its heights need signal: the climbs come back when there's some."
        : FREE.why === "map" ? "The road ahead needs the map: open the Map screen once with signal, or ride where you've loaded a route before."
        : "No route? Ride, and the climbs on the road ahead appear here: the app follows the road you're on in the map and looks up its heights (heights need signal).";
      return;
    }
    const at = st.along, span = P.km ? 8000 : 8046.7, on = FREE.names.filter(n => n.along <= at + 50).pop();
    $("free-k").textContent = `Road ahead${on ? ` · ${on.name}` : ""}`;
    $("free-prof-k").textContent = `Next ${distTxt(Math.min(span, r.total - at))} ${unitD()}`;
    if (curPage() === "ahead") drawProfile(/** @type {HTMLCanvasElement} */ ($("prof-free")), r, at, Math.min(r.total, at + span), at);
    paintClimbBox("free-climb", st.onClimb || st.climb, !!st.onClimb, at, r, st.grade, C.climbsWorth(r.climbs, P.freeride));
    const ahead = C.climbsWorth(r.climbs, P.freeride).filter(c => c.end > at).slice(0, 5);
    $("free-list").innerHTML = ahead.length ? ahead.map(c => `<li><span class="ta">${picto("summit")}<span class="sr">Climb:</span></span><b class="num">${esc(nearTxt(Math.max(0, c.start - at)))}</b><span>${esc(nearTxt(c.len))} at ${(c.grade * 100).toFixed(1)}% · ${eleTxt(c.gain)} ${unitE()} up${c.cat ? ` · ${c.cat}` : ""}</span></li>`).join("")
      : `<li class="none">No climbs on the next ${distTxt(r.total - at)} ${unitD()} of this road.</li>`;
  }
  /** A climb in words, the one way every screen says it: before it (how far, how long, how steep) and on it (to the
   *  top, height to go, grade now). `long` adds the average and the steepest bit, for the boxes with room. */
  function climbText(c, on, at, r, grade, long = false) {
    const left = Math.max(0, on ? c.end - at : c.start - at), upToGo = Math.max(0, c.top - (C.eleAt(r, at) ?? c.top)), avg = `${(c.grade * 100).toFixed(1)}%`;
    return {
      left, main: on ? `${nearTxt(left)} to the top` : `in ${nearTxt(left)}`, pct: on ? Math.min(100, (at - c.start) / c.len * 100) : 0,
      sub: on ? `${eleTxt(upToGo)} ${unitE()} up to go${grade != null ? ` · now ${grade.toFixed(0)}%` : ""}${long ? ` · avg ${avg}` : ""}`
        : `${nearTxt(c.len)} at ${avg}${long ? ` (max ${(c.maxGrade * 100).toFixed(0)}%)` : ""} · ${eleTxt(c.gain)} ${unitE()} up`,
      field: on ? `to the top · ${eleTxt(upToGo)} ${unitE()} up` : `to a ${avg} climb${c.cat ? ` · ${c.cat}` : ""}`,
    };
  }
  /** Climbs as map lines, coloured by their grade. */
  const climbFeatures = (r, list) => ({ type: "FeatureCollection", features: r ? list.map(c => { const pts = []; for (let d = c.start; d <= c.end; d += 25) pts.push(C.pointAt(r, d)); return { ...line(pts), properties: { g: c.grade * 100 } }; }) : [] });
  /** A ClimbPro box: before the climb (how far, how long, how steep) and on it (to the top, height to go, grade now). */
  function paintClimbBox(id, c, on, at, r, grade, list) {
    const box = $(id);
    box.hidden = !c;
    if (!c) return;
    const n = list.indexOf(c) + 1, t = climbText(c, on, at, r, grade, true);
    $(`${id}-k`).textContent = on ? `Climbing · ${n} of ${list.length}` : `Next climb · ${n} of ${list.length}${c.cat ? ` · ${c.cat}` : ""}`;
    $(`${id}-main`).textContent = t.main;
    $(`${id}-sub`).textContent = t.sub;
    $(`${id}-bar`).style.width = `${t.pct}%`;
    box.classList.toggle("on", on);
  }
  /** The climb ahead or underway, route or not: the route's own on a route, else the road ahead's. */
  function climbNow() {
    if (NAV.route) {
      const st = NAV.st;
      if (!st || st.offCourse || NAV.detour) return null;
      const c = st.onClimb || st.climb;
      return c ? { c, on: !!st.onClimb, at: st.along, r: NAV.route, grade: st.grade, list: NAV.route.climbs } : null;
    }
    const st = FREE.st, c = st && (st.onClimb || st.climb);
    return c ? { c, on: !!st.onClimb, at: st.along, r: FREE.route, grade: st.grade, list: C.climbsWorth(FREE.route.climbs, P.freeride) } : null;
  }
  /** The grade under you: the route's, else the road ahead's. */
  function gradeNow() {
    if (NAV.route) return NAV.st && !NAV.st.offCourse ? NAV.st.grade : null;
    return FREE.st ? FREE.st.grade : null;
  }
  /** On the Workout screen, the climb within 2 km or underway, in a strip under the step (the weather steps aside). */
  function paintClimbStrip() {
    const c = climbNow(), show = !!c && S.running && (c.on || c.c.start - c.at <= 2000);
    $("climbstrip").hidden = !show;
    document.body.classList.toggle("climbing", show);
    if (!show) return;
    const { c: cl, on, at, r, grade } = c;
    $("cs-k").textContent = `${on ? "Climbing" : "Climb ahead"}${cl.cat ? ` · ${cl.cat}` : ""}`;
    const t = climbText(cl, on, at, r, grade);
    $("cs-main").textContent = t.main;
    $("cs-sub").textContent = t.sub;
    $("cs-bar").style.width = `${t.pct}%`;
  }
  /** The road ahead's climbs on the map, in their grade colours, when no route is loaded. */
  function mapFree() {
    if (NAV.route || !MAP.ready) return;
    const r = FREE.route;
    set("climbs", climbFeatures(r, r ? C.climbsWorth(r.climbs, P.freeride) : []));
  }

  /** How the wind sits on the next stretch of the route: headwind, tailwind or cross, as shares of the distance. */
  function windAhead(r, at) {
    const W = wx.cur;
    if (!W) return "No weather yet: it's fetched when you tap Start.";
    if (W.wind < 5) return `Light wind (${windTxt(W.wind)} ${windU()}): it won't matter.`;
    const to = Math.min(r.total, at + 16000);
    if (to - at < 300) return "Nearly there.";
    let head = 0, tail = 0, cross = 0, worst = 0;
    for (let d = at; d < to; d += 250) {
      const a = C.pointAt(r, d), b = C.pointAt(r, Math.min(r.total, d + 250)), course = bearing(a, b), along = W.wind * Math.cos((W.dir - course) * Math.PI / 180), len = hav(a, b);
      if (Math.abs(along) < 0.35 * W.wind) cross += len; else if (along > 0) { head += len; worst = Math.max(worst, along); } else tail += len;
    }
    const tot = head + tail + cross || 1, pc = x => Math.round(x / tot * 100);
    return `Next ${distTxt(to - at)} ${unitD()} (wind ${windTxt(W.wind)} ${windU()} from ${compass(W.dir)}): ${pc(head)}% headwind${worst ? ` (up to ${windTxt(worst)} ${windU()} against you)` : ""}, ${pc(tail)}% tailwind, ${pc(cross)}% crosswind.`;
  }

  // ── recording: a sample a second into memory, and into IndexedDB a minute at a time (a reload loses nothing) ──
  const avgSpeed = () => S.moving > 60 ? S.dist / S.moving : speedNow() || 0;
  async function flush(all = false) {
    if (!S.rideId) return;
    const from = S.chunk * 60, n = all ? samples.length - from : Math.floor((samples.length - from) / 60) * 60;
    for (let k = from; k < from + n; k += 60) {
      await DB.put("chunks", samples.slice(k, k + 60), `${S.rideId}:${String(k / 60).padStart(6, "0")}`).catch(() => {});
      if (k + 60 <= samples.length) S.chunk = k / 60 + 1;
    }
  }
  async function restoreSamples() {
    if (!S.rideId) return;
    const rows = await DB.range("chunks", `${S.rideId}:`, `${S.rideId}:￿`).catch(() => []);
    samples = rows.flat();
    S.chunk = Math.floor(samples.length / 60);
    samples = samples.slice(0, S.chunk * 60);
  }
  function record(now) {
    const fix = !TR.virtual && live.lastFix && now - live.lastFix.t < 5000 ? live.lastFix : null;   // a ride along a route on the trainer is indoors: no track
    let ele = null;
    if (NAV.route && NAV.route.hasEle && NAV.st && !NAV.st.offCourse && (fix || TR.virtual)) ele = C.eleAt(NAV.route, NAV.st.along);
    else if (live.alt != null && fix) ele = live.alt;
    const hr = live.hr && now - live.hrAt < 5000 ? live.hr : null, cad = live.cad != null && now - live.cadAt < 4000 ? live.cad : null, pw = now - live.powerAt < 4000 ? live.power : null;
    const spd = speedNow(now);
    if (ele != null && samples.length) { const prev = samples[samples.length - 1][3]; if (prev != null && ele - prev > 0 && ele - prev < 10) S.ascent += ele - prev; }
    if (spd != null) S.maxSpeed = Math.max(S.maxSpeed, spd);
    samples.push([now, fix ? Math.round(fix.lat * 1e7) / 1e7 : null, fix ? Math.round(fix.lon * 1e7) / 1e7 : null, ele == null ? null : Math.round(ele * 10) / 10, hr, cad, pw, spd == null ? null : Math.round(spd * 100) / 100, Math.round(S.dist * 10) / 10]);
    if (samples.length - S.chunk * 60 >= 60) flush();
  }
  /** Laps: closed by the Lap button, at each workout step (a setting), or every N miles / km (a setting). */
  function lap(trigger = 0, now = Date.now()) {
    if (!S.running || now - S.lapStart < 1000) return;
    const seg = samples.filter(s => s[0] >= S.lapStart);
    const st = C.stats({ samples: seg });
    S.laps.push({ start: S.lapStart, end: now, trigger, time: S.elapsed - S.lapElapsed, dist: S.dist - S.lapDist, hr: st.avgHr, pw: st.avgPower, name: (steps()[S.step] || {}).name || "" });
    S.lapStart = now; S.lapElapsed = S.elapsed; S.lapDist = S.dist;
    paintLaps();
  }
  function paintLaps() {
    const per = S.laps.slice().reverse();
    $("lap-dist-h").textContent = unitD();
    $("lap-rows").innerHTML = per.length ? per.map((l, i) => `<tr><td>${per.length - i}</td><td class="num">${clock(l.time)}</td><td class="num">${distTxt(l.dist)}</td><td class="num">${l.time > 0 ? speedTxt(l.dist / l.time) : "—"}</td><td class="num">${l.hr ? Math.round(l.hr) : "—"}</td><td class="num">${l.pw ? Math.round(l.pw) : "—"}</td></tr>`).join("") : `<tr><td colspan="6" class="none">No laps yet: tap Lap, or let each workout step make one.</td></tr>`;
  }

  // ── battery: this ride's drain → how long the phone lasts; a saver mode when that's shorter than the ride left ─────
  //    Saver: true black, map and camera moved every 5 s without animation, the screens redrawn every 3 s (the timer,
  //    the recording, the cues and the trainer keep their second-by-second pace)
  const batt = { log: [], fc: null, at: 0 };
  const saver = { on: false, auto: false, declined: false };
  function setSaver(on) {
    if (saver.on === on) return;
    saver.on = on;
    document.body.classList.toggle("saver", on);
    const was = document.documentElement.dataset.theme;
    UI.apply(on);
    if (was !== document.documentElement.dataset.theme) { restyleMap(); drawCrumb(); }
  }
  /** Minutes of riding left: the route at your average speed, else the session's steps; null for a free ride. */
  const rideLeftMin = () => {
    const A = active(), st = A ? (NAV.detour ? NAV.detour.st : NAV.st) : null, v = avgSpeed();
    if (st && st.left > 0 && v > 1 && !TR.virtual) return st.left / v / 60;
    const list = steps();
    if (list.length && S.step < list.length) return Math.max(0, list[S.step].min - (S.elapsed - S.stepStart) / 60) + list.slice(S.step + 1).reduce((a, s) => a + s.min, 0);
    return null;
  };
  const hm = h => (h >= 1 ? `${Math.floor(h)} h ${String(Math.round(h % 1 * 60)).padStart(2, "0")} m` : `${Math.round(h * 60)} min`);
  const hmSay = h => (h >= 1 ? `${Math.floor(h)} hour${Math.floor(h) === 1 ? "" : "s"}${Math.round(h % 1 * 60) ? ` ${Math.round(h % 1 * 60)} minutes` : ""}` : `${Math.round(h * 60)} minutes`);
  function batteryCheck(now) {
    const b = live.battery;
    if (!b) return;
    const lastRow = batt.log[batt.log.length - 1];
    if (!lastRow || lastRow[1] !== b.level || lastRow[2] !== b.charging) { batt.log.push([now, b.level, b.charging]); if (batt.log.length > 400) batt.log.shift(); }
    if (now - batt.at < 30000) return;
    batt.at = now;
    batt.fc = b.charging ? null : C.batteryForecast(batt.log, now);
    if (P.saver !== "auto" || !S.running || saver.on || saver.declined || !batt.fc) return;
    const need = rideLeftMin();
    if (need == null || batt.fc.hours * 60 >= need + 20) return;
    saver.auto = true;
    auto(`Battery lasts about ${hmSay(batt.fc.hours)} at this rate and the ride needs ${hmSay(need / 60)}: battery saver is on. Turning the screen brightness down helps most.`,
      () => setSaver(true), () => { setSaver(false); saver.auto = false; saver.declined = true; });
  }

  // ── stamina: the fuel tank (carbohydrate burned at the intensity, filled by what you eat) and W′ (the reserve
  //    above critical power, from the power curve the sync learned) ──────────────────────────────────────────────
  const ftpNow = () => P.ftp || cfg.eftp || Math.round(2.8 * P.weight);
  const fuelGrams = () => { const long = (planned && planned.minutes >= 150) || S.elapsed > 2.5 * 3600; return cfg.drink && cfg.drink.carbs ? Math.round(cfg.drink.carbs / 3) + (long ? 25 : 0) : long ? 30 : 20; };
  function stamina(now, dt) {
    if (!S.tank) S.tank = C.tank(P.weight);
    const w = now - live.powerAt < 4000 && live.power != null ? live.power : null, hr = live.hr && now - live.hrAt < 5000 ? live.hr : null;
    if (w == null && hr == null) return;
    const pct = w != null ? w / ftpNow() * 100 : C.ftpPct(hr / P.lthr * 100);
    const before = S.tank.burned;
    C.burn(S.tank, { watts: w, hr, pct, secs: dt, kg: P.weight, male: cfg.sex !== "female" });
    const perMin = (S.tank.burned - before) / Math.max(1e-6, dt) * 60;
    S.tank.rate = S.tank.rate == null ? perMin : S.tank.rate + (perMin - S.tank.rate) * Math.min(1, dt / 300);   // ~5 min average
    const left = S.tank.left / S.tank.full;
    if (left <= 0.25 && S.fuelSaid < 2) { S.fuelSaid = 2; notice("Fuel tank at 25 percent: eat now, before the legs go."); }
    else if (left <= 0.4 && S.fuelSaid < 1) { S.fuelSaid = 1; notice("Fuel tank at 40 percent: eat something in the next 15 minutes."); }
    const cp = cfg.cp, wp = cfg.w_prime_kj ? cfg.w_prime_kj * 1000 : 0;
    if (cp && wp && w != null) {
      if (S.wbal == null) S.wbal = wp;
      S.wbal = C.wbal(S.wbal, w, cp, wp, dt);
      if (S.wbal / wp < 0.2 && !S.wbalLow) { S.wbalLow = true; say("W prime nearly gone: ease off below critical power and it comes back.", false); }
      else if (S.wbal / wp > 0.6) S.wbalLow = false;
    }
  }
  /** Minutes until the tank is down to its last tenth at the recent rate, without eating. */
  const emptyIn = () => S.tank && S.tank.rate > 0.05 ? Math.max(0, (S.tank.left - S.tank.full * 0.1) / S.tank.rate) : null;

  // ── tailoring the workout as you ride ─────────────────────────────────────────────────────────────────────
  const tgt = s => { const k = C.isWork(s) ? S.intensity : 1; return s.lo > 0 ? [bpm(s.lo * k), bpm(s.hi * k)] : [0, bpm(s.hi)]; };
  const pwTgt = s => { if (!(P.ftp > 0)) return null; const k = C.isWork(s) ? S.intensity : 1; return s.lo > 0 ? [Math.round(P.ftp * C.ftpPct(s.lo * k) / 100), Math.round(P.ftp * C.ftpPct(s.hi * k) / 100)] : [0, Math.round(P.ftp * C.ftpPct(s.hi) / 100)]; };
  const tssPerMin = s => { const mid = s.lo > 0 ? (s.lo + s.hi) / 2 * (C.isWork(s) ? S.intensity : 1) : s.hi * 0.85, f = C.ftpPct(mid) / 100; return f * f * 100 / 60; };
  const tssNow = () => S.trimp / trimpHour() * 100;
  const projected = () => { const st = steps(); if (!st.length) return null; const cur = st[S.step]; let t = tssNow(); if (cur) t += Math.max(0, cur.min * 60 - (S.elapsed - S.stepStart)) / 60 * tssPerMin(cur); for (let i = S.step + 1; i < st.length; i++) t += st[i].min * tssPerMin(st[i]); return t; };
  const doneIn = () => Math.max(0, (S.elapsed - S.stepStart) / 60);
  const replan = (next, why) => { S.plan = next; if (S.step >= S.plan.length) S.step = S.plan.length; save(); render(); if (why) { note.hidden = false; note.textContent = why; } };
  // ── the app decides, you ride: every change it makes on its own is said, shown, and can be undone for 30 s ──────
  let undo = null, undoTimer = 0;
  const auto = (text, change, revert = null) => {
    const before = { plan: S.plan.map(x => ({ ...x })), intensity: S.intensity, step: S.step, stepStart: S.stepStart };
    change();
    undo = revert ? { revert } : before;
    $("suggest-text").textContent = text; $("suggest-yes").hidden = false; $("suggest").hidden = false;
    say(text, false); beep(700, 120, 2); buzz([120, 60, 120]);
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { $("suggest").hidden = true; undo = null; }, 30000);
    save(); render();
  };
  /** Something worth knowing (the weather, the fuel tank): said, shown and buzzed, with nothing to undo. */
  const notice = (text, urgent = false) => {
    undo = null;
    $("suggest-text").textContent = text; $("suggest-yes").hidden = true; $("suggest").hidden = false;
    say(text, urgent); beep(600, 140, 2); buzz([200, 80, 200]);
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { $("suggest").hidden = true; $("suggest-yes").hidden = false; }, 30000);
  };
  $("suggest-yes").addEventListener("click", () => {
    if (undo) { if (undo.revert) undo.revert(); else Object.assign(S, undo); undo = null; say("Changed back.", false); save(); render(); }
    $("suggest").hidden = true;
  });
  $("suggest-no").addEventListener("click", () => { $("suggest").hidden = true; $("suggest-yes").hidden = false; undo = null; });
  const setIntensity = k => { S.intensity = Math.max(0.8, Math.min(1.15, Math.round(k * 100) / 100)); };
  const easyHomeNow = () => {   // the rest of the session as easy endurance, same time
    const st = steps(), rest = Math.max(0, st[S.step] ? st[S.step].min - doneIn() : 0) + st.slice(S.step + 1).reduce((a, s) => a + s.min, 0);
    S.plan = [...st.slice(0, S.step), { name: "Easy (intervals off)", min: Math.max(1, doneIn() + rest), zone: "z2", lo: 0, hi: 89, cue: "Endurance only today" }];
  };
  const kindSel = $("tl-kind");
  kindSel.innerHTML = Object.entries(C.QUICK).map(([k, q]) => `<option value="${k}">${esc(/** @type {any} */ (q).label)}</option>`).join("");
  $("w-tailor").addEventListener("click", () => {
    const st = steps(), left = st.length ? Math.round(Math.max(0, (st[S.step] ? st[S.step].min - doneIn() : 0)) + st.slice(S.step + 1).reduce((a, s) => a + s.min, 0)) : 60;
    /** @type {HTMLInputElement} */ ($("tl-left")).value = String(Math.max(5, left));
    const pr = projected(), goal = planned && planned.load ? Math.round(+planned.load) : null;
    $("tl-load").textContent = st.length ? `Load so far ${Math.round(tssNow())}${goal ? ` of ${goal} planned` : ""} · on pace for ${Math.round(pr ?? tssNow())} at the end of the session.` : `No session: pick a quick workout below, or ride free. Load so far ${Math.round(tssNow())}.`;
    $("tailor").showModal();
  });
  $("tailor").addEventListener("click", e => {
    const b = /** @type {HTMLElement} */ (e.target).closest("[data-tl]");
    if (!b) return;
    const st = steps(), act = b.dataset.tl;
    if (act === "quick") {
      const kind = /** @type {HTMLSelectElement} */ (kindSel).value, m = +(/** @type {HTMLInputElement} */ ($("tl-min")).value) || 60, q = C.quick(kind, m);
      S.quick = { date: iso(today), title: `${C.QUICK[kind].label} · ${m} min`, session: C.QUICK[kind].label, minutes: m, load: Math.round(q.reduce((a, s) => a + s.min * tssPerMin(s), 0)), steps: q };
      paintDays();
      if (S.running) { S.plan = [...st.slice(0, S.step), ...q.map(s => ({ ...s }))]; S.stepStart = S.elapsed; planned = S.quick; daySel.value = "quick"; say(`${S.quick.title}. First, ${q[0].name}.`); }
      else { daySel.value = "quick"; pickDay(); }
      $("tailor").close(); save(); render(); return;
    }
    if (!st.length) return;
    if (act === "less") replan(C.extend(st, S.step, -1, doneIn()));
    else if (act === "more") replan(C.extend(st, S.step, 1, doneIn()));
    else if (act === "more5") replan(C.extend(st, S.step, 5, doneIn()));
    else if (act === "back" && S.step > 0) { S.step -= 1; S.stepStart = S.elapsed; save(); render(); }
    else if (act === "rep") replan(C.addRep(st, Math.min(S.step, st.length - 1)), "One more rep added.");
    else if (act === "cut") replan(C.cutSet(st, Math.min(S.step, st.length - 1)), "Rest of the set cut.");
    else if (act === "fit") { const m = +(/** @type {HTMLInputElement} */ ($("tl-left")).value); if (m > 0 && st[S.step]) replan(C.fitTime(st, S.step, doneIn(), m), `The rest fits ${m} min.`); }
    $("tailor").close();
  });
  // ── the loop ────────────────────────────────────────────────────────────────────────────────────────────
  const k = cfg.sex === "female" ? [0.86, 1.67] : [0.64, 1.92];
  const trimpRate = hr => { const r = Math.max(0, Math.min(1, (hr - P.rest) / Math.max(1, P.max - P.rest))); return r * k[0] * Math.exp(k[1] * r); };
  const trimpHour = () => 60 * trimpRate(P.lthr);
  let last = 0, lastBeep = 0, rep = { under: 0, high: 0, n: 0 };
  const fuelText = () => {
    const long = (planned && planned.minutes >= 150) || S.elapsed > 2.5 * 3600;
    const drink = cfg.drink;   // the drink mix from the fuel plan: a bottle an hour, so a third of one every 20 min
    if (drink && drink.name) return long ? ` ⅓ bottle of ${drink.name} (~${Math.round(drink.carbs / 3)} g) and a gel or a few chews each hour` : ` ⅓ bottle of ${drink.name} (~${Math.round(drink.carbs / 3)} g carbs)`;
    return long ? " ~30 g carbs (a gel or half a bar) and a few big sips" : " ~20 g carbs and a few sips";
  };
  function advance(manual) {
    const st = steps();
    if (!st.length) return;
    const then = endRep(st[S.step]);
    S.step += 1; S.stepStart = S.elapsed; S.held = 0;
    if (then) setTimeout(then, 0);   // what the app decided about the set, once the next step has begun
    if (P.stepLap && S.running) lap(1);
    if (S.step >= st.length) { say("Workout complete. Ride easy or finish up."); beep(660, 300, 2); offerLoad(); return; }
    const s = st[S.step], [lo, hi] = tgt(s), pt = pwTgt(s);
    const target = s.cue && s.cue.includes("feel") ? (pt && live.powerAt ? `${pt[0]} to ${pt[1]} watts.` : "By feel.") : `Heart rate ${lo > 0 ? `${lo} to ${hi}` : `under ${hi}`}.`;
    say(`${s.name}. ${Math.round(s.min) >= 1 ? `${Math.round(s.min)} minute${Math.round(s.min) === 1 ? "" : "s"}` : `${Math.round(s.min * 60)} seconds`}. ${target}`);
    if (!manual) { beep(s.zone === "z1" || s.zone === "z2" ? 660 : 990, 220, 2); buzz([200, 100, 200]); }
  }
  /** At the end of a work step: did HR reach the target, or run well over it? Two such reps in a row and the app acts. */
  function endRep(s) {
    if (!s || !C.isWork(s) || s.min < 3 || rep.n < 30) { rep = { under: 0, high: 0, n: 0 }; return null; }
    const under = rep.under / rep.n > 0.6, high = rep.high / rep.n > 0.5;
    S.missed = under ? S.missed + 1 : 0; S.hot = high ? S.hot + 1 : 0;
    rep = { under: 0, high: 0, n: 0 };
    const set = C.setOf(steps(), S.step), more = set && set.last > S.step;
    if (S.missed >= 2 && more) { S.missed = 0; return () => auto("Heart rate isn't reaching the target on these reps: that's fatigue, so the rest of the set is cut.", () => { S.plan = C.cutSet(steps(), S.step); }); }
    else if (S.hot >= 2 && more) { S.hot = 0; return () => auto("Heart rate is running well over the target: the rest of the set is 5% easier.", () => setIntensity(S.intensity - 0.05)); }
    return null;
  }
  function offerLoad() {
    const goal = planned && planned.load ? +planned.load : 0;
    if (!goal || S.loadOffered || tssNow() >= goal * 0.9) return;
    S.loadOffered = true;
    const m = Math.min(90, Math.ceil((goal - tssNow()) / tssPerMin({ lo: 81, hi: 89 }) / 5) * 5);
    auto(`Load ${Math.round(tssNow())} of ${Math.round(goal)} planned: ${m} more minutes of easy endurance finish the day's work.`, () => {
      S.plan = [...steps(), { name: "Endurance (the day's load)", min: m, zone: "z2", lo: 81, hi: 89, cue: "Steady, conversational" }]; S.stepStart = S.elapsed;
    });
  }
  // ── commute check (RideCore.commuteCheck): steady riding only, so lights and traffic don't read as fatigue ─────
  const hrSpeed = [], stops = [];
  let check = null, checkSaid = "", hotFrom = 0, lastSpd = [], moving = false, rollAt = 0;
  const commuteModel = () => planned && planned.check && cfg.commute && cfg.commute[planned.leg];
  /** Rolling again after a stop: for 45 s heart rate is still catching up (or coming down), so nothing is judged. */
  const rolling = () => !!rollAt && S.elapsed - rollAt < 45;

  function tick() {
    const now = Date.now(), dt = last ? Math.min(5, (now - last) / 1000) : 1;
    last = now;
    driveTrainer(now);
    if (S.running && !S.paused) {
      if (now - wx.at > WX_EVERY) refreshWx();   // fresh conditions every half hour on a long ride
      if (live.lastFix && now - (NAV.lastAt || 0) > 1500) onFix(live.lastFix);   // a quiet GPS (standing still, under trees): keep judging the last fix
      if (!S.autoPaused) { trackMine(); ghostCallout(); paceCoach(now); }
      const spd = speedNow(now), gpsQuiet = watch != null && live.gpsAt && now - live.gpsAt > 8000 && now - live.gpsAt < 60000 && (live.gpsSpeed ?? 0) < 1.5;
      const v = spd ?? (gpsQuiet ? 0 : null);
      // auto-pause: stopped 4 s (a speed source says so) pauses the timer and the recording; moving again resumes
      if (P.autoPause && v != null) {
        if (v < 0.6) { S.still += dt; if (!S.autoPaused && S.still >= 4) { S.autoPaused = true; S.pauses.push([now, 0]); beep(520, 90, 2); } }
        else { S.still = 0; if (S.autoPaused && v > 1.2) { S.autoPaused = false; const p = S.pauses[S.pauses.length - 1]; if (p && !p[1]) p[1] = now; beep(880, 90, 2); } }
      } else if (S.autoPaused) { S.autoPaused = false; const p = S.pauses[S.pauses.length - 1]; if (p && !p[1]) p[1] = now; }
      if (!S.autoPaused) {
        S.elapsed += dt;
        if (v == null || v > 0.8) S.moving += dt;
        if (live.hr && now - live.hrAt < 5000) {
          S.hrSum += live.hr * dt; S.hrSecs += dt; S.hrMax = Math.max(S.hrMax, live.hr);
          S.zones[zoneOf(live.hr) - 1] += dt; S.trimp += trimpRate(live.hr) * dt / 60;
        }
        if (live.cad && now - live.cadAt < 4000 && live.cad > 0) { S.cadSum += live.cad * dt; S.cadSecs += dt; }
        if (now - live.powerAt < 4000 && live.power != null) { S.pwSum += live.power * dt; S.pwSecs += dt; }
        stamina(now, dt);
        // stops and starts: a stop is under 1.5 m/s after moving; rolling again opens a 45 s grace for the coaching
        if (spd != null) {
          if (moving && spd < 1.5) { moving = false; stops.push(S.elapsed); }
          else if (!moving && spd > 3) { moving = true; rollAt = stops.length ? S.elapsed : 0; }
          lastSpd.push(spd); if (lastSpd.length > 15) lastSpd.shift();
        }
        if (live.hr && now - live.hrAt < 5000 && spd != null && spd > 3) {
          const even = lastSpd.length >= 10 && Math.max(...lastSpd) - Math.min(...lastSpd) < 2.5;
          const sinceStop = stops.length ? S.elapsed - stops[stops.length - 1] : Infinity;
          hrSpeed.push({ t: S.elapsed, hr: live.hr, kmh: spd * 3.6, steady: spd > 4.2 && even && sinceStop > 60 && !rolling() });
          if (hrSpeed.length > 900) hrSpeed.shift();
        }
        record(now);
        const wc = windNow(now, spd);
        if (wc && wc.vCalm > 0) {                                     // what the wind did to the clock: your speed against the calm-air speed for the same effort
          S.windSecs += dt; S.windSec += dt * Math.max(-1, Math.min(1, 1 - spd / wc.vCalm));
          if (wc.drag > 0.15) S.windHead += dt; else if (wc.drag < -0.15) S.windTail += dt;
        }
        // a hot verdict must hold 2 minutes of steady riding before the app acts on it; stop-and-go gets no verdict
        check = C.commuteCheck(hrSpeed, commuteModel(), stops, S.elapsed);
        if (check && check.verdict === "hot") { if (!hotFrom) hotFrom = S.elapsed; } else hotFrom = 0;
        const verdict = check ? (check.verdict === "hot" && S.elapsed - hotFrom < 120 ? "" : check.verdict) : "";
        if (verdict && verdict !== "normal" && verdict !== "city" && checkSaid !== verdict) {
          checkSaid = verdict;
          if (verdict === "hot" && steps().slice(S.step).some(C.isWork)) auto(`Heart rate is ${Math.round(check.diff)} beats above your usual for this speed on steady riding: the intervals are off today, the rest is easy.`, easyHomeNow);
          else if (verdict === "hot") say("Heart rate is running high for this speed: keep it easy.", false);
          else say("You're running fresh today: lower heart rate than usual for this speed.", false);
        }
        const st = steps();
        if (st.length && S.step < st.length) {
          const s = st[S.step], inStep = S.elapsed - S.stepStart, left = s.min * 60 - inStep, hrLive = live.hr && now - live.hrAt < 5000 ? live.hr : null;
          if (C.isWork(s) && hrLive && inStep > s.min * 60 * 0.5 && !rolling()) { const [lo, hi] = tgt(s); rep.n++; if (hrLive < lo - 3) rep.under++; if (hrLive > hi + 5) rep.high++; }
          if (hrLive && !rolling() && inStep > 45) {   // time on target, for the after-ride note (HR gets 45 s to arrive)
            const [lo, hi] = tgt(s), on = hrLive >= lo - 2 && hrLive <= hi + 2;
            S.tgtSecs += dt; if (on) S.tgtOn += dt;
            if (C.isWork(s)) { S.workSecs += dt; if (on) S.workOn += dt; }
          }
          // efforts on the climbs: an easy step before a work step waits (up to 10 min) for the foot of the next climb
          const nxt = st[S.step + 1], ns = NAV.st;
          const holding = P.climbs && NAV.route && ns && !ns.offCourse && !C.isWork(s) && C.isWork(nxt) && left <= 0 && S.held < 600 && ns.toClimb != null && ns.toClimb > Math.max(15, (spd || 4) * 4) && ns.toClimb / Math.max(3, spd || 3) < 600 - S.held;
          if (holding) { if (!S.held) say(`Next effort at the foot of the climb, ${nearSay(ns.toClimb)} ahead.`, false); S.held += dt; }
          else {
            const sec = Math.ceil(left);
            if (sec >= 1 && sec <= 3 && sec !== lastBeep) { lastBeep = sec; beep(1320, 90); }   // 3-2-1 before each change
            if (left <= 0) advance(false);
          }
        }
        if (P.fuel > 0 && S.elapsed >= S.fuelAt + P.fuel * 60 && S.elapsed > 20 * 60) {
          S.fuelAt = S.elapsed; S.fuelDue = true; beep(520, 250, 3); buzz([400, 150, 400]); say("Time to eat and drink.");
        }
        if (P.autoLap > 0 && S.dist - S.lapDist >= P.autoLap * (P.km ? 1000 : 1609.344)) lap(2, now);
        if (live.battery && !live.battery.charging && live.battery.level <= 0.15 && !S.battSaid) { S.battSaid = true; say("Phone battery at 15 percent."); }
      }
      if (Math.round(S.elapsed) % 5 === 0) save();
    }
    batteryCheck(now);
    if (!saver.on || now - drawnAt >= 3000) render();
  }
  let drawnAt = 0;

  /** The target gauge: the step's range as a band in its zone's color, heart rate as the marker, 20 bpm either side. */
  function paintGauge(s, hr = null, lo = 0, hi = 0) {
    const g = $("gauge");
    g.hidden = !s;
    if (!s) return;
    const a = (lo > 0 ? lo : hi - 30) - 20, b = hi + 20, pos = x => `${Math.max(0, Math.min(100, (x - a) / (b - a) * 100))}%`;
    const band = $("g-band"), mark = $("g-mark");
    band.style.left = pos(lo > 0 ? lo : a); band.style.right = `calc(100% - ${pos(hi)})`;
    band.dataset.zone = String(zoneOf(bpm((s.lo > 0 ? (s.lo + s.hi) / 2 : s.hi - 5))));
    mark.hidden = hr == null;
    if (hr != null) mark.style.left = pos(hr);
  }

  /** What the sync learned, in a line each: what moved readiness, fitness and form against the next event's target,
   *  the commute's speed per heartbeat over time, and where the zones came from. */
  function briefLines(B) {
    const out = [...(B.why || [])];
    const T = B.target, raceName = cfg.race && cfg.race.name ? cfg.race.name.replace(/^Bell's\s+/, "") : "the race";
    if (B.ctl != null) out.push(`Fitness ${B.ctl.toFixed(0)}${B.tsb != null ? `, form ${B.tsb > 0 ? "+" : ""}${B.tsb}` : ""}${T ? ` · ${raceName} asks for ${T.ctl}${T.race_ctl != null ? `, on course for ${Math.round(T.race_ctl)}` : ""}` : ""}`);
    else if (B.tsb != null) out.push(`Form ${B.tsb > 0 ? "+" : ""}${B.tsb}`);
    if (B.ef_trend != null && Math.abs(B.ef_trend) >= 0.5) out.push(`Commute: ${B.ef_trend > 0 ? "+" : "−"}${Math.abs(B.ef_trend).toFixed(1)}% speed per heartbeat vs your earlier commutes${B.ef_trend > 0 ? " (fitter)" : ""}`);
    if (B.zones) out.push(B.zones);
    return out;
  }

  /** Before the ride: why today's ride is today's ride (the sync's call, readiness and what moved it, the next event). */
  function paintBrief() {
    const B = cfg.brief, box = $("brief");
    box.hidden = !B || B.date !== iso(today) || S.running;
    if (box.hidden) return;
    const sc = $("b-score");
    sc.textContent = B.score != null ? String(B.score) : "—"; sc.dataset.level = B.level || "";
    sc.setAttribute("aria-label", B.score != null ? `Readiness ${B.score}` : "No readiness yet");
    $("b-title").textContent = B.title || "";
    $("b-why").replaceChildren(...briefLines(B).map(t => { const li = document.createElement("li"); li.textContent = String(t); return li; }));
    const race = cfg.race && cfg.race.date ? Math.round((new Date(cfg.race.date + "T12:00:00") - new Date(iso(today) + "T12:00:00")) / 864e5) : null;
    $("b-race").textContent = race != null && race >= 0 ? ` · ${cfg.race.name} in ${race} day${race === 1 ? "" : "s"}` : "";
  }

  // ── drawing ─────────────────────────────────────────────────────────────────────────────────────────────
  function render() {
    const now = Date.now();
    drawnAt = now;
    const hrLive = live.hr && now - live.hrAt < 5000 ? live.hr : null;
    $("hr").textContent = hrLive ?? "—";
    $("hr").classList.toggle("idle", !hrLive);
    $("hrcard").hidden = !S.running && !hrLive && !live.hrAt;   // before the ride, no strap: the brief has the room
    if (hrLive) $("hr-zone").dataset.n = String(zoneOf(hrLive)); else delete $("hr-zone").dataset.n;
    const zm = $("zmark");
    $("hrcard").dataset.zone = hrLive ? String(zoneOf(hrLive)) : "";
    if (hrLive) { zm.style.display = "block"; zm.style.left = `${Math.max(0, Math.min(100, (hrLive / P.lthr * 100 - 60) / 52 * 100))}%`; $("hr-zone").textContent = ZNAME[zoneOf(hrLive)]; }
    else { zm.style.display = "none"; $("hr-zone").textContent = live.hrAt ? "signal lost" : "bpm"; }

    const st = $("hr-status"), list = steps();
    const s = list[S.step];
    st.className = "status";
    st.textContent = "";
    if (s && S.running) {
      const elapsedInStep = S.elapsed - S.stepStart;
      const left = s.min * 60 - elapsedInStep;
      const [lo, hi] = tgt(s), pt = pwTgt(s), p10 = pw10();
      $("step-name").textContent = `${s.name}${list.length > 1 ? `  ·  ${S.step + 1}/${list.length}` : ""}`;
      $("step-time").textContent = S.held ? `+${clock(S.held)}` : clock(left);
      const erg = trainerLine();
      lineOf($("step-target"), ["Target ", lo > 0 ? `${lo}–${hi}` : `under ${hi}`, " bpm", ...(pt && !erg ? [" · ", pt[0] ? `${pt[0]}–${pt[1]}` : `<${pt[1]}`, " W"] : []),
        ...(erg ? [` · ${erg[0]} `, erg[1], ` ${erg[2]}`] : [])]);
      $("step-bar").style.width = `${Math.min(100, elapsedInStep / (s.min * 60) * 100)}%`;
      const ns = NAV.st;
      const lim = TR.mode === "erg" && now - TR.limitAt < 5000 ? TR.limit : null;
      $("step-cue").textContent = lim === "slow" ? `Shift to a harder gear: the trainer can't hold ${TR.watts} W at this wheel speed.` : lim === "fast" ? `Shift to an easier gear for ${TR.watts} W.`
        : S.held && ns && ns.toClimb != null ? `Holding for the climb: the effort starts at its foot, ${nearTxt(ns.toClimb)} ahead.` : nb(s.cue);
      paintGauge(s, hrLive, lo, hi);
      const n = list[S.step + 1];
      $("step-next").textContent = n ? `Next: ${n.name} · ${n.min >= 1 ? `${Math.round(n.min)} min` : `${Math.round(n.min * 60)} s`}` : "Last step";
      const byFeel = s.cue && s.cue.includes("by feel");
      const usePower = pt && p10 != null && C.isWork(s);
      if (S.autoPaused) { st.classList.add("feel"); st.textContent = "Auto-paused"; }
      else if (rolling() && !usePower) { st.classList.add("feel"); st.textContent = "Rolling again"; }   // after a stop: HR catches up, nothing to chase
      else if (usePower && elapsedInStep >= 5) {   // power has no lag: short efforts get a number too
        if (p10 < pt[0] - 5) { st.classList.add("up"); st.textContent = `▲ Push · ${p10} W`; }
        else if (p10 > pt[1] + 5) { st.classList.add("down"); st.textContent = `▼ Ease · ${p10} W`; }
        else { st.classList.add("good"); st.textContent = `On target · ${p10} W`; }
      } else if (byFeel || elapsedInStep < 45 && s.zone !== "z1" && s.zone !== "z2") { st.classList.add("feel"); st.textContent = byFeel ? "By feel" : "Settling in"; }
      else if (hrLive) {
        if (hrLive < lo - 2) { st.classList.add("up"); st.textContent = "▲ Push"; }
        else if (hrLive > hi + 2) { st.classList.add("down"); st.textContent = "▼ Ease off"; }
        else { st.classList.add("good"); st.textContent = "On target"; }
      }
    } else if (s) {
      $("step-name").textContent = planned ? planned.title : "Free ride";
      $("step-time").textContent = clock(list.reduce((a, x) => a + x.min * 60, 0));
      $("step-target").innerHTML = `${list.length} step${list.length === 1 ? "" : "s"} · first: <b>${esc(s.name)}</b>`;
      $("step-cue").textContent = planned ? nb(planned.eased ? `${planned.eased}: ${planned.title.toLowerCase()} instead of the planned session.` : planned.session) : "";
      $("step-next").textContent = "";
      $("step-bar").style.width = "0";
      paintGauge(null);
    } else if (S.running && (!list.length || S.step >= list.length) && paceNow()) {   // racing to the plan: its section is the step
      const p = paceNow(), sec = p.section, hrNow = hrLive;
      $("step-name").textContent = `Race plan · ${KIND_NAME[sec.kind]} ${p.i + 1}/${NAV.pace.sections.length}`;
      $("step-time").textContent = p.delta == null ? clock(S.elapsed) : `${p.delta <= 0 ? "−" : "+"}${signed(p.delta)}`;
      $("step-time").classList.toggle("ahead", p.delta != null && p.delta <= 0); $("step-time").classList.toggle("behind", p.delta != null && p.delta > 0);
      if (sec.watts > 20) lineOf($("step-target"), ["Target ", `${p.hr[0]}–${p.hr[1]}`, " bpm · ", `${sec.watts}`, " W · ", speedTxt(sec.speed), ` ${unitS()}`]);
      else lineOf($("step-target"), ["Descent: ", "coast", ", eat and drink"]);
      $("step-bar").style.width = `${Math.min(100, (1 - p.left / Math.max(1, sec.len)) * 100)}%`;
      $("step-cue").textContent = `${p.delta == null ? "" : `${signed(p.delta)} ${p.delta <= 0 ? "ahead of" : "behind"} the plan · `}${nearTxt(p.left)} left in this section`;
      $("step-next").textContent = p.next ? `Next: ${KIND_NAME[p.next.kind]} ${distTxt(p.next.len)} ${unitD()}${p.next.kind !== "flat" ? ` at ${(p.next.grade * 100).toFixed(1)}%` : ""}` : "Last section: to the finish";
      paintGauge(sec.watts > 20 ? { lo: p.hr[0] / P.lthr * 100, hi: p.hr[1] / P.lthr * 100 } : null, hrNow, p.hr[0], p.hr[1]);
      if (hrNow && sec.watts > 20) { st.classList.add(hrNow > p.hr[1] + 2 ? "down" : hrNow < p.hr[0] - 2 ? "up" : "good"); st.textContent = hrNow > p.hr[1] + 2 ? "▼ Over the plan" : hrNow < p.hr[0] - 2 ? "▲ Under the plan" : "On the plan"; }
    } else {
      $("step-time").classList.remove("ahead", "behind");
      paintGauge(null);
      $("step-name").textContent = S.step >= list.length && list.length ? "Workout done" : planned ? planned.title : "Free ride";
      $("step-time").textContent = clock(S.elapsed);
      const tl = trainerLine();
      if (tl) lineOf($("step-target"), [`${NAV.route ? NAV.route.name : "Trainer"} · ${tl[0]} `, tl[1], tl[2]]);
      else $("step-target").textContent = list.length ? "Ride easy home" : NAV.route ? `${NAV.route.name}: follow the route` : "No steps — just ride";
      $("step-cue").textContent = ""; $("step-next").textContent = ""; $("step-bar").style.width = "0";
    }

    const spd = speedNow(now), page = curPage();
    paintFields(now, spd, page === "data");
    paintClimbStrip();
    paintWx(now);
    $("fuel").hidden = !S.fuelDue;
    if (S.fuelDue) $("fuel-text").textContent = fuelText();

    $("sb-clock").textContent = hhmm(now);
    paintBrief();
    $("sb-batt").textContent = live.battery ? `${Math.round(live.battery.level * 100)}%` : "";
    $("sb-batt").classList.toggle("low", !!(batt.fc && (rideLeftMin() ?? 0) > batt.fc.hours * 60));
    if (page === "laps") { $("lap-no").textContent = String(S.laps.length + 1); $("lap-time").textContent = clock(S.elapsed - S.lapElapsed); $("lap-sub").textContent = `${distTxt(S.dist - S.lapDist)} ${unitD()}`; }
    if (page === "map") { $("m-speed").textContent = spd == null ? "—" : `${speedTxt(spd)}`; const A = active(); const ast = A ? (NAV.detour ? NAV.detour.st : NAV.st) : null; $("m-left").textContent = ast ? `${distTxt(ast.left)}` : "—"; const v = avgSpeed(); $("m-eta").textContent = ast && v > 1 ? hhmm(now + ast.left / v * 1000) : "—"; }
    renderAhead();
    paintBanner();

    const go = $("btn-start");
    go.textContent = !S.running ? "Start" : S.paused ? "Resume" : S.autoPaused ? "Pause (auto)" : "Pause";
    go.classList.toggle("paused", S.running && !S.paused);
    /** @type {HTMLButtonElement} */ ($("btn-skip")).disabled = !S.running || !list.length || S.step >= list.length;
    /** @type {HTMLButtonElement} */ ($("btn-end")).disabled = !S.running;
    /** @type {HTMLButtonElement} */ ($("btn-lap")).disabled = !S.running;
    /** @type {HTMLSelectElement} */ (daySel).disabled = S.running;
    if (TR.calibrate && !S.running && !note.dataset.cal) { note.dataset.cal = "1"; note.textContent = "The trainer asks for a calibration: run its spin-down in the Tacx Training app (tyre pumped, roller pressed the same as always), then connect it here again."; }
    note.hidden = S.running && !S.paused;   // setup help is for before the ride, not on the bars
    document.body.classList.toggle("riding", S.running && !S.paused);
  }
  // ── the fields: every reading ride mode has, and the ones you've chosen for the Workout row (six) and the Data
  //    screen (any number, 2–4 a row: fewer and bigger on rough ground, like a head unit's zoom) ────────────────────────
  const u = (v, unit) => `${v}<small>${esc(unit)}</small>`;
  const ampm = t => { const x = hhmm(t), m = x.match(/^(.*?)\s*([AaPp]\.?[Mm]\.?)$/); return m ? `${esc(m[1])}<small>${esc(m[2])}</small>` : esc(x); };
  const sunNow = now => { const p = live.lastFix || (NAV.route && NAV.route.pts[0]); return p ? C.sunTimes(new Date(now), p.lat, p.lon) : null; };
  const wpJ = () => (cfg.w_prime_kj ? cfg.w_prime_kj * 1000 : 0);
  /** @type {{id: string, k: string | (() => string), ks?: string, v: (now: number, spd: number | null) => string, s?: (now: number, spd: number | null) => string, flip?: boolean, hide?: () => boolean}[]} */
  const FIELDS = [
    { id: "time", k: "Ride time", ks: "Time", v: () => clock(S.elapsed) },
    { id: "moving", k: "Moving", v: () => clock(S.moving) },
    { id: "dist", k: "Distance", v: () => u(distTxt(S.dist), unitD()), flip: true },
    { id: "speed", k: "Speed", v: (now, spd) => (spd == null ? "—" : u(speedTxt(spd), unitS())), flip: true },
    { id: "avgspd", k: "Avg speed", v: () => (S.moving > 30 ? u(speedTxt(S.dist / S.moving), unitS()) : "—") },
    { id: "maxspd", k: "Max speed", v: () => (S.maxSpeed ? u(speedTxt(S.maxSpeed), unitS()) : "—") },
    { id: "asc", k: "Climbed", v: () => u(eleTxt(S.ascent), unitE()) },
    { id: "grade", k: "Grade", v: () => { const g = gradeNow(); return g == null ? "—" : `${g.toFixed(1)}%`; } },
    { id: "climb", k: "Climb", v: () => { const c = climbNow(); return !c ? "—" : esc(nearTxt(climbText(c.c, c.on, c.at, c.r, c.grade).left)); },
      s: () => { const c = climbNow(); return !c ? "none close" : climbText(c.c, c.on, c.at, c.r, c.grade).field; } },
    { id: "hr", k: "Heart rate", v: now => (live.hr && now - live.hrAt < 5000 ? String(live.hr) : "—") },
    { id: "avghr", k: "Avg HR", v: () => (S.hrSecs ? String(Math.round(S.hrSum / S.hrSecs)) : "—") },
    { id: "maxhr", k: "Max HR", v: () => (S.hrMax ? String(S.hrMax) : "—") },
    { id: "pw", k: "Power", v: () => { const p10 = pw10(); return p10 != null ? u(p10, "W 10s") : S.pwSecs ? u(Math.round(S.pwSum / S.pwSecs), "W avg") : "—"; } },
    { id: "cad", k: "Cadence", v: now => (live.cad != null && now - live.cadAt < 4000 ? u(live.cad, "rpm") : "—") },
    { id: "cadpw", k: () => (live.powerMeter ? "Power" : "Cadence"), v: now => (now - live.powerAt < 4000 ? u(live.power, "W") : live.cad != null && now - live.cadAt < 4000 ? u(live.cad, "rpm") : "—") },
    { id: "load", k: "Load", v: () => `${Math.round(tssNow())}${planned && planned.load ? `<small>/${Math.round(+planned.load)}</small>` : ""}` },
    { id: "lap", k: "Lap", v: () => clock(S.elapsed - S.lapElapsed), s: () => `lap ${S.laps.length + 1} · ${distTxt(S.dist - S.lapDist)} ${unitD()}` },
    { id: "clock", k: "Time of day", v: now => ampm(now) },
    { id: "sunset", k: "Light left", v: now => { const sun = sunNow(now); if (!sun) return "—"; const left = (sun.sunset - now) / 60000; return left > 0 ? (left >= 60 ? `${Math.floor(left / 60)}<small>h</small> ${Math.round(left % 60)}<small>m</small>` : u(Math.round(left), "min")) : "Dark"; },
      s: now => { const sun = sunNow(now); return sun ? `sunset ${hhmm(sun.sunset)}` : ""; } },
    { id: "ele", k: "Elevation", v: () => { const e = NAV.route && NAV.st && !NAV.st.offCourse && NAV.route.hasEle ? NAV.st.ele : live.alt; return e == null ? "—" : u(eleTxt(e), unitE()); } },
    { id: "wind", k: "Wind", v: now => { const c = windNow(now); return c ? esc(dragTxt(c)) : wx.cur && wx.cur.wind < 3 ? "Calm" : "—"; },
      s: now => { const c = windNow(now), so = windSoFar(); return c ? `drag · ${c.watts >= 0 ? "" : "saves "}≈${Math.abs(Math.round(c.watts))} W${so ? ` · ${so}` : ""}` : so || "est. from the forecast as you ride"; } },
    { id: "fuel", k: "Fuel tank", v: () => (S.tank ? u(Math.round(S.tank.left / S.tank.full * 100), "%") : "—"),
      s: () => { if (!S.tank) return "fills in as you ride"; const e = emptyIn(); return `${Math.round(S.tank.burned)} g used · ${Math.round(S.tank.eaten)} g eaten${e != null ? ` · low in ${hm(e / 60)}` : ""}`; } },
    { id: "wbal", k: "W′ left", v: () => (S.wbal == null ? "—" : u(Math.round(S.wbal / wpJ() * 100), "%")), s: () => `${((S.wbal ?? wpJ()) / 1000).toFixed(1)} of ${(wpJ() / 1000).toFixed(1)} kJ above ${cfg.cp} W`, hide: () => !(cfg.cp && wpJ()) },
    { id: "batt", k: "Battery", v: () => (live.battery ? `${Math.round(live.battery.level * 100)}%` : "—"),
      s: () => { const need = rideLeftMin(); return live.battery && live.battery.charging ? "charging" : batt.fc ? `lasts ${hm(batt.fc.hours)}${need != null ? (batt.fc.hours * 60 < need ? " · short of the ride" : " · enough") : ""}${saver.on ? " · saver" : ""}` : saver.on ? "saver on" : ""; } },
  ];
  const FIELD = Object.fromEntries(FIELDS.map(f => [f.id, f]));
  const T_ID = { time: "t-time", dist: "t-dist", speed: "t-speed", cadpw: "t-cad", avghr: "t-avg", load: "t-load" };   // the Workout row's old ids, kept
  const S_ID = { sunset: "d-sunset-at", batt: "d-batt-left" };
  const FIELDS_DEF = { workout: ["time", "dist", "speed", "cadpw", "avghr", "load"],
    data: ["time", "moving", "dist", "speed", "avgspd", "maxspd", "asc", "grade", "hr", "maxhr", "pw", "cad", "clock", "sunset", "ele", "fuel", "wbal", "wind", "batt"], cols: 2 };
  const known = id => !!FIELD[id];
  let FL = (() => {
    const f = jget("fitness-ride-fields", null);
    if (!f || !Array.isArray(f.workout) || !Array.isArray(f.data)) return structuredClone(FIELDS_DEF);
    const w = f.workout.filter(known).slice(0, 6);
    while (w.length < 6) w.push(FIELDS_DEF.workout[w.length]);
    return { workout: w, data: [...new Set(f.data.filter(known))], cols: [2, 3, 4].includes(f.cols) ? f.cols : 2 };
  })();
  const saveFields = () => ls.set("fitness-ride-fields", JSON.stringify(FL));
  const label = (f, short = false) => (typeof f.k === "function" ? f.k() : short && f.ks ? f.ks : f.k);
  /** The Workout row and the Data screen, built from the choices (ids kept stable so nothing else needs to know). */
  function buildFields() {
    const used = new Set(), tile = (f, id, sid, cls = "") => {
      const el = document.createElement(f.flip && cls === "w" ? "button" : "div");
      el.className = `rtile${f.flip && cls === "w" ? " unit-flip" : ""}`;
      el.dataset.f = f.id;
      if (el instanceof HTMLButtonElement) { el.type = "button"; el.setAttribute("aria-label", `${label(f)}; tap to switch imperial / metric`); }
      const k = document.createElement("span"), v = document.createElement("span");
      k.className = "k"; v.className = "v num"; v.textContent = "—";
      if (!used.has(id)) { v.id = id; used.add(id); }
      el.append(k, v);
      if (f.s) { const sub = document.createElement("span"); sub.className = "s"; if (!used.has(sid)) { sub.id = sid; used.add(sid); } el.append(sub); }
      return el;
    };
    $("w-tiles").replaceChildren(...FL.workout.map(id => tile(FIELD[id], T_ID[id] || `t-${id}`, `t-${id}-s`, "w")));
    $("data-grid").replaceChildren(...FL.data.map(id => { const el = tile(FIELD[id], `d-${id}`, S_ID[id] || `d-${id}-s`); el.id = `d-${id}-t`; return el; }));
    $("data-grid").dataset.cols = String(FL.cols);
    document.querySelectorAll("button[data-cols]").forEach(b => b.setAttribute("aria-pressed", String(+(/** @type {HTMLElement} */ (b).dataset.cols) === FL.cols)));
  }
  function paintFields(now, spd, data) {
    const paint = el => {
      const f = FIELD[el.dataset.f];
      if (f.hide && (el.hidden = f.hide())) return;
      el.querySelector(".k").textContent = label(f, el.parentElement.id === "w-tiles");
      el.querySelector(".v").innerHTML = f.v(now, spd);
      if (f.s) el.querySelector(".s").textContent = f.s(now, spd);
    };
    for (const el of $("w-tiles").children) paint(/** @type {HTMLElement} */ (el));
    if (data) for (const el of $("data-grid").children) paint(/** @type {HTMLElement} */ (el));
  }
  $("w-tiles").addEventListener("click", e => { if (/** @type {HTMLElement} */ (e.target).closest(".unit-flip")) { setUnits(!P.km); beep(990, 60); } });
  document.querySelectorAll("button[data-cols]").forEach(b => b.addEventListener("click", () => { FL.cols = +(/** @type {HTMLElement} */ (b).dataset.cols); saveFields(); buildFields(); render(); }));
  // the fields sheet: six selects for the Workout row; the Data screen's list, ticked and ordered with ▲ ▼
  function paintFieldSheet(focus = "") {
    const opts = id => FIELDS.map(f => `<option value="${f.id}"${f.id === id ? " selected" : ""}>${esc(label(f))}</option>`).join("");
    $("fl-workout").innerHTML = FL.workout.map((id, i) => `<label>Field ${i + 1}<select data-slot="${i}">${opts(id)}</select></label>`).join("");
    const order = [...FL.data, ...FIELDS.map(f => f.id).filter(id => !FL.data.includes(id))];
    $("fl-data").innerHTML = order.map(id => {
      const on = FL.data.includes(id), i = FL.data.indexOf(id), name = esc(label(FIELD[id]));
      return `<li${on ? "" : ' class="off"'}><label class="row"><input type="checkbox" data-show="${id}"${on ? " checked" : ""}> ${name}</label>
        <span class="ud"><button type="button" class="chip" data-move="${id}" data-by="-1" aria-label="Move ${name} up"${on && i > 0 ? "" : " disabled"}>▲</button><button type="button" class="chip" data-move="${id}" data-by="1" aria-label="Move ${name} down"${on && i < FL.data.length - 1 ? "" : " disabled"}>▼</button></span></li>`;
    }).join("");
    const again = focus && /** @type {HTMLElement | null} */ (document.querySelector(focus));
    if (again && !(/** @type {HTMLButtonElement} */ (again).disabled)) again.focus();
  }
  const fieldsChanged = (focus = "") => { saveFields(); buildFields(); paintFieldSheet(focus); render(); };
  $("btn-fields").addEventListener("click", () => { paintFieldSheet(); $("fields").showModal(); });
  $("fields").addEventListener("change", e => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.dataset.slot != null) { FL.workout[+t.dataset.slot] = t.value; fieldsChanged(`[data-slot="${t.dataset.slot}"]`); }
    else if (t.dataset.show) { FL.data = t.checked ? [...FL.data, t.dataset.show] : FL.data.filter(x => x !== t.dataset.show); fieldsChanged(`[data-show="${t.dataset.show}"]`); }
  });
  $("fields").addEventListener("click", e => {
    const b = /** @type {HTMLElement} */ (e.target).closest("[data-move]");
    if (b) {
      const id = /** @type {HTMLElement} */ (b).dataset.move, by = +(/** @type {HTMLElement} */ (b).dataset.by), i = FL.data.indexOf(id), j = i + by;
      if (i < 0 || j < 0 || j >= FL.data.length) return;
      [FL.data[i], FL.data[j]] = [FL.data[j], FL.data[i]];
      fieldsChanged(`[data-move="${id}"][data-by="${by}"]`);
    }
    if (/** @type {HTMLElement} */ (e.target).id === "fl-reset") { FL = structuredClone(FIELDS_DEF); fieldsChanged("#fl-reset"); }
  });
  buildFields();

  // ── screens: tabs, and a swipe across the screen to change them ───────────────────────────────────────────
  const TABS = ["workout", "map", "ahead", "data", "laps"];
  const asked = new URLSearchParams(location.search).get("page");
  let page = TABS.includes(asked || "") ? asked : TABS.includes(ls.get("fitness-ride-page") || "") ? ls.get("fitness-ride-page") : "workout";
  const curPage = () => page;
  function show(p, focus = false) {
    page = p; ls.set("fitness-ride-page", p);
    for (const t of TABS) {
      const tab = $(`tab-${t}`), on = t === p;
      tab.setAttribute("aria-selected", String(on)); tab.tabIndex = on ? 0 : -1; $(`pg-${t}`).hidden = !on;
      if (on && focus) tab.focus();
    }
    document.body.dataset.page = p;
    if (p === "map") { ensureMap(); setTimeout(() => { if (MAP.ready) MAP.map.resize(); paintMap(live.lastFix, true); drawCrumb(); }, 30); }
    if (p === "ahead") renderAhead(true);
    if (p === "laps") paintLaps();
    render();
  }
  for (const t of TABS) $(`tab-${t}`).addEventListener("click", () => show(t));
  document.querySelector(".rtabs").addEventListener("keydown", e => {
    const i = TABS.indexOf(page);
    if (e.key === "ArrowRight") show(TABS[(i + 1) % TABS.length], true);
    else if (e.key === "ArrowLeft") show(TABS[(i + TABS.length - 1) % TABS.length], true);
  });
  let touch = null;
  $("pages").addEventListener("touchstart", e => { const t = e.touches[0]; touch = /** @type {HTMLElement} */ (e.target).closest(".map, canvas, input, select") ? null : { x: t.clientX, y: t.clientY, at: Date.now() }; }, { passive: true });
  $("pages").addEventListener("touchend", e => {
    if (!touch) return;
    const t = e.changedTouches[0], dx = t.clientX - touch.x, dy = t.clientY - touch.y;
    if (Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy) && Date.now() - touch.at < 600) { const i = TABS.indexOf(page); show(TABS[(i + (dx < 0 ? 1 : TABS.length - 1)) % TABS.length]); }
    touch = null;
  }, { passive: true });

  // ── controls ────────────────────────────────────────────────────────────────────────────────────────────
  $("btn-start").addEventListener("click", () => {
    if (!audio) { try { audio = new (window.AudioContext || /** @type {any} */ (window).webkitAudioContext)(); } catch { audio = null; } }
    if (audio && audio.state === "suspended") audio.resume();
    startGps();
    if (!S.running || S.paused) refreshWx();   // Start and Resume fetch the weather where you are now
    const now = Date.now();
    if (!S.running) {
      const plan = S.plan, quick = S.quick, intensity = S.intensity;
      FREE.said = []; FREE.offSince = 0;   // a new ride: every climb gets its callouts again
      Object.assign(S, fresh(), { running: true, plan, quick, intensity, rideId: uid(), wallStart: now, lapStart: now });
      samples = []; hrSpeed.length = 0; stops.length = 0; check = null; checkSaid = ""; hotFrom = 0; rollAt = 0; moving = false; rep = { under: 0, high: 0, n: 0 };
      const st = steps();
      if (st.length) { const s = st[0]; say(`${planned && planned.eased ? `${planned.eased}. ` : ""}${planned ? planned.title : "Workout"}. First, ${s.name}, ${Math.round(s.min)} minutes.`); }
      else if (NAV.route) say(`${NAV.route.name}. ${nearSay(NAV.route.total)}${NAV.route.hasEle ? `, ${eleTxt(NAV.route.gain)} ${P.km ? "metres" : "feet"} of climbing` : ""}.`);
      if (NAV.nav) NAV.nav.seek(0);
      saver.declined = false; saver.auto = false; batt.log = []; batt.fc = null;
      setSaver(P.saver === "on");
      beep(880, 200, 2);
      wake();
      if (P.autoLock) setTimeout(() => { if (S.running) setTouchLock(true); }, 1500);   // after the Start tap has landed
    } else {
      S.paused = !S.paused;
      if (S.paused) { S.pauses.push([now, 0]); if (lock) lock.release().catch(() => {}); flush(true); }
      else { const p = S.pauses[S.pauses.length - 1]; if (p && !p[1]) p[1] = now; wake(); }
    }
    last = Date.now();
    save(); render();
  });
  $("btn-skip").addEventListener("click", () => { advance(true); beep(990, 120); render(); });
  $("btn-lap").addEventListener("click", () => { lap(0); beep(990, 120); say(`Lap ${S.laps.length}. ${clock(S.laps[S.laps.length - 1]?.time || 0)}.`, false); render(); });
  $("fuel-ok").addEventListener("click", () => {   // eaten: into the tank
    S.fuelDue = false;
    if (S.running) { if (!S.tank) S.tank = C.tank(P.weight); C.eat(S.tank, fuelGrams()); if (S.tank.left / S.tank.full > 0.5) S.fuelSaid = 0; }
    render();
  });
  // ── press and hold: End (and the unlock bar) fill from the left while held, and act when full. A tap on End asks
  //    first instead; a keyboard press acts on the button as usual.
  function holdable(btn, ms, done) {
    let timer = 0, firedAt = 0;
    btn.style.setProperty("--hold-ms", `${ms}ms`);
    const stop = () => { clearTimeout(timer); btn.classList.remove("holding"); };
    btn.addEventListener("pointerdown", e => {
      if (/** @type {HTMLButtonElement} */ (btn).disabled || e.button > 0) return;
      firedAt = 0; btn.classList.add("holding");
      timer = window.setTimeout(() => { firedAt = Date.now(); stop(); buzz(40); done(); }, ms);
    });
    for (const ev of ["pointerup", "pointerleave", "pointercancel"]) btn.addEventListener(ev, stop);
    btn.addEventListener("contextmenu", e => e.preventDefault());   // a long press is ours, not the browser's menu
    // true once, just after a completed hold: the click that follows it is spent. Time-boxed, because a hold that hides
    // or disables its button (End, unlock) never gets that click, and the next real tap must not be swallowed
    return (/** @type {MouseEvent} */ e) => { if (e.detail === 0) return false; const f = Date.now() - firedAt < 600; firedAt = 0; return f; };   // a keyboard click is never a hold's
  }
  const endHeld = holdable($("btn-end"), 900, () => endRide());
  $("btn-end").addEventListener("click", async e => {
    if (endHeld(e) || !S.running) return;
    if (!await ask("End the ride?", "The ride is saved on this phone with its laps, ready to export or send to your sync. Next time, hold End for a second to finish without this question.", "End ride")) return;
    endRide();
  });

  // ── the touch lock: rain and bumps press buttons. Locked, the readings stay in view and nothing takes a touch but
  //    the unlock bar along the bottom, which wants a one-second hold. Lock it from the footer, or at Start (Settings).
  function setTouchLock(on) {
    if (on === !$("lockveil").hidden) return;
    $("lockveil").hidden = !on;
    for (const el of [document.querySelector(".rtop"), $("pages"), document.querySelector(".rfoot")]) if (el) /** @type {any} */ (el).inert = on;
    document.body.classList.toggle("locked", on);
    buzz(30);
    if (on) $("btn-unlock").focus(); else $("btn-lock").focus();
  }
  const unlockHeld = holdable($("btn-unlock"), 800, () => setTouchLock(false));
  $("btn-unlock").addEventListener("click", e => { if (unlockHeld(e)) return; if (e.detail === 0) setTouchLock(false); });   // Enter / Space unlocks; a touch needs the hold
  $("btn-lock").addEventListener("click", () => setTouchLock(true));

  async function endRide() {
    if (!S.running) return;
    setTouchLock(false);
    const now = Date.now();
    lap(0, now);
    S.running = false; S.paused = false; S.autoPaused = false;
    releaseTrainer();
    if (lock) lock.release().catch(() => {});
    await flush(true);
    const ride = await saveRide(now);
    ls.set("fitness-ride-last", JSON.stringify({ ...S, endedAt: now, samples: undefined }));
    ls.set("fitness-ride-state", null);
    S.step = 0; S.stepStart = 0;
    showRide(ride, true);
    if (ride.elapsed >= 120) queueRide(ride.id);
    render();
  }
  daySel.addEventListener("change", pickDay);

  // ── saved rides: summary, laps and exports ───────────────────────────────────────────────────────────────
  const slug = s => String(s || "ride").replace(/[^\w\d-]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "ride";
  /** What this ride did, in a few lines: the work against the target, the training effect on fitness and form, the
   *  next event, and the commute check. */
  function rideNote(tss) {
    const B = cfg.brief && cfg.brief.date === iso(new Date(S.wallStart || Date.now())) ? cfg.brief : null, out = [];
    if (S.workSecs >= 120) out.push(`Work on target ${Math.round(S.workOn / 60)} of ${Math.round(S.workSecs / 60)} min (${Math.round(S.workOn / S.workSecs * 100)}%)${S.workOn / S.workSecs >= 0.7 ? ": the session did its job" : S.workOn / S.workSecs >= 0.4 ? ": most of what it asked" : ": heart rate rarely got there — a sign to rest more before the next hard day"}.`);
    else if (S.tgtSecs >= 300) out.push(`Heart rate on target ${Math.round(S.tgtOn / S.tgtSecs * 100)}% of the time${S.tgtOn / S.tgtSecs >= 0.7 ? ", easy where easy was asked: that's the aerobic work that builds the base" : ""}.`);
    const zt = S.zones.reduce((a, b) => a + b, 0);
    if (zt >= 300) out.push(`Zones: ${Math.round((S.zones[0] + S.zones[1]) / zt * 100)}% in Z1–Z2, ${Math.round((S.zones[3] + S.zones[4]) / zt * 100)}% at Z4–Z5.`);
    if (B && B.ctl != null && B.atl != null) {
      const ctl = B.ctl + (tss - B.ctl) / 42, atl = B.atl + (tss - B.atl) / 7;
      out.push(`Load ${tss}${planned && planned.load ? ` of ${Math.round(+planned.load)} planned` : ""}: fitness ${B.ctl.toFixed(1)} → ${ctl.toFixed(1)}, form tomorrow about ${Math.round(ctl - atl) > 0 ? "+" : ""}${Math.round(ctl - atl)}.`);
      const T = B.target, raceName = cfg.race && cfg.race.name ? cfg.race.name.replace(/^Bell's\s+/, "") : "the race";
      if (T && T.days != null) out.push(T.ctl - ctl > 1 ? `${raceName} in ${T.days} days asks for fitness ${T.ctl}: ${(T.ctl - ctl).toFixed(1)} to go, and the plan's coming weeks are built for it.` : `${raceName} in ${T.days} days: fitness is at its target ${T.ctl}, so the job now is arriving fresh.`);
    } else out.push(`Load ${tss}${planned && planned.load ? ` of ${Math.round(+planned.load)} planned` : ""}.`);
    if (S.tank && S.tank.burned > 30) out.push(`Fuel: about ${Math.round(S.tank.burned)} g of carbohydrate burned, ${Math.round(S.tank.eaten)} g eaten; the tank ended near ${Math.round(S.tank.left / S.tank.full * 100)}%${S.tank.left / S.tank.full < 0.3 ? ": eat more, earlier, on rides this long" : ""}.`);
    if (S.windSecs >= 600 && Math.abs(S.windSec) >= 60) {
      const pc = x => Math.round(x / S.windSecs * 100);
      out.push(`Wind (estimated from the forecast): it ${S.windSec > 0 ? "cost you" : "gave you"} about ${Math.round(Math.abs(S.windSec) / 60)} min; headwind ${pc(S.windHead)}% of the time, tailwind ${pc(S.windTail)}%.`);
    }
    if (checkSaid === "hot") out.push("The commute check ran hot on steady riding: worth an easy day and an early night.");
    else if (checkSaid === "fresh") out.push("The commute check ran fresh: lower heart rate than usual for the speed.");
    return out;
  }
  async function saveRide(now) {
    const tss = Math.round(tssNow());
    const name = `${planned ? planned.title : NAV.route ? NAV.route.name : "Ride"} · ${new Date(S.wallStart || now).toLocaleDateString([], { month: "short", day: "numeric" })}`;
    const meta = { id: S.rideId || uid(), name, start: S.wallStart || now - S.elapsed * 1000, end: now, elapsed: S.elapsed, moving: S.moving, dist: S.dist, ascent: S.ascent, maxSpeed: S.maxSpeed,
      avgHr: S.hrSecs ? S.hrSum / S.hrSecs : null, maxHr: S.hrMax || null, avgCad: S.cadSecs ? S.cadSum / S.cadSecs : null, avgPower: S.pwSecs ? S.pwSum / S.pwSecs : null, tss, planned: planned && planned.load ? Math.round(+planned.load) : null,
      zones: S.zones, laps: S.laps, pauses: S.pauses, route: NAV.route ? NAV.route.name : null, routeId: NAV.route ? NAV.route.id : null,
      startLL: (s => (s ? [s[1], s[2]] : null))(samples.find(x => x[1] != null)), check, indoor: !samples.some(s => s[1] != null), trainer: TR.used, note: rideNote(tss) };
    try {
      await DB.put("tracks", { id: meta.id, samples });
      await DB.put("rides", meta);
      if (S.rideId) await DB.delRange("chunks", `${S.rideId}:`, `${S.rideId}:￿`);
    } catch { /* storage full: the summary still shows, and the export still works from memory */ }
    meta._samples = samples;
    return meta;
  }
  let shown = null;
  function showRide(r, justNow = false) {
    shown = r;
    // built from text nodes only: a saved ride is data from this phone's storage, and never becomes markup
    const n = x => (Number.isFinite(+x) ? +x : 0);
    const zones = (Array.isArray(r.zones) ? r.zones : [0, 0, 0, 0, 0]).slice(0, 5).map(n), zt = zones.reduce((a, b) => a + b, 0) || 1;
    const node = (tag, cls, ...kids) => { const e = document.createElement(tag); if (cls) e.className = cls; e.append(...kids.filter(k => k != null && k !== "").map(k => (typeof k === "object" ? k : String(k)))); return e; };
    const cell = (k, v) => node("div", "", k, node("b", "", v));
    const laps = Array.isArray(r.laps) ? r.laps : [];
    const grid = node("div", "sum",
      cell("Time", clock(n(r.elapsed))), cell("Moving", clock(n(r.moving))),
      cell("Distance", `${distTxt(n(r.dist))} ${unitD()}`), cell("Avg speed", `${n(r.moving) ? speedTxt(n(r.dist) / n(r.moving)) : "—"} ${unitS()}`),
      cell("Avg HR", r.avgHr ? Math.round(n(r.avgHr)) : "—"), cell("Max HR", r.maxHr ? Math.round(n(r.maxHr)) : "—"),
      cell("Load (hrTSS)", `${Math.round(n(r.tss))}${r.planned ? ` / ${Math.round(n(r.planned))}` : ""}`), cell("Avg cadence", r.avgCad ? Math.round(n(r.avgCad)) : "—"),
      cell("Climbed", `${eleTxt(n(r.ascent))} ${unitE()}`),
      r.avgPower ? cell("Avg power", `${Math.round(n(r.avgPower))} W`) : cell("Max speed", `${speedTxt(n(r.maxSpeed))} ${unitS()}`));
    const bar = node("div", "zbar sumbar", node("span"), node("span"), node("span"), node("span"), node("span"));
    bar.style.gridTemplateColumns = zones.map(z => `${Math.max(0.5, z / zt * 100)}fr`).join(" ");
    const v = r.check && ["hot", "fresh", "normal"].includes(r.check.verdict) ? r.check : null;
    const did = Array.isArray(r.note) && r.note.length ? node("div", "did", node("h3", "k", "What this ride did"), node("ul", "", ...r.note.slice(0, 6).map(t => node("li", "", String(t))))) : null;
    $("sum-body").replaceChildren(...[did, grid, bar,
      node("p", "note mt-2", zones.map((z, i) => `Z${i + 1} ${clock(z)}`).join(" · ")),
      laps.length > 1 ? node("p", "note", `${laps.length} laps · ${laps.slice(0, 12).map((l, i) => `${i + 1}: ${clock(n(l.time))}`).join(" · ")}${laps.length > 12 ? " …" : ""}`) : null,
      v ? node("p", "note", `Commute check: HR ${n(v.diff) >= 0 ? "+" : "−"}${Math.abs(Math.round(n(v.diff)))} bpm against your usual for the speed (${v.verdict}).`) : null,
      node("p", "note", `${justNow ? "Saved on this phone. " : ""}FIT goes straight into Garmin Connect (Import data), Strava (Upload) or TrainingPeaks. The watch's own file is still the official record, so upload this one only for rides the watch didn't record.`),
      Object.assign(node("p", "note"), { id: "sum-sync" })].filter(Boolean));
    $("sum-exports").hidden = false;
    paintSync();
    $("summary").showModal();
  }
  async function rideSamples(r) { return r._samples || ((await DB.get("tracks", r.id).catch(() => null)) || { samples: [] }).samples; }
  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  $("sum-exports").addEventListener("click", async e => {
    const b = /** @type {HTMLElement} */ (e.target).closest("[data-export]");
    if (!b || !shown) return;
    const kind = b.dataset.export, r = shown;
    if (kind === "delete") {
      if (!await ask("Delete this ride?", "It's removed from this phone for good. A copy already sent to your sync or Garmin Connect stays there.", "Delete")) return;
      await DB.del("rides", r.id).catch(() => {}); await DB.del("tracks", r.id).catch(() => {});
      $("summary").close(); paintRides(); return;
    }
    const full = { ...r, samples: await rideSamples(r) }, base = slug(`${new Date(r.start).toISOString().slice(0, 10)}-${r.name.split(" · ")[0]}`);
    const fit = () => new File([C.toFIT(full)], `${base}.fit`, { type: "application/vnd.ant.fit" });
    if (kind === "route") {
      try {
        const raw = C.rideRoute(r.name.split(" · ")[0], full.samples), id = uid(), route = C.analyze({ ...raw, id });
        await DB.put("routes", C.storable(raw, { id, added: Date.now(), dist: route.total, gain: route.gain, climbs: route.climbs.length, turns: route.turns.length, fromRide: r.id }));
        $("sum-sync").textContent = `Saved as a route: ${route.name}, ${distTxt(route.total)} ${unitD()}. Ride it again from Map → Routes, against this ride.`;
      } catch (err) { $("sum-sync").textContent = String((err && err.message) || err); }
      return;
    }
    if (kind === "fit") download(fit(), `${base}.fit`);
    else if (kind === "gpx") download(new Blob([C.toGPX(full)], { type: "application/gpx+xml" }), `${base}.gpx`);
    else if (kind === "tcx") download(new Blob([C.toTCX(full)], { type: "application/vnd.garmin.tcx+xml" }), `${base}.tcx`);
    else if (kind === "share") {
      const f = fit();
      if (navigator.canShare && navigator.canShare({ files: [f] })) { try { await navigator.share({ files: [f], title: r.name }); } catch { /* cancelled */ } }
      else download(f, f.name);
    }
  });
  async function paintRides() {
    const rows = (await DB.all("rides").catch(() => [])).sort((a, b) => b.start - a.start);
    $("ride-list").innerHTML = rows.length ? rows.map(r => `<li><div class="rl-main"><b>${esc(r.name)}</b><span>${new Date(r.start).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${distTxt(r.dist)} ${unitD()} · ${clock(r.moving || r.elapsed)}${r.avgHr ? ` · ${Math.round(r.avgHr)} bpm` : ""} · ${r.tss} TSS</span></div>
      <div class="rl-btns"><button type="button" class="chip primary" data-open="${esc(r.id)}">Open</button></div></li>`).join("") : `<li class="none">No saved rides yet: they're kept here when you tap End.</li>`;
  }
  $("ride-list").addEventListener("click", async e => {
    const b = /** @type {HTMLElement} */ (e.target).closest("[data-open]");
    if (!b) return;
    const r = await DB.get("rides", b.dataset.open);
    if (r) { $("rides").close(); showRide(r); }
  });
  $("btn-rides").addEventListener("click", () => { paintRides(); $("rides").showModal(); });

  // ── to the training sync: a ride rides a "service" run of the sync's workflow (its one text input carries the ride,
  //    deflated), and the sync's status.json lists the rides it has, so one lost in GitHub's queue is sent again ──
  const cloud = () => { try { const x = JSON.parse(ls.get("fitness-cloud") || "null"); return x && x.repo && x.token ? x : null; } catch { return null; } };
  const outbox = () => jget("fitness-ride-outbox", []).filter(x => x && typeof x.id === "string");
  const setOutbox = list => ls.set("fitness-ride-outbox", list.length ? JSON.stringify(list.slice(-20)) : null);
  let sending = false, syncWhy = "";
  async function packRide(r, rows) {
    for (const step of [5, 10, 20, 30, 60]) {
      const z = new Uint8Array(await new Response(new Blob([JSON.stringify(C.rideDigest(r, rows, step))]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
      let s = "";
      for (let i = 0; i < z.length; i += 0x8000) s += String.fromCharCode(...z.subarray(i, i + 0x8000));
      const code = `ride:${btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
      if (code.length < 60000) return code;   // GitHub takes 65,535 characters of inputs
    }
    return null;
  }
  const REPO = /^([A-Za-z0-9-]{1,39})\/([\w.-]{1,100})$/;   // owner/name, and nothing else reaches the URL
  const ghApi = (x, path, init = {}) => {
    const m = REPO.exec(String(x.repo || ""));
    if (!m) return Promise.reject(new Error("not a repository name"));
    return fetch(`https://api.github.com/repos/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}${path}`, { cache: "no-store", ...init,
    headers: { Authorization: `Bearer ${x.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) } });
  };
  function queueRide(id) { if (!outbox().some(x => x.id === id)) setOutbox([...outbox(), { id, sent: 0, tries: 0 }]); sendRides(); }
  async function sendRides() {
    const x = cloud();
    if (!x || !P.upload || sending || !outbox().length) { paintSync(); return; }
    if (!navigator.onLine) { syncWhy = "Waiting for a signal to send it to the training sync."; paintSync(); return; }
    sending = true;
    try {
      // what the sync already has (status.json on its state branch)
      const st = await ghApi(x, "/contents/status.json?ref=state", { headers: { Accept: "application/vnd.github.raw+json" } }).then(r => (r.ok ? r.json() : null)).catch(() => null);
      const have = new Set(st && Array.isArray(st.rides) ? st.rides : []);
      for (const item of outbox()) {
        const r = await DB.get("rides", item.id).catch(() => null);
        if (!r || have.has(item.id)) {
          setOutbox(outbox().filter(o => o.id !== item.id));
          if (r && !r.synced) { r.synced = Date.now(); await DB.put("rides", r).catch(() => {}); }
          continue;
        }
        if (item.sent && Date.now() - item.sent < 40 * 60e3) continue;   // in GitHub's queue: give it time
        if (item.tries >= 5) { setOutbox(outbox().filter(o => o.id !== item.id)); syncWhy = "The training sync never took this ride: export the FIT and upload it by hand."; continue; }
        const code = await packRide(r, await rideSamples(r));
        if (!code) { setOutbox(outbox().filter(o => o.id !== item.id)); continue; }
        const res = await ghApi(x, "/actions/workflows/training.yml/dispatches", { method: "POST", body: JSON.stringify({ ref: x.branch || "main", inputs: { action: "service", code } }) });
        if (!res.ok) { syncWhy = res.status === 401 ? "GitHub didn't accept the app's token: connect the sync again on the dashboard." : res.status === 403 ? "The app's token can't start the sync (it needs Actions: read and write)." : `GitHub answered ${res.status}; it will try again.`; break; }
        setOutbox(outbox().map(o => (o.id === item.id ? { ...o, sent: Date.now(), tries: o.tries + 1 } : o)));
        r.sent = Date.now(); await DB.put("rides", r).catch(() => {});
        syncWhy = "";
      }
    } catch { syncWhy = "Couldn't reach GitHub: it will try again."; } finally { sending = false; }
    paintSync();
  }
  /** The summary's line about the sync. */
  function paintSync() {
    const el = $("sum-sync");
    if (!el || !shown) return;
    const r = shown, queued = outbox().some(o => o.id === r.id);
    el.textContent = !cloud() ? "Connect the training sync on the dashboard and rides go to it by themselves."
      : !P.upload ? "Sending rides to the training sync is off (settings)."
      : r.synced ? "In the training sync: it counts in the plan, and goes to Garmin Connect if the watch didn't record it."
      : syncWhy && queued ? syncWhy
      : queued || r.sent ? "Sent to the training sync: it counts in the plan from its next run." : "";
  }
  window.addEventListener("online", sendRides);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sendRides(); });

  // ── settings ────────────────────────────────────────────────────────────────────────────────────────────
  const dlg = $("settings");
  const inp = id => /** @type {HTMLInputElement} */ ($(id));
  $("btn-settings").addEventListener("click", () => {
    inp("s-lthr").value = P.lthr; inp("s-max").value = P.max; inp("s-rest").value = P.rest; inp("s-wheel").value = P.wheel; inp("s-fuel").value = P.fuel;
    inp("s-ftp").value = P.ftp || 0; inp("s-autolap").value = P.autoLap || 0;
    inp("s-voice").checked = P.voice; inp("s-autopause").checked = P.autoPause; inp("s-autolock").checked = P.autoLock; inp("s-steplap").checked = P.stepLap; inp("s-climbs").checked = P.climbs; inp("s-reroute").checked = P.reroute;
    /** @type {HTMLSelectElement} */ ($("s-profile")).value = P.profile;
    /** @type {HTMLSelectElement} */ ($("s-trainer")).value = P.trainer; /** @type {HTMLSelectElement} */ ($("s-saver")).value = P.saver;
    /** @type {HTMLSelectElement} */ ($("s-freeride")).value = P.freeride;
    inp("s-weight").value = P.weight; inp("s-upload").checked = P.upload;
    paintUnits();
    dlg.showModal();
  });
  dlg.addEventListener("close", () => {
    if (dlg.returnValue !== "save") return;
    const num = (id, d) => { const v = parseFloat(inp(id).value); return Number.isFinite(v) ? v : d; };
    Object.assign(P, { lthr: num("s-lthr", P.lthr), max: num("s-max", P.max), rest: num("s-rest", P.rest), wheel: num("s-wheel", P.wheel), fuel: num("s-fuel", P.fuel),
      ftp: num("s-ftp", P.ftp), autoLap: num("s-autolap", P.autoLap), voice: inp("s-voice").checked, autoPause: inp("s-autopause").checked, autoLock: inp("s-autolock").checked, stepLap: inp("s-steplap").checked,
      climbs: inp("s-climbs").checked, reroute: inp("s-reroute").checked, profile: /** @type {HTMLSelectElement} */ ($("s-profile")).value,
      trainer: /** @type {HTMLSelectElement} */ ($("s-trainer")).value, saver: /** @type {HTMLSelectElement} */ ($("s-saver")).value, weight: num("s-weight", P.weight), upload: inp("s-upload").checked,
      freeride: /** @type {HTMLSelectElement} */ ($("s-freeride")).value });
    if (P.freeride === "off") { FREE.route = null; FREE.st = null; mapFree(); }
    if (TR.kind === "Tacx FE-C") send(C.fecUser(P.weight, 9, P.wheel));
    setSaver(P.saver === "on" || (P.saver === "auto" && saver.auto));
    savePrefs();
    render();
  });

  // imperial / metric: the segmented pair in settings, or a tap on the distance or speed reading mid-ride
  const unitBtns = [...document.querySelectorAll("[data-units]")];
  const paintUnits = () => unitBtns.forEach(b => b.setAttribute("aria-pressed", String((/** @type {HTMLElement} */ (b).dataset.units === "km") === P.km)));
  const setUnits = km => { P.km = km; ls.set("fitness-units", km ? "km" : "mi"); paintUnits(); paintRouteBits(); paintLaps(); render(); };
  unitBtns.forEach(b => b.addEventListener("click", () => setUnits(/** @type {HTMLElement} */ (b).dataset.units === "km")));
  paintUnits();

  // light / auto / dark: dark unless chosen otherwise; shared with the dashboard. Applies the moment it's tapped, and in
  // auto follows the phone as it switches (battery saver keeps true black either way)
  const themeBtns = [...document.querySelectorAll("[data-theme-pick]")];
  const paintTheme = () => themeBtns.forEach(b => b.setAttribute("aria-pressed", String(/** @type {HTMLElement} */ (b).dataset.themePick === UI.pref())));
  const applyTheme = () => {
    const was = document.documentElement.dataset.theme;
    UI.apply(saver.on);
    paintTheme();
    if (was !== document.documentElement.dataset.theme) { drawCrumb(); renderAhead(true); restyleMap(); }
  };
  themeBtns.forEach(b => b.addEventListener("click", () => { ls.set("fitness-theme", /** @type {HTMLElement} */ (b).dataset.themePick); applyTheme(); }));
  UI.deviceDark.addEventListener("change", applyTheme);
  paintTheme();

  // the screen's own height, measured: the footer's Start / Lap / Next / End must never sit under the system bars
  const fitScreen = () => {
    const h = Math.round(window.visualViewport ? Math.min(window.visualViewport.height, window.innerHeight) : window.innerHeight);
    if (h > 200) document.body.style.setProperty("--app-h", `${h}px`);
  };
  fitScreen();
  window.addEventListener("resize", fitScreen);
  window.addEventListener("orientationchange", () => setTimeout(fitScreen, 300));
  if (window.visualViewport) window.visualViewport.addEventListener("resize", fitScreen);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") setTimeout(fitScreen, 100); });

  // installed-app offline: the same service worker as the dashboard (scope: this folder)
  if ("serviceWorker" in navigator && window.isSecureContext && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});

  // ── start-up: the session, the route, and a ride restored after a reload ──────────────────────────────────
  planned = dayOf(daySel.value);
  if (!S.running || !S.plan.length) { S.plan = planned ? planned.steps.map(s => ({ ...s })) : S.plan; if (!S.running) S.intensity = 1; }
  if (S.running) { note.textContent = "Ride restored after a reload — tap Resume."; startGps(); await restoreSamples(); }
  const lastRoute = ls.get("fitness-ride-route");
  if (lastRoute) await useRoute(lastRoute, false).catch(() => {});
  await raceCourse().catch(() => {});
  setInterval(tick, 1000);
  if (document.fonts) document.fonts.ready.then(() => { if (NAV.route) renderAhead(true); }).catch(() => {});   // the profiles' figures, redrawn in Helvetica once it's in
  setTimeout(sendRides, 3000);   // anything waiting from an earlier ride
  show(page);
  paintLaps();
  /** @type {any} */ (window).__ride = { S, NAV, P, MAP, get rep() { return rep; }, onFix: f => { live.lastFix = f; onFix(f); }, importFiles, useRoute, live, samples: () => samples, DB,
    TR, batt, saver, sendRides, outbox, reroute, paceNow, wx, offerGo, routeTo, findGhosts, FREE, windNow, heights, graphMemo, raceCourse };
})();
