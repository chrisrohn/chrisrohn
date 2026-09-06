"""Optional Spotify source: newest albums for your top artists via the (still working) search + artist-albums
endpoints. Since February 2026 a dev-mode app needs a Premium account; browse/new-releases, related-artists and
other users' playlists are gone, so this is strictly a bonus. Set SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET.
"""
from __future__ import annotations

import base64
import os
from datetime import date, timedelta

from ..models import Item
from ..util import Http, log, norm, parse_date, source_days

API = "https://api.spotify.com/v1"


def _token(http: Http) -> str | None:
    cid, secret = os.environ.get("SPOTIFY_CLIENT_ID"), os.environ.get("SPOTIFY_CLIENT_SECRET")
    if not cid or not secret:
        log.warning("spotify enabled but SPOTIFY_CLIENT_ID/SECRET missing")
        return None
    auth = base64.b64encode(f"{cid}:{secret}".encode()).decode()
    resp = http.session.post(
        "https://accounts.spotify.com/api/token",
        data={"grant_type": "client_credentials"},
        headers={"Authorization": f"Basic {auth}"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json().get("access_token")


def fetch(cfg: dict, profile: dict, http: Http) -> list[Item]:
    scfg = cfg["sources"]["spotify"]
    token = _token(http)
    if not token:
        return []
    hdr = {"Authorization": f"Bearer {token}"}
    days = source_days(cfg, "spotify")   # own `days`, else listenbrainz_fresh.days, else 10
    since = date.today() - timedelta(days=days)
    ranked = sorted((e for e in profile["artists"].values() if e.get("kind") == "direct"), key=lambda e: -e["affinity"])
    out: list[Item] = []
    for e in ranked[: int(scfg.get("top_artists", 100))]:
        try:
            s = http.get(f"{API}/search", params={"q": f'artist:"{e["name"]}"', "type": "artist", "limit": 3}, headers=hdr)
        except Exception as exc:  # noqa: BLE001
            log.warning("spotify search %s: %s", e["name"], exc)
            continue
        sid = None
        for a in ((s.get("artists") or {}).get("items") or []):
            if norm(a.get("name")) == norm(e["name"]):
                sid = a["id"]
                break
        if not sid:
            continue
        try:
            al = http.get(f"{API}/artists/{sid}/albums", params={"include_groups": "album,single", "limit": 10}, headers=hdr)
        except Exception as exc:  # noqa: BLE001
            log.warning("spotify albums %s: %s", e["name"], exc)
            continue
        for a in al.get("items") or []:
            rd = parse_date(a.get("release_date"))
            if not rd or rd < since:
                continue
            imgs = a.get("images") or []
            out.append(Item(
                artist=e["name"],
                title=a.get("name") or "",
                kind="release",
                release=a.get("name"),
                release_type=(a.get("album_type") or "").title() or None,
                release_date=rd,
                sources=["spotify"],
                links={"spotify": (a.get("external_urls") or {}).get("spotify", "")},
                artwork=imgs[1]["url"] if len(imgs) > 1 else (imgs[0]["url"] if imgs else None),
            ))
    return out
