"""Merge duplicate sightings and score items against the taste profile."""
from __future__ import annotations

import math
from datetime import date

from .models import Item
from .util import log, norm, split_artists


def dedupe(items: list[Item]) -> list[Item]:
    by_key: dict[str, Item] = {}
    # secondary index so a "release" from ListenBrainz and a "track" from a blog for the same artist+album merge
    by_artist_release: dict[tuple[str, str], Item] = {}
    for it in items:
        k = it.key
        if k in by_key:
            by_key[k].merge(it)
            continue
        ar = (it.artist_norm, norm(it.release) if it.release else "")
        if ar[1] and ar in by_artist_release and it.kind == "release":
            by_artist_release[ar].merge(it)
            continue
        by_key[k] = it
        if ar[1]:
            by_artist_release.setdefault(ar, it)
    return list(by_key.values())


def _match_artist(it: Item, profile: dict) -> tuple[dict | None, str | None]:
    artists = profile["artists"]
    mbid_index = profile.get("mbid_index") or {}
    for m in it.artist_mbids:
        n = mbid_index.get(m)
        if n and n in artists:
            return artists[n], artists[n]["kind"]
    candidates = [it.artist] + split_artists(it.artist)
    for c in candidates:
        n = norm(c)
        if n in artists:
            return artists[n], artists[n]["kind"]
    return None, None


def score_items(items: list[Item], profile: dict, cfg: dict) -> list[Item]:
    r = cfg["ranking"]
    w = r["weights"]
    fresh_days = float(r.get("freshness_days", 14))
    tags_w: dict[str, float] = profile["tags"]
    today = date.today()

    for it in items:
        reasons: list[str] = []
        s = 0.0
        entry, kind = _match_artist(it, profile)
        if entry:
            it.matched_artist = entry["name"]
            it.match_kind = kind
            if kind == "direct":
                s += w["affinity"] * (0.5 + entry["affinity"])
                reasons.append(f"you play {entry['name']}")
            else:
                s += w["similar"] * (0.4 + entry["affinity"])
                via = ", ".join(entry.get("via", [])[:2])
                reasons.append(f"similar to {via}" if via else "similar artist")
        tag_score = 0.0
        hits: list[str] = []
        for t in it.tags:
            tw = tags_w.get(norm(t))
            if tw:
                tag_score += tw
                if tw > 0:
                    hits.append(t)
        if tag_score:
            s += w["tags"] * max(-4.0, min(2.5, tag_score))
        if hits:
            reasons.append("tags: " + ", ".join(hits[:4]))
        if len(it.sources) > 1:
            s += w["source_count"] * (len(it.sources) - 1)
            reasons.append(f"{len(it.sources)} sources")
        if it.editorial:
            s += w["editorial"]
            reasons.append("editorial pick")
        if it.listen_count:
            s += w["listens"] * math.log10(it.listen_count + 1)
        if it.release_date:
            age = (today - it.release_date).days
            s += w["freshness"] * max(0.0, 1.0 - age / fresh_days)
        else:
            s += w["freshness"] * 0.4
        if it.youtube:
            s += 0.3
        it.score = round(s, 3)
        it.reasons = reasons
    items.sort(key=lambda i: (-i.score, i.artist_norm))
    log.info("scored %d items; top: %s", len(items), [(i.artist, i.title, i.score) for i in items[:3]])
    return items
