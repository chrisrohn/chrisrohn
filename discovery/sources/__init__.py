"""Source plugins. Each exposes `fetch(cfg, profile, http) -> list[Item]`."""
from __future__ import annotations

from importlib import import_module
from typing import Callable

from ..models import Item
from ..util import log

SOURCE_MODULES = {
    "listenbrainz_fresh": "listenbrainz",
    "musicbrainz_tags": "musicbrainz",
    "bandcamp": "bandcamp",
    "deezer": "deezer",
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
            fetch: Callable = getattr(mod, "fetch")
            got = fetch(cfg, profile, http)
            log.info("source %s: %d items", key, len(got))
            items.extend(got)
        except Exception as exc:  # noqa: BLE001
            log.exception("source %s failed: %s", key, exc)
        finally:
            http.save()
    return items
