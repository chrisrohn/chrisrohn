"""Apply decisions you made on the site.

Payload (sent by the site via GitHub `repository_dispatch`, event_type = "decisions"):
  {"decisions": [{"id": "...", "decision": "up"|"down", "year": 2026, "videoId": "...", "artist": "...", "title": "..."}]}

  * every decision is recorded in data/decisions.json → the item disappears from the feed and shows in the archive
  * "up" decisions are added to the "<year> Indie Discotheque" playlist in YOUR YouTube Music library
    — only here, only for tracks you explicitly approved. The daily feed build never touches playlists.

Needs the YTMUSIC_OAUTH_JSON (or YTMUSIC_HEADERS_RAW / YTMUSIC_BROWSER_JSON) secret (see SETUP.md) for the playlist step; without it,
decisions are still archived and approved tracks stay in `pending_playlist`, retried on the next sync.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import date
from typing import Any

from .util import DATA_DIR, log, read_json, utcnow, write_json

DECISIONS_PATH = DATA_DIR / "decisions.json"


def _load() -> dict:
    d = read_json(DECISIONS_PATH, {"items": {}})
    d.setdefault("items", {})
    d.setdefault("playlists", {})
    return d


def _ytmusic_authed():
    """Authenticated client from whichever secret exists (checked in this order):

    * YTMUSIC_OAUTH_JSON (+ YTMUSIC_OAUTH_CLIENT_ID/SECRET) – created by the "Connect YouTube Music" workflow
    * YTMUSIC_HEADERS_RAW  – request headers copied from the browser's DevTools on music.youtube.com
    * YTMUSIC_BROWSER_JSON – the browser.json produced by `ytmusicapi browser`
    """
    oauth_json = os.environ.get("YTMUSIC_OAUTH_JSON")
    cid, csec = os.environ.get("YTMUSIC_OAUTH_CLIENT_ID"), os.environ.get("YTMUSIC_OAUTH_CLIENT_SECRET")
    raw_headers = os.environ.get("YTMUSIC_HEADERS_RAW")
    raw_json = os.environ.get("YTMUSIC_BROWSER_JSON")
    if not (oauth_json or raw_headers or raw_json):
        return None
    import ytmusicapi
    from ytmusicapi import YTMusic

    tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    tmp.close()
    try:
        if oauth_json:
            if not (cid and csec):
                log.error("YTMUSIC_OAUTH_JSON is set but YTMUSIC_OAUTH_CLIENT_ID/SECRET are missing")
                return None
            from ytmusicapi import OAuthCredentials

            with open(tmp.name, "w", encoding="utf-8") as fh:
                fh.write(oauth_json)
            return YTMusic(tmp.name, oauth_credentials=OAuthCredentials(client_id=cid, client_secret=csec))
        if raw_headers:
            ytmusicapi.setup(filepath=tmp.name, headers_raw=raw_headers.strip())
        else:
            with open(tmp.name, "w", encoding="utf-8") as fh:
                fh.write(raw_json)
        return YTMusic(tmp.name)
    except Exception as exc:  # noqa: BLE001
        log.error("YouTube Music auth failed: %s", exc)
        return None


def _find_year_playlists(yt, cfg: dict, cache: dict[str, str]) -> dict[str, str]:
    """Map '2026' → playlistId by scanning the library for '<year> Indie Discotheque'."""
    pattern = cfg["youtube_music"].get("playlist_title_pattern", "{year} Indie Discotheque")
    rx = re.compile("^" + re.escape(pattern).replace(re.escape("{year}"), r"(\d{4})") + "$", re.I)
    try:
        lib = yt.get_library_playlists(limit=None)
    except Exception as exc:  # noqa: BLE001
        log.warning("could not list library playlists: %s", exc)
        lib = []
    found = dict(cache)
    for pl in lib:
        m = rx.match((pl.get("title") or "").strip())
        if m and pl.get("playlistId"):
            found[m.group(1)] = pl["playlistId"]
    for y, pid in (cfg["youtube_music"].get("playlists") or {}).items():
        found.setdefault(str(y), pid)
    return found


def _cache_lookup(video_id: str | None, item_id: str) -> str | None:
    if video_id:
        return video_id
    yt_cache = read_json(DATA_DIR / "cache" / "youtube.json", {})
    entry = yt_cache.get(item_id) or {}
    return entry.get("videoId")


def apply_decisions(cfg: dict, payload: dict[str, Any]) -> dict:
    decisions = payload.get("decisions") or []
    store = _load()
    now = utcnow().isoformat()
    approved: list[dict] = []
    for d in decisions:
        iid = d.get("id")
        verdict = d.get("decision")
        if not iid or verdict not in ("up", "down"):
            continue
        rec = store["items"].get(iid, {})
        rec.update({
            "decision": verdict,
            "artist": d.get("artist") or rec.get("artist"),
            "title": d.get("title") or rec.get("title"),
            "year": int(d.get("year") or rec.get("year") or date.today().year),
            "videoId": _cache_lookup(d.get("videoId"), iid) or rec.get("videoId"),
            "decided_at": d.get("decided_at") or rec.get("decided_at") or now,
        })
        if verdict == "up" and not rec.get("filed_at"):
            rec["pending_playlist"] = True
            approved.append(dict(rec, id=iid))
        elif verdict == "down":
            rec.pop("pending_playlist", None)
        store["items"][iid] = rec
    log.info("recorded %d decisions (%d approvals to file)", len(decisions), len(approved))

    # include anything approved earlier but not yet filed (e.g. secret was missing)
    for iid, rec in store["items"].items():
        if rec.get("pending_playlist") and rec.get("decision") == "up" and not any(a["id"] == iid for a in approved):
            approved.append(dict(rec, id=iid))

    filed = 0
    yt = _ytmusic_authed()
    if approved and not yt:
        log.warning("YouTube Music not connected — %d approvals stay pending", len(approved))
    elif approved:
        playlists = _find_year_playlists(yt, cfg, store["playlists"])
        store["playlists"] = playlists
        by_year: dict[str, list[dict]] = {}
        for a in approved:
            if not a.get("videoId"):
                log.warning("no videoId for %s – %s; skipping", a.get("artist"), a.get("title"))
                continue
            by_year.setdefault(str(a["year"]), []).append(a)
        for year, recs in by_year.items():
            pid = playlists.get(year)
            if not pid:
                log.warning("no playlist named for %s; %d tracks stay pending", year, len(recs))
                continue
            vids = [r["videoId"] for r in recs]
            try:
                res = yt.add_playlist_items(pid, vids, duplicates=False)
                ok = isinstance(res, dict) and str(res.get("status", "")).upper().startswith("STATUS_SUCC")
                if not ok and isinstance(res, str):
                    ok = "SUCC" in res.upper()
            except Exception as exc:  # noqa: BLE001
                log.error("add to %s failed: %s", year, exc)
                ok = False
            if ok:
                for r in recs:
                    rec = store["items"][r["id"]]
                    rec["filed_at"] = now
                    rec["playlistId"] = pid
                    rec.pop("pending_playlist", None)
                filed += len(recs)
                log.info("filed %d tracks into %s (%s)", len(recs), year, pid)
    store["updated_at"] = now
    write_json(DECISIONS_PATH, store, compact=True)
    return {"recorded": len(decisions), "filed": filed, "pending": sum(1 for r in store["items"].values() if r.get("pending_playlist"))}


def payload_from_env() -> dict:
    raw = os.environ.get("DECISIONS_JSON") or "{}"
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        log.error("DECISIONS_JSON is not valid JSON")
        return {}
