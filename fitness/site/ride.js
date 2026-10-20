"use strict";
// Ride mode: a cycling computer on the phone on your bars.
//   Workout  the day's session as timed steps with HR (and power) targets, tailored as you ride
//   Map      the route, where you are and where you've been, turn by turn, offline along a downloaded route
//   Ahead    the elevation profile, the next climb (ClimbPro-style), the turns, stops and the wind still to come
//   Data     every live figure, big;  Laps  manual, per-step and auto laps
// Sensors over Web Bluetooth, position from the phone's GPS, routes from GPX / TCX files (or shared from any app),
// detours from BRouter. Rides are kept on this phone and export as FIT, GPX or TCX; nothing is uploaded by itself.
(async () => {
  const C = /** @type {any} */ (window).RideCore;
  const $ = id => document.getElementById(id);
  // keep figures with their units so a cue never breaks "3 / min" on a phone-width line
  const nb = t => String(t ?? "").replace(/ × /g, "\u00a0×\u00a0").replace(/(\d) (?=(?:min|h|s|mi|km|ft|m|bpm|W|g|rpm|TSS|%)(?!\w))/g, "$1\u00a0")
    .replace(/(RPE|Z\d|\+|−|~) (?=[\d(])/g, "$1\u00a0").replace(/(\d)–(?=\d)/g, "$1\u2060–\u2060");   // word joiners keep 88–93 whole
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  const jget = (k, d) => { try { return JSON.parse(ls.get(k) || "null") ?? d; } catch { return d; } };

  // ── config: a link from the dashboard (#z= deflate-raw, or #c= plain; base64url JSON) > inlined by the build >
  //    the last one saved on this phone. A fragment never reaches the server, and it's treated as untrusted text.
  const bytes = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  const inflate = async s => new Response(new Blob([bytes(s)]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
  let cfg = null;
  const frag = new URLSearchParams(location.hash.slice(1));
  if (frag.has("move")) {   // the move from chrisrohn.com/fitness/: this phone's settings from there (never over newer ones here)
    try { const got = JSON.parse(await inflate(frag.get("move"))); for (const [key, v] of Object.entries(got || {})) if (/^fitness-[\w:-]+$/.test(key) && typeof v === "string" && ls.get(key) == null) ls.set(key, v); } catch { /* start fresh */ }
    frag.delete("move");
    history.replaceState(null, "", location.pathname + location.search + (frag.toString() ? `#${frag}` : ""));
  }
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
  };
  const savePrefs = () => ls.set("fitness-ride-prefs", JSON.stringify({ lthr: P.lthr, max: P.max, rest: P.rest, wheel: P.wheel, fuel: P.fuel, voice: P.voice, ftp: P.ftp,
    autoPause: P.autoPause, stepLap: P.stepLap, autoLap: P.autoLap, climbs: P.climbs, reroute: P.reroute, profile: P.profile, headingUp: P.headingUp }));

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
    laps: [], lapStart: 0, lapElapsed: 0, lapDist: 0, pauses: [], autoPaused: false, still: 0, ascent: 0, maxSpeed: 0, held: 0, missed: 0, hot: 0, loadOffered: false, navAlong: 0, battSaid: false });
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
          if (S.running && !S.paused && !S.autoPaused) S.dist += dr * P.wheel;
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
  };
  const hooked = new WeakSet();
  const helpHtml = kind => kind === "hr"
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
    const a = await hook("cycling_speed_and_cadence", "csc_measurement", onCsc);
    const b = await hook("cycling_power", "cycling_power_measurement", onPower);
    if (b) $("t-cad-k").textContent = "Power";
    return a || b;
  }
  // one live sensor per kind; a connection that fails says why (and what to try) instead of just turning red
  const conn = { hr: null, csc: null };
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
      if (!quiet) help(kind, `${name} connected but sends no ${kind === "hr" ? "heart rate" : "cadence, speed or power"}.`);
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
  if (!navigator.bluetooth) noBluetooth();
  else if (typeof navigator.bluetooth.getDevices === "function") {
    navigator.bluetooth.getDevices().then(list => {
      for (const kind of ["hr", "csc"]) {
        const d = list.find(x => x.id === ls.get(`fitness-ride-${kind}`));
        if (d) { conn[kind] = d; rejoin(d, kind); }
      }
    }).catch(() => {});
  }

  // ── GPS ─────────────────────────────────────────────────────────────────────────────────────────────────
  const hav = C.hav, bearing = C.bearing;
  let watch = null;
  const startGps = () => {
    if (!("geolocation" in navigator) || watch != null) return;
    chip("gps-chip", "wait");
    watch = navigator.geolocation.watchPosition(pos => {
      const c = pos.coords, fix = { lat: c.latitude, lon: c.longitude, t: pos.timestamp || Date.now(), acc: c.accuracy };
      chip("gps-chip", c.accuracy <= 30 ? "on" : "wait");
      if (c.accuracy > 50) return;
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
  const WX_EVERY = 30 * 60e3;
  const wx = { cur: null, src: "", at: 0, busy: false };
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
      const q = new URLSearchParams({ latitude: p.lat.toFixed(2), longitude: p.lon.toFixed(2), timezone: "auto", wind_speed_unit: "kmh", forecast_hours: "3",
        current: "temperature_2m,apparent_temperature,wind_speed_10m,wind_direction_10m,wind_gusts_10m", hourly: "precipitation_probability" });
      const r = await timed(`https://api.open-meteo.com/v1/forecast?${q}`, 8000, { cache: "no-store" });
      if (!r.ok) throw new Error(`weather ${r.status}`);
      const j = await r.json(), c = j.current || {};
      if (c.temperature_2m == null) throw new Error("no current weather");
      wx.cur = { temp: c.temperature_2m, feels: c.apparent_temperature ?? c.temperature_2m, wind: c.wind_speed_10m ?? 0, dir: c.wind_direction_10m ?? 0,
        gust: c.wind_gusts_10m ?? 0, pop: Math.max(0, ...((j.hourly && j.hourly.precipitation_probability) || []).filter(x => x != null)) };
      wx.src = "Live";
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
    $("wx-src").textContent = wx.src === "Live" ? `Live · ${hhmm(wx.at)}` : "Forecast from the sync";
  }
  const windOn = (W, course) => {
    const along = W.wind * Math.cos((W.dir - course) * Math.PI / 180);
    const side = Math.sin((W.dir - course) * Math.PI / 180) > 0 ? "right" : "left";
    return Math.abs(along) < 0.35 * W.wind ? `Crosswind from the ${side}` : along > 0 ? `Headwind ${windTxt(along)} ${windU()}` : `Tailwind ${windTxt(-along)} ${windU()}`;
  };

  // ── routes: GPX / TCX in, kept on this phone, one chosen for the ride ─────────────────────────────────────
  const NAV = { route: null, nav: null, st: null, detour: null, routing: false, lastReroute: 0, lastAt: 0, names: new Map(), offSaid: false, lastWrong: 0 };
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
    if (!row) { NAV.route = NAV.nav = NAV.st = NAV.detour = null; ls.set("fitness-ride-route", null); paintRouteBits(); return; }
    const route = C.analyze(C.unstore(row));
    const along = keepProgress && NAV.nav ? NAV.nav.state.along : S.running ? S.navAlong : 0;
    NAV.route = route; NAV.nav = C.navigator(route, { startAlong: along }); NAV.st = NAV.nav.status(); NAV.detour = null; NAV.names.clear();
    ls.set("fitness-ride-route", id);
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
      if (!confirm("Delete this route from the phone?")) return;
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

  // ── navigation: position on the route, turns, off course and detours ──────────────────────────────────────
  const KIND_WORD = { water: "Water", food: "Food", aid: "Aid station", summit: "Summit", danger: "Caution", toilet: "Restroom", sprint: "Sprint", valley: "Valley", finish: "Finish", generic: "" };
  const KIND_ICON = { water: "💧", food: "🍴", aid: "✚", summit: "▲", danger: "⚠", toilet: "WC", sprint: "⚡", valley: "▼", finish: "⚑", generic: "•" };
  const active = () => NAV.detour ? NAV.detour : NAV.route ? { route: NAV.route, nav: NAV.nav } : null;
  const turnText = t => {
    if (!t) return "";
    const nm = t.name || NAV.names.get(Math.round(t.along)) || "";
    return `${C.TURN_WORDS[t.kind] || "Turn"}${nm ? (/^(take|turn|onto|at)\b/i.test(nm) || t.src === "file" ? ` · ${nm}` : ` onto ${nm}`) : ""}`;
  };
  function onFix(fix) {
    NAV.lastAt = Date.now();
    if (!NAV.route) { paintMap(fix); return; }
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
      if (P.reroute && S.running && v > 1 && now - NAV.lastReroute > 30000 && navigator.onLine) reroute("rejoin");
    } else if (NAV.offSaid) { NAV.offSaid = false; say("Back on course."); beep(990, 120); }
    if (NAV.st.wrongWay && now - NAV.lastWrong > 30000) { NAV.lastWrong = now; say("Wrong way. Turn around."); buzz([500, 200, 500]); }
    if (S.running && !S.paused) {
      const A = active();
      for (const c of A ? A.nav.callouts(v) : []) {
        if (c.kind === "turn-soon") say(`In ${nearSay(c.dist)}, ${turnText(c.turn).replace(" · ", ", ")}.`, false);
        else if (c.kind === "turn-now") { say(`${C.TURN_WORDS[c.turn.kind] || "Turn"} now.`); beep(1100, 140, 2); buzz([150, 80, 150]); }
        else if (c.kind === "climb") say(`Climb in ${nearSay(c.dist)}: ${nearSay(c.climb.len).replace(/^a /, "")} at ${(c.climb.grade * 100).toFixed(0)} percent, ${eleTxt(c.climb.gain)} ${P.km ? "metres" : "feet"} up.`, false);
        else if (c.kind === "top") say("Top of the climb.", false);
        else if (c.kind === "poi") say(`${KIND_WORD[c.poi.kind] || "Waypoint"} in ${nearSay(c.dist)}${c.poi.name && c.poi.name !== KIND_WORD[c.poi.kind] ? `: ${c.poi.name}` : ""}.`, false);
        else if (c.kind === "arrive" && !NAV.detour) { say("You've reached the end of the route."); beep(660, 300, 2); }
      }
    }
    paintMap(fix);
  }
  /** A way back to the route (or to its start) from BRouter, followed turn by turn until you're on the route again. */
  async function reroute(kind) {
    const fix = live.lastFix;
    if (NAV.routing || !NAV.route || !fix) return;
    NAV.routing = true; NAV.lastReroute = Date.now();
    const target = kind === "start" ? { along: 0, ...C.pointAt(NAV.route, 0) } : NAV.nav.rejoin(fix);
    paintBanner();
    try {
      const r = await timed(C.brouterUrl(fix, target, P.profile), 15000);
      if (!r.ok) throw new Error(`router ${r.status}`);
      const d = C.fromBRouter(await r.json(), kind === "start" ? "To the start" : "Back to the route");
      NAV.detour = { route: d, nav: C.navigator(d), target, kind };
      NAV.detour.st = NAV.detour.nav.update(fix, live.heading, speedNow() ?? 0);
      const t = d.turns[0];
      say(kind === "start" ? `Directions to the start: ${nearSay(d.total)}.` : `Rerouting. ${nearSay(d.total)} back to the route.${t ? ` First, in ${nearSay(t.along)}, ${turnText(t).replace(" · ", ", ")}.` : ""}`);
      mapDetour();
    } catch {
      const back = NAV.nav.toRoute(fix);
      note.textContent = `No way back from the router (no signal?). The route is ${nearTxt(back.dist)} ${compass(back.brg)} of you.`;
      if (S.running) say(`The route is ${nearSay(back.dist)} to the ${({ N: "north", NE: "northeast", E: "east", SE: "southeast", S: "south", SW: "southwest", W: "west", NW: "northwest" })[compass(back.brg)]}.`, false);
    }
    NAV.routing = false;
    paintBanner(); renderAhead(true);
  }
  function paintBanner() {
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
      act.textContent = "Reroute"; act.hidden = !navigator.onLine; act.dataset.kind = "rejoin";
      b.hidden = false; return;
    }
    $("nb-arrow").style.transform = "";
    if (!NAV.detour && NAV.st.wrongWay) { b.classList.add("alert"); $("nb-arrow").textContent = "⮌"; $("nb-dist").textContent = ""; $("nb-what").textContent = "Wrong way — turn around"; b.hidden = false; return; }
    if (!NAV.detour && NAV.st.along < 50 && live.lastFix && hav(live.lastFix, NAV.route.pts[0]) > 250 && !NAV.route.loop) {
      $("nb-arrow").textContent = "⚑"; $("nb-dist").textContent = nearTxt(hav(live.lastFix, NAV.route.pts[0])); $("nb-what").textContent = " to the start of the route";
      act.textContent = "Directions"; act.hidden = !navigator.onLine; act.dataset.kind = "start"; b.hidden = false; return;
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
      const map = new lib.Map({ container: "map", style: STYLE_URL, center: c, zoom: r && !live.lastFix ? 11 : 14, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, maxPitch: 0, fadeDuration: 0, cooperativeGestures: false });
      MAP.map = map;
      const t = setTimeout(() => { if (!MAP.ready) { $("crumb").hidden = false; mapNote(navigator.onLine ? "The map is slow to load; showing the route meanwhile." : "No signal and no saved map here: showing the route and your track. Routes → a route's map saves itself when you load it online."); drawCrumb(); } }, 9000);
      map.on("error", () => { /* a missing tile offline is expected; the breadcrumb covers a missing style */ });
      map.on("load", () => {
        clearTimeout(t); MAP.ready = true; MAP.loading = false; $("crumb").hidden = true; mapNote("");
        for (const l of map.getStyle().layers || []) if (l["source-layer"] === "poi" || /^poi/.test(l.id)) map.setLayoutProperty(l.id, "visibility", "none");   // a bike screen, not a guidebook
        const add = (id, data) => map.addSource(id, { type: "geojson", data: data || { type: "FeatureCollection", features: [] } });
        add("route"); add("climbs"); add("done"); add("detour"); add("trail"); add("marks");
        const ink = css("--ink"), acc = css("--accent");
        map.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 5, 16, 12] } });
        map.addLayer({ id: "route-line", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": acc, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 7] } });
        map.addLayer({ id: "climb-line", type: "line", source: "climbs", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": ["step", ["get", "g"], "#fab219", 6, "#ec835a", 9, "#7a1f12"], "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 7] } });
        map.addLayer({ id: "done-line", type: "line", source: "done", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#8a8780", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 7] } });
        map.addLayer({ id: "trail-line", type: "line", source: "trail", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#1f5bb5", "line-width": 3, "line-opacity": 0.85 } });
        map.addLayer({ id: "detour-line", type: "line", source: "detour", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#1f5bb5", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 7], "line-dasharray": [1.5, 1] } });
        map.addLayer({ id: "marks-dot", type: "circle", source: "marks", paint: { "circle-radius": ["case", ["==", ["get", "t"], "turn"], 4, 6], "circle-color": ["case", ["==", ["get", "t"], "turn"], "#ffffff", ink], "circle-stroke-color": ink, "circle-stroke-width": 2 } });
        map.addLayer({ id: "marks-label", type: "symbol", source: "marks", filter: ["!=", ["get", "t"], "turn"], minzoom: 12, layout: { "text-field": ["get", "label"], "text-size": 13, "text-offset": [0, 1.1], "text-anchor": "top", "text-font": ["Noto Sans Bold"] }, paint: { "text-color": ink, "text-halo-color": "#ffffff", "text-halo-width": 2 } });
        const el = document.createElement("div"); el.className = "me"; el.setAttribute("aria-hidden", "true");
        MAP.marker = new lib.Marker({ element: el, rotationAlignment: "map", pitchAlignment: "map" }).setLngLat(c);
        if (live.lastFix) { MAP.marker.addTo(map); MAP.markerOn = true; }
        mapRoute(); mapDetour(); paintMap(live.lastFix, true);
      });
      map.on("dragstart", () => { MAP.follow = false; $("m-center").classList.add("primary"); });
      map.on("idle", () => nameTurns());
    } catch { giveUp("The map couldn't start here; showing the route and your track."); }
  }
  const line = pts => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts.map(p => [p.lon, p.lat]) } });
  const set = (id, data) => { const s = MAP.map && MAP.ready && MAP.map.getSource(id); if (s) /** @type {any} */ (s).setData(data); };
  function mapRoute() {
    drawCrumb();
    if (!MAP.ready) return;
    const r = NAV.route;
    set("route", r ? line(r.pts) : { type: "FeatureCollection", features: [] });
    set("climbs", { type: "FeatureCollection", features: r ? r.climbs.map(c => { const pts = []; for (let d = c.start; d <= c.end; d += 25) pts.push(C.pointAt(r, d)); return { ...line(pts), properties: { g: c.grade * 100 } }; }) : [] });
    set("marks", { type: "FeatureCollection", features: r ? [...r.turns.map(t => { const p = C.pointAt(r, t.along); return { type: "Feature", properties: { t: "turn" }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } }; }),
      ...r.pois.map(p => ({ type: "Feature", properties: { t: p.kind, label: `${KIND_ICON[p.kind] || "•"} ${p.name}`.slice(0, 40) }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } }))] : [] });
    if (r && !live.lastFix) MAP.map.fitBounds(r.bounds, { padding: 40, duration: 0 });
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
    if (!MAP.follow || (!force && now - MAP.lastCam < 900)) return;
    MAP.lastCam = now;
    const st = NAV.detour ? NAV.detour.st : NAV.st;
    const near = st && st.toTurn != null && st.toTurn < 250 ? 0.6 : 0;
    const zoom = (v > 11 ? 14.6 : v > 7 ? 15.2 : v > 3 ? 15.8 : 16.2) + near + MAP.zoom;
    const h = $("map").clientHeight || 400;
    MAP.map.easeTo({ center: [fix.lon, fix.lat], bearing: P.headingUp && live.heading != null && v > 1.5 ? live.heading : P.headingUp ? MAP.map.getBearing() : 0, zoom, duration: force ? 0 : 900, padding: { top: P.headingUp ? h * 0.35 : 0, bottom: 0, left: 0, right: 0 } });
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
    if (!fix) { g.fillStyle = css("--ink-2"); g.font = "15px sans-serif"; g.fillText("Waiting for GPS…", 16, 32); return; }
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
    if (NAV.detour) path(NAV.detour.route.pts, "#1f5bb5", 5, [8, 6]);
    path(samples.filter(s => s[1] != null).map(s => ({ lat: s[1], lon: s[2] })), "#1f5bb5", 3);
    if (live.lastFix) {
      g.save(); g.translate(cx, cy); g.rotate(((live.heading ?? 0) * Math.PI / 180) + rot);
      g.beginPath(); g.moveTo(0, -13); g.lineTo(9, 10); g.lineTo(0, 5); g.lineTo(-9, 10); g.closePath();
      g.fillStyle = css("--ink"); g.fill(); g.strokeStyle = css("--page"); g.lineWidth = 2; g.stroke(); g.restore();
    }
    // north arrow and scale
    g.save(); g.translate(W - 24, 24); g.rotate(rot); g.fillStyle = css("--ink"); g.font = "bold 12px sans-serif"; g.textAlign = "center"; g.fillText("N", 0, -8); g.beginPath(); g.moveTo(0, -4); g.lineTo(5, 8); g.lineTo(-5, 8); g.closePath(); g.fill(); g.restore();
    const bar = P.km ? [50, 100, 200, 500, 1000, 2000, 5000, 10000] : [30.48, 60.96, 152.4, 304.8, 402.3, 804.7, 1609.3, 3218.7, 8046.7];
    const len = bar.find(b => b / mpp > 60) || bar[bar.length - 1];
    g.fillStyle = css("--ink"); g.fillRect(16, H - 22, len / mpp, 3); g.font = "12px sans-serif"; g.textAlign = "left"; g.fillText(nearTxt(len), 16, H - 28);
  }
  $("m-center").addEventListener("click", () => { MAP.follow = true; MAP.zoom = 0; $("m-center").classList.remove("primary"); paintMap(live.lastFix, true); drawCrumb(); });
  const paintOrient = () => { $("m-orient").textContent = P.headingUp ? "▲ Up" : "N Up"; $("m-orient").setAttribute("aria-pressed", String(P.headingUp)); };
  $("m-orient").addEventListener("click", () => { P.headingUp = !P.headingUp; savePrefs(); paintOrient(); if (MAP.ready && !P.headingUp) MAP.map.easeTo({ bearing: 0, duration: 300 }); paintMap(live.lastFix, true); drawCrumb(); });
  $("m-zin").addEventListener("click", () => { MAP.zoom = Math.min(3, MAP.zoom + 1); if (MAP.ready && !MAP.follow) MAP.map.zoomIn(); paintMap(live.lastFix, true); drawCrumb(); });
  $("m-zout").addEventListener("click", () => { MAP.zoom = Math.max(-5, MAP.zoom - 1); if (MAP.ready && !MAP.follow) MAP.map.zoomOut(); paintMap(live.lastFix, true); drawCrumb(); });
  paintOrient();

  // ── what's ahead: profile, climb, turns, stops, wind ──────────────────────────────────────────────────────
  let aheadAt = 0;
  const gradeColor = g => g >= 9 ? "#7a1f12" : g >= 6 ? css("--serious") : g >= 3 ? css("--warn") : css("--z2");
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
    g.fillStyle = css("--ink-2"); g.font = "11px sans-serif"; g.textAlign = "left";
    g.fillText(`${eleTxt(hi)} ${unitE()}`, 2, 11); g.fillText(`${eleTxt(lo)} ${unitE()}`, 2, H - 3);
    g.textAlign = "right"; g.fillText(`${distTxt(to - from)} ${unitD()}`, W - 2, H - 3);
  }
  function renderAhead(force = false) {
    const r = NAV.route;
    if (!r || (!force && (curPage() !== "ahead" || Date.now() - aheadAt < 2000))) return;
    aheadAt = Date.now();
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
    const c = st.onClimb || st.climb, box = $("climb");
    box.hidden = !c;
    if (c) {
      const on = !!st.onClimb, done = on ? at - c.start : 0, n = r.climbs.indexOf(c) + 1;
      $("climb-k").textContent = on ? `Climbing · ${n} of ${r.climbs.length}` : `Next climb · ${n} of ${r.climbs.length}${c.cat ? ` · ${c.cat}` : ""}`;
      $("climb-main").textContent = on ? `${nearTxt(c.end - at)} to the top` : `in ${nearTxt(c.start - at)}`;
      const grade = st.grade != null && on ? ` · now ${st.grade.toFixed(0)}%` : "";
      $("climb-sub").textContent = on ? `${eleTxt(c.top - (C.eleAt(r, at) ?? c.top))} ${unitE()} up to go${grade} · avg ${(c.grade * 100).toFixed(1)}%` : `${nearTxt(c.len)} at ${(c.grade * 100).toFixed(1)}% (max ${(c.maxGrade * 100).toFixed(0)}%) · ${eleTxt(c.gain)} ${unitE()} up`;
      $("climb-bar").style.width = `${on ? Math.min(100, done / c.len * 100) : 0}%`;
      box.classList.toggle("on", on);
    }
    const A = active(), ast = NAV.detour ? NAV.detour.st || NAV.detour.nav.status() : st;
    const turns = A.route.turns.filter(t => t.along > ast.along).slice(0, 8);
    $("turn-list").innerHTML = turns.length ? turns.map(t => `<li><span class="ta" aria-hidden="true">${C.TURN_ARROWS[t.kind] || "↑"}</span><b class="num">${nearTxt(t.along - ast.along)}</b><span>${esc(turnText(t))}</span></li>`).join("") : `<li class="none">${A.route.turns.length ? "No more turns: straight to the finish." : "No turns in this file."}</li>`;
    const pois = r.pois.filter(q => q.along > at - 20).slice(0, 8);
    $("poi-wrap").hidden = !r.pois.length;
    $("poi-list").innerHTML = pois.map(q => `<li><span class="ta" aria-hidden="true">${KIND_ICON[q.kind] || "•"}</span><b class="num">${nearTxt(Math.max(0, q.along - at))}</b><span>${esc(q.name)}${q.desc && q.desc !== q.name ? ` · ${esc(q.desc)}` : ""}</span></li>`).join("") || `<li class="none">None left.</li>`;
    $("wind-ahead").textContent = windAhead(r, at);
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
    const fix = live.lastFix && now - live.lastFix.t < 5000 ? live.lastFix : null;
    let ele = null;
    if (NAV.route && NAV.route.hasEle && NAV.st && !NAV.st.offCourse && fix) ele = C.eleAt(NAV.route, NAV.st.along);
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

  // ── tailoring the workout as you ride ─────────────────────────────────────────────────────────────────────
  const tgt = s => { const k = C.isWork(s) ? S.intensity : 1; return s.lo > 0 ? [bpm(s.lo * k), bpm(s.hi * k)] : [0, bpm(s.hi)]; };
  const pwTgt = s => { if (!(P.ftp > 0)) return null; const k = C.isWork(s) ? S.intensity : 1; return s.lo > 0 ? [Math.round(P.ftp * C.ftpPct(s.lo * k) / 100), Math.round(P.ftp * C.ftpPct(s.hi * k) / 100)] : [0, Math.round(P.ftp * C.ftpPct(s.hi) / 100)]; };
  const tssPerMin = s => { const mid = s.lo > 0 ? (s.lo + s.hi) / 2 * (C.isWork(s) ? S.intensity : 1) : s.hi * 0.85, f = C.ftpPct(mid) / 100; return f * f * 100 / 60; };
  const tssNow = () => S.trimp / trimpHour() * 100;
  const projected = () => { const st = steps(); if (!st.length) return null; const cur = st[S.step]; let t = tssNow(); if (cur) t += Math.max(0, cur.min * 60 - (S.elapsed - S.stepStart)) / 60 * tssPerMin(cur); for (let i = S.step + 1; i < st.length; i++) t += st[i].min * tssPerMin(st[i]); return t; };
  const doneIn = () => Math.max(0, (S.elapsed - S.stepStart) / 60);
  const replan = (next, why) => { S.plan = next; if (S.step >= S.plan.length) S.step = S.plan.length; save(); render(); if (why) { note.hidden = false; note.textContent = why; } };
  let suggestion = null;
  const suggest = (text, yes, speak = true) => {
    if (suggestion && suggestion.text === text) return;
    suggestion = { text, yes };
    $("suggest-text").textContent = text; $("suggest").hidden = false;
    if (speak) say(text, false);
    beep(700, 120, 2);
  };
  const unsuggest = () => { suggestion = null; $("suggest").hidden = true; };
  $("suggest-yes").addEventListener("click", () => { const s = suggestion; unsuggest(); if (s) s.yes(); });
  $("suggest-no").addEventListener("click", unsuggest);
  const setIntensity = k => { S.intensity = Math.max(0.8, Math.min(1.15, Math.round(k * 100) / 100)); save(); render(); say(`Targets at ${Math.round(S.intensity * 100)} percent.`, false); };
  $("w-easier").addEventListener("click", () => setIntensity(S.intensity - 0.05));
  $("w-harder").addEventListener("click", () => setIntensity(S.intensity + 0.05));
  $("w-more").addEventListener("click", () => { if (steps()[S.step]) replan(C.extend(steps(), S.step, 1, doneIn())); });
  const easyHome = () => {   // the rest of the session as easy endurance, same time
    const st = steps(), rest = Math.max(0, st[S.step] ? st[S.step].min - doneIn() : 0) + st.slice(S.step + 1).reduce((a, s) => a + s.min, 0);
    replan([...st.slice(0, S.step), { name: "Easy (intervals skipped)", min: Math.max(1, doneIn() + rest), zone: "z2", lo: 0, hi: 89, cue: "Endurance only today" }], "Intervals skipped: the rest is easy endurance.");
  };
  const kindSel = $("tl-kind");
  kindSel.innerHTML = Object.entries(C.QUICK).map(([k, q]) => `<option value="${k}">${esc(/** @type {any} */ (q).label)}</option>`).join("");
  $("w-tailor").addEventListener("click", () => {
    const st = steps(), left = st.length ? Math.round(Math.max(0, (st[S.step] ? st[S.step].min - doneIn() : 0)) + st.slice(S.step + 1).reduce((a, s) => a + s.min, 0)) : 60;
    /** @type {HTMLInputElement} */ ($("tl-left")).value = String(Math.max(5, left));
    const pr = projected(), goal = planned && planned.load ? Math.round(+planned.load) : null;
    $("tl-load").textContent = st.length ? `Load so far ${Math.round(tssNow())}${goal ? ` of ${goal} planned` : ""} · on pace for ${Math.round(pr ?? tssNow())} at the end of the session.` : `No session: pick a quick workout below, or ride free. Load so far ${Math.round(tssNow())}.`;
    $("tl-hit").hidden = !(goal && pr != null && pr < goal * 0.95);
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
    else if (act === "load") addLoad();
    $("tailor").close();
  });
  /** Endurance added before the cool-down to reach the planned load. */
  function addLoad() {
    const goal = planned && planned.load ? +planned.load : 0, pr = projected() ?? tssNow();
    if (!goal || pr >= goal) return;
    const z2 = { name: "Endurance (to hit the load)", min: 0, zone: "z2", lo: 81, hi: 89, cue: "Steady, conversational" }, m = Math.min(90, Math.ceil((goal - pr) / tssPerMin(z2) / 5) * 5);
    const st = steps(), cool = st.length - 1 > S.step && /cool/i.test(st[st.length - 1].name) ? st.length - 1 : st.length;
    replan([...st.slice(0, cool), { ...z2, min: m }, ...st.slice(cool)], `${m} min of endurance added to reach ${Math.round(goal)} TSS.`);
  }

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
    endRep(st[S.step]);
    S.step += 1; S.stepStart = S.elapsed; S.held = 0;
    if (P.stepLap && S.running) lap(1);
    if (S.step >= st.length) { say("Workout complete. Ride easy or finish up."); beep(660, 300, 2); offerLoad(); return; }
    const s = st[S.step], [lo, hi] = tgt(s), pt = pwTgt(s);
    const target = s.cue && s.cue.includes("feel") ? (pt && live.powerAt ? `${pt[0]} to ${pt[1]} watts.` : "By feel.") : `Heart rate ${lo > 0 ? `${lo} to ${hi}` : `under ${hi}`}.`;
    say(`${s.name}. ${Math.round(s.min) >= 1 ? `${Math.round(s.min)} minute${Math.round(s.min) === 1 ? "" : "s"}` : `${Math.round(s.min * 60)} seconds`}. ${target}`);
    if (!manual) { beep(s.zone === "z1" || s.zone === "z2" ? 660 : 990, 220, 2); buzz([200, 100, 200]); }
  }
  /** At the end of a work step: did HR reach the target, or run well over it? Two such reps in a row → a suggestion. */
  function endRep(s) {
    if (!s || !C.isWork(s) || s.min < 3 || rep.n < 30) { rep = { under: 0, high: 0, n: 0 }; return; }
    const under = rep.under / rep.n > 0.6, high = rep.high / rep.n > 0.5;
    S.missed = under ? S.missed + 1 : 0; S.hot = high ? S.hot + 1 : 0;
    rep = { under: 0, high: 0, n: 0 };
    const set = C.setOf(steps(), S.step), more = set && set.last > S.step;
    if (S.missed >= 2 && more) { S.missed = 0; suggest("Heart rate isn't reaching the target on these reps: fatigue shows. Cut the rest of the set?", () => replan(C.cutSet(steps(), S.step), "Rest of the set cut.")); }
    else if (S.hot >= 2 && more) { S.hot = 0; suggest("You're running well over the target. Make the rest 5% easier?", () => setIntensity(S.intensity - 0.05)); }
  }
  function offerLoad() {
    const goal = planned && planned.load ? +planned.load : 0;
    if (!goal || S.loadOffered || tssNow() >= goal * 0.9) return;
    S.loadOffered = true;
    suggest(`Load ${Math.round(tssNow())} of ${Math.round(goal)} planned. Add endurance to hit it?`, () => { S.step = steps().length; addLoad(); });
  }
  // ── commute check: same route every time, so HR at a given speed is a daily fitness reading ─────────────
  // After 8 minutes, the last 5 minutes' average HR is compared with what this leg usually costs at that speed
  // (a line fitted to your past commutes). 6+ bpm high: fatigue, illness or heat, so skip the intervals.
  const hrSpeed = [];
  let check = null, checkSaid = "";
  function commuteCheck() {
    const model = planned && planned.check && cfg.commute && cfg.commute[planned.leg];
    if (!model || S.elapsed < 480) return null;
    const recent = hrSpeed.filter(x => x.t > S.elapsed - 300);
    if (recent.length < 120) return null;
    const hr = recent.reduce((a, x) => a + x.hr, 0) / recent.length, kmh = recent.reduce((a, x) => a + x.kmh, 0) / recent.length;
    let usual = null;
    if (Array.isArray(model.model)) usual = model.model[0] + model.model[1] * kmh;
    else if (model.hr && Math.abs(kmh - model.speed) < 1.5) usual = model.hr;
    if (usual == null) return null;
    const diff = hr - usual;
    return { diff, kmh, verdict: diff >= 6 ? "hot" : diff <= -4 ? "fresh" : "normal" };
  }

  function tick() {
    const now = Date.now(), dt = last ? Math.min(5, (now - last) / 1000) : 1;
    last = now;
    if (S.running && !S.paused) {
      if (now - wx.at > WX_EVERY) refreshWx();   // fresh conditions every half hour on a long ride
      if (live.lastFix && now - (NAV.lastAt || 0) > 1500) onFix(live.lastFix);   // a quiet GPS (standing still, under trees): keep judging the last fix
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
        if (live.hr && now - live.hrAt < 5000 && spd != null && spd > 3) {
          hrSpeed.push({ t: S.elapsed, hr: live.hr, kmh: spd * 3.6 });
          if (hrSpeed.length > 900) hrSpeed.shift();
        }
        record(now);
        check = commuteCheck();
        if (check && check.verdict !== "normal" && checkSaid !== check.verdict) {
          checkSaid = check.verdict;
          if (check.verdict === "hot") { buzz([300, 120, 300]); suggest("Heart rate is running high for this speed. Keep it easy today: skip the intervals?", easyHome); }
          else say("You're running fresh today: lower heart rate than usual for this speed.");
        }
        const st = steps();
        if (st.length && S.step < st.length) {
          const s = st[S.step], inStep = S.elapsed - S.stepStart, left = s.min * 60 - inStep, hrLive = live.hr && now - live.hrAt < 5000 ? live.hr : null;
          if (C.isWork(s) && hrLive && inStep > s.min * 60 * 0.5) { const [lo, hi] = tgt(s); rep.n++; if (hrLive < lo - 3) rep.under++; if (hrLive > hi + 5) rep.high++; }
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
    render();
  }

  // ── drawing ─────────────────────────────────────────────────────────────────────────────────────────────
  function render() {
    const now = Date.now();
    const hrLive = live.hr && now - live.hrAt < 5000 ? live.hr : null;
    $("hr").textContent = hrLive ?? "—";
    const zm = $("zmark");
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
      $("step-target").innerHTML = `${lo > 0 ? `Target <b>${lo}–${hi}</b> bpm` : `Target <b>under ${hi}</b> bpm`}${pt ? ` · <b>${pt[0] ? `${pt[0]}–${pt[1]}` : `&lt;${pt[1]}`}</b> W` : ""}`;
      $("step-bar").style.width = `${Math.min(100, elapsedInStep / (s.min * 60) * 100)}%`;
      const ns = NAV.st;
      $("step-cue").textContent = S.held && ns && ns.toClimb != null ? `Holding for the climb: the effort starts at its foot, ${nearTxt(ns.toClimb)} ahead.`
        : check ? `HR vs usual at ${speedTxt(check.kmh / 3.6)} ${unitS()}: ${check.diff >= 0 ? "+" : "−"}${Math.abs(Math.round(check.diff))} bpm · ${check.verdict === "hot" ? "running hot: keep it easy, skip the intervals" : check.verdict === "fresh" ? "fresh: a good day for the work" : "normal"}`
          : nb(s.cue);
      $("step-cue").classList.toggle("hot", !!check && check.verdict === "hot");
      const n = list[S.step + 1];
      $("step-next").textContent = n ? `Next: ${n.name} · ${n.min >= 1 ? `${Math.round(n.min)} min` : `${Math.round(n.min * 60)} s`}` : "Last step";
      const byFeel = s.cue && s.cue.includes("by feel");
      const usePower = pt && p10 != null && C.isWork(s);
      if (S.autoPaused) { st.classList.add("feel"); st.textContent = "Auto-paused"; }
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
      $("step-cue").textContent = planned ? nb(planned.session) : "";
      $("step-next").textContent = "";
      $("step-bar").style.width = "0";
    } else {
      $("step-name").textContent = S.step >= list.length && list.length ? "Workout done" : planned ? planned.title : "Free ride";
      $("step-time").textContent = clock(S.elapsed);
      $("step-target").textContent = list.length ? "Ride easy home" : NAV.route ? `${NAV.route.name}: follow the route` : "No steps — just ride";
      $("step-cue").textContent = ""; $("step-next").textContent = ""; $("step-bar").style.width = "0";
    }
    $("w-int").textContent = `${Math.round(S.intensity * 100)}%`;
    for (const id of ["w-easier", "w-harder", "w-more"]) /** @type {HTMLButtonElement} */ ($(id)).disabled = !list.length || S.step >= list.length;

    $("t-time").textContent = clock(S.elapsed);
    $("t-dist").innerHTML = `${distTxt(S.dist)}<small>${unitD()}</small>`;
    const spd = speedNow(now);
    $("t-speed").innerHTML = spd == null ? "—" : `${speedTxt(spd)}<small>${unitS()}</small>`;
    const showPower = now - live.powerAt < 4000;
    $("t-cad").innerHTML = showPower ? `${live.power}<small>W</small>` : live.cad != null && now - live.cadAt < 4000 ? `${live.cad}<small>rpm</small>` : "—";
    $("t-avg").textContent = S.hrSecs ? Math.round(S.hrSum / S.hrSecs) : "—";
    const tss = tssNow();
    $("t-load").innerHTML = `${Math.round(tss)}${planned && planned.load ? `<small>/${Math.round(+planned.load)}</small>` : ""}`;
    paintWx(now);
    $("fuel").hidden = !S.fuelDue;
    if (S.fuelDue) $("fuel-text").textContent = fuelText();

    const page = curPage();
    if (page === "data") paintData(now, spd);
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
    note.hidden = S.running && !S.paused;   // setup help is for before the ride, not on the bars
    document.body.classList.toggle("riding", S.running && !S.paused);
  }
  function paintData(now, spd) {
    $("d-time").textContent = clock(S.elapsed); $("d-moving").textContent = clock(S.moving);
    $("d-dist").innerHTML = `${distTxt(S.dist)}<small>${unitD()}</small>`;
    $("d-speed").innerHTML = spd == null ? "—" : `${speedTxt(spd)}<small>${unitS()}</small>`;
    $("d-avgspd").innerHTML = S.moving > 30 ? `${speedTxt(S.dist / S.moving)}<small>${unitS()}</small>` : "—";
    $("d-maxspd").innerHTML = S.maxSpeed ? `${speedTxt(S.maxSpeed)}<small>${unitS()}</small>` : "—";
    $("d-asc").innerHTML = `${eleTxt(S.ascent)}<small>${unitE()}</small>`;
    const gr = NAV.route && NAV.st && !NAV.st.offCourse ? NAV.st.grade : null;
    $("d-grade").textContent = gr == null ? "—" : `${gr.toFixed(1)}%`;
    $("d-hr").textContent = live.hr && now - live.hrAt < 5000 ? String(live.hr) : "—";
    $("d-maxhr").textContent = S.hrMax ? String(S.hrMax) : "—";
    const p10 = pw10();
    $("d-pw").innerHTML = p10 != null ? `${p10}<small>W 10s</small>` : S.pwSecs ? `${Math.round(S.pwSum / S.pwSecs)}<small>W avg</small>` : "—";
    $("d-cad").innerHTML = live.cad != null && now - live.cadAt < 4000 ? `${live.cad}<small>rpm</small>` : "—";
    $("d-clock").textContent = hhmm(now);
    const p = live.lastFix || (NAV.route && NAV.route.pts[0]);
    if (p) { const sun = C.sunTimes(new Date(), p.lat, p.lon), left = (sun.sunset - now) / 60000; $("d-sunset").textContent = left > 0 ? `${hhmm(sun.sunset)} · ${left >= 60 ? `${Math.floor(left / 60)}h ${Math.round(left % 60)}m` : `${Math.round(left)} min`}` : hhmm(sun.sunset); }
    const e = NAV.route && NAV.st && !NAV.st.offCourse && NAV.route.hasEle ? NAV.st.ele : live.alt;
    $("d-ele").innerHTML = e == null ? "—" : `${eleTxt(e)}<small>${unitE()}</small>`;
    $("d-batt").textContent = live.battery ? `${Math.round(live.battery.level * 100)}%${live.battery.charging ? " ⚡" : ""}` : "—";
  }

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
      Object.assign(S, fresh(), { running: true, plan, quick, intensity, rideId: uid(), wallStart: now, lapStart: now });
      samples = []; hrSpeed.length = 0; check = null; checkSaid = ""; rep = { under: 0, high: 0, n: 0 };
      const st = steps();
      if (st.length) { const s = st[0]; say(`${planned ? planned.title : "Workout"}. First, ${s.name}, ${Math.round(s.min)} minutes.`); }
      else if (NAV.route) say(`${NAV.route.name}. ${nearSay(NAV.route.total)}${NAV.route.hasEle ? `, ${eleTxt(NAV.route.gain)} ${P.km ? "metres" : "feet"} of climbing` : ""}.`);
      if (NAV.nav) NAV.nav.seek(0);
      beep(880, 200, 2);
      wake();
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
  $("fuel-ok").addEventListener("click", () => { S.fuelDue = false; render(); });
  $("btn-end").addEventListener("click", async () => {
    if (!confirm("End the ride?")) return;
    const now = Date.now();
    lap(0, now);
    S.running = false; S.paused = false; S.autoPaused = false;
    if (lock) lock.release().catch(() => {});
    await flush(true);
    const ride = await saveRide(now);
    ls.set("fitness-ride-last", JSON.stringify({ ...S, endedAt: now, samples: undefined }));
    ls.set("fitness-ride-state", null);
    S.step = 0; S.stepStart = 0;
    showRide(ride, true);
    render();
  });
  daySel.addEventListener("change", pickDay);

  // ── saved rides: summary, laps and exports ───────────────────────────────────────────────────────────────
  const slug = s => String(s || "ride").replace(/[^\w\d-]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "ride";
  async function saveRide(now) {
    const tss = Math.round(tssNow());
    const name = `${planned ? planned.title : NAV.route ? NAV.route.name : "Ride"} · ${new Date(S.wallStart || now).toLocaleDateString([], { month: "short", day: "numeric" })}`;
    const meta = { id: S.rideId || uid(), name, start: S.wallStart || now - S.elapsed * 1000, end: now, elapsed: S.elapsed, moving: S.moving, dist: S.dist, ascent: S.ascent, maxSpeed: S.maxSpeed,
      avgHr: S.hrSecs ? S.hrSum / S.hrSecs : null, maxHr: S.hrMax || null, avgCad: S.cadSecs ? S.cadSum / S.cadSecs : null, avgPower: S.pwSecs ? S.pwSum / S.pwSecs : null, tss, planned: planned && planned.load ? Math.round(+planned.load) : null,
      zones: S.zones, laps: S.laps, pauses: S.pauses, route: NAV.route ? NAV.route.name : null, check, indoor: !samples.some(s => s[1] != null) };
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
    $("sum-body").replaceChildren(...[grid, bar,
      node("p", "note mt-2", zones.map((z, i) => `Z${i + 1} ${clock(z)}`).join(" · ")),
      laps.length > 1 ? node("p", "note", `${laps.length} laps · ${laps.slice(0, 12).map((l, i) => `${i + 1}: ${clock(n(l.time))}`).join(" · ")}${laps.length > 12 ? " …" : ""}`) : null,
      v ? node("p", "note", `Commute check: HR ${n(v.diff) >= 0 ? "+" : "−"}${Math.abs(Math.round(n(v.diff)))} bpm against your usual for the speed (${v.verdict}).`) : null,
      node("p", "note", `${justNow ? "Saved on this phone. " : ""}FIT goes straight into Garmin Connect (Import data), Strava (Upload) or TrainingPeaks. The watch's own file is still the official record, so upload this one only for rides the watch didn't record.`)].filter(Boolean));
    $("sum-exports").hidden = false;
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
      if (!confirm("Delete this ride from the phone?")) return;
      await DB.del("rides", r.id).catch(() => {}); await DB.del("tracks", r.id).catch(() => {});
      $("summary").close(); paintRides(); return;
    }
    const full = { ...r, samples: await rideSamples(r) }, base = slug(`${new Date(r.start).toISOString().slice(0, 10)}-${r.name.split(" · ")[0]}`);
    const fit = () => new File([C.toFIT(full)], `${base}.fit`, { type: "application/vnd.ant.fit" });
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

  // ── settings ────────────────────────────────────────────────────────────────────────────────────────────
  const dlg = $("settings");
  const inp = id => /** @type {HTMLInputElement} */ ($(id));
  $("btn-settings").addEventListener("click", () => {
    inp("s-lthr").value = P.lthr; inp("s-max").value = P.max; inp("s-rest").value = P.rest; inp("s-wheel").value = P.wheel; inp("s-fuel").value = P.fuel;
    inp("s-ftp").value = P.ftp || 0; inp("s-autolap").value = P.autoLap || 0;
    inp("s-voice").checked = P.voice; inp("s-autopause").checked = P.autoPause; inp("s-steplap").checked = P.stepLap; inp("s-climbs").checked = P.climbs; inp("s-reroute").checked = P.reroute;
    /** @type {HTMLSelectElement} */ ($("s-profile")).value = P.profile;
    paintUnits();
    dlg.showModal();
  });
  dlg.addEventListener("close", () => {
    if (dlg.returnValue !== "save") return;
    const num = (id, d) => { const v = parseFloat(inp(id).value); return Number.isFinite(v) ? v : d; };
    Object.assign(P, { lthr: num("s-lthr", P.lthr), max: num("s-max", P.max), rest: num("s-rest", P.rest), wheel: num("s-wheel", P.wheel), fuel: num("s-fuel", P.fuel),
      ftp: num("s-ftp", P.ftp), autoLap: num("s-autolap", P.autoLap), voice: inp("s-voice").checked, autoPause: inp("s-autopause").checked, stepLap: inp("s-steplap").checked,
      climbs: inp("s-climbs").checked, reroute: inp("s-reroute").checked, profile: /** @type {HTMLSelectElement} */ ($("s-profile")).value });
    savePrefs();
    render();
  });

  // imperial / metric: the segmented pair in settings, or a tap on the distance or speed reading mid-ride
  const unitBtns = [...document.querySelectorAll("[data-units]")];
  const paintUnits = () => unitBtns.forEach(b => b.setAttribute("aria-pressed", String((/** @type {HTMLElement} */ (b).dataset.units === "km") === P.km)));
  const setUnits = km => { P.km = km; ls.set("fitness-units", km ? "km" : "mi"); paintUnits(); paintRouteBits(); paintLaps(); render(); };
  unitBtns.forEach(b => b.addEventListener("click", () => setUnits(/** @type {HTMLElement} */ (b).dataset.units === "km")));
  document.querySelectorAll(".unit-flip").forEach(t => t.addEventListener("click", () => { setUnits(!P.km); beep(990, 60); }));
  paintUnits();

  // light / dark: light (paper) unless chosen otherwise; shared with the dashboard. Applies the moment it's tapped.
  const themeBtns = [...document.querySelectorAll("[data-theme-pick]")];
  const paintTheme = () => themeBtns.forEach(b => b.setAttribute("aria-pressed", String(/** @type {HTMLElement} */ (b).dataset.themePick === (document.documentElement.dataset.theme || "light"))));
  themeBtns.forEach(b => b.addEventListener("click", () => { document.documentElement.dataset.theme = /** @type {HTMLElement} */ (b).dataset.themePick; ls.set("fitness-theme", /** @type {HTMLElement} */ (b).dataset.themePick); paintTheme(); drawCrumb(); renderAhead(true); }));
  paintTheme();

  // installed-app offline: the same service worker as the dashboard (scope: this folder)
  if ("serviceWorker" in navigator && window.isSecureContext && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});

  // ── start-up: the session, the route, and a ride restored after a reload ──────────────────────────────────
  planned = dayOf(daySel.value);
  if (!S.running || !S.plan.length) { S.plan = planned ? planned.steps.map(s => ({ ...s })) : S.plan; if (!S.running) S.intensity = 1; }
  if (S.running) { note.textContent = "Ride restored after a reload — tap Resume."; startGps(); await restoreSamples(); }
  const lastRoute = ls.get("fitness-ride-route");
  if (lastRoute) await useRoute(lastRoute, false).catch(() => {});
  setInterval(tick, 1000);
  show(page);
  paintLaps();
  /** @type {any} */ (window).__ride = { S, NAV, P, MAP, onFix: f => { live.lastFix = f; onFix(f); }, importFiles, useRoute, live, samples: () => samples, DB };
})();
