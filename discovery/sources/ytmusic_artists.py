"""Artist watch on YouTube Music: singles/albums of your profile artists (no key; ytmusicapi).

Replaces Spotify's dead Release Radar. The pool is the strongest `pool` artists of the configured `kinds` (the acts
you play, their associates, the Last.fm genre artists); artist browse IDs are cached; each run checks `top_artists`
of them, rotating through the pool over successive days so everyone gets covered. Every release from this year and
the backfill window (`backfill.years`) is returned on every run: the feed decides what is fresh and what fills a gap,
and its own first_seen state decides what counts as new.

The client is the region-pinned one from resolve.ytmusic, so an artist is judged where the playlists are listened
to. data/cache/ytmusic_artists.json (schema CACHE_VERSION): {"ids": {name: browseId | {"miss": date}}, "cursor": n};
a miss is retried after util.NEGATIVE_CACHE_DAYS.
"""
from __future__ import annotations

from datetime import date

from ..models import Item
from ..profile import ranked_artists
from ..resolve import ytmusic
from ..util import CACHE_DIR, Http, backfill_years, log, miss_expired, miss_row, norm, read_versioned, write_versioned

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
    ranked = ranked_artists(profile, scfg.get("kinds") or ("direct",), int(scfg.get("pool", 600)))
    if not ranked:
        return []
    start = int(cache.get("cursor", 0)) % len(ranked)
    batch = (ranked + ranked)[start:start + min(per_run, len(ranked))]   # never the same artist twice in a run
    # this year's releases, and the backfill window's when the feed may look further back
    since_year = date.today().year - backfill_years(cfg)
    out: list[Item] = []
    done = 0
    for e in batch:
        if http is not None and getattr(http, "deadline", None) and http.deadline.expired:
            log.warning("ytmusic artists: time budget spent after %d of %d artists; the rest are next run's", done, len(batch))
            break
        done += 1
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
                if year < since_year:
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
    cache["cursor"] = (start + done) % len(ranked)    # only what was actually checked; the rest comes round next run
    write_versioned(CACHE, CACHE_VERSION, cache)
    log.info("ytmusic artists: %d of %d checked (cursor %d), %d releases", done, len(ranked), start, len(out))
    return out
