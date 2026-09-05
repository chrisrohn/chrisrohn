"""Source plugins. Each exposes `fetch(cfg, profile, http) -> list[Item]`."""
from __future__ import annotations

from collections.abc import Callable
from importlib import import_module

from ..models import Item
from ..util import log

HEALTH: dict[str, dict] = {}   # "<source or feed name>" -> {"ok": bool, "entries": n, "kept": n, "error": str|None}


def report(name: str, ok: bool, entries: int = 0, kept: int = 0, error: str | None = None) -> None:
    HEALTH[name] = {"ok": ok, "entries": entries, "kept": kept, "error": (error or None) and str(error)[:120]}


SOURCE_MODULES = {
    "listenbrainz_fresh": "listenbrainz",
    "musicbrainz_tags": "musicbrainz",
    "musicbrainz_labels": "labels",
    "bandcamp": "bandcamp",
    "deezer": "deezer",
    "ytmusic_artists": "ytmusic_artists",
    "youtube_channels": "youtube_channels",
    "listenbrainz_playlists": "lb_playlists",
    "radio": "radio",
    "rss": "rss",
    "spotify": "spotify",
}


def run_sources(cfg: dict, profile: dict, http) -> list[Item]:
    items: list[Item] = []
    for key, modname in SOURCE_MODULES.items():
        scfg = (cfg.get("sources") or {}).get(key) or {}
        if not scfg.get("enabled"):
            continue
        try:
            mod = import_module(f".{modname}", __name__)
            fetch: Callable = mod.fetch
            got = fetch(cfg, profile, http)
            log.info("source %s: %d items", key, len(got))
            items.extend(got)
            if key not in ("rss", "youtube_channels", "radio"):   # those report per feed
                report(key, True, kept=len(got))
        except Exception as exc:  # noqa: BLE001
            log.exception("source %s failed: %s", key, exc)
            report(key, False, error=str(exc))
        finally:
            http.save()
    return items
