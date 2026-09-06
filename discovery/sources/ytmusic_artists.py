"""Artist watch on YouTube Music: newest singles/albums of your top profile artists (no key; ytmusicapi).

Replaces Spotify's dead Release Radar. Artist browse IDs are cached; each run checks `top_artists` artists
(rotating through the list over successive days so big profiles still get full coverage). Every release from the
current window is returned on every run: the feed's own first_seen state decides what counts as new.

The client is the region-pinned one from resolve.ytmusic, so an artist is judged where the playlists are listened
to. data/cache/ytmusic_artists.json (schema CACHE_VERSION): {"ids": {name: browseId | {"miss": date}}, "cursor": n};
a miss is retried after util.NEGATIVE_CACHE_DAYS.
"""
from __future__ import annotations

from datetime import date

from ..models import Item
from ..resolve import ytmusic
from ..util import CACHE_DIR, Http, log, miss_expired, miss_row, norm, read_versioned, write_versioned

CACHE = CACHE_DIR / "ytmusic_artists.json"
CACHE_VERSION = 2   # 1: ids were browseId | "" (a miss cached for good); 2: misses are {"miss": date}


def _migrate(data: dict, old: int) -> dict | None:
    if old != 1:
        return None
    today = date.today()
    ids = {k: (v if v else miss_row(today)) for k, v in (data.get("ids") or {}).items()}
    return {"ids": ids, "cursor": int(data.get("cursor") or 0)}


def fetch(cfg: dict, profile: dict, http: Http) -> list[Item]:
    scfg = cfg["sources"]["ytmusic_artists"]
    per_run = int(scfg.get("top_artists", 150))
    yt = ytmusic(cfg)
    cache = read_versioned(CACHE, CACHE_VERSION, {"ids": {}, "cursor": 0}, migrate=_migrate)
    cache.setdefault("ids", {})
    cache.pop("seen", None)   # older builds hid a release after its first sighting; the feed keeps items for the freshness window
    ranked = [e for e in sorted(profile["artists"].values(), key=lambda e: -e["affinity"]) if e.get("kind") == "direct"]
    ranked = ranked[: int(scfg.get("pool", 600))]
    if not ranked:
        return []
    start = int(cache.get("cursor", 0)) % len(ranked)
    batch = (ranked + ranked)[start:start + min(per_run, len(ranked))]   # never the same artist twice in a run
    cache["cursor"] = (start + per_run) % len(ranked)
    this_year = date.today().year
    out: list[Item] = []
    for e in batch:
        n = norm(e["name"])
        row = cache["ids"].get(n)
        bid = row if isinstance(row, str) and row else None
        if bid is None and (row is None or miss_expired(row)):
            try:
                res = yt.search(e["name"], filter="artists", limit=3)
                hit = next((r for r in res if norm(r.get("artist")) == n), None)
                bid = (hit.get("browseId") or None) if hit else None
            except Exception as exc:  # noqa: BLE001
                log.debug("ytmusic artist search %s: %s", e["name"], exc)
                bid = None
            cache["ids"][n] = bid or miss_row()
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
                if not rb:
                    continue
                thumbs = rel.get("thumbnails") or []
                out.append(Item(
                    artist=e["name"], title=rel.get("title") or "", kind="release", release=rel.get("title"),
                    release_type=rtype, sources=["ytmusic"], tags=[], stated_year=year or None,
                    links={"youtube music": f"https://music.youtube.com/browse/{rb}"},
                    artwork=thumbs[-1]["url"] if thumbs else None,
                ))
    write_versioned(CACHE, CACHE_VERSION, cache)
    return out
