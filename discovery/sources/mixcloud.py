"""Mixcloud tracklists: what the radio shows you follow played on their newest uploads (public API, no key).

  GET https://api.mixcloud.com/{user}/cloudcasts/?limit={n}     the user's newest uploads, with `key` and `created_time`
  GET https://api.mixcloud.com{key}                              one upload; its `sections` carry the filed tracklist

Beats In Space (Tim Sweeney, WNYU, since 1999) uploads every episode as `bisradio`; any show that files its
tracklists on Mixcloud works the same way: `sources.mixcloud.shows` lists them by the user in the mixcloud.com/<user>
URL. A section of type "track" names the artist and the track; an upload with no sections falls back to the
"Artist - Title" lines of its description, where some shows paste the tracklist instead. Only plays by profile
artists are kept, like NTS and SomaFM. Every play is a sighting dated by the upload, editorial, source
"radio:<show name>". Look-back: `sources.mixcloud.days`, else listenbrainz_fresh.days, else 10.
"""
from __future__ import annotations

import re
from datetime import date, timedelta

from ..models import Item
from ..util import Http, log, norm, parse_date, source_days, split_artists
from . import report

API = "https://api.mixcloud.com"
DEFAULT_SHOWS = [{"name": "Beats In Space", "user": "bisradio"}]
DEFAULT_EPISODES = 3
# "01. Artist - Title", "Artist – Title (Label)", "Artist — Title [Remix]"; never a URL, a timestamp or a bare heading
LINE = re.compile(r"^\s*(?:\d{1,3}[.):]\s*|[-•*]\s*)?(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*)?(?P<artist>[^\-–—\n]{2,120}?)\s+[-–—]\s+(?P<title>[^\n]{2,160}?)\s*$")


def _match(profile: dict, artist: str) -> bool:
    arts = profile["artists"]
    return norm(artist) in arts or any(norm(a) in arts for a in split_artists(artist))


def _section_tracks(cloudcast: dict) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for sec in cloudcast.get("sections") or []:
        if not isinstance(sec, dict):
            continue
        kind = sec.get("section_type") or ("track" if sec.get("track") else None)
        track = sec.get("track")
        if kind != "track" or not isinstance(track, dict):
            continue
        artist = track.get("artist")
        if isinstance(artist, dict):
            artist = artist.get("name")
        title = track.get("name")
        if artist and title:
            out.append((str(artist).strip(), str(title).strip()))
    return out


def description_tracks(text: str | None) -> list[tuple[str, str]]:
    """The "Artist - Title" lines of an upload's description: a pasted tracklist, skipping links and prose."""
    out: list[tuple[str, str]] = []
    for line in (text or "").splitlines():
        if "://" in line or "@" in line or len(line) > 200:
            continue
        m = LINE.match(line)
        if not m:
            continue
        artist, title = m["artist"].strip(), m["title"].strip()
        if len(artist.split()) > 8 or artist.lower() in {"tracklist", "playlist", "part"} or title.endswith(":"):
            continue
        out.append((artist, title))
    return out


def episode_tracks(http: Http, cloudcast: dict) -> list[tuple[str, str]]:
    """The tracklist of one upload: its sections when the listing already carries them, else the upload itself
    (sections, then the description lines)."""
    tracks = _section_tracks(cloudcast)
    if tracks:
        return tracks
    key = cloudcast.get("key")
    full = http.get(API + str(key), cache=False) if key else None
    if isinstance(full, dict):
        tracks = _section_tracks(full) or description_tracks(full.get("description"))
    return tracks or description_tracks(cloudcast.get("description"))


def fetch(cfg: dict, profile: dict, http: Http) -> list[Item]:
    scfg = cfg["sources"]["mixcloud"]
    per_show = int(scfg.get("episodes_per_show", DEFAULT_EPISODES))
    since = date.today() - timedelta(days=source_days(cfg, "mixcloud"))
    out: list[Item] = []
    for show in scfg.get("shows") or DEFAULT_SHOWS:
        if isinstance(show, str):
            show = {"name": show, "user": show}
        user = str(show.get("user") or "").strip("/ ")
        label = str(show.get("name") or user)
        name = f"radio:{label}"
        if not user:
            report(name, False, error="no Mixcloud user (the mixcloud.com/<user> URL)")
            continue
        try:
            data = http.get(f"{API}/{user}/cloudcasts/", params={"limit": per_show}, cache=False)
            casts = (data.get("data") if isinstance(data, dict) else None) or []
            plays = kept = 0
            seen: set[tuple[str, str]] = set()
            for cc in casts[:per_show]:
                if not isinstance(cc, dict):
                    continue
                uploaded = parse_date(cc.get("created_time") or cc.get("updated_time"))
                if uploaded and uploaded < since:
                    continue
                link = str(cc.get("url") or f"https://www.mixcloud.com{cc.get('key') or '/' + user + '/'}")
                for artist, title in episode_tracks(http, cc):
                    plays += 1
                    pair = (norm(artist), norm(title))
                    if pair in seen or not _match(profile, artist):
                        continue
                    seen.add(pair)
                    out.append(Item(artist=artist, title=title, kind="track", release_date=uploaded, date_kind="sighting",
                                    sources=[name], editorial=True, links={"mixcloud": link}, blurb=(cc.get("name") or None)))
                    kept += 1
            report(name, True, entries=plays, kept=kept)
            log.info("mixcloud %s: %d plays over %d uploads, %d kept", user, plays, len(casts), kept)
        except Exception as exc:  # noqa: BLE001
            log.warning("mixcloud %s: %s", user, exc)
            report(name, False, error=exc)
    return out
