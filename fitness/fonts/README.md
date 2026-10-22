# Nimbus Sans L: the app's Helvetica off Apple devices

The Training app is set in Helvetica. iPhones, iPads and Macs have Helvetica Neue and use it. Android has no Helvetica (the
name is only an alias for Roboto there), and Windows maps it to Arial. Those devices get **Nimbus Sans L**, URW's
metric-compatible Helvetica clone, served with the app from `fitness/site/fonts/`.

| File | What |
|---|---|
| `NimbusSanL-Reg.otf`, `NimbusSanL-Bol.otf` | The source: URW++'s Nimbus Sans L, regular and bold, version 1.000 (© 2014 (URW)++ Design & Development GmbH) |
| `LICENSE-GPL-2.0.txt` | The license the fonts are released under: the GNU General Public License, version 2 |
| `subset.sh` | Rebuilds `../site/fonts/nimbus-sans-l-{400,700}.woff2` from the source (`pip install fonttools brotli`) |

**Changes from the source** (GPL v2 §2): `subset.sh` keeps only the characters the app sets (Latin, Latin-1,
punctuation, arrows, geometric shapes, a few math signs), keeps every OpenType layout feature, and writes WOFF2. Nothing
else is changed. The vertical-metric overrides that centre capitals in their line boxes are in `site/style.css`
(`@font-face`), not in the font files. Italics aren't shipped: Helvetica's italic is an oblique, and the browser's
slanted roman is the same drawing.

The deployed app carries the license next to the fonts (`fonts/LICENSE-GPL-2.0.txt`), and this folder is the source.
