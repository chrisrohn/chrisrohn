"""The catalog: the station's whole Last.fm play history, reviewed song by song.

Where the feed hunts what is new, the catalog looks back at what has already been played. The candidates are every
track `station.lastfm_user` has ever scrobbled — user.getTopTracks over `overall`, every page, one row a track with
its play count — flagged when loved, and dated by the scrobble log (user.getRecentTracks, walked newest to oldest a
few hundred pages a run until the whole log is read, then kept up to date from the newest scrobble on), so each card
says how often and how recently the station played it. Anything a year playlist or the Skipped playlist already holds
is hidden. The rest is resolved on YouTube Music — the exact edition: "Song (X Remix)" is the remix or nothing, never
the original the library most likely holds — and given a verified release year in daily batches, on the same caches
and budgets as the feed, and published to site/data/catalog.json for the Catalog tab, the most played first, where
each Keep files into its verified year. Nothing here spends YouTube API quota.

Until 2026-09-18 the catalog also carried the top tracks of the artists you play and of their similar artists, and
put loved tracks first: of the 914 such cards rated, the artists' hits were kept 1% of the time, the similar artists'
hits and the loved tracks 0%. The history is the catalog.
"""
from __future__ import annotations

import os
import time
from datetime import UTC, date, datetime, timedelta

from .learn import load_ratings, wrong_videos
from .models import Item
from .profile import LastFm, load_profile
from .resolve import audio_summary, collapse_shared_videos, drop_by_length, is_audio, resolve_all
from .score import dedupe, score_items
from .util import CACHE_DIR, DATA_DIR, SITE_DATA_DIR, Deadline, Http, log, norm, read_json, read_versioned, safe_url, utcnow, write_json, write_versioned
from .years import verify_years

CATALOG_PATH = SITE_DATA_DIR / "catalog.json"
STATE_PATH = DATA_DIR / "catalog_state.json"       # the candidate snapshot (refreshed weekly), the scrobble walk and first_seen dates
TAGS_CACHE = CACHE_DIR / "artist_tags.json"        # artist → Last.fm top tags, kept for good (they hardly change)
TAGS_CACHE_VERSION = 1
HISTORY = "lastfm:history"                         # every candidate's source; loved tracks carry "lastfm:loved" as well
LOVED = "lastfm:loved"
RECENT_PLAY_YEARS = 8.0                            # a track last played this long ago has spent its recent-play bonus

DEFAULTS = {
    "enabled": True, "refresh_days": 7, "history_tracks": 0, "loved_tracks": 0, "max_items": 2500, "time_budget_minutes": 35,
    "max_lookups_per_run": 800, "max_year_lookups_per_run": 800, "tag_lookups_per_run": 300, "loved_bonus": 1.0, "year_chain": "fast",
    "scrobble_dates": True, "scrobble_pages_per_run": 300, "scrobble_minutes": 6,
    "weights": {"affinity": 4.0, "saved": 2.0, "similar": 2.5, "tags": 1.2, "source_count": 0.0, "freshness": 0.0, "editorial": 0.0, "listens": 2.0, "learned": 1.0, "recent_play": 1.0},
}


def _cfg(cfg: dict) -> dict:
    c = {**DEFAULTS, **(cfg.get("catalog") or {})}
    c["weights"] = {**DEFAULTS["weights"], **((cfg.get("catalog") or {}).get("weights") or {})}
    return c


# ---------- the history: keys, plays, dates ----------

def history_key(artist: str, title: str) -> str:
    """The id a play-history row has as a card: the same key a feed item gets (Rohn Standard Notation applied, so a
    scrobble's "Song feat. B (X Remix)" and the card's "Song (X Remix)" are one), for joining the history to the
    playlist rows and the resolver's cache."""
    return Item(artist=artist, title=title).normalize_credit().key


def _artist_name(t: dict) -> str:
    artist = t.get("artist")
    return str((artist.get("name") or artist.get("#text")) if isinstance(artist, dict) else artist or "")


def _track(t: dict, plays: int = 0, loved: bool = False) -> dict | None:
    name, title = _artist_name(t), t.get("name")
    if not name or not title:
        return None
    return {"artist": name, "title": str(title), "sources": [HISTORY] + ([LOVED] if loved else []), "plays": int(plays or 0), "loved": loved, "url": safe_url(t.get("url"))}


def gather(cfg: dict, lastfm: LastFm) -> list[dict]:
    """Every track the station has ever played, as plain rows (the snapshot lives in catalog_state.json): the whole
    of user.getTopTracks (`catalog.history_tracks` caps it; 0 = every page), the loved tracks flagged."""
    c = _cfg(cfg)
    user = cfg["station"]["lastfm_user"]
    rows: dict[str, dict] = {}
    for t in lastfm.top_tracks(user, int(c["history_tracks"] or 0)):
        r = _track(t, plays=t.get("playcount", 0))
        if r:
            rows.setdefault(history_key(r["artist"], r["title"]), r)
    loved = 0
    for t in lastfm.loved_tracks(user, int(c["loved_tracks"] or 0)):
        r = _track(t, loved=True)
        if not r:
            continue
        k = history_key(r["artist"], r["title"])
        row = rows.setdefault(k, r)
        if not row.get("loved"):
            row["loved"] = True
            row["sources"] = [HISTORY, LOVED]
        loved += 1
    log.info("catalog: %d tracks in the Last.fm history (%d loved)", len(rows), loved)
    return list(rows.values())


def history_plays(state: dict | None = None) -> dict[str, int]:
    """{card id: plays} for every track in the play history, from the catalog's snapshot (no request): what the
    Videos workflow orders the library by."""
    st = state if state is not None else read_json(STATE_PATH, {})
    out: dict[str, int] = {}
    for r in (st.get("candidates") or []):
        try:
            out[history_key(r["artist"], r["title"])] = int(r.get("plays") or 0)
        except (KeyError, TypeError, ValueError):
            continue
    return out


def walk_scrobbles(lastfm: LastFm, user: str, state: dict, pages: int, deadline: Deadline | None = None) -> dict:
    """Read the scrobble log a few pages a run (200 plays a page) into state["scrobbles"]: for every track the first
    and the last time it was played, as Unix times, keyed like the cards. The log is walked from the newest play
    down until its beginning is reached ("complete"); after that each run first closes the gap between the newest
    play it knows and now, top down, so a run cut short resumes exactly where it stopped and never skips a page.
    Returns the walk's state."""
    sc = state.setdefault("scrobbles", {"newest": None, "oldest": None, "complete": False, "gap": None, "total": None, "tracks": {}})
    tracks: dict[str, list[int]] = sc.setdefault("tracks", {})
    deadline = deadline or Deadline(None)

    def absorb(rows: list[dict]) -> int:
        low = None
        for t in rows:
            try:
                uts = int((t.get("date") or {}).get("uts") or 0)
            except (TypeError, ValueError):
                continue
            if not uts:
                continue
            name, title = _artist_name(t), t.get("name")
            if not name or not title:
                continue
            k = history_key(name, str(title))
            cur = tracks.get(k)
            tracks[k] = [min(cur[0], uts), max(cur[1], uts)] if cur else [uts, uts]
            sc["oldest"] = uts if sc["oldest"] is None else min(sc["oldest"], uts)
            sc["newest"] = uts if sc["newest"] is None else max(sc["newest"], uts)
            low = uts if low is None else min(low, uts)
        return low or 0

    left = max(0, int(pages))
    opened = sc["newest"] is None      # a first run has nothing to catch up on: the walk starts at the top of the log
    fetched = 0
    while left > 0 and not deadline.expired and lastfm.enabled:
        if sc.get("gap") is None and sc["newest"] and not opened:
            now = int(time.time())
            opened = True
            if now > int(sc["newest"]):
                sc["gap"] = {"lo": int(sc["newest"]), "hi": now}      # the plays since the last walk, walked top down
        if sc.get("gap"):
            g = sc["gap"]
            rows, _attr = lastfm.recent_tracks(user, from_uts=g["lo"] + 1, to_uts=g["hi"])
            left -= 1
            fetched += 1
            if not rows:
                sc["newest"] = max(int(sc["newest"] or 0), int(g["hi"]))
                sc["gap"] = None
                continue
            low = absorb(rows)
            g["hi"] = (low or g["hi"]) - 1
            if g["hi"] <= g["lo"]:
                sc["gap"] = None
            continue
        if sc.get("complete"):
            break
        rows, attr = lastfm.recent_tracks(user, to_uts=(int(sc["oldest"]) - 1) if sc["oldest"] else None)
        left -= 1
        fetched += 1
        if sc.get("total") is None and str(attr.get("total") or "").isdigit():
            sc["total"] = int(attr["total"])
        if not rows:
            sc["complete"] = True
            break
        absorb(rows)
    if fetched:
        log.info("catalog: %d pages of the scrobble log read; %d tracks dated, walked back to %s%s", fetched, len(tracks),
                 datetime.fromtimestamp(sc["oldest"], tz=UTC).date().isoformat() if sc.get("oldest") else "?", " (the whole log)" if sc.get("complete") else "")
    return sc


def _items(rows: list[dict]) -> list[Item]:
    out = []
    for r in rows:
        it = Item(artist=r["artist"], title=r["title"], kind="track", sources=list(r.get("sources") or [HISTORY]), listen_count=int(r.get("plays") or 0),
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


def _iso_day(uts: int | None) -> str | None:
    if not uts:
        return None
    try:
        return datetime.fromtimestamp(int(uts), tz=UTC).date().isoformat()
    except (OverflowError, OSError, ValueError, TypeError):
        return None


def build_catalog(cfg: dict, *, deadline_minutes: float | None = None) -> dict | None:
    c = _cfg(cfg)
    if not c.get("enabled", True):
        return None
    profile = load_profile()
    http = Http("catalog", ttl_hours=72)
    lastfm = LastFm(http, os.environ.get("LASTFM_API_KEY"))
    user = cfg["station"]["lastfm_user"]
    state = read_json(STATE_PATH, {"fetched_at": None, "candidates": [], "first_seen": {}})
    fetched = state.get("fetched_at")
    stale = not fetched or (utcnow() - datetime.fromisoformat(fetched)) > timedelta(days=int(c["refresh_days"]))
    if stale and lastfm.enabled:
        state["candidates"] = gather(cfg, lastfm)
        state["fetched_at"] = utcnow().isoformat()
    elif stale:
        log.warning("catalog: LASTFM_API_KEY not set; using the last candidate snapshot (%d rows)", len(state.get("candidates") or []))
    minutes = float(c["time_budget_minutes"]) if deadline_minutes is None else min(float(c["time_budget_minutes"]), deadline_minutes)
    deadline = Deadline(max(0.01, minutes))
    # the scrobble log, a few hundred pages a run inside its own slice of the clock: what it has read so far dates
    # the cards it has reached, and a track it has not reached yet is older than the oldest play it has read
    scrobbles = state.get("scrobbles") or {}
    if c.get("scrobble_dates", True) and lastfm.enabled:
        scrobbles = walk_scrobbles(lastfm, user, state, int(c["scrobble_pages_per_run"] or 0), Deadline(min(minutes, float(c["scrobble_minutes"] or 0) or minutes)))
    write_json(STATE_PATH, state, compact=True)
    http.save()

    items = dedupe(_items(state.get("candidates") or []))
    saved = profile.get("saved") or {}
    saved_videos = {v.get("videoId") for v in saved.values() if isinstance(v, dict) and v.get("videoId")}
    before = len(items)
    items = [i for i in items if i.key not in saved]
    log.info("catalog: %d unique candidates, %d hidden (already in a playlist or skipped), %d to review", before, before - len(items), len(items))

    _tags(items, lastfm, int(c["tag_lookups_per_run"]))
    http.save()
    dates: dict[str, list[int]] = scrobbles.get("tracks") or {}
    ccfg = {**cfg, "ranking": {**cfg["ranking"], "weights": c["weights"], "freshness_days": 1, "undated_freshness": 0.0},
            "resolve": {**(cfg.get("resolve") or {}), "max_lookups_per_run": int(c["max_lookups_per_run"]), "max_year_lookups_per_run": int(c["max_year_lookups_per_run"]), "year_chain": c["year_chain"]}}
    # every candidate is scored and carried into resolution: the lookup budgets bound each run, the cache carries the
    # answers, and the most played (the strongest scores) are looked up first
    items = _score(items, profile, ccfg, c, dates)

    # a card the curator flagged as the wrong video is resolved again without that upload (data/ratings.json)
    resolve_all(items, ccfg, deadline, avoid=wrong_videos(load_ratings()))
    items = collapse_shared_videos(items)
    items = drop_by_length(items, ccfg)     # the same song-length range as the feed: no interludes, no DJ mixes
    items = [i for i in items if is_audio(i.youtube) and i.youtube.get("videoId") not in saved_videos]   # every card plays its audio track
    items = _score(items, profile, ccfg, c, dates)
    verify_years(items, ccfg, http, deadline)
    http.save()

    first_year = int((cfg.get("youtube_music") or {}).get("first_year", 1979))
    this_year = date.today().year
    # a track whose year has not been looked up yet waits for a later run: the tab is for reviewing, not for guessing
    pending = sum(1 for i in items if i.year_source == "pending")
    items = [i for i in items if i.year_source != "pending" and (i.year is None or first_year <= i.year <= this_year)]
    playable = len(items)
    items = items[: int(c["max_items"] or 0) or None]
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
        "playable": playable,          # …of which the tab shows the best `catalog.max_items`
        "undated": per_year.get("?", 0),
        "pending": pending,
        "sources": sorted({s for i in items for s in i.sources}),
        "years": years,
        "audio": audio_summary(items),
        # the play history behind the tab: how many tracks it holds, how far the scrobble log has been read
        "history": {"fetched_at": state.get("fetched_at"), "tracks": len(state.get("candidates") or []), "scrobbles": scrobbles.get("total"),
                    "dated": sum(1 for i in items if i.key in dates), "walked_back_to": _iso_day(scrobbles.get("oldest")), "complete": bool(scrobbles.get("complete"))},
        "items": [_public(i, first_seen.get(i.key), dates.get(i.key)) for i in items],
    }
    write_json(CATALOG_PATH, payload, compact=True)
    log.info("catalog: %d of %d playable candidates published (%d with no year found, %d more waiting for a year lookup)", len(items), playable, per_year.get("?", 0), pending)
    return payload


def _month(iso: str | None) -> str:
    try:
        return datetime.fromisoformat(iso).strftime("%b %Y") if iso else ""
    except ValueError:
        return ""


def _score(items: list[Item], profile: dict, ccfg: dict, c: dict, dates: dict[str, list[int]]) -> list[Item]:
    """The feed's scoring with the catalog's weights, then what only the history knows: the plays are already in
    (`listens`), a track played recently earns `recent_play` (fading over RECENT_PLAY_YEARS), a loved one
    `loved_bonus`; the reasons say so on the card."""
    score_items(items, profile, ccfg)
    w_recent = float((c.get("weights") or {}).get("recent_play", 0) or 0)
    loved_bonus = float(c.get("loved_bonus", 0) or 0)
    today = date.today()
    for it in items:
        if it.listen_count:
            it.reasons.append(f"{it.listen_count} plays")
        span = dates.get(it.key)
        if span and span[1]:
            last = _iso_day(span[1])
            if last:
                age_years = (today - date.fromisoformat(last)).days / 365.25
                bonus = w_recent * max(0.0, 1.0 - age_years / RECENT_PLAY_YEARS)
                it.score = round(it.score + bonus, 3)
                it.reasons.append(f"last played {_month(last)}")
        if it.blurb == "loved":
            it.score = round(it.score + loved_bonus, 3)
            it.reasons.append("loved on Last.fm")
    items.sort(key=lambda i: (-i.score, -i.listen_count, i.artist_norm))
    return items


def _public(it: Item, first_seen: str | None, span: list[int] | None) -> dict:
    from .build import _public_item
    d = _public_item(it, first_seen)
    d["plays"] = it.listen_count
    d["loved"] = it.blurb == "loved"
    d["first_played"] = _iso_day(span[0]) if span else None
    d["last_played"] = _iso_day(span[1]) if span else None
    d["release_date"] = None      # the catalog has no sighting date to show; the year badge is the date
    return d
