"""Artist watch on YouTube Music: newest singles/albums of your top profile artists (no key; ytmusicapi).

Replaces Spotify's dead Release Radar. Artist browse IDs are cached; each run checks `top_artists` artists
(rotating through the list over successive days so big profiles still get full coverage).
"""
from __future__ import annotations

from datetime import date

from ..models import Item
from ..util import CACHE_DIR, Http, log, norm, read_json, write_json

CACHE = CACHE_DIR / "ytmusic_artists.json"


def fetch(cfg: dict, profile: dict, http: Http) -> list[Item]:
    from ytmusicapi import YTMusic

    scfg = cfg["sources"]["ytmusic_artists"]
    per_run = int(scfg.get("top_artists", 150))
    yt = YTMusic()
    cache = read_json(CACHE, {"ids": {}, "seen": {}, "cursor": 0})
    ranked = [e for e in sorted(profile["artists"].values(), key=lambda e: -e["affinity"]) if e.get("kind") == "direct"]
    ranked = ranked[: int(scfg.get("pool", 600))]
    if not ranked:
        return []
    start = int(cache.get("cursor", 0)) % len(ranked)
    batch = (ranked + ranked)[start:start + per_run]
    cache["cursor"] = (start + per_run) % len(ranked)
    this_year = date.today().year
    out: list[Item] = []
    for e in batch:
        n = norm(e["name"])
        bid = cache["ids"].get(n)
        if bid is None:
            try:
                res = yt.search(e["name"], filter="artists", limit=3)
                hit = next((r for r in res if norm(r.get("artist")) == n), None)
                bid = hit.get("browseId") if hit else ""
            except Exception as exc:  # noqa: BLE001
                log.debug("ytmusic artist search %s: %s", e["name"], exc)
                bid = ""
            cache["ids"][n] = bid
        if not bid:
            continue
        try:
            art = yt.get_artist(bid)
        except Exception as exc:  # noqa: BLE001
            log.debug("ytmusic get_artist %s: %s", e["name"], exc)
            continue
        for section, rtype in (("singles", "Single"), ("albums", "Album")):
            for rel in ((art.get(section) or {}).get("results") or []):
                try:
                    year = int(rel.get("year") or 0)
                except ValueError:
                    year = 0
                if year < this_year - (1 if date.today().month == 1 else 0):
                    continue
                rb = rel.get("browseId")
                if not rb or rb in cache["seen"]:
                    continue
                cache["seen"][rb] = date.today().isoformat()
                thumbs = rel.get("thumbnails") or []
                out.append(Item(
                    artist=e["name"], title=rel.get("title") or "", kind="release", release=rel.get("title"),
                    release_type=rtype, sources=["ytmusic"], tags=[],
                    links={"youtube music": f"https://music.youtube.com/browse/{rb}"},
                    artwork=thumbs[-1]["url"] if thumbs else None,
                ))
    # forget seen releases older than a year so the cache doesn't grow forever
    cutoff = date.today().replace(year=this_year - 1).isoformat()
    cache["seen"] = {k: v for k, v in cache["seen"].items() if v >= cutoff}
    write_json(CACHE, cache, compact=True)
    return out
