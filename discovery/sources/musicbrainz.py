"""MusicBrainz release-group search by tag + first release date (free, 1 req/s, needs a User-Agent).

Catches genre-tagged releases from artists you have never heard of — the old "Edge of <genre>" idea.
"""
from __future__ import annotations

from datetime import date, timedelta

from ..models import Item
from ..util import Http, log, norm, parse_date

MB_SEARCH = "https://musicbrainz.org/ws/2/release-group/"
SKIP_SECONDARY = {"compilation", "live", "remix", "dj-mix", "soundtrack", "audiobook", "spokenword", "interview", "demo"}


def fetch(cfg: dict, profile: dict, http: Http) -> list[Item]:
    scfg = cfg["sources"]["musicbrainz_tags"]
    days = int(scfg.get("days", 10))
    start = (date.today() - timedelta(days=days)).isoformat()
    end = date.today().isoformat()
    limit = int(scfg.get("limit_per_tag", 50))
    out: list[Item] = []
    seen: set[str] = set()
    for tag in scfg.get("tags") or []:
        q = f'tag:"{tag}" AND firstreleasedate:[{start} TO {end}]'
        try:
            data = http.get(MB_SEARCH, params={"query": q, "fmt": "json", "limit": limit})
        except Exception as exc:  # noqa: BLE001
            log.warning("musicbrainz tag %s failed: %s", tag, exc)
            continue
        for rg in data.get("release-groups") or []:
            rgid = rg.get("id")
            if not rgid or rgid in seen:
                continue
            seen.add(rgid)
            sec = {str(s).lower() for s in (rg.get("secondary-types") or [])}
            if sec & SKIP_SECONDARY:
                continue
            credits = rg.get("artist-credit") or []
            credit = "".join((c.get("name") or (c.get("artist") or {}).get("name") or "") + (c.get("joinphrase") or "") for c in credits if isinstance(c, dict)).strip()
            if not credit or norm(credit) in ("various artists", "various"):
                continue
            mbids = [(c.get("artist") or {}).get("id") for c in credits if isinstance(c, dict) and (c.get("artist") or {}).get("id")]
            tags = [norm(t.get("name")) for t in (rg.get("tags") or []) if t.get("name")]
            if norm(tag) not in tags:
                tags.append(norm(tag))
            out.append(Item(
                artist=credit,
                title=rg.get("title") or "",
                kind="release",
                release=rg.get("title"),
                release_type=rg.get("primary-type"),
                release_date=parse_date(rg.get("first-release-date")),
                tags=tags,
                sources=["musicbrainz"],
                links={"musicbrainz": f"https://musicbrainz.org/release-group/{rgid}"},
                artist_mbids=mbids,
            ))
    return out
