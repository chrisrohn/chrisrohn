"""Rides recorded in ride mode and sent to the sync (rides.py): decoded, kept as an activity and a trace, merged with
the watch's copy (its power added), and uploaded to Garmin Connect only when nothing else recorded them."""
from __future__ import annotations

import base64
import json
import sys
import zlib
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from fitness import cloud, config, demo, rides  # noqa: E402
from fitness.activities import activity, merge  # noqa: E402
from fitness.store import Store  # noqa: E402

START = datetime(2026, 10, 20, 17, 0, tzinfo=UTC)


def digest(rid: str = "abc123", minutes: int = 45, step: int = 5, power: bool = True, gps: bool = True, start: datetime = START) -> dict:
    """What RideCore.rideDigest sends: columns every `step` seconds, delta-coded where they accumulate."""
    n = minutes * 60 // step
    t = [i * step for i in range(1, n + 1)]
    lat = [round((42.73 + i * 1e-5) * 1e5) for i in range(n)] if gps else [None] * n
    lon = [round(-84.55 * 1e5)] * n if gps else [None] * n
    d = [round(i * step * 7.5) for i in range(1, n + 1)]

    def delta(xs):
        out, last = [], 0
        for x in xs:
            if x is None:
                out.append(None)
                continue
            out.append(x - last)
            last = x
        return out

    ms = int(start.timestamp() * 1000)
    return {"v": 1, "id": rid, "name": "Commute home · Oct 20", "start": ms, "t0": ms, "end": ms + minutes * 60_000, "step": step,
            "elapsed": minutes * 60, "moving": minutes * 60 - 60, "dist": d[-1], "ascent": 42, "avgHr": 141, "maxHr": 168, "avgPower": 182 if power else None,
            "avgCad": 86, "tss": 48, "indoor": not gps, "trainer": not gps, "zones": [300, 1500, 600, 300, 0],
            "s": {"t": delta(t), "hr": [140 + i % 7 for i in range(n)], "pw": [180 + i % 9 for i in range(n)] if power else [None] * n, "cad": [86] * n,
                  "v": [75] * n, "lat": delta(lat), "lon": delta(lon), "ele": delta([2600 + i % 30 for i in range(n)]), "d": delta(d)}}


def pack(r: dict) -> str:
    c = zlib.compressobj(9, zlib.DEFLATED, -15)
    raw = c.compress(json.dumps(r, separators=(",", ":")).encode()) + c.flush()
    return "ride:" + base64.urlsafe_b64encode(raw).decode().rstrip("=")


def test_a_ride_code_decodes_into_absolute_columns():
    r = rides.decode(pack(digest()))
    s = r["s"]
    assert s["t"][:3] == [5, 10, 15] and s["d"][-1] == r["dist"] and abs(s["lat"][1] / 1e5 - 42.73001) < 1e-6
    assert len(s["hr"]) == len(s["t"]) == 540
    for bad in ("ride:%%%", "feel:x", pack({"v": 2, "s": {}}), pack({**digest(), "id": "../x"}), "ride:" + "A" * 80_000):
        with pytest.raises(Exception):  # noqa: B017 - any refusal will do; nothing is stored
            rides.decode(bad)


def test_saved_ride_counts_as_an_activity_with_a_trace(tmp_path):
    with Store(tmp_path / "f.db") as store:
        line = rides.save(store, pack(digest()))
        assert "Commute home" in line and "45 min" in line
        acts = {a["id"]: a for a in store.activities()}
        a = acts["phone:abc123"]
        assert a["group"] == "ride" and a["avg_power"] == 182 and a["duration_s"] == 2700 and not a["indoor"]
        tr = json.loads(store.get("stream:phone:abc123"))
        assert len(tr["hr"]) == 46 and tr["p"][3] and abs(tr["v"][3] - 7.5) < 1e-6
        rides.save(store, pack(digest()))                                              # a resend replaces, never doubles
        assert sum(1 for x in store.activities() if x["id"] == "phone:abc123") == 1
        assert rides.recent_ids(store) == ["abc123"]
        rides.save(store, pack(digest("trainer1", gps=False, start=START + timedelta(days=1))))
        assert {x["id"]: x for x in store.activities()}["phone:trainer1"]["indoor"] is True
        assert rides.recent_ids(store)[0] == "trainer1"


def test_the_watch_copy_wins_and_gets_the_phones_power(tmp_path):
    with Store(tmp_path / "f.db") as store:
        rides.save(store, pack(digest()))
        local = datetime.fromtimestamp(START.timestamp())
        watch = activity(id="garmin:9", source="garmin", start=local + timedelta(minutes=1), kind="cycling", name="Lansing Cycling", duration_s=2640,
                         avg_hr=140, start_utc=(START + timedelta(minutes=1)).replace(tzinfo=None).isoformat())
        store.put_activity(watch)
        store.set("stream:garmin:9", json.dumps({"hr": [140.0] * 44, "v": [7.5] * 44, "p": None}))
        merged = [a for a in merge(store.activities()) if a["group"] == "ride"]
        assert len(merged) == 1 and merged[0]["id"] == "garmin:9" and merged[0]["avg_power"] == 182 and merged[0]["links"]["phone"] == "phone:abc123"
        assert rides.reconcile(store) == 1
        p = json.loads(store.get("stream:garmin:9"))["p"]
        mine = json.loads(store.get("stream:phone:abc123"))["p"]
        assert p[0] == mine[1] and p[43] == mine[44] and len(p) == 44                    # lined up: the phone started a minute first
        assert rides.reconcile(store) == 0                                               # once only
        calls = []
        assert rides.upload_pending(store, local + timedelta(hours=8), calls.append) == [] and calls == []


def test_only_rides_nothing_else_recorded_go_up_to_garmin(tmp_path):
    with Store(tmp_path / "f.db") as store:
        rides.save(store, pack(digest()))
        local_end = datetime.fromtimestamp(START.timestamp()) + timedelta(minutes=45)
        sent: list[str] = []

        def upload(path: str) -> None:
            text = Path(path).read_text()
            assert path.endswith(".tcx") and "<Trackpoint>" in text and "<ns3:Watts>" in text and "<LatitudeDegrees>42.73" in text
            sent.append(path)

        assert rides.upload_pending(store, local_end + timedelta(hours=2), upload) == [] and not sent      # the watch may still sync
        assert rides.upload_pending(store, local_end + timedelta(hours=7), upload) == ["Commute home · Oct 20"]
        assert rides.upload_pending(store, local_end + timedelta(hours=9), upload) == [] and len(sent) == 1  # once

        rides.save(store, pack(digest("b2", start=START + timedelta(days=1))))

        def refuse(path: str) -> None:
            raise RuntimeError("409 duplicate")

        for _ in range(4):
            rides.upload_pending(store, local_end + timedelta(days=2), refuse)
        assert json.loads(store.get("phone_up:b2")) == {"tries": 3, "error": "409 duplicate"}            # three tries, then left alone


@pytest.fixture
def cloud_dir(tmp_path, monkeypatch):
    import time as _time
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(config, "DATA_DIR", data)
    monkeypatch.setattr(config, "DB_PATH", data / "fitness.db")
    monkeypatch.setattr(config, "STRAVA_TOKEN", data / "strava_token.json")
    for k in ("GARMIN_EMAIL", "GARMIN_PASSWORD", "STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("TZ", "UTC")
    yield data
    monkeypatch.undo()
    _time.tzset()


def test_a_service_run_saves_the_ride_and_lists_it_in_the_status(tmp_path, cloud_dir):
    cfg = config.load()
    today = date(2026, 10, 21)
    with Store(cloud_dir / "fitness.db") as store:
        demo.populate(store, today, days=60)
    status = cloud.run(cfg, "service", pack(digest()), tmp_path / "out", today)
    assert status["ok"] and status["rides"] == ["abc123"] and status["ride"]["error"] is None
    saved = json.loads((tmp_path / "out" / "status.json").read_text())
    assert saved["rides"] == ["abc123"]
    status = cloud.run(cfg, "service", "ride:not-a-ride", tmp_path / "out", today)
    assert "wasn't saved" in status["ride"]["error"] and status["rides"] == ["abc123"]
