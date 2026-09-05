"""python -m discovery <command>

  profile           rebuild the taste profile (Last.fm + your playlists + similar artists)
  build             fetch sources, score, resolve, write site/data/feed.json (+ feed.xml, history)
  daily             profile (if stale or from an older pipeline version) + build + catalog
  catalog           the infill catalog for earlier years: Last.fm history → site/data/catalog.json
  seed-everynoise   scrape frozen Everynoise genre pages into data/seeds_everynoise.json
"""
from __future__ import annotations

import argparse
import time
from datetime import UTC, datetime, timedelta

from .util import DATA_DIR, PROFILE_VERSION, Http, ensure_dirs, load_config, log, read_json, setup_logging


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m discovery", description="Chris Rohn's New Music: the daily discovery pipeline.",
                                formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    sub = p.add_subparsers(dest="command")
    sub.add_parser("profile", help="rebuild the taste profile")
    sub.add_parser("build", help="fetch sources, score, resolve and write the feed")
    daily = sub.add_parser("daily", help="profile (when stale) + build; the default")
    daily.add_argument("--rebuild-profile", action="store_true", help="rebuild the profile even if it is fresh")
    sub.add_parser("catalog", help="build the infill catalog (site/data/catalog.json) from Last.fm history")
    sub.add_parser("seed-everynoise", help="scrape frozen Everynoise genre pages into data/seeds_everynoise.json")
    return p


def _profile_stale(cfg: dict) -> bool:
    prof = read_json(DATA_DIR / "profile.json", None)
    if not (prof and prof.get("built_at") and prof.get("version") == PROFILE_VERSION):   # older shapes get rebuilt
        return True
    built = datetime.fromisoformat(prof["built_at"])
    return datetime.now(UTC) - built > timedelta(days=int(cfg["profile"].get("rebuild_days", 3)))


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    setup_logging()
    ensure_dirs()
    cfg = load_config()
    cmd = args.command or "daily"

    if cmd == "profile":
        from .profile import build_profile

        build_profile(cfg, Http("profile", ttl_hours=72))
        return 0
    if cmd == "build":
        from .build import build_feed

        build_feed(cfg)
        return 0
    if cmd == "catalog":
        from .catalog import build_catalog

        build_catalog(cfg)
        return 0
    if cmd == "daily":
        from .build import build_feed
        from .catalog import build_catalog
        from .profile import build_profile

        t0 = time.monotonic()
        if getattr(args, "rebuild_profile", False) or _profile_stale(cfg):
            build_profile(cfg, Http("profile", ttl_hours=72))
        else:
            log.info("profile is fresh (built %s)", read_json(DATA_DIR / "profile.json", {}).get("built_at"))
        build_feed(cfg)
        # the catalog takes what is left of the job: the feed comes first, the job dies at its timeout
        left = float((cfg.get("catalog") or {}).get("job_budget_minutes", 40)) - (time.monotonic() - t0) / 60
        build_catalog(cfg, deadline_minutes=max(0.0, left))
        return 0
    if cmd == "seed-everynoise":
        from .profile import scrape_everynoise

        scrape_everynoise(cfg, Http("everynoise", ttl_hours=24 * 30))
        return 0
    _parser().print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
