"""Source plugins. Each exposes `fetch(cfg, profile, http) -> list[Item]`."""
from __future__ import annotations

from collections.abc import Callable
from importlib import import_module

from ..models import Item
from ..util import Deadline, log

HEALTH: dict[str, dict] = {}   # "<source or feed name>" -> {"ok": bool, "entries": n, "kept": n, "error": str|None}


def report(name: str, ok: bool, entries: int = 0, kept: int = 0, error: str | None = None) -> None:
    HEALTH[name] = {"ok": ok, "entries": entries, "kept": kept, "error": (error or None) and str(error)[:120]}


SOURCE_MODULES = {
    "listenbrainz_fresh": "listenbrainz",
    "musicbrainz_tags": "musicbrainz",
    "bandcamp": "bandcamp",
    "deezer": "deezer",
    "ytmusic_artists": "ytmusic_artists",
    "youtube_channels": "youtube_channels",
    "listenbrainz_playlists": "lb_playlists",
    "radio": "radio",
    "rss": "rss",
    "spotify": "spotify",
    "apple_music": "apple_music",
    "musicbrainz_artists": "musicbrainz_artists",
    "nts": "nts",
    "reddit": "reddit",
}
PER_FEED_HEALTH = {"rss", "youtube_channels", "radio", "nts", "reddit", "apple_music"}   # these report per feed / show / sub


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
