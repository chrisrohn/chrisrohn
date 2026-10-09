"""Strava: the official API (OAuth, your own app, read-only) for ongoing sync, and the bulk-export zip for full history.

Create an app at https://www.strava.com/settings/api with Authorization Callback Domain `chrisrohn.com`
(Strava always allows localhost too), then
`STRAVA_CLIENT_ID=... STRAVA_CLIENT_SECRET=... python -m fitness login strava`.
"""
from __future__ import annotations

import csv
import io
import json
import os
import time
import webbrowser
import zipfile
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse
from zoneinfo import ZoneInfo

from fitness.activities import activity
from fitness.config import STRAVA_TOKEN
from fitness.store import Store

API = "https://www.strava.com/api/v3"
PORT = 8721


def _requests():
    import requests

    return requests


def login() -> None:
    client_id = os.environ.get("STRAVA_CLIENT_ID") or input("Strava client ID: ").strip()
    secret = os.environ.get("STRAVA_CLIENT_SECRET") or input("Strava client secret: ").strip()
    redirect = f"http://localhost:{PORT}/callback"
    url = "https://www.strava.com/oauth/authorize?" + urlencode(
        {"client_id": client_id, "response_type": "code", "redirect_uri": redirect, "approval_prompt": "auto", "scope": "read,activity:read_all"})
    got: dict = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            got.update({k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()})
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"Strava connected. You can close this tab.")

        def log_message(self, *args):
            pass

    print(f"Opening Strava to authorize. If no browser opens, visit:\n  {url}")
    webbrowser.open(url)
    with HTTPServer(("localhost", PORT), Handler) as server:
        while "code" not in got and "error" not in got:
            server.handle_request()
    if "error" in got or "activity:read_all" not in got.get("scope", ""):
        raise SystemExit(f"Strava authorization failed or the activity:read_all box was unticked: {got}")
    token = exchange(client_id, secret, got["code"])
    print(f"Strava connected as {token.get('athlete', {}).get('firstname', 'you')}; token saved to {STRAVA_TOKEN}.")


def exchange(client_id: str, secret: str, code: str) -> dict:
    """Trade an authorization code (from the browser's redirect) for tokens, and keep them."""
    token = _requests().post("https://www.strava.com/oauth/token", timeout=30, data={
        "client_id": client_id, "client_secret": secret, "code": code, "grant_type": "authorization_code"}).json()
    if "access_token" not in token:
        raise SystemExit(f"Strava token exchange failed: {_problem(token)}")
    _save({**token, "client_id": client_id})   # the client secret stays in the environment, never in the file
    return token


def _problem(reply: dict) -> str:
    """What Strava said went wrong, without echoing anything else from its reply (it can carry tokens)."""
    fields = ", ".join(f"{e.get('field')} {e.get('code')}" for e in reply.get("errors") or [] if isinstance(e, dict))
    return f"{reply.get('message') or 'no token in the reply'}{f' ({fields})' if fields else ''}"


def _save(token: dict) -> None:
    STRAVA_TOKEN.parent.mkdir(parents=True, exist_ok=True)
    STRAVA_TOKEN.write_text(json.dumps(token, indent=2))
    STRAVA_TOKEN.chmod(0o600)


def _access_token() -> str:
    if not STRAVA_TOKEN.exists():
        raise SystemExit("No Strava token yet: run `python -m fitness login strava` once (or import the bulk export).")
    token = json.loads(STRAVA_TOKEN.read_text())
    if token["expires_at"] - 300 < time.time():
        legacy = token.pop("client_secret", None)   # older sign-ins kept it in the file; it's dropped on this save
        secret = os.environ.get("STRAVA_CLIENT_SECRET") or legacy
        if not secret:
            raise SystemExit("Set STRAVA_CLIENT_SECRET in the environment to refresh the Strava sign-in.")
        fresh = _requests().post("https://www.strava.com/oauth/token", timeout=30, data={
            "client_id": token["client_id"], "client_secret": secret, "grant_type": "refresh_token",
            "refresh_token": token["refresh_token"]}).json()
        if "access_token" not in fresh:
            raise SystemExit(f"Strava token refresh failed ({_problem(fresh)}): connect Strava again.")
        token.update(fresh)
        _save(token)
    return token["access_token"]


def parse_api(a: dict) -> dict:
    return activity(
        id=f"strava:{a['id']}", source="strava", start=datetime.fromisoformat(a["start_date_local"].rstrip("Z")),
        kind=a.get("sport_type") or a.get("type") or "Workout", name=a.get("name") or "", duration_s=a.get("elapsed_time") or 0,
        moving_s=a.get("moving_time"), distance_m=a.get("distance"), elev_m=a.get("total_elevation_gain"), avg_hr=a.get("average_heartrate"),
        max_hr=a.get("max_heartrate"), avg_power=a.get("average_watts") if a.get("device_watts") else None,
        np=a.get("weighted_average_watts") if a.get("device_watts") else None, kj=a.get("kilojoules"), suffer_score=a.get("suffer_score"), trainer=a.get("trainer"), commute=a.get("commute") or None,
    )


def sync(store: Store) -> None:
    requests = _requests()
    headers = {"Authorization": f"Bearer {_access_token()}"}
    since = store.latest_start("strava")
    after = int(datetime.fromisoformat(since).replace(tzinfo=UTC).timestamp()) - 3 * 86400 if since else 0
    page, total = 1, 0
    while True:
        r = requests.get(f"{API}/athlete/activities", headers=headers, timeout=30, params={"after": after, "per_page": 200, "page": page})
        if r.status_code == 429:
            wait = 900 - int(time.time()) % 900 + 5   # Strava's limits reset on the quarter hour
            print(f"Strava rate limit hit; waiting {wait}s")
            time.sleep(wait)
            continue
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        for a in batch:
            store.put_activity(parse_api(a), a)
        total += len(batch)
        store.commit()
        page += 1
    print(f"Strava: {total} activit{'y' if total == 1 else 'ies'} synced")


def _num(v: str | None) -> float | None:
    try:
        return float(v.replace(",", "")) if v not in (None, "") else None
    except ValueError:
        return None


def parse_export(text: str, tz: str) -> list[tuple[dict, dict]]:
    """activities.csv from Strava's "Download your data" zip. The file repeats some headers ("Elapsed Time",
    "Distance"); the later column is the raw SI value, the earlier one is in display units, so the last one wins.
    Activity Date is UTC ("Nov 4, 2023, 3:12:45 PM")."""
    rows = list(csv.reader(io.StringIO(text)))
    header, out = rows[0], []
    col = {name: i for i, name in enumerate(header)}   # later duplicates overwrite earlier ones
    zone = ZoneInfo(tz)
    for row in rows[1:]:
        if len(row) < len(header):
            continue
        rec = {name: row[i] for name, i in col.items()}
        when = datetime.strptime(rec["Activity Date"], "%b %d, %Y, %I:%M:%S %p").replace(tzinfo=UTC).astimezone(zone)
        watts = _num(rec.get("Average Watts"))
        has_meter = (rec.get("Device Watts") or "").lower() in ("true", "1")
        out.append((activity(
            id=f"strava:{rec['Activity ID']}", source="strava", start=when, kind=rec.get("Activity Type") or "Workout",
            name=rec.get("Activity Name") or "", duration_s=_num(rec.get("Elapsed Time")) or 0, moving_s=_num(rec.get("Moving Time")),
            distance_m=_num(rec.get("Distance")), elev_m=_num(rec.get("Elevation Gain")), avg_hr=_num(rec.get("Average Heart Rate")),
            max_hr=_num(rec.get("Max Heart Rate")), avg_power=watts if has_meter else None,
            np=_num(rec.get("Weighted Average Power")) if has_meter else None, calories=_num(rec.get("Calories")),
            suffer_score=_num(rec.get("Relative Effort")), commute=(rec.get("Commute") or "").lower() in ("true", "1") or None,
        ), rec))
    return out


def import_export(path: Path, store: Store, tz: str) -> int:
    if path.is_dir():
        text = (path / "activities.csv").read_text(encoding="utf-8-sig")
    else:
        with zipfile.ZipFile(path) as z:
            text = z.read("activities.csv").decode("utf-8-sig")
    rows = parse_export(text, tz)
    for act, raw in rows:
        store.put_activity(act, raw)
    store.commit()
    return len(rows)
