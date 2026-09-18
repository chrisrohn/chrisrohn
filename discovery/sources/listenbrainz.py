"""ListenBrainz sitewide fresh releases (free, no key).

GET https://api.listenbrainz.org/1/explore/fresh-releases/?days=N&sort=release_date&past=true&future=false
Returns every release MusicBrainz knows about in the window (thousands). We keep those by a profile artist of
the configured `kinds` with at least `min_affinity` (by MBID or name; the default is the acts you play and the acts
in your playlists with more than a song or two there — a release by a similar or genre artist, or by an act with
one song in the library, was kept 5–8% of the time against 27% for the rest), or that carry matching tags.
"""
from __future__ import annotations

from datetime import date, timedelta

from ..models import Item
from ..util import Http, log, norm, parse_date, split_artists

FRESH_URL = "https://api.listenbrainz.org/1/explore/fresh-releases/"
CAA = "https://coverartarchive.org/release/{mbid}/front-250"
DEFAULT_KINDS = ("direct", "saved")


def wanted(profile: dict, credit: str, mbids: list[str], kinds: set[str], min_affinity: float) -> bool:
    """Is a release by one of the profile artists this source follows: an act of one of `kinds` with at least
    `min_affinity`, matched by MusicBrainz id, by the whole credit, or by one of the acts in a split credit."""
    artists = profile.get("artists") or {}
    mbid_index = profile.get("mbid_index") or {}
    names = [mbid_index.get(m) for m in mbids] + [norm(credit)] + [norm(a) for a in split_artists(credit)]
    for n in names:
        e = artists.get(n) if n else None
        if e and e.get("kind") in kinds and float(e.get("affinity") or 0) >= min_affinity:
            return True
    return False


def fetch(cfg: dict, profile: dict, http: Http) -> list[Item]:
    scfg = cfg["sources"]["listenbrainz_fresh"]
    days = int(scfg.get("days", 10))
    params = {"days": min(90, days), "sort": "release_date", "past": "true", "future": "false"}
    data = http.get(FRESH_URL, params=params, timeout=120)
    payload = data.get("payload") or data
    releases = payload.get("releases") or []
    log.info("listenbrainz fresh: %d releases in last %d days", len(releases), days)

    tag_w = profile["tags"]
    min_listens = int(scfg.get("min_listen_count", 0))
    kinds = set(scfg.get("kinds") or DEFAULT_KINDS)
    min_aff = float(scfg.get("min_affinity", 0) or 0)
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
        matched = wanted(profile, credit, mbids, kinds, min_aff)
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
