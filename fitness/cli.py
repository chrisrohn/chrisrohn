"""python -m fitness <command>. See fitness/README.md."""
from __future__ import annotations

import argparse
import functools
import http.server
import tempfile
import webbrowser
from datetime import date
from pathlib import Path

from fitness import build, config
from fitness.store import Store


def _build(cfg: dict, db: Path, out: Path | None = None, today: date | None = None) -> tuple[Path, dict]:
    with Store(db) as store:
        data = build.assemble(cfg, store.days(), store.activities(), today or date.today())
    return build.render(data, out), data


def _print_today(data: dict) -> None:
    now, plan = data["now"], data["plan"]
    rec, ready, form = now["recommendation"], now["readiness"], now["form"]
    print(f"\n  {rec['title']}\n  {rec['detail']}\n")
    if ready:
        print(f"  Readiness {ready['score']}/100" + ("  ⚠ illness watch" if ready["illness"] else ""))
        for r in ready["reasons"]:
            print(f"    {'+' if r['tone'] == 'good' else '−'} {r['text']}")
    if now["sleep"]:
        print(f"  Sleep {now['sleep']['score']} ({now['sleep']['label']}), {now['sleep']['hours']:.1f} h")
    if form.get("ctl") is not None:
        print(f"  Fitness {form['ctl']:.0f} · fatigue {form['atl']:.0f} · form {form['tsb']:+.0f}")
    for race in (plan or {}).get("races", []):
        print(f"  {race['name']} ({race['label']}): {race['days_out']} days · race morning fitness {race['race_ctl']:.0f} (target {race['target_ctl']}), form {race['race_tsb']:+.0f}")
    print()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m fitness", description="Personal fitness insights from Garmin + Strava.")
    p.add_argument("--db", type=Path, default=config.DB_PATH, help="SQLite store (default fitness/data/fitness.db)")
    sub = p.add_subparsers(dest="cmd", required=True)
    lg = sub.add_parser("login", help="one-time sign-in")
    lg.add_argument("service", choices=["garmin", "strava"])
    sy = sub.add_parser("sync", help="pull new data from Garmin and/or Strava")
    sy.add_argument("--only", choices=["garmin", "strava"])
    sy.add_argument("--days", type=int, help="Garmin history to backfill (default sync.history_days)")
    im = sub.add_parser("import-strava", help="load Strava's bulk export (zip or unzipped folder)")
    im.add_argument("path", type=Path)
    bd = sub.add_parser("build", help="write fitness/dist/index.html")
    bd.add_argument("--open", action="store_true")
    sub.add_parser("today", help="print today's call in the terminal")
    rn = sub.add_parser("run", help="sync + build + today (for cron / launchd)")
    rn.add_argument("--open", action="store_true")
    sv = sub.add_parser("serve", help="serve fitness/dist on the local network (phone on the same Wi-Fi)")
    sv.add_argument("--port", type=int, default=8765)
    dm = sub.add_parser("demo", help="build a demo page from a synthetic athlete")
    dm.add_argument("--open", action="store_true")
    args = p.parse_args(argv)
    cfg = config.load()

    if args.cmd == "login":
        if args.service == "garmin":
            from fitness import garmin
            garmin.login(cfg)
        else:
            from fitness import strava
            strava.login()
    elif args.cmd in ("sync", "run"):
        with Store(args.db) as store:
            if getattr(args, "only", None) in (None, "garmin"):
                from fitness import garmin
                garmin.sync(cfg, store, getattr(args, "days", None))
            if getattr(args, "only", None) in (None, "strava") and config.STRAVA_TOKEN.exists():
                from fitness import strava
                strava.sync(store)
        if args.cmd == "run":
            out, data = _build(cfg, args.db)
            _print_today(data)
            print(f"Site: {out}")
            if args.open:
                webbrowser.open(out.as_uri())
    elif args.cmd == "import-strava":
        from fitness import strava
        with Store(args.db) as store:
            n = strava.import_export(args.path, store, cfg["athlete"]["timezone"])
        print(f"Imported {n} Strava activities. Next: python -m fitness build")
    elif args.cmd in ("build", "today"):
        out, data = _build(cfg, args.db)
        _print_today(data)
        if args.cmd == "build":
            print(f"Site: {out}")
            if args.open:
                webbrowser.open(out.as_uri())
    elif args.cmd == "serve":
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(config.DIST_DIR))
        print(f"Serving {config.DIST_DIR} on http://0.0.0.0:{args.port}/ — private data: keep this on your own network. Ctrl-C stops.")
        http.server.ThreadingHTTPServer(("0.0.0.0", args.port), handler).serve_forever()
    elif args.cmd == "demo":
        from fitness import demo
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "demo.db"
            with Store(db) as store:
                demo.populate(store, date.today())
            out, data = _build(cfg, db, config.DIST_DIR / "demo.html")
        _print_today(data)
        print(f"Demo: {out}")
        if args.open:
            webbrowser.open(out.as_uri())
    return 0
