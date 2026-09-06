"""Merge duplicate sightings and score items against the taste profile."""
from __future__ import annotations

import math
from datetime import date

from .learn import adjustment, exploration
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
    n = norm(it.artist)
    if n in artists:
        return artists[n], artists[n]["kind"]
    # a collaboration credit: each named act counts, but only when the credit is unambiguously split ("A & B",
    # "A feat. B"), never on "and" / "with" / "x", and never for a one-letter fragment
    for c in split_artists(it.artist, strict=True):
        cn = norm(c)
        if len(cn) > 1 and cn != n and cn in artists:
            return artists[cn], artists[cn]["kind"]
    return None, None


def score_items(items: list[Item], profile: dict, cfg: dict) -> list[Item]:
    r = cfg["ranking"]
    w = r["weights"]
    fresh_days = float(r.get("freshness_days", 60))
    undated = float(r.get("undated_freshness", 0.2))   # no date at all: less than anything released recently
    tags_w: dict[str, float] = profile["tags"]
    learned = profile.get("learned")
    today = date.today()
    # labels you trust (sources.musicbrainz_labels.labels): a release on one of them is a signal of its own, whatever
    # the tag table knows (label: tags never match a genre weight)
    trusted = {norm(label) for label in ((cfg.get("sources") or {}).get("musicbrainz_labels") or {}).get("labels") or []}

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
            elif kind == "saved":
                s += w.get("saved", 2.0) * (0.5 + entry["affinity"])
                reasons.append(f"{entry['name']} is in your playlists")
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
            s += w["freshness"] * undated
        if it.youtube:
            s += float(w.get("playable", 0.3))
        labels = [t[6:].strip() for t in it.tags if t.lower().startswith("label:")]
        on = next((label for label in labels if norm(label) in trusted), None)
        if on:
            s += float(w.get("label", 1.0))
            reasons.append(f"on {on}")
        # what the curator actually kept: sources, blogs, tags and artists with a track record (see learn.py)
        adj, why = adjustment(learned, it.sources, it.tags, it.artist)
        if adj:
            s += float(w.get("learned", 1.0)) * adj
            reasons.extend(why)
        # what the curator has barely seen: a fair look before the keep rate has an opinion (see learn.exploration)
        x = exploration(learned, it.sources, it.tags, it.artist)
        if x:
            s += float(w.get("explore", 1.0)) * x
            if x >= 0.4:
                reasons.append("little history yet")
        # an act the profile does not know, vouched for by more than one place: nothing else lifts a newcomer
        if not entry and (it.editorial or len(it.sources) > 1):
            s += float(w.get("novelty", 0.0))
            if w.get("novelty"):
                reasons.append("new act")
        it.score = round(s, 3)
        it.reasons = reasons
    items.sort(key=lambda i: (-i.score, i.artist_norm))
    log.info("scored %d items; top: %s", len(items), [(i.artist, i.title, i.score) for i in items[:3]])
    return items


def diversify(items: list[Item], cfg: dict) -> list[Item]:
    """One artist (or label) must not own the day. Past `max_per_artist` / `max_per_label` tracks, each further one
    by the same act loses `repeat_penalty` per extra so it drops down the list rather than off it; and the top
    `shown_rank` is guaranteed `explore_slots` tracks by artists the profile does not know, so newcomers are seen.
    The penalties live in the score itself, which is what the site sorts by, so the order survives the trip."""
    r = cfg.get("ranking") or {}
    per_artist = int(r.get("max_per_artist", 0) or 0)
    per_label = int(r.get("max_per_label", 0) or 0)
    penalty = float(r.get("repeat_penalty", 2.0))
    slots = int(r.get("explore_slots", 0) or 0)
    shown = int((cfg.get("learn") or {}).get("shown_rank", 80) or 80)
    if not items or not (per_artist or per_label or slots):
        return items
    items.sort(key=lambda i: (-i.score, i.artist_norm))
    a_count: dict[str, int] = {}
    l_count: dict[str, int] = {}
    for it in items:
        extra = 0
        a = it.artist_norm
        if per_artist:
            a_count[a] = a_count.get(a, 0) + 1
            extra = max(extra, a_count[a] - per_artist)
        if per_label:
            for label in {norm(t[6:]) for t in it.tags if t.lower().startswith("label:")}:
                l_count[label] = l_count.get(label, 0) + 1
                extra = max(extra, l_count[label] - per_label)
        if extra > 0:
            it.score = round(it.score - penalty * extra, 3)
            it.reasons.append(f"no. {a_count.get(a, 0)} by them today" if per_artist and a_count.get(a, 0) > per_artist else "label well represented today")
    items.sort(key=lambda i: (-i.score, i.artist_norm))
    if slots and len(items) > shown:
        top = items[:shown]
        have = sum(1 for i in top if not i.match_kind)
        need = slots - have
        if need > 0:
            floor = top[-1].score
            for it in [i for i in items[shown:] if not i.match_kind][:need]:
                it.score = round(floor + 0.001, 3)
                it.reasons.append("explore slot")
            items.sort(key=lambda i: (-i.score, i.artist_norm))
    return items
