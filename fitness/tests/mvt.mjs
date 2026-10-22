// Builds Mapbox Vector Tiles for the specs: lines in lon/lat → one tile (lines are written whole, past the tile edge
// where they run on, as a real tile's buffer would hold them). Only what ride mode's offline router reads.
export function encodeTile(z, x, y, layers, extent = 4096) {
  const out = [];
  const varint = (a, v) => { while (v > 127) { a.push((v & 127) | 128); v = Math.floor(v / 128); } a.push(v); };
  const key = (a, f, wt) => varint(a, f * 8 + wt);
  const bytes = (a, f, b) => { key(a, f, 2); varint(a, b.length); a.push(...b); };
  const str = s => [...new TextEncoder().encode(s)];
  const zig = v => (v < 0 ? -2 * v - 1 : 2 * v);
  const packed = arr => { const a = []; for (const v of arr) varint(a, v); return a; };
  const n = 2 ** z;
  const px = (lon, lat) => { const fx = (lon + 180) / 360 * n, s = Math.sin(lat * Math.PI / 180), fy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n; return [Math.round((fx - x) * extent), Math.round((fy - y) * extent)]; };
  for (const [name, feats] of Object.entries(layers)) {
    const L = [], keys = [], vals = [], kI = new Map(), vI = new Map();
    bytes(L, 1, str(name));
    for (const f of feats) {
      const tags = [];
      for (const [k, v] of Object.entries(f.props || {})) {
        if (!kI.has(k)) { kI.set(k, keys.length); keys.push(k); }
        const vk = typeof v + ":" + v;
        if (!vI.has(vk)) { vI.set(vk, vals.length); vals.push(v); }
        tags.push(kI.get(k), vI.get(vk));
      }
      const g = []; let cx = 0, cy = 0;
      f.coords.forEach((c, i) => { const [X, Y] = px(c[0], c[1]); if (i === 0) g.push(9); else if (i === 1) g.push(2 | ((f.coords.length - 1) << 3)); g.push(zig(X - cx), zig(Y - cy)); cx = X; cy = Y; });
      const F = [];
      bytes(F, 2, packed(tags)); key(F, 3, 0); varint(F, 2); bytes(F, 4, packed(g));
      bytes(L, 2, F);
    }
    for (const k of keys) bytes(L, 3, str(k));
    for (const v of vals) { const V = []; if (typeof v === "string") bytes(V, 1, str(v)); else if (v < 0) { key(V, 6, 0); varint(V, zig(v)); } else { key(V, 5, 0); varint(V, v); } bytes(L, 4, V); }
    key(L, 5, 0); varint(L, extent); key(L, 15, 0); varint(L, 2);
    bytes(out, 3, L);
  }
  return new Uint8Array(out);
}
