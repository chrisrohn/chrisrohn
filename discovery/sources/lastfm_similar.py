"""New artists that sound like Indie Discotheque: Last.fm's similar tracks to the station's own songs.

The seeds are the songs that define the station — the ones you kept lately (ratings.json), your picks (the newest
songs in the year playlists) and the most played tracks of the whole Last.fm history (data/catalog_history.json) —
a batch a run through a cursor, so every seed comes round in turn. For each, Last.fm's track.getSimilar (free,
listener co-occurrence across Last.fm, not tags) names songs that the same people play; only songs by acts the
station has never played and that are not in your profile are kept, so this source finds newcomers and nothing
else. Each carries what it is like (`similar_to`) and how strongly (`fit`: the summed match, weighted by how central
the seed is), which the scoring and the newcomer share of the day rank by (newcomers.py).

Why: of 1,600 cards by acts new to the station rated 2026-09 → 11, 24 were kept. They came from tag crawls, blogs and
radio with nothing tying them to the station's sound; a song that Last.fm listeners play next to Cut Copy's is."""
from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

from .. import util
from ..history import StationHistory
from ..models import Item
from ..util import Http, log, norm, read_json, write_json

CURSOR_FILE = "lastfm_similar.json"   # {"cursor": n, "seeds": n} under data/cache


def _seeds(cfg: dict, profile: dict, history: StationHistory) -> list[tuple[str, str, float, str]]:
    """(artist, title, weight, why) for every seed, the current taste first: songs kept on the site lately, the picks,
    then the most played songs of the whole history (weighted by their plays). One entry per song."""
    from ..learn import load_ratings

    scfg = (cfg.get("sources") or {}).get("lastfm_similar") or {}
    days = int(scfg.get("kept_days", 120) or 120)
    since = (datetime.now(UTC) - timedelta(days=days)).timestamp() * 1000
    out: list[tuple[str, str, float, str]] = []
    seen: set[tuple[str, str]] = set()

    def add(artist: str | None, title: str | None, weight: float, why: str) -> None:
        k = (norm(artist), norm(title))
        if artist and title and all(k) and k not in seen:
            seen.add(k)
            out.append((str(artist), str(title), weight, why))

    kept = sorted(((r.get("at") or 0, r) for r in load_ratings().values() if r.get("decision") == "up" and (r.get("at") or 0) >= since), key=lambda x: -x[0])
    for _, r in kept:
        add(r.get("artist"), r.get("title"), 1.0, "kept")
    for p in profile.get("picks") or []:
        add(p.get("artist"), p.get("title"), 1.0, "pick")
    top = sorted(history.songs.items(), key=lambda kv: -kv[1])[: int(scfg.get("history_seeds", 1500) or 1500)]
    for (a, t), plays in top:
        disp = history.song_names.get((a, t))
        if disp:
            add(disp[0], disp[1], max(0.4, history.relevance(plays)), "history")
    return out


def fetch(cfg: dict, profile: dict, http: Http) -> list[Item]:
    from ..profile import LastFm

    scfg = (cfg.get("sources") or {}).get("lastfm_similar") or {}
    lastfm = LastFm(http, os.environ.get("LASTFM_API_KEY"))
    if not lastfm.enabled:
        log.info("lastfm_similar: no LASTFM_API_KEY; skipping")
        return []
    history = StationHistory.load(reference=int((cfg.get("profile") or {}).get("history_reference_plays", 500)))
    seeds = _seeds(cfg, profile, history)
    if not seeds:
        return []
    artists = profile.get("artists") or {}
    per_run = int(scfg.get("seeds_per_run", 150) or 150)
    per_seed = int(scfg.get("per_seed", 30) or 30)
    min_match = float(scfg.get("min_match", 0.1) or 0.0)
    state = read_json(util.CACHE_DIR / CURSOR_FILE, {}) or {}
    start = int(state.get("cursor") or 0) % len(seeds)
    found: dict[tuple[str, str], dict] = {}
    done = 0
    for n in range(min(per_run, len(seeds))):
        if getattr(http, "deadline", None) and http.deadline.expired:
            break
        artist, title, weight, _why = seeds[(start + n) % len(seeds)]
        done += 1
        data = lastfm.call("track.getsimilar", artist=artist, track=title, limit=per_seed, autocorrect=1)
        for t in ((data.get("similartracks") or {}).get("track") or []):
            a = ((t.get("artist") or {}).get("name") or "").strip()
            name = (t.get("name") or "").strip()
            try:
                match = float(t.get("match") or 0)
            except (TypeError, ValueError):
                match = 0.0
            if not a or not name or match < min_match:
                continue
            an = norm(a)
            # newcomers only: an act the station has played, or one the profile already counts as yours, is not new
            if history.artist_plays(a) or (artists.get(an) or {}).get("kind") in ("direct", "saved"):
                continue
            row = found.setdefault((an, norm(name)), {"artist": a, "title": name, "fit": 0.0, "like": [], "url": t.get("url"), "mbid": (t.get("artist") or {}).get("mbid")})
            row["fit"] += match * weight
            like = f"{artist} – {title}"
            if like not in row["like"]:
                row["like"].append(like)
    state["cursor"] = (start + done) % len(seeds)
    state["seeds"] = len(seeds)
    write_json(util.CACHE_DIR / CURSOR_FILE, state)
    # an act's best two songs, the strongest fits first, up to the source's own cap
    rows = sorted(found.values(), key=lambda r: (-r["fit"], -len(r["like"])))
    per_artist: dict[str, int] = {}
    out: list[Item] = []
    for r in rows:
        an = norm(r["artist"])
        if per_artist.get(an, 0) >= int(scfg.get("per_artist", 2) or 2):
            continue
        per_artist[an] = per_artist.get(an, 0) + 1
        out.append(Item(artist=r["artist"], title=r["title"], kind="track", sources=["lastfm:similar"],
                        links={"last.fm": r["url"]} if r.get("url") else {}, artist_mbids=[r["mbid"]] if r.get("mbid") else [],
                        similar_to=r["like"][:3], fit=round(min(r["fit"], 5.0), 3)))
        if len(out) >= int(scfg.get("max_items", 600) or 600):
            break
    log.info("lastfm similar: %d of %d seeds asked (cursor %d), %d songs by %d acts new to the station", done, len(seeds), start, len(out), len(per_artist))
    return out
