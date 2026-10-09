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
  const fmtD = iso => { const d = asDate(iso); return `${MON[d.getMonth()]} ${d.getDate()}`; };
  const fmtDow = iso => { const d = asDate(iso); return `${DOW[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()}`; };
  const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
  const dur = s => { const m = Math.round((s || 0) / 60); return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${m} min`; };
  const hrs = h => h == null ? "—" : `${Math.floor(h)}h${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
  const dist = m => { const v = units === "mi" ? m / 1609.344 : m / 1000; return `${v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1)} ${units}`; };
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
    if (day.commute && c) return { level: { skip: "rest", easy: "easy", optional: "easy" }[c.verdict] || day.level, title: c.title, detail: c.detail };   // same rule as the build
    if (ORDER.includes(base.level) && ORDER.indexOf(base.level) < ORDER.indexOf(day.level)) return { ...base, detail: `Planned: ${day.session}. Readiness says scale it back — ${base.detail.charAt(0).toLowerCase()}${base.detail.slice(1)}` };
    const m = day.minutes || 0;
    return { level: day.level, title: day.title, detail: day.session + (m >= 60 ? ` — about ${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : m ? ` — about ${m} min` : "") };
  };
  const shortName = name => name.replace(/^Bell's /, "").replace(/ Cometh Challenge$/, "");
  const LEVEL = { hard: "Go hard", moderate: "Train", easy: "Easy", rest: "Rest", unknown: "Waiting for data" };
  const formWord = t => t == null ? "" : t > 15 ? "very fresh" : t > 5 ? "fresh" : t > -10 ? "neutral" : t > -30 ? "productive fatigue" : "overreaching";
  const tile = (k, v, unit, d, tone) => `<div class="tile"><span class="k">${esc(k)}</span><span class="v num">${v}${unit ? `<small>${esc(unit)}</small>` : ""}</span><span class="d">${tone ? `<span class="tag ${tone}">${tone === "good" ? "▲" : "▼"}</span> ` : ""}${d}</span></div>`;
  const COMP = { sleep: "Sleep score", rhr: "Resting HR", sleep_stress: "Overnight stress", bb_wake: "Body Battery at wake", resp: "Respiration" };
  const SLEEP_PARTS = { duration: "Duration", deep: "Deep sleep", rem: "REM sleep", continuity: "Continuity", calm: "Overnight calm" };
  const meters = (obj, names) => `<div class="meters">${Object.entries(obj).map(([k, v]) => `<div class="meter"><span>${esc(names[k] || k)}</span><span class="track"><span class="fill" style="display:block;width:${Math.max(2, v)}%"></span></span><b class="num">${v}</b></div>`).join("")}</div>`;

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
    const mark = { ride: "▲", easy: "■", optional: "□", skip: "▼" }[c.verdict] || "■";
    return `<div class="commute-call ${esc(c.verdict)}"><span class="label">Bike commute</span>
      ${headline ? "" : `<p><b>${mark} ${esc(c.title)}.</b> ${esc(c.detail)}</p>`}
      ${c.fuel ? `<p class="sub">${esc(c.fuel)}</p>` : ""}</div>`;
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

  function seasonHTML() {
    if (!plan) return `<section id="season" class="card"><div class="head"><h2>Season</h2></div><p class="empty">Add a race under [[races]] in fitness/config.toml to get a plan.</p></section>`;
    const first = plan.races[0], raceIdx = plan.days.findIndex(d => d.phase === "race");
    const shown = plan.days.slice(0, first.days_out <= 21 ? raceIdx + 1 : 14);
    return `<section id="season" class="card">
      <div class="head"><h2>Season</h2><span class="sub">${plan.races.length} race${plan.races.length === 1 ? "" : "s"} · plan through ${fmtD(plan.races[plan.races.length - 1].date)}, ${plan.races[plan.races.length - 1].date.slice(0, 4)}</span></div>
      <div class="grid">${plan.races.map(raceCard).join("")}</div>
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

  function render() {
    const rd = now.readiness, sl = now.sleep, pToday = plan && plan.days[0], rec = todayCall(pToday), next = plan && plan.races[0];
    const last7 = D.readiness.slice(-8, -1).map(r => r.score);
    const rAvg = mean(last7);
    const html = [];

    // today
    html.push(`<section id="today" class="hero" aria-labelledby="today-h"><h2 class="sr" id="today-h">Today</h2>
      <div class="card call">
        <span class="sub">Today · ${fmtDow(D.today)}${next ? ` · ${esc(shortName(next.name))} in ${next.days_out} day${next.days_out === 1 ? "" : "s"}` : ""}${pToday && pToday.indoor ? " · trainer season" : ""}</span>
        <span class="badge ${esc(rec.level)}"><i></i>${esc(LEVEL[rec.level] || rec.level)}</span>
        <div class="title">${esc(rec.title)}</div>
        <p class="detail">${esc(rec.detail)}</p>
        ${pToday && pToday.done ? `<p class="sub">Already logged today: ${pToday.done} TSS of ${pToday.load} planned.</p>` : ""}
        ${rd ? `<ul class="reasons">${rd.reasons.map(r => `<li class="${r.tone === "bad" ? "bad" : ""}">${esc(r.text)}</li>`).join("")}</ul>` : ""}
        ${plan ? `<p class="sub">Next: ${plan.days.slice(1, 4).map(d => `<b>${DOW[asDate(d.date).getDay()]}</b> ${esc(d.title.toLowerCase())}${d.minutes ? ` ${dur(d.minutes * 60)}` : ""}`).join(" · ")}</p>` : ""}
        ${commuteBlock()}
        ${D.phone_href || D.ride_qr ? `<details class="phone"><summary>Phone app</summary>
          <div class="phone-in">
            ${D.phone_href ? `<p>The whole dashboard, in the app on your phone: <button type="button" class="chip" data-copy="phone">Copy phone link</button> <button type="button" class="chip" data-save="1">Save data file</button></p>
            <p class="sub">Send the link to yourself (AirDrop, Messages, email) and paste it under <b>Import data</b> in the app, or put the file in iCloud Drive / Google Drive and pick it there. It carries this build's numbers after the <b>#</b>, which never reaches the server; the app keeps them on the phone, offline.</p>` : ""}
            ${D.ride_qr ? `<div class="qr"><div class="qrimg" role="img" aria-label="QR code that opens ride mode with this week's sessions">${D.ride_qr}</div>
            <p class="sub"><b>Just ride mode:</b> scan this with the phone on your bars, or <button type="button" class="chip" data-copy="ride">copy the ride link</button>. It opens ride mode with your HR zones and the next 7 days of sessions.</p></div>` : ""}
          </div></details>` : ""}
        ${rd && rd.illness ? `<p class="sub"><b>Illness watch:</b> elevated resting HR plus breathing rate or overnight stress is the classic early sign of a cold. Rest beats a workout here.</p>` : ""}
      </div>
      <div class="card">
        <div class="tiles">
          ${tile("Readiness", rd ? rd.score : "—", "/100", rAvg != null && rd ? `${signed(rd.score - rAvg)} vs 7-day avg` : "needs 14 nights", rd ? (rd.score >= 60 ? "good" : "bad") : "")}
          ${tile("Sleep score", sl ? sl.score : "—", "", sl ? `${esc(sl.label)} · ${hrs(sl.hours)}` : "no sleep logged", sl ? (sl.score >= 80 ? "good" : sl.score < 60 ? "bad" : "") : "")}
          ${tile("Form (TSB)", signed(form.tsb), "", esc(formWord(form.tsb)))}
          ${tile("Fitness (CTL)", r0(form.ctl), "", form.ramp != null ? `${signed(form.ramp)} this week` : "")}
          ${tile("Fatigue (ATL)", r0(form.atl), "", form.acwr != null ? `ACWR ${form.acwr.toFixed(2)}${form.acwr > 1.3 ? " · spike" : form.acwr < 0.8 ? " · detraining" : " · sweet spot"}` : "")}
          ${tile("Sleep debt", now.sleep_debt == null ? "—" : now.sleep_debt.toFixed(1), "h", `last 7 nights vs ${D.need_hours} h need`, now.sleep_debt != null ? (now.sleep_debt > 3 ? "bad" : "good") : "")}
        </div>
        ${rd ? `<h3 class="mt-6">What went into readiness</h3>${meters(rd.components, COMP)}` : ""}
      </div>
    </section>`);

    // season
    html.push(seasonHTML());


    // load
    html.push(`<section id="load" class="card"><div class="head"><h2>Fitness, fatigue &amp; form</h2><span class="sub">last ${D.pmc.length} days${next ? ` + plan to ${esc(shortName(next.name))}` : ""}</span></div>
      <div id="c-pmc"></div><h3 class="mt-6">Form (TSB)</h3><div id="c-tsb"></div></section>`);

    // sleep
    const s30 = D.sleep.slice(-30);
    const scored = s30.filter(s => s.score != null);
    const beds = scored.filter(s => s.start).map(s => { const d = new Date(s.start); return (d.getHours() * 60 + d.getMinutes() + 720) % 1440; });
    const bedAvg = mean(beds);
    const bedTxt = bedAvg == null ? "—" : (() => { const mm = (Math.round(bedAvg) + 720) % 1440; const h = Math.floor(mm / 60); return `${(h % 12) || 12}:${String(mm % 60).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`; })();
    const garminNights = D.sleep.filter(s => s.garmin_score != null).length;
    html.push(`<section id="sleep" class="card"><div class="head"><h2>Sleep</h2><span class="sub">scored here from stages, duration, wake-ups and overnight stress</span></div>
      <div class="kpis"><span>30-night average <b>${r0(mean(scored.map(s => s.score)))}</b></span><span>Duration <b>${hrs(mean(scored.map(s => s.hours)))}</b></span>
        <span>Typical bedtime <b>${bedTxt}</b></span><span>Regularity <b>±${now.regularity_min ?? "—"} min</b></span>
        <span>Garmin-scored nights <b>${garminNights}</b></span></div>
      <div class="grid"><div><h3>Sleep score</h3><div id="c-sleep"></div></div><div><h3>Stages, last 30 nights</h3><div id="c-stages"></div></div></div>
      ${sl ? `<h3 class="mt-6">Last night · ${fmtTime(now.last_night && now.last_night.start)} – ${fmtTime(now.last_night && now.last_night.end)}</h3>${meters(sl.parts, SLEEP_PARTS)}` : ""}
    </section>`);

    // recovery
    html.push(`<section id="recovery" class="card"><div class="head"><h2>Recovery markers</h2><span class="sub">shaded: your 60-day normal (mean ± 1 SD)</span></div>
      <div class="grid four">${Object.keys(D.markers).map(k => `<div><h3>${esc(D.markers[k].label)}</h3><div id="c-m-${k}"></div></div>`).join("")}</div>
      <h3 class="mt-6">Readiness</h3><div id="c-ready"></div></section>`);

    // training
    const z = D.zones;
    const zt = z ? z.seconds.reduce((a, b) => a + b, 0) : 0;
    const zp = z ? z.seconds.map(s => s / zt * 100) : [];
    html.push(`<section id="training" class="card"><div class="head"><h2>Training</h2><span class="sub">${D.ytd.rides} rides this year · ${D.ytd.hours} h · ${dist(D.ytd.km * 1000)} · ${elev(D.ytd.elev_m)}</span></div>
      ${D.indoor ? `<div class="kpis"><span>Trainer season ${fmtD(D.indoor.start)} – ${fmtD(D.indoor.end)}${D.indoor.current ? " (on now)" : ""}: <b>${D.indoor.rides}</b> rides · <b>${D.indoor.hours} h</b>${D.indoor.avg_np ? ` · avg NP <b>${D.indoor.avg_np} W</b>` : ""}${D.indoor.ftp_start && D.indoor.ftp_end ? ` · best-effort FTP <b>${D.indoor.ftp_start} → ${D.indoor.ftp_end} W</b>` : ""}${D.indoor.outdoor_rides ? ` · ${D.indoor.outdoor_rides} outdoor` : ""}</span></div>` : ""}
      <div class="grid"><div><h3>Weekly hours</h3><div id="c-weeks"></div></div>
      <div><h3>Heart-rate zones, last ${z ? z.days : 28} days</h3>${z ? `<div class="zones" role="img" aria-label="Time in zones">${zp.map((p, i) => `<div style="flex:${p};background:var(--z${i + 1})" title="Zone ${i + 1}: ${p.toFixed(0)}%"></div>`).join("")}</div>
        <div class="zones-key">${zp.map((p, i) => `<span><b><i class="sw" style="background:var(--z${i + 1})"></i>Z${i + 1}</b>${p.toFixed(0)}%<br>${dur(z.seconds[i])}</span>`).join("")}</div>
        <p class="sub mt-3">${zp[0] + zp[1] >= 75 ? "Mostly easy, with the hard work concentrated: a polarized/pyramidal mix that suits a 2-hour race." : zp[2] > 25 ? "A lot of Zone 3: the 'grey zone' tires you without the stimulus of real intervals. Make easy days easier." : "A balanced mix."}</p>` : `<p class="empty">Time in zones comes from Garmin-recorded activities.</p>`}</div></div>
      ${commuteHTML()}
      <h3 class="mt-6">Recent activities</h3><div class="scrollx" tabindex="0" role="region" aria-label="Recent activities"><table class="tbl"><thead><tr><th>When</th><th>Activity</th><th class="r">Time</th><th class="r">Distance</th><th class="r hide-sm">Climb</th><th class="r hide-sm">Avg HR</th><th class="r">TSS</th></tr></thead><tbody>
      ${D.recent.map(a => `<tr><td class="num">${fmtD(a.start)}</td><td>${esc(a.name)}<br><span class="sub">${esc(a.kind.replace(/_/g, " "))}${a.offroad ? " · off-road" : ""}${a.indoor ? " · trainer" : ""}${a.commute ? ` · commute ${a.leg === "home" ? "home" : "in"}` : ""}</span></td><td class="r">${dur(a.moving_s)}</td><td class="r">${a.distance_m ? dist(a.distance_m) : "—"}</td><td class="r hide-sm">${a.elev_m ? elev(a.elev_m) : "—"}</td><td class="r hide-sm">${r0(a.avg_hr)}</td><td class="r" title="from ${esc(a.load_src)}">${r0(a.load)}${a.load_src === "duration" ? "*" : ""}</td></tr>`).join("")}
      </tbody></table></div>${D.recent.some(a => a.load_src === "duration") ? `<p class="sub mt-3">* No heart rate: load estimated from duration.</p>` : ""}</section>`);

    // insights
    html.push(`<section id="insights" class="card"><div class="head"><h2>What your data says</h2><span class="sub">rank correlations over your own history</span></div>
      ${D.insights.length ? `<ul class="insights">${D.insights.map(i => `<li>${esc(i.text)}</li>`).join("")}</ul>` : `<p class="empty">Nothing clears the bar yet: an insight needs 30+ paired days and a real effect (|ρ| ≥ 0.2).</p>`}</section>`);

    // data
    const th = D.athlete;
    html.push(`<section id="device" class="card"><div class="head"><h2>What the Venu Sq gives you</h2><span class="sub">last 30 days of data actually received</span></div>
      <div class="scrollx" tabindex="0" role="region" aria-label="Signals received"><table class="tbl"><thead><tr><th>Signal</th><th class="r">Days</th><th>Hardware</th><th>Note</th></tr></thead><tbody>
      ${D.coverage.map(c => `<tr><td>${esc(c.field)}</td><td class="r">${c.days}/${c.of}</td><td>${esc(c.device)}</td><td class="sub">${esc(c.note)}</td></tr>`).join("")}</tbody></table></div>
      <div class="kpis mt-4"><span>Max HR <b>${th.max_hr}</b></span><span>Resting HR <b>${r0(th.rest_hr)}</b></span><span>LTHR <b>${th.lthr}</b></span><span>FTP <b>${th.ftp || "—"}</b></span>
      ${th.estimated.length ? `<span class="muted">${esc(listOf(th.estimated.map(k => ({ max_hr: "max HR", resting_hr: "resting HR", lthr: "LTHR", ftp: "FTP" })[k] || k)))} estimated from your data; set ${th.estimated.length === 1 ? "it" : "them"} in fitness/config.toml</span>` : ""}</div>
      <p class="sub">${D.counts.days} days of wellness, ${D.counts.activities} activities since ${fmtD(D.counts.first)}, ${D.counts.first.slice(0, 4)}. Built ${esc(D.generated.replace("T", " "))}.</p></section>`);

    app.innerHTML = html.join("");
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
    chart(document.getElementById("c-ready"), {
      label: "Readiness score", x: D.readiness.map(r => r.date), height: 170, yMin: 0, yMax: 100,
      ref: { lo: 75, hi: 100, label: "key-session zone", color: "var(--s3)" },
      series: [{ name: "Readiness", type: "line", color: "var(--s1)", values: D.readiness.map(r => r.score), endDot: true }],
    });

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
