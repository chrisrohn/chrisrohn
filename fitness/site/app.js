"use strict";
// Renders the dashboard from the data shell.js hands it (inlined by `python -m fitness build`, a phone link, or this
// device's saved copy). No dependencies: the charts are SVG drawn here (thin marks, hairline grid, crosshair +
// tooltip, arrow-key navigation, a table view under each).
/** @param {any} D */
window.startDashboard = D => {
  const app = document.getElementById("app");
  // escape, then keep figures with their units and operators so a line never ends "RPE" or starts "min"
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
    .replace(/ × /g, "\u00a0×\u00a0").replace(/(\d) (?=(?:min|h|s|mi|km|ft|bpm|W|g|rpm|TSS|days?|weeks?|nights?|%)(?!\w))/g, "$1\u00a0")
    .replace(/(RPE|Z\d|\+|−|~) (?=[\d(])/g, "$1\u00a0").replace(/(\d)–(?=\d)/g, "$1\u2060–\u2060");   // word joiners keep 88–93 whole
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  // imperial or metric: the viewer's last choice on this device, else config.toml's athlete.units
  let units = (ls.get("fitness-units") || (D.units === "metric" ? "km" : "mi")) === "km" ? "km" : "mi";

  // ── formatting ──────────────────────────────────────────────────────────────────────────────────────────
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const asDate = iso => new Date(iso.slice(0, 10) + "T12:00:00");
  const isoToday = () => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; };
  const fmtD = iso => { const d = asDate(iso); return `${MON[d.getMonth()]} ${d.getDate()}`; };
  const fmtDow = iso => { const d = asDate(iso); return `${DOW[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()}`; };
  const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
  const dur = s => { const m = Math.round((s || 0) / 60); return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${m} min`; };
  const hrs = h => h == null ? "—" : `${Math.floor(h)}h${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
  const dist = m => { const v = units === "mi" ? m / 1609.344 : m / 1000; return `${v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1)} ${units}`; };
  const deg = c => units === "mi" ? `${Math.round(c * 9 / 5 + 32)}°` : `${Math.round(c)}°`;
  // WMO weather codes as a pictogram in the 1974 AIGA/DOT manner: solid geometric marks in the ink colour, drawn here
  // (a glyph like ☂ or ⛅ looks different on every phone, and some draw it as a colour emoji)
  const SKY = c => c >= 95 ? "thunderstorms" : c >= 71 && c <= 86 && !(c >= 80 && c <= 82) ? "snow" : c >= 51 ? "rain" : c >= 45 ? "fog" : c >= 3 ? "overcast" : c >= 1 ? "partly cloudy" : "clear";
  const CLOUD = (dy = 0) => `<circle cx="8" cy="${14.5 + dy}" r="4.5"/><circle cx="13.5" cy="${11 + dy}" r="5.5"/><circle cx="18" cy="${15 + dy}" r="4"/><rect x="8" y="${13 + dy}" width="10" height="6"/>`;
  const RAYS = (cx, cy, r0, r1, from = 0, to = 360) => { let d = ""; for (let a = from; a < to; a += 45) { const t = a * Math.PI / 180, c = Math.cos(t), s = Math.sin(t); d += `M${(cx + c * r0).toFixed(2)} ${(cy + s * r0).toFixed(2)}L${(cx + c * r1).toFixed(2)} ${(cy + s * r1).toFixed(2)}`; } return `<path d="${d}" stroke="currentColor" stroke-width="2" fill="none"/>`; };
  const PICTO = {
    clear: `<circle cx="12" cy="12" r="4.5"/>${RAYS(12, 12, 7, 10.5)}`,
    "partly cloudy": `<circle cx="8" cy="8" r="3.2"/>${RAYS(8, 8, 5, 7.5, 135, 360)}${CLOUD(2)}`,
    overcast: CLOUD(),
    fog: `<rect x="3" y="6" width="18" height="2.5"/><rect x="5" y="10.75" width="16" height="2.5"/><rect x="3" y="15.5" width="15" height="2.5"/>`,
    rain: `${CLOUD(-3)}<path d="M8.5 18.5l-1.5 3.5M12.5 18.5l-1.5 3.5M16.5 18.5l-1.5 3.5" stroke="currentColor" stroke-width="2" fill="none"/>`,
    snow: `${CLOUD(-3)}<rect x="6.5" y="18.5" width="2.5" height="2.5"/><rect x="11" y="20.5" width="2.5" height="2.5"/><rect x="15.5" y="18.5" width="2.5" height="2.5"/>`,
    thunderstorms: `${CLOUD(-4)}<path d="M13.5 13L8.5 19h3.5l-1.5 5 6-7h-3.5l1.5-4z"/>`,
  };
  /** The day's sky as a pictogram; the word goes to screen readers. */
  const sky = c => `<svg class="picto" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${PICTO[SKY(c)]}</svg><span class="sr">${SKY(c)}</span>`;
  const elev = m => units === "mi" ? `${Math.round(m * 3.28084).toLocaleString()} ft` : `${Math.round(m).toLocaleString()} m`;
  const speed = kph => kph == null ? "—" : units === "mi" ? `${(kph / 1.609344).toFixed(1)} mph` : `${kph.toFixed(1)} km/h`;
  const signed = v => v == null ? "—" : (Math.round(v) > 0 ? "+" : Math.round(v) < 0 ? "−" : "") + Math.abs(Math.round(v));
  const r0 = v => v == null ? "—" : Math.round(v).toLocaleString();
  const listOf = xs => (xs.length < 2 ? (xs[0] || "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`).replace(/^./, c => c.toUpperCase());
  const mean = xs => { const v = xs.filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

  // ── charts ──────────────────────────────────────────────────────────────────────────────────────────────
  const SVG = "http://www.w3.org/2000/svg";
  const BAR_R = 0;   // square-ended bars: the 1978 Swiss-style data marks
  const el = (tag, attrs = {}, style = "") => {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (style) n.setAttribute("style", style);
    return n;
  };
  function niceTicks(min, max, count = 4) {
    if (min === max) { min -= 1; max += 1; }
    const raw = (max - min) / count, mag = Math.pow(10, Math.floor(Math.log10(raw))), err = raw / mag;
    const step = mag * (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1);
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step, ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(6));
    return ticks;
  }
  function barPath(x, yTop, yBase, w, radius) {
    const h = yBase - yTop; if (h <= 0) return "";
    const r = Math.min(radius, w / 2, h);
    return `M${x},${yBase}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${yBase}Z`;
  }
  const swatch = s => `<i class="sw ${s.type === "bar" ? "" : s.wash ? "wash" : "line"}" style="background:${s.color}"></i>`;

  function chart(host, cfg) {
    if (!host || host.dataset.drawn) return;   // drawn once per build of its panel; a panel not rebuilt keeps its chart
    host.dataset.drawn = "1";
    host.classList.add("chart");
    host.tabIndex = 0;
    host.setAttribute("role", "img");
    host.setAttribute("aria-label", cfg.label || "");
    const wrap = document.createElement("div");
    host.parentNode.insertBefore(wrap, host);
    wrap.appendChild(host);
    const shown = cfg.series.filter(s => !s.hideLegend);
    if (shown.length + (cfg.band ? 1 : 0) + (cfg.ref ? 1 : 0) >= 2) {
      const lg = document.createElement("div");
      lg.className = "legend";
      lg.innerHTML = shown.map(s => `<span>${swatch(s)}${esc(s.name)}</span>`).join("")
        + (cfg.band ? `<span><i class="sw wash" style="background:${cfg.band.color}"></i>${esc(cfg.band.name)}</span>` : "")
        + (cfg.ref ? `<span><i class="sw wash" style="background:${cfg.ref.color}"></i>${esc(cfg.ref.label)}</span>` : "")
        + (cfg.dashFrom != null ? `<span><i class="sw dash" style="border-color:var(--ink-2)"></i>projected</span>` : "");
      wrap.insertBefore(lg, host);
    }
    const tip = document.createElement("div");
    tip.className = "tip"; tip.hidden = true;
    host.appendChild(tip);
    const state = { i: null, geo: null };
    const draw = () => {
      const old = host.querySelector("svg"); if (old) old.remove();
      const W = Math.max(260, host.clientWidth), H = cfg.height || 220, n = cfg.x.length;
      const stacked = cfg.series.filter(s => s.stack);
      const vals = [];
      for (const s of cfg.series) if (!s.stack) vals.push(...s.values.filter(v => v != null));
      if (stacked.length) for (let i = 0; i < n; i++) vals.push(stacked.reduce((a, s) => a + (s.values[i] || 0), 0));
      if (cfg.band) for (let i = 0; i < n; i++) { if (cfg.band.lo[i] != null) vals.push(cfg.band.lo[i], cfg.band.hi[i]); }
      if (cfg.ref) vals.push(cfg.ref.lo, cfg.ref.hi);
      if (cfg.zero || cfg.series.some(s => s.type === "bar")) vals.push(0);
      const ticks = niceTicks(cfg.yMin ?? Math.min(...vals), cfg.yMax ?? Math.max(...vals));
      const y0 = ticks[0], y1 = ticks[ticks.length - 1];
      const fmtY = cfg.yFmt || (v => v.toLocaleString());
      const left = 10 + Math.max(...ticks.map(t => fmtY(t).length)) * 6.6, right = 10, top = cfg.marks ? 18 : 8, bottom = 22;
      const iw = W - left - right, ih = H - top - bottom, slot = iw / n;
      const X = i => left + slot * (i + 0.5), Y = v => top + ih - (v - y0) / (y1 - y0) * ih;
      const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H, "aria-hidden": "true" });
      for (const t of ticks) {
        svg.appendChild(el("line", { x1: left, x2: W - right, y1: Y(t), y2: Y(t), class: t === 0 && y0 < 0 ? "baseline" : "gridline" }));
        const tx = el("text", { x: left - 6, y: Y(t) + 4, "text-anchor": "end" }); tx.textContent = fmtY(t); svg.appendChild(tx);
      }
      svg.appendChild(el("line", { x1: left, x2: W - right, y1: Y(Math.max(y0, Math.min(0, y1))), y2: Y(Math.max(y0, Math.min(0, y1))), class: "baseline" }));
      const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 78))));
      for (let i = n - 1; i >= 0; i -= every) {
        const tx = el("text", { x: Math.min(W - right - 14, Math.max(left + 14, X(i))), y: H - 6, "text-anchor": "middle" });
        tx.textContent = (cfg.xFmt || fmtD)(cfg.x[i]); svg.appendChild(tx);
      }
      if (cfg.ref) {
        const from = cfg.ref.from ?? 0, xa = left + slot * from;
        svg.appendChild(el("rect", { x: xa, width: W - right - xa, y: Y(cfg.ref.hi), height: Math.max(0, Y(cfg.ref.lo) - Y(cfg.ref.hi)) }, `fill:${cfg.ref.color};fill-opacity:var(--wash)`));
      }
      for (const b of cfg.xbands || []) {
        const xa = left + slot * b.from, xb = left + slot * (b.to + 1);
        svg.appendChild(el("rect", { x: xa, width: Math.max(1, xb - xa), y: top, height: ih }, `fill:${b.color};fill-opacity:var(--wash)`));
        const tx = el("text", { x: xa + 4, y: top + ih - 6, "text-anchor": "start", class: "marker-label" }); tx.textContent = b.label; svg.appendChild(tx);
      }
      if (cfg.band) {
        let d = "", run = [];
        const flush = () => { if (run.length > 1) d += "M" + run.map(i => `${X(i)},${Y(cfg.band.hi[i])}`).join("L") + "L" + run.slice().reverse().map(i => `${X(i)},${Y(cfg.band.lo[i])}`).join("L") + "Z"; run = []; };
        for (let i = 0; i < n; i++) { if (cfg.band.lo[i] != null) run.push(i); else flush(); }
        flush();
        svg.appendChild(el("path", { d }, `fill:${cfg.band.color};fill-opacity:var(--wash)`));
      }
      const bw = Math.max(1, Math.min(24, slot > 4 ? slot * 0.72 : slot - 1));
      const base = Y(Math.max(y0, Math.min(0, y1)));
      for (const s of cfg.series.filter(s => s.type === "bar" && !s.stack)) {
        for (let i = 0; i < n; i++) {
          const v = s.values[i]; if (!v) continue;
          svg.appendChild(el("path", { d: barPath(X(i) - bw / 2, Y(v), base, bw, BAR_R) }, `fill:${s.color}`));
        }
      }
      if (stacked.length) {
        for (let i = 0; i < n; i++) {
          let acc = 0;
          const parts = stacked.map(s => ({ s, v: s.values[i] || 0 })).filter(p => p.v > 0);
          parts.forEach((p, k) => {
            const yb = Y(acc) - (k ? 1 : 0), yt = Y(acc + p.v) + (k < parts.length - 1 ? 1 : 0);
            acc += p.v;
            svg.appendChild(el("path", { d: k === parts.length - 1 ? barPath(X(i) - bw / 2, yt, yb, bw, BAR_R) : `M${X(i) - bw / 2},${yb}V${yt}H${X(i) + bw / 2}V${yb}Z` }, `fill:${p.s.color}`));
          });
        }
      }
      for (const s of cfg.series.filter(s => s.type === "line")) {
        const seg = (from, to) => {
          let d = "", pen = false;
          for (let i = from; i <= to; i++) {
            const v = s.values[i];
            if (v == null) { pen = false; continue; }
            d += `${pen ? "L" : "M"}${X(i)},${Y(v)}`; pen = true;
          }
          return d;
        };
        const split = cfg.dashFrom != null && s.project !== false ? cfg.dashFrom : n - 1;
        const st = `fill:none;stroke:${s.color};stroke-width:2;stroke-linejoin:round;stroke-linecap:round`;
        svg.appendChild(el("path", { d: seg(0, split) }, st));
        if (split < n - 1) svg.appendChild(el("path", { d: seg(split, n - 1) }, st + ";stroke-dasharray:4 5"));
        if (s.endDot) {
          const last = s.values.reduce((a, v, i) => v != null ? i : a, -1);
          if (last >= 0) svg.appendChild(el("circle", { cx: X(last), cy: Y(s.values[last]), r: 4 }, `fill:${s.color};stroke:var(--surface);stroke-width:2`));
        }
      }
      for (const mk of cfg.marks || []) {
        if (mk.at < 0 || mk.at >= n) continue;
        svg.appendChild(el("line", { x1: X(mk.at), x2: X(mk.at), y1: top - 4, y2: top + ih, class: "marker-line" }));
        const tx = el("text", { x: X(mk.at), y: top - 7, "text-anchor": mk.at > n * 0.85 ? "end" : "middle", class: "marker-label" }); tx.textContent = mk.label; svg.appendChild(tx);
      }
      const cross = el("line", { y1: top, y2: top + ih, class: "cross", visibility: "hidden" });
      svg.appendChild(cross);
      const dots = el("g"); svg.appendChild(dots);
      const hit = el("rect", { x: left, y: 0, width: iw, height: H, fill: "transparent" });
      svg.appendChild(hit);
      host.insertBefore(svg, tip);
      state.geo = { X, Y, left, slot, n, cross, dots, W };
      hit.addEventListener("pointermove", e => { const r = svg.getBoundingClientRect(); show(Math.floor((e.clientX - r.left) * (W / r.width) - left) / slot | 0); });
      hit.addEventListener("pointerleave", hide);
      if (state.i != null) show(state.i);
    };
    const show = i => {
      const g = state.geo; i = Math.max(0, Math.min(g.n - 1, i)); state.i = i;
      g.cross.setAttribute("x1", g.X(i)); g.cross.setAttribute("x2", g.X(i)); g.cross.setAttribute("visibility", "visible");
      g.dots.replaceChildren();
      for (const s of cfg.series) {
        if (s.type !== "line" || s.values[i] == null) continue;
        g.dots.appendChild(el("circle", { cx: g.X(i), cy: g.Y(s.values[i]), r: 4 }, `fill:${s.color};stroke:var(--surface);stroke-width:2`));
      }
      const rows = cfg.series.filter(s => s.values[i] != null && !s.noTip).map(s => `<div class="r"><span>${swatch(s)}${esc(s.name)}</span><b class="num">${esc((s.fmt || r0)(s.values[i]))}</b></div>`);
      if (cfg.band && cfg.band.lo[i] != null) rows.push(`<div class="r"><span><i class="sw wash" style="background:${cfg.band.color}"></i>${esc(cfg.band.name)}</span><b class="num">${esc((cfg.band.fmt || r0)(cfg.band.lo[i]))}–${esc((cfg.band.fmt || r0)(cfg.band.hi[i]))}</b></div>`);
      if (cfg.extra) rows.push(...cfg.extra(i).map(([k, v]) => `<div class="r"><span>${esc(k)}</span><b class="num">${esc(v)}</b></div>`));
      tip.innerHTML = `<div class="t">${esc((cfg.tipFmt || fmtDow)(cfg.x[i]))}</div>${rows.join("") || '<div class="muted">no data</div>'}`;
      tip.hidden = false;
      const scale = host.clientWidth / g.W, x = g.X(i) * scale, tw = tip.offsetWidth;
      tip.style.left = `${x + 12 + tw > host.clientWidth ? Math.max(0, x - tw - 12) : x + 12}px`;
      tip.style.top = "4px";
    };
    const hide = () => { state.i = null; tip.hidden = true; if (state.geo) { state.geo.cross.setAttribute("visibility", "hidden"); state.geo.dots.replaceChildren(); } };
    host.addEventListener("keydown", e => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); show((state.i ?? cfg.x.length - 1) + (e.key === "ArrowLeft" ? -1 : 1)); }
      else if (e.key === "Escape") hide();
    });
    host.addEventListener("blur", hide);
    const det = document.createElement("details");
    det.className = "table";
    det.innerHTML = `<summary>Table</summary><div class="scroll" tabindex="0" role="region" aria-label="Chart data"><table class="tbl"><thead><tr><th>${esc(cfg.xName || "Date")}</th>${cfg.series.map(s => `<th class="r">${esc(s.name)}</th>`).join("")}</tr></thead><tbody>${
      cfg.x.map((x, i) => [x, i]).reverse().map(([x, i]) => `<tr><td>${esc((cfg.tipFmt || fmtDow)(x))}</td>${cfg.series.map(s => `<td class="r">${s.values[i] == null ? "—" : esc((s.fmt || r0)(s.values[i]))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    wrap.appendChild(det);
    let raf = 0;
    new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }).observe(host);
    draw();
  }

  // ── page ────────────────────────────────────────────────────────────────────────────────────────────────
  const now = D.now, form = now.form || {};
  const ORDER = ["rest", "easy", "moderate", "hard"];
  // the plan for the distances picked on the page (a race's option buttons); the build ships every alternative
  const planFor = (name, key) => {
    const base = D.plan && D.plan.races.find(r => r.name === name);
    return base && base.option === key ? D.plan : D.variants[`${name}|${key}`] || null;
  };
  const activePlan = () => {
    if (!D.plan) return null;
    for (const r of D.plan.races) {
      const pick = ls.get(`fitness-option:${r.name}`);
      if (pick && pick !== r.option && D.variants[`${r.name}|${pick}`]) return D.variants[`${r.name}|${pick}`];
    }
    return D.plan;
  };
  let plan = activePlan();
  // mirrors metrics.recommend: the plan's session is the default, readiness can only make it easier
  const todayCall = day => {
    const base = now.base_call;
    if (!day) return base;
    const c = D.commute && D.commute.today;
    if (day.commute && c && c.weather && c.verdict === "skip") return now.recommendation;   // drive today, train this evening
    if (day.commute && c) return { level: { skip: "rest", easy: "easy", optional: "easy" }[c.verdict] || day.level, title: c.title, detail: c.detail };   // same rule as the build
    if (ORDER.includes(base.level) && ORDER.indexOf(base.level) < ORDER.indexOf(day.level)) return { ...base, detail: `Planned: ${day.session}. Readiness says scale it back — ${base.detail.charAt(0).toLowerCase()}${base.detail.slice(1)}` };
    const m = day.minutes || 0;
    return { level: day.level, title: day.title, detail: day.session + (m >= 60 ? ` — about ${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : m ? ` — about ${m} min` : "") };
  };

  // ── the morning check-in ────────────────────────────────────────────────────────────────────────────────
  // How you feel is the earliest read on how the training is landing: subjective wellness tracks load, fatigue and
  // illness more sensitively than resting HR or heart-rate measures do (Saw, Main & Gastin 2016, a systematic review
  // of 56 studies). Four taps, kept on this device only, blended into readiness (70% the watch, 30% you) and able to
  // ease the call, never to make it harder. Sickness follows the "neck check": a head cold may ride easy, anything
  // below the neck (chest, fever, aches) rests.
  const CHECK_KEY = "fitness-checkin";
  const FEEL = [
    ["legs", "Legs", ["Very sore", "Sore", "Normal", "Good", "Fresh"]],
    ["energy", "Energy", ["Drained", "Tired", "Normal", "Good", "Great"]],
    ["stress", "Life stress", ["Very high", "High", "Normal", "Low", "Very low"]],
    ["mood", "Mood", ["Low", "Flat", "Normal", "Good", "Great"]],
  ];
  const SICK = [["none", "No"], ["above", "Head cold"], ["below", "Chest, fever, aches"]];
  const stored = key => { try { const c = JSON.parse(ls.get(key) || "{}"); return c && typeof c === "object" ? c : {}; } catch { return {}; } };
  // this phone's answers over what the sync already holds (another device's, or this one's from before a reinstall)
  const checkins = () => { const mine = stored(CHECK_KEY), all = { ...(D.checkins || {}) }; for (const [d, c] of Object.entries(mine)) all[d] = { ...(all[d] || {}), ...c }; return all; };
  const live = () => D.today === isoToday();                         // a check-in belongs to the morning it was made on
  const checkin = () => live() ? checkins()[D.today] || null : null;
  const saveCheckin = (k, v) => saveAnswers({ [k]: v });
  const saveAnswers = got => {
    const all = stored(CHECK_KEY), day = { ...(all[D.today] || {}), ...got };
    all[D.today] = day;
    const keep = Object.keys(all).sort().slice(-90);                  // three months is plenty for the chart
    ls.set(CHECK_KEY, JSON.stringify(Object.fromEntries(keep.map(d => [d, all[d]]))));
    syncFeel();
  };

  // ── how hard each ride felt: Foster's session RPE, on the CR-10 scale ──────────────────────────────────────
  // Rated rides sit beside their heart-rate load (TSS). Rides that keep feeling harder than their load says are an
  // early sign of fatigue, before it shows overnight (Foster et al. 2001; Saw et al. 2016).
  const RPE_KEY = "fitness-rpe";
  const RPE_WORDS = { 1: "very easy", 2: "easy", 3: "moderate", 4: "somewhat hard", 5: "hard", 6: "hard", 7: "very hard", 8: "very hard", 9: "near max", 10: "maximal" };
  const ratings = () => ({ ...(D.rpe || {}), ...stored(RPE_KEY) });
  const rateRide = (id, n) => {
    const all = { ...stored(RPE_KEY), [id]: n };
    ls.set(RPE_KEY, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-60))));
    syncFeel();
  };
  // each rated ride: session RPE (RPE × minutes) per TSS, against your own usual ratio
  const felt = () => {
    const R = ratings();
    const rows = (D.recent || []).filter(a => a.group === "ride" && R[a.id] && a.load > 0).map(a => ({ ...a, rpe: R[a.id], srpe: R[a.id] * a.moving_s / 60, ratio: R[a.id] * a.moving_s / 60 / a.load })).reverse();
    const sorted = rows.map(r => r.ratio).sort((a, b) => a - b), med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    for (const r of rows) r.vs = med ? r.ratio / med : null;
    const last3 = rows.slice(-3), drift = rows.length >= 8 && last3.length === 3 ? mean(last3.map(r => r.vs)) : null;
    return { rows, drift };
  };
  const toRate = () => {
    if (!live()) return null;
    const R = ratings(), since = new Date(asDate(D.today).getTime() - 3 * 864e5).toISOString().slice(0, 10);
    return (D.recent || []).find(a => a.id && a.group === "ride" && !a.commute && a.start.slice(0, 10) >= since && !R[a.id]) || null;
  };
  function rpeBlock() {
    const a = toRate();
    if (!a) return "";
    return `<div class="rate"><span class="label">How hard was it?</span> <span>${esc(a.start.slice(0, 10) === D.today ? "Today's" : `${DOW[asDate(a.start).getDay()]}'s`)} ${esc(a.name)} · ${dur(a.moving_s)}</span>
      <div class="seg rpe" role="group" aria-label="Effort, 1 very easy to 10 maximal">${Array.from({ length: 10 }, (_, i) => `<button type="button" class="chip" data-rpe="${esc(a.id)}" data-v="${i + 1}" aria-label="${i + 1}, ${RPE_WORDS[i + 1]}">${i + 1}</button>`).join("")}</div>
      <p class="sub">1 very easy · 3 moderate · 5 hard · 7 very hard · 10 maximal. The whole ride, 30 minutes after.</p></div>`;
  }

  // check-ins and ratings go to the sync too (a quiet "service" run), so the morning call and every device see them
  let feelTimer = 0;
  function syncFeel() {
    clearTimeout(feelTimer);
    feelTimer = window.setTimeout(() => {
      const mine = stored(CHECK_KEY), since = new Date(asDate(D.today).getTime() - 3 * 864e5).toISOString().slice(0, 10);
      const body = { checkins: Object.fromEntries(Object.entries(mine).filter(([d]) => d >= since)), rpe: stored(RPE_KEY) };
      const json = JSON.stringify(body);
      if (json === ls.get("fitness-feel-sent")) return;
      document.dispatchEvent(new CustomEvent("fitness-feel", { detail: { code: "feel:" + btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), sent: json } }));
    }, 4000);
  }
  // 3 is your normal = 75, like the watch's markers; each step either way is 15 points
  const feelScore = c => { const v = c && FEEL.map(([k]) => c[k]).filter(x => x >= 1 && x <= 5); return v && v.length ? Math.max(0, Math.min(100, Math.round(75 + 15 * (mean(v) - 3)))) : null; };
  const levelOf = s => s >= 75 ? "hard" : s >= 60 ? "moderate" : s >= 45 ? "easy" : "rest";
  // readiness with the check-in in it, and what it says
  const blended = () => {
    const rd = now.readiness, c = checkin(), f = feelScore(c);
    if (!c) return null;
    const score = f == null ? (rd ? rd.score : null) : rd ? Math.round(0.7 * rd.score + 0.3 * f) : f;
    const low = FEEL.filter(([k]) => c[k] === 1).map(([, name, words]) => `${name.toLowerCase()} ${words[0].toLowerCase()}`);
    let cap = score == null ? null : levelOf(score), why = f != null && rd && levelOf(score) !== levelOf(rd.score) ? `how you feel (${f}) moves readiness to ${score}` : "";
    if (low.length) { cap = cap === "rest" ? "rest" : "easy"; why = low.join(", "); }
    if (c.sick === "above") { cap = cap === "rest" ? "rest" : "easy"; why = "a head cold: easy only, and stop if it gets worse"; }
    if (c.sick === "below") { cap = "rest"; why = "symptoms below the neck: rest until they're gone"; }
    return { score, feel: f, cap, why, c };
  };
  // the call, eased by the check-in when it says so (the same rule as readiness: easier, never harder)
  const feelCall = (rec, day) => {
    const B = blended();
    if (!B || !B.cap || !ORDER.includes(rec.level) || ORDER.indexOf(B.cap) >= ORDER.indexOf(rec.level)) return rec;
    const planned = day ? `Planned: ${day.session}. ` : "";
    const commute = day && day.commute ? " On the bike to work: Z1 both ways, or leave it." : "";
    return B.cap === "rest"
      ? { level: "rest", title: "Rest today", detail: `${planned}Your check-in says rest — ${B.why}. Off the bike, or 20–30 min truly easy if you're well.`, eased: true }
      : { level: "easy", title: "Keep it easy", detail: `${planned}Your check-in says ease off — ${B.why}. Z1–Z2 only, 45–75 min, no intervals.${commute}`, eased: true };
  };
  const answered = c => !!c && FEEL.every(([k]) => c[k]) && !!c.sick;
  let feelOpen = false;   // a finished check-in reopened to change an answer stays open while you do
  function checkinBlock() {
    if (!live()) return "";
    const c = checkin() || {};
    const done = answered(c);
    const group = (k, name, opts) => `<fieldset class="feel"><legend>${esc(name)}</legend><div class="seg">${opts.map(([v, label]) =>
      `<button type="button" class="chip" data-feel="${k}" data-v="${v}" aria-pressed="${String(c[k] === v)}">${esc(label)}</button>`).join("")}</div></fieldset>`;
    const B = blended();
    const said = done ? FEEL.map(([k, name, words]) => `${name.toLowerCase()} ${words[c[k] - 1].toLowerCase()}`).concat(c.sick !== "none" ? [SICK.find(s => s[0] === c.sick)[1].toLowerCase()] : []) : [];
    return `<details class="checkin"${done && !feelOpen ? "" : " open"}><summary><span class="label">How do you feel?</span>${done ? ` <span class="said">${esc(listOf(said))}${B && B.feel != null ? ` · feel ${B.feel}` : ""}</span>` : ""}</summary>
      ${done ? "" : `<p class="feel-quick"><button type="button" class="chip primary" data-feel-all="1">All normal · not sick</button> <span class="sub">or tap each below</span></p>`}
      <div class="feel-in">${FEEL.map(([k, name, words]) => group(k, name, words.map((w, i) => [i + 1, w]))).join("")}${group("sick", "Feeling sick?", SICK)}</div>
      <p class="sub">Kept on this phone. It eases the call when your body says so, never makes it harder.</p></details>`;
  }
  app.addEventListener("click", e => {
    const r = e.target instanceof Element ? e.target.closest("[data-rpe]") : null;
    if (!r) return;
    rateRide(/** @type {HTMLElement} */ (r).dataset.rpe, Number(/** @type {HTMLElement} */ (r).dataset.v));
    const y = window.scrollY;
    render("today");
    window.scrollTo(0, y);
  });
  app.addEventListener("click", e => {
    const t = e.target instanceof Element ? e.target : null;
    const sum = t && t.closest(".checkin > summary");
    if (sum) { feelOpen = !(/** @type {HTMLDetailsElement} */ (sum.parentElement).open); return; }
    if (t && t.closest("[data-feel-all]")) {                         // the usual morning: everything normal, not sick
      feelOpen = false;
      const now = checkin() || {};   // only what's not answered yet: a "very sore" already tapped stays very sore
      saveAnswers({ ...Object.fromEntries(FEEL.map(([k]) => [k, 3])), sick: "none", ...Object.fromEntries(Object.entries(now).filter(([, v]) => v != null && v !== "")) });
      const y = window.scrollY;
      render("today");
      window.scrollTo(0, y);
      const sum2 = document.querySelector(".checkin > summary");
      if (sum2 instanceof HTMLElement) sum2.focus();
      return;
    }
    const b = t && t.closest("[data-feel]");
    if (!b) return;
    const k = /** @type {HTMLElement} */ (b).dataset.feel, raw = /** @type {HTMLElement} */ (b).dataset.v;
    feelOpen = answered(checkin());                                   // the answer that finishes it folds it away
    saveCheckin(k, k === "sick" ? raw : Number(raw));
    const y = window.scrollY;
    render("today");
    window.scrollTo(0, y);
    const again = document.querySelector(`[data-feel="${k}"][data-v="${raw}"]`);
    if (again instanceof HTMLElement && again.closest("details[open]")) again.focus();
  });

  // the power-duration curve (fitness/power.py): the last 6 weeks against the year's best, and critical power
  const durLabel = m => m >= 60 ? `${m / 60} h` : `${m} min`;
  function powerHTML() {
    const P = D.power;
    if (!P) return "";
    const cp = P.cp;
    return `<h3 class="mt-6" id="power">Power-duration curve</h3>
      <div class="kpis">${cp ? `<span>Critical power <b>${cp.cp} W</b>${P.wkg_cp ? ` · ${P.wkg_cp} W/kg` : ""}</span><span>W′ <b>${cp.w_prime_kj} kJ</b></span>` : ""}
        ${P.eftp ? `<span>eFTP <b>${P.eftp} W</b>${P.wkg_20 ? ` · 20 min ${P.wkg_20} W/kg` : ""}</span>` : ""}${P.ftp ? `<span>FTP in use <b>${P.ftp} W</b></span>` : ""}</div>
      <div id="c-power"></div>
      ${P.notes.map(n => `<p class="advice">${esc(n)}</p>`).join("")}
      <p class="sub">Best average power for each duration. Critical power is fitted to the best 3–20 minute efforts of the last 90 days${cp ? "" : " once there are enough of them"}.</p>`;
  }
  // rides you rated, against their heart-rate load
  function ratedHTML() {
    const { rows, drift } = felt();
    if (!rows.length) return "";
    const word = v => v == null ? "—" : v >= 1.2 ? "harder than usual" : v <= 0.83 ? "easier than usual" : "as usual";
    return `<h3 class="mt-6" id="rated">How rides felt</h3>
      <div class="scrollx" tabindex="0" role="region" aria-label="Rated rides"><table class="tbl"><thead><tr><th>When</th><th>Ride</th><th class="r">RPE</th><th class="r hide-sm">Session RPE</th><th class="r">TSS</th><th>Felt</th></tr></thead><tbody>
      ${rows.slice().reverse().map(r => `<tr><td class="num">${fmtD(r.start)}</td><td>${esc(r.name)}</td><td class="r">${r.rpe}</td><td class="r hide-sm">${r0(r.srpe)}</td><td class="r">${r0(r.load)}</td><td>${rows.length >= 5 ? word(r.vs) : "—"}</td></tr>`).join("")}
      </tbody></table></div>
      <p class="sub">${rows.length < 8 ? `${rows.length} rated so far: after 8, the app says when rides start feeling harder than their load (fatigue) or easier (fitness).` : drift >= 1.2 ? "The last three rides felt harder than their load: ease off before the overnight numbers say so." : drift <= 0.83 ? "The last three rides felt easier than their load: the fitness is landing." : "Effort and load agree: the training is landing as planned."}</p>`;
  }

  // strength after the ride (plan.py STRENGTH): what, and whether today's call still has room for it
  function strengthLine(day, rec) {
    const S = day && day.strength;
    if (!S) return "";
    const off = ORDER.indexOf(rec.level) < ORDER.indexOf(day.level);
    const wk = D.strength;
    const tally = wk ? ` <span class="sub">Strength this week: ${wk.done.length} of ${wk.done.length + wk.ahead.length}.</span>` : "";
    return `<p class="lift${off ? " off" : ""}"><span class="label">Plus · ${esc(S.title)} · ${S.minutes} min</span> ${off ? "Skip the lifting today: the call is easier than the plan, and heavy sets want fresh legs." : esc(S.detail)}${off ? "" : tally}</p>`;
  }

  const shortName = name => name.replace(/^Bell's /, "").replace(/ Cometh Challenge$/, "");
  const LEVEL = { hard: "Go hard", moderate: "Train", easy: "Easy", rest: "Rest", unknown: "Waiting for data" };
  const formWord = t => t == null ? "" : t > 15 ? "very fresh" : t > 5 ? "fresh" : t > -10 ? "neutral" : t > -30 ? "productive fatigue" : "overreaching";
  // colour says good or bad; the glyph says which way the number moved (● when it has no direction)
  const tile = (k, v, unit, d, tone, dir = "") => `<div class="tile"><span class="k">${esc(k)}</span><span class="v num">${v}${unit ? `<small>${esc(unit)}</small>` : ""}</span><span class="d">${tone ? `<span class="tag ${tone}" aria-hidden="true">${dir === "up" ? "▲" : dir === "down" ? "▼" : "●"}</span> ` : ""}${d}</span></div>`;
  const COMP = { sleep: "Sleep score", rhr: "Resting HR", sleep_stress: "Overnight stress", bb_wake: "Body Battery at wake", resp: "Respiration" };
  const SLEEP_PARTS = { duration: "Duration", deep: "Deep sleep", rem: "REM sleep", continuity: "Continuity", calm: "Overnight calm" };
  const raw = k => {   // today's reading for a readiness marker, as recorded (Body Battery 5, not its score)
    if (k === "sleep") return now.sleep ? `${now.sleep.score}` : "";
    const M = D.markers && D.markers[k], x = M && M.series.find(r => r.date === D.today);
    return x && x.v != null ? `${x.v}${M.unit ? ` ${M.unit}` : ""}` : "";
  };
  const meters = (obj, names) => `<div class="meters">${Object.entries(obj).map(([k, v]) => `<div class="meter"><span>${esc(names[k] || k)}${raw(k) && k !== "sleep" ? ` <small class="raw">${esc(raw(k))}</small>` : ""}</span><span class="track"><span class="fill" style="display:block;width:${Math.max(2, v)}%"></span></span><b class="num">${v}</b></div>`).join("")}</div>`;

  // a tag marks where a phase (or the trainer season) starts, not every row inside it
  const chipFor = (d, prev) => (!prev || prev.phase !== d.phase || prev.indoor !== d.indoor)
    ? `<br><span class="phase ${d.phase}">${esc(d.phase)}</span>${d.indoor ? '<span class="phase indoor">trainer</span>' : ""}` : "";

  function compareOptions(r) {
    const rows = r.options.map(o => {
      const p = planFor(r.name, o.key), rr = p && p.races.find(x => x.name === r.name);
      return rr ? { o, rr, pct: rr.race_ctl / rr.target_ctl } : null;
    }).filter(Boolean);
    if (rows.length < 2) return "";
    const longest = rows.reduce((a, b) => (a.rr.km >= b.rr.km ? a : b));
    const build = longest.rr.build_start ? fmtD(longest.rr.build_start) : "the outdoor build";
    const verdict = longest.pct >= 0.95 ? `On track for the ${esc(longest.o.label)} if the trainer weeks happen.`
      : longest.pct >= 0.85 ? `The ${esc(longest.o.label)} is within reach but tight. Decide by ${build}, when the outdoor build starts: if the trainer winter slips, drop down.`
      : `The shorter distance fits the fitness the calendar allows; the ${esc(longest.o.label)} would be a survival ride.`;
    return `<div class="advice"><b>Which distance?</b> ${rows.map(x => `${esc(x.o.label)}: race-morning fitness <b>${r0(x.rr.race_ctl)}</b> of ${x.rr.target_ctl} (${Math.round(x.pct * 100)}%), peak week ${x.rr.peak_week_h ?? "—"} h`).join(" · ")}. ${verdict}</div>`;
  }

  function raceCard(r) {
    const eds = D.editions[r.name] || [];
    const best = eds.length ? eds.reduce((a, b) => (a.moving_s < b.moving_s ? a : b)) : null;
    const pct = Math.round(r.race_ctl / r.target_ctl * 100);
    const km = r.km ? (units === "mi" ? `${Math.round(r.km / 1.609)} mi` : `${r.km} km`) : "";
    return `<div class="racecard">
      <div class="rhead"><span class="when">${fmtDow(r.date)}, ${r.date.slice(0, 4)} · ${r.days_out} days</span><h3 class="rname">${esc(r.name)}</h3></div>
      ${r.options.length > 1 ? `<div class="opts" role="group" aria-label="${esc(r.name)} distance">${r.options.map(o => `<button type="button" class="chip opt" data-race="${esc(r.name)}" data-opt="${esc(o.key)}" aria-pressed="${o.key === r.option}">${esc(o.label)}</button>`).join("")}</div>` : ""}
      <div class="kpis"><span>${km ? `<b>${km}</b>` : ""}${r.climbing_ft ? ` · <b>${elev(r.climbing_ft / 3.28084)}</b> climbing` : ""} · ~${hrs(r.hours)} race</span>
        <span>Taper <b>${r.taper_days} days</b> at <b>${Math.round(r.volume_floor * 100)}%</b> volume</span></div>
      <div class="kpis"><span>Race morning: fitness <b>${r0(r.race_ctl)}</b> of ${r.target_ctl} <span class="tag ${pct >= 95 ? "good" : "bad"}">${pct >= 95 ? "▲" : "▼"} ${pct}%</span></span>
        <span>form <b>${signed(r.race_tsb)}</b> <span class="tag ${r.in_band ? "good" : "bad"}">${r.in_band ? "▲ in band" : "▼ off"}</span> ${signed(r.target_tsb[0])} to ${signed(r.target_tsb[1])}</span></div>
      ${r.options.length > 1 ? compareOptions(r) : ""}
      ${best ? `<p class="sub">Best edition: ${best.date.slice(0, 4)}, ${dur(best.moving_s)} (${speed(best.speed_kph)}), started at fitness <b>${r0(best.ctl)}</b>, form <b>${signed(best.tsb)}</b>.</p>
      <details class="table"><summary>${eds.length} past edition${eds.length === 1 ? "" : "s"}</summary><div class="scroll" tabindex="0" role="region" aria-label="Past editions"><table class="tbl"><thead><tr><th>Date</th><th class="r">Time</th><th class="r">Speed</th><th class="r">Avg HR</th><th class="r">Fitness</th><th class="r">Form</th></tr></thead><tbody>
        ${eds.map(e => `<tr><td>${fmtD(e.date)}, ${e.date.slice(0, 4)}</td><td class="r">${dur(e.moving_s)}</td><td class="r">${speed(e.speed_kph)}</td><td class="r">${r0(e.avg_hr)}</td><td class="r">${r0(e.ctl)}</td><td class="r">${signed(e.tsb)}</td></tr>`).join("")}</tbody></table></div></details>` : ""}
    </div>`;
  }

  function commuteBlock() {
    const c = D.commute && D.commute.today;
    if (!c) return "";
    const headline = pToday0() && pToday0().commute;   // on a planned commute day the call above already is the commute
    const fuel = c.fuel && !D.fuel;
    if (headline && !fuel) return "";                  // nothing left to say under the label: no orphaned heading
    const mark = { ride: "▲", easy: "■", optional: "□", wet: `<svg class="picto" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${PICTO.rain}</svg>`, skip: "▼" }[c.verdict] || "■";
    return `<div class="commute-call ${esc(c.verdict)}"><span class="label">Bike commute</span>
      ${headline ? "" : `<p><b>${mark} ${esc(c.title)}.</b> ${esc(c.detail)}</p>`}
      ${fuel ? `<p class="sub">${esc(c.fuel)}</p>` : ""}</div>`;
  }

  // the fallback for weather or a short day; a rest day's "feeling great?" only when the morning says so
  function planB(day, rec, rd) {
    if (!day || !day.alt || (rd && rd.illness)) return "";
    if (day.role === "rest" ? rd && rd.score < 70 : rec.level === "rest") return "";
    return `<p class="plan-b"><span class="label">Plan B</span> ${esc(day.alt)}</p>`;
  }

  // readiness weighted by what predicts your good commutes (metrics.personal_weights)
  function personalNote() {
    const P = now.personal;
    if (!P) return `<p class="sub mt-3">Weights are the defaults until there are 20 mornings with a commute to learn from.</p>`;
    const best = P.best ? `${COMP[P.best] || P.best} tracks your good days best (ρ ${P.rho[P.best].toFixed(2)}), so it counts most` : "No marker stands out yet, so the weights stay close to the defaults";
    return `<p class="sub mt-3">Weighted for you: ${esc(best)}. Learned from ${P.days} mornings against your commute's speed per heartbeat.</p>`;
  }

  // tonight's lights-out, worked back from tomorrow's wake time and sleep need (fitness/build.py _bedtime)
  function bedBlock() {
    const B = now.bedtime;
    if (!B) return "";
    return `<p class="tonight"><span class="label">Tonight</span> Lights out by <b>${esc(B.bed)}</b>: up around ${esc(B.wake)}${B.ride_in ? " for the ride in" : ""}, ${B.need} h of sleep and 15 min to fall asleep${B.reasons.length ? `; earlier for ${esc(B.reasons.join(" and "))}` : ""}.</p>`;
  }

  // tomorrow in a line, so the Today tab carries the next step too (the full week is on Plan)
  function tomorrowLine() {
    const t = plan && plan.days[1];
    if (!t) return "";
    const w = t.wx ? ` · ${sky(t.wx.code)} ${deg(t.wx.hi)}${t.wx.pop >= 30 ? ` ${t.wx.pop}%` : ""}` : "";
    return `<p class="tomorrow"><span class="label">Tomorrow</span> <b>${esc(t.title)}</b>${t.minutes ? ` · ${dur(t.minutes * 60)}` : ""}${w} <a href="#plan" data-tab="plan">The week →</a></p>`;
  }
  // the day's eating in a line, with the meals one tap away on Fuel
  function fuelLine() {
    const T = D.fuel && D.fuel.today;
    if (!T) return "";
    return `<p class="fuel-line"><span class="label">Fuel · ${esc(T.label)}</span> ${T.carbs_g ? `${T.carbs_g} g carbs · ${T.protein_g} g protein` : `${T.carbs_per_kg} g carbs per kg`} <a href="#fuel" data-tab="fuel">Meals →</a></p>`;
  }

  // the tabs: Today, Plan, Fuel, Body, Ride. A bar at the bottom on a phone (where the thumb is), along the top on a
  // wide screen. Every old section link (#season, #bike…) still lands on the right tab, and the tab survives a reload.
  const TABS = [["today", "Today"], ["plan", "Plan"], ["fuel", "Fuel"], ["body", "Body"], ["ride", "Ride"]];
  const HOME = { today: "today", plan: "plan", week: "plan", race: "plan", season: "plan", fuel: "fuel", kitchen: "fuel", body: "body", numbers: "body",
    load: "body", sleep: "body", recovery: "body", insights: "body", device: "body", "phone-app": "body", ride: "ride", training: "ride", bike: "ride" };
  const ss = { get(k) { try { return sessionStorage.getItem(k); } catch { return null; } }, set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } } };
  function tabs() {
    const nav = document.getElementById("tabs");
    if (!nav) return;
    const due = (D.bike && D.bike.items || []).some(i => i.status === "due");
    const changed = !!((plan && plan.adjustments) || []).length;
    const dot = { plan: changed ? "the plan changed" : "", ride: due ? "a bike job is due" : "", body: now.readiness && now.readiness.illness ? "illness watch" : "" };
    nav.hidden = false;
    nav.innerHTML = `<div class="tabs-in" role="tablist">${TABS.map(([id, label]) => `<button type="button" role="tab" id="tab-${id}" aria-controls="panel-${id}" data-tab="${id}">${label}${dot[id] ? `<i class="dot" title="${esc(dot[id])}"></i><span class="sr"> (${esc(dot[id])})</span>` : ""}</button>`).join("")}</div>`;
    const hash = location.hash.slice(1);
    show(HOME[hash] || (TABS.some(t => t[0] === ss.get("fitness-tab")) ? ss.get("fitness-tab") : "today"), HOME[hash] && hash !== HOME[hash] ? hash : "");
  }
  /** @type {Record<string, string>} */
  const pending = {};   // panels rebuilt off screen by a Today-only render, put in place when their tab is shown
  function show(id, anchor = "") {
    const fresh = pending[id] != null && document.getElementById(`panel-${id}`);
    if (fresh) { fresh.innerHTML = pending[id]; delete pending[id]; charts(); }
    for (const [t] of TABS) {
      const on = t === id, b = document.getElementById(`tab-${t}`), pnl = document.getElementById(`panel-${t}`);
      if (b) { b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; }
      if (pnl) pnl.hidden = !on;
    }
    ss.set("fitness-tab", id);
    const hash = anchor || (id === "today" ? "" : id);              // Today is home: a clean address
    if (location.hash.slice(1) !== hash) history.replaceState(null, "", `${location.pathname}${location.search}${hash ? `#${hash}` : ""}`);
    const el = anchor && document.getElementById(anchor);
    if (el) el.scrollIntoView({ block: "start" }); else window.scrollTo(0, 0);
  }
  document.addEventListener("click", e => {
    const t = e.target instanceof Element ? e.target.closest("[data-tab]") : null;
    if (!t) return;
    e.preventDefault();
    show(/** @type {HTMLElement} */ (t).dataset.tab || "today");
    if (t.getAttribute("role") === "tab") /** @type {HTMLElement} */ (t).focus();
  });
  document.addEventListener("keydown", e => {   // arrow keys move along the tab bar, as a tab list should
    const t = e.target instanceof Element ? e.target.closest("[role=tab]") : null;
    if (!t || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const i = TABS.findIndex(([id]) => id === /** @type {HTMLElement} */ (t).dataset.tab);
    const j = e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
    e.preventDefault();
    show(TABS[j][0]);
    document.getElementById(`tab-${TABS[j][0]}`).focus();
  });
  window.addEventListener("hashchange", () => {
    const h = location.hash.slice(1);
    if (HOME[h]) show(HOME[h], h !== HOME[h] ? h : "");
  });

  // the call above is only as good as last night's data: say when the watch hasn't handed it over yet
  function overnightBlock() {
    if (now.last_night || D.today !== isoToday()) return "";
    const sync = document.querySelector("[data-action=sync]") ? ` <button type="button" class="chip" data-action="sync">Sync now</button>` : "";
    return `<p class="overnight"><span class="label">Last night isn't in yet</span> Open Garmin Connect so the watch syncs its sleep, then sync here; the call above uses yesterday's numbers until then.${sync}</p>`;
  }

  // a day's forecast in the week list: sky, high / low, and the rain chance when it matters
  const wxChip = w => w ? `<span class="wx" aria-label="${esc(`${SKY(w.code)}, high ${deg(w.hi)}, low ${deg(w.lo)}${w.pop >= 30 ? `, ${w.pop}% chance of rain` : ""}`)}"><span aria-hidden="true">${sky(w.code)} ${deg(w.hi)}/${deg(w.lo)}${w.pop >= 30 ? ` ${w.pop}%` : ""}</span></span>` : "";

  // today's weather: the commute legs (from the call), or the best window to ride, what to wear and lights
  function weatherBlock() {
    const W = now.weather;
    if (!W) return "";
    const rows = [];
    if (W.commute) {
      if (W.commute.in) rows.push(["Ride in", W.commute.in]);
      if (W.commute.home) rows.push(["Ride home", W.commute.home]);
    } else if (W.ride) {
      rows.push([`Best window · ${W.ride.when}`, W.ride.line]);
      if (W.ride.advice) rows.push(["", W.ride.advice]);
    }
    const kit = (W.commute && W.commute.kit) || (W.ride && W.ride.kit);
    const extra = [(W.commute && W.commute.lights) || (W.ride && W.ride.lights), W.commute && W.commute.wind].filter(Boolean);
    return `<div class="weather"><span class="label">Weather · ${esc(W.summary)}</span>
      ${rows.length ? `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : ""}
      ${kit ? `<p><b>Wear:</b> ${esc(kit)}</p>` : ""}${extra.map(x => `<p>${esc(x)}</p>`).join("")}</div>`;
  }

  // the next seven days at a glance: tap a day for the session and its Plan B (it reshuffles at each sync)
  function weekBlock() {
    if (!plan) return "";
    const week = plan.days.slice(0, 7);
    const hours = week.reduce((a, d) => a + (d.minutes || 0), 0) / 60, commutes = week.filter(d => d.commute).length, lifts = week.filter(d => d.strength).length;
    return `<div class="week-ahead"><span class="label">The next 7 days · ${hours.toFixed(1)} h${commutes ? ` · ${commutes} commute${commutes === 1 ? "" : "s"}` : ""}${lifts ? ` · ${lifts} strength` : ""}</span>
      <ol>${week.map((d, i) => `<li class="${esc(d.level)}${i === 0 ? " today" : ""}"><details><summary><span class="dow">${i === 0 ? "Today" : DOW[asDate(d.date).getDay()]}</span><i aria-hidden="true"></i><span class="sr">${esc(LEVEL[d.level] || d.level)}: </span>
        <span class="what"><b>${esc(d.title)}</b>${d.minutes ? ` · ${dur(d.minutes * 60)}` : ""}${d.strength ? " · + strength" : ""}</span>${wxChip(d.wx)}</summary>
        <p class="sub">${esc(d.session)}</p>${d.strength ? `<p class="sub"><b>+ ${esc(d.strength.title)} · ${d.strength.minutes} min:</b> ${esc(d.strength.detail)}</p>` : ""}${d.alt ? `<p class="sub"><b>Plan B:</b> ${esc(d.alt)}</p>` : ""}${d.indoor && d.steps && d.steps.length ? `<p><button type="button" class="chip" data-zwo="${esc(d.date)}">Zwift / MyWoosh file (.zwo)</button></p>` : ""}</details></li>`).join("")}</ol>
      <p class="sub">Rebuilt at every sync from what you actually rode, slept and recovered: a missed day moves, a good week grows.</p></div>`;
  }

  // what the plan did about sessions that didn't happen this week (fitness/plan.py adapt)
  function adjustedBlock() {
    const notes = (plan && plan.adjustments) || (D.plan && D.plan.adjustments);   // a race-option variant carries the same week
    if (!notes || !notes.length) return "";
    return `<div class="adjusted"><span class="label">Plan adjusted</span><ul>${notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul></div>`;
  }

  // what to eat today, around the Blueprint meals and the riding (fitness/fuel.py), and tomorrow's in a fold
  function mealsHTML(day) {
    return `<dl class="meals">${day.meals.map(m => `<dt>${esc(m.slot)}</dt><dd>${esc(m.what)}${m.base ? `<span class="base">${esc(m.base)}</span>` : ""}<span class="sub">${esc(m.why)}</span></dd>`).join("")}</dl>`;
  }
  function fuelBlock(full = false) {
    const F = D.fuel;
    if (!F || !F.today) return "";
    const T = F.today, N = F.tomorrow;
    const k = n => Math.round(n).toLocaleString();
    const energy = T.kcal && T.burn ? ` That's about <b>${k(T.kcal)} kcal</b>, all meals and snacks together; today burns roughly ${k(T.burn.total)} (${k(T.burn.base)} living${T.burn.ride ? ` + ${k(T.burn.ride)} riding` : ""}).` : "";
    const targets = T.carbs_g ? `About <b>${T.carbs_g} g carbs</b> and <b>${T.protein_g} g protein</b> today (${Math.round(T.carbs_g / F.weight_kg * 10) / 10} and ${T.protein_per_kg} g per kg at ${F.weight_kg} kg).${energy}`
      : `About ${T.carbs_per_kg} g carbs and ${T.protein_per_kg} g protein per kg of body weight today (add your weight in Garmin Connect for grams).`;
    const W = D.weight, kg = v => units === "mi" ? `${(v * 2.20462).toFixed(1)} lb` : `${v.toFixed(1)} kg`;
    const weight = W ? `<p class="sub">Weight trend <b>${kg(W.kg)}</b>${W.change_4w != null ? ` (${W.change_4w > 0 ? "+" : W.change_4w < 0 ? "−" : "±"}${kg(Math.abs(W.change_4w))} over 4 weeks)` : ""}, from ${W.count} Garmin weigh-in${W.count === 1 ? "" : "s"}, the last ${fmtD(W.last)}. The targets follow it.</p>`
      : `<p class="sub">Weigh in now and then (Garmin Connect → Health Stats → Weight, or a Garmin Index scale) and the targets follow your trend instead of the profile's one number.</p>`;
    return `<div class="fuel"><span class="label">Fuel · ${esc(T.label)}</span>
      <p class="sub">${targets}</p>${weight}
      ${mealsHTML(T)}
      ${N ? `<details class="fuel-next"><summary>Tomorrow · ${esc(N.label)}</summary>${mealsHTML(N)}</details>` : ""}
      ${full ? nutrientsHTML(T.nutrients) : ""}
      ${kitchenHTML(F.kitchen, full)}</div>`;
  }

  // beyond carbs and protein: what today's meals bring against the day's needs, and what food can't (fitness/nutrients.py)
  function nutrientsHTML(Nu) {
    if (!Nu) return "";
    const tag = { ok: "good", near: "", low: "bad" }, word = { ok: "covered", near: "close: dinner adds more", low: "short" };
    const num = (v, u) => `${v.toLocaleString()} ${u}`;
    return `<h3 class="mt-6">Nutrients · today</h3>
      <p class="sub">The Nutty Pudding and Super Veggie worked out ingredient by ingredient, plus the yogurt and gap fillers, against the Dietary Reference Intakes for your age${Nu.vegetarian ? " (iron and zinc raised for a vegetarian diet, which absorbs less of both)" : ""}. Dinner comes on top: beans, tofu and potatoes add zinc, potassium, magnesium and iron.</p>
      <div class="scrollx" tabindex="0" role="region" aria-label="Nutrients today"><table class="tbl nutrients"><thead><tr><th>Nutrient</th><th class="r">Need</th><th class="r hide-sm">Pudding + Veggie</th><th class="r hide-sm">+ fillers</th><th class="r">Today</th></tr></thead><tbody>
      ${Nu.rows.map(r => `<tr><td>${esc(r.label)}</td><td class="r num">${num(r.need, r.unit)}</td><td class="r num hide-sm">${num(r.core, r.unit)}</td><td class="r num hide-sm">${r.fillers ? `+${num(r.fillers, r.unit)}` : "—"}${r.supplement ? ` +${num(r.supplement, r.unit)} supp.` : ""}</td><td class="r"><span class="tag ${tag[r.status]}" title="${esc(word[r.status])}">${r.pct}%</span></td></tr>`).join("")}
      </tbody></table></div>
      ${Nu.advice.length ? `<h4 class="mt-3">What food can't cover</h4><ul class="plain advice-list">${Nu.advice.map(a => `<li><b>${esc(a.name)}</b> · ${esc(a.dose)}<span class="sub">${esc(a.why)}</span></li>`).join("")}</ul>
      <p class="sub">Already taking something? List it under <code>[nutrition.supplements]</code> in the config (<code>vitamin_d_iu</code>, <code>epa_dha_mg</code>, <code>b12_ug</code>…) and it counts here instead.</p>` : ""}`;
  }
  const pToday0 = () => plan && plan.days[0];

  function commuteHTML() {
    const c = D.commute;
    if (!c) return "";
    const L = c.legs, sp = kph => speed(kph);
    const trend = c.ef_trend_pct == null ? "" : c.ef_trend_pct >= 1.5 ? `Your last six commutes are <b>${c.ef_trend_pct}% more efficient</b> than the ones before: more speed for the same heartbeats, which is aerobic fitness arriving.`
      : c.ef_trend_pct <= -3 ? `Your last six commutes are <b>${Math.abs(c.ef_trend_pct)}% less efficient</b> than usual. Wind does that for a ride or two; for a week, it's fatigue: check the recovery markers.`
      : "Commute efficiency is steady.";
    return `<h3 class="mt-6">Bike commute</h3>
      <div class="kpis"><span>This year <b>${Math.round(c.year.legs / 2)}</b> round trips · <b>${dist(c.year.km * 1000)}</b> · <b>${c.year.hours} h</b></span><span>Last 8 weeks <b>${c.per_week_8}</b> a week</span>
        <span>In <b>${L.in.minutes} min</b> at ${sp(L.in.speed)}${L.in.hr ? `, ${L.in.hr} bpm` : ""}</span><span>Home <b>${L.home.minutes} min</b> at ${sp(L.home.speed)}${L.home.hr ? `, ${L.home.hr} bpm` : ""}</span></div>
      ${c.series.length >= 6 ? `<p class="sub">Same route, same terrain: speed per heartbeat on it is a free fitness test every commute. ${trend}</p><div id="c-commute" class="mt-3"></div>` : `<p class="empty">Efficiency tracking starts after a handful of commutes with heart rate.</p>`}`;
  }

  // inside the rides: decoupling on the long steady rides, and this week's hard sessions against their targets
  function insideHTML() {
    const R = D.rides;
    if (!R) return "";
    const L = R.latest;
    return `<h3 class="mt-6">Inside the rides</h3>
      ${L ? `<p>Aerobic decoupling on ${fmtD(L.date)}'s ${dur(L.minutes * 60)} ride: <b>${L.pct.toFixed(1)}%</b>, ${esc(L.verdict)}.</p>
        <p class="sub">How much more heart rate the second half cost for the same ${L.by === "power" ? "power" : "speed"}. Under 5% over a ride as long as the race is the goal${L.by === "speed" ? "; outdoors, wind and hills blur a single ride, so watch the trend" : ""}.</p>` : ""}
      ${R.decoupling.length > 1 ? `<div class="scrollx" tabindex="0" role="region" aria-label="Decoupling by ride"><table class="tbl"><thead><tr><th>Ride</th><th class="r">Length</th><th class="r">Decoupling</th><th class="hide-sm">From</th></tr></thead><tbody>
        ${R.decoupling.slice().reverse().map(x => `<tr><td>${fmtD(x.date)} · ${esc(x.name)}</td><td class="r">${dur(x.minutes * 60)}</td><td class="r num">${x.pct.toFixed(1)}%</td><td class="hide-sm">${x.by}${x.indoor ? ", trainer" : ""}</td></tr>`).join("")}</tbody></table></div>` : ""}
      ${R.sessions.length ? `<h4 class="mt-3">This week's hard sessions</h4><ul class="plain">${R.sessions.map(x => `<li><b>${fmtDow(x.date)}</b> ${esc(x.title)}: ${x.actual} of ${x.expected} planned minutes at ${x.bpm}+ bpm <span class="tag ${x.pct >= 80 ? "good" : x.pct < 60 ? "bad" : ""}">${x.pct}%</span></li>`).join("")}</ul>` : ""}
      ${R.hint ? `<p class="warn-line">${esc(R.hint)}</p>` : ""}`;
  }

  // a trainer session as a Zwift workout file (.zwo, also what MyWoosh imports): power as a fraction of FTP per zone
  const ZWO_POWER = { z1: 0.5, z2: 0.68, tempo: 0.83, race: 0.88, ss: 0.9, thr: 0.97, z5: 1.12, max: 1.25 };
  const xml = t => String(t ?? "").replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
  function zwo(day) {
    const body = day.steps.map(st => {
      const secs = Math.max(1, Math.round(st.min * 60)), cue = st.cue ? `<textevent timeoffset="0" message="${xml(st.name + ": " + st.cue)}"/>` : `<textevent timeoffset="0" message="${xml(st.name)}"/>`;
      if (/warm/i.test(st.name)) return `    <Warmup Duration="${secs}" PowerLow="0.45" PowerHigh="0.68">${cue}</Warmup>`;
      if (/cool/i.test(st.name)) return `    <Cooldown Duration="${secs}" PowerLow="0.65" PowerHigh="0.45">${cue}</Cooldown>`;
      return `    <SteadyState Duration="${secs}" Power="${ZWO_POWER[st.zone] ?? 0.65}">${cue}</SteadyState>`;
    }).join("\n");
    return `<workout_file>\n  <author>Training &amp; Recovery</author>\n  <name>${xml(day.title)} ${xml(day.date)}</name>\n  <description>${xml(day.session)}</description>\n  <sportType>bike</sportType>\n  <tags/>\n  <workout>\n${body}\n  </workout>\n</workout_file>\n`;
  }
  document.addEventListener("click", e => {
    const b = e.target instanceof Element ? e.target.closest("[data-zwo]") : null;
    const day = b && plan && plan.days.find(d => d.date === /** @type {HTMLElement} */ (b).dataset.zwo);
    if (!day) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([zwo(day)], { type: "application/xml" }));
    a.download = `${day.date}-${day.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.zwo`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  // the week's shopping and prep for the Blueprint meals (fitness/grocery.py)
  function kitchenHTML(K, open = false) {
    if (!K) return "";
    const list = rows => `<ul class="plain shop">${rows.map(r => `<li><span>${esc(r.item)}</span><b>${esc(r.amount)}</b></li>`).join("")}</ul>`;
    return `<details class="fuel-next kitchen"${open ? " open" : ""}><summary>Shopping &amp; prep · ${fmtDow(K.from)} – ${fmtDow(K.to)}</summary>
      <p class="sub">${K.pudding} Nutty Pudding${K.pudding === 1 ? "" : "s"} (${K.pudding_days.join(", ")}) and ${K.veggie} Super Veggie${K.veggie === 1 ? "" : "s"} (${K.veggie_days.join(", ")})${K.chicken ? ", with chicken" : ""}: the fuel plan's next seven days.</p>
      <h3>Buy</h3>${list(K.buy)}
      <h3>Check you have</h3>${list(K.check)}
      <h3>Prep</h3><ul class="plain">${K.prep.map(x => `<li>${esc(x)}</li>`).join("")}</ul></details>`;
  }

  // how the plan is fitted to the riding you actually do (fitness/plan.py fit, from the last 12 weeks)
  function fitHTML() {
    const F = D.fit;
    if (!F || !F.habits) return "";
    const H = F.habits, names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const week = plan.days.slice(0, 7), roleOn = i => week.find(d => asDate(d.date).getDay() === (i + 1) % 7);
    return `<h3 class="mt-6">Fitted to your riding</h3>
      <p class="sub">From your last ${H.weeks} weeks, commutes included: a usual week of ${H.hours.median} h (busy weeks ${H.hours.p75} h), long rides around ${dur(H.long_min.median * 60)}.</p>
      <ul class="fit-notes">${F.notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul>
      <div class="scrollx" tabindex="0" role="region" aria-label="Your week, ridden and planned"><table class="tbl fit"><thead><tr><th>Day</th><th class="r">You ride</th><th class="r">Usually</th><th>Next 7 days</th></tr></thead><tbody>
        ${H.days.map((h, i) => { const d = roleOn(i); return `<tr><td>${names[i]}</td><td class="r">${Math.round(h.p * 100)}%</td><td class="r">${h.minutes ? dur(h.minutes * 60) : "—"}</td>
          <td>${d ? `${esc(d.title)}${d.minutes ? ` · ${dur(d.minutes * 60)}` : ""}` : "—"}</td></tr>`; }).join("")}
      </tbody></table></div>`;
  }

  // race day: the morning, the start, the bottles, the bike the week before, what to pack (fitness/raceday.py)
  function raceHTML() {
    const R = D.race_day || [];
    if (!R.length) return "";
    const one = (r, i) => `<article class="race-day">
      <div class="head"><h3>${esc(r.name)} · ${esc(r.label)}</h3><span class="sub">${fmtDow(r.date)}${r.start_set ? ` · ${r.wave ? `wave ${r.wave}, ` : ""}${esc(r.start)}` : ""} · ${r.days_out === 0 ? "today" : `${r.days_out} day${r.days_out === 1 ? "" : "s"} to go`}</span></div>
      <div class="grid">
        <div><h4>Race morning</h4><dl class="timeline">${r.timeline.map(t => `<dt class="num">${esc(t.at)}</dt><dd>${esc(t.what)}</dd>`).join("")}</dl>
          ${r.start_set ? "" : `<p class="sub">Timed from a 10:00 start: set your wave's start time in config.toml (start = "HH:MM", wave = N).</p>`}</div>
        <div><h4>The start</h4><p>${esc(r.strategy)}</p>
          <h4>Fuel</h4><p>${esc(r.fuel.setup)}.</p><p>${esc(r.fuel.sips[0].toUpperCase() + r.fuel.sips.slice(1))}${r.fuel.top_up ? `, plus ${r.fuel.top_up} g an hour from gels or chews` : ""}: about ${r.fuel.rate} g of carbs and ${r.fuel.sodium} mg of sodium an hour.</p>
          ${r.fuel.climate ? `<p>${esc(r.fuel.climate)}</p>` : ""}
          ${r.fuel.no_refill ? `<p class="sub">${esc(r.fuel.no_refill)}</p>` : ""}
          ${r.conditions ? "" : r.forecast ? `<h4>Forecast at home</h4><p>${esc(r.forecast.line)}.</p><p><b>Wear:</b> ${esc(r.forecast.kit)}. ${esc(r.forecast.warm)}</p>` : `<p class="sub">The race-morning forecast appears 16 days out.</p>`}</div>
        <div><h4>The bike, the week before</h4><ul class="checks">${r.bike.map(b => `<li class="${b.ok ? "ok" : ""}"><span><span class="sr">${b.ok ? "Done: " : "To do: "}</span>${esc(b.job)}${b.note ? ` <span class="sub">${esc(b.note)}</span>` : ""}</span></li>`).join("")}</ul>
          <h4>Pack</h4><ul class="checks">${r.pack.map(x => `<li><span>${esc(x)}</span></li>`).join("")}</ul>
          <h4>Between now and the start</h4>${r.sessions_left.length ? `<ul class="plain">${r.sessions_left.map(x => `<li><b>${fmtDow(x.date)}</b> ${esc(x.title)}</li>`).join("")}</ul>` : `<p class="sub">No hard sessions left: it's all freshening up now.</p>`}
          <p class="sub">Taper: ${r.taper.days} days, arriving at form ${signed(r.taper.race_tsb)} (target ${r.taper.target_tsb[0]} to ${r.taper.target_tsb[1]}).</p></div>
      </div>${courseHTML(r, i)}${conditionsHTML(r)}</article>`;
    return `<section id="race" class="card"><div class="head"><h2>Race day</h2><span class="sub">${R.length === 1 ? esc(R[0].name) : `${R.length} races in the next six weeks`}</span></div>${R.map(one).join("")}</section>`;
  }

  // the course from the organizer's GPX: its profile with the hills shaded, what it asks, the clock at each third, and
  // every hill with the effort it takes (fitness/course.py, raceday.course_plan); the profile is drawn in charts()
  function courseHTML(r, i) {
    const c = r.course;
    if (!c) return "";
    return `<section class="course" aria-label="${esc(r.name)} course">
      <h3 class="mt-6">The course: ${esc(c.distance)} · ${esc(c.climbing)} up · ${c.kicks} rise${c.kicks === 1 ? "" : "s"}, ${c.climbs} climb${c.climbs === 1 ? "" : "s"}</h3>
      ${c.profile.length ? `<div id="c-course-${i}"></div>` : ""}
      <ul class="checks">${c.notes.map(n => `<li><span>${esc(n)}</span></li>`).join("")}</ul>
      ${c.checkpoints.length ? `<h4>On the clock</h4><dl class="timeline">${c.checkpoints.map(k => `<dt class="num">${esc(k.at)}</dt><dd>${esc(k.clock)} <span class="sub">(${esc(k.elapsed)} in)</span></dd>`).join("")}</dl>` : ""}
      ${c.hills.length ? `<details class="table hills"><summary>The ${c.hills.length} hills, and how to ride each</summary><div class="scroll" tabindex="0" role="region" aria-label="${esc(r.name)} hills"><table class="tbl"><thead><tr><th>Where</th><th class="r">Long</th><th class="r">Up</th><th class="r">Grade</th><th class="r">Time</th><th>How</th></tr></thead><tbody>
        ${c.hills.map(h => `<tr><td class="nowrap">${esc(h.at)}<br><span class="sub">${esc(h.to_go)} to go</span></td><td class="r">${esc(h.len)}</td><td class="r">${esc(h.gain)}</td><td class="r">${h.grade}%<br><span class="sub">max ${h.max_grade}%</span></td><td class="r">~${dur(h.minutes * 60)}</td><td class="sub">${esc(h.how)}</td></tr>`).join("")}</tbody></table></div></details>` : ""}
    </section>`;
  }

  // the race's weather where you'll ride it, what it asks of you and the bike, and every other case (fitness/racewx.py)
  function conditionsHTML(r) {
    const C = r.conditions, list = xs => xs.length ? `<ul class="checks">${xs.map(x => `<li><span>${esc(x)}</span></li>`).join("")}</ul>` : "";
    const part = (h, xs) => xs.length ? `<h4>${h}</h4>${list(xs)}` : "";
    const caseHTML = c => `<details class="case${c.picked ? " picked" : ""}"${c.picked ? " open" : ""}><summary><b>${esc(c.label)}</b>${c.picked ? ` <span class="tag warn">This forecast</span>` : ""}
        <span class="sub">${esc(c.when)}${c.psi ? ` Tires ${c.psi > 0 ? "+" : ""}${c.psi} psi.` : ""}</span></summary>
        ${part("Wear", c.wear)}${part("Bike", c.bike)}${part("Ride", c.ride)}${part("Fuel", c.fuel)}</details>`;
    const top = C ? `<h4>${C.where === "venue" ? "Weather at the course" : "Weather at home (the course forecast isn't in yet)"}</h4>
        <dl class="timeline">${C.windows.pre ? `<dt>Warm-up</dt><dd>${esc(C.windows.pre)}</dd>` : ""}
          <dt>Racing</dt><dd>${esc(C.windows.race)} <span class="sub">(${esc(r.start)}–${esc(r.finish)}, timed from ${esc(r.expected.from)})</span></dd>
          ${C.windows.finish ? `<dt>Finish</dt><dd>${esc(C.windows.finish)}</dd>` : ""}</dl>
        <p>${esc(C.trail.line)}.</p>
        <div class="grid">
          <div>${part("Wear", C.wear)}</div>
          <div>${part("Bike", C.bike)}</div>
          <div>${part("Ride", C.ride)}${part("Fuel", C.fuel)}</div>
        </div>` : `<p class="sub">Race time: about ${esc(r.start)}–${esc(r.finish)}, from ${esc(r.expected.from)}. The forecast-specific plan appears 16 days out; until then, every case is below.</p>`;
    return `<section class="conditions" aria-label="${esc(r.name)} conditions"><h3 class="mt-6">Conditions${C ? `: ${esc(r.playbook.filter(c => c.picked).map(c => c.label.toLowerCase()).join(", "))}` : ""}</h3>${top}
      <details class="table"><summary>Every case on the ${esc((D.bike && D.bike.name) || "bike")} (${r.playbook.length})</summary><div class="cases">${r.playbook.map(caseHTML).join("")}</div></details></section>`;
  }

  // the bike: what's due, Silca's pressures, and "Done" to log a job (fitness/bike.py)
  function bikeHTML() {
    const B = D.bike;
    if (!B) return "";
    const tag = s => s === "due" ? `<span class="tag bad">Due</span>` : s === "soon" ? `<span class="tag warn">Soon</span>` : `<span class="tag good">OK</span>`;
    const P = B.pressure || {}, S = B.surfaces || {};
    return `<section id="bike" class="card"><div class="head"><h2>Bike</h2><span class="sub">${esc(B.name)}</span></div>
      ${B.parts ? `<p class="sub">${esc(B.parts)}</p>` : ""}
      <ul class="upkeep">${B.items.map(i => `<li class="${esc(i.status)}"><div class="row"><b>${esc(i.job)}</b>${tag(i.status)}</div>
        <span class="track" aria-hidden="true"><span class="fill" style="display:block;width:${Math.max(2, Math.min(100, i.pct * 100))}%"></span></span>
        <span class="sub">${esc(i.used)}${i.why ? ` · due now after ${esc(i.why)}` : ""}${i.done ? ` · last done ${fmtD(i.done)}` : ` · counting since ${fmtD(i.counting_since)}`}</span>
        <span class="sub how">${esc(i.how)}</span>
        <button type="button" class="chip needs-cloud" data-action="service" data-code="${esc(i.key)}" data-label="${esc(i.job)}" aria-label="Done: ${esc(i.job)}">Done</button></li>`).join("")}</ul>
      <h3 class="mt-6">Tire pressure · Silca</h3>
      ${(B.pressure_notes || []).map(n => `<p class="warn-line">${esc(n)}</p>`).join("")}
      ${Object.keys(P).length ? `<div class="scrollx" tabindex="0" role="region" aria-label="Tire pressures"><table class="tbl"><thead><tr><th>For</th><th class="r">Front</th><th class="r">Rear</th><th>Set</th></tr></thead><tbody>
        ${Object.entries(P).map(([k, v]) => `<tr><td>${esc(S[k] || k)}</td><td class="r num">${v.front} psi</td><td class="r num">${v.rear} psi</td><td>${fmtD(v.at)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="sub">No pressures yet: run Silca's calculator for each surface and add them here.</p>`}
      <p class="sub">In Silca's calculator: total weight ${B.silca.system_lb ? `<b>${units === "mi" ? `${B.silca.system_lb} lb` : `${B.silca.system_kg} kg`}</b> (you, the bike and two full bottles and tools)` : "you + the bike + bottles"}${B.silca.tire ? `; tire ${esc(B.silca.tire)}` : ""}${B.silca.rim ? `; rim ${esc(B.silca.rim)}` : ""}.</p>
      <form class="pressure needs-cloud" data-form="pressure">
        <div class="wide"><label for="p-where" class="label">For</label><select id="p-where">${Object.entries(S).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("")}</select></div>
        <div><label for="p-front" class="label">Front psi</label><input id="p-front" inputmode="decimal" pattern="[0-9.]*" required></div>
        <div><label for="p-rear" class="label">Rear psi</label><input id="p-rear" inputmode="decimal" pattern="[0-9.]*" required></div>
        <button type="submit" class="chip primary">Save</button></form>
    </section>`;
  }

  function seasonHTML() {
    if (!plan) return `<section id="season" class="card"><div class="head"><h2>Season</h2></div><p class="empty">Add a race under [[races]] in fitness/config.toml to get a plan.</p></section>`;
    const first = plan.races[0], raceIdx = plan.days.findIndex(d => d.phase === "race");
    const shown = plan.days.slice(0, first.days_out <= 21 ? raceIdx + 1 : 14);
    return `<section id="season" class="card">
      <div class="head"><h2>Season</h2><span class="sub">${plan.races.length} race${plan.races.length === 1 ? "" : "s"} · plan through ${fmtD(plan.races[plan.races.length - 1].date)}, ${plan.races[plan.races.length - 1].date.slice(0, 4)}</span></div>
      <div class="grid">${plan.races.map(raceCard).join("")}</div>
      ${fitHTML()}
      <h3 class="mt-6">${shown.length > 14 ? `Every day to ${esc(shortName(first.name))}` : "Next two weeks"}</h3>
      <div class="scrollx" tabindex="0" role="region" aria-label="Day by day plan"><table class="tbl plan"><thead><tr><th>Day</th><th>Session</th><th class="r">Time</th><th class="r hide-sm">TSS</th><th class="r">Form</th></tr></thead><tbody>
        ${shown.map((d, i) => `<tr class="${i === 0 ? "today" : ""} ${d.phase === "race" ? "race" : ""}"><td class="num nowrap">${fmtDow(d.date)}${chipFor(d, shown[i - 1])}${d.commute ? `${chipFor(d, shown[i - 1]) ? "" : "<br>"}<span class="phase commute">commute</span>` : ""}</td>
          <td><b>${esc(d.title)}</b><br><span class="sub">${esc(d.session)}</span></td><td class="r">${d.minutes ? dur(d.minutes * 60) : "—"}</td><td class="r hide-sm">${d.load || "—"}</td><td class="r">${signed(d.tsb)}</td></tr>`).join("")}
      </tbody></table></div>
      <p class="sub mt-3">Readiness can only make a day easier: on a red morning take the easy option and the plan recalculates from what you actually did at the next build.</p>
      <h3 class="mt-6">Projected fitness</h3><div id="c-season"></div>
      <details class="table" open><summary>Week by week</summary><div class="scroll tall" tabindex="0" role="region" aria-label="Week by week"><table class="tbl"><thead><tr><th>Week of</th><th>Phase</th><th class="r">Hours</th><th class="r hide-sm">TSS</th><th class="hide-sm">Key days</th><th class="r">Fitness</th></tr></thead><tbody>
        ${plan.weeks.map(w => `<tr class="${w.race ? "race" : ""}"><td class="num nowrap">${fmtD(w.week)}</td><td class="nowrap"><span class="phase ${w.phase}">${esc(w.phase)}</span>${w.indoor ? ' <span class="phase indoor">trainer</span>' : ""}${w.recovery_week ? ' <span class="phase recovery">easy week</span>' : ""}</td>
          <td class="r">${w.hours}</td><td class="r hide-sm">${r0(w.load)}</td><td class="sub hide-sm">${w.race ? `<b>${esc(w.race)}</b> · ` : ""}${esc([...new Set(w.keys.filter(k => !k.startsWith("Race day")))].join(", ")) || "—"}${w.commutes ? ` · ${w.commutes} commute${w.commutes === 1 ? "" : "s"}` : ""}</td><td class="r">${r0(w.ctl)}</td></tr>`).join("")}
      </tbody></table></div></details>
    </section>`;
  }

  /** Builds the page. A tap on Today (the check-in, a ride rating) rebuilds only Today and leaves the other tabs to be
   *  rebuilt when they're opened: no chart is redrawn for a tap. @param {"all" | "today"} [scope] */
  function render(scope = "all") {
    const rd = now.readiness, sl = now.sleep, pToday = plan && plan.days[0], rec = feelCall(todayCall(pToday), pToday), next = plan && plan.races[0];
    const last7 = D.readiness.slice(-8, -1).map(r => r.score);
    const rAvg = mean(last7);
    const B = blended(), score = B && B.score != null ? B.score : rd ? rd.score : null;   // with this morning's check-in in it
    const readinessTile = tile("Readiness", score ?? "—", "/100", B && B.feel != null ? `watch ${rd ? rd.score : "—"} · feel ${B.feel}` : rAvg != null && rd ? `${signed(rd.score - rAvg)} vs 7-day avg` : "needs 14 nights", score != null ? (score >= 60 ? "good" : "bad") : "", score != null && rAvg != null ? (score - rAvg >= 0.5 ? "up" : score - rAvg <= -0.5 ? "down" : "") : "");
    const F = felt();
    const feelReason = [...(B && B.why ? [{ tone: rec.eased ? "bad" : "good", text: `Check-in: ${B.why}` }] : []),
      ...(F.drift && F.drift >= 1.2 ? [{ tone: "bad", dir: "up", text: `Your last 3 rides felt ${Math.round((F.drift - 1) * 100)}% harder than their heart-rate load usually does: fatigue building before it shows overnight` }] : [])];
    const sleepTile = tile("Sleep score", sl ? sl.score : "—", "", sl ? `${esc(sl.label)} · ${hrs(sl.hours)}` : "no sleep logged", sl ? (sl.score >= 80 ? "good" : sl.score < 60 ? "bad" : "") : "");

    // today: the call and everything that bears on it, on one screen
    const todaySec = `<section id="today" class="hero" aria-labelledby="today-h"><h2 class="sr" id="today-h">Today</h2>
      <div class="card call">
        <span class="sub">Today · ${fmtDow(D.today)}${next ? ` · ${esc(shortName(next.name))} in ${next.days_out} day${next.days_out === 1 ? "" : "s"}` : ""}${pToday && pToday.indoor ? " · trainer season" : ""}</span>
        <span class="badge ${esc(rec.level)}"><i></i>${esc(LEVEL[rec.level] || rec.level)}</span>
        <div class="title">${esc(rec.title)}</div>
        <p class="detail">${esc(rec.detail)}</p>
        ${adjustedBlock()}
        ${pToday && pToday.done ? `<p class="sub">Already logged today: ${pToday.done} TSS of ${pToday.load} planned.</p>` : ""}
        ${rd || feelReason.length ? `<ul class="reasons">${[...feelReason, ...(rd ? rd.reasons : [])].map(r => `<li class="${r.tone === "bad" ? "bad" : ""} ${r.dir || ""}">${esc(r.text)}</li>`).join("")}</ul>` : ""}
        ${checkinBlock()}
        ${rpeBlock()}
        ${strengthLine(pToday, rec)}
        ${planB(pToday, rec, rd)}
        ${overnightBlock()}
        ${weatherBlock()}
        ${bedBlock()}
        ${commuteBlock()}
        ${rd && rd.illness ? `<p class="sub"><b>Illness watch:</b> elevated resting HR plus breathing rate or overnight stress is the classic early sign of a cold. Rest beats a workout here.</p>` : ""}
        ${tomorrowLine()}
      </div>
      <div class="card">
        <div class="tiles four">
          ${readinessTile}
          ${sleepTile}
          ${tile("Form (TSB)", signed(form.tsb), "", esc(formWord(form.tsb)))}
          ${tile("Fitness (CTL)", r0(form.ctl), "", form.ramp != null ? `${signed(form.ramp)} this week` : "")}
        </div>
        ${fuelLine()}
      </div>
    </section>`;

    const phone = D.phone_href || D.ride_qr ? `<section class="card" id="phone-app"><div class="head"><h2>Phone app</h2></div>
        ${D.phone_href || D.ride_qr ? `<details class="phone" open><summary>Phone app</summary>
          <div class="phone-in">
            ${D.phone_href ? `<p>The whole dashboard, in the app on your phone: <button type="button" class="chip" data-copy="phone">Copy phone link</button> <button type="button" class="chip" data-save="1">Save data file</button></p>
            <p class="sub">Send the link to yourself (AirDrop, Messages, email) and paste it under <b>Import data</b> in the app, or put the file in iCloud Drive / Google Drive and pick it there. It carries this build's numbers after the <b>#</b>, which never reaches the server; the app keeps them on the phone, offline.</p>` : ""}
            ${D.ride_qr ? `<div class="qr"><div class="qrimg"><img src="${esc(D.ride_qr)}" alt="QR code that opens ride mode with this week's sessions"></div>
            <p class="sub"><b>Just ride mode:</b> scan this with the phone on your bars, or <button type="button" class="chip" data-copy="ride">copy the ride link</button>. It opens ride mode with your HR zones and the next 7 days of sessions.</p></div>` : ""}
          </div></details>` : ""}</section>` : "";

    // body: every number, what went into readiness, then sleep, recovery, load and insights below
    const bodyTop = `<section id="numbers" class="card"><div class="head"><h2>Readiness &amp; load</h2><span class="sub">this morning</span></div>
        <div class="tiles">
          ${readinessTile}
          ${sleepTile}
          ${tile("Form (TSB)", signed(form.tsb), "", esc(formWord(form.tsb)))}
          ${tile("Fitness (CTL)", r0(form.ctl), "", form.ramp != null ? `${signed(form.ramp)} this week` : "")}
          ${tile("Fatigue (ATL)", r0(form.atl), "", form.acwr != null ? `ACWR ${form.acwr.toFixed(2)}${form.acwr > 1.3 ? " · spike" : form.acwr < 0.8 ? " · detraining" : " · sweet spot"}` : "")}
          ${tile("Sleep debt", now.sleep_debt == null ? "—" : now.sleep_debt.toFixed(1), "h", `last 7 nights vs ${D.need_hours} h need`, now.sleep_debt != null ? (now.sleep_debt > 3 ? "bad" : "good") : "")}
        </div>
        ${rd ? `<h3 class="mt-6">What went into readiness</h3>${meters(rd.components, COMP)}<p class="sub mt-3">Each bar is that marker's score out of 100, where 75 is your normal; today's actual reading is beside its name.</p>${personalNote()}` : ""}
    </section>`;

    // load
    const load = (`<section id="load" class="card"><div class="head"><h2>Fitness, fatigue &amp; form</h2><span class="sub">last ${D.pmc.length} days${next ? ` + plan to ${esc(shortName(next.name))}` : ""}</span></div>
      <div id="c-pmc"></div><h3 class="mt-6">Form (TSB)</h3><div id="c-tsb"></div></section>`);

    // sleep
    const s30 = D.sleep.slice(-30);
    const scored = s30.filter(s => s.score != null);
    const beds = scored.filter(s => s.start).map(s => { const d = new Date(s.start); return (d.getHours() * 60 + d.getMinutes() + 720) % 1440; });
    const bedAvg = mean(beds);
    const bedTxt = bedAvg == null ? "—" : (() => { const mm = (Math.round(bedAvg) + 720) % 1440; const h = Math.floor(mm / 60); return `${(h % 12) || 12}:${String(mm % 60).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`; })();
    const garminNights = D.sleep.filter(s => s.garmin_score != null).length;
    const sleepSec = (`<section id="sleep" class="card"><div class="head"><h2>Sleep</h2><span class="sub">scored here from stages, duration, wake-ups and overnight stress</span></div>
      <div class="kpis"><span>30-night average <b>${r0(mean(scored.map(s => s.score)))}</b></span><span>Duration <b>${hrs(mean(scored.map(s => s.hours)))}</b></span>
        <span>Typical bedtime <b>${bedTxt}</b></span><span>Regularity <b>±${now.regularity_min ?? "—"} min</b></span>
        <span>Garmin-scored nights <b>${garminNights}</b></span></div>
      <div class="grid"><div><h3>Sleep score</h3><div id="c-sleep"></div></div><div><h3>Stages, last 30 nights</h3><div id="c-stages"></div></div></div>
      ${sl ? `<h3 class="mt-6">Last night · ${fmtTime(now.last_night && now.last_night.start)} – ${fmtTime(now.last_night && now.last_night.end)}</h3>${meters(sl.parts, SLEEP_PARTS)}` : ""}
    </section>`);

    // recovery
    const recovery = (`<section id="recovery" class="card"><div class="head"><h2>Recovery markers</h2><span class="sub">shaded: your 60-day normal (mean ± 1 SD)</span></div>
      <div class="grid four">${Object.keys(D.markers).map(k => `<div><h3>${esc(D.markers[k].label)}</h3><div id="c-m-${k}"></div></div>`).join("")}</div>
      <h3 class="mt-6">Readiness</h3><div id="c-ready"></div></section>`);

    // training
    const z = D.zones;
    const zt = z ? z.seconds.reduce((a, b) => a + b, 0) : 0;
    const zp = z ? z.seconds.map(s => s / zt * 100) : [];
    const training = (`<section id="training" class="card"><div class="head"><h2>Training</h2><span class="sub">${D.ytd.rides} rides this year · ${D.ytd.hours} h · ${dist(D.ytd.km * 1000)} · ${elev(D.ytd.elev_m)}</span></div>
      ${D.indoor ? `<div class="kpis"><span>Trainer season ${fmtD(D.indoor.start)} – ${fmtD(D.indoor.end)}${D.indoor.current ? " (on now)" : ""}: <b>${D.indoor.rides}</b> rides · <b>${D.indoor.hours} h</b>${D.indoor.avg_np ? ` · avg NP <b>${D.indoor.avg_np} W</b>` : ""}${D.indoor.ftp_start && D.indoor.ftp_end ? ` · best-effort FTP <b>${D.indoor.ftp_start} → ${D.indoor.ftp_end} W</b>` : ""}${D.indoor.outdoor_rides ? ` · ${D.indoor.outdoor_rides} outdoor` : ""}</span></div>` : ""}
      ${D.strength ? `<div class="kpis"><span>Strength: <b>${D.strength.per_week_8}</b> a week over the last 8 weeks · <b>${D.strength.done.length}</b> this week${D.strength.ahead.length ? `, ${D.strength.ahead.length} still planned` : ""}</span><span class="muted">The plan asks for 2 a week in the trainer base and 1 in the build; log them on the watch as Strength.</span></div>` : ""}
      <div class="grid"><div><h3>Weekly hours</h3><div id="c-weeks"></div></div>
      <div><h3>Heart-rate zones, last ${z ? z.days : 28} days</h3>${z ? `<div class="zones" role="img" aria-label="Time in zones">${zp.map((p, i) => `<div style="flex:${p};background:var(--z${i + 1})" title="Zone ${i + 1}: ${p.toFixed(0)}%"></div>`).join("")}</div>
        <div class="zones-key">${zp.map((p, i) => `<span><b><i class="sw" style="background:var(--z${i + 1})"></i>Z${i + 1}</b>${p.toFixed(0)}%<br>${dur(z.seconds[i])}</span>`).join("")}</div>
        <p class="sub mt-3">${zp[0] + zp[1] >= 75 ? "Mostly easy, with the hard work concentrated: a polarized/pyramidal mix that suits a 2-hour race." : zp[2] > 25 ? "A lot of Zone 3: the 'grey zone' tires you without the stimulus of real intervals. Make easy days easier." : "A balanced mix."}</p>` : `<p class="empty">Time in zones comes from Garmin-recorded activities.</p>`}</div></div>
      ${powerHTML()}
      ${ratedHTML()}
      ${commuteHTML()}
      ${insideHTML()}
      <h3 class="mt-6">Recent activities</h3><div class="scrollx" tabindex="0" role="region" aria-label="Recent activities"><table class="tbl"><thead><tr><th>When</th><th>Activity</th><th class="r">Time</th><th class="r">Distance</th><th class="r hide-sm">Climb</th><th class="r hide-sm">Avg HR</th><th class="r">TSS</th></tr></thead><tbody>
      ${D.recent.map(a => `<tr><td class="num">${fmtD(a.start)}</td><td>${esc(a.name)}<br><span class="sub">${esc(a.kind.replace(/_/g, " "))}${a.offroad ? " · off-road" : ""}${a.indoor ? " · trainer" : ""}${a.commute ? ` · commute ${a.leg === "home" ? "home" : "in"}` : ""}${ratings()[a.id] ? ` · RPE ${ratings()[a.id]}` : ""}</span></td><td class="r">${dur(a.moving_s)}</td><td class="r">${a.distance_m ? dist(a.distance_m) : "—"}</td><td class="r hide-sm">${a.elev_m ? elev(a.elev_m) : "—"}</td><td class="r hide-sm">${r0(a.avg_hr)}</td><td class="r" title="from ${esc(a.load_src)}">${r0(a.load)}${a.load_src === "duration" ? "*" : ""}</td></tr>`).join("")}
      </tbody></table></div>${D.recent.some(a => a.load_src === "duration") ? `<p class="sub mt-3">* No heart rate: load estimated from duration.</p>` : ""}</section>`);

    // insights
    const insights = (`<section id="insights" class="card"><div class="head"><h2>What your data says</h2><span class="sub">rank correlations over your own history</span></div>
      ${D.insights.length ? `<ul class="insights">${D.insights.map(i => `<li>${esc(i.text)}</li>`).join("")}</ul>` : `<p class="empty">Nothing clears the bar yet: an insight needs 30+ paired days and a real effect (|ρ| ≥ 0.2).</p>`}</section>`);

    // data
    const th = D.athlete;
    const device = (`<section id="device" class="card"><div class="head"><h2>What the Venu Sq gives you</h2><span class="sub">last 30 days of data actually received</span></div>
      <div class="scrollx" tabindex="0" role="region" aria-label="Signals received"><table class="tbl"><thead><tr><th>Signal</th><th class="r">Days</th><th>Hardware</th><th>Note</th></tr></thead><tbody>
      ${D.coverage.map(c => `<tr><td>${esc(c.field)}</td><td class="r">${c.days}/${c.of}</td><td>${esc(c.device)}</td><td class="sub">${esc(c.note)}</td></tr>`).join("")}</tbody></table></div>
      <div class="kpis mt-4"><span>Max HR <b>${th.max_hr}</b></span><span>Resting HR <b>${r0(th.rest_hr)}</b></span><span>LTHR <b>${th.lthr}</b></span><span>FTP <b>${th.ftp || "—"}</b></span>
      ${th.estimated.length ? `<span class="muted">${esc(listOf(th.estimated.map(k => ({ max_hr: "max HR", resting_hr: "resting HR", lthr: "LTHR", ftp: "FTP" })[k] || k)))} estimated from your data; set ${th.estimated.length === 1 ? "it" : "them"} in fitness/config.toml</span>` : ""}</div>
      <p class="sub">${D.counts.days} days of wellness, ${D.counts.activities} activities since ${fmtD(D.counts.first)}, ${D.counts.first.slice(0, 4)}. Built ${esc(D.generated.replace("T", " "))}.</p></section>`);

    // five tabs: the day at a glance, then the plan, food, body and riding, each one tap away
    const panels = {
      today: todaySec,
      plan: `<section id="week" class="card"><div class="head"><h2>This week</h2></div>${adjustedBlock()}${weekBlock()}</section>${raceHTML()}${seasonHTML()}`,
      fuel: `<section id="fuel" class="card"><div class="head"><h2>Fuel</h2></div>${fuelBlock(true) || `<p class="empty">The fuel plan needs the season plan (a race in config.toml).</p>`}</section>`,
      body: bodyTop + load + sleepSec + recovery + insights + device + phone,
      ride: `<section id="ride-mode" class="card ride-cta"><div class="head"><h2>Ride</h2></div><p><a class="chip big-chip primary" href="${esc(D.ride_href || "ride.html")}">Open ride mode</a> <span class="sub">Live heart rate, today's session as timed steps, the weather on your line.</span></p></section>`
        + training + bikeHTML(),
    };
    if (scope === "today" && document.getElementById("panel-today")) {
      document.getElementById("panel-today").innerHTML = panels.today;
      for (const [id, inner] of Object.entries(panels)) if (id !== "today") pending[id] = inner;
      return;
    }
    for (const id of Object.keys(pending)) delete pending[id];
    app.innerHTML = Object.entries(panels).map(([id, inner]) => `<div class="panel" id="panel-${id}" role="tabpanel" aria-labelledby="tab-${id}" tabindex="-1">${inner}</div>`).join("");
    tabs();
    document.getElementById("foot").innerHTML = `<p><b>How the numbers work.</b> TSS from power (when an FTP is set), else heart-rate TSS (Banister TRIMP, 1 h at threshold HR = 100), else a duration estimate. Fitness/fatigue are 42/7-day exponentially weighted load; form is yesterday's fitness minus fatigue. Readiness compares last night's resting HR, overnight stress (the Venu Sq's HRV-derived signal), Body Battery and breathing rate with your own 60-day normal, blends in the sleep score, and takes points off for deep fatigue or a load spike.</p>
      <p>This is a personal analysis tool, not medical advice. Private data: keep this page off the public web.</p>`;
    charts();
  }

  function charts() {
    // PMC with projection to the next race
    const next = plan && plan.races[0];
    const hist = D.pmc, firstRace = plan ? plan.days.findIndex(d => d.phase === "race") : -1;
    const future = plan ? plan.days.slice(1, firstRace + 1) : [];
    const x = hist.map(r => r.date).concat(future.map(d => d.date));
    const todayIdx = hist.length - 1;
    const proj = (key) => hist.map(r => r[key]).concat(future.map(d => d[key]));
    const marks = [{ at: todayIdx, label: "today" }];
    if (next) marks.push({ at: x.length - 1, label: shortName(next.name) });
    const tooltipPlan = i => { const p = i > todayIdx ? future[i - todayIdx - 1] : null; return p ? [["Planned", `${p.title} · ${p.load || 0} TSS`]] : []; };
    chart(document.getElementById("c-pmc"), {
      label: "Daily training load with fitness and fatigue", x, height: 260, marks, dashFrom: plan ? todayIdx : null, extra: tooltipPlan,
      series: [
        { name: "Daily load (TSS)", type: "bar", color: "var(--load)", values: hist.map(r => r.load).concat(future.map(() => null)) },
        { name: "Fitness (CTL)", type: "line", color: "var(--s1)", values: proj("ctl"), endDot: true },
        { name: "Fatigue (ATL)", type: "line", color: "var(--s2)", values: proj("atl") },
      ],
    });
    chart(document.getElementById("c-tsb"), {
      label: "Form, training stress balance", x, height: 170, marks, zero: true, dashFrom: plan ? todayIdx : null, extra: tooltipPlan,
      ref: next ? { lo: next.target_tsb[0], hi: next.target_tsb[1], from: Math.max(0, x.length - 15), label: "race-day target", color: "var(--s3)" } : null,
      series: [{ name: "Form (TSB)", type: "line", color: "var(--s1)", values: proj("tsb"), fmt: signed }],
    });

    // the season: 60 days behind, every planned day ahead, trainer windows shaded
    if (plan) {
      const back = hist.slice(-60), ahead = plan.days.slice(1);
      const sx = back.map(r => r.date).concat(ahead.map(d => d.date));
      const now0 = back.length - 1;
      const xb = [];
      ahead.forEach((d, i) => {
        const at = now0 + 1 + i, last = xb[xb.length - 1];
        if (d.indoor) { if (last && last.to === at - 1) last.to = at; else xb.push({ from: at, to: at, label: "trainer", color: "var(--ink)" }); }
      });
      const smarks = [{ at: now0, label: "today" }].concat(plan.races.map(r => ({ at: sx.indexOf(r.date), label: shortName(r.name) })));
      const sp = key => back.map(r => r[key]).concat(ahead.map(d => d[key]));
      chart(document.getElementById("c-season"), {
        label: "Projected fitness and fatigue through the season", x: sx, height: 240, marks: smarks, xbands: xb, dashFrom: now0,
        extra: i => { const d = i > now0 ? ahead[i - now0 - 1] : null; return d ? [["Phase", d.phase + (d.indoor ? " · trainer" : "")], ["Planned", `${d.title} · ${d.load || 0} TSS`]] : []; },
        series: [
          { name: "Fitness (CTL)", type: "line", color: "var(--s1)", values: sp("ctl") },
          { name: "Fatigue (ATL)", type: "line", color: "var(--s2)", values: sp("atl") },
        ],
      });
    }


    // each race's course profile, the hills shaded (fitness/course.py)
    (D.race_day || []).forEach((r, i) => {
      const c = r.course, P = c && c.profile;
      if (!P || P.length < 2) return;
      const mi = units === "mi", along = km => (mi ? km / 1.609344 : km), up = m => Math.round(mi ? m * 3.28084 : m);
      const near = km => P.reduce((b, p, j) => (Math.abs(p[0] - km) < Math.abs(P[b][0] - km) ? j : b), 0);
      const hillAt = j => c.hills.find(h => P[j][0] >= h.start_km && P[j][0] <= h.end_km);
      chart(document.getElementById(`c-course-${i}`), {
        label: `${r.name}: the course's profile, ${c.distance} with ${c.climbing} of climbing`, x: P.map(p => p[0]), height: 180, xName: mi ? "Mile" : "Km",
        xFmt: km => `${Math.round(along(km))} ${units}`, tipFmt: km => `${units} ${along(km).toFixed(1)}`, yFmt: v => `${v.toLocaleString()} ${mi ? "ft" : "m"}`,
        xbands: c.hills.map(h => ({ from: near(h.start_km), to: Math.max(near(h.start_km), near(h.end_km) - 1), label: "", color: "var(--s2)" })),
        extra: j => { const h = hillAt(j); return h ? [["Hill", `${h.gain} at ${h.grade}%, max ${h.max_grade}%`], ["Ride it", h.how.split(":")[0]]] : []; },
        series: [{ name: mi ? "Height (ft)" : "Height (m)", type: "line", color: "var(--s1)", values: P.map(p => up(p[1])), fmt: v => `${v.toLocaleString()} ${mi ? "ft" : "m"}` }],
      });
    });

    // sleep
    const S = D.sleep, sx = S.map(s => s.date);
    const avg7 = S.map((s, i) => { const w = S.slice(Math.max(0, i - 6), i + 1).map(r => r.score).filter(v => v != null); return w.length >= 4 ? Math.round(mean(w)) : null; });
    chart(document.getElementById("c-sleep"), {
      label: "Nightly sleep score", x: sx, height: 200, yMin: 0, yMax: 100,
      extra: i => S[i].hours != null ? [["Asleep", hrs(S[i].hours)], ...(S[i].garmin_score != null ? [["Garmin score", String(S[i].garmin_score)]] : [])] : [],
      series: [
        { name: "Sleep score", type: "bar", color: "var(--s1)", values: S.map(s => s.score) },
        { name: "7-night average", type: "line", color: "var(--s2)", values: avg7 },
      ],
    });
    const s30 = S.slice(-30);
    chart(document.getElementById("c-stages"), {
      label: "Sleep stages per night, hours", x: s30.map(s => s.date), height: 200, yFmt: v => `${v}h`,
      series: [
        { name: "Deep", type: "bar", stack: true, color: "var(--s1)", values: s30.map(s => s.deep), fmt: hrs },
        { name: "REM", type: "bar", stack: true, color: "var(--s2)", values: s30.map(s => s.rem), fmt: hrs },
        { name: "Light", type: "bar", stack: true, color: "var(--s3)", values: s30.map(s => s.light), fmt: hrs },
        { name: "Awake", type: "bar", stack: true, color: "var(--s4)", values: s30.map(s => s.awake), fmt: hrs },
      ],
    });

    // recovery markers
    for (const [k, mk] of Object.entries(D.markers)) {
      const ser = mk.series, fmt = v => v == null ? "—" : `${(+v).toFixed(k === "resp" ? 1 : 0)}${mk.unit ? " " + mk.unit : ""}`;
      chart(document.getElementById(`c-m-${k}`), {
        label: `${mk.label} with normal range`, x: ser.map(r => r.date), height: 150,
        band: { name: "Your normal", color: "var(--ink)", lo: ser.map(r => r.mean != null ? r.mean - r.sd : null), hi: ser.map(r => r.mean != null ? r.mean + r.sd : null), fmt },
        series: [{ name: mk.label, type: "line", color: "var(--s1)", values: ser.map(r => r.v), fmt, endDot: true, hideLegend: true }],
        yFmt: v => (k === "resp" ? v.toFixed(1) : String(Math.round(v))),
      });
    }
    const mine = checkins(), feltLine = D.readiness.map(r => feelScore(mine[r.date]));   // this phone's check-ins, on the same scale
    chart(document.getElementById("c-ready"), {
      label: "Readiness score", x: D.readiness.map(r => r.date), height: 170, yMin: 0, yMax: 100,
      ref: { lo: 75, hi: 100, label: "key-session zone", color: "var(--s3)" },
      series: [{ name: "Readiness", type: "line", color: "var(--s1)", values: D.readiness.map(r => r.score), endDot: true },
        ...(feltLine.some(v => v != null) ? [{ name: "How you felt", type: "line", color: "var(--s2)", values: feltLine, endDot: true }] : [])],
    });

    if (D.power && document.getElementById("c-power")) {
      const P = D.power;
      chart(document.getElementById("c-power"), {
        label: "Power-duration curve: best average power for each duration", x: P.durations, height: 200, xName: "Duration",
        xFmt: durLabel, tipFmt: durLabel, yFmt: v => `${v}`,
        extra: i => P.year_when[i] ? [["Year's best on", fmtD(P.year_when[i])]] : [],
        series: [
          { name: "Last 6 weeks (W)", type: "line", color: "var(--s1)", values: P.recent, endDot: true },
          { name: "Best of the year", type: "line", color: "var(--s3)", values: P.year },
        ],
      });
    }

    // weekly hours
    const W = D.weeks;
    chart(document.getElementById("c-weeks"), {
      label: "Weekly training hours by sport", x: W.map(w => w.week), height: 220, xName: "Week of", tipFmt: iso => `Week of ${fmtD(iso)}`,
      extra: i => [["Distance", dist(W[i].km * 1000)], ["Climbing", elev(W[i].elev_m)], ["Load", `${r0(W[i].load)} TSS`]],
      series: [
        { name: "Ride", type: "bar", stack: true, color: "var(--s1)", values: W.map(w => w.ride), fmt: hrs },
        { name: "Commute", type: "bar", stack: true, color: "var(--s2)", values: W.map(w => w.commute), fmt: hrs },
        { name: "Trainer", type: "bar", stack: true, color: "var(--s3)", values: W.map(w => w.indoor), fmt: hrs },
        { name: "Other", type: "bar", stack: true, color: "var(--s4)", values: W.map(w => w.other), fmt: hrs },
      ],
    });

    // commute efficiency: speed per 100 bpm, rolling median of each leg's last five
    const C = D.commute;
    if (C && C.series.length >= 6 && document.getElementById("c-commute")) {
      const dates = [...new Set(C.series.map(r => r.date))];
      const roll = leg => dates.map(dt => {
        const prior = C.series.filter(r => r.leg === leg && r.date <= dt).slice(-5).map(r => r.ef);
        if (prior.length < 3) return null;
        const v = prior.slice().sort((a, b) => a - b)[Math.floor(prior.length / 2)];
        return units === "mi" ? +(v / 1.609344).toFixed(2) : v;
      });
      chart(document.getElementById("c-commute"), {
        label: "Commute efficiency, speed per 100 heartbeats per minute", x: dates, height: 180, xName: "Commute",
        yFmt: v => v.toFixed(1),
        series: [
          { name: `Ride in (${units === "mi" ? "mph" : "km/h"} per 100 bpm)`, type: "line", color: "var(--s1)", values: roll("in"), fmt: v => v.toFixed(2), endDot: true },
          { name: "Ride home", type: "line", color: "var(--s2)", values: roll("home"), fmt: v => v.toFixed(2), endDot: true },
        ],
      });
    }
  }

  // ── controls ────────────────────────────────────────────────────────────────────────────────────────────
  const unitBtns = [...document.querySelectorAll("[data-units]")];
  const paintUnits = () => unitBtns.forEach(b => b.setAttribute("aria-pressed", String(b.dataset.units === units)));
  for (const b of unitBtns) b.addEventListener("click", () => {
    if (b.dataset.units === units) return;
    units = b.dataset.units; ls.set("fitness-units", units); paintUnits();
    const y = window.scrollY; render(); window.scrollTo(0, y);
  });
  paintUnits();
  if (D.ride_href) { const rl = document.getElementById("ride-link"); rl.href = D.ride_href; rl.hidden = false; }
  app.addEventListener("click", e => {
    const btn = e.target instanceof Element ? e.target.closest("[data-copy], [data-save]") : null;
    if (!btn) return;
    if (btn.dataset.save) {   // the data file, for iCloud Drive / Google Drive → Import on the phone
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify({ ...D, ride_qr: null, phone_href: null })], { type: "application/json" }));
      a.download = `fitness-data-${D.today}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return;
    }
    const text = btn.dataset.copy === "phone" ? D.phone_href : D.ride_href;
    navigator.clipboard.writeText(text).then(() => { btn.textContent = "Copied"; }, () => { btn.textContent = "Copy failed"; });
  });
  app.addEventListener("click", e => {
    const b = e.target instanceof Element ? e.target.closest("button.opt") : null;
    if (!b) return;
    ls.set(`fitness-option:${b.dataset.race}`, b.dataset.opt);
    plan = activePlan();
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  });
  render();
};
