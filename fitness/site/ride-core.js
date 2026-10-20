"use strict";
// Ride mode's engine, kept free of the page so the specs can drive it directly (window.RideCore):
//   routes      GPX / TCX / GeoJSON in (read as data, never as a DOM) → distance, elevation, climbs, turns and points of interest
//   navigation  where you are on a route, off course, wrong way, what's ahead, and BRouter detours back to it
//   sun         sunrise and sunset for the place and day (light left on the ride)
//   workouts    the session tailored mid-ride: intensity, time left, one more rep, cut the set, quick workouts
//   files       the ride out as FIT (Garmin Connect, Strava, TrainingPeaks), GPX and TCX
//   tiles       the map tiles along a route, for offline use at the trailhead
self.RideCore = (() => {
  const R = 6371008.8, rad = x => x * Math.PI / 180, deg = x => x * 180 / Math.PI;
  const hav = (a, b) => { const dl = rad(b.lat - a.lat), dn = rad(b.lon - a.lon); const h = Math.sin(dl / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(h))); };
  const bearing = (a, b) => { const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat)), x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon)); return (deg(Math.atan2(y, x)) + 360) % 360; };
  const turnAngle = (a, b) => ((b - a + 540) % 360) - 180;   // signed, -180..180: + is to the right
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const num = s => { const v = parseFloat(s); return Number.isFinite(v) ? v : null; };

  // ── parsing ─────────────────────────────────────────────────────────────────────────────────────────────
  const DIRS = [   // a cue's words → its kind (RideWithGPS, Garmin, TCX course points, OsmAnd and BRouter wording)
    [/u[- ]?turn|make a u/i, "uturn"], [/sharp(ly)? left/i, "sharp-left"], [/sharp(ly)? right/i, "sharp-right"],
    [/(slight(ly)?|bear|keep|fork) left|exit left/i, "slight-left"], [/(slight(ly)?|bear|keep|fork) right|exit right/i, "slight-right"],
    [/roundabout|rotary|traffic circle/i, "roundabout"], [/\bleft\b/i, "left"], [/\bright\b/i, "right"],
    [/straight|continue|\bonto\b/i, "straight"],
  ];
  const POI = [
    [/water|fountain|drink|refill|bottle/i, "water"], [/food|feed|cafe|café|restaurant|store|shop|market|gas|c-?store|bakery|snack/i, "food"],
    [/aid|first aid|medical|support|checkpoint|check point|rest stop|station/i, "aid"], [/summit|peak|top|kom|qom|climb|category|\bcat\b|hors/i, "summit"],
    [/danger|caution|hazard|warning|steep descent|rough|sand/i, "danger"], [/toilet|restroom|wc|bathroom|porta/i, "toilet"],
    [/sprint/i, "sprint"], [/valley/i, "valley"], [/finish|end/i, "finish"],
  ];
  const kindOf = (text, table) => { for (const [re, k] of table) if (re.test(text)) return k; return null; };
  // A small XML reader for route files: elements (by local name, prefixes dropped), attributes, text, CDATA and the five
  // entities plus numeric ones. It builds plain objects, never a DOM, so nothing in a file can ever become markup.
  const ENT = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
  const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== "#") return ENT[e.toLowerCase()] ?? m;
    const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : "";
  });
  const local = n => n.slice(n.indexOf(":") + 1);
  function parseXML(src) {
    const root = { name: "#document", attrs: {}, kids: [], text: "" }, stack = [root];
    const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/gy;
    let m;
    while (re.lastIndex < src.length) {
      const at = re.lastIndex;
      if (!(m = re.exec(src)) || re.lastIndex === at) throw new Error("bad xml");
      const top = stack[stack.length - 1];
      if (m[1] != null) top.text += m[1];
      else if (m[6] != null) { if (stack.length > 1) top.text += decode(m[6]); }
      else if (m[2] != null) { if (stack.length < 2 || top.name !== local(m[2])) throw new Error("bad xml"); stack.pop(); }
      else if (m[3] != null) {
        const attrs = {};
        for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[local(a[1])] = decode(a[2] ?? a[3] ?? "");
        const node = { name: local(m[3]), attrs, kids: [], text: "" };
        top.kids.push(node);
        if (!m[5]) stack.push(node);
      }
    }
    if (stack.length !== 1 || root.kids.length !== 1) throw new Error("bad xml");
    return root.kids[0];
  }
  const textOf = n => n.text + n.kids.map(textOf).join("");
  /** Every element under a node with this local name, in document order (what getElementsByTagNameNS("*", name) gives). */
  const kids = (node, name, out = []) => { for (const k of node.kids) { if (k.name === name) out.push(k); kids(k, name, out); } return out; };
  const el = (node, name) => kids(node, name)[0] || null;
  const txt = (node, name) => { const x = el(node, name); return x ? textOf(x).trim() : ""; };

  /** Text of a GPX, TCX or GeoJSON file → { name, points: [{lat, lon, ele}], marks: [{lat, lon, name, kind, cue}] } */
  function parseRoute(text, filename = "") {
    const t = String(text || "").replace(/^\uFEFF/, "").trim();
    if (t.startsWith("{")) return parseGeoJSON(JSON.parse(t), filename);
    let doc;
    try { doc = parseXML(t); } catch { throw new Error("That file isn't valid GPX or TCX."); }
    const root = doc.name.toLowerCase();
    const base = filename.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim();
    let out;
    if (root === "gpx") out = parseGPX(doc);
    else if (root === "trainingcenterdatabase") out = parseTCX(doc);
    else throw new Error("Only GPX, TCX and GeoJSON routes can be loaded.");
    out.name = out.name || base || "Route";
    if (out.points.length < 2) throw new Error("That file has no track or route in it.");
    return out;
  }
  function parseGPX(doc) {
    const pt = n => ({ lat: num(n.attrs.lat), lon: num(n.attrs.lon), ele: num(txt(n, "ele")) });
    const ok = p => p.lat != null && p.lon != null && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
    let points = kids(doc, "trkpt").map(pt).filter(ok);
    const rtepts = kids(doc, "rtept");
    const marks = [];
    if (points.length < 2) points = rtepts.map(pt).filter(ok);
    else for (const r of rtepts) {   // a route alongside the track: its points are the cues (BaseCamp, OsmAnd)
      const p = pt(r), words = [txt(r, "name"), txt(r, "desc"), txt(r, "cmt"), txt(r, "type"), txt(r, "sym")].join(" ");
      const cue = kindOf(words, DIRS);
      if (ok(p) && cue) marks.push({ ...p, name: txt(r, "desc") || txt(r, "name"), kind: cue, cue: true });
    }
    for (const w of kids(doc, "wpt")) {
      const p = pt(w);
      if (!ok(p)) continue;
      const name = txt(w, "name"), desc = txt(w, "desc") || txt(w, "cmt"), type = txt(w, "type"), sym = txt(w, "sym");
      const cue = kindOf(`${type} ${sym}`, DIRS) || (/^(left|right|straight|slight|sharp|u-?turn|bear|keep|continue)\b/i.test(name) ? kindOf(name, DIRS) : null);
      if (cue && !kindOf(`${type} ${sym}`, POI)) marks.push({ ...p, name: desc || name, kind: cue, cue: true });
      else marks.push({ ...p, name: name || desc || type || "Waypoint", desc, kind: kindOf(`${type} ${sym} ${name}`, POI) || "generic", cue: false });
    }
    const meta = el(doc, "metadata");
    const trk = el(doc, "trk") || el(doc, "rte");
    return { name: (trk && txt(trk, "name")) || (meta && txt(meta, "name")) || "", points, marks };
  }
  function parseTCX(doc) {
    const pos = n => { const p = el(n, "Position"); return p ? { lat: num(txt(p, "LatitudeDegrees")), lon: num(txt(p, "LongitudeDegrees")) } : null; };
    const points = [];
    for (const tp of kids(doc, "Trackpoint")) { const p = pos(tp); if (p && p.lat != null && p.lon != null) points.push({ ...p, ele: num(txt(tp, "AltitudeMeters")) }); }
    const marks = [];
    for (const cp of kids(doc, "CoursePoint")) {
      const p = pos(cp);
      if (!p || p.lat == null) continue;
      const type = txt(cp, "PointType"), name = txt(cp, "Name"), notes = txt(cp, "Notes");
      const cue = kindOf(type, DIRS);
      if (cue && type !== "Generic") marks.push({ ...p, ele: null, name: notes || name, kind: cue, cue: true });
      else marks.push({ ...p, ele: null, name: name || type, desc: notes, kind: kindOf(`${type} ${name}`, POI) || "generic", cue: false });
    }
    const course = el(doc, "Course");
    return { name: course ? txt(course, "Name") : "", points, marks };
  }
  function parseGeoJSON(j, filename) {
    const feats = j.type === "FeatureCollection" ? j.features : j.type === "Feature" ? [j] : [{ type: "Feature", geometry: j, properties: {} }];
    const points = [], marks = [];
    let name = "";
    for (const f of feats || []) {
      const g = f && f.geometry;
      if (!g) continue;
      const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
      for (const line of lines) for (const c of line) if (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) points.push({ lat: c[1], lon: c[0], ele: Number.isFinite(c[2]) ? c[2] : null });
      if (g.type === "Point") { const p = f.properties || {}; marks.push({ lat: g.coordinates[1], lon: g.coordinates[0], ele: null, name: p.name || "Waypoint", kind: kindOf(`${p.type || ""} ${p.name || ""}`, POI) || "generic", cue: false }); }
      if (!name && f.properties && f.properties.name) name = String(f.properties.name);
    }
    if (points.length < 2) throw new Error("That file has no line to follow.");
    return { name: name || filename.replace(/\.[a-z0-9]+$/i, "") || "Route", points, marks };
  }

  // ── analysis ────────────────────────────────────────────────────────────────────────────────────────────
  const STEP = 20;   // the profile's spacing, m
  /** A parsed route → everything ride mode navigates by. @param {{name: string, points: any[], marks?: any[], id?: string}} raw */
  function analyze(raw) {
    const pts = [];
    for (const p of raw.points) { if (!pts.length || hav(pts[pts.length - 1], p) >= 1) pts.push({ lat: p.lat, lon: p.lon, ele: p.ele ?? null }); }
    if (pts.length < 2) throw new Error("The route is too short to follow.");
    const n = pts.length, cum = new Float64Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + hav(pts[i - 1], pts[i]);
    const total = cum[n - 1];
    // elevation: gaps interpolated; none at all is flagged (ride mode then asks Open-Meteo for it)
    const known = pts.filter(p => p.ele != null).length;
    const hasEle = known >= Math.min(n, 2) && known / n > 0.5;
    if (hasEle) {
      let lastI = -1;
      for (let i = 0; i < n; i++) {
        if (pts[i].ele == null) continue;
        if (lastI < 0) for (let j = 0; j < i; j++) pts[j].ele = pts[i].ele;
        else for (let j = lastI + 1; j < i; j++) pts[j].ele = pts[lastI].ele + (pts[i].ele - pts[lastI].ele) * (cum[j] - cum[lastI]) / Math.max(1e-6, cum[i] - cum[lastI]);
        lastI = i;
      }
      for (let j = lastI + 1; j < n; j++) pts[j].ele = pts[lastI].ele;
    }
    // the planar frame for snapping: metres east and north of the route's middle
    const mid = pts[Math.floor(n / 2)], kx = R * rad(1) * Math.cos(rad(mid.lat)), ky = R * rad(1);
    const xs = new Float64Array(n), ys = new Float64Array(n);
    for (let i = 0; i < n; i++) { xs[i] = (pts[i].lon - mid.lon) * kx; ys[i] = (pts[i].lat - mid.lat) * ky; }
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (const p of pts) { minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat); minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon); }
    const route = { id: raw.id || "", name: raw.name || "Route", pts, cum, total, xs, ys, frame: { lat: mid.lat, lon: mid.lon, kx, ky },
      bounds: [[minLon, minLat], [maxLon, maxLat]], hasEle, prof: null, gain: 0, loss: 0, climbs: [], turns: [], pois: [], loop: hav(pts[0], pts[n - 1]) < 250 };
    if (hasEle) profile(route);
    const marks = (raw.marks || []).map(m => ({ ...m, along: project(route, m) })).filter(m => m.along.off < (m.cue ? 60 : 400));
    const cues = marks.filter(m => m.cue).map(m => ({ along: m.along.along, kind: m.kind, name: cleanCue(m.name), angle: null, src: "file" }));
    route.turns = (cues.length >= 2 ? cues : deriveTurns(route)).sort((a, b) => a.along - b.along);
    route.pois = marks.filter(m => !m.cue).map(m => ({ along: m.along.along, off: m.along.off, lat: m.lat, lon: m.lon, name: m.name, desc: m.desc || "", kind: m.kind })).sort((a, b) => a.along - b.along);
    return route;
  }
  const cleanCue = s => String(s || "").replace(/\s+/g, " ").trim().slice(0, 120);

  /** The elevation profile every 20 m (smoothed over ~100 m), its gain and loss, and its climbs. */
  function profile(route) {
    const { pts, cum, total } = route, m = Math.max(2, Math.ceil(total / STEP) + 1), raw = new Float64Array(m);
    let j = 0;
    for (let k = 0; k < m; k++) {
      const d = Math.min(total, k * STEP);
      while (j < pts.length - 2 && cum[j + 1] < d) j++;
      const f = (d - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]);
      raw[k] = pts[j].ele + (pts[j + 1].ele - pts[j].ele) * clamp(f, 0, 1);
    }
    const ele = new Float64Array(m), w = 2;   // ±2 samples = 100 m window
    for (let k = 0; k < m; k++) { let s = 0, c = 0; for (let i = Math.max(0, k - w); i <= Math.min(m - 1, k + w); i++) { s += raw[i]; c++; } ele[k] = s / c; }
    let gain = 0, loss = 0, ref = ele[0];
    for (let k = 1; k < m; k++) { const d = ele[k] - ref; if (d >= 3) { gain += d; ref = ele[k]; } else if (d <= -3) { loss -= d; ref = ele[k]; } }
    route.prof = { step: STEP, ele, min: Math.min(...ele), max: Math.max(...ele) };
    route.gain = gain; route.loss = loss;
    route.climbs = findClimbs(ele, total);
  }
  /** Climbs, the way a ClimbPro screen lists them: from a low point to the top, a dip of 10 m (or a fifth of the gain)
   *  ends one, and what's left must be 300 m+ long, 15 m+ up and 3%+ on average. Categories from length × grade. */
  function findClimbs(ele, total) {
    const out = [], m = ele.length;
    let lo = 0, hi = 0;
    const close = () => {
      // a long gentle rise into the climb, or a flat top, isn't the climb: trim while the first / last 40 m is under 2%
      while (hi - lo > 2 && (ele[lo + 2] - ele[lo]) / (2 * STEP) < 0.02) lo++;
      while (hi - lo > 2 && (ele[hi] - ele[hi - 2]) / (2 * STEP) < 0.02) hi--;
      const len = (hi - lo) * STEP, up = ele[hi] - ele[lo];
      if (len >= 300 && up >= 15 && up / len >= 0.03) {
        let maxG = 0;
        for (let k = lo; k + 5 <= hi; k++) maxG = Math.max(maxG, (ele[k + 5] - ele[k]) / (5 * STEP));
        const grade = up / len, score = len * grade * 100;
        out.push({ start: lo * STEP, end: Math.min(total, hi * STEP), len, gain: up, grade, maxGrade: Math.max(maxG, grade), top: ele[hi], score,
          cat: score >= 80000 ? "HC" : score >= 64000 ? "Cat 1" : score >= 32000 ? "Cat 2" : score >= 16000 ? "Cat 3" : score >= 8000 ? "Cat 4" : "" });
      }
    };
    for (let k = 1; k < m; k++) {
      if (ele[k] > ele[hi]) hi = k;
      if (hi === lo) { if (ele[k] < ele[lo]) { lo = k; hi = k; } continue; }
      const drop = ele[hi] - ele[k], gained = ele[hi] - ele[lo];
      if (ele[k] < ele[lo] || drop > Math.max(10, gained * 0.2)) { close(); lo = k; hi = k; }
    }
    if (hi > lo) close();
    return out;
  }
  /** The ground height at a distance along the route (the smoothed profile). */
  const eleAt = (route, along) => {
    if (!route.prof) return null;
    const e = route.prof.ele, f = clamp(along / STEP, 0, e.length - 1), i = Math.floor(f);
    return i >= e.length - 1 ? e[e.length - 1] : e[i] + (e[i + 1] - e[i]) * (f - i);
  };
  /** The grade (%) over the next ~100 m from a point along the route. */
  const gradeAt = (route, along) => { const a = eleAt(route, along), b = eleAt(route, Math.min(route.total, along + 100)); return a == null || b == null || route.total - along < 30 ? null : (b - a) / Math.min(100, route.total - along) * 100; };

  /** The point at a distance along the route. */
  function pointAt(route, along) {
    const { pts, cum } = route, d = clamp(along, 0, route.total);
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const md = (lo + hi) >> 1; if (cum[md] <= d) lo = md; else hi = md; }
    const f = (d - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]);
    return { lat: pts[lo].lat + (pts[hi].lat - pts[lo].lat) * f, lon: pts[lo].lon + (pts[hi].lon - pts[lo].lon) * f, i: lo, brg: bearing(pts[lo], pts[hi]) };
  }

  /** Turns from the line itself, for files with no cues: a change of course of 35°+ within 20 m either side that holds over
   *  60 m (so a wiggle in the trace isn't one), kept 30 m apart, the sharper of two close ones winning. */
  function deriveTurns(route) {
    const pts = [], total = route.total, sp = 10;
    for (let d = 0; d <= total; d += sp) pts.push(pointAt(route, d));
    const found = [];
    for (let i = 2; i < pts.length - 2; i++) {
      const a = Math.max(0, i - 2), b = Math.min(pts.length - 1, i + 2), A = Math.max(0, i - 6), B = Math.min(pts.length - 1, i + 6);
      if (hav(pts[a], pts[i]) < 8 || hav(pts[i], pts[b]) < 8) continue;
      const near = turnAngle(bearing(pts[a], pts[i]), bearing(pts[i], pts[b]));
      const wide = turnAngle(bearing(pts[A], pts[i]), bearing(pts[i], pts[B]));
      if (Math.abs(near) >= 35 && Math.abs(wide) >= 40 && Math.sign(near) === Math.sign(wide)) found.push({ along: i * sp, angle: wide });
    }
    const turns = [];
    for (const t of found) {
      const last = turns[turns.length - 1];
      if (last && t.along - last.along < 30) { if (Math.abs(t.angle) > Math.abs(last.angle)) turns[turns.length - 1] = t; }
      else turns.push(t);
    }
    return turns.filter(t => t.along > 15 && t.along < total - 15).map(t => ({ along: t.along, angle: Math.round(t.angle), kind: kindFromAngle(t.angle), name: "", src: "line" }));
  }
  const kindFromAngle = a => { const x = Math.abs(a), s = a > 0 ? "right" : "left"; return x >= 160 ? "uturn" : x >= 120 ? `sharp-${s}` : x >= 60 ? s : x >= 25 ? `slight-${s}` : "straight"; };
  const TURN_WORDS = { left: "Turn left", right: "Turn right", "slight-left": "Bear left", "slight-right": "Bear right", "sharp-left": "Sharp left", "sharp-right": "Sharp right",
    uturn: "Make a U-turn", roundabout: "At the roundabout", straight: "Continue straight", arrive: "Arrive" };
  const TURN_ARROWS = { left: "↰", right: "↱", "slight-left": "↖", "slight-right": "↗", "sharp-left": "⤺", "sharp-right": "⤻", uturn: "⮌", roundabout: "⟳", straight: "↑", arrive: "⚑" };

  /** Where a point sits on the route: its distance along, how far off it is, and the course there.
   *  `near` (a distance along) keeps the search on the stretch you're riding, so an out-and-back or a figure eight
   *  doesn't jump to the other side; with nothing close there it falls back to the whole route. */
  function project(route, p, near = null, ahead = 2500, behind = 300) {
    const { xs, ys, cum, frame } = route, n = xs.length;
    const px = (p.lon - frame.lon) * frame.kx, py = (p.lat - frame.lat) * frame.ky;
    const scan = (lo, hi) => {
      let best = { off: Infinity, along: 0, i: 0 };
      for (let i = lo; i < hi; i++) {
        const dx = xs[i + 1] - xs[i], dy = ys[i + 1] - ys[i], L = dx * dx + dy * dy;
        const t = L > 0 ? clamp(((px - xs[i]) * dx + (py - ys[i]) * dy) / L, 0, 1) : 0;
        const ex = xs[i] + t * dx - px, ey = ys[i] + t * dy - py, off = Math.hypot(ex, ey);
        if (off < best.off) best = { off, along: cum[i] + t * (cum[i + 1] - cum[i]), i };
      }
      return best;
    };
    const idx = d => { let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; } return lo; };
    let best = null;
    if (near != null) best = scan(idx(Math.max(0, near - behind)), Math.min(n - 1, idx(Math.min(route.total, near + ahead)) + 1));
    if (!best || best.off > 75) { const all = scan(0, n - 1); if (!best || all.off + 25 < best.off) best = all; }
    const a = route.pts[best.i], b = route.pts[Math.min(n - 1, best.i + 1)];
    return { along: best.along, off: best.off, i: best.i, brg: bearing(a, b) };
  }

  // ── navigation: one instance per ride on a route ──────────────────────────────────────────────────────────
  /** Follows you along a route: progress, off course / wrong way (each with a little hysteresis), the next turn,
   *  climb and point of interest, and the cue callouts due now. */
  function navigator(route, opts = {}) {
    const st = { along: opts.startAlong || 0, off: 0, offCourse: false, offSince: 0, wrongWay: false, wrongSince: 0, onSince: 0, fixes: 0, brg: 0, said: new Set(), lastOnAlong: opts.startAlong || 0 };
    function update(fix, heading, speed, now = Date.now()) {
      const pr = project(route, fix, st.fixes ? st.along : null);
      st.fixes++;
      st.off = pr.off; st.brg = pr.brg;
      const limit = Math.max(40, Math.min(80, (fix.acc || 10) * 1.5));
      if (pr.off <= limit) { st.along = pr.along; st.lastOnAlong = pr.along; }
      if (pr.off > limit) { if (!st.offSince) st.offSince = now; if (now - st.offSince >= 6000) st.offCourse = true; st.onSince = 0; }
      else { st.offSince = 0; if (st.offCourse) { if (!st.onSince) st.onSince = now; if (pr.off < 30 && now - st.onSince >= 3000) st.offCourse = false; } }
      if (!st.offCourse && heading != null && (speed ?? 0) > 2 && Math.abs(turnAngle(heading, pr.brg)) > 135) { if (!st.wrongSince) st.wrongSince = now; if (now - st.wrongSince >= 8000) st.wrongWay = true; }
      else { st.wrongSince = 0; st.wrongWay = false; }
      return status();
    }
    function status() {
      const a = st.along;
      const turn = route.turns.find(t => t.along > a + 3) || null;
      const after = turn ? route.turns.find(t => t.along > turn.along + 1) || null : null;
      const climb = route.climbs.find(c => c.end > a) || null;
      const on = climb && climb.start <= a ? climb : null;
      return { along: a, left: Math.max(0, route.total - a), frac: route.total ? a / route.total : 0, off: st.off, offCourse: st.offCourse, wrongWay: st.wrongWay,
        turn, toTurn: turn ? turn.along - a : null, after, climb, onClimb: on, toClimb: climb && !on ? climb.start - a : null,
        pois: route.pois.filter(p => p.along > a - 20).slice(0, 6), ele: eleAt(route, a), grade: gradeAt(route, a), finishIn: route.total - a };
    }
    /** The callouts due at this speed: a turn 25 s out (at least 200 m) and 7 s out (at least 40 m), a climb 300 m before
     *  its foot and at the top, a point of interest 500 m out. Each once. */
    function callouts(speed) {
      const s = status(), out = [], v = Math.max(3, speed || 0);
      if (s.offCourse || s.wrongWay) return out;
      if (s.turn) {
        const far = Math.max(200, 25 * v), near = Math.max(40, 7 * v), key = Math.round(s.turn.along);
        if (s.toTurn <= near && !st.said.has(`n${key}`)) { st.said.add(`n${key}`); st.said.add(`f${key}`); out.push({ kind: "turn-now", turn: s.turn, dist: s.toTurn }); }
        else if (s.toTurn <= far && s.toTurn > near * 1.5 && !st.said.has(`f${key}`)) { st.said.add(`f${key}`); out.push({ kind: "turn-soon", turn: s.turn, dist: s.toTurn }); }
      }
      if (s.climb && s.toClimb != null && s.toClimb <= 300 && s.toClimb > 0 && !st.said.has(`c${s.climb.start}`)) { st.said.add(`c${s.climb.start}`); out.push({ kind: "climb", climb: s.climb, dist: s.toClimb }); }
      if (s.onClimb && s.onClimb.end - s.along < 40 && !st.said.has(`t${s.onClimb.start}`)) { st.said.add(`t${s.onClimb.start}`); out.push({ kind: "top", climb: s.onClimb }); }
      for (const p of s.pois) if (p.along - s.along <= 500 && p.along - s.along > 0 && !st.said.has(`p${p.along}`)) { st.said.add(`p${p.along}`); out.push({ kind: "poi", poi: p, dist: p.along - s.along }); }
      if (s.left < 30 && !st.said.has("arrive")) { st.said.add("arrive"); out.push({ kind: "arrive" }); }
      return out;
    }
    /** Where to rejoin: the nearest point of the route ahead of the last one you were on, weighing distance from here
     *  against skipping route (300 m of skipped route costs like 100 m of detour). */
    function rejoin(fix) {
      let best = null;
      for (let d = st.lastOnAlong + 150; d <= Math.min(route.total, st.lastOnAlong + 4000); d += 50) {
        const p = pointAt(route, d), cost = hav(fix, p) + (d - st.lastOnAlong) / 3;
        if (!best || cost < best.cost) best = { cost, along: d, lat: p.lat, lon: p.lon };
      }
      return best || { along: route.total, ...pointAt(route, route.total) };
    }
    const toRoute = fix => { const p = pointAt(route, project(route, fix, st.lastOnAlong).along); return { dist: hav(fix, p), brg: bearing(fix, p), lat: p.lat, lon: p.lon }; };
    return { update, status, callouts, rejoin, toRoute, state: st, seek(along) { st.along = along; st.lastOnAlong = along; st.said.clear(); } };
  }

  /** A BRouter answer (GeoJSON, with voicehints when asked for) → a parsed route whose turns are the router's. */
  const BR_CMD = { 1: "straight", 2: "left", 3: "slight-left", 4: "sharp-left", 5: "right", 6: "slight-right", 7: "sharp-right", 8: "slight-left", 9: "slight-right",
    10: "uturn", 11: "uturn", 12: "uturn", 14: "roundabout", 15: "roundabout", 17: "slight-left", 18: "slight-right" };
  function fromBRouter(j, name = "Back to the route") {
    const raw = parseGeoJSON(j, name);
    raw.name = name;
    const r = analyze(raw);
    const f = (j.features || [])[0], vh = f && f.properties && f.properties.voicehints;
    if (Array.isArray(vh) && vh.length) {
      const turns = [];
      for (const h of vh) {
        if (!Array.isArray(h) || !Number.isFinite(h[0])) continue;
        const kind = BR_CMD[h[1]];
        const c = j.features[0].geometry.coordinates[h[0]];
        if (!kind || kind === "straight" || !c) continue;
        turns.push({ along: project(r, { lat: c[1], lon: c[0] }).along, kind, name: kind === "roundabout" && h[2] ? `take exit ${h[2]}` : "", angle: Number.isFinite(h[4]) ? h[4] : null, src: "router" });
      }
      if (turns.length) r.turns = turns.sort((a, b) => a.along - b.along);
    }
    return r;
  }
  /** The URL of a BRouter route from → to (the public server: free, no key, cycling profiles). */
  const brouterUrl = (from, to, profile = "trekking", server = "https://brouter.de/brouter") =>
    `${server}?lonlats=${from.lon.toFixed(6)},${from.lat.toFixed(6)}|${to.lon.toFixed(6)},${to.lat.toFixed(6)}&profile=${encodeURIComponent(profile)}&alternativeidx=0&format=geojson&timode=3`;

  // ── the sun (after Agafonkin's SunCalc, from the NOAA / Astronomical Almanac formulas) ────────────────────────
  function sunTimes(date, lat, lon) {
    const dayMs = 864e5, J1970 = 2440588, J2000 = 2451545, e = rad(23.4397);
    const toDays = d => d.valueOf() / dayMs - 0.5 + J1970 - J2000;
    const fromJ = j => new Date((j + 0.5 - J1970) * dayMs);
    const lw = rad(-lon), phi = rad(lat), d = toDays(date);
    const n = Math.round(d - 0.0009 - lw / (2 * Math.PI));
    const ds = 0.0009 + lw / (2 * Math.PI) + n;
    const M = rad(357.5291 + 0.98560028 * ds);
    const C = rad(1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const L = M + C + rad(102.9372) + Math.PI;
    const dec = Math.asin(Math.sin(L) * Math.sin(e));
    const Jnoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    const w = Math.acos(clamp((Math.sin(rad(-0.833)) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)), -1, 1));
    const a = 0.0009 + (w + lw) / (2 * Math.PI) + n;
    const Jset = J2000 + a + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    return { sunrise: fromJ(Jnoon - (Jset - Jnoon)).getTime(), sunset: fromJ(Jset).getTime(), noon: fromJ(Jnoon).getTime() };
  }

  // ── workouts: Friel's HR zones as % of LTHR (fitness/workouts.py) ─────────────────────────────────────────
  const ZONES = { z1: [0, 81], z2: [81, 89], tempo: [88, 93], race: [90, 96], ss: [92, 97], thr: [95, 100], z5: [100, 106], max: [100, 110] };
  const LAG = "Short effort: heart rate lags — ride it by feel, RPE 9";
  const step = (name, min, zone, cue = "") => ({ name, min: Math.round(min * 100) / 100, zone, lo: ZONES[zone][0], hi: ZONES[zone][1], cue });
  const isWork = s => !!s && s.lo >= 88;
  const isEasy = s => !!s && !isWork(s);
  const reps = (n, label, on, zone, off, cue = "", offZone = "z1") => { const o = []; for (let i = 0; i < n; i++) { o.push(step(`${label} ${i + 1}/${n}`, on, zone, cue)); if (i < n - 1 && off) o.push(step("Easy", off, offZone)); } return o; };
  /** Workouts picked on the bike, fitted to the minutes you have. */
  const QUICK = {
    endurance: { label: "Endurance", build: m => [step("Warm-up", 10, "z2", "Build gradually"), step("Endurance", Math.max(5, m - 15), "z2", "Steady, conversational"), step("Cool-down", 5, "z1")] },
    tempo: { label: "Tempo", build: m => { const n = clamp(Math.floor((m - 20) / 19), 1, 4); return [step("Warm-up", 10, "z2"), ...reps(n, "Tempo", 15, "tempo", 4, "Strong but sustainable"), step("Cool-down", Math.max(5, m - 10 - n * 15 - (n - 1) * 4), "z1")]; } },
    sweetspot: { label: "Sweet spot", build: m => { const n = clamp(Math.floor((m - 21) / 16), 1, 4); return [step("Warm-up", 12, "z2"), ...reps(n, "Sweet spot", 12, "ss", 4), step("Cool-down", Math.max(5, m - 12 - n * 12 - (n - 1) * 4), "z1")]; } },
    threshold: { label: "Threshold", build: m => { const on = m >= 70 ? 20 : m >= 55 ? 15 : 10, n = clamp(Math.floor((m - 22) / (on + 5)), 1, 3); return [step("Warm-up", 15, "z2"), ...reps(n, "Threshold", on, "thr", 5), step("Cool-down", Math.max(5, m - 15 - n * on - (n - 1) * 5), "z1")]; } },
    vo2: { label: "VO2 max", build: m => { const n = clamp(Math.floor((m - 21) / 8), 3, 6); return [step("Warm-up", 15, "z2", "A few 10 s spin-ups at the end"), ...reps(n, "VO2", 4, "z5", 4, "RPE 9 — HR catches up in the last minute"), step("Cool-down", Math.max(5, m - 15 - n * 8 + 4), "z1")]; } },
    thirty: { label: "30/30s", build: m => { const per = clamp(Math.floor((m - 30) / 2), 6, 12); const o = [step("Warm-up", 15, "z2")]; for (let s = 0; s < 2; s++) { for (let i = 0; i < per; i++) o.push(step(`Set ${s + 1} · 30 s on (${i + 1}/${per})`, 0.5, "max", LAG), step("30 s easy", 0.5, "z1")); if (!s) o.push(step("Easy between sets", 5, "z1")); } o.push(step("Cool-down", Math.max(5, m - 20 - per * 2), "z1")); return o; } },
    hills: { label: "Hill repeats", build: m => { const n = clamp(Math.floor((m - 20) / 4), 4, 10); return [step("Warm-up", 12, "z2"), ...reps(n, "Hill", 1.5, "max", 2.5, "Hard to the top — by feel"), step("Cool-down", Math.max(5, m - 12 - n * 4 + 2.5), "z1")]; } },
    sprints: { label: "Sprints", build: m => { const n = clamp(Math.floor((m - 20) / 5), 4, 8); return [step("Warm-up", 15, "z2"), ...reps(n, "Sprint", 0.25, "max", 4.75, "Seated, then out of the saddle — all out"), step("Cool-down", Math.max(5, m - 15 - n * 5 + 4.75), "z1")]; } },
    recovery: { label: "Recovery spin", build: m => [step("Recovery", Math.max(10, m), "z1", "Easy gears, high cadence")] },
  };
  const quick = (kind, minutes) => (QUICK[kind] || QUICK.endurance).build(clamp(Math.round(minutes), 15, 360));
  const sum = (steps, from = 0) => steps.slice(from).reduce((a, s) => a + s.min, 0);
  const copy = s => ({ ...s });
  /** The set the step at i belongs to: its work steps' indexes (same label before a "n/N"), and the recoveries between. */
  function setOf(steps, i) {
    const label = s => (s && isWork(s) ? s.name.replace(/\s*\d+\s*\/\s*\d+.*$/, "").replace(/\s*·\s*(over|under)$/, "") : null);
    let w = i;
    while (w >= 0 && !isWork(steps[w])) w--;
    if (w < 0) { w = i; while (w < steps.length && !isWork(steps[w])) w++; }
    if (w >= steps.length) return null;
    const L = label(steps[w]);
    let a = w, b = w;
    for (let k = w - 1; k >= 0; k--) { if (isWork(steps[k])) { if (label(steps[k]) === L) a = k; else break; } else if (steps[k].min > 10 || /warm/i.test(steps[k].name)) break; }
    for (let k = w + 1; k < steps.length; k++) { if (isWork(steps[k])) { if (label(steps[k]) === L) b = k; else break; } else if (steps[k].min > 10 || /cool/i.test(steps[k].name)) break; }
    return { label: L, first: a, last: b };
  }
  const renumber = (steps, set) => {
    const work = [];
    for (let k = set.first; k <= set.last; k++) if (isWork(steps[k]) && /\d+\s*\/\s*\d+/.test(steps[k].name)) work.push(k);
    const shapes = new Set(work.map(k => steps[k].name.replace(/\d+\s*\/\s*\d+/, "#")));
    if (shapes.size !== 1) return;   // over-unders number their blocks, not their steps: leave them be
    work.forEach((k, n) => { steps[k] = { ...steps[k], name: steps[k].name.replace(/\d+\s*\/\s*\d+/, `${n + 1}/${work.length}`) }; });
  };
  /** One more rep of the set you're in (or just did): another work step and its recovery after the set's last rep. */
  function addRep(steps, cur) {
    const out = steps.map(copy), set = setOf(out, cur);
    if (!set) return out;
    const work = out[set.last];
    let rec = null;
    for (let k = set.last - 1; k >= set.first; k--) if (!isWork(out[k])) { rec = out[k]; break; }
    rec = rec || step("Easy", Math.max(1, work.min), "z1");
    out.splice(set.last + 1, 0, copy(rec), copy(work));
    renumber(out, { first: set.first, last: set.last + 2 });
    return out;
  }
  /** Cut the set: the rest of its reps (and the recoveries between) come out, the rest of the session stays. */
  function cutSet(steps, cur) {
    const out = steps.map(copy), set = setOf(out, cur);
    if (!set || set.last <= cur) return out;
    out.splice(cur + 1, set.last - cur);
    return out;
  }
  /** More or less of the step you're on (minutes; never under 30 s left). */
  const extend = (steps, cur, delta, done = 0) => steps.map((s, i) => i === cur ? { ...s, min: Math.max(done + 0.5, s.min + delta) } : s);
  /** Fit what's left of the session into `minutes`: a short ride first trims long easy riding (to 40%, 5 min at least) and
   *  the cool-down (to 5 min), then drops reps from the end of each set (one always stays), then shortens everything
   *  evenly; a long one adds endurance before the cool-down. The step you're on keeps going. */
  function fitTime(steps, cur, done, minutes) {
    const out = steps.map(copy), want = Math.max(1, minutes);
    const left = () => out[cur].min - done + sum(out, cur + 1);
    if (left() <= want) {
      const extra = want - left();
      if (extra >= 3) {
        const cool = out.length - 1 > cur && /cool/i.test(out[out.length - 1].name) ? out.length - 1 : out.length;
        out.splice(cool, 0, step("Endurance (added)", Math.round(extra), "z2", "Steady, conversational"));
      }
      return out;
    }
    const lastI = out.length - 1, cool = lastI > cur && /cool/i.test(out[lastI].name) ? lastI : -1;
    const set = setOf(out, cur);
    for (let k = cur + 1; k < out.length && left() > want; k++) {
      if (k === cool || isWork(out[k]) || (set && k >= set.first && k <= set.last)) continue;
      if (out[k].min > 8) out[k].min = Math.max(5, Math.max(out[k].min * 0.4, out[k].min - (left() - want)));
    }
    if (cool > 0 && left() > want) out[cool].min = Math.max(5, out[cool].min - (left() - want));
    // drop reps from the back, one pair at a time, while the set keeps at least one
    for (let guard = 0; guard < 80 && left() > want; guard++) {
      let q = -1;
      for (let k = out.length - 1; k > cur && q < 0; k--) {
        if (!isWork(out[k])) continue;
        const s = setOf(out, k);
        let count = 0;
        for (let j = s.first; j <= s.last; j++) if (isWork(out[j])) count++;
        if (count >= 2) q = k;
      }
      if (q < 0) break;
      const s = setOf(out, q), rec = q - 1 > cur && q - 1 >= s.first && !isWork(out[q - 1]) ? 1 : 0;
      out.splice(q - rec, 1 + rec);
      renumber(out, { first: s.first, last: s.last - 1 - rec });
    }
    const coolNow = out.length - 1 > cur && /cool/i.test(out[out.length - 1].name) ? out.length - 1 : -1;
    if (left() < want - 1 && coolNow > 0) out[coolNow].min = Math.round((out[coolNow].min + want - left()) * 4) / 4;   // a dropped rep's time back to the cool-down
    if (left() > want) {
      const rest = sum(out, cur + 1), f = rest > 0 ? Math.max(0, (want - (out[cur].min - done)) / rest) : 0;
      for (let k = cur + 1; k < out.length; k++) out[k].min = Math.max(0.25, Math.round(out[k].min * f * 4) / 4);
    }
    return out;
  }
  /** % of LTHR → ≈ % of FTP (Coggan's power zones against Friel's HR zones), for a power target beside the HR one. */
  const PCT = [[0, 0], [68, 45], [81, 56], [90, 76], [94, 91], [100, 101], [106, 118], [110, 135]];
  const ftpPct = lthrPct => { for (let i = 1; i < PCT.length; i++) if (lthrPct <= PCT[i][0]) { const [a, pa] = PCT[i - 1], [b, pb] = PCT[i]; return pa + (pb - pa) * (lthrPct - a) / (b - a); } return 150; };

  // ── files: the recorded ride out ────────────────────────────────────────────────────────────────────────
  // A sample is [t ms, lat, lon, ele m, hr, cadence, power, speed m/s, distance m]; nulls where a sensor said nothing.
  const FIT_EPOCH = 631065600;   // 1989-12-31T00:00:00Z
  const CRC_T = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];
  const fitCrc = (bytes, crc = 0) => { for (const b of bytes) { let t = CRC_T[crc & 0xF]; crc = (crc >> 4) & 0x0FFF; crc = crc ^ t ^ CRC_T[b & 0xF]; t = CRC_T[crc & 0xF]; crc = (crc >> 4) & 0x0FFF; crc = crc ^ t ^ CRC_T[(b >> 4) & 0xF]; } return crc; };
  // base types: [id, size, invalid]
  const BT = { enum: [0x00, 1, 0xFF], sint8: [0x01, 1, 0x7F], uint8: [0x02, 1, 0xFF], sint16: [0x83, 2, 0x7FFF], uint16: [0x84, 2, 0xFFFF], sint32: [0x85, 4, 0x7FFFFFFF], uint32: [0x86, 4, 0xFFFFFFFF], uint32z: [0x8C, 4, 0] };
  /** A FIT activity file (cycling): file id, device, timer events, a record a second, laps, the session and the activity. */
  function toFIT(ride) {
    const chunks = [];
    let size = 0;
    const defs = new Map();
    let nextLocal = 0;
    const write = arr => { chunks.push(arr); size += arr.length; };
    function msg(global, fields) {   // fields: [[num, type, value]]
      const sig = `${global}:${fields.map(f => `${f[0]}${f[1]}`).join(",")}`;
      let local = defs.get(sig);
      if (local == null) {
        local = nextLocal++ % 16;
        for (const [k, v] of defs) if (v === local) defs.delete(k);
        defs.set(sig, local);
        const d = new Uint8Array(6 + fields.length * 3);
        d[0] = 0x40 | local; d[2] = 0; d[3] = global & 0xFF; d[4] = global >> 8; d[5] = fields.length;
        fields.forEach(([n, t], i) => { d[6 + i * 3] = n; d[7 + i * 3] = BT[t][1]; d[8 + i * 3] = BT[t][0]; });
        write(d);
      }
      const len = 1 + fields.reduce((a, f) => a + BT[f[1]][1], 0), buf = new ArrayBuffer(len), dv = new DataView(buf);
      dv.setUint8(0, local);
      let o = 1;
      for (const [, t, v0] of fields) {
        const [, sz, inv] = BT[t], v = v0 == null || !Number.isFinite(v0) ? inv : Math.round(v0);
        if (t === "sint8") dv.setInt8(o, clamp(v, -128, 127)); else if (sz === 1) dv.setUint8(o, clamp(v, 0, 255));
        else if (t === "sint16") dv.setInt16(o, v, true); else if (sz === 2) dv.setUint16(o, clamp(v, 0, 65535), true);
        else if (t === "sint32") dv.setInt32(o, v, true); else dv.setUint32(o, clamp(v, 0, 4294967295), true);
        o += sz;
      }
      write(new Uint8Array(buf));
    }
    const ts = ms => Math.round(ms / 1000) - FIT_EPOCH;
    const semi = d => d == null ? null : Math.round(d * 2147483648 / 180);
    const S = ride.samples, t0 = ride.start, tEnd = S.length ? S[S.length - 1][0] : t0;
    msg(0, [[0, "enum", 4], [1, "uint16", 255], [2, "uint16", 1], [3, "uint32z", 0x52494445], [4, "uint32", ts(t0)]]);
    msg(23, [[253, "uint32", ts(t0)], [0, "uint8", 0], [2, "uint16", 255], [4, "uint16", 1]]);   // device_info
    msg(21, [[253, "uint32", ts(t0)], [0, "enum", 0], [1, "enum", 0]]);                          // timer start
    for (const p of ride.pauses || []) {
      msg(21, [[253, "uint32", ts(p[0])], [0, "enum", 0], [1, "enum", 4]]);
      if (p[1]) msg(21, [[253, "uint32", ts(p[1])], [0, "enum", 0], [1, "enum", 0]]);
    }
    for (const s of S) msg(20, [[253, "uint32", ts(s[0])], [0, "sint32", semi(s[1])], [1, "sint32", semi(s[2])], [2, "uint16", s[3] == null ? null : (s[3] + 500) * 5],
      [3, "uint8", s[4]], [4, "uint8", s[5]], [7, "uint16", s[6]], [6, "uint16", s[7] == null ? null : s[7] * 1000], [5, "uint32", s[8] == null ? null : s[8] * 100]]);
    msg(21, [[253, "uint32", ts(tEnd)], [0, "enum", 0], [1, "enum", 4]]);                        // timer stop
    const laps = ride.laps && ride.laps.length ? ride.laps : [{ start: t0, end: tEnd }];
    laps.forEach(l => {
      const st = stats(ride, l.start, l.end);
      msg(19, [[253, "uint32", ts(l.end)], [254, "uint16", null], [0, "enum", 9], [1, "enum", 1], [2, "uint32", ts(l.start)], [7, "uint32", (l.end - l.start)], [8, "uint32", st.moving * 1000],
        [9, "uint32", st.dist * 100], [13, "uint16", st.avgSpeed * 1000], [15, "uint8", st.avgHr], [16, "uint8", st.maxHr], [17, "uint8", st.avgCad], [19, "uint16", st.avgPower], [21, "uint16", st.ascent], [24, "enum", l.trigger ?? 0]]);
    });
    const all = stats(ride, t0, tEnd);
    msg(18, [[253, "uint32", ts(tEnd)], [254, "uint16", 0], [0, "enum", 8], [1, "enum", 1], [2, "uint32", ts(t0)], [5, "enum", 2], [6, "enum", ride.indoor ? 6 : 0],
      [7, "uint32", (tEnd - t0)], [8, "uint32", all.moving * 1000], [9, "uint32", all.dist * 100], [11, "uint16", ride.kcal ?? null], [14, "uint16", all.avgSpeed * 1000], [15, "uint16", all.maxSpeed * 1000],
      [16, "uint8", all.avgHr], [17, "uint8", all.maxHr], [18, "uint8", all.avgCad], [20, "uint16", all.avgPower], [22, "uint16", all.ascent], [23, "uint16", all.descent],
      [25, "uint16", 0], [26, "uint16", laps.length], [35, "uint16", ride.tss != null ? ride.tss * 10 : null]]);
    const tz = -new Date(tEnd).getTimezoneOffset() * 60;
    msg(34, [[253, "uint32", ts(tEnd)], [0, "uint32", all.moving * 1000], [1, "uint16", 1], [2, "enum", 0], [3, "enum", 26], [4, "enum", 1], [5, "uint32", ts(tEnd) + tz]]);
    const body = new Uint8Array(size);
    let o = 0;
    for (const c of chunks) { body.set(c, o); o += c.length; }
    const head = new Uint8Array(14), hv = new DataView(head.buffer);
    hv.setUint8(0, 14); hv.setUint8(1, 0x20); hv.setUint16(2, 2132, true); hv.setUint32(4, size, true);
    head.set([0x2E, 0x46, 0x49, 0x54], 8);
    hv.setUint16(12, fitCrc(head.subarray(0, 12)), true);
    const file = new Uint8Array(14 + size + 2);
    file.set(head, 0); file.set(body, 14);
    const crc = fitCrc(file.subarray(0, 14 + size));
    file[14 + size] = crc & 0xFF; file[15 + size] = crc >> 8;
    return file;
  }
  /** Totals between two times of a recorded ride. */
  function stats(ride, from = -Infinity, to = Infinity) {
    const S = ride.samples.filter(s => s[0] >= from && s[0] <= to);
    let hr = 0, hrN = 0, maxHr = 0, cad = 0, cadN = 0, pw = 0, pwN = 0, maxSpeed = 0, moving = 0, ascent = 0, descent = 0, ref = null;
    for (let i = 0; i < S.length; i++) {
      const s = S[i];
      if (s[4] != null) { hr += s[4]; hrN++; maxHr = Math.max(maxHr, s[4]); }
      if (s[5] != null && s[5] > 0) { cad += s[5]; cadN++; }
      if (s[6] != null) { pw += s[6]; pwN++; }
      if (s[7] != null) maxSpeed = Math.max(maxSpeed, s[7]);
      if (i && (s[7] ?? 0) > 0.8) moving += clamp((s[0] - S[i - 1][0]) / 1000, 0, 5);
      if (s[3] != null) { if (ref == null) ref = s[3]; else if (s[3] - ref >= 2) { ascent += s[3] - ref; ref = s[3]; } else if (ref - s[3] >= 2) { descent += ref - s[3]; ref = s[3]; } }
    }
    const dist = S.length ? Math.max(0, (S[S.length - 1][8] ?? 0) - (S[0][8] ?? 0)) : 0;
    return { dist, moving, avgSpeed: moving ? dist / moving : 0, maxSpeed, avgHr: hrN ? hr / hrN : null, maxHr: maxHr || null, avgCad: cadN ? cad / cadN : null,
      avgPower: pwN ? pw / pwN : null, ascent, descent, n: S.length };
  }
  const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const xml = s => String(s ?? "").replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
  /** GPX 1.1 with Garmin's TrackPointExtension (heart rate, cadence) and power, which Strava and Garmin Connect read. */
  function toGPX(ride) {
    const pts = ride.samples.filter(s => s[1] != null).map(s => {
      const ext = [s[4] != null ? `<gpxtpx:hr>${s[4]}</gpxtpx:hr>` : "", s[5] != null ? `<gpxtpx:cad>${s[5]}</gpxtpx:cad>` : ""].join("");
      return `<trkpt lat="${s[1].toFixed(7)}" lon="${s[2].toFixed(7)}">${s[3] != null ? `<ele>${s[3].toFixed(1)}</ele>` : ""}<time>${iso(s[0])}</time>${ext || s[6] != null ? `<extensions>${s[6] != null ? `<power>${s[6]}</power>` : ""}${ext ? `<gpxtpx:TrackPointExtension>${ext}</gpxtpx:TrackPointExtension>` : ""}</extensions>` : ""}</trkpt>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Training ride mode" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">\n<metadata><name>${xml(ride.name)}</name><time>${iso(ride.start)}</time></metadata>\n<trk><name>${xml(ride.name)}</name><type>cycling</type><trkseg>\n${pts.join("\n")}\n</trkseg></trk>\n</gpx>\n`;
  }
  /** TCX (TrainingPeaks, older uploaders): laps, trackpoints with distance, HR, cadence, speed and watts. */
  function toTCX(ride) {
    const S = ride.samples, laps = ride.laps && ride.laps.length ? ride.laps : [{ start: ride.start, end: S.length ? S[S.length - 1][0] : ride.start }];
    const lap = l => {
      const st = stats(ride, l.start, l.end), pts = S.filter(s => s[0] >= l.start && s[0] <= l.end);
      return `<Lap StartTime="${iso(l.start)}"><TotalTimeSeconds>${((l.end - l.start) / 1000).toFixed(0)}</TotalTimeSeconds><DistanceMeters>${st.dist.toFixed(1)}</DistanceMeters><MaximumSpeed>${st.maxSpeed.toFixed(2)}</MaximumSpeed><Calories>0</Calories>${st.avgHr ? `<AverageHeartRateBpm><Value>${Math.round(st.avgHr)}</Value></AverageHeartRateBpm><MaximumHeartRateBpm><Value>${st.maxHr}</Value></MaximumHeartRateBpm>` : ""}<Intensity>Active</Intensity>${st.avgCad ? `<Cadence>${Math.round(st.avgCad)}</Cadence>` : ""}<TriggerMethod>Manual</TriggerMethod><Track>${pts.map(s => `<Trackpoint><Time>${iso(s[0])}</Time>${s[1] != null ? `<Position><LatitudeDegrees>${s[1].toFixed(7)}</LatitudeDegrees><LongitudeDegrees>${s[2].toFixed(7)}</LongitudeDegrees></Position>` : ""}${s[3] != null ? `<AltitudeMeters>${s[3].toFixed(1)}</AltitudeMeters>` : ""}${s[8] != null ? `<DistanceMeters>${s[8].toFixed(1)}</DistanceMeters>` : ""}${s[4] != null ? `<HeartRateBpm><Value>${s[4]}</Value></HeartRateBpm>` : ""}${s[5] != null ? `<Cadence>${s[5]}</Cadence>` : ""}${s[7] != null || s[6] != null ? `<Extensions><TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2">${s[7] != null ? `<Speed>${s[7].toFixed(2)}</Speed>` : ""}${s[6] != null ? `<Watts>${s[6]}</Watts>` : ""}</TPX></Extensions>` : ""}</Trackpoint>`).join("")}</Track></Lap>`;
    };
    return `<?xml version="1.0" encoding="UTF-8"?>\n<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="Biking"><Id>${iso(ride.start)}</Id>${laps.map(lap).join("")}<Notes>${xml(ride.name)}</Notes></Activity></Activities></TrainingCenterDatabase>\n`;
  }
  /** A planned route back out as GPX (to share or keep), with its turns as waypoints. */
  function routeGPX(route) {
    const pts = route.pts.map(p => `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${p.ele != null ? `<ele>${p.ele.toFixed(1)}</ele>` : ""}</trkpt>`).join("\n");
    const wpts = route.pois.map(p => `<wpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><name>${xml(p.name)}</name><type>${xml(p.kind)}</type></wpt>`).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Training ride mode" xmlns="http://www.topografix.com/GPX/1/1">\n${wpts}\n<trk><name>${xml(route.name)}</name><trkseg>\n${pts}\n</trkseg></trk>\n</gpx>\n`;
  }

  // ── tiles: the web-mercator tiles covering a corridor along the route ─────────────────────────────────────
  const tileXY = (lat, lon, z) => { const n = 2 ** z, x = (lon + 180) / 360 * n, s = Math.sin(rad(clamp(lat, -85.05, 85.05))); return [x, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n]; };
  function corridorTiles(route, zmin = 8, zmax = 14, buffer = 800) {
    const out = [];
    for (let z = zmin; z <= zmax; z++) {
      const seen = new Set(), tileM = 40075016.7 * Math.cos(rad(route.frame.lat)) / 2 ** z, spacing = Math.max(50, tileM / 3), pad = buffer / tileM;
      for (let d = 0; d <= route.total + spacing; d += spacing) {
        const p = pointAt(route, Math.min(d, route.total)), [x, y] = tileXY(p.lat, p.lon, z);
        for (let tx = Math.floor(x - pad); tx <= Math.floor(x + pad); tx++) for (let ty = Math.floor(y - pad); ty <= Math.floor(y + pad); ty++) {
          const k = `${z}/${tx}/${ty}`;
          if (!seen.has(k)) { seen.add(k); out.push({ z, x: tx, y: ty }); }
        }
      }
    }
    return out;
  }

  /** A route trimmed to what an IndexedDB row needs (the analysis is rebuilt on load). */
  const storable = (raw, extra = {}) => ({ name: raw.name, points: raw.points.map(p => [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6, p.ele == null ? null : Math.round(p.ele * 10) / 10]), marks: raw.marks || [], ...extra });
  const unstore = row => ({ id: row.id, name: row.name, points: row.points.map(p => ({ lat: p[0], lon: p[1], ele: p[2] })), marks: row.marks || [] });
  const reversed = raw => ({ ...raw, name: `${raw.name} (reversed)`, points: [...raw.points].reverse(), marks: (raw.marks || []).filter(m => !m.cue) });

  return { hav, bearing, turnAngle, parseRoute, analyze, eleAt, gradeAt, pointAt, project, navigator, fromBRouter, brouterUrl, sunTimes, kindFromAngle, TURN_WORDS, TURN_ARROWS,
    ZONES, QUICK, quick, isWork, isEasy, setOf, addRep, cutSet, extend, fitTime, ftpPct, toFIT, toGPX, toTCX, routeGPX, stats, fitCrc, corridorTiles, tileXY, storable, unstore, reversed };
})();
