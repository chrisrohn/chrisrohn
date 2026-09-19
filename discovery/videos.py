"""The Video tab's list: the official video of every song the library holds, the most played first.

The year playlists hold audio tracks. Most of those songs also have an official video on YouTube, and the site's
Video tab reviews them one by one: an approved one is added to the single music-video playlist
(`youtube_music.videos_playlist_id`), a passed one is remembered and never listed again. This module builds the
tab's list from the profile's playlist scan (profile.json → youtube.entries), walked in the order the songs matter:
the picks (the newest songs kept, profile.json → picks) first, then every song by how often the station has played
it on Last.fm (the catalog's history snapshot, discovery/catalog.py → history_plays), the rest by year. Each audio
row is asked for its video through `resolve.find_video` — the pair the watch playlist names, which YouTube Music
answered with for 10 of the 11,209 rows asked by 2026-09-18, then a video search that refuses anything titled as
the audio side ("Song (Official Audio)", a visualiser, a lyric video) — `videos.lookups_per_run` a run, cached in
data/cache/videos.json and asked again after `videos.recheck_days` while there is none. A playlist row that is
itself a video is listed only when it is a music video by the same rule; otherwise its video is looked for like any
other row's. Rows whose video the playlist already holds (read through YouTube Music's own client, no API quota)
and rows the tab has decided on (data/ratings.json → `videos`) are left out, and one video is one row however many
years hold the song. The feed's own cards carry their video side from the resolver (`youtube.video`), so a song kept
on the site is on the tab the same day; this report catches up with it at the next profile scan. Nothing here
spends YouTube API quota. The report is site/data/videos.json.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from .catalog import history_key, history_plays
from .learn import RATINGS_PATH
from .profile import load_profile
from .resolve import ATV, find_video, is_music_video, prune_cache, ytmusic
from .util import CACHE_DIR, SITE_DATA_DIR, Deadline, log, read_json, utcnow, write_json

CACHE = CACHE_DIR / "videos.json"
REPORT = SITE_DATA_DIR / "videos.json"
CACHE_VERSION = 2   # 1: the watch-playlist pair alone (answered for 10 rows in 11,209); 2: the pair, then a video search
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


def order_entries(entries: list[dict], picks: list[dict] | None = None, plays: dict[str, int] | None = None) -> list[dict]:
    """The playlist rows in the order they are asked and listed: the picks (the newest songs kept) first, in their
    order, then by how often the station has played the song on Last.fm, then the newest year and the latest
    position. Each row gets `plays` and, for a pick, `pick: True`."""
    picked = {p.get("videoId"): n for n, p in enumerate(picks or []) if p.get("videoId")}
    plays = plays or {}
    out = []
    for e in entries:
        if not e.get("videoId"):
            continue
        row = dict(e)
        row["plays"] = plays.get(history_key(e.get("artist") or "", e.get("title") or ""), 0)
        if e["videoId"] in picked:
            row["pick"] = True
        out.append(row)
    out.sort(key=lambda r: (0 if r.get("pick") else 1, picked.get(r["videoId"], 0), -int(r.get("plays") or 0),
                            -int(r["year"]) if str(r.get("year") or "").isdigit() else 0, -(r.get("position") if isinstance(r.get("position"), int) else 0)))
    return out


def build_videos(cfg: dict, *, deadline_minutes: float | None = None, profile: dict | None = None, plays: dict[str, int] | None = None) -> dict | None:
    """The Video tab's list, and the counts feed.json carries. Returns the report (also written to REPORT)."""
    c = settings(cfg)
    if not c.get("enabled", True):
        return None
    profile = profile or load_profile()
    entries = order_entries((profile.get("youtube") or {}).get("entries") or [], profile.get("picks") or [], history_plays() if plays is None else plays)
    minutes = float(c["time_budget_minutes"]) if deadline_minutes is None else min(float(c["time_budget_minutes"]), deadline_minutes)
    deadline = Deadline(max(0.01, minutes))
    budget = int(c.get("lookups_per_run") or 0)
    recheck = int(c.get("recheck_days") or 0)
    today = date.today()
    today_s = today.isoformat()
    recheck_before = (today - timedelta(days=recheck)).isoformat() if recheck else None
    keep_days = int((cfg.get("resolve") or {}).get("cache_keep_days", 120) or 0) or 365
    # rows written by the pair-only resolver (v1) are asked again: nearly every one of them said "no video" because
    # YouTube Music does not name the pair, not because there is none
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
        own_video = {"videoId": vid, "videoType": e.get("videoType"), "title": e.get("title")}
        own = bool(e.get("videoType")) and e["videoType"] != ATV and is_music_video(own_video)
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
                    side = find_video(yt, vid, e.get("artist"), e.get("title"))
                except Exception as exc:  # noqa: BLE001
                    log.debug("video of %s failed: %s", vid, exc)
                    pending += 1
                    continue
                cache[vid] = {"seen": today_s, "at": today_s, "video": {k: side[k] for k in ("videoId", "videoType", "title", "via") if side.get(k)} if side else None, "v": CACHE_VERSION}
                if looked % FLUSH_EVERY == 0:
                    flush()
            if not side or not is_music_video({**side, "title": side.get("title")}):
                no_video += 1
                continue
        video = side["videoId"]
        year = str(e.get("year") or "")
        if video in rows:                    # the same song filed in another year too: one row, both years named
            r = rows[video]
            if year and year not in r["years"]:
                r["years"].append(year)
            r["plays"] = max(r.get("plays") or 0, int(e.get("plays") or 0))
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
                       "position": e.get("position"), "artist": e.get("artist") or "", "title": e.get("title") or "", "album": e.get("album"),
                       "plays": int(e.get("plays") or 0), **({"pick": True} if e.get("pick") else {}), **({"via": side["via"]} if side.get("via") else {})}
    if looked:
        flush()
    report = {"generated_at": utcnow().isoformat(), "checked_at": (profile.get("youtube") or {}).get("checked_at"), "playlist_id": pid,
              "count": len(rows), "pending": pending, "no_video": no_video, "in_playlist": in_playlist, "decided": skipped, "looked_up": looked,
              "order": "picks first, then the most played on Last.fm", "rows": list(rows.values())}
    write_json(REPORT, report, compact=True)
    log.info("videos: %d playlist songs have a video to review (%d looked up this run, %d rows still to ask, %d songs with no video, %d videos already in the playlist, %d decided on the tab)",
             report["count"], looked, pending, no_video, in_playlist, skipped)
    if deadline.expired and pending:
        log.warning("videos: time budget reached; %d rows wait for the next run", pending)
    return report
