#!/bin/sh
# Rebuilds the app's web fonts (fitness/site/fonts/*.woff2) from URW's Nimbus Sans L OTFs in this folder: the Latin
# letters, the punctuation, arrows and geometric marks the app sets, every OpenType layout feature kept (kerning).
# Needs fontTools with brotli: pip install fonttools brotli
set -eu
cd "$(dirname "$0")"
RANGES="U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+0160-0161,U+0178,U+017D-017E,U+0192,U+02C6-02C7,U+02D8-02DD,U+2000-206F,U+20AC,U+2122,U+2190-2199,U+2212,U+2215,U+2219,U+221E,U+2248,U+2260,U+2264-2265,U+25A0-25FF,U+FB01-FB02"
for w in Reg:400 Bol:700; do
  src="NimbusSanL-${w%%:*}.otf"; out="../site/fonts/nimbus-sans-l-${w##*:}.woff2"
  pyftsubset "$src" --unicodes="$RANGES" --layout-features='*' --flavor=woff2 --output-file="$out"
done
cp LICENSE-GPL-2.0.txt ../site/fonts/LICENSE-GPL-2.0.txt
