"""The video side of the library: every song the year playlists hold whose official video is not yet reviewed.

The year playlists hold audio tracks. YouTube Music pairs most of them with an official video (the watch playlist
lists both sides of the pair), and the site's Video tab reviews those videos one by one: an approved one is added to
the single music-video playlist (`youtube_music.videos_playlist_id`), a passed one is remembered and never listed
again. This module builds the tab's list from the profile's playlist scan (profile.json → youtube.entries): every
row that is itself a video is a candidate as it stands; every audio row is asked, through the watch playlist, which
video it is paired with (`videos.lookups_per_run` a run, ≈0.3 s each, cached for good in data/cache/videos.json and
asked again after `videos.recheck_days` while there is none). Rows whose video the playlist already holds (read
through YouTube Music's own client, no API quota) and rows the tab has decided on (data/ratings.json → `videos`)
are left out, and one video is one row however many years hold the song. The feed's own cards carry their video
side from the resolver (`youtube.video`), so a song kept on the site is on the tab the same day; this report catches
up with it at the next profile scan. Nothing here spends YouTube API quota. The report is site/data/videos.json.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from .learn import RATINGS_PATH
from .profile import load_profile
from .resolve import ATV, prune_cache, video_side, ytmusic
from .util import CACHE_DIR, SITE_DATA_DIR, Deadline, log, read_json, utcnow, write_json

CACHE = CACHE_DIR / "videos.json"
REPORT = SITE_DATA_DIR / "videos.json"
CACHE_VERSION = 1
FLUSH_EVERY = 50
DEFAULTS = {"enabled": True, "lookups_per_run": 1500, "feed_lookups_per_run": 400, "recheck_days": 90, "time_budget_minutes": 35,
            "in_daily": True, "job_budget_minutes": 41}
DECISIONS = ("up", "down")   # approved (added to the music-video playlist) or passed


def settings(cfg: dict) -> dict:
    return {**DEFAULTS, **(cfg.get("videos") or {})}


def playlist_id(cfg: dict) -> str:
    """The one music-video playlist every approved video goes to."""
    return str((cfg.get("youtube_music") or {}).get("videos_playlist_id") or "")


def video_decisions(path=None) -> dict[str, dict]:
    """What the Video tab decided, pushed with the ratings (data/ratings.json → `videos`): {video id: {"decision":
    "up" | "down", ...}}. Either way the video is off the tab; only an approval reaches the playlist."""
    data = read_json(path or RATINGS_PATH, None) or {}
    rows = data.get("videos") if isinstance(data, dict) else None
    return {k: r for k, r in (rows or {}).items() if isinstance(r, dict) and r.get("decision") in DECISIONS}


def playlist_videos(yt, pid: str) -> set[str] | None:
    """Every video the music-video playlist holds right now (it is public; YouTube Music's own client reads it, no
    API quota). None when it could not be read, so nothing is assumed about it."""
    if not pid:
        return set()
    try:
        pl = yt.get_playlist(pid, limit=None)
    except Exception as exc:  # noqa: BLE001
        log.warning("could not read the music-video playlist %s: %s", pid, exc)
        return None
    return {t["videoId"] for t in (pl.get("tracks") or []) if t.get("videoId")}


def _sorted_entries(entries: list[dict]) -> list[dict]:
    return sorted((e for e in entries if e.get("videoId")), key=lambda e: (str(e.get("year") or ""), -(e.get("position") if isinstance(e.get("position"), int) else 0)), reverse=True)


def build_videos(cfg: dict, *, deadline_minutes: float | None = None, profile: dict | None = None) -> dict | None:
    """The Video tab's list, and the counts feed.json carries. Returns the report (also written to REPORT)."""
    c = settings(cfg)
    if not c.get("enabled", True):
        return None
    profile = profile or load_profile()
    entries = _sorted_entries((profile.get("youtube") or {}).get("entries") or [])
    minutes = float(c["time_budget_minutes"]) if deadline_minutes is None else min(float(c["time_budget_minutes"]), deadline_minutes)
    deadline = Deadline(max(0.01, minutes))
    budget = int(c.get("lookups_per_run") or 0)
    recheck = int(c.get("recheck_days") or 0)
    today = date.today()
    today_s = today.isoformat()
    recheck_before = (today - timedelta(days=recheck)).isoformat() if recheck else None
    keep_days = int((cfg.get("resolve") or {}).get("cache_keep_days", 120) or 0) or 365
    cache: dict[str, Any] = {k: v for k, v in read_json(CACHE, {}).items() if isinstance(v, dict) and v.get("v") == CACHE_VERSION}
    decided = video_decisions()
    pid = playlist_id(cfg)
    yt = None
    try:
        yt = ytmusic(cfg)
    except ImportError:
        log.warning("ytmusicapi not installed; the video report is built from the cache alone")
    held = playlist_videos(yt, pid) if yt is not None else None
    if held is None:
        held = set()
    looked = 0

    def flush() -> None:
        write_json(CACHE, prune_cache(cache, today, keep_days), compact=True)

    rows: dict[str, dict] = {}      # video id → row (one video is one row, whatever years hold the song)
    left_out: set[str] = set()      # videos already counted as held or decided
    pending = no_video = in_playlist = skipped = 0
    for e in entries:
        vid = e["videoId"]
        own = bool(e.get("videoType")) and e["videoType"] != ATV
        if own:
            side: dict | None = {"videoId": vid, "videoType": e["videoType"]}
        else:
            row = cache.get(vid)
            fresh = row is not None and (row.get("video") or not recheck_before or (row.get("at") or "") >= recheck_before)
            if fresh:
                row["seen"] = today_s
                side = row.get("video")
            elif yt is None or looked >= budget or deadline.expired:
                pending += 1
                continue
            else:
                looked += 1
                try:
                    side = video_side(yt, vid)
                except Exception as exc:  # noqa: BLE001
                    log.debug("video side of %s failed: %s", vid, exc)
                    pending += 1
                    continue
                cache[vid] = {"seen": today_s, "at": today_s, "video": {k: side[k] for k in ("videoId", "videoType") if side.get(k)} if side else None, "v": CACHE_VERSION}
                if looked % FLUSH_EVERY == 0:
                    flush()
            if not side:
                no_video += 1
                continue
        video = side["videoId"]
        year = str(e.get("year") or "")
        if video in rows:                    # the same song filed in another year too: one row, both years named
            r = rows[video]
            if year and year not in r["years"]:
                r["years"].append(year)
            continue
        if video in left_out:
            continue
        if video in held:
            in_playlist += 1
            left_out.add(video)
            continue
        if video in decided:
            skipped += 1
            left_out.add(video)
            continue
        rows[video] = {"video": video, "kind": side.get("videoType"), "own": own, "videoId": vid, "year": year, "years": [year] if year else [], "playlistId": e.get("playlistId"),
                       "position": e.get("position"), "artist": e.get("artist") or "", "title": e.get("title") or "", "album": e.get("album")}
    if looked:
        flush()
    report = {"generated_at": utcnow().isoformat(), "checked_at": (profile.get("youtube") or {}).get("checked_at"), "playlist_id": pid,
              "count": len(rows), "pending": pending, "no_video": no_video, "in_playlist": in_playlist, "decided": skipped, "looked_up": looked,
              "rows": list(rows.values())}
    write_json(REPORT, report, compact=True)
    log.info("videos: %d playlist songs have a video to review (%d looked up this run, %d rows still to ask, %d songs with no video, %d videos already in the playlist, %d decided on the tab)",
             report["count"], looked, pending, no_video, in_playlist, skipped)
    if deadline.expired and pending:
        log.warning("videos: time budget reached; %d rows wait for the next run", pending)
    return report
