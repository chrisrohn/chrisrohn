"""Deezer public catalog API (free, no key for catalog endpoints).

  * newest albums of your top-N profile artists  → GET /search/artist, GET /artist/{id}/albums
  * optional: related artists' newest albums      → GET /artist/{id}/related   (Spotify's dead "related artists")
  * editorial new releases by genre               → GET /editorial/{genre_id}/releases
"""
from __future__ import annotations

from datetime import date, timedelta

from ..models import Item
from ..util import CACHE_DIR, Http, log, norm, parse_date, read_json, write_json

API = "https://api.deezer.com"
ID_CACHE = CACHE_DIR / "deezer_artists.json"


def _artist_id(http: Http, name: str, cache: dict) -> int | None:
    n = norm(name)
    if n in cache:
        return cache[n]
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
    cache[n] = aid
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
    days = int(cfg["sources"].get("listenbrainz_fresh", {}).get("days", 10))
    since = date.today() - timedelta(days=days)
    cache = read_json(ID_CACHE, {})
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
            out.append(Item(
                artist=artist,
                title=al.get("title") or "",
                kind="release",
                release=al.get("title"),
                release_type={"single": "Single", "ep": "EP", "album": "Album"}.get(rt, None),
                release_date=rd,
                tags=[],
                sources=["deezer-editorial"],
                links={"deezer": al.get("link") or f"https://www.deezer.com/album/{al.get('id')}"},
                artwork=al.get("cover_medium") or al.get("cover"),
            ))
    write_json(ID_CACHE, cache, compact=True)
    return out
