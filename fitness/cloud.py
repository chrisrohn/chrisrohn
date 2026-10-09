"""The sync that runs in GitHub Actions, so nothing has to run on a computer of yours.

`.github/workflows/fitness-sync.yml` (called on a schedule from a private repository of yours) runs
`python -m fitness cloud` and keeps everything between runs on that repository's `state` branch:

- `state.enc`: the SQLite store and the Garmin / Strava sign-ins, encrypted by the workflow with STATE_KEY;
- `fitness-data.json`: the dashboard's numbers, which the phone app downloads with its own token;
- `status.json`: whether each service is connected, when the last sync ran, and what went wrong if anything did.

Garmin signs in with GARMIN_EMAIL / GARMIN_PASSWORD whenever its saved session is missing or stale. With two-step
verification on, Garmin emails a code: the app hands it back by starting a run named "garmin-code 123456", which
this run watches for (its token can read the repository's runs, and a run's name is all it needs).
Strava connects once through its own authorize page, which redirects to the app with a code; the app starts a
"connect-strava" run carrying it, and this trades it for tokens.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from collections.abc import Callable
from datetime import UTC, date, datetime
from pathlib import Path
from urllib.request import Request, urlopen

from fitness import build, config
from fitness.store import Store

CODE_WAIT_S = 600          # how long a sign-in waits for the code Garmin emailed
DATA_FILE, STATUS_FILE = "fitness-data.json", "status.json"


def _gh(path: str) -> dict:
    """GitHub's REST API for this repository, with the workflow's own token."""
    api = os.environ.get("GITHUB_API_URL", "https://api.github.com")
    req = Request(f"{api}/repos/{os.environ['GITHUB_REPOSITORY']}{path}", headers={
        "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}", "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"})
    with urlopen(req, timeout=30) as r:
        return json.load(r)


def workflow_file() -> str:
    """The calling workflow's file name (GITHUB_WORKFLOW_REF is owner/repo/.github/workflows/<file>@ref)."""
    m = re.search(r"/workflows/([^@/]+)@", os.environ.get("GITHUB_WORKFLOW_REF", ""))
    return m[1] if m else "training.yml"


def wait_for_code(workflow: str, since: datetime, timeout: float = CODE_WAIT_S, poll: float = 5,
                  fetch: Callable[[str], dict] = _gh, sleep: Callable[[float], None] = time.sleep) -> str:
    """The code the phone sent back as a run named "garmin-code 123456", started after `since`."""
    print("::notice::Garmin emailed you a sign-in code: enter it in the app (or run this workflow with action garmin-code).")
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        for run in fetch(f"/actions/workflows/{workflow}/runs?event=workflow_dispatch&per_page=20").get("workflow_runs", []):
            m = re.fullmatch(r"garmin-code\s+(\d{4,10})", (run.get("display_title") or "").strip())
            if m and datetime.fromisoformat(run["created_at"].replace("Z", "+00:00")) >= since:
                return m[1]
        sleep(poll)
    raise TimeoutError("no sign-in code arrived within 10 minutes")


def import_inbox(inbox: Path | None, store: Store, tz: str) -> dict | None:
    """Strava's account export, uploaded to the private repository's strava/ folder: the activities.csv from it (or the
    whole zip, if it's small enough to upload). Each distinct file is imported once; what was imported is remembered
    in the store, so the status can say so after the file is gone."""
    from fitness import strava

    done = json.loads(store.get("strava_export") or "null") or {"shas": []}
    files = sorted([*inbox.glob("strava/*.csv"), *inbox.glob("strava/*.zip")]) if inbox and inbox.is_dir() else []
    for f in files:
        sha = hashlib.sha256(f.read_bytes()).hexdigest()
        if sha in done["shas"]:
            continue
        if f.suffix == ".csv":
            rows = strava.parse_export(f.read_text(encoding="utf-8-sig"), tz)
            for act, raw in rows:
                store.put_activity(act, raw)
            n = len(rows)
        else:
            n = strava.import_export(f, store, tz)
        done = {"shas": [*done["shas"], sha], "file": f.name, "rows": n,
                "at": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")}
        store.set("strava_export", json.dumps(done))
        store.commit()
        print(f"Strava export: {n} activities from {f.name}")
    return done if done.get("file") else None


def _why(e: BaseException) -> str:
    text = str(e).strip() or type(e).__name__
    return text.splitlines()[0][:300]


def run(cfg: dict, action: str = "sync", code: str = "", out: Path = Path("."), today: date | None = None,
        prompt_code: Callable[[], str] | None = None, inbox: Path | None = None) -> dict:
    """Connect (if asked), import an uploaded Strava export, sync both services, and write fitness-data.json +
    status.json into `out`."""
    from fitness import garmin, strava

    os.environ["TZ"] = cfg["athlete"]["timezone"]   # "today" is your day, not the runner's UTC one
    time.tzset()
    started = datetime.now(UTC).replace(microsecond=0)
    tokens = config.DATA_DIR / "garmin"
    cfg = {**cfg, "sync": {**cfg["sync"], "garmin_tokens": str(tokens)}}
    out.mkdir(parents=True, exist_ok=True)
    errors: dict[str, str] = {}

    if action == "connect-strava":
        try:
            if not code:
                raise SystemExit("no authorization code came with the request")
            strava.exchange(os.environ.get("STRAVA_CLIENT_ID", ""), os.environ.get("STRAVA_CLIENT_SECRET", ""), code)
        except (SystemExit, Exception) as e:   # every failure ends up in status.json, for the app to show
            errors["strava"] = _why(e)

    # whether the sign-in secrets are set, without the password's value going anywhere near what's printed or saved
    has_login = all(os.environ.get(name) for name in ("GARMIN_EMAIL", "GARMIN_PASSWORD"))
    export = None
    with Store(config.DB_PATH) as store:
        try:
            export = import_inbox(inbox, store, cfg["athlete"]["timezone"])
        except Exception as e:
            errors["strava"] = f"the uploaded export couldn't be read: {_why(e)}"
        if has_login or (tokens / "garmin_tokens.json").exists():
            try:
                garmin.sync(cfg, store, prompt_mfa=prompt_code or (lambda: wait_for_code(workflow_file(), started)))
            except (SystemExit, Exception) as e:
                errors["garmin"] = _why(e)
        elif action == "connect-garmin":
            errors["garmin"] = "add GARMIN_EMAIL and GARMIN_PASSWORD to the repository's Actions secrets"
        if config.STRAVA_TOKEN.exists() and "strava" not in errors:
            try:
                strava.sync(store)
            except (SystemExit, Exception) as e:
                errors["strava"] = _why(e)
        days, acts = store.days(), store.activities()

    if days or acts:
        try:
            data = build.assemble(cfg, days, acts, today or date.today())
            (out / DATA_FILE).write_text(json.dumps(build.phone_data(data), separators=(",", ":")))
        except Exception as e:
            errors["build"] = _why(e)

    status = {
        "synced": started.isoformat().replace("+00:00", "Z"),
        "action": action,
        "ok": not errors,
        "garmin": {"connected": (tokens / "garmin_tokens.json").exists(), "days": len(days),
                   "last": max(days) if days else None, "error": errors.get("garmin")},
        "strava": {"connected": config.STRAVA_TOKEN.exists(), "client_id": os.environ.get("STRAVA_CLIENT_ID") or None,
                   "activities": sum(1 for a in acts if str(a.get("id", "")).startswith("strava:")),
                   "export": {k: export[k] for k in ("file", "rows", "at")} if export else None, "error": errors.get("strava")},
        "error": errors.get("build"),
    }
    (out / STATUS_FILE).write_text(json.dumps(status, indent=2))
    for where, why in errors.items():
        print(f"::error title={where}::{why}")
    return status
