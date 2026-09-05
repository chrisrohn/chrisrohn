"""Music-blog / radio RSS feeds (Pitchfork, Gorilla vs. Bear, Stereogum, Hype Machine, KEXP, Bandcamp Daily...).

Headlines become cards only when they are about one song: `Artist – "Track"`, or `Artist shares new single "Track"`
with a known artist opening the headline (see discovery/headlines.py). News, listicles, interviews, tour dates and
the like are dropped, however many artist names they mention.
"""
from __future__ import annotations

import html
import re
from datetime import date, timedelta

import feedparser

from ..headlines import headline_track
from ..models import Item
from ..util import BROWSER_USER_AGENT, Http, log, norm, parse_date, safe_url, struct_time_to_date
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
            raw = http.get(url, as_json=False, cache=False, headers={"User-Agent": BROWSER_USER_AGENT, "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5"})
        except Exception as exc:  # noqa: BLE001
            log.warning("rss %s: %s", name, exc)
            report(name, False, error=exc)
            continue
        parsed = feedparser.parse(raw)
        if not parsed.entries:
            report(name, False, error="no entries (not a feed?)")
            continue
        n = 0
        feed_words = {w for w in norm(name).split() if len(w) > 3}   # "Clash" magazine must not become The Clash
        for entry in parsed.entries[:80]:
            title = html.unescape(STRIP_HTML.sub("", entry.get("title") or "")).strip()
            link = safe_url(entry.get("link"))
            when = None
            for k in ("published_parsed", "updated_parsed"):
                if entry.get(k):
                    when = struct_time_to_date(entry[k])
                    break
            if when is None:
                when = parse_date(entry.get("published") or entry.get("updated"))
            if when and when < since:
                continue
            summary = html.unescape(STRIP_HTML.sub(" ", entry.get("summary") or entry.get("description") or "")).strip()
            summary = re.sub(r"\s+", " ", summary)[:280]
            tags = [norm(t.get("term")) for t in (entry.get("tags") or []) if t.get("term")]

            hit = headline_track(title, artists, feed_words)
            if not hit:
                continue
            artist, track, kind = hit
            out.append(Item(
                artist=artist,
                title=track,
                kind=kind,
                release_date=when, date_kind="sighting",
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
