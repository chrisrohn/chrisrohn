"""The catalog: songs for the years the playlists are thin on, drawn from your own listening.

Where the feed hunts what is new, the catalog looks back. Candidates come from Last.fm: the tracks you have played
most and the ones you loved but never filed, then the top tracks of the artists you play and of their similar
artists (what is adjacent). Anything a year playlist or the Skipped playlist already holds is hidden. The rest is
resolved on YouTube Music and given a verified release year in daily batches, on the same caches and budgets as
the feed, and published to site/data/catalog.json for the Catalog tab, where each Keep files into its verified
year. Nothing here spends YouTube API quota.
"""
from __future__ import annotations

import os
from datetime import date, datetime, timedelta

from .models import Item
from .profile import LastFm, load_profile
from .resolve import collapse_shared_videos, resolve_all
from .score import dedupe, score_items
from .util import CACHE_DIR, DATA_DIR, SITE_DATA_DIR, Deadline, Http, log, norm, read_json, read_versioned, safe_url, utcnow, write_json, write_versioned
from .years import verify_years

CATALOG_PATH = SITE_DATA_DIR / "catalog.json"
STATE_PATH = DATA_DIR / "catalog_state.json"       # the candidate snapshot (refreshed weekly) and first_seen dates
TAGS_CACHE = CACHE_DIR / "artist_tags.json"        # artist → Last.fm top tags, kept for good (they hardly change)
TAGS_CACHE_VERSION = 1

DEFAULTS = {
    "enabled": True, "refresh_days": 7, "top_tracks": 3000, "loved_tracks": 2000, "artists_top_n": 150, "per_artist": 8,
    "similar_top_n": 100, "per_similar": 5, "max_items": 2000, "time_budget_minutes": 35, "max_lookups_per_run": 800,
    "max_year_lookups_per_run": 800, "tag_lookups_per_run": 300, "loved_bonus": 1.5, "year_chain": "fast",
    "weights": {"affinity": 4.0, "saved": 2.0, "similar": 2.5, "tags": 1.2, "source_count": 0.6, "freshness": 0.0, "editorial": 0.0, "listens": 2.0, "playable": 0.3, "learned": 1.0},
}


def _cfg(cfg: dict) -> dict:
    c = {**DEFAULTS, **(cfg.get("catalog") or {})}
    c["weights"] = {**DEFAULTS["weights"], **((cfg.get("catalog") or {}).get("weights") or {})}
    return c


# ---------- candidates from Last.fm ----------

def _track(t: dict, source: str, plays: int = 0, loved: bool = False) -> dict | None:
    artist = t.get("artist")
    name = (artist.get("name") or artist.get("#text")) if isinstance(artist, dict) else artist
    title = t.get("name")
    if not name or not title:
        return None
    return {"artist": str(name), "title": str(title), "sources": [source], "plays": int(plays or 0), "loved": loved, "url": safe_url(t.get("url"))}


def gather(cfg: dict, profile: dict, lastfm: LastFm) -> list[dict]:
    """Every candidate the catalog will ever consider, as plain rows (the snapshot lives in catalog_state.json)."""
    c = _cfg(cfg)
    user = cfg["station"]["lastfm_user"]
    rows: list[dict] = []
    for t in lastfm.top_tracks(user, int(c["top_tracks"])):
        r = _track(t, "lastfm:top tracks", plays=t.get("playcount", 0))
        if r:
            rows.append(r)
    for t in lastfm.loved_tracks(user, int(c["loved_tracks"])):
        r = _track(t, "lastfm:loved", loved=True)
        if r:
            rows.append(r)
    artists = profile.get("artists") or {}
    direct = sorted((e for e in artists.values() if e.get("kind") == "direct"), key=lambda e: -e.get("affinity", 0))[: int(c["artists_top_n"])]
    similar = sorted((e for e in artists.values() if e.get("kind") == "similar"), key=lambda e: -e.get("affinity", 0))[: int(c["similar_top_n"])]
    for bucket, source, per in ((direct, "lastfm:artist top", int(c["per_artist"])), (similar, "lastfm:similar top", int(c["per_similar"]))):
        for e in bucket:
            for t in lastfm.artist_top_tracks(e["name"], per):
                r = _track(t, source)
                if r:
                    rows.append(r)
    log.info("catalog: %d candidate rows from Last.fm (%d artists, %d similar)", len(rows), len(direct), len(similar))
    return rows


def _items(rows: list[dict]) -> list[Item]:
    out = []
    for r in rows:
        it = Item(artist=r["artist"], title=r["title"], kind="track", sources=list(r.get("sources") or []), listen_count=int(r.get("plays") or 0),
                  links={"last.fm": r["url"]} if r.get("url") else {})
        it.normalize_credit()
        it.blurb = "loved" if r.get("loved") else None      # private field: carried to the scoring pass, never published
        out.append(it)
    return out


def _tags(items: list[Item], lastfm: LastFm, budget: int) -> None:
    """Genre tags per artist from Last.fm, cached for good; a bounded number of new artists per run."""
    cache: dict[str, dict] = read_versioned(TAGS_CACHE, TAGS_CACHE_VERSION, {})
    looked = 0
    for it in items:
        key = norm(it.artist)
        row = cache.get(key)
        if row is None and lastfm.enabled and looked < budget:
            looked += 1
            tags = []
            for t in lastfm.top_tags(it.artist)[:10]:
                try:
                    cnt = int(t.get("count", 0))
                except (TypeError, ValueError):
                    cnt = 0
                if cnt >= 10 and t.get("name"):
                    tags.append(str(t["name"]).lower())
            row = cache[key] = {"tags": tags[:6], "at": date.today().isoformat()}
        if row:
            it.tags = list(row.get("tags") or [])
    if looked:
        write_versioned(TAGS_CACHE, TAGS_CACHE_VERSION, cache)
    log.info("catalog: tags for %d artists (%d looked up this run)", len(cache), looked)


# ---------- the build ----------

def _playlist_counts(profile: dict) -> dict[str, int]:
    counts: dict[str, int] = {}
    for e in (profile.get("youtube") or {}).get("entries") or []:
        y = str(e.get("year") or "")
        if y.isdigit():
            counts[y] = counts.get(y, 0) + 1
    return counts


def build_catalog(cfg: dict, *, deadline_minutes: float | None = None) -> dict | None:
    c = _cfg(cfg)
    if not c.get("enabled", True):
        return None
    profile = load_profile()
    http = Http("catalog", ttl_hours=72)
    lastfm = LastFm(http, os.environ.get("LASTFM_API_KEY"))
    state = read_json(STATE_PATH, {"fetched_at": None, "candidates": [], "first_seen": {}})
    fetched = state.get("fetched_at")
    stale = not fetched or (utcnow() - datetime.fromisoformat(fetched)) > timedelta(days=int(c["refresh_days"]))
    if stale and lastfm.enabled:
        state["candidates"] = gather(cfg, profile, lastfm)
        state["fetched_at"] = utcnow().isoformat()
    elif stale:
        log.warning("catalog: LASTFM_API_KEY not set; using the last candidate snapshot (%d rows)", len(state.get("candidates") or []))
    http.save()

    items = dedupe(_items(state.get("candidates") or []))
    saved = profile.get("saved") or {}
    saved_videos = {v.get("videoId") for v in saved.values() if isinstance(v, dict) and v.get("videoId")}
    before = len(items)
    items = [i for i in items if i.key not in saved]
    log.info("catalog: %d unique candidates, %d hidden (already in a playlist or skipped)", before, before - len(items))

    _tags(items, lastfm, int(c["tag_lookups_per_run"]))
    http.save()
    ccfg = {**cfg, "ranking": {**cfg["ranking"], "weights": c["weights"], "freshness_days": 1, "undated_freshness": 0.0},
            "resolve": {**(cfg.get("resolve") or {}), "max_lookups_per_run": int(c["max_lookups_per_run"]), "max_year_lookups_per_run": int(c["max_year_lookups_per_run"]), "year_chain": c["year_chain"]}}
    items = _score(items, profile, ccfg, float(c["loved_bonus"]))[: int(c["max_items"])]

    minutes = float(c["time_budget_minutes"]) if deadline_minutes is None else min(float(c["time_budget_minutes"]), deadline_minutes)
    deadline = Deadline(max(0.01, minutes))
    resolve_all(items, ccfg, deadline)
    items = collapse_shared_videos(items)
    items = [i for i in items if i.youtube and i.youtube.get("videoId") not in saved_videos]
    items = _score(items, profile, ccfg, float(c["loved_bonus"]))
    verify_years(items, ccfg, http, deadline)
    http.save()

    first_year = int((cfg.get("youtube_music") or {}).get("first_year", 1979))
    this_year = date.today().year
    # a track whose year has not been looked up yet waits for a later run: the tab is for reviewing, not for guessing
    pending = sum(1 for i in items if i.year_source == "pending")
    items = [i for i in items if i.year_source != "pending" and (i.year is None or first_year <= i.year <= this_year)]
    today_s = date.today().isoformat()
    first_seen: dict[str, str] = state.setdefault("first_seen", {})
    for it in items:
        first_seen.setdefault(it.key, today_s)
    keys = {i.key for i in items}
    state["first_seen"] = {k: v for k, v in first_seen.items() if k in keys}
    write_json(STATE_PATH, state, compact=True)

    counts = _playlist_counts(profile)
    per_year: dict[str, int] = {}
    for it in items:
        y = str(it.year) if it.year else "?"
        per_year[y] = per_year.get(y, 0) + 1
    years = {str(y): {"playlist": counts.get(str(y), 0), "candidates": per_year.get(str(y), 0)} for y in range(this_year, first_year - 1, -1)}
    payload = {
        "generated_at": utcnow().isoformat(),
        "candidates": len(state.get("candidates") or []),
        "count": len(items),
        "undated": per_year.get("?", 0),
        "pending": pending,
        "sources": sorted({s for i in items for s in i.sources}),
        "years": years,
        "items": [_public(i, first_seen.get(i.key)) for i in items],
    }
    write_json(CATALOG_PATH, payload, compact=True)
    log.info("catalog: %d playable candidates published (%d with no year found, %d more waiting for a year lookup)", len(items), per_year.get("?", 0), pending)
    return payload


def _score(items: list[Item], profile: dict, ccfg: dict, loved_bonus: float) -> list[Item]:
    score_items(items, profile, ccfg)
    for it in items:
        if it.listen_count:
            it.reasons.append(f"{it.listen_count} plays")
        if it.blurb == "loved":
            it.score = round(it.score + loved_bonus, 3)
            it.reasons.append("loved on Last.fm")
    items.sort(key=lambda i: (-i.score, i.artist_norm))
    return items


def _public(it: Item, first_seen: str | None) -> dict:
    from .build import _public_item
    d = _public_item(it, first_seen)
    d["plays"] = it.listen_count
    d["loved"] = it.blurb == "loved"
    d["release_date"] = None      # the catalog has no sighting date to show; the year badge is the date
    return d

