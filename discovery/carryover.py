"""Cards you did not get to: kept for later days instead of lost.

A day's list is longer than a day's listening, and the sources rotate through their artists, so an unrated card had a
one-in-three chance of ever coming back (1,157 of 3,188 within a week, 2026-09 → 2026-11) and 2,352 cards shown in
sixty days were never rated at all. Every card the feed shows is remembered here (data/carryover.json) with what the
site needs to show it again; the next builds offer the ones still unrated, unfiled and younger than `max_days` back
to the day, re-scored against today's profile so they compete with the new sightings for the places rather than
taking them. A rating (any: keep, skip, wrong video), a playlist that now holds the song, or age retires a card."""
from __future__ import annotations

import dataclasses
from datetime import date, timedelta
from typing import Any

from . import util
from .models import Item
from .util import log, read_json, write_json

CARRY_FILE = "carryover.json"
VERSION = 1
_FIELDS = {f.name for f in dataclasses.fields(Item)}
# what a carried card needs again; the scoring fields (score, reasons, match) are worked out afresh every build
_KEEP = ("artist", "title", "kind", "featuring", "remixer", "remix_kind", "release", "release_type", "release_date", "stated_year", "date_kind",
         "tags", "sources", "links", "artwork", "artist_mbids", "listen_count", "editorial", "backfill", "year", "year_source", "year_confidence",
         "year_evidence", "original_year", "youtube", "similar_to", "fit")


def _path():
    return util.DATA_DIR / CARRY_FILE


def _compact(it: Item) -> dict[str, Any]:
    d = dataclasses.asdict(it)
    d["release_date"] = it.release_date.isoformat() if it.release_date else None
    return {k: d[k] for k in _KEEP if d.get(k) not in (None, "", [], {}, False)}


def item_from(d: dict[str, Any]) -> Item:
    """An Item from its stored form (unknown keys ignored, so an older or newer store still reads)."""
    kw = {k: v for k, v in d.items() if k in _FIELDS}
    if kw.get("release_date"):
        try:
            kw["release_date"] = date.fromisoformat(str(kw["release_date"])[:10])
        except ValueError:
            kw["release_date"] = None
    return Item(**kw)


def load() -> dict[str, dict]:
    data = read_json(_path(), {}) or {}
    return data.get("items") or {} if isinstance(data, dict) and data.get("v") == VERSION else {}


def waiting(cfg: dict, rated: dict, saved: dict, saved_videos: set[str], today: date | None = None) -> list[Item]:
    """The carried cards that may join today: still unrated, not in any playlist, shown first no more than `max_days`
    ago. Each comes back flagged `carried` (the day it was first shown) with a reason that says so."""
    ccfg = cfg.get("carryover") or {}
    if not ccfg.get("enabled", True):
        return []
    today = today or date.today()
    since = (today - timedelta(days=int(ccfg.get("max_days", 21) or 21))).isoformat()
    out: list[Item] = []
    for key, row in load().items():
        first = str(row.get("first") or "")
        if not first or first < since or key in rated or key in saved:
            continue
        vid = ((row.get("item") or {}).get("youtube") or {}).get("videoId")
        if vid and vid in saved_videos:
            continue
        try:
            it = item_from(row.get("item") or {})
        except TypeError:
            continue
        if it.key != key:
            continue
        it.carried = first
        out.append(it)
    if out:
        log.info("carry-over: %d unrated cards from earlier days can come back", len(out))
    return out


def remember(cfg: dict, items: list[Item], rated: dict, today: date | None = None) -> int:
    """Record today's cards (first shown, last shown, how many days), drop what was rated or aged out, and keep the
    store to `max_items`, the most recently shown first. Returns how many cards it holds."""
    ccfg = cfg.get("carryover") or {}
    today = today or date.today()
    today_s = today.isoformat()
    since = (today - timedelta(days=int(ccfg.get("max_days", 21) or 21))).isoformat()
    store = {k: v for k, v in load().items() if k not in rated and str(v.get("first") or "") >= since}
    for it in items:
        row = store.get(it.key) or {"first": it.carried or today_s, "days": 0}
        if row.get("last") != today_s:
            row["days"] = int(row.get("days") or 0) + 1
        row["last"] = today_s
        row["item"] = _compact(it)
        store[it.key] = row
    cap = int(ccfg.get("max_items", 1500) or 1500)
    if len(store) > cap:
        keep = sorted(store.items(), key=lambda kv: (str(kv[1].get("last") or ""), str(kv[1].get("first") or "")), reverse=True)[:cap]
        store = dict(keep)
    write_json(_path(), {"v": VERSION, "updated": today_s, "items": store}, compact=True)
    return len(store)
