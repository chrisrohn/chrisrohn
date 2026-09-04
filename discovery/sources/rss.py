"""Music-blog / radio RSS feeds (Pitchfork, Gorilla vs. Bear, Stereogum, Hype Machine, KEXP, Bandcamp Daily...).

Headlines are parsed into (artist, track) when they look like `Artist – "Track"`. Anything that can't be parsed
is kept only if the headline mentions an artist from the profile.
"""
from __future__ import annotations

import html
import re
import time
from datetime import date, timedelta

import feedparser

from ..models import Item
from ..util import Http, log, norm, parse_artist_title, parse_date

from . import report

STRIP_HTML = re.compile(r"<[^>]+>")


def fetch(cfg: dict, profile: dict, http: Http) -> list[Item]:
    scfg = cfg["sources"]["rss"]
    days = int(cfg["sources"].get("listenbrainz_fresh", {}).get("days", 10))
    since = date.today() - timedelta(days=days + 4)
    artists = profile["artists"]
    out: list[Item] = []
    for feed in scfg.get("feeds") or []:
        name, url = feed["name"], feed["url"]
        try:
            raw = http.get(url, as_json=False, cache=False, headers={"Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5"})
        except Exception as exc:  # noqa: BLE001
            log.warning("rss %s: %s", name, exc)
            report(name, False, error=exc)
            continue
        parsed = feedparser.parse(raw)
        if not parsed.entries:
            report(name, False, error="no entries (not a feed?)")
            continue
        n = 0
        for entry in parsed.entries[:80]:
            title = html.unescape(STRIP_HTML.sub("", entry.get("title") or "")).strip()
            link = entry.get("link") or ""
            when = None
            for k in ("published_parsed", "updated_parsed"):
                if entry.get(k):
                    when = date.fromtimestamp(time.mktime(entry[k]))
                    break
            if when is None:
                when = parse_date(entry.get("published") or entry.get("updated"))
            if when and when < since:
                continue
            summary = html.unescape(STRIP_HTML.sub(" ", entry.get("summary") or entry.get("description") or "")).strip()
            summary = re.sub(r"\s+", " ", summary)[:280]
            tags = [norm(t.get("term")) for t in (entry.get("tags") or []) if t.get("term")]

            pair = parse_artist_title(title)
            artist = track = None
            if pair:
                artist, track = pair
            else:
                # fall back: does the headline name someone we know?
                lower = norm(title)
                for key, e in artists.items():
                    if len(key) > 3 and re.search(rf"\b{re.escape(key)}\b", lower):
                        artist = e["name"]
                        break
                if not artist:
                    continue
                track = title
            out.append(Item(
                artist=artist,
                title=track,
                kind="track" if pair else "release",
                release_date=when,
                tags=tags,
                sources=[f"rss:{name}"],
                links={"article": link} if link else {},
                editorial=True,
                blurb=summary or None,
            ))
            n += 1
        report(name, True, entries=len(parsed.entries), kept=n)
        log.info("rss %s: %d/%d entries kept", name, n, len(parsed.entries))
    return out
