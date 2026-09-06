"""Playlist tracks that will not stream here, and the counterpart that will.

The profile build reads every year playlist through YouTube Music's own client, which greys out a track that is not
available in the request's region (label rights, a withdrawn upload, a video the owner region-locked). Those rows
are collected here, and for each one the resolver's search is asked for another upload of the same song — same
artist, same title, the audio track preferred — that the region can play. The report goes to
site/data/unavailable.json for the Cleanup tab, where a swap (add the counterpart, remove the dead copy) is two
YouTube API writes. Lookups are cached in data/cache/counterparts.json and bounded per run.
"""
from __future__ import annotations

from datetime import date
from typing import Any

from .models import Item
from .resolve import ATV, _pick, _shape, prefer_audio, prune_cache, ytmusic
from .util import CACHE_DIR, SITE_DATA_DIR, Deadline, log, read_json, utcnow, write_json

CACHE = CACHE_DIR / "counterparts.json"
REPORT = SITE_DATA_DIR / "unavailable.json"
CACHE_VERSION = 1


def unavailable_entries(profile: dict) -> list[dict]:
    """Every playlist row the last scan saw greyed out, newest year first."""
    rows = [e for e in (profile.get("youtube") or {}).get("entries") or [] if e.get("avail") is False and e.get("videoId")]
    rows.sort(key=lambda e: (str(e.get("year") or ""), str(e.get("artist") or "").lower()), reverse=True)
    return rows


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


def build_report(profile: dict, cfg: dict, deadline: Deadline | None = None) -> dict:
    rows = unavailable_entries(profile)
    rcfg = cfg.get("resolve") or {}
    budget = int(rcfg.get("counterparts_per_run", 300))
    keep_days = int(rcfg.get("cache_keep_days", 120))
    deadline = deadline or Deadline(None)
    today_s = date.today().isoformat()
    cache: dict[str, Any] = read_json(CACHE, {})
    yt = ytmusic(cfg) if rows and budget else None
    looked = 0
    out: list[dict] = []
    for e in rows:
        vid = e["videoId"]
        row = cache.get(vid)
        if row is None or row.get("v") != CACHE_VERSION:
            if yt is None or looked >= budget or deadline.expired:
                alt: dict | None = None
                pending = True
            else:
                looked += 1
                alt = find_counterpart(yt, e.get("artist") or "", e.get("title") or "", vid)
                row = cache[vid] = {"seen": today_s, "alt": alt, "v": CACHE_VERSION}
                pending = False
        else:
            row["seen"] = today_s
            alt, pending = row.get("alt"), False
        out.append({"year": str(e.get("year") or ""), "playlistId": e.get("playlistId"), "videoId": vid, "position": e.get("position"),
                    "artist": e.get("artist") or "", "title": e.get("title") or "", "alt": alt, "pending": pending})
    if looked:
        write_json(CACHE, prune_cache(cache, date.today(), keep_days), compact=True)
    report = {"checked_at": (profile.get("youtube") or {}).get("checked_at"), "generated_at": utcnow().isoformat(), "count": len(out),
              "with_counterpart": sum(1 for r in out if r["alt"]), "audio": sum(1 for r in out if r["alt"] and r["alt"].get("videoType") == ATV),
              "pending": sum(1 for r in out if r["pending"]), "rows": out}
    write_json(REPORT, report, compact=True)
    log.info("unavailable: %d greyed-out playlist tracks, %d with a streamable counterpart (%d looked up this run, %d waiting)", report["count"], report["with_counterpart"], looked, report["pending"])
    return report
