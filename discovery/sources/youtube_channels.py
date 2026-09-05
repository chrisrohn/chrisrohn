"""YouTube channel feeds (labels, curators, live-session channels). Free RSS, no key, video IDs included.

config.sources.youtube_channels.channels: list of {name, channel: "UC..." | "@handle", artist_in_title: bool}
  artist_in_title=true  → titles like "Artist - Track (Official Video)" (label / curator channels)
  artist_in_title=false → the channel IS the artist; the video title is the track
Handles are resolved to channel IDs once (cached in data/cache/yt_channels.json).
"""
from __future__ import annotations

import html
import re
from datetime import date, timedelta

import feedparser

from ..models import Item
from ..util import CACHE_DIR, Http, log, parse_artist_title, read_json, struct_time_to_date, write_json
from . import report

CACHE = CACHE_DIR / "yt_channels.json"
FEED = "https://www.youtube.com/feeds/videos.xml?channel_id={cid}"
NOISE = re.compile(r"\s*[\(\[]\s*(official|lyric|music)?\s*(video|audio|visuali[sz]er|lyrics?|live( on kexp| session)?|hq|hd|4k|premiere)\s*[\)\]]\s*$", re.I)
SKIP = re.compile(r"\b(trailer|teaser|interview|announce|documentary|behind the scenes|mix\b|dj set|full set|podcast|live stream|livestream|playlist)\b", re.I)


def _channel_id(http: Http, ref: str, cache: dict) -> str | None:
    if ref.startswith("UC") and len(ref) >= 20:
        return ref
    key = ref.lower()
    if key in cache:
        return cache[key] or None
    handle = ref if ref.startswith("@") else "@" + ref
    try:
        page = http.get(f"https://www.youtube.com/{handle}", as_json=False, cache=False, headers={"Accept-Language": "en"})
        m = re.search(r'"externalId":"(UC[\w-]{20,})"', page) or re.search(r'channel_id=(UC[\w-]{20,})', page) or re.search(r'"channelId":"(UC[\w-]{20,})"', page)
        cache[key] = m.group(1) if m else None
    except Exception as exc:  # noqa: BLE001
        log.warning("youtube handle %s: %s", handle, exc)
        cache[key] = None
    return cache[key]


def fetch(cfg: dict, profile: dict, http: Http) -> list[Item]:
    scfg = cfg["sources"]["youtube_channels"]
    days = int(scfg.get("days") or cfg["sources"].get("listenbrainz_fresh", {}).get("days", 10))
    since = date.today() - timedelta(days=days)
    cache = read_json(CACHE, {})
    out: list[Item] = []
    for ch in scfg.get("channels") or []:
        name = ch.get("name") or ch.get("channel")
        cid = _channel_id(http, str(ch.get("channel", "")), cache)
        if not cid:
            report(f"yt:{name}", False, error="channel not found")
            continue
        try:
            raw = http.get(FEED.format(cid=cid), as_json=False, cache=False)
        except Exception as exc:  # noqa: BLE001
            report(f"yt:{name}", False, error=exc)
            continue
        parsed = feedparser.parse(raw)
        kept = 0
        for e in parsed.entries:
            vid = e.get("yt_videoid") or (e.get("id") or "").split(":")[-1]
            title = html.unescape(e.get("title") or "").strip()
            when = struct_time_to_date(e.published_parsed) if e.get("published_parsed") else None
            if not vid or not title or (when and when < since) or SKIP.search(title):
                continue
            clean = NOISE.sub("", title).strip()
            artist = track = None
            if ch.get("artist_in_title", True):
                pair = parse_artist_title(clean)
                if pair:
                    artist, track = pair
            else:
                artist, track = (ch.get("artist") or (e.get("author") or name)), clean
            if not artist or not track:
                continue
            thumb = None
            media = e.get("media_thumbnail") or []
            if media:
                thumb = media[0].get("url")
            out.append(Item(
                artist=artist, title=track, kind="track", release_date=when, date_kind="sighting",
                sources=[f"youtube:{name}"], links={"youtube": f"https://www.youtube.com/watch?v={vid}"},
                artwork=thumb, editorial=bool(ch.get("editorial", True)),
                youtube={"videoId": vid, "title": title, "artists": [artist], "thumbnail": thumb, "via": "channel-feed"},
            ))
            kept += 1
        report(f"yt:{name}", True, entries=len(parsed.entries), kept=kept)
    write_json(CACHE, cache, compact=True)
    return out
