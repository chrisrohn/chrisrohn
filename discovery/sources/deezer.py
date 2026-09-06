"""Deezer public catalog API (free, no key for catalog endpoints).

  * newest albums of your top-N profile artists  → GET /search/artist, GET /artist/{id}/albums
  * optional: related artists' newest albums      → GET /artist/{id}/related   (Spotify's dead "related artists")
  * editorial new releases by genre               → GET /editorial/{genre_id}/releases
    (compilations and sped-up / slowed / nightcore / karaoke / tribute / 8-bit knock-offs are skipped)

Artist ids are cached in data/cache/deezer_artists.json (schema ID_CACHE_VERSION): name → id, or {"miss": date} for a
name Deezer did not know, retried after util.NEGATIVE_CACHE_DAYS. Look-back: `sources.deezer.days`, else
listenbrainz_fresh.days, else 10.
"""
from __future__ import annotations

import re
from datetime import date, timedelta

from ..models import Item
from ..util import CACHE_DIR, Http, log, miss_expired, miss_row, norm, parse_date, read_versioned, source_days, write_versioned

API = "https://api.deezer.com"
ID_CACHE = CACHE_DIR / "deezer_artists.json"
ID_CACHE_VERSION = 2   # 1: name → id | null (a miss cached for good); 2: misses are {"miss": date}
KNOCKOFF = re.compile(r"sped.?up|slowed|nightcore|karaoke|tribute|8.?bit", re.I)


def _migrate_ids(data: dict, old: int) -> dict | None:
    """v1 → v2: keep every id, turn a null (a miss cached for good) into a dated miss so it is retried in a month."""
    if old != 1:
        return None
    today = date.today()
    return {k: (v if v else miss_row(today)) for k, v in data.items()}


def _artist_id(http: Http, name: str, cache: dict) -> int | None:
    n = norm(name)
    row = cache.get(n)
    if isinstance(row, int) and not isinstance(row, bool):
        return row
    if row is not None and not miss_expired(row):
        return None
    try:
        data = http.get(f"{API}/search/artist", params={"q": name, "limit": 3})
    except Exception as exc:  # noqa: BLE001
        log.debug("deezer search %s: %s", name, exc)
        return None
    aid = None
    for a in data.get("data") or []:
        if norm(a.get("name")) == n:
            aid = a.get("id")
            break
    cache[n] = aid if aid else miss_row()
    return aid


def _albums(http: Http, aid: int, artist_name: str, since: date, tags: list[str], via: str) -> list[Item]:
    out: list[Item] = []
    try:
        data = http.get(f"{API}/artist/{aid}/albums", params={"limit": 15})
    except Exception as exc:  # noqa: BLE001
        log.debug("deezer albums %s: %s", aid, exc)
        return out
    for al in data.get("data") or []:
        rd = parse_date(al.get("release_date"))
        if not rd or rd < since:
            continue
        rt = (al.get("record_type") or "").lower()
        if rt == "compile":
            continue
        out.append(Item(
            artist=artist_name,
            title=al.get("title") or "",
            kind="release",
            release=al.get("title"),
            release_type={"single": "Single", "ep": "EP", "album": "Album"}.get(rt, rt.title() or None),
            release_date=rd,
            tags=tags,
            sources=[via],
            links={"deezer": al.get("link") or f"https://www.deezer.com/album/{al.get('id')}"},
            artwork=al.get("cover_medium") or al.get("cover"),
        ))
    return out


def fetch(cfg: dict, profile: dict, http: Http) -> list[Item]:
    scfg = cfg["sources"]["deezer"]
    days = source_days(cfg, "deezer")
    since = date.today() - timedelta(days=days)
    cache = read_versioned(ID_CACHE, ID_CACHE_VERSION, {}, migrate=_migrate_ids)
    out: list[Item] = []

    ranked = sorted(
        (e for e in profile["artists"].values() if e.get("kind") == "direct"),
        key=lambda e: -e["affinity"],
    )[: int(scfg.get("top_artists", 150))]
    related_n = int(scfg.get("related_per_artist", 0))
    seen_ids: set[int] = set()
    for e in ranked:
        aid = _artist_id(http, e["name"], cache)
        if not aid or aid in seen_ids:
            continue
        seen_ids.add(aid)
        out.extend(_albums(http, aid, e["name"], since, [], "deezer"))
        if related_n:
            try:
                rel = http.get(f"{API}/artist/{aid}/related", params={"limit": related_n})
            except Exception:  # noqa: BLE001
                rel = {}
            for ra in rel.get("data") or []:
                rid = ra.get("id")
                if not rid or rid in seen_ids:
                    continue
                seen_ids.add(rid)
                cache.setdefault(norm(ra.get("name")), rid)
                out.extend(_albums(http, rid, ra.get("name") or "", since, [], "deezer-related"))

    for gid in scfg.get("editorial_genres") or []:
        try:
            data = http.get(f"{API}/editorial/{gid}/releases", params={"limit": 100})
        except Exception as exc:  # noqa: BLE001
            log.warning("deezer editorial %s: %s", gid, exc)
            continue
        for al in data.get("data") or []:
            rd = parse_date(al.get("release_date"))
            if not rd or rd < since:
                continue
            artist = (al.get("artist") or {}).get("name") or ""
            if not artist:
                continue
            rt = (al.get("record_type") or "").lower()
            if rt == "compile" or KNOCKOFF.search(al.get("title") or ""):
                continue
            out.append(Item(
                artist=artist,
                title=al.get("title") or "",
                kind="release",
                release=al.get("title"),
                release_type={"single": "Single", "ep": "EP", "album": "Album"}.get(rt),
                release_date=rd,
                tags=[],
                sources=["deezer-editorial"],
                links={"deezer": al.get("link") or f"https://www.deezer.com/album/{al.get('id')}"},
                artwork=al.get("cover_medium") or al.get("cover"),
            ))
    write_versioned(ID_CACHE, ID_CACHE_VERSION, cache)
    return out
