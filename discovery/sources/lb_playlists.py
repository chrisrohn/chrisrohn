"""ListenBrainz recommendation playlists ("Weekly Exploration", "Weekly Jams") for a ListenBrainz user.

Free collaborative filtering over everyone's listens. Needs a ListenBrainz account that imports your Last.fm
history (Settings → Import → Last.fm) — set sources.listenbrainz_playlists.user to that username.
"""
from __future__ import annotations

from ..models import Item
from ..util import Http, log

API = "https://api.listenbrainz.org/1"


def fetch(cfg: dict, profile: dict, http: Http) -> list[Item]:
    scfg = cfg["sources"]["listenbrainz_playlists"]
    user = (scfg.get("user") or "").strip()
    if not user:
        log.info("listenbrainz_playlists: no user configured; skipping")
        return []
    kinds = [k.lower() for k in (scfg.get("kinds") or ["exploration", "jams"])]
    data = http.get(f"{API}/user/{user}/playlists/createdfor", params={"count": 10}, cache=False)
    out: list[Item] = []
    for pl in data.get("playlists") or []:
        meta = pl.get("playlist") or {}
        title = (meta.get("title") or "").lower()
        if not any(k in title for k in kinds):
            continue
        ident = (meta.get("identifier") or "").rstrip("/").split("/")[-1]
        if not ident:
            continue
        try:
            full = http.get(f"{API}/playlist/{ident}", cache=False)
        except Exception as exc:  # noqa: BLE001
            log.warning("listenbrainz playlist %s: %s", ident, exc)
            continue
        label = "LB Weekly Exploration" if "exploration" in title else "LB Weekly Jams"
        for tr in ((full.get("playlist") or {}).get("track") or []):
            artist, name = tr.get("creator"), tr.get("title")
            if not artist or not name:
                continue
            ext = ((tr.get("extension") or {}).get("https://musicbrainz.org/doc/jspf#track") or {})
            mbids = ext.get("artist_identifiers") or []
            out.append(Item(
                artist=artist, title=name, kind="track", sources=[f"listenbrainz:{label}"], editorial=True,
                artist_mbids=[m.rstrip("/").split("/")[-1] for m in mbids],
                links={"listenbrainz": tr.get("identifier") or f"https://listenbrainz.org/playlist/{ident}"},
            ))
    return out
