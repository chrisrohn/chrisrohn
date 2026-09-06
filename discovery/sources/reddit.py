"""Music subreddits (r/indieheads, r/listentothis, ...): the newest link posts, read as `Artist - Song [genre] (year)`.

  GET https://www.reddit.com/r/{sub}/new.json?limit=100   (reddit refuses generic User-Agents; ours names the project)

A post is kept when it links to YouTube, Bandcamp, SoundCloud or Spotify, scores at least `min_score`, is newer than
the source's look-back and its title splits into artist and track (util.parse_artist_title, after the trailing
`[genre] (year)` fragments are peeled off: the year becomes stated_year, the genre a tag). The link is kept under
its host family; a YouTube link keeps its video id (resolve looks the song up on YouTube Music itself). Every post
is a sighting dated by its posting, source "reddit:<sub>". Look-back: `sources.reddit.days`, else
listenbrainz_fresh.days, else 10.
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from urllib.parse import parse_qs, urlparse

from ..models import Item
from ..util import Http, log, parse_artist_title, parse_date, safe_url, source_days
from . import report

NEW_URL = "https://www.reddit.com/r/{sub}/new.json"
HEADERS = {"User-Agent": "chrisrohn-new-music/1.0 (+https://chrisrohn.com)"}
DEFAULT_SUBREDDITS = ["indieheads", "listentothis", "futurefunkairlines", "nudisco"]
_TRAIL = re.compile(r"\s*(?:\[(?P<genre>[^\]]{1,60})\]|\((?P<year>(?:19|20)\d{2})\))\s*$")
_YT_ID = re.compile(r"^[\w-]{11}$")


def split_title(text: str) -> tuple[str, int | None, list[str]]:
    """'Jungle - Keep Moving [Nu-Disco / Funk] (2026)' → ('Jungle - Keep Moving', 2026, ['nu-disco', 'funk'])."""
    t = re.sub(r"\s+", " ", text or "").strip()
    t = re.sub(r"\s+-{2,}\s+", " - ", t)          # r/listentothis writes "Artist -- Song"
    year, tags = None, []
    while True:
        m = _TRAIL.search(t)
        if not m:
            break
        if m.group("year"):
            year = year or int(m.group("year"))
        else:
            tags[0:0] = [g.strip().lower() for g in re.split(r"\s*[/,|]\s*", m.group("genre")) if g.strip()]
        t = t[: m.start()].strip()
    return t, year, tags


def link_family(url: str | None) -> tuple[str, str] | None:
    """(family, canonical url) for a YouTube / Bandcamp / SoundCloud / Spotify link; None for anything else."""
    u = safe_url(url)
    if not u:
        return None
    p = urlparse(u)
    host = (p.hostname or "").lower()
    if host in ("youtu.be", "www.youtu.be") or host.endswith("youtube.com"):
        vid = None
        if host.endswith("youtu.be"):
            vid = p.path.strip("/").split("/")[0]
        else:
            vid = (parse_qs(p.query).get("v") or [None])[0]
            if not vid:
                m = re.match(r"^/(?:shorts|embed|live)/([\w-]{11})", p.path)
                vid = m.group(1) if m else None
        return ("youtube", f"https://www.youtube.com/watch?v={vid}") if vid and _YT_ID.match(vid) else None
    if host.endswith("bandcamp.com"):
        return "bandcamp", u
    if host.endswith("soundcloud.com"):
        return "soundcloud", u
    if host.endswith("spotify.com"):
        return "spotify", u
    return None


def fetch(cfg: dict, profile: dict, http: Http) -> list[Item]:
    scfg = cfg["sources"]["reddit"]
    min_score = int(scfg.get("min_score", 5))
    since = date.today() - timedelta(days=source_days(cfg, "reddit"))
    out: list[Item] = []
    for sub in scfg.get("subreddits") or DEFAULT_SUBREDDITS:
        name = f"reddit:{sub}"
        try:
            data = http.get(NEW_URL.format(sub=sub), params={"limit": 100}, cache=False, headers=dict(HEADERS))
        except Exception as exc:  # noqa: BLE001
            log.warning("reddit %s: %s", sub, exc)
            report(name, False, error=exc)
            continue
        posts = [c.get("data") or {} for c in ((data.get("data") or {}).get("children") or []) if isinstance(c, dict)]
        kept = 0
        for post in posts:
            if post.get("is_self") or int(post.get("score") or 0) < min_score:
                continue
            posted = parse_date(post.get("created_utc"))
            if posted and posted < since:
                continue
            fam = link_family(post.get("url"))
            if not fam:
                continue
            core, year, tags = split_title(post.get("title") or "")
            pair = parse_artist_title(core)
            if not pair:
                continue
            artist, track = pair
            links = {fam[0]: fam[1]}
            permalink = safe_url("https://www.reddit.com" + str(post.get("permalink") or "")) if post.get("permalink") else None
            if permalink:
                links["reddit"] = permalink
            out.append(Item(
                artist=artist, title=track, kind="track", release_date=posted, date_kind="sighting", stated_year=year,
                tags=tags, sources=[name], links=links, youtube=None, listen_count=0,
                blurb=f"r/{sub} · {int(post.get('score') or 0)} points",
            ))
            kept += 1
        report(name, True, entries=len(posts), kept=kept)
    return out
