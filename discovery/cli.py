"""python -m discovery <command>

  profile           rebuild the taste profile (Last.fm + your playlists + similar artists)
  build             fetch sources, score, resolve, write site/data/feed.json (+ feed.xml, history)
  daily             profile (if stale) + build
  seed-everynoise   scrape frozen Everynoise genre pages into data/seeds_everynoise.json
"""
from __future__ import annotations

import sys
from datetime import UTC, datetime, timedelta

from .util import DATA_DIR, PROFILE_VERSION, Http, ensure_dirs, load_config, log, read_json, setup_logging


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    setup_logging()
    ensure_dirs()
    cfg = load_config()
    cmd = argv[0] if argv else "daily"

    if cmd == "profile":
        from .profile import build_profile

        build_profile(cfg, Http("profile", ttl_hours=72))
        return 0
    if cmd == "build":
        from .build import build_feed

        build_feed(cfg)
        return 0
    if cmd == "daily":
        from .build import build_feed
        from .profile import build_profile

        prof = read_json(DATA_DIR / "profile.json", None)
        stale = True
        if prof and prof.get("built_at") and prof.get("version") == PROFILE_VERSION:   # older shapes get rebuilt
            built = datetime.fromisoformat(prof["built_at"])
            stale = datetime.now(UTC) - built > timedelta(days=int(cfg["profile"].get("rebuild_days", 3)))
        if stale or "--rebuild-profile" in argv:
            build_profile(cfg, Http("profile", ttl_hours=72))
        else:
            log.info("profile is fresh (built %s)", prof["built_at"])
        build_feed(cfg)
        return 0
    if cmd == "seed-everynoise":
        from .profile import scrape_everynoise

        scrape_everynoise(cfg, Http("everynoise", ttl_hours=24 * 30))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
