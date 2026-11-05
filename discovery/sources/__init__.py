"""Source plugins. Each exposes `fetch(cfg, profile, http) -> list[Item]`."""
from __future__ import annotations

from collections.abc import Callable
from importlib import import_module

from ..models import Item
from ..util import Deadline, log

HEALTH: dict[str, dict] = {}   # "<source or feed name>" -> {"ok": bool, "entries": n, "kept": n, "error": str|None}


def report(name: str, ok: bool, entries: int = 0, kept: int = 0, error: str | None = None) -> None:
    HEALTH[name] = {"ok": ok, "entries": entries, "kept": kept, "error": (error or None) and str(error)[:120]}


# The order is the order they run in, against one time budget (`sources.time_budget_minutes`). The quick sources go
# first, the new-act source among them, so a slow day never leaves them out; the three artist watches go last
# because they are the slow ones and keep a cursor, so what they do not reach today is simply tomorrow's first.
# (Until 2026-11-05 the watches ran in the middle and spent the budget: lastfm_similar, nts, reddit, difm and
# mixcloud were left out, and the day had 9 cards by new acts instead of ~120.)
SOURCE_MODULES = {
    "listenbrainz_fresh": "listenbrainz",
    "lastfm_similar": "lastfm_similar",
    "musicbrainz_tags": "musicbrainz",
    "bandcamp": "bandcamp",
    "youtube_channels": "youtube_channels",
    "listenbrainz_playlists": "lb_playlists",
    "radio": "radio",
    "rss": "rss",
    "spotify": "spotify",
    "apple_music": "apple_music",
    "nts": "nts",
    "reddit": "reddit",
    "difm": "difm",
    "mixcloud": "mixcloud",
    "deezer": "deezer",
    "ytmusic_artists": "ytmusic_artists",
    "musicbrainz_artists": "musicbrainz_artists",
}
PER_FEED_HEALTH = {"rss", "youtube_channels", "radio", "nts", "reddit", "apple_music", "difm", "mixcloud"}   # these report per feed / show / sub


def run_sources(cfg: dict, profile: dict, http, deadline: Deadline | None = None) -> list[Item]:
    """Every enabled source in turn, within `deadline`. A source that would start after the budget is spent is left
    for the next run and says so in ⚙ feed health; the three artist-watch sources check the same budget inside
    their own loops (through `http.deadline`) and keep their cursor where they stopped, so nobody is skipped."""
    items: list[Item] = []
    http.deadline = deadline
    for key, modname in SOURCE_MODULES.items():
        scfg = (cfg.get("sources") or {}).get(key) or {}
        if not scfg.get("enabled"):
            continue
        if deadline is not None and deadline.expired:
            log.warning("source %s: the source time budget is spent; left for the next run", key)
            report(key, False, error="time budget spent; next run")
            continue
        try:
            mod = import_module(f".{modname}", __name__)
            fetch: Callable = mod.fetch
            got = fetch(cfg, profile, http)
            log.info("source %s: %d items", key, len(got))
            items.extend(got)
            if key not in PER_FEED_HEALTH:
                report(key, True, kept=len(got))
        except Exception as exc:  # noqa: BLE001
            log.exception("source %s failed: %s", key, exc)
            report(key, False, error=str(exc))
        finally:
            http.save()
    return items
