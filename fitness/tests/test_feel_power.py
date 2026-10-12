"""The check-in and ride ratings the app syncs (feel.py), and the power-duration curve (power.py)."""
from __future__ import annotations

import base64
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from fitness import build, cloud, config, demo, feel, power  # noqa: E402
from fitness.activities import activity  # noqa: E402
from fitness.store import Store  # noqa: E402

TODAY = date(2026, 10, 12)


def code(body: dict) -> str:
    return "feel:" + base64.urlsafe_b64encode(json.dumps(body).encode()).decode().rstrip("=")


@pytest.fixture
def cfg():
    return config.load()


def test_parse_keeps_only_what_it_should():
    got = feel.parse(code({"checkins": {"2026-10-12": {"legs": 2, "energy": 9, "mood": "x", "sick": "above", "evil": "<script>"},
                                        "2025-01-01": {"legs": 3}, "nonsense": {"legs": 3}},
                           "rpe": {"garmin:123": 7, "strava:9": 11, "../etc": 5, "garmin:1": 6.5}}), TODAY)
    assert got == {"checkins": {"2026-10-12": {"legs": 2, "sick": "above"}}, "rpe": {"garmin:123": 7}}
    for bad in ("feel:%%%", code({"checkins": {}}), code([1, 2])):
        with pytest.raises(ValueError):
            feel.parse(bad, TODAY)


def test_save_and_load_round_trip(tmp_path):
    with Store(tmp_path / "s.db") as store:
        assert feel.save(store, code({"checkins": {"2026-10-12": {"legs": 4, "sick": "none"}}, "rpe": {"garmin:5": 6}}), TODAY) == "1 check-in(s) and 1 ride rating(s)"
        feel.save(store, code({"checkins": {"2026-10-12": {"legs": 1}}}), TODAY)        # a changed answer replaces the day
        assert feel.load(store, TODAY) == {"checkins": {"2026-10-12": {"legs": 1}}, "rpe": {"garmin:5": 6}}


def test_blend_and_ease_only_ever_make_the_day_easier():
    ready = {"score": 82}
    plan = {"session": "Sweet spot: 3 × 12 min", "commute": None}
    hard = {"level": "hard", "title": "Key session", "detail": "Sweet spot"}
    great = feel.blended(ready, {"legs": 5, "energy": 5, "stress": 5, "mood": 5, "sick": "none"})
    assert great["score"] == 87 and feel.ease(hard, great, plan) is hard
    easy = {"level": "easy", "title": "Recovery spin", "detail": "Z1"}
    assert feel.ease(easy, great, plan) is easy                                                # never harder
    sore = feel.blended(ready, {"legs": 1, "energy": 3, "stress": 3, "mood": 3, "sick": "none"})
    assert sore["cap"] == "easy" and feel.ease(hard, sore, plan)["title"] == "Keep it easy"
    flat = feel.blended({"score": 78}, {"legs": 2, "energy": 2, "stress": 2, "mood": 2, "sick": "none"})
    assert flat["score"] == 73 and flat["cap"] == "moderate" and "moves readiness" in flat["why"]
    sick = feel.blended(ready, {"sick": "below"})
    out = feel.ease(hard, sick, plan)
    assert out["level"] == "rest" and "below the neck" in out["detail"] and out["detail"].startswith("Planned: Sweet spot")
    assert feel.blended(None, {"legs": 3})["score"] == 75                                     # no watch data: the check-in alone


def test_the_build_and_the_notification_carry_the_check_in(tmp_path, cfg):
    today = date(2026, 10, 13)                                      # a Tuesday: a hard day in the plan
    with Store(tmp_path / "d.db") as store:
        demo.populate(store, today, days=120)
        feel.save(store, code({"checkins": {today.isoformat(): {"legs": 3, "energy": 3, "stress": 3, "mood": 3, "sick": "below"}}}), today)
        data = build.assemble(cfg, store.days(), store.activities(), today, felt=feel.load(store, today))
    assert data["plan"]["days"][0]["level"] == "hard"
    assert data["now"]["recommendation"]["level"] == "rest" and data["now"]["feel"]["cap"] == "rest"
    assert data["checkins"][today.isoformat()]["sick"] == "below"
    assert cloud.message(data)["title"] == "Rest today"
    assert all(a.get("id") for a in data["recent"])                                          # the app rates rides by id


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


def test_a_service_run_stores_the_check_in_and_says_when_it_cant(tmp_path, cfg, cloud_dir):
    with Store(cloud_dir / "fitness.db") as store:
        demo.populate(store, TODAY, days=60)
    status = cloud.run(cfg, "service", code({"rpe": {"garmin:1": 4}, "checkins": {"2026-10-12": {"legs": 1}}}), tmp_path / "out", TODAY)
    assert status["ok"] and status["feel"]["error"] is None
    saved = json.loads((tmp_path / "out" / "fitness-data.json").read_text())
    assert saved["checkins"]["2026-10-12"] == {"legs": 1} and saved["now"]["feel"]["cap"] in ("easy", "rest")
    with Store(cloud_dir / "fitness.db") as store:
        assert feel.load(store, TODAY)["rpe"] == {"garmin:1": 4}
    status = cloud.run(cfg, "service", "feel:not-json", tmp_path / "out", TODAY)
    assert "wasn't saved" in status["feel"]["error"]


def test_mean_max_and_critical_power():
    cp, wp = 250.0, 20000.0                                         # a rider whose bests follow the model exactly
    best = {d: {"w": round(cp + wp / (d * 60)), "date": "2026-10-01", "name": "x"} for d in power.DURATIONS}
    fit = power.critical_power(best)
    assert abs(fit["cp"] - 250) <= 2 and abs(fit["w_prime_kj"] - 20) <= 0.6 and fit["r2"] > 0.99
    assert power.critical_power({d: best[d] for d in (3, 5)}) is None                      # too few points to be honest
    trace = [100.0] * 30 + [300.0] * 5 + [None] * 3 + [200.0] * 20
    mm = power.mean_max(trace)
    assert mm[5] == 300 and mm[1] == 300 and mm[20] == 200 and 30 not in mm or mm[30] < 200
    assert 90 not in mm                                                                   # longer than the ride


def test_profile_from_traces_and_average_power(cfg):
    acts, traces = [], {}
    for k in range(10):
        day = TODAY - timedelta(days=3 + 7 * k)
        a = activity(id=f"garmin:{k}", source="garmin", start=datetime.combine(day, datetime.min.time()).replace(hour=17), kind="road_biking",
                     duration_s=3600, moving_s=3600)
        acts.append(a)
        traces[a["id"]] = {"hr": [140] * 60, "v": [8] * 60, "p": [150.0] * 10 + [320.0] * 3 + [150.0] * 7 + [270.0] * 12 + [150.0] * 8 + [250.0] * 20}
    old = activity(id="strava:z", source="strava", start=datetime(2026, 1, 20, 18), kind="VirtualRide", duration_s=5400, moving_s=5400, avg_power=230)
    p = power.profile([*acts, old], traces, TODAY, 75.0, 200)
    i20 = p["durations"].index(20)
    assert p["recent"][p["durations"].index(3)] == 320 and p["year"][i20] >= 250
    assert p["year"][p["durations"].index(90)] == 230 and p["year_when"][p["durations"].index(90)] == "2026-01-20"   # a ride's average floors its length
    assert p["recent"][p["durations"].index(90)] is None
    assert p["cp"] and 230 <= p["cp"]["cp"] <= 270 and p["eftp"] == round(0.95 * p["year"][i20])
    assert p["wkg_20"] == round(p["year"][i20] / 75, 2)
    assert any("puts FTP near" in n for n in p["notes"])                                   # 200 W in config is out of date
    assert power.profile([], {}, TODAY, None, None) is None
