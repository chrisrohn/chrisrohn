"""ListenBrainz sitewide fresh releases (free, no key).

GET https://api.listenbrainz.org/1/explore/fresh-releases/?days=N&sort=release_date&past=true&future=false
Returns every release MusicBrainz knows about in the window (thousands). We keep those that match the
profile by artist MBID / name, or that carry matching tags.
"""
from __future__ import annotations

from datetime import date, timedelta

from ..models import Item
from ..util import Http, log, norm, parse_date, split_artists

FRESH_URL = "https://api.listenbrainz.org/1/explore/fresh-releases/"
CAA = "https://coverartarchive.org/release/{mbid}/front-250"


def fetch(cfg: dict, profile: dict, http: Http) -> list[Item]:
    scfg = cfg["sources"]["listenbrainz_fresh"]
    days = int(scfg.get("days", 10))
    params = {"days": min(90, days), "sort": "release_date", "past": "true", "future": "false"}
    data = http.get(FRESH_URL, params=params, timeout=120)
    payload = data.get("payload") or data
    releases = payload.get("releases") or []
    log.info("listenbrainz fresh: %d releases in last %d days", len(releases), days)

    artists = profile["artists"]
    mbid_index = profile.get("mbid_index") or {}
    tag_w = profile["tags"]
    min_listens = int(scfg.get("min_listen_count", 0))
    cutoff = date.today() - timedelta(days=days)
    out: list[Item] = []
    for r in releases:
        credit = r.get("artist_credit_name") or ""
        rname = r.get("release_name") or ""
        if not credit or not rname:
            continue
        rd = parse_date(r.get("release_date"))
        if rd and rd < cutoff:
            continue
        mbids = [m for m in (r.get("artist_mbids") or []) if m]
        tags = [norm(t) for t in (r.get("release_tags") or []) if t]
        matched = any(m in mbid_index for m in mbids) or any(norm(a) in artists for a in split_artists(credit)) or norm(credit) in artists
        tag_hit = sum(tag_w.get(t, 0) for t in tags) > 0.25
        listens = int(r.get("listen_count") or 0)
        if not matched and not tag_hit:
            continue
        if listens < min_listens and not matched:
            continue
        rtype = r.get("release_group_primary_type") or None
        secondary = r.get("release_group_secondary_type")
        if secondary and str(secondary).lower() in ("compilation", "live", "remix", "dj-mix", "soundtrack", "audiobook", "spokenword", "interview", "demo"):
            continue
        rel_mbid = r.get("release_mbid")
        rg_mbid = r.get("release_group_mbid")
        links = {}
        if rg_mbid:
            links["musicbrainz"] = f"https://musicbrainz.org/release-group/{rg_mbid}"
        if rel_mbid:
            links["listenbrainz"] = f"https://listenbrainz.org/release/{rel_mbid}"
        art = None
        caa_rel = r.get("caa_release_mbid") or rel_mbid
        if r.get("caa_id") and caa_rel:
            art = CAA.format(mbid=caa_rel)
        out.append(Item(
            artist=credit,
            title=rname,
            kind="release",
            release=rname,
            release_type=rtype,
            release_date=rd,
            tags=tags,
            sources=["listenbrainz"],
            links=links,
            artwork=art,
            artist_mbids=mbids,
            listen_count=listens,
        ))
    return out
