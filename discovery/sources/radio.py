"""Radio play logs: what tastemaker stations actually aired recently.

  * KEXP – public API (https://api.kexp.org/v2/plays/), includes release dates. Every play since the last run: the
    newest airdate seen is kept in data/cache/kexp.json and the next run asks for `airdate_after` it, following the
    API's `next` links (200 plays a page, at most `pages` pages a run; a first run looks back FIRST_RUN_HOURS).
  * SomaFM – recent songs XML per channel (indiepop = "Indie Pop Rocks!", etc.)
Only plays matching the profile (artist or tag) or with a recent release date are kept. Look-back for "recent":
`sources.radio.days`, else listenbrainz_fresh.days, else 10.
"""
from __future__ import annotations

import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta
from pathlib import Path

from .. import util
from ..models import Item
from ..util import Http, log, norm, parse_date, read_versioned, source_days, split_artists, utcnow, write_versioned
from . import report

KEXP_PLAYS = "https://api.kexp.org/v2/plays/"
KEXP_CACHE_VERSION = 1      # {"cursor": "<iso airdate of the newest play seen>", "at": "<iso>"}
PAGE_SIZE = 200
DEFAULT_PAGES = 12
FIRST_RUN_HOURS = 24


def kexp_cache_path() -> Path:
    return util.CACHE_DIR / "kexp.json"


def _match(profile: dict, artist: str) -> bool:
    arts = profile["artists"]
    return norm(artist) in arts or any(norm(a) in arts for a in split_artists(artist))


def _airdate(value: str | None) -> datetime | None:
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=util.UTC)


def kexp_plays(http: Http, cursor: str | None, pages: int) -> tuple[list[dict], str | None]:
    """Every play newer than `cursor` (newest first), at most `pages` pages of PAGE_SIZE, and the newest airdate seen."""
    after = _airdate(cursor) or (utcnow() - timedelta(hours=FIRST_RUN_HOURS))
    params = {"limit": PAGE_SIZE, "exclude_airbreaks": "true", "airdate_after": after.isoformat()}
    plays: list[dict] = []
    newest = _airdate(cursor)
    url: str | None = KEXP_PLAYS
    for page in range(max(1, pages)):
        data = http.get(url, params=params if page == 0 else None, cache=False)
        results = data.get("results") or []
        plays.extend(results)
        for p in results:
            when = _airdate(p.get("airdate"))
            if when and (newest is None or when > newest):
                newest = when
        url = data.get("next")
        if not results or not url:
            break
    return plays, (newest.isoformat() if newest else cursor)


def fetch(cfg: dict, profile: dict, http: Http) -> list[Item]:
    scfg = cfg["sources"]["radio"]
    days = source_days(cfg, "radio")
    since = date.today() - timedelta(days=days)
    out: list[Item] = []

    if scfg.get("kexp", True):
        cache = read_versioned(kexp_cache_path(), KEXP_CACHE_VERSION, {})
        try:
            kept = 0
            plays, cursor = kexp_plays(http, cache.get("cursor"), int(scfg.get("pages", DEFAULT_PAGES)))
            for p in plays:
                artist, song = p.get("artist"), p.get("song")
                if not artist or not song:
                    continue
                rd = parse_date(p.get("release_date"))
                recent = rd is not None and rd >= since
                if not (recent or _match(profile, artist)):
                    continue
                aired = parse_date(p.get("airdate"))
                out.append(Item(artist=artist, title=song, kind="track", release=p.get("album"), release_date=rd or aired,
                                date_kind="release" if rd else "sighting",
                                sources=["radio:KEXP"], editorial=True, links={"kexp": "https://www.kexp.org/playlist/"}))
                kept += 1
            report("radio:KEXP", True, entries=len(plays), kept=kept)
            if cursor:
                write_versioned(kexp_cache_path(), KEXP_CACHE_VERSION, {"cursor": cursor, "at": utcnow().isoformat()})
            log.info("radio KEXP: %d plays since %s, %d kept", len(plays), cache.get("cursor") or f"{FIRST_RUN_HOURS}h ago", kept)
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
