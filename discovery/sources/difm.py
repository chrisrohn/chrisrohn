"""DI.FM channel play logs: what the genre channels you follow just aired (AudioAddict's public API, no key).

  GET https://api.audioaddict.com/v1/di/channels                        every channel: {id, key, name, ...}
  GET https://api.audioaddict.com/v1/di/track_history/channel/{id}      the channel's recent plays, newest first

Channels are named by the key in their di.fm URL (di.fm/indiedance → `indiedance`); the channel list is asked once a
run (it is cached) to turn keys into ids. A play carries `display_artist` / `display_title` on the current API and a
single `track` ("Artist - Title") on the older one; both are read, ads and station idents (`type` other than
"track") are skipped. Only plays by profile artists are kept, like SomaFM: a channel is mostly not for you, its plays
by your artists are. Every play is a sighting dated by the airtime, editorial, source "radio:DI.FM <key>".
"""
from __future__ import annotations

from ..models import Item
from ..util import Http, log, norm, parse_date, split_artists
from . import report

CHANNELS = "https://api.audioaddict.com/v1/di/channels"
HISTORY = "https://api.audioaddict.com/v1/di/track_history/channel/{id}"
SITE = "https://www.di.fm/{key}"
DEFAULT_CHANNELS = ["indiedance", "nudisco", "electropop", "synthwave"]


def _match(profile: dict, artist: str) -> bool:
    arts = profile["artists"]
    return norm(artist) in arts or any(norm(a) in arts for a in split_artists(artist))


def channel_ids(http: Http) -> dict[str, int]:
    """`key` → numeric id for every channel the network lists (the list is cached for the day)."""
    data = http.get(CHANNELS, cache=True)
    rows = data.get("channels") if isinstance(data, dict) else data
    out: dict[str, int] = {}
    for ch in rows or []:
        if isinstance(ch, dict) and ch.get("key") and ch.get("id") is not None:
            out[str(ch["key"]).lower()] = int(ch["id"])
    return out


def _credit(play: dict) -> tuple[str, str]:
    """(artist, title) of one play, from the fields the API offers: the display pair, then `artist`/`title` (an
    artist may be an object), then the older single `track` split on its first dash."""
    artist = play.get("display_artist") or play.get("artist")
    title = play.get("display_title") or play.get("title")
    if isinstance(artist, dict):
        artist = artist.get("name")
    if isinstance(title, dict):
        title = title.get("name")
    if (not artist or not title) and play.get("track"):
        head, sep, tail = str(play["track"]).partition(" - ")
        if sep:
            artist, title = artist or head, title or tail
    return (str(artist or "")).strip(), (str(title or "")).strip()


def fetch(cfg: dict, profile: dict, http: Http) -> list[Item]:
    scfg = cfg["sources"]["difm"]
    keys = [str(k).lower() for k in (scfg.get("channels") or DEFAULT_CHANNELS)]
    out: list[Item] = []
    try:
        ids = channel_ids(http)
    except Exception as exc:  # noqa: BLE001
        log.warning("di.fm: the channel list failed: %s", exc)
        for key in keys:
            report(f"radio:DI.FM {key}", False, error=exc)
        return out
    for key in keys:
        name = f"radio:DI.FM {key}"
        cid = ids.get(key)
        if cid is None:
            report(name, False, error=f"no DI.FM channel with the key '{key}' (see the di.fm/<key> URL)")
            continue
        try:
            data = http.get(HISTORY.format(id=cid), cache=False)
            plays = data.get("track_history") or data.get("tracks") or [] if isinstance(data, dict) else data or []
            entries = kept = 0
            seen: set[tuple[str, str]] = set()
            for p in plays:
                if not isinstance(p, dict) or (p.get("type") and str(p["type"]).lower() != "track"):
                    continue
                artist, title = _credit(p)
                if not artist or not title:
                    continue
                entries += 1
                pair = (norm(artist), norm(title))
                if pair in seen or not _match(profile, artist):
                    continue
                seen.add(pair)
                aired = parse_date(p.get("started") or p.get("started_at"))
                out.append(Item(artist=artist, title=title, kind="track", release=(p.get("album") or None), release_date=aired,
                                date_kind="sighting", sources=[name], editorial=True, links={"di.fm": SITE.format(key=key)}))
                kept += 1
            report(name, True, entries=entries, kept=kept)
            log.info("di.fm %s: %d plays, %d kept", key, entries, kept)
        except Exception as exc:  # noqa: BLE001
            log.warning("di.fm %s: %s", key, exc)
            report(name, False, error=exc)
    return out
