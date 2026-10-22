"use strict";
// Ride mode's engine, kept free of the page so the specs can drive it directly (window.RideCore):
//   routes      GPX / TCX / GeoJSON in (read as data, never as a DOM) → distance, elevation, climbs, turns and points of interest
//   navigation  where you are on a route, off course, wrong way, what's ahead, and BRouter detours back to it
//   sun         sunrise and sunset for the place and day (light left on the ride)
//   workouts    the session tailored mid-ride: intensity, time left, one more rep, cut the set, quick workouts
//   files       the ride out as FIT (Garmin Connect, Strava, TrainingPeaks), GPX and TCX
//   tiles       the map tiles along a route, for offline use at the trailhead, and the roads in them for rerouting offline
//   trainers    FTMS and Tacx FE-C over Bluetooth: ERG watts, heart-rate ERG, the route's grade
//   battery     how long the phone lasts at this ride's drain;  sync  the ride packed for the training sync
//   pacing      a plan for a target time over the route's sections;  stamina  the fuel tank and W′ balance
//   ghosts      your own past rides on a route to race, and their climb times;  going anywhere: loops, nearby places
//   weather     rain arriving, the wind turning and storms in the next hours
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
  function project(route, p, near = null, ahead = 2500, behind = 300, strict = false) {
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
    if (!best || (best.off > 75 && !strict)) { const all = scan(0, n - 1); if (!best || all.off + 25 < best.off) best = all; }
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
    /** Where to rejoin, looking forward: places on the route ahead of both where you left it and where you are now
     *  (your position projected onto it), so a parallel road leads you on rather than back. Each is weighed by distance
     *  from here, more when it lies behind your direction of travel (×1.4 past 60°, ×2.5 past 110°), plus a third of
     *  the route it skips, plus 250 m when you'd meet the route head-on. The best three, 400 m+ apart, go to the router
     *  together (fromBRouter + pickDetour); `avoid` is just past where you left, the likely blockage (a locked gate,
     *  a closed bridge), so no way back runs through it. */
    function rejoinOptions(fix, heading = null) {
      const here = project(route, fix, st.lastOnAlong, 8000, 100, true);
      const minAlong = Math.min(route.total, Math.max(st.lastOnAlong + 150, here.along + 100));
      const all = [];
      for (let d = minAlong; d <= Math.min(route.total, minAlong + 6000); d += 50) {
        const p = pointAt(route, d), dist = hav(fix, p), brg = bearing(fix, p);
        const ang = heading == null || dist < 40 ? 0 : Math.abs(turnAngle(heading, brg));
        const against = dist > 60 && Math.abs(turnAngle(brg, p.brg)) > 120;
        all.push({ along: d, lat: p.lat, lon: p.lon, dist, cost: dist * (ang > 110 ? 2.5 : ang > 60 ? 1.4 : 1) + (d - minAlong) * 0.3 + (against ? 250 : 0) });
      }
      all.sort((a, b) => a.cost - b.cost);
      const options = [];
      for (const c of all) if (options.length < 3 && options.every(o => Math.abs(o.along - c.along) >= 400)) options.push(c);
      if (!options.length) options.push({ along: route.total, ...pointAt(route, route.total), dist: hav(fix, route.pts[route.pts.length - 1]), cost: 0 });
      const left = pointAt(route, Math.min(route.total, st.lastOnAlong + 60));
      return { options, minAlong, avoid: st.lastOnAlong > 0 && st.lastOnAlong < route.total - 100 ? { lat: left.lat, lon: left.lon, r: 40 } : null };
    }
    const rejoin = (fix, heading = null) => rejoinOptions(fix, heading).options[0];
    const toRoute = fix => { const p = pointAt(route, project(route, fix, st.lastOnAlong).along); return { dist: hav(fix, p), brg: bearing(fix, p), lat: p.lat, lon: p.lon }; };
    return { update, status, callouts, rejoin, rejoinOptions, toRoute, state: st, seek(along) { st.along = along; st.lastOnAlong = along; st.said.clear(); } };
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
  const brouterUrl = (from, to, profile = "trekking", server = "https://brouter.de/brouter", nogos = []) =>
    `${server}?lonlats=${from.lon.toFixed(6)},${from.lat.toFixed(6)}|${to.lon.toFixed(6)},${to.lat.toFixed(6)}&profile=${encodeURIComponent(profile)}&alternativeidx=0&format=geojson&timode=3`
    + (nogos.length ? `&nogos=${nogos.map(g => `${g.lon.toFixed(6)},${g.lat.toFixed(6)},${Math.round(g.r)}`).join("|")}` : "");
  /** The best of several ways back (parsed BRouter routes, one per rejoin option): the shortest ride once a U-turn at the
   *  start (600 m), arriving against the route's direction (300 m) and a third of the route skipped are counted in.
   *  @returns {{detour: any, option: any, score: number} | null} */
  function pickDetour(route, tries, heading = null, minAlong = 0) {
    let best = null;
    for (const { detour, option } of tries) {
      if (!detour) continue;
      const a = detour.pts[0], b = pointAt(detour, Math.min(detour.total, 80));
      const back = heading != null && detour.total > 80 && Math.abs(turnAngle(heading, bearing(a, b))) > 110;
      const end = detour.pts[detour.pts.length - 1], before = pointAt(detour, Math.max(0, detour.total - 60));
      const against = detour.total > 60 && Math.abs(turnAngle(bearing(before, end), pointAt(route, option.along).brg)) > 135;
      const score = detour.total + (back ? 600 : 0) + (against ? 300 : 0) + Math.max(0, option.along - minAlong) * 0.3;
      if (!best || score < best.score) best = { detour, option, score, back, against };
    }
    return best;
  }

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

  // ── the commute check: the same road every day makes heart rate at a speed a daily fitness reading ───────────
  /** Judged on steady riding only. City riding (stops, lights, sprints away from them) puts heart rate out of step with
   *  speed, so: samples count only when rolling 15 km/h+ at an even speed a minute or more after a stop (the caller marks
   *  them `steady`), it needs 4 minutes of those in the last 8, and 4+ stops in the last 10 minutes means stop-and-go:
   *  no verdict at all. Hot is 8+ bpm over what this leg usually costs at that speed; fresh is 5+ under.
   *  @param {{t: number, hr: number, kmh: number, steady: boolean}[]} samples  t in seconds of ride time
   *  @param {any} model  cfg.commute[leg]: {model: [a, b]} (HR = a + b × km/h) or {hr, speed}
   *  @param {number[]} stops  ride-time seconds each stop began */
  function commuteCheck(samples, model, stops, now) {
    if (!model || now < 480) return null;
    if (stops.filter(t => t > now - 600).length >= 4) return { verdict: "city" };
    const recent = samples.filter(x => x.steady && x.t > now - 480);
    if (recent.length < 240) return null;
    const hr = recent.reduce((a, x) => a + x.hr, 0) / recent.length, kmh = recent.reduce((a, x) => a + x.kmh, 0) / recent.length;
    let usual = null;
    if (Array.isArray(model.model)) usual = model.model[0] + model.model[1] * kmh;
    else if (model.hr && Math.abs(kmh - model.speed) < 1.5) usual = model.hr;
    if (usual == null) return null;
    const diff = hr - usual;
    return { diff, kmh, verdict: diff >= 8 ? "hot" : diff <= -5 ? "fresh" : "normal", minutes: recent.length / 60 };
  }

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

  // ── the map at night: OpenFreeMap's day style turned dark, the way a bike computer's night mode is ───────────
  // Every color in the style's paint is flipped in lightness (paper becomes near-black, dark labels become light) and
  // calmed a little, so the route and your position are the brightest things on the screen.
  const COLOR_KEYS = new Set(["background-color", "fill-color", "fill-outline-color", "line-color", "text-color", "text-halo-color", "icon-color", "icon-halo-color",
    "circle-color", "circle-stroke-color", "fill-extrusion-color", "hillshade-shadow-color", "hillshade-highlight-color", "hillshade-accent-color"]);
  function parseColor(c) {
    let m = /^#([0-9a-f]{3,8})$/i.exec(c);
    if (m) {
      let h = m[1];
      if (h.length <= 4) h = [...h].map(x => x + x).join("");
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
    }
    if ((m = /^rgba?\(([^)]+)\)$/i.exec(c))) { const v = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat); return [v[0], v[1], v[2], v[3] ?? 1]; }
    if ((m = /^hsla?\(([^)]+)\)$/i.exec(c))) {
      const v = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat), hh = v[0] / 360, ss = v[1] / 100, ll = v[2] / 100;
      const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss, p = 2 * ll - q;
      const f = t => { t = (t + 1) % 1; return 255 * (t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p); };
      return [f(hh + 1 / 3), f(hh), f(hh - 1 / 3), v[3] ?? 1];
    }
    return null;
  }
  function nightColor(c) {
    const rgb = typeof c === "string" ? parseColor(c.trim()) : null;
    if (!rgb) return c;
    const [r, g, b, a] = rgb.map((x, i) => (i < 3 ? x / 255 : x)), mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    const d = mx - mn, sat = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
    let h = 0;
    if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    const L = 0.05 + (1 - l) * 0.82, S = sat * 0.6;
    return `hsla(${Math.round((h * 60 + 360) % 360)}, ${Math.round(S * 100)}%, ${Math.round(L * 100)}%, ${Math.round(a * 100) / 100})`;
  }
  const nightValue = v => Array.isArray(v) ? v.map(nightValue) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, nightValue(x)])) : nightColor(v);
  /** A copy of a MapLibre style with its paint colors at night. */
  function nightStyle(style) {
    const out = JSON.parse(JSON.stringify(style));
    for (const l of out.layers || []) {
      if (!l.paint) continue;
      for (const k of Object.keys(l.paint)) if (COLOR_KEYS.has(k)) l.paint[k] = nightValue(l.paint[k]);
    }
    return out;
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

  // ── smart trainers: FTMS (the Bluetooth standard) and Tacx's FE-C over Bluetooth (Flow Smart, Vortex, Bushido, Neo) ──
  // The Tacx bridge takes ANT+ FE-C pages wrapped in ANT messages on its write characteristic and sends the trainer's
  // pages back the same way; FTMS has its own control point and an Indoor Bike Data stream.
  const FTMS = { service: 0x1826, data: 0x2ad2, control: 0x2ad9, status: 0x2ada };
  const TACX = { service: "6e40fec1-b5a3-f393-e0a9-e50e24dcca9e", rx: "6e40fec2-b5a3-f393-e0a9-e50e24dcca9e", tx: "6e40fec3-b5a3-f393-e0a9-e50e24dcca9e" };
  /** One FE-C page as an ANT acknowledged-data message on channel 5 (sync, length, type, channel, 8 bytes, XOR). */
  function fecMsg(page) {
    const m = new Uint8Array(13);
    m[0] = 0xA4; m[1] = 9; m[2] = 0x4F; m[3] = 5; m.set(page.slice(0, 8), 4);
    let x = 0; for (let i = 0; i < 12; i++) x ^= m[i];
    m[12] = x;
    return m;
  }
  const u16 = v => [v & 0xFF, (v >> 8) & 0xFF];
  /** Page 49, target power (ERG): 0.25 W units. */
  const fecPower = w => fecMsg([0x31, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, ...u16(Math.round(clamp(w, 0, 4000) * 4))]);
  /** Page 51, track resistance (the route's grade): 0.01 % from −200 %, rolling resistance in 5×10⁻⁵ units. */
  const fecGrade = (pct, crr = 0.004) => fecMsg([0x33, 0xFF, 0xFF, 0xFF, 0xFF, ...u16(Math.round((clamp(pct, -200, 200) + 200) * 100)), Math.round(clamp(crr, 0, 0.0127) / 5e-5)]);
  /** Page 48, basic resistance: 0.5 % units of the brake's range. */
  const fecLevel = pct => fecMsg([0x30, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, Math.round(clamp(pct, 0, 100) * 2)]);
  /** Page 55, user configuration: rider and bike weight and wheel size, which simulation needs to feel right. */
  function fecUser(riderKg = 75, bikeKg = 9, wheelM = 2.096) {
    const w = Math.round(clamp(riderKg, 10, 650) * 100), b = Math.round(clamp(bikeKg, 1, 50) / 0.05), d = Math.round(wheelM / Math.PI * 100);
    return fecMsg([0x37, w & 0xFF, w >> 8, 0xFF, 0x0F | ((b & 0x0F) << 4), b >> 4, d, 0x00]);
  }
  /** A message from the Tacx bridge → the trainer's figures. Page 16 (general: speed, distance, HR) and page 25
   *  (trainer: power, cadence, and whether it can hold the ERG target at this wheel speed).
   *  @param {DataView} dv @returns {any} */
  function parseFec(dv) {
    if (dv.byteLength < 12 || dv.getUint8(0) !== 0xA4) return null;
    const p = i => dv.getUint8(4 + i), page = p(0);
    if (page === 0x10) {
      const sp = p(4) | (p(5) << 8), hr = p(6);
      return { page, speed: sp === 0xFFFF ? null : sp / 1000, dist: p(3), hr: hr > 0 && hr < 0xFF ? hr : null, elapsed: p(2) / 4 };
    }
    if (page === 0x19) {
      const cad = p(2), w = p(5) | ((p(6) & 0x0F) << 8), flags = p(7) & 0x03;
      return { page, cadence: cad === 0xFF ? null : cad, power: w === 0xFFF ? null : w, calibrate: (p(6) >> 4) & 0x03,
        limit: flags === 1 ? "slow" : flags === 2 ? "fast" : flags === 3 ? "max" : null };
    }
    return { page };
  }
  /** FTMS Indoor Bike Data → speed (m/s), cadence, power, heart rate; the flags say which fields follow.
   *  @param {DataView} dv */
  function parseBikeData(dv) {
    const f = dv.getUint16(0, true), out = { speed: null, cadence: null, power: null, hr: null };
    let i = 2;
    if (!(f & 1)) { out.speed = dv.getUint16(i, true) / 360; i += 2; }   // 0.01 km/h
    if (f & 2) i += 2;
    if (f & 4) { out.cadence = Math.round(dv.getUint16(i, true) / 2); i += 2; }
    if (f & 8) i += 2;
    if (f & 16) i += 3;
    if (f & 32) i += 2;
    if (f & 64) { out.power = dv.getInt16(i, true); i += 2; }
    if (f & 128) i += 2;
    if (f & 256) i += 5;
    if (f & 512) out.hr = dv.getUint8(i);
    return out;
  }
  /** FTMS control point requests: take control, start, ERG watts, simulation grade (with wind 0, Crr, CdA), level. */
  const ftms = {
    control: () => Uint8Array.of(0x00), start: () => Uint8Array.of(0x07),
    power: w => Uint8Array.of(0x05, ...u16(Math.round(clamp(w, 0, 4000)))),
    grade: (pct, crr = 0.004, cw = 0.51) => { const g = Math.round(clamp(pct, -40, 40) * 100) & 0xFFFF; return Uint8Array.of(0x11, 0, 0, g & 0xFF, g >> 8, Math.round(crr / 0.0001), Math.round(cw / 0.01)); },
  };
  /** ERG watts for a step from FTP: the middle of its power range (or 85 % of its cap), with the session's intensity. */
  const ergWatts = (s, ftp, k = 1) => {
    if (!s || !(ftp > 0)) return null;
    const kk = isWork(s) ? k : 1, mid = s.lo > 0 ? (ftpPct(s.lo * kk) + ftpPct(s.hi * kk)) / 2 : ftpPct(s.hi) * 0.85;
    return Math.round(ftp * mid / 100);
  };
  /** Heart-rate ERG, for a rider with no FTP: the trainer's watts are nudged every 20 s toward the middle of the step's
   *  heart-rate range. Heart rate lags a minute or two, so the steps are small, and over the top end cuts quicker. */
  function hrErg(w, hr, lo, hi, since) {
    if (hr == null || since < 20) return w;
    const mid = lo > 0 ? (lo + hi) / 2 : hi - 6, err = mid - hr;
    let d = Math.abs(err) <= 2 ? 0 : clamp(err * 0.8, -10, 8);
    if (hr > hi + 3) d = Math.min(d, -12);
    return clamp(Math.round(w + d), 40, 500);
  }
  /** A first guess at the watts for a heart-rate band before the controller has learned it (% of LTHR → W). */
  const ergGuess = pct => Math.round(pct < 81 ? 95 : pct < 90 ? 135 : pct < 94 ? 175 : pct < 100 ? 205 : 240);

  // ── offline rerouting: the road network from the map tiles already on the phone (OpenMapTiles vector tiles) ─────
  /** A protobuf reader, just enough for Mapbox Vector Tiles. */
  function pbf(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let pos = 0;
    const varint = () => { let v = 0, m = 1, x; do { x = b[pos++]; v += (x & 0x7F) * m; m *= 128; } while (x & 0x80 && pos < b.length); return v; };
    return {
      get pos() { return pos; }, set pos(p) { pos = p; }, len: b.length, varint,
      svarint: () => { const v = varint(); return v % 2 ? -(v + 1) / 2 : v / 2; },
      bytes: () => { const n = varint(), s = b.subarray(pos, pos + n); pos += n; return s; },
      fixed: n => { const s = b.subarray(pos, pos + n); pos += n; return s; },
      skip: wt => { if (wt === 0) varint(); else if (wt === 1) pos += 8; else if (wt === 2) pos += varint(); else if (wt === 5) pos += 4; else throw new Error("bad tile"); },
    };
  }
  const utf8 = new TextDecoder();
  function mvtValue(bytes) {
    const r = pbf(bytes);
    let v = null;
    while (r.pos < r.len) {
      const tag = r.varint(), f = tag >> 3, wt = tag & 7;
      if (f === 1) v = utf8.decode(r.bytes());
      else if (f === 2) { const s = r.fixed(4); v = new DataView(s.buffer, s.byteOffset, 4).getFloat32(0, true); }
      else if (f === 3) { const s = r.fixed(8); v = new DataView(s.buffer, s.byteOffset, 8).getFloat64(0, true); }
      else if (f === 4 || f === 5) v = r.varint();
      else if (f === 6) v = r.svarint();
      else if (f === 7) v = !!r.varint();
      else r.skip(wt);
    }
    return v;
  }
  /** A vector tile → its line features in the given layers, as lon/lat with their properties. Points along a line
   *  that sit outside the tile (the buffer, where clipping cut it) are flagged so the graph can join tiles there.
   *  @returns {Record<string, {props: any, coords: number[][], clipped: boolean[]}[]>} */
  function mvtLines(buf, z, x, y, want = ["transportation", "transportation_name"]) {
    const out = {};
    for (const w of want) out[w] = [];
    const r = pbf(buf);
    while (r.pos < r.len) {
      const tag = r.varint();
      if (tag >> 3 !== 3 || (tag & 7) !== 2) { r.skip(tag & 7); continue; }
      const L = pbf(r.bytes());
      let name = "", extent = 4096;
      const keys = [], vals = [], feats = [];
      while (L.pos < L.len) {
        const t = L.varint(), f = t >> 3;
        if (f === 1) name = utf8.decode(L.bytes());
        else if (f === 2) feats.push(L.bytes());
        else if (f === 3) keys.push(utf8.decode(L.bytes()));
        else if (f === 4) vals.push(mvtValue(L.bytes()));
        else if (f === 5) extent = L.varint();
        else L.skip(t & 7);
      }
      if (!want.includes(name)) continue;
      const n = 2 ** z, toLL = (px, py) => {
        const lon = (x + px / extent) / n * 360 - 180, yy = Math.PI * (1 - 2 * (y + py / extent) / n);
        return [lon, deg(Math.atan(Math.sinh(yy)))];
      };
      for (const fb of feats) {
        const F = pbf(fb);
        let type = 0, tags = [], geom = [];
        while (F.pos < F.len) {
          const t = F.varint(), f = t >> 3;
          if (f === 2 || f === 4) { const p = pbf(F.bytes()), arr = []; while (p.pos < p.len) arr.push(p.varint()); if (f === 2) tags = arr; else geom = arr; }
          else if (f === 3) type = F.varint();
          else F.skip(t & 7);
        }
        if (type !== 2) continue;
        const props = {};
        for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = vals[tags[i + 1]];
        let cx = 0, cy = 0, i = 0, line = null;
        const zz = v => (v % 2 ? -(v + 1) / 2 : v / 2);
        while (i < geom.length) {
          const c = geom[i++], id = c & 7, cnt = c >> 3;
          if (id === 1 || id === 2) {
            for (let k = 0; k < cnt; k++) {
              cx += zz(geom[i++]); cy += zz(geom[i++]);
              if (id === 1) { if (line && line.coords.length > 1) out[name].push(line); line = { props, coords: [], clipped: [] }; }
              line.coords.push(toLL(cx, cy)); line.clipped.push(cx <= 0 || cy <= 0 || cx >= extent || cy >= extent);
            }
          } else if (id === 7) { /* ClosePath: lines have none */ }
        }
        if (line && line.coords.length > 1) out[name].push(line);
      }
    }
    return out;
  }
  // What a bike pays per metre on each kind of way (OpenMapTiles classes); motorways are left out altogether.
  const WAY_COST = { trunk: 2.6, primary: 1.6, secondary: 1.3, tertiary: 1.1, minor: 1, service: 1.2, track: 1.35, path: 1.15, busway: 1.2, raceway: 3 };
  const PATH_COST = { cycleway: 0.85, footway: 1.5, pedestrian: 1.5, steps: 6, bridleway: 1.6, platform: 5 };
  /** The rideable road network from decoded tiles: nodes where lines share a point (to ~1 m), plus joins where a
   *  line ends on another (a tile edge, or a junction the tile's simplification dropped). One-ways are kept one way.
   *  @param {{props: any, coords: number[][], clipped?: boolean[]}[]} lines @param {{lat: number, lon: number, r: number}[]} avoid */
  function roadGraph(lines, avoid = []) {
    const nodes = [], adj = [], key = new Map();
    const lat0 = lines.length ? lines[0].coords[0][1] : 0, kx = R * rad(1) * Math.cos(rad(lat0)), ky = R * rad(1);
    const node = c => {
      const k = `${Math.round(c[0] * kx)}:${Math.round(c[1] * ky)}`;   // ~1 m cells
      let i = key.get(k);
      if (i === undefined) { i = nodes.length; key.set(k, i); nodes.push({ lon: c[0], lat: c[1], x: c[0] * kx, y: c[1] * ky, deg: 0 }); adj.push([]); }
      return i;
    };
    const blocked = (a, b) => avoid.some(g => { const m = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 }; return hav(a, g) < g.r || hav(b, g) < g.r || hav(m, g) < g.r; });
    const segs = [];
    const link = (a, b, cost, oneway, name) => {
      if (a === b) return;
      const A = nodes[a], B = nodes[b], len = Math.hypot(A.x - B.x, A.y - B.y);
      if (blocked(A, B)) return;
      if (oneway !== -1) adj[a].push({ to: b, len, cost: len * cost, name });
      if (oneway !== 1) adj[b].push({ to: a, len, cost: len * cost, name });
      A.deg++; B.deg++;
      segs.push({ a, b, cost, oneway, name });
    };
    const ends = [];
    for (const l of lines) {
      const p = l.props || {}, cls = String(p.class || "").replace(/_construction$/, "");
      if (p.bicycle === "no" || p.access === "no" || /construction/.test(String(p.class || ""))) continue;
      let cost = cls === "path" ? PATH_COST[p.subclass] ?? WAY_COST.path : WAY_COST[cls];
      if (cost == null) continue;
      if (p.bicycle === "designated" || p.bicycle === "yes") cost = Math.min(cost, 0.95);
      const oneway = p.oneway === 1 || p.oneway === -1 ? p.oneway : 0, name = p.name || p["name:latin"] || p.ref || "";
      const ids = l.coords.map(node);
      for (let i = 1; i < ids.length; i++) link(ids[i - 1], ids[i], cost, oneway, name);
      ends.push(ids[0], ids[ids.length - 1]);
    }
    // a line that ends on (not at a point of) another line: split that segment there and join them
    const cell = 40, grid = new Map(), gk = (x, y) => `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
    segs.forEach((s, i) => {
      const A = nodes[s.a], B = nodes[s.b];
      for (let gx = Math.floor(Math.min(A.x, B.x) / cell); gx <= Math.floor(Math.max(A.x, B.x) / cell); gx++)
        for (let gy = Math.floor(Math.min(A.y, B.y) / cell); gy <= Math.floor(Math.max(A.y, B.y) / cell); gy++) { const k = `${gx}:${gy}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); }
    });
    for (const e of new Set(ends)) {
      const E = nodes[e];
      if (E.deg !== 1) continue;
      let best = null;
      const near = new Set();
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const i of grid.get(gk(E.x + dx * cell, E.y + dy * cell)) || []) near.add(i);
      for (const i of near) {
        const s = segs[i];
        if (s.a === e || s.b === e) continue;
        const A = nodes[s.a], B = nodes[s.b], dx = B.x - A.x, dy = B.y - A.y, L = dx * dx + dy * dy;
        const t = L > 0 ? clamp(((E.x - A.x) * dx + (E.y - A.y) * dy) / L, 0, 1) : 0, d = Math.hypot(A.x + t * dx - E.x, A.y + t * dy - E.y);
        if (d < 2.5 && (!best || d < best.d)) best = { d, s, t };
      }
      if (!best) continue;
      const { s, t } = best;
      if (t < 0.02 || t > 0.98) { link(e, t < 0.5 ? s.a : s.b, s.cost, 0, s.name); continue; }
      link(e, s.a, s.cost, s.oneway === 1 ? -1 : s.oneway === -1 ? 1 : 0, s.name);   // E→A runs against A→B
      link(e, s.b, s.cost, s.oneway, s.name);
    }
    return { nodes, adj, kx, ky };
  }
  /** Street names onto the road lines (OpenMapTiles keeps them in a separate layer, transportation_name): each line
   *  takes the name of the named line that runs along its middle, within 8 m. */
  function nameRoads(lines, named) {
    if (!named.length) return lines;
    const lat0 = named[0].coords[0][1], kx = R * rad(1) * Math.cos(rad(lat0)), ky = R * rad(1), cell = 60, grid = new Map();
    named.forEach((l, li) => {
      const nm = l.props && (l.props.name || l.props["name:latin"] || l.props.ref);
      if (!nm) return;
      for (let i = 0; i + 1 < l.coords.length; i++) {
        const a = l.coords[i], b = l.coords[i + 1];
        for (let gx = Math.floor(Math.min(a[0], b[0]) * kx / cell); gx <= Math.floor(Math.max(a[0], b[0]) * kx / cell); gx++)
          for (let gy = Math.floor(Math.min(a[1], b[1]) * ky / cell); gy <= Math.floor(Math.max(a[1], b[1]) * ky / cell); gy++) {
            const k = `${gx}:${gy}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push([li, i, nm]);
          }
      }
    });
    return lines.map(l => {
      if (l.props && l.props.name) return l;
      const k = Math.floor(l.coords.length / 2), m = l.coords.length % 2 ? l.coords[k] : [(l.coords[k - 1][0] + l.coords[k][0]) / 2, (l.coords[k - 1][1] + l.coords[k][1]) / 2];
      const x = m[0] * kx, y = m[1] * ky;
      let best = null;
      for (const [li, i, nm] of grid.get(`${Math.floor(x / cell)}:${Math.floor(y / cell)}`) || []) {
        const a = named[li].coords[i], b = named[li].coords[i + 1], ax = a[0] * kx, ay = a[1] * ky, dx = b[0] * kx - ax, dy = b[1] * ky - ay, L = dx * dx + dy * dy;
        const t = L > 0 ? clamp(((x - ax) * dx + (y - ay) * dy) / L, 0, 1) : 0, d = Math.hypot(ax + t * dx - x, ay + t * dy - y);
        if (d < 8 && (!best || d < best.d)) best = { d, nm };
      }
      return best ? { ...l, props: { ...l.props, name: best.nm } } : l;
    });
  }
  /** A place joined to the graph at the nearest point of the nearest way (within `max` m): a new node there, linked
   *  both ways the way itself runs. */
  function attach(g, p, max = 80) {
    const x = p.lon * g.kx, y = p.lat * g.ky;
    let best = null;
    g.adj.forEach((list, i) => {
      const A = g.nodes[i];
      if (Math.abs(A.x - x) > 3000 || Math.abs(A.y - y) > 3000) return;
      for (const e of list) {
        const B = g.nodes[e.to], dx = B.x - A.x, dy = B.y - A.y, L = dx * dx + dy * dy;
        const t = L > 0 ? clamp(((x - A.x) * dx + (y - A.y) * dy) / L, 0, 1) : 0, d = Math.hypot(A.x + t * dx - x, A.y + t * dy - y);
        if (d < max && (!best || d < best.d)) best = { d, a: i, e, t };
      }
    });
    if (!best) return null;
    const { a, e, t } = best, b = e.to, A = g.nodes[a], B = g.nodes[b];
    const k = g.nodes.length;
    g.nodes.push({ lon: (A.lon + (B.lon - A.lon) * t), lat: A.lat + (B.lat - A.lat) * t, x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t, deg: 2 });
    g.adj.push([]);
    const part = (from, to, f, edge) => g.adj[from].push({ to, len: edge.len * f, cost: edge.cost * f, name: edge.name });
    part(a, k, t, e); part(k, b, 1 - t, e);
    const back = g.adj[b].find(x => x.to === a);
    if (back) { part(b, k, 1 - t, back); part(k, a, t, back); }
    return { i: k, d: best.d };
  }
  /** Shortest (cheapest) ways from one place to several goals over the graph (Dijkstra with a binary heap).
   *  @returns {({points: {lat: number, lon: number}[], names: {along: number, name: string}[], len: number, cost: number} | null)[]} */
  function shortestWays(g, from, goals, maxCost = 20000) {
    const s = attach(g, from), targets = goals.map(p => attach(g, p, 60));
    if (!s) return goals.map(() => null);
    const n = g.nodes.length, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), via = new Array(n);
    const want = new Set(targets.filter(Boolean).map(t => t.i));
    const heap = [];
    const push = (d, i) => { heap.push([d, i]); let k = heap.length - 1; while (k) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
    dist[s.i] = s.d * 1.2; push(dist[s.i], s.i);
    while (heap.length && want.size) {
      const [d, i] = pop();
      if (d > dist[i]) continue;
      if (d > maxCost) break;
      want.delete(i);
      for (const e of g.adj[i]) { const nd = d + e.cost; if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = i; via[e.to] = e; push(nd, e.to); } }
    }
    return targets.map((t, k) => {
      if (!t || !Number.isFinite(dist[t.i])) return null;
      const path = [];
      for (let i = t.i; i >= 0; i = prev[i]) path.push(i);
      path.reverse();
      const points = [{ lat: from.lat, lon: from.lon }], names = [];
      let len = s.d;
      for (let j = 0; j < path.length; j++) {
        const nd = g.nodes[path[j]];
        if (j) { const e = via[path[j]]; len += e.len; if (e.name && (!names.length || names[names.length - 1].name !== e.name)) names.push({ along: len - e.len, name: e.name }); }
        points.push({ lat: nd.lat, lon: nd.lon });
      }
      points.push({ lat: goals[k].lat, lon: goals[k].lon });
      return { points, names, len: len + t.d, cost: dist[t.i] + t.d };
    });
  }
  /** A way found offline → a route ride mode can follow, turns named after the road they turn onto. */
  function fromWay(way, name = "Back to the route") {
    const r = analyze({ name, points: way.points.map(p => ({ ...p, ele: null })), marks: [] });
    for (const t of r.turns) {
      const on = way.names.filter(x => x.along <= t.along + 20).pop();
      if (on && on.along >= t.along - 25) t.name = on.name;
      t.src = "offline";
    }
    return r;
  }
  /** The z14 tiles covering a few places (and a margin around them, m). */
  function tilesAround(points, margin = 400, z = 14) {
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (const p of points) { minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat); minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon); }
    const dLat = margin / (R * rad(1)), dLon = margin / (R * rad(1) * Math.cos(rad((minLat + maxLat) / 2)));
    const [x0, y0] = tileXY(maxLat + dLat, minLon - dLon, z), [x1, y1] = tileXY(minLat - dLat, maxLon + dLon, z), out = [];
    for (let x = Math.floor(x0); x <= Math.floor(x1); x++) for (let y = Math.floor(y0); y <= Math.floor(y1); y++) out.push({ z, x, y });
    return out.length > 36 ? out.slice(0, 36) : out;
  }

  // ── battery: how long the phone lasts at the rate it's draining on this ride ──────────────────────────────
  /** From [time ms, level 0–1, charging] readings: the drain per hour since it last charged (a least-squares line
   *  over the last 45 min, once 10 min and 2 % have passed) and when it reaches 5 %. */
  function batteryForecast(log, now = Date.now()) {
    let from = 0;
    for (let i = 0; i < log.length; i++) if (log[i][2]) from = i + 1;
    const xs = log.slice(from).filter(r => r[0] >= now - 45 * 60e3);
    if (xs.length < 2) return null;
    const span = (xs[xs.length - 1][0] - xs[0][0]) / 3600e3, drop = xs[0][1] - xs[xs.length - 1][1];
    if (span < 1 / 6 || drop < 0.02) return null;
    const mx = xs.reduce((a, r) => a + r[0], 0) / xs.length, my = xs.reduce((a, r) => a + r[1], 0) / xs.length;
    let sxy = 0, sxx = 0;
    for (const r of xs) { sxy += (r[0] - mx) * (r[1] - my); sxx += (r[0] - mx) ** 2; }
    const perHour = -(sxy / sxx) * 3600e3, level = xs[xs.length - 1][1];
    if (!(perHour > 0.002)) return null;
    const hours = Math.max(0, (level - 0.05) / perHour);
    return { perHour, hours, until: now + hours * 3600e3, level };
  }

  // ── the ride, packed for the sync: summary + samples every few seconds, as delta-coded columns ───────────────
  /** A recorded ride → a small object for the sync (GitHub carries it as one workflow input, so it must stay well under
   *  64 KB once deflated and base64'd): HR, power, cadence and speed averaged over `step` seconds, position, height
   *  and distance at the end of each. */
  function rideDigest(meta, samples, step = 5) {
    const col = { t: [], hr: [], pw: [], cad: [], v: [], lat: [], lon: [], ele: [], d: [] };
    const t0 = samples.length ? samples[0][0] : meta.start;
    const avg = (xs, i) => { const v = xs.map(s => s[i]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    let k = 0;
    while (k < samples.length) {
      const b = [samples[k]];
      while (k + b.length < samples.length && samples[k + b.length][0] - samples[k][0] < step * 1000) b.push(samples[k + b.length]);
      const last = b[b.length - 1], fix = [...b].reverse().find(s => s[1] != null), ele = [...b].reverse().find(s => s[3] != null);
      const r = x => (x == null ? null : Math.round(x));
      col.t.push(Math.round((last[0] - t0) / 1000)); col.hr.push(r(avg(b, 4))); col.cad.push(r(avg(b, 5))); col.pw.push(r(avg(b, 6)));
      const v = avg(b, 7); col.v.push(v == null ? null : Math.round(v * 10));
      col.lat.push(fix ? Math.round(fix[1] * 1e5) : null); col.lon.push(fix ? Math.round(fix[2] * 1e5) : null);
      col.ele.push(ele ? Math.round(ele[3] * 10) : null); col.d.push(r(last[8]));
      k += b.length;
    }
    const delta = xs => { let p = 0; return xs.map(x => { if (x == null) return null; const d = x - p; p = x; return d; }); };
    for (const c of ["t", "lat", "lon", "ele", "d"]) col[c] = delta(col[c]);
    const n = x => (Number.isFinite(+x) && x != null ? Math.round(+x * 10) / 10 : null);
    return { v: 1, id: String(meta.id), name: String(meta.name || "Ride").slice(0, 80), start: Math.round(meta.start), t0: Math.round(t0), end: Math.round(meta.end), step,
      elapsed: n(meta.elapsed), moving: n(meta.moving), dist: n(meta.dist), ascent: n(meta.ascent), avgHr: n(meta.avgHr), maxHr: n(meta.maxHr), avgPower: n(meta.avgPower),
      avgCad: n(meta.avgCad), tss: n(meta.tss), indoor: !!meta.indoor, trainer: !!meta.trainer, zones: (meta.zones || []).map(z => Math.round(z)), s: col };
  }

  // ── pacing: a plan for a target time over the route's sections (Garmin's Power Guide / PacePro) ─────────────
  const GRAV = 9.80665;
  /** Rolling resistance, frontal area and the fastest it's sensible to go down a hill, by surface. */
  const SURFACE = { road: { crr: 0.005, cda: 0.36, maxV: 16 }, gravel: { crr: 0.008, cda: 0.40, maxV: 13 }, mtb: { crr: 0.014, cda: 0.45, maxV: 9 } };
  /** The speed (m/s) a power holds on a grade, for a mass and a surface: the power balance solved by bisection. */
  const powerFor = (v, grade, o) => { const th = Math.atan(grade); return (o.mass * GRAV * (o.crr * Math.cos(th) + Math.sin(th)) * v + 0.6 * o.cda * v ** 3) / 0.97; };
  function speedFor(watts, grade, o) {
    const need = v => powerFor(v, grade, o);
    let lo = 0.8, hi = grade < -0.02 ? o.maxV : 25;   // only a descent is held to what's safe on the surface
    if (need(hi) <= watts) return hi;
    if (need(lo) >= watts) return lo;
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (need(m) > watts) hi = m; else lo = m; }
    return (lo + hi) / 2;
  }
  /** The route as sections of like grade: climbs (3 %+), descents (−3 % or steeper) and the rest, 400 m or longer. */
  function sections(route) {
    const total = route.total, out = [], chunk = 100;
    for (let d = 0; d < total; d += chunk) {
      const e = Math.min(total, d + chunk), a = eleAt(route, d), b = eleAt(route, e), g = a == null || b == null || e - d < 1 ? 0 : (b - a) / (e - d);
      const kind = g >= 0.03 ? "climb" : g <= -0.03 ? "descent" : "flat", last = out[out.length - 1];
      if (last && last.kind === kind) last.to = e; else out.push({ kind, from: d, to: e });
    }
    for (let i = 0; i < out.length; i++) {   // a short section joins the one before it (or the one after, at the start)
      if (out.length > 1 && out[i].to - out[i].from < 400) {
        if (i > 0) { out[i - 1].to = out[i].to; out.splice(i, 1); } else { out[1].from = out[0].from; out.splice(0, 1); }
        i = Math.max(-1, i - 2);
      }
    }
    for (let i = 1; i < out.length; i++) if (out[i].kind === out[i - 1].kind) { out[i - 1].to = out[i].to; out.splice(i, 1); i--; }
    return out.map(s => {
      const len = s.to - s.from, a = eleAt(route, s.from), b = eleAt(route, s.to), grade = a == null || b == null ? 0 : (b - a) / len;
      return { ...s, len, grade, kind: grade >= 0.03 ? "climb" : grade <= -0.03 ? "descent" : "flat" };
    });
  }
  /** How much harder than the base effort a grade is ridden: more up the climbs, less down (capped −45 % / +25 %). */
  const lean = g => clamp(1 + 2.2 * g, 0.55, 1.25);
  /** What fraction of FTP can be held for a ride this long (≈ 100 % for an hour, 90 % for two, 79 % for four). */
  const sustainable = hours => clamp(1 - 0.15 * Math.log(Math.max(0.25, hours)), 0.6, 1.05);
  /** A pacing plan: base watts found so the sections add up to the target time; each section's watts, speed, time,
   *  and the clock at its end; normalised power and intensity against FTP, and what's sustainable that long.
   *  @param {{target: number, ftp: number, mass: number, surface?: string}} opt  target in seconds */
  function pacePlan(route, { target, ftp, mass, surface = "gravel" }) {
    const o = { mass, ...(SURFACE[surface] || SURFACE.gravel) }, secs = sections(route);
    const timeAt = p0 => secs.reduce((a, s) => a + s.len / speedFor(p0 * lean(s.grade), s.grade, o), 0);
    let lo = 10, hi = 2000;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (timeAt(m) > target) lo = m; else hi = m; }
    const p0 = hi;
    let cum = 0, w4 = 0;
    const out = secs.map(s => {
      const v = speedFor(p0 * lean(s.grade), s.grade, o), watts = Math.max(0, Math.min(p0 * lean(s.grade), powerFor(v, s.grade, o))), t = s.len / v;   // a capped descent: only what it takes
      cum += t; w4 += watts ** 4 * t;
      return { ...s, watts: Math.round(watts), speed: v, secs: t, end: cum };
    });
    const np = cum > 0 ? (w4 / cum) ** 0.25 : 0;
    return { sections: out, base: Math.round(p0), total: cum, target, np: Math.round(np), if: ftp > 0 ? np / ftp : null, sustain: sustainable(cum / 3600), surface, ftp, mass };
  }
  /** The fastest target a rider can hold: where the plan's intensity meets what's sustainable for its length. */
  function paceSuggest(route, opt) {
    let lo = 60, hi = 24 * 3600;
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2, p = pacePlan(route, { ...opt, target: m }); if (p.if > p.sustain) lo = m; else hi = m; }
    return Math.ceil(hi / 60) * 60;
  }
  /** Where a distance along the route falls in the plan: its section, and the clock the plan has there. */
  function paceAt(plan, along) {
    const S = plan.sections;
    let i = 0;
    while (i < S.length - 1 && along >= S[i].to) i++;
    const s = S[i], start = s.end - s.secs, f = clamp((along - s.from) / Math.max(1, s.len), 0, 1);
    return { i, section: s, next: S[i + 1] || null, planned: start + s.secs * f, left: s.to - along };
  }
  /** % of threshold HR for a % of FTP (the ftpPct table, the other way round). */
  const hrPctFor = pct => { for (let i = 1; i < PCT.length; i++) if (pct <= PCT[i][1]) { const [a, pa] = PCT[i - 1], [b, pb] = PCT[i]; return a + (b - a) * (pct - pa) / Math.max(1e-9, pb - pa); } return 110; };

  // ── stamina: the carbohydrate left in the tank, and W′ (the reserve above critical power) ───────────────────
  /** The share of energy from carbohydrate at an intensity (% of FTP): about a third easy, nearly all at threshold
   *  (Romijn 1993, van Loon 2001). */
  const CARB = [[0, 0.25], [40, 0.3], [55, 0.4], [65, 0.5], [75, 0.62], [85, 0.78], [95, 0.92], [105, 1]];
  const carbShare = pct => { for (let i = 1; i < CARB.length; i++) if (pct <= CARB[i][0]) { const [a, sa] = CARB[i - 1], [b, sb] = CARB[i]; return sa + (sb - sa) * (pct - a) / (b - a); } return 1; };
  /** kcal a minute: from power (work at ~24 % efficiency, 1 kJ of work ≈ 1 kcal burned), else from heart rate
   *  (Keytel 2005). */
  function kcalMin(watts, hr, kg = 75, male = true, age = 40) {
    if (watts != null && watts > 0) return watts * 60 / 1000 / 0.24 / 4.184;
    if (hr == null) return 0;
    const k = male ? (-55.0969 + 0.6309 * hr + 0.1988 * kg + 0.2017 * age) : (-20.4022 + 0.4472 * hr - 0.1263 * kg + 0.074 * age);
    return Math.max(1.2, k / 4.184);
  }
  /** A fuel tank for the ride: the glycogen a fed rider starts with (~6.5 g/kg of usable carbohydrate), spent second
   *  by second at the intensity's carbohydrate share, filled by what you eat. */
  function tank(kg = 75) {
    const full = Math.round(kg * 6.5);
    return { full, left: full, burned: 0, eaten: 0, kcal: 0 };
  }
  /** One step of the tank: `pct` is the intensity in % of FTP (from power, else heart rate through the zone table). */
  function burn(t, { watts = null, hr = null, pct = 60, secs = 1, kg = 75, male = true }) {
    const kcal = kcalMin(watts, hr, kg, male) * secs / 60, g = kcal * carbShare(pct) / 4;
    t.kcal += kcal; t.burned += g; t.left = Math.max(0, t.left - g);
    return t;
  }
  const eat = (t, grams) => { t.eaten += grams; t.left = Math.min(t.full, t.left + grams); return t; };
  /** W′ balance (Skiba's differential model): spent 1 J per J above CP, coming back exponentially below it. */
  function wbal(bal, watts, cp, wPrime, secs = 1) {
    if (!(cp > 0) || !(wPrime > 0) || watts == null) return bal;
    if (watts > cp) return Math.max(0, bal - (watts - cp) * secs);
    return wPrime - (wPrime - bal) * Math.exp(-(cp - watts) * secs / wPrime);
  }

  // ── your own past rides on a route: a ghost to race, and times on its climbs ──────────────────────────────
  /** A recorded ride along a route → the ride clock (s, stops left out) at every 50 m of the route; null where it
   *  wasn't on it. A ride that covers under 70 % of the route, or starts more than 300 m in, isn't a ghost. */
  function ghostOf(route, samples, step = 50) {
    const n = Math.floor(route.total / step) + 1, t = new Array(n).fill(null);
    let near = null, clock = 0, prevT = null, lastK = -1, lastAlong = 0, lastClock = 0;
    for (const s of samples) {
      if (prevT != null) clock += clamp((s[0] - prevT) / 1000, 0, 5);
      prevT = s[0];
      if (s[1] == null) continue;
      const pr = project(route, { lat: s[1], lon: s[2] }, near, 800, 200);
      if (pr.off > 40) continue;
      if (near == null) { if (pr.along > 300) continue; clock = 0; lastAlong = pr.along; }
      else if (pr.along < near - 30 || pr.along > near + 600) continue;   // backwards, or a jump to another part
      near = pr.along;
      const k = Math.floor(pr.along / step);
      for (let j = lastK + 1; j <= k && j < n; j++) {
        const d = j * step, f = pr.along > lastAlong ? clamp((d - lastAlong) / (pr.along - lastAlong), 0, 1) : 1;
        t[j] = lastClock + (clock - lastClock) * f;
      }
      if (k > lastK) lastK = Math.min(k, n - 1);
      lastAlong = pr.along; lastClock = clock;
    }
    const covered = t.filter(x => x != null).length / n;
    return covered >= 0.7 ? { t, step, covered, total: t[lastK] } : null;
  }
  /** The ghost's clock at a distance along the route (null where it has no time). */
  const ghostAt = (g, along) => {
    const f = along / g.step, i = Math.floor(f), a = g.t[i], b = g.t[i + 1];
    return a == null ? null : b == null ? a : a + (b - a) * (f - i);
  };
  /** Times on the route's climbs, foot to top, from a ghost. */
  const climbTimes = (route, g) => route.climbs.map(c => { const a = ghostAt(g, c.start), b = ghostAt(g, c.end); return a != null && b != null && b > a ? b - a : null; });
  /** A recorded ride → a route to follow (the track thinned to a point every 10 m or so). */
  function rideRoute(name, samples) {
    const points = [];
    for (const s of samples) {
      if (s[1] == null) continue;
      const p = { lat: s[1], lon: s[2], ele: s[3] };
      if (!points.length || hav(points[points.length - 1], p) >= 10) points.push(p);
    }
    if (points.length < 2) throw new Error("That ride has no track to follow.");
    return { name, points, marks: [] };
  }

  // ── going somewhere new: a round trip of a given length, and what's nearby from OpenStreetMap ─────────────────
  /** Three turning points for a loop of about `dist` m from here, the first leg toward `bearing` (into the wind,
   *  so the wind brings you home): a diamond whose sides, on real roads (~1.25× the straight line), add up. */
  const dest = (p, brg, d) => {
    const dl = d / R, b = rad(brg), la = rad(p.lat), lo = rad(p.lon);
    const la2 = Math.asin(Math.sin(la) * Math.cos(dl) + Math.cos(la) * Math.sin(dl) * Math.cos(b));
    return { lat: deg(la2), lon: deg(lo + Math.atan2(Math.sin(b) * Math.sin(dl) * Math.cos(la), Math.cos(dl) - Math.sin(la) * Math.sin(la2))) };
  };
  function loopPoints(from, dist, bearing = 0, scale = 1) {
    const r = dist / (4 * Math.SQRT2 * 1.25) * scale, c = dest(from, bearing, r);
    return [bearing - 90, bearing, bearing + 90].map(a => dest(c, ((a % 360) + 360) % 360, r));
  }
  /** BRouter through several points (a loop comes back to the first). */
  const brouterVia = (pts, profile = "trekking", server = "https://brouter.de/brouter") =>
    `${server}?lonlats=${pts.map(p => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join("|")}&profile=${encodeURIComponent(profile)}&alternativeidx=0&format=geojson&timode=3`;
  /** What a rider stops for, from OpenStreetMap tags. */
  const OSM_KINDS = [[t => t.amenity === "drinking_water" || t.amenity === "water_point" || t.man_made === "water_tap", "water"],
    [t => ["cafe", "restaurant", "fast_food", "pub", "ice_cream"].includes(t.amenity) || ["convenience", "supermarket", "bakery"].includes(t.shop) || t.amenity === "fuel", "food"],
    [t => t.amenity === "toilets", "toilet"], [t => t.shop === "bicycle" || t.amenity === "bicycle_repair_station", "bike"]];
  /** An Overpass query for those within `r` m of a line of points (a route, thinned) or of one point. */
  function overpassQuery(points, r = 150) {
    const ll = points.map(p => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(",");
    const near = `(around:${Math.round(r)},${ll})`;
    return `[out:json][timeout:25];(nwr["amenity"~"^(drinking_water|water_point|cafe|restaurant|fast_food|pub|ice_cream|toilets|bicycle_repair_station|fuel)$"]${near};`
      + `nwr["shop"~"^(convenience|supermarket|bakery|bicycle)$"]${near};nwr["man_made"="water_tap"]${near};);out center tags 400;`;
  }
  /** Overpass's answer → places: where, what kind, its name, and when it's open (as OSM has it). */
  function fromOverpass(j) {
    const out = [], seen = new Set();
    for (const e of (j && j.elements) || []) {
      const t = e.tags || {}, lat = e.lat ?? (e.center && e.center.lat), lon = e.lon ?? (e.center && e.center.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const kind = (OSM_KINDS.find(([f]) => f(t)) || [])[1];
      if (!kind) continue;
      const name = String(t.name || ({ water: "Drinking water", food: "Food", toilet: "Restroom", bike: t.shop === "bicycle" ? "Bike shop" : "Bike repair stand" })[kind]).slice(0, 80);
      const key = `${kind}:${lat.toFixed(4)}:${lon.toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ lat, lon, kind, name, hours: t.opening_hours ? String(t.opening_hours).slice(0, 80) : "", src: "osm" });
    }
    return out;
  }
  /** A route thinned to a point every `every` m (an Overpass "around" line, or a short URL). */
  const thin = (route, every = 400) => { const out = []; for (let d = 0; d < route.total; d += every) out.push(pointAt(route, d)); out.push(pointAt(route, route.total)); return out; };

  // ── weather on the ride: rain arriving, the wind turning, storms ────────────────────────────────────────────
  /** From Open-Meteo's 15-minute forecast (unix times) and hourly weather codes: what's coming in the next 2 hours
   *  (3 for storms) that's worth saying out loud. Each alert has a key, so it's said once per change. */
  function wxAlerts(j, now = Date.now()) {
    const out = [], m = j && j.minutely_15, h = j && j.hourly;
    if (m && Array.isArray(m.time)) {
      const rows = m.time.map((t, i) => ({ t: t * 1000, p: (m.precipitation || [])[i] ?? 0, w: (m.wind_speed_10m || [])[i], d: (m.wind_direction_10m || [])[i] }))
        .filter(r => r.t + 15 * 60e3 > now && r.t < now + 2 * 3600e3);
      const cur = rows[0];
      if (cur) {
        const wet = rows.find(r => r.p >= 0.2);
        if (cur.p < 0.1 && wet) { const min = Math.max(5, Math.round((wet.t - now) / 60e3 / 5) * 5); out.push({ kind: "rain", at: wet.t, key: `rain:${Math.round(wet.t / 1800e3)}`, text: `Rain in about ${min} minutes${rows.some(r => r.t >= wet.t && r.p >= 1) ? ", heavy" : ""}.` }); }
        else if (cur.p >= 0.2) { const dry = rows.find(r => r.p < 0.1); if (dry) out.push({ kind: "dry", at: dry.t, key: `dry:${Math.round(dry.t / 1800e3)}`, text: `Rain easing in about ${Math.max(5, Math.round((dry.t - now) / 60e3 / 5) * 5)} minutes.` }); }
        if (cur.w != null && cur.d != null) {
          const big = r => r.w != null && r.d != null && (Math.abs(r.w - cur.w) >= 12 || (Math.max(r.w, cur.w) >= 15 && Math.abs(turnAngle(cur.d, r.d)) >= 60));
          const first = rows.find(big);
          if (first) {   // when it starts, and where it ends up (the biggest change in the window)
            const score = r => Math.abs(r.w - cur.w) + Math.abs(turnAngle(cur.d, r.d)) / 5, to = rows.filter(big).reduce((a, r) => (score(r) > score(a) ? r : a), first);
            const names = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"], from = names[Math.round(to.d / 45) % 8];
            const how = to.w > cur.w + 6 ? "picking up" : to.w < cur.w - 6 ? "dropping" : "turning";
            out.push({ kind: "wind", at: first.t, key: `wind:${from}:${Math.round(to.w / 10)}`, text: `Wind ${how} in about ${Math.max(15, Math.round((first.t - now) / 60e3 / 15) * 15)} minutes: from the ${from} at ${Math.round(to.w)} km/h.`, dir: to.d, speed: to.w });
          }
        }
      }
    }
    if (h && Array.isArray(h.time)) {
      const i = h.time.findIndex((t, k) => t * 1000 + 3600e3 > now && t * 1000 < now + 3 * 3600e3 && ((h.weather_code || [])[k] ?? 0) >= 95);
      if (i >= 0) out.push({ kind: "storm", at: h.time[i] * 1000, key: `storm:${h.time[i]}`, text: `Thunderstorms likely ${h.time[i] * 1000 <= now ? "now" : `around ${new Date(h.time[i] * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}: find shelter if you hear thunder.` });
    }
    return out;
  }

  /** A route trimmed to what an IndexedDB row needs (the analysis is rebuilt on load). */
  const storable = (raw, extra = {}) => ({ name: raw.name, points: raw.points.map(p => [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6, p.ele == null ? null : Math.round(p.ele * 10) / 10]), marks: raw.marks || [], ...extra });
  const unstore = row => ({ id: row.id, name: row.name, points: row.points.map(p => ({ lat: p[0], lon: p[1], ele: p[2] })), marks: row.marks || [] });
  const reversed = raw => ({ ...raw, name: `${raw.name} (reversed)`, points: [...raw.points].reverse(), marks: (raw.marks || []).filter(m => !m.cue) });

  return { hav, bearing, turnAngle, parseRoute, analyze, eleAt, gradeAt, pointAt, project, navigator, fromBRouter, brouterUrl, pickDetour, sunTimes, kindFromAngle, TURN_WORDS, TURN_ARROWS,
    commuteCheck, nightStyle, nightColor, ZONES, QUICK, quick, isWork, isEasy, setOf, addRep, cutSet, extend, fitTime, ftpPct, toFIT, toGPX, toTCX, routeGPX, stats, fitCrc, corridorTiles, tileXY, storable, unstore, reversed,
    FTMS, TACX, fecMsg, fecPower, fecGrade, fecLevel, fecUser, parseFec, parseBikeData, ftms, ergWatts, hrErg, ergGuess,
    pbf, mvtLines, nameRoads, roadGraph, attach, shortestWays, fromWay, tilesAround, batteryForecast, rideDigest,
    SURFACE, speedFor, sections, pacePlan, paceSuggest, paceAt, hrPctFor, sustainable, carbShare, kcalMin, tank, burn, eat, wbal,
    ghostOf, ghostAt, climbTimes, rideRoute, loopPoints, brouterVia, overpassQuery, fromOverpass, thin, wxAlerts };
})();
