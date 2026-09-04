"""Resolve items to YouTube Music (no key needed for search) so the feed can play them inline.

For releases we look up the release and take the first (or featured) track; for tracks we search directly.
Results are cached in data/cache/youtube.json.
"""
from __future__ import annotations

from typing import Any

from .models import Item
from .util import CACHE_DIR, log, norm, norm_track, read_json, write_json

YT_CACHE = CACHE_DIR / "youtube.json"
YEAR_CACHE = CACHE_DIR / "years.json"
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


def resolve_all(items: list[Item], cfg: dict) -> None:
    rcfg = cfg.get("resolve") or {}
    if not rcfg.get("youtube_music", True):
        return
    try:
        from ytmusicapi import YTMusic
    except ImportError:
        log.warning("ytmusicapi not installed; skipping YouTube resolution")
        return
    yt = YTMusic()
    cache: dict[str, Any] = read_json(YT_CACHE, {})
    budget = int(rcfg.get("max_lookups_per_run", 400))
    looked = 0
    for it in items:
        if it.youtube:
            continue
        key = it.key
        if key in cache:
            it.youtube = cache[key] or None
            continue
        if looked >= budget:
            continue
        looked += 1
        found: dict | None = None
        try:
            if it.kind == "track":
                res = yt.search(f"{it.artist} {it.title}", filter="songs", limit=6)
                hit = _pick(res, it.artist, it.title)
                if not hit:
                    res = yt.search(f"{it.artist} {it.title}", filter="videos", limit=4)
                    hit = _pick(res, it.artist, it.title)
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
                if not found:
                    res = yt.search(f"{it.artist} {it.release or it.title}", filter="songs", limit=6)
                    hit = _pick(res, it.artist, None)
                    if hit:
                        found = _shape(hit, "release-fallback")
                        it.title = hit.get("title") or it.title
                        it.kind = "track"
        except Exception as exc:  # noqa: BLE001
            log.debug("yt resolve failed for %s – %s: %s", it.artist, it.title, exc)
            found = None
        cache[key] = found
        it.youtube = found
        if found and not it.artwork:
            it.artwork = found.get("thumbnail")
    write_json(YT_CACHE, cache, compact=True)
    log.info("youtube: %d lookups this run, %d cached", looked, len(cache))


def _mb_earliest_year(http, artist: str, title: str) -> tuple[int | None, bool]:
    """Earliest release year MusicBrainz knows for this artist + recording title. Returns (year, matched)."""
    from .util import split_artists

    q = f'recording:"{title}" AND artist:"{artist}"'
    try:
        data = http.get(MB_RECORDING, params={"query": q, "fmt": "json", "limit": 15})
    except Exception as exc:  # noqa: BLE001
        log.debug("MB recording lookup failed for %s – %s: %s", artist, title, exc)
        return None, False
    a_norms = {norm(artist)} | {norm(x) for x in split_artists(artist)}
    t_norm = norm_track(title)
    years: list[int] = []
    for rec in data.get("recordings") or []:
        if norm_track(rec.get("title")) != t_norm:
            continue
        credits = rec.get("artist-credit") or []
        names = {norm(c.get("name") or (c.get("artist") or {}).get("name")) for c in credits if isinstance(c, dict)}
        if not (names & a_norms):
            continue
        for rel in rec.get("releases") or []:
            rg = rel.get("release-group") or {}
            sec = {str(x).lower() for x in (rg.get("secondary-types") or [])}
            if sec & {"compilation", "live", "dj-mix", "remix"}:
                continue
            for d in (rel.get("date"), rg.get("first-release-date")):
                if d and str(d)[:4].isdigit():
                    years.append(int(str(d)[:4]))
    if not years:
        return None, True
    return min(years), True


def verify_years(items: list[Item], cfg: dict, http) -> None:
    """Decide `year` for each item with provenance + confidence, using MusicBrainz as the authority when it knows the recording.

    Order: MusicBrainz earliest release of the recording (high) → source release date (medium; low for blog dates)
    → YouTube album year (medium) → current year (low).
    """
    from datetime import date

    rcfg = cfg.get("resolve") or {}
    budget = int(rcfg.get("max_year_lookups_per_run", 300))
    cache: dict = read_json(YEAR_CACHE, {})
    looked = 0
    for it in items:
        feed_year = it.release_date.year if it.release_date else None
        feed_is_blog = it.release_date is not None and all(s.startswith("rss") for s in it.sources)
        mb_year: int | None = None
        key = it.key
        if key in cache:
            mb_year = cache[key].get("mb")
        elif looked < budget and it.kind == "track":
            looked += 1
            mb_year, matched = _mb_earliest_year(http, it.artist, it.title)
            cache[key] = {"mb": mb_year, "matched": matched}
        yt_year = None
        try:
            yt_year = int(str((it.youtube or {}).get("year") or "")[:4])
        except ValueError:
            yt_year = None

        if mb_year:
            it.year, it.year_source, it.year_confidence = mb_year, "musicbrainz-recording", "high"
            if feed_year and mb_year < feed_year - 1:
                it.original_year = mb_year
        elif feed_year and not feed_is_blog:
            it.year, it.year_source, it.year_confidence = feed_year, "release-date", "medium"
        elif yt_year:
            it.year, it.year_source, it.year_confidence = yt_year, "youtube", "medium"
        elif feed_year:
            it.year, it.year_source, it.year_confidence = feed_year, "feed-date", "low"
        else:
            it.year, it.year_source, it.year_confidence = date.today().year, "unknown", "low"
        # a YouTube album year older than everything else is also a reissue hint
        if yt_year and it.year and yt_year < it.year - 1 and not it.original_year:
            it.original_year = yt_year
            it.year_confidence = "low" if it.year_confidence != "high" else it.year_confidence
    write_json(YEAR_CACHE, cache, compact=True)
    log.info("years: %d MusicBrainz lookups this run", looked)
