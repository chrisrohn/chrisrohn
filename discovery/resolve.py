"""Resolve items to YouTube Music (no key needed for search) so the feed can play them inline.

For releases we look up the release and take the first (or featured) track; for tracks we search directly.
Results are cached in data/cache/youtube.json.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from .models import Item
from .util import CACHE_DIR, Deadline, log, norm, norm_track, read_json, write_json

YT_CACHE = CACHE_DIR / "youtube.json"
FLUSH_EVERY = 25   # lookups between cache writes, so a killed job keeps what it already found
MB_RECORDING = "https://musicbrainz.org/ws/2/recording/"


def _pick(results: list[dict], artist: str, title: str | None) -> dict | None:
    a = norm(artist)
    t = norm_track(title) if title else ""
    best, best_score = None, 0.0
    for r in results:
        if r.get("resultType") not in ("song", "video"):
            continue
        names = [norm(x.get("name")) for x in (r.get("artists") or []) if x.get("name")]
        artist_ok = any(a and (a == n or a in n or n in a) for n in names)
        rt = norm_track(r.get("title"))
        title_ok = bool(t) and (t == rt or t in rt or rt in t)
        score = (2.0 if artist_ok else 0.0) + (1.5 if title_ok else 0.0) + (0.3 if r.get("resultType") == "song" else 0.0)
        if score > best_score:
            best, best_score = r, score
    if best and best_score >= 2.0:
        return best
    return None


def _shape(r: dict, via: str) -> dict[str, Any]:
    thumbs = r.get("thumbnails") or []
    album = r.get("album") or {}
    return {
        "videoId": r.get("videoId"),
        "title": r.get("title"),
        "artists": [x.get("name") for x in (r.get("artists") or []) if x.get("name")],
        "album": album.get("name") if isinstance(album, dict) else None,
        "duration": r.get("duration"),
        "thumbnail": thumbs[-1]["url"] if thumbs else None,
        "year": r.get("year"),
        "via": via,
    }


def _entry(v: Any, today: str) -> dict:
    """Cache rows are {"seen": date, "yt": result|None}; rows written before the prune existed are the bare result."""
    if isinstance(v, dict) and "yt" in v and "seen" in v:
        return v
    return {"seen": today, "yt": v or None}


def prune_cache(cache: dict[str, Any], today: date, keep_days: int, seen_key: str = "seen") -> dict[str, Any]:
    """Drop rows no feed item has touched for `keep_days` (the caches are committed daily, so they must not grow forever)."""
    if not keep_days:
        return cache
    cutoff = (today - timedelta(days=keep_days)).isoformat()
    return {k: v for k, v in cache.items() if (v.get(seen_key) if isinstance(v, dict) else None) and v[seen_key] >= cutoff}


def resolve_all(items: list[Item], cfg: dict, deadline: Deadline | None = None) -> None:
    rcfg = cfg.get("resolve") or {}
    if not rcfg.get("youtube_music", True):
        return
    try:
        from ytmusicapi import YTMusic
    except ImportError:
        log.warning("ytmusicapi not installed; skipping YouTube resolution")
        return
    yt = YTMusic()
    today = date.today()
    today_s = today.isoformat()
    keep_days = int(rcfg.get("cache_keep_days", 120))
    cache: dict[str, Any] = {k: _entry(v, today_s) for k, v in read_json(YT_CACHE, {}).items()}
    deadline = deadline or Deadline(None)
    budget = int(rcfg.get("max_lookups_per_run", 400))
    looked = 0
    skipped_deadline = 0

    def flush() -> None:
        write_json(YT_CACHE, prune_cache(cache, today, keep_days), compact=True)

    for it in items:
        if it.youtube:
            continue
        key = it.key
        if key in cache:
            row = cache[key]
            row["seen"] = today_s
            it.youtube = row["yt"] or None
            continue
        if looked >= budget:
            continue
        if deadline.expired:
            skipped_deadline += 1
            continue
        looked += 1
        found: dict | None = None
        try:
            if it.kind == "track":
                res = yt.search(f"{it.artist} {it.display_title}", filter="songs", limit=6)
                hit = _pick(res, it.artist, it.display_title)
                if not hit:
                    res = yt.search(f"{it.artist} {it.display_title}", filter="videos", limit=4)
                    hit = _pick(res, it.artist, it.display_title)
                if hit:
                    found = _shape(hit, "track-search")
            else:
                # release: find the album, then its first track
                res = yt.search(f"{it.artist} {it.release or it.title}", filter="albums", limit=5)
                album = None
                for r in res:
                    names = [norm(x.get("name")) for x in (r.get("artists") or [])]
                    if any(norm(it.artist) == n or norm(it.artist) in n for n in names) and norm_track(r.get("title")) == norm_track(it.release or it.title):
                        album = r
                        break
                if album is None:
                    for r in res:
                        names = [norm(x.get("name")) for x in (r.get("artists") or [])]
                        if any(norm(it.artist) == n for n in names):
                            album = r
                            break
                if album and album.get("browseId"):
                    detail = yt.get_album(album["browseId"])
                    tracks = detail.get("tracks") or []
                    tracks = [t for t in tracks if t.get("videoId")]
                    if tracks:
                        first = tracks[0]
                        found = _shape(first, "album")
                        found["thumbnail"] = (detail.get("thumbnails") or [{}])[-1].get("url") or found["thumbnail"]
                        found["album"] = detail.get("title")
                        found["trackCount"] = len(tracks)
                        found["albumBrowseId"] = album["browseId"]
                        found["playlistId"] = detail.get("audioPlaylistId")
                        # promote release → track so the card shows a playable song
                        it.title = first.get("title") or it.title
                        it.kind = "track"
                        it.normalize_credit()
                if not found:
                    res = yt.search(f"{it.artist} {it.release or it.title}", filter="songs", limit=6)
                    hit = _pick(res, it.artist, None)
                    if hit:
                        found = _shape(hit, "release-fallback")
                        it.title = hit.get("title") or it.title
                        it.kind = "track"
                        it.normalize_credit()
        except Exception as exc:  # noqa: BLE001
            log.debug("yt resolve failed for %s – %s: %s", it.artist, it.title, exc)
            found = None
        cache[key] = {"seen": today_s, "yt": found}
        it.youtube = found
        if found and not it.artwork:
            it.artwork = found.get("thumbnail")
        if looked % FLUSH_EVERY == 0:
            flush()
    flush()
    if skipped_deadline:
        log.warning("youtube: time budget reached; %d lookups left for the next run", skipped_deadline)
    log.info("youtube: %d lookups this run, %d cached", looked, len(cache))


# Year verification moved to discovery/years.py (identifier-based); kept importable from here.
from .years import verify_years  # noqa: E402,F401
