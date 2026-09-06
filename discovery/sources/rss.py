"""Music-blog / radio RSS feeds (Pitchfork, Gorilla vs. Bear, Stereogum, Hype Machine, KEXP, Bandcamp Daily...).

Headlines become cards only when they are about one song: `Artist – "Track"`, or `Artist shares new single "Track"`
with a known artist opening the headline (see discovery/headlines.py). News, listicles, interviews, tour dates and
the like are dropped, however many artist names they mention.

Feeds are fetched a few at a time (MAX_WORKERS threads) with conditional GETs — the Http layer keeps each feed's
ETag / Last-Modified and hands back the stored text on 304 — and then read in configured order, so the output is the
same whichever feed answered first. Look-back: `sources.rss.days` (else listenbrainz_fresh.days, else 10), +4 days
of slack for slow blogs.
"""
from __future__ import annotations

import html
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from typing import Any

import feedparser

from ..headlines import headline_track
from ..models import Item
from ..util import BROWSER_USER_AGENT, Http, log, norm, parse_date, safe_url, source_days, struct_time_to_date
from . import report

STRIP_HTML = re.compile(r"<[^>]+>")
MAX_WORKERS = 6
FEED_HEADERS = {"User-Agent": BROWSER_USER_AGENT, "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5"}


def fetch_all(http: Http, urls: list[str], headers: dict | None = None, workers: int = MAX_WORKERS) -> list[Any]:
    """GET every URL concurrently (text, uncached, conditional); results in input order, an Exception where one failed."""
    def one(url: str) -> Any:
        try:
            return http.get(url, as_json=False, cache=False, conditional=True, headers=dict(headers or {}))
        except Exception as exc:  # noqa: BLE001
            return exc
    if not urls:
        return []
    with ThreadPoolExecutor(max_workers=max(1, min(workers, len(urls)))) as pool:
        return list(pool.map(one, urls))


def fetch(cfg: dict, profile: dict, http: Http) -> list[Item]:
    scfg = cfg["sources"]["rss"]
    days = source_days(cfg, "rss")
    since = date.today() - timedelta(days=days + 4)
    artists = profile["artists"]
    out: list[Item] = []
    feeds = [f for f in (scfg.get("feeds") or []) if f.get("url")]
    bodies = fetch_all(http, [f["url"] for f in feeds], FEED_HEADERS, int(scfg.get("workers", MAX_WORKERS)))
    for feed, raw in zip(feeds, bodies, strict=True):
        name = feed["name"]
        if isinstance(raw, Exception):
            log.warning("rss %s: %s", name, raw)
            report(name, False, error=raw)
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
