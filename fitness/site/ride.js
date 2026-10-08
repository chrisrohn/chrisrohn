"use strict";
// Ride mode: live heart rate, cadence and power from Bluetooth sensors (Web Bluetooth), speed and distance from the
// phone's GPS, and the day's planned session as timed steps with heart-rate targets, cues and fueling reminders.
// The watch keeps recording the official file; nothing here is uploaded anywhere.
(async () => {
  const $ = id => document.getElementById(id);
  // keep figures with their units so a cue never breaks "3 / min" on a phone-width line
  const nb = t => String(t ?? "").replace(/ × /g, "\u00a0×\u00a0").replace(/(\d) (?=(?:min|h|s|mi|km|ft|bpm|W|g|rpm|TSS|%)(?!\w))/g, "$1\u00a0")
    .replace(/(RPE|Z\d|\+|−|~) (?=[\d(])/g, "$1\u00a0").replace(/(\d)–(?=\d)/g, "$1\u2060–\u2060");   // word joiners keep 88–93 whole
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

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
    history.replaceState(null, "", location.pathname);
  }
  if (!cfg) { try { const t = $("ride-data").textContent.trim(); if (t.startsWith("{")) cfg = JSON.parse(t); } catch { cfg = null; } }
  if (!cfg) { try { cfg = JSON.parse(ls.get("fitness-ride-config") || "null"); } catch { cfg = null; } }
  cfg = cfg || { lthr: 160, max_hr: 185, rest_hr: 55, sex: "male", days: [], wheel_m: 2.29, fuel_every_min: 20 };
  const prefs = (() => { try { return JSON.parse(ls.get("fitness-ride-prefs") || "{}"); } catch { return {}; } })();
  const P = {
    lthr: prefs.lthr || cfg.lthr, max: prefs.max || cfg.max_hr, rest: prefs.rest || cfg.rest_hr, wheel: prefs.wheel || cfg.wheel_m || 2.29,
    fuel: prefs.fuel ?? cfg.fuel_every_min ?? 20, voice: prefs.voice ?? true, km: (ls.get("fitness-units") || (cfg.units === "metric" ? "km" : "mi")) === "km",
  };

  // ── formatting ──────────────────────────────────────────────────────────────────────────────────────────
  const clock = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`; };
  const distTxt = m => (P.km ? m / 1000 : m / 1609.344).toFixed(1);
  const speedTxt = mps => mps == null ? "—" : (P.km ? mps * 3.6 : mps * 2.23694).toFixed(1);
  const unitD = () => (P.km ? "km" : "mi"), unitS = () => (P.km ? "km/h" : "mph");
  const bpm = pct => Math.round(P.lthr * pct / 100);
  const zoneOf = hr => { const p = hr / P.lthr * 100; return p < 81 ? 1 : p < 90 ? 2 : p < 94 ? 3 : p < 100 ? 4 : 5; };
  const ZNAME = ["", "Z1 recovery", "Z2 endurance", "Z3 tempo", "Z4 threshold", "Z5 VO2"];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const today = new Date(), iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  // ── the day's session ───────────────────────────────────────────────────────────────────────────────────
  const daySel = $("day");
  const days = (cfg.days || []).filter(d => d.steps && d.steps.length);
  daySel.innerHTML = days.map((d, i) => {
    const dt = new Date(d.date + "T12:00:00");
    const label = d.date === iso(today) ? "Today" : `${DOW[dt.getDay()]} ${MON[dt.getMonth()]} ${dt.getDate()}`;
    return `<option value="${i}">${label} · ${esc(d.title)}${d.minutes ? ` · ${Math.round(+d.minutes)} min` : ""}</option>`;
  }).join("") + `<option value="free">Free ride (no steps)</option>`;
  const todayIdx = days.findIndex(d => d.date === iso(today));
  daySel.value = todayIdx >= 0 ? String(todayIdx) : days.length && days[0].date > iso(today) ? "0" : "free";
  let steps = [], planned = null;
  const pickDay = () => {
    const d = daySel.value === "free" ? null : days[+daySel.value];
    planned = d;
    steps = d ? d.steps : [];
    S.step = 0; S.stepStart = S.elapsed;
    render();
  };

  // ── ride state (saved every few seconds so a reload mid-ride picks up where it was) ───────────────────────
  const S = { running: false, paused: false, elapsed: 0, moving: 0, dist: 0, step: 0, stepStart: 0, hrSum: 0, hrSecs: 0, hrMax: 0, zones: [0, 0, 0, 0, 0],
    trimp: 0, cadSum: 0, cadSecs: 0, fuelAt: 0, fuelDue: false, ended: false };
  const live = { hr: null, hrAt: 0, cad: null, cadAt: 0, power: null, powerAt: 0, wheelSpeed: null, wheelAt: 0, gpsSpeed: null, gpsAt: 0, lastFix: null, still: 0 };
  try {
    const saved = JSON.parse(ls.get("fitness-ride-state") || "null");
    if (saved && saved.running && Date.now() - saved.savedAt < 12 * 3600e3) { Object.assign(S, saved, { paused: true }); daySel.value = saved.day ?? daySel.value; }
  } catch { /* fresh ride */ }
  const save = () => ls.set("fitness-ride-state", JSON.stringify({ ...S, day: daySel.value, savedAt: Date.now() }));

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
  const say = text => { if (P.voice && "speechSynthesis" in window) { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } };
  const buzz = pattern => { if (navigator.vibrate) navigator.vibrate(pattern); };
  let lock = null;
  const wake = async () => { try { if ("wakeLock" in navigator && document.visibilityState === "visible") lock = await navigator.wakeLock.request("screen"); } catch { lock = null; } };
  document.addEventListener("visibilitychange", () => { if (S.running && !S.paused && document.visibilityState === "visible") wake(); });

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
          if (S.running && !S.paused) S.dist += dr * P.wheel;
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
  const onPower = dv => { live.power = dv.getInt16(2, true); live.powerAt = Date.now(); };

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
  async function connect(kind) {
    if (!navigator.bluetooth) { noBluetooth(); return; }
    const id = kind === "hr" ? "btn-hr" : "btn-csc";
    const services = kind === "hr" ? ["heart_rate"] : ["cycling_speed_and_cadence", "cycling_power"];
    try {
      chip(id, "wait");
      const device = await navigator.bluetooth.requestDevice({ filters: services.map(s => ({ services: [s] })), optionalServices: services });
      device.addEventListener("gattserverdisconnected", () => retry(device, kind, id, 0));
      chip(id, (await subscribe(device, kind)) ? "on" : "off");
    } catch (e) {
      chip(id, "off");
      if (e && e.name !== "NotFoundError") note.textContent = `Bluetooth: ${e.message || e}`;
    }
  }
  function retry(device, kind, id, n) {
    chip(id, "wait");
    if (n > 6) { chip(id, "off"); return; }
    setTimeout(async () => { try { chip(id, (await subscribe(device, kind)) ? "on" : "off"); } catch { retry(device, kind, id, n + 1); } }, Math.min(16000, 1000 * 2 ** n));
  }
  $("btn-hr").addEventListener("click", () => connect("hr"));
  $("btn-csc").addEventListener("click", () => connect("csc"));
  if (!navigator.bluetooth) noBluetooth();

  // ── GPS ─────────────────────────────────────────────────────────────────────────────────────────────────
  const R = 6371e3, rad = x => x * Math.PI / 180;
  const hav = (a, b) => { const dl = rad(b.lat - a.lat), dn = rad(b.lon - a.lon); const h = Math.sin(dl / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
  let watch = null;
  const startGps = () => {
    if (!("geolocation" in navigator) || watch != null) return;
    chip("gps-chip", "wait");
    watch = navigator.geolocation.watchPosition(pos => {
      const c = pos.coords, fix = { lat: c.latitude, lon: c.longitude, t: pos.timestamp, acc: c.accuracy };
      chip("gps-chip", c.accuracy <= 30 ? "on" : "wait");
      if (c.accuracy > 50) return;
      const prev = live.lastFix;
      live.lastFix = fix;
      if (!prev) return;
      const d = hav(prev, fix), dt = (fix.t - prev.t) / 1000;
      live.gpsSpeed = c.speed != null && c.speed >= 0 ? c.speed : dt > 0 ? d / dt : null;
      live.gpsAt = Date.now();
      const wheelLive = Date.now() - live.wheelAt < 5000;   // a wheel sensor wins under tree cover
      if (S.running && !S.paused && !wheelLive && d < 200 && (live.gpsSpeed ?? 0) > 0.8) S.dist += d;
    }, () => chip("gps-chip", "off"), { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  };

  // ── the loop ────────────────────────────────────────────────────────────────────────────────────────────
  const k = cfg.sex === "female" ? [0.86, 1.67] : [0.64, 1.92];
  const trimpRate = hr => { const r = Math.max(0, Math.min(1, (hr - P.rest) / Math.max(1, P.max - P.rest))); return r * k[0] * Math.exp(k[1] * r); };
  const trimpHour = () => 60 * trimpRate(P.lthr);
  let last = 0, lastBeep = 0;
  const fuelText = () => {
    const long = (planned && planned.minutes >= 150) || S.elapsed > 2.5 * 3600;
    return long ? " ~30 g carbs (a gel or half a bar) and a few big sips" : " ~20 g carbs and a few sips";
  };
  function advance(manual) {
    if (!steps.length) return;
    S.step += 1; S.stepStart = S.elapsed;
    if (S.step >= steps.length) { say("Workout complete. Ride easy or finish up."); beep(660, 300, 2); return; }
    const s = steps[S.step];
    const tgt = s.lo > 0 ? `${bpm(s.lo)} to ${bpm(s.hi)}` : `under ${bpm(s.hi)}`;
    say(`${s.name}. ${Math.round(s.min) >= 1 ? `${Math.round(s.min)} minute${Math.round(s.min) === 1 ? "" : "s"}` : `${Math.round(s.min * 60)} seconds`}. ${s.cue && s.cue.includes("feel") ? "By feel." : `Heart rate ${tgt}.`}`);
    if (!manual) { beep(s.zone === "z1" || s.zone === "z2" ? 660 : 990, 220, 2); buzz([200, 100, 200]); }
  }
  function tick() {
    const now = Date.now(), dt = last ? Math.min(5, (now - last) / 1000) : 1;
    last = now;
    if (S.running && !S.paused) {
      S.elapsed += dt;
      const spd = Date.now() - live.wheelAt < 5000 ? live.wheelSpeed : Date.now() - live.gpsAt < 8000 ? live.gpsSpeed : null;
      if (spd == null || spd > 0.8) { S.moving += dt; live.still = 0; } else live.still += dt;
      if (live.hr && now - live.hrAt < 5000) {
        S.hrSum += live.hr * dt; S.hrSecs += dt; S.hrMax = Math.max(S.hrMax, live.hr);
        S.zones[zoneOf(live.hr) - 1] += dt; S.trimp += trimpRate(live.hr) * dt / 60;
      }
      if (live.cad && now - live.cadAt < 4000 && live.cad > 0) { S.cadSum += live.cad * dt; S.cadSecs += dt; }
      if (steps.length && S.step < steps.length) {
        const s = steps[S.step], left = s.min * 60 - (S.elapsed - S.stepStart);
        const sec = Math.ceil(left);
        if (sec >= 1 && sec <= 3 && sec !== lastBeep) { lastBeep = sec; beep(1320, 90); }   // 3-2-1 before each change
        if (left <= 0) advance(false);
      }
      if (P.fuel > 0 && S.elapsed >= S.fuelAt + P.fuel * 60 && S.elapsed > 20 * 60) {
        S.fuelAt = S.elapsed; S.fuelDue = true; beep(520, 250, 3); buzz([400, 150, 400]); say("Time to eat and drink.");
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

    const st = $("hr-status");
    const s = steps[S.step];
    st.className = "status";
    st.textContent = "";
    if (s && S.running) {
      const elapsedInStep = S.elapsed - S.stepStart;
      const left = s.min * 60 - elapsedInStep;
      $("step-name").textContent = `${s.name}${steps.length > 1 ? `  ·  ${S.step + 1}/${steps.length}` : ""}`;
      $("step-time").textContent = clock(left);
      $("step-target").innerHTML = s.lo > 0 ? `Target <b>${bpm(s.lo)}–${bpm(s.hi)}</b> bpm` : `Target <b>under ${bpm(s.hi)}</b> bpm`;
      $("step-bar").style.width = `${Math.min(100, elapsedInStep / (s.min * 60) * 100)}%`;
      $("step-cue").textContent = nb(s.cue);
      const n = steps[S.step + 1];
      $("step-next").textContent = n ? `Next: ${n.name} · ${n.min >= 1 ? `${Math.round(n.min)} min` : `${Math.round(n.min * 60)} s`}` : "Last step";
      const byFeel = s.cue && s.cue.includes("by feel");
      if (byFeel || elapsedInStep < 45 && s.zone !== "z1" && s.zone !== "z2") { st.classList.add("feel"); st.textContent = byFeel ? "By feel" : "Settling in"; }
      else if (hrLive) {
        const lo = s.lo > 0 ? bpm(s.lo) : 0, hi = bpm(s.hi);
        if (hrLive < lo - 2) { st.classList.add("up"); st.textContent = "▲ Push"; }
        else if (hrLive > hi + 2) { st.classList.add("down"); st.textContent = "▼ Ease off"; }
        else { st.classList.add("good"); st.textContent = "On target"; }
      }
    } else if (s) {
      $("step-name").textContent = planned ? planned.title : "Free ride";
      $("step-time").textContent = clock(steps.reduce((a, x) => a + x.min * 60, 0));
      $("step-target").innerHTML = `${steps.length} step${steps.length === 1 ? "" : "s"} · first: <b>${esc(s.name)}</b>`;
      $("step-cue").textContent = planned ? nb(planned.session) : "";
      $("step-next").textContent = "";
      $("step-bar").style.width = "0";
    } else {
      $("step-name").textContent = S.step >= steps.length && steps.length ? "Workout done" : planned ? planned.title : "Free ride";
      $("step-time").textContent = clock(S.elapsed);
      $("step-target").textContent = steps.length ? "Ride easy home" : "No steps — just ride";
      $("step-cue").textContent = ""; $("step-next").textContent = ""; $("step-bar").style.width = "0";
    }

    $("t-time").textContent = clock(S.elapsed);
    $("t-dist").innerHTML = `${distTxt(S.dist)}<small>${unitD()}</small>`;
    const spd = now - live.wheelAt < 5000 ? live.wheelSpeed : now - live.gpsAt < 8000 ? live.gpsSpeed : null;
    $("t-speed").innerHTML = spd == null ? "—" : `${speedTxt(spd)}<small>${unitS()}</small>`;
    const showPower = now - live.powerAt < 4000;
    $("t-cad").innerHTML = showPower ? `${live.power}<small>W</small>` : live.cad != null && now - live.cadAt < 4000 ? `${live.cad}<small>rpm</small>` : "—";
    $("t-avg").textContent = S.hrSecs ? Math.round(S.hrSum / S.hrSecs) : "—";
    const tss = S.trimp / trimpHour() * 100;
    $("t-load").innerHTML = `${Math.round(tss)}${planned && planned.load ? `<small>/${Math.round(+planned.load)}</small>` : ""}`;
    $("fuel").hidden = !S.fuelDue;
    if (S.fuelDue) $("fuel-text").textContent = fuelText();

    const go = $("btn-start");
    go.textContent = !S.running ? "Start" : S.paused ? "Resume" : "Pause";
    go.classList.toggle("paused", S.running && !S.paused);
    $("btn-skip").disabled = !S.running || !steps.length || S.step >= steps.length;
    $("btn-end").disabled = !S.running;
    daySel.disabled = S.running;
    note.hidden = S.running && !S.paused;   // setup help is for before the ride, not on the bars
    document.body.classList.toggle("riding", S.running && !S.paused);
  }

  // ── controls ────────────────────────────────────────────────────────────────────────────────────────────
  $("btn-start").addEventListener("click", () => {
    if (!audio) { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; } }
    if (audio && audio.state === "suspended") audio.resume();
    startGps();
    if (!S.running) {
      Object.assign(S, { running: true, paused: false, elapsed: 0, moving: 0, dist: 0, step: 0, stepStart: 0, hrSum: 0, hrSecs: 0, hrMax: 0, zones: [0, 0, 0, 0, 0], trimp: 0, cadSum: 0, cadSecs: 0, fuelAt: 0, fuelDue: false });
      if (steps.length) { const s = steps[0]; say(`${planned.title}. First, ${s.name}, ${Math.round(s.min)} minutes.`); }
      beep(880, 200, 2);
      wake();
    } else {
      S.paused = !S.paused;
      if (S.paused) { if (lock) lock.release().catch(() => {}); } else wake();
    }
    last = Date.now();
    save(); render();
  });
  $("btn-skip").addEventListener("click", () => { advance(true); beep(990, 120); render(); });
  $("fuel-ok").addEventListener("click", () => { S.fuelDue = false; render(); });
  $("btn-end").addEventListener("click", () => {
    if (!confirm("End the ride?")) return;
    S.running = false; S.paused = false;
    if (lock) lock.release().catch(() => {});
    const tss = Math.round(S.trimp / trimpHour() * 100);
    const zt = S.zones.reduce((a, b) => a + b, 0) || 1;
    $("sum-body").innerHTML = `<div class="sum">
      <div>Time<b>${clock(S.elapsed)}</b></div><div>Moving<b>${clock(S.moving)}</b></div>
      <div>Distance<b>${distTxt(S.dist)} ${unitD()}</b></div><div>Avg speed<b>${S.moving ? speedTxt(S.dist / S.moving) : "—"} ${unitS()}</b></div>
      <div>Avg HR<b>${S.hrSecs ? Math.round(S.hrSum / S.hrSecs) : "—"}</b></div><div>Max HR<b>${S.hrMax || "—"}</b></div>
      <div>Load (hrTSS)<b>${tss}${planned && planned.load ? ` / ${Math.round(+planned.load)}` : ""}</b></div><div>Avg cadence<b>${S.cadSecs ? Math.round(S.cadSum / S.cadSecs) : "—"}</b></div>
    </div><div class="zbar sumbar" style="grid-template-columns:${S.zones.map(z => `${Math.max(0.5, z / zt * 100)}fr`).join(" ")}"><span></span><span></span><span></span><span></span><span></span></div>
    <p class="note mt-2">${S.zones.map((z, i) => `Z${i + 1} ${clock(z)}`).join(" · ")}</p>
    <p class="note">The watch or Strava keeps the official record; this summary isn't uploaded anywhere.</p>`;
    ls.set("fitness-ride-last", JSON.stringify({ ...S, endedAt: Date.now() }));
    ls.set("fitness-ride-state", null);
    S.step = 0; S.stepStart = 0;
    $("summary").showModal();
    render();
  });
  daySel.addEventListener("change", pickDay);

  const dlg = $("settings");
  $("btn-settings").addEventListener("click", () => {
    $("s-lthr").value = P.lthr; $("s-max").value = P.max; $("s-rest").value = P.rest; $("s-wheel").value = P.wheel; $("s-fuel").value = P.fuel;
    $("s-voice").checked = P.voice; paintUnits();
    dlg.showModal();
  });
  dlg.addEventListener("close", () => {
    if (dlg.returnValue !== "save") return;
    const num = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : d; };
    Object.assign(P, { lthr: num("s-lthr", P.lthr), max: num("s-max", P.max), rest: num("s-rest", P.rest), wheel: num("s-wheel", P.wheel), fuel: num("s-fuel", P.fuel),
      voice: $("s-voice").checked });
    ls.set("fitness-ride-prefs", JSON.stringify({ lthr: P.lthr, max: P.max, rest: P.rest, wheel: P.wheel, fuel: P.fuel, voice: P.voice }));
    render();
  });

  // imperial / metric: the segmented pair in settings, or a tap on the distance or speed reading mid-ride
  const unitBtns = [...document.querySelectorAll("[data-units]")];
  const paintUnits = () => unitBtns.forEach(b => b.setAttribute("aria-pressed", String((b.dataset.units === "km") === P.km)));
  const setUnits = km => { P.km = km; ls.set("fitness-units", km ? "km" : "mi"); paintUnits(); render(); };
  unitBtns.forEach(b => b.addEventListener("click", () => setUnits(b.dataset.units === "km")));
  document.querySelectorAll(".unit-flip").forEach(t => t.addEventListener("click", () => { setUnits(!P.km); beep(990, 60); }));
  paintUnits();

  // light / dark: light (paper) unless chosen otherwise; shared with the dashboard. Applies the moment it's tapped.
  const themeBtns = [...document.querySelectorAll("[data-theme-pick]")];
  const paintTheme = () => themeBtns.forEach(b => b.setAttribute("aria-pressed", String(b.dataset.themePick === (document.documentElement.dataset.theme || "light"))));
  themeBtns.forEach(b => b.addEventListener("click", () => { document.documentElement.dataset.theme = b.dataset.themePick; ls.set("fitness-theme", b.dataset.themePick); paintTheme(); }));
  paintTheme();

  planned = daySel.value === "free" ? null : days[+daySel.value] || null;
  steps = planned ? planned.steps : [];
  if (S.running) { note.textContent = "Ride restored after a reload — tap Resume."; startGps(); }
  setInterval(tick, 1000);
  render();
})();
