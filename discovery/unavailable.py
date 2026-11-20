"""Playlist tracks that will not stream here, and the counterpart that will; playlist tracks that are the video
rather than the audio track, and the audio track that pairs with them.

The profile build reads every year playlist through YouTube Music's own client, which greys out a track that is not
available in the request's region (label rights, a withdrawn upload, a video the owner region-locked). Those rows
are collected here, and for each one the resolver's search is asked for another upload of the same song — same
artist, same title, the audio track preferred — that the region can play. The site's own playability audit
(site/src/audit.js) adds the rows YouTube Music cannot see — deleted, private and region-blocked videos — through
the ratings file it pushes (data/ratings.json → `unplayable`), and they get the same search. The report goes to
site/data/unavailable.json for the Cleanup tab, where a swap (add the counterpart, remove the dead copy) is two
YouTube API writes. Lookups are cached in data/cache/counterparts.json and bounded per run.
The same report lists every playlist row that is a video (an official video or an upload, videoType other than
MUSIC_VIDEO_TYPE_ATV) with why "video" and, from the watch playlist, the audio track YouTube Music pairs it with as
the counterpart (or, when it pairs none, the same recording's audio track found by a song search, as the resolver
does for cards), so the tab can swap the library over to audio files one row (or one year) at a time.

The lookups run a few at a time (`resolve.counterpart_workers`) inside a window of their own (build.py reserves
`resolve.cleanup_minutes` off the end of the feed's), so the feed's slow year lookups can no longer leave them none:
from 2026-10-29 to 2026-11-19 every run reached this report with its deadline spent and looked nothing up. A miss
(no counterpart found) is asked again after `resolve.counterpart_retry_days`, since uploads appear and regions open.
"""
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from typing import Any

from .models import Item
from .resolve import ATV, _pick, _shape, audio_counterpart, prefer_audio, prune_cache, search_audio, ytmusic
from .util import CACHE_DIR, SITE_DATA_DIR, Deadline, log, read_json, utcnow, write_json

CACHE = CACHE_DIR / "counterparts.json"
REPORT = SITE_DATA_DIR / "unavailable.json"
CACHE_VERSION = 1
# a video row's audio side: 2 adds the song search when the watch playlist pairs no audio track (375 of the 376 rows
# asked under version 1 came back empty), so every version-1 answer is asked again
AUDIO_CACHE_VERSION = 2


def unavailable_entries(profile: dict, ratings: dict | None = None) -> list[dict]:
    """Every playlist row the last scan saw greyed out, plus what the site's playability audit found and pushed in
    the ratings file (`unplayable`: deleted, private and region-blocked videos the YouTube Music scan cannot see),
    newest year first. A row the scan and the audit both name is one row, the audit's reason kept."""
    rows = [dict(e, why="greyed") for e in (profile.get("youtube") or {}).get("entries") or [] if e.get("avail") is False and e.get("videoId")]
    seen = {(str(e.get("playlistId") or ""), e["videoId"]): e for e in rows}
    for k, u in ((ratings or {}).get("unplayable") or {}).items():
        if not isinstance(u, dict) or not u.get("videoId"):
            continue
        key = (str(u.get("playlistId") or ""), str(u["videoId"]))
        if key in seen:
            seen[key]["why"] = u.get("why") or seen[key].get("why")
            continue
        row = {"year": str(u.get("year") or ""), "playlistId": u.get("playlistId"), "videoId": str(u["videoId"]), "position": u.get("position"),
               "artist": u.get("artist") or "", "title": u.get("title") or "", "avail": False, "why": u.get("why") or "dead", "audited_at": u.get("at")}
        seen[key] = row
        rows.append(row)
    rows.sort(key=lambda e: (str(e.get("year") or ""), str(e.get("artist") or "").lower()), reverse=True)
    return rows


def video_entries(profile: dict) -> list[dict]:
    """Every playlist row the last scan saw as a video rather than the audio track (and that still plays), newest
    year first; a row that is also greyed out is listed as unavailable instead, its counterpart search covers both."""
    rows = [dict(e, why="video") for e in (profile.get("youtube") or {}).get("entries") or []
            if e.get("videoId") and e.get("videoType") and e.get("videoType") != ATV and e.get("avail") is not False]
    rows.sort(key=lambda e: (str(e.get("year") or ""), str(e.get("artist") or "").lower()), reverse=True)
    return rows


def load_unplayable(path=None) -> dict:
    """The audit findings the site pushed with its ratings (data/ratings.json → `unplayable`)."""
    from .learn import RATINGS_PATH
    data = read_json(path or RATINGS_PATH, None) or {}
    return data if isinstance(data, dict) else {}


def find_counterpart(yt, artist: str, title: str, avoid: str) -> dict[str, Any] | None:
    """Another upload of the same song that streams here: same artist and title, the audio track first."""
    if not artist or not title:
        return None
    it = Item(artist=artist, title=title, kind="track").normalize_credit()
    hits: list[dict] = []
    try:
        hits = [r for r in yt.search(f"{artist} {it.display_title}", filter="songs", limit=8) if r.get("videoId") != avoid]
    except Exception as exc:  # noqa: BLE001
        log.debug("counterpart search failed for %s – %s: %s", artist, title, exc)
        return None
    hit = _pick(hits, artist, it.display_title)
    if not hit:
        try:
            hits = [r for r in yt.search(f"{artist} {it.display_title}", filter="videos", limit=5) if r.get("videoId") != avoid]
        except Exception:  # noqa: BLE001
            hits = []
        hit = _pick(hits, artist, it.display_title)
    if not hit:
        return None
    found = _shape(hit, "counterpart")
    prefer_audio(yt, found)
    if found.get("videoId") == avoid:
        return None
    return {k: found.get(k) for k in ("videoId", "title", "album", "thumbnail", "videoType") if found.get(k) is not None}


def audio_side(yt, entry: dict) -> dict[str, Any] | None:
    """The audio track of a playlist row that is a video: the one YouTube Music pairs with it in the watch playlist,
    else the same recording's audio track found by a song search (artist and title agreeing, never another version),
    named after the row itself."""
    cp = audio_counterpart(yt, entry["videoId"])
    if cp:
        return {k: v for k, v in (("videoId", cp), ("title", entry.get("title")), ("album", entry.get("album")), ("videoType", ATV)) if v is not None}
    artist, title = entry.get("artist") or "", entry.get("title") or ""
    if not artist or not title:
        return None
    found: dict[str, Any] = {"videoId": entry["videoId"], "videoType": entry.get("videoType"), "title": title}
    want = Item(artist=artist, title=title, kind="track").normalize_credit().display_title
    if not search_audio(yt, found, artist, want, {entry["videoId"]}) or found.get("videoId") == entry["videoId"]:
        return None
    return {k: v for k, v in (("videoId", found["videoId"]), ("title", found.get("title") or title), ("album", found.get("album") or entry.get("album")), ("videoType", ATV)) if v is not None}


def _due(row: dict | None, version: int, today: date, retry_days: int) -> bool:
    """Whether a row needs (another) lookup: never asked, asked under older rules, or a miss old enough to retry."""
    if row is None or row.get("v") != version:
        return True
    if row.get("alt") or not retry_days:
        return False
    try:
        asked = date.fromisoformat(str(row.get("at") or ""))
    except ValueError:
        return True          # a miss from before the date was kept: due now
    return (today - asked).days >= retry_days


def build_report(profile: dict, cfg: dict, deadline: Deadline | None = None) -> dict:
    dead = unavailable_entries(profile, load_unplayable())
    videos = video_entries(profile)
    greyed = {(str(e.get("playlistId") or ""), e["videoId"]) for e in dead}
    videos = [e for e in videos if (str(e.get("playlistId") or ""), e["videoId"]) not in greyed]
    rows = dead + videos
    rcfg = cfg.get("resolve") or {}
    budget = int(rcfg.get("counterparts_per_run", 300))
    keep_days = int(rcfg.get("cache_keep_days", 120))
    retry_days = int(rcfg.get("counterpart_retry_days", 30))
    workers = max(1, int(rcfg.get("counterpart_workers", 4)))
    deadline = deadline or Deadline(None)
    today = date.today()
    today_s = today.isoformat()
    cache: dict[str, Any] = read_json(CACHE, {})

    def key(e: dict) -> str:
        # a video row's counterpart is the audio side the watch playlist names, a dead row's a search: cached apart
        return f"audio:{e['videoId']}" if e.get("why") == "video" else e["videoId"]

    def ver(e: dict) -> int:
        return AUDIO_CACHE_VERSION if e.get("why") == "video" else CACHE_VERSION

    def searchable(e: dict) -> bool:
        # a deleted video has no name left to search by: the tab offers a removal or a typed search
        return e.get("why") == "video" or bool(e.get("artist") and e.get("title"))

    # never asked first, then misses due a retry, newest year first within each (rows are already in that order);
    # one lookup per video id even when several playlists hold it
    due: dict[str, dict] = {}
    for e in rows:
        k = key(e)
        if k not in due and searchable(e) and _due(cache.get(k), ver(e), today, retry_days):
            due[k] = e

    def fresh(k: str, e: dict) -> bool:
        return cache.get(k) is None or cache[k].get("v") != ver(e)
    todo = [kv for kv in due.items() if fresh(*kv)] + [kv for kv in due.items() if not fresh(*kv)]
    todo = todo[:budget] if budget > 0 else []

    local = threading.local()

    def client():
        if not hasattr(local, "yt"):
            local.yt = ytmusic(cfg)
        return local.yt

    def look(item: tuple[str, dict]) -> tuple[str, dict | None, bool]:
        """One row's lookup on this worker's own client (ytmusicapi's session is not shared across threads)."""
        k, e = item
        if deadline.expired:
            return k, None, False
        try:
            yt = client()
            vid = e["videoId"]
            alt = audio_side(yt, e) if e.get("why") == "video" else find_counterpart(yt, e.get("artist") or "", e.get("title") or "", vid)
        except Exception as exc:  # noqa: BLE001
            log.debug("counterpart lookup for %s failed: %s", e.get("videoId"), exc)
            return k, None, False
        return k, alt, True

    looked = 0
    if todo:
        with ThreadPoolExecutor(max_workers=min(workers, len(todo))) as pool:
            for (k, e), (_, alt, ok) in zip(todo, pool.map(look, todo), strict=True):
                if ok:
                    looked += 1
                    cache[k] = {"seen": today_s, "at": today_s, "alt": alt, "v": ver(e)}

    out: list[dict] = []
    for e in rows:
        k = key(e)
        row = cache.get(k)
        if not searchable(e):
            alt, pending = None, False
        elif row is None or row.get("v") != ver(e):
            alt, pending = None, True        # not asked yet (over budget or out of time): waits, is not "no counterpart"
        else:
            row["seen"] = today_s
            alt, pending = row.get("alt"), False
        out.append({"year": str(e.get("year") or ""), "playlistId": e.get("playlistId"), "videoId": e["videoId"], "position": e.get("position"),
                    "artist": e.get("artist") or "", "title": e.get("title") or "", "alt": alt, "pending": pending, "why": e.get("why") or "greyed"})
    # always written: the rows still listed are marked seen, so the pruning never drops an answer the report still uses
    if cache or looked:
        write_json(CACHE, prune_cache(cache, today, keep_days), compact=True)
    dead_rows = [r for r in out if r["why"] != "video"]
    video_rows = [r for r in out if r["why"] == "video"]
    report = {"checked_at": (profile.get("youtube") or {}).get("checked_at"), "generated_at": utcnow().isoformat(), "count": len(dead_rows),
              "with_counterpart": sum(1 for r in dead_rows if r["alt"]), "audio": sum(1 for r in dead_rows if r["alt"] and r["alt"].get("videoType") == ATV),
              "pending": sum(1 for r in dead_rows if r["pending"]),
              # playlist rows that are the video, not the audio track, and how many have the audio side to swap in
              "video": len(video_rows), "video_with_audio": sum(1 for r in video_rows if r["alt"]), "video_pending": sum(1 for r in video_rows if r["pending"]),
              "looked": looked, "rows": out}
    write_json(REPORT, report, compact=True)
    log.info("unavailable: %d greyed-out playlist tracks, %d with a streamable counterpart (%d looked up this run, %d waiting); %d playlist rows are the video rather than the audio track, %d with the audio side found (%d waiting); %d lookups still due",
             report["count"], report["with_counterpart"], looked, report["pending"], report["video"], report["video_with_audio"], report["video_pending"], max(0, len(due) - looked))
    return report
