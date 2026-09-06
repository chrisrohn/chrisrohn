"""NTS Radio tracklists: what the selectors you follow played on their latest shows (free, no key).

  GET https://www.nts.live/api/v2/shows/{show}/episodes?offset=0&limit={n}       the show's newest episodes
  GET https://www.nts.live/api/v2/shows/{show}/episodes/{episode_alias}          one episode, with its `tracklist`

The episode list sometimes embeds each episode's tracklist already; when it does not, the episode's `self` link is
followed. Only plays by profile artists are kept (a two-hour show is mostly not for you), like SomaFM. Every play
is a sighting dated by the broadcast, editorial, source "radio:NTS <show>". Look-back: `sources.nts.days`, else
listenbrainz_fresh.days, else 10.
"""
from __future__ import annotations

from datetime import date, timedelta

from ..models import Item
from ..util import Http, log, norm, parse_date, source_days, split_artists
from . import report

API = "https://www.nts.live/api/v2/shows/{show}/episodes"
SITE = "https://www.nts.live/shows/{show}/episodes/{alias}"
DEFAULT_SHOWS = ["balearic-breakfast", "charlie-bones", "the-do-you-show", "moxie", "bullion"]


def _match(profile: dict, artist: str) -> bool:
    arts = profile["artists"]
    return norm(artist) in arts or any(norm(a) in arts for a in split_artists(artist))


def _self_link(ep: dict) -> str | None:
    for link in ep.get("links") or []:
        if isinstance(link, dict) and link.get("rel") == "self" and link.get("href"):
            return str(link["href"])
    return None


def _tracklist(http: Http, show: str, ep: dict) -> list[dict]:
    tracks = ep.get("tracklist")
    if isinstance(tracks, list):
        return tracks
    alias = ep.get("episode_alias") or ep.get("alias")
    url = _self_link(ep) or (API.format(show=show) + f"/{alias}" if alias else None)
    if not url:
        return []
    full = http.get(url, cache=False)
    return full.get("tracklist") or [] if isinstance(full, dict) else []


def fetch(cfg: dict, profile: dict, http: Http) -> list[Item]:
    scfg = cfg["sources"]["nts"]
    per_show = int(scfg.get("episodes_per_show", 2))
    since = date.today() - timedelta(days=source_days(cfg, "nts"))
    out: list[Item] = []
    for show in scfg.get("shows") or DEFAULT_SHOWS:
        name = f"radio:NTS {show}"
        try:
            data = http.get(API.format(show=show), params={"offset": 0, "limit": per_show}, cache=False)
            episodes = (data.get("results") if isinstance(data, dict) else None) or []
            plays = kept = 0
            seen: set[tuple[str, str]] = set()
            for ep in episodes[:per_show]:
                aired = parse_date(ep.get("broadcast") or ep.get("updated"))
                if aired and aired < since:
                    continue
                alias = ep.get("episode_alias") or ep.get("alias") or ""
                link = SITE.format(show=show, alias=alias) if alias else f"https://www.nts.live/shows/{show}"
                for tr in _tracklist(http, show, ep):
                    artist = (tr.get("artist") or "").strip()
                    title = (tr.get("title") or "").strip()
                    if not artist or not title:
                        continue
                    plays += 1
                    key = (norm(artist), norm(title))
                    if key in seen or not _match(profile, artist):
                        continue
                    seen.add(key)
                    out.append(Item(artist=artist, title=title, kind="track", release_date=aired, date_kind="sighting",
                                    sources=[name], editorial=True, links={"nts": link}, blurb=(ep.get("name") or None)))
                    kept += 1
            report(name, True, entries=plays, kept=kept)
        except Exception as exc:  # noqa: BLE001
            log.warning("nts %s: %s", show, exc)
            report(name, False, error=exc)
    return out
