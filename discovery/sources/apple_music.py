"""Apple Music charts via the RSS marketing tools JSON (free, no key).

  https://rss.marketingtools.apple.com/api/v2/{storefront}/music/most-recent-albums/{n}/albums.json
  https://rss.marketingtools.apple.com/api/v2/{storefront}/music/most-played/{n}/albums.json

Both are storefront-wide charts, so an album is kept only when its artist is in the profile or one of its genres is
in `sources.apple_music.genres`. Sources are "apple:most-recent" / "apple:most-played"; the charts are algorithmic,
so nothing here is editorial. Look-back: `sources.apple_music.days`, else listenbrainz_fresh.days, else 10.
"""
from __future__ import annotations

from datetime import date, timedelta

from ..models import Item
from ..util import Http, log, norm, parse_date, source_days, split_artists
from . import report

BASE = "https://rss.marketingtools.apple.com/api/v2/{storefront}/music/{path}"
FEEDS = {"most-recent": "most-recent-albums/{n}/albums.json", "most-played": "most-played/{n}/albums.json"}
DEFAULT_GENRES = ["Alternative", "Dance", "Electronic", "Pop", "Indie Pop"]


def _match(profile: dict, artist: str) -> bool:
    arts = profile["artists"]
    return norm(artist) in arts or any(norm(a) in arts for a in split_artists(artist))


def fetch(cfg: dict, profile: dict, http: Http) -> list[Item]:
    scfg = cfg["sources"]["apple_music"]
    storefront = str(scfg.get("storefront") or "us").lower()
    limit = int(scfg.get("limit", 100))
    genres = {norm(g) for g in (scfg.get("genres") or DEFAULT_GENRES)}
    since = date.today() - timedelta(days=source_days(cfg, "apple_music"))
    out: list[Item] = []
    for feed in scfg.get("feeds") or list(FEEDS):
        seen: set[str] = set()      # per chart: an album on both charts is two sightings, merged downstream
        path = FEEDS.get(str(feed))
        name = f"apple:{feed}"
        if not path:
            report(name, False, error="unknown feed (use most-recent / most-played)")
            continue
        try:
            data = http.get(BASE.format(storefront=storefront, path=path.format(n=limit)), cache=False)
        except Exception as exc:  # noqa: BLE001
            log.warning("apple music %s: %s", feed, exc)
            report(name, False, error=exc)
            continue
        results = (data.get("feed") or {}).get("results") or []
        kept = 0
        for r in results:
            artist, title = (r.get("artistName") or "").strip(), (r.get("name") or "").strip()
            if not artist or not title:
                continue
            tags = [norm(g.get("name")) for g in (r.get("genres") or []) if isinstance(g, dict) and g.get("name")]
            tags = [t for t in tags if t and t != "music"]
            if not (_match(profile, artist) or genres & set(tags)):
                continue
            rd = parse_date(r.get("releaseDate"))
            if rd and rd < since:
                continue
            key = str(r.get("id") or r.get("url") or f"{artist}|{title}")
            if key in seen:
                continue
            seen.add(key)
            art = r.get("artworkUrl100") or None
            out.append(Item(
                artist=artist, title=title, kind="release", release=title, release_date=rd, tags=tags,
                sources=[name], links={"apple music": r["url"]} if r.get("url") else {},
                artwork=art.replace("100x100", "600x600") if art else None,
            ))
            kept += 1
        report(name, True, entries=len(results), kept=kept)
    return out
