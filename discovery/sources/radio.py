"""Radio play logs: what tastemaker stations actually aired recently.

  * KEXP – public API (https://api.kexp.org/v2/plays/), includes release dates
  * SomaFM – recent songs XML per channel (indiepop = "Indie Pop Rocks!", etc.)
Only plays matching the profile (artist or tag) or with a recent release date are kept.
"""
from __future__ import annotations

import xml.etree.ElementTree as ET
from datetime import date, timedelta

from ..models import Item
from ..util import Http, log, norm, parse_date, split_artists
from . import report


def _match(profile: dict, artist: str) -> bool:
    arts = profile["artists"]
    return norm(artist) in arts or any(norm(a) in arts for a in split_artists(artist))


def fetch(cfg: dict, profile: dict, http: Http) -> list[Item]:
    scfg = cfg["sources"]["radio"]
    days = int(cfg["sources"].get("listenbrainz_fresh", {}).get("days", 10))
    since = date.today() - timedelta(days=days)
    out: list[Item] = []

    if scfg.get("kexp", True):
        try:
            kept = 0
            data = http.get("https://api.kexp.org/v2/plays/", params={"limit": 200, "exclude_airbreaks": "true"}, cache=False)
            plays = data.get("results") or []
            for p in plays:
                artist, song = p.get("artist"), p.get("song")
                if not artist or not song:
                    continue
                rd = parse_date(p.get("release_date"))
                recent = rd is not None and rd >= since
                if not (recent or _match(profile, artist)):
                    continue
                out.append(Item(artist=artist, title=song, kind="track", release=p.get("album"), release_date=rd,
                                sources=["radio:KEXP"], editorial=True, links={"kexp": "https://www.kexp.org/playlist/"}))
                kept += 1
            report("radio:KEXP", True, entries=len(plays), kept=kept)
        except Exception as exc:  # noqa: BLE001
            report("radio:KEXP", False, error=exc)

    for channel in scfg.get("somafm") or []:
        name = f"radio:SomaFM {channel}"
        try:
            raw = http.get(f"https://somafm.com/songs/{channel}.xml", as_json=False, cache=False)
            root = ET.fromstring(raw)
            songs = root.findall("song")
            kept = 0
            for s in songs:
                artist = (s.findtext("artist") or "").strip()
                title = (s.findtext("title") or "").strip()
                if not artist or not title or not _match(profile, artist):
                    continue
                out.append(Item(artist=artist, title=title, kind="track", release=(s.findtext("album") or None),
                                sources=[name], editorial=True, links={"somafm": f"https://somafm.com/{channel}/"}))
                kept += 1
            report(name, True, entries=len(songs), kept=kept)
        except Exception as exc:  # noqa: BLE001
            report(name, False, error=exc)
    return out
