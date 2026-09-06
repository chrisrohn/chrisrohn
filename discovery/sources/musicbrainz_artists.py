"""New release groups of your top artists, by MusicBrainz artist id (free, 1 req/s, honest User-Agent).

  GET https://musicbrainz.org/ws/2/release-group/?query=arid:<mbid> AND firstreleasedate:[<since> TO <today>]&fmt=json

The MBIDs are the ones the profile already resolved (profile["artists"][name]["mbid"], the same field mbid_index is
built from). MusicBrainz allows one request a second, so a run checks `top_artists` artists out of the strongest
`pool`, rotating through it (the cursor lives in data/cache/musicbrainz_artists.json) so every artist comes round
every few days. Look-back: `sources.musicbrainz_artists.days`, else listenbrainz_fresh.days, else 10.
"""
from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

from .. import util
from ..models import Item
from ..util import Http, log, norm, parse_date, read_versioned, source_days, write_versioned
from .musicbrainz import MB_SEARCH, SKIP_SECONDARY

CACHE_VERSION = 1   # {"cursor": n}


def cache_path() -> Path:
    return util.CACHE_DIR / "musicbrainz_artists.json"


def _credit(rg: dict) -> tuple[str, list[str]]:
    credits = rg.get("artist-credit") or []
    name = "".join((c.get("name") or (c.get("artist") or {}).get("name") or "") + (c.get("joinphrase") or "") for c in credits if isinstance(c, dict)).strip()
    mbids = [(c.get("artist") or {}).get("id") for c in credits if isinstance(c, dict) and (c.get("artist") or {}).get("id")]
    return name, mbids


def fetch(cfg: dict, profile: dict, http: Http) -> list[Item]:
    scfg = cfg["sources"]["musicbrainz_artists"]
    per_run = int(scfg.get("top_artists", 150))
    limit = int(scfg.get("limit", 25))
    days = source_days(cfg, "musicbrainz_artists")
    start, end = (date.today() - timedelta(days=days)).isoformat(), date.today().isoformat()
    ranked = [e for e in sorted(profile["artists"].values(), key=lambda e: -e["affinity"]) if e.get("kind") == "direct" and e.get("mbid")]
    ranked = ranked[: int(scfg.get("pool", 600))]
    if not ranked:
        return []
    cache = read_versioned(cache_path(), CACHE_VERSION, {"cursor": 0})
    start_at = int(cache.get("cursor") or 0) % len(ranked)
    batch = (ranked + ranked)[start_at:start_at + min(per_run, len(ranked))]   # never the same artist twice in a run
    write_versioned(cache_path(), CACHE_VERSION, {"cursor": (start_at + per_run) % len(ranked)})

    out: list[Item] = []
    seen: set[str] = set()
    for e in batch:
        q = f"arid:{e['mbid']} AND firstreleasedate:[{start} TO {end}]"
        try:
            data = http.get(MB_SEARCH, params={"query": q, "fmt": "json", "limit": limit})
        except Exception as exc:  # noqa: BLE001
            log.debug("musicbrainz artist %s: %s", e["name"], exc)
            continue
        for rg in data.get("release-groups") or []:
            rgid = rg.get("id")
            if not rgid or rgid in seen:
                continue
            seen.add(rgid)
            sec = {str(s).lower() for s in (rg.get("secondary-types") or [])}
            if sec & SKIP_SECONDARY:
                continue
            credit, mbids = _credit(rg)
            if norm(credit) in ("various artists", "various"):
                continue
            tags = [norm(t.get("name")) for t in (rg.get("tags") or []) if t.get("name")]
            out.append(Item(
                artist=credit or e["name"],
                title=rg.get("title") or "",
                kind="release",
                release=rg.get("title"),
                release_type=rg.get("primary-type"),
                release_date=parse_date(rg.get("first-release-date")),
                tags=tags,
                sources=["musicbrainz:artists"],
                links={"musicbrainz": f"https://musicbrainz.org/release-group/{rgid}"},
                artist_mbids=mbids or [e["mbid"]],
            ))
    log.info("musicbrainz artists: %d of %d checked (cursor %d), %d release groups", len(batch), len(ranked), start_at, len(out))
    return out
