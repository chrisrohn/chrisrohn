"""Rides recorded in ride mode, sent to the sync by the phone.

The phone starts a "service" run whose code is `ride:` + the ride deflated and base64url'd (RideCore.rideDigest:
the summary, and heart rate, power, cadence and speed every few seconds as delta-coded columns). Here it becomes:

- an activity (`phone:<id>`), so the ride counts in the training load and the plan from this run on. When the watch
  recorded the same ride, activities.merge folds the two into one (the watch's record wins and borrows the power);
- its minute-by-minute trace (`stream:phone:<id>`, streams.py), and its power copied onto the watch's trace when
  that has none (a ride on the Tacx with the watch on the wrist), so the power curve and decoupling see it;
- an upload to Garmin Connect (TCX), when after UPLOAD_AFTER no other copy of the ride has turned up: a ride the watch
  didn't record still lands there, and from there on Strava.

The ride's ids go into status.json (`recent_ids`), which is how the phone knows a ride arrived and can stop resending.
"""
from __future__ import annotations

import base64
import json
import statistics
import tempfile
import zlib
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from xml.sax.saxutils import escape

from fitness.activities import activity, merge
from fitness.store import Store

PREFIX = "ride:"
KEY = "phone_ride:"
UPLOAD_AFTER = timedelta(hours=6)   # time for the watch's own copy to reach Garmin Connect first
MAX_CODE = 70_000


def decode(code: str) -> dict:
    """`ride:<base64url(deflate-raw(JSON))>` → the ride, its columns undone from deltas into absolute values."""
    if not code.startswith(PREFIX) or len(code) > MAX_CODE:
        raise ValueError("not a ride from ride mode")
    raw = code[len(PREFIX):].strip()
    data = zlib.decompress(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)), -15, 2_000_000)
    r = json.loads(data)
    if not isinstance(r, dict) or r.get("v") != 1 or not isinstance(r.get("s"), dict):
        raise ValueError("not a ride from ride mode")
    if not str(r.get("id", "")).replace("-", "").isalnum():
        raise ValueError("the ride has no usable id")
    s = r["s"]
    for col in ("t", "lat", "lon", "ele", "d"):
        out, last = [], 0
        for x in s.get(col) or []:
            if x is None:
                out.append(None)
                continue
            last += x
            out.append(last)
        s[col] = out
    n = len(s["t"])
    for col in ("hr", "pw", "cad", "v", "lat", "lon", "ele", "d"):
        s[col] = (list(s.get(col) or []) + [None] * n)[:n]
    return r


def _local(ms: float) -> datetime:
    return datetime.fromtimestamp(ms / 1000)


def to_activity(r: dict) -> dict:
    indoor = bool(r.get("indoor"))
    return activity(
        id=f"phone:{r['id']}", source="phone", start=_local(r["start"]), kind="indoor_cycling" if indoor else "cycling", name=str(r.get("name") or "Ride")[:80],
        duration_s=r.get("elapsed") or (r["end"] - r["start"]) / 1000, moving_s=r.get("moving"), distance_m=r.get("dist"), elev_m=r.get("ascent"),
        avg_hr=r.get("avgHr"), max_hr=r.get("maxHr"), avg_power=r.get("avgPower"), trainer=bool(r.get("trainer")) or None,
        hr_zones=r.get("zones") if r.get("zones") and any(r["zones"]) else None,
        start_utc=datetime.fromtimestamp(r["start"] / 1000, UTC).replace(tzinfo=None).isoformat(),
    )


def stream(r: dict) -> dict:
    """The ride as streams.compact keeps a Garmin trace: one value a minute of heart rate, speed (m/s) and power."""
    s, buckets = r["s"], {}
    for i, t in enumerate(s["t"]):
        if t is None:
            continue
        b = buckets.setdefault(int(t // 60), {"hr": [], "v": [], "p": []})
        for col, name, k in (("hr", "hr", 1), ("v", "v", 0.1), ("pw", "p", 1)):
            v = s[col][i]
            if v is not None and v > 0:
                b[name].append(v * k)
    n = max(buckets) + 1 if buckets else 0
    out = {k: [round(statistics.mean(buckets[m][k]), 1) if m in buckets and buckets[m][k] else None for m in range(n)] for k in ("hr", "v", "p")}
    if not any(out["p"]):
        out["p"] = None
    return out


def save(store: Store, code: str) -> str:
    """Keep a ride the phone sent (again: a resend replaces it), as an activity and a trace. Returns a line for the log."""
    r = decode(code)
    store.set(f"{KEY}{r['id']}", json.dumps(r, separators=(",", ":")))
    store.put_activity(to_activity(r))
    tr = stream(r)
    if any(tr["hr"]) or tr["p"]:
        store.set(f"stream:phone:{r['id']}", json.dumps(tr, separators=(",", ":")))
    store.commit()
    km = (r.get("dist") or 0) / 1000
    return f"{r.get('name') or 'Ride'}: {km:.1f} km, {round((r.get('elapsed') or 0) / 60)} min"


def recent_ids(store: Store, n: int = 30) -> list[str]:
    """The newest rides the sync has from the phone (status.json), so it stops sending them."""
    rides = [json.loads(v) for v in store.prefixed(KEY).values()]
    return [r["id"] for r in sorted(rides, key=lambda r: r.get("start", 0), reverse=True)[:n]]


def _twins(store: Store) -> dict[str, dict]:
    """phone activity id → the record it merged into, for phone rides another source also recorded."""
    out = {}
    for a in merge(store.activities()):
        link = (a.get("links") or {}).get("phone")
        if link and a["source"] != "phone":
            out[link] = a
    return out


def reconcile(store: Store) -> int:
    """The phone's power onto the watch's trace of the same ride, where the watch's has none. Returns how many."""
    twins, traces, done = _twins(store), store.prefixed("stream:"), 0
    starts = {a["id"]: a["start"] for a in store.activities()}
    for pid, twin in twins.items():
        mine, theirs = traces.get(pid), traces.get(twin["id"])
        if not mine or not theirs:
            continue
        m, t = json.loads(mine), json.loads(theirs)
        if t.get("none") or t.get("p") or not m.get("p"):
            continue
        n = len(t.get("hr") or [])
        if pid not in starts:
            continue
        offset = round((datetime.fromisoformat(starts[pid]) - datetime.fromisoformat(twin["start"])).total_seconds() / 60)
        p = [None] * n
        for i, v in enumerate(m["p"]):
            if 0 <= i + offset < n:
                p[i + offset] = v
        if any(p):
            store.set(f"stream:{twin['id']}", json.dumps({**t, "p": p}, separators=(",", ":")))
            done += 1
    return done


def tcx(r: dict) -> str:
    """The ride as a TCX file (Garmin Connect reads heart rate, cadence, speed, power, position and height from it)."""
    s, t0 = r["s"], r.get("t0") or r["start"]

    def when(off: float) -> str:
        return datetime.fromtimestamp(t0 / 1000 + off, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

    pts = []
    for i, off in enumerate(s["t"]):
        if off is None:
            continue
        lat, lon, ele, d, hr, cad, pw, v = (s[c][i] for c in ("lat", "lon", "ele", "d", "hr", "cad", "pw", "v"))
        pts.append("<Trackpoint>" + f"<Time>{when(off)}</Time>"
                   + (f"<Position><LatitudeDegrees>{lat / 1e5:.5f}</LatitudeDegrees><LongitudeDegrees>{lon / 1e5:.5f}</LongitudeDegrees></Position>" if lat is not None and lon is not None else "")
                   + (f"<AltitudeMeters>{ele / 10:.1f}</AltitudeMeters>" if ele is not None else "")
                   + (f"<DistanceMeters>{d:.1f}</DistanceMeters>" if d is not None else "")
                   + (f"<HeartRateBpm><Value>{round(hr)}</Value></HeartRateBpm>" if hr else "")
                   + (f"<Cadence>{round(cad)}</Cadence>" if cad is not None else "")
                   + ("<Extensions><ns3:TPX>" + (f"<ns3:Speed>{v / 10:.2f}</ns3:Speed>" if v is not None else "") + (f"<ns3:Watts>{round(pw)}</ns3:Watts>" if pw is not None else "")
                      + "</ns3:TPX></Extensions>" if v is not None or pw is not None else "")
                   + "</Trackpoint>")
    start = when(0) if s["t"] else datetime.fromtimestamp(r["start"] / 1000, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" '
            'xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">\n'
            f'<Activities><Activity Sport="Biking"><Id>{start}</Id><Lap StartTime="{start}">'
            f'<TotalTimeSeconds>{r.get("elapsed") or 0:.0f}</TotalTimeSeconds><DistanceMeters>{r.get("dist") or 0:.1f}</DistanceMeters>'
            f'<Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod><Track>{"".join(pts)}</Track></Lap>'
            f'<Notes>{escape(str(r.get("name") or "Ride"))} (ride mode)</Notes></Activity></Activities>\n</TrainingCenterDatabase>\n')


def upload_pending(store: Store, now: datetime, upload: Callable[[str], object]) -> list[str]:
    """Rides only the phone recorded, ended over UPLOAD_AFTER ago and not uploaded yet → Garmin Connect. A failure is
    kept for the next run (three tries); the ride's activity stays in the plan either way."""
    twins, done = _twins(store), []
    for key, raw in store.prefixed(KEY).items():
        r = json.loads(raw)
        mark = json.loads(store.get(f"phone_up:{key}") or "null") or {}
        if mark.get("done") or mark.get("tries", 0) >= 3 or f"phone:{key}" in twins:
            continue
        if now - _local(r["end"]) < UPLOAD_AFTER or (r.get("elapsed") or 0) < 300:
            continue
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / f"ride-{key}.tcx"
            path.write_text(tcx(r), encoding="utf-8")
            try:
                upload(str(path))
                mark = {"done": now.isoformat(timespec="seconds")}
                done.append(r.get("name") or key)
            except Exception as e:   # Garmin said no (a duplicate, a hiccup): try again next run, three times
                mark = {"tries": mark.get("tries", 0) + 1, "error": str(e)[:200]}
        store.set(f"phone_up:{key}", json.dumps(mark))
    store.commit()
    return done
