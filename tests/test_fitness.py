"""Offline tests for the fitness insights site: the models, the planner, the parsers and the end-to-end build."""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fitness import build, config, demo  # noqa: E402
from fitness import metrics as m  # noqa: E402
from fitness.activities import activity, classify, merge  # noqa: E402
from fitness.garmin import parse_activity, parse_day  # noqa: E402
from fitness.plan import plan_race, roles  # noqa: E402
from fitness.store import Store  # noqa: E402
from fitness.strava import parse_api, parse_export  # noqa: E402

TH = {"max_hr": 185, "rest_hr": 50, "lthr": 165, "ftp": 0, "sex": "male"}


@pytest.fixture
def cfg():
    return config.load()


def test_config_loads_race(cfg):
    assert cfg["race"]["date"] == date(2026, 11, 7)
    assert len(cfg["plan"]["weekly_pattern"]) == 7


def test_hr_tss_is_100_for_an_hour_at_threshold():
    a = activity(id="x", source="garmin", start=datetime(2026, 1, 1, 8), kind="road_biking", duration_s=3600, avg_hr=165)
    load, src = m.session_load(a, TH)
    assert src == "hr" and load == pytest.approx(100, abs=0.5)


def test_power_tss_wins_when_ftp_set():
    a = activity(id="x", source="strava", start=datetime(2026, 1, 1, 8), kind="Ride", duration_s=7200, avg_hr=150, np=200)
    load, src = m.session_load(a, {**TH, "ftp": 250})
    assert src == "power" and load == pytest.approx(2 * 0.8 ** 2 * 100)


def test_duration_fallback_without_hr():
    a = activity(id="x", source="strava", start=datetime(2026, 1, 1, 8), kind="Walk", duration_s=3600)
    assert m.session_load(a, TH)[1] == "duration"


def test_pmc_converges_to_constant_load():
    load = {(date(2026, 1, 1) + timedelta(days=i)).isoformat(): 60.0 for i in range(400)}
    rows = m.pmc(load)
    assert rows[-1]["ctl"] == pytest.approx(60, abs=0.5)
    assert rows[-1]["tsb"] == pytest.approx(0, abs=0.5)
    assert rows[-1]["acwr"] == pytest.approx(1.0)


def test_sleep_score_bands():
    great = {"total": 8 * 3600, "deep": 0.2 * 8 * 3600, "rem": 0.24 * 8 * 3600, "awake": 300, "awake_count": 1, "avg_stress": 12}
    short = {**great, "total": 5 * 3600, "awake": 3600, "awake_count": 6, "avg_stress": 35}
    assert m.sleep_score(great, 8)["score"] == 100
    assert m.sleep_score(short, 8)["label"] == "Poor"
    assert m.sleep_score(None, 8) is None
    no_stages = {"total": 7 * 3600, "awake": 600}
    assert set(m.sleep_score(no_stages, 8)["parts"]) == {"duration", "continuity"}


def _days(n=60, **last):
    days = {}
    for i in range(n):
        d = (date(2026, 9, 1) + timedelta(days=i)).isoformat()
        days[d] = {"rhr": 50 + (i % 3) - 1, "bb_wake": 80 + (i % 5), "sleep": {"total": 27000, "avg_stress": 18 + (i % 4), "resp": 14.0 + (i % 2) * 0.2}}
    k = max(days)
    days[k] = {**days[k], **{x: v for x, v in last.items() if x != "sleep"}}
    days[k]["sleep"] = {**days[k]["sleep"], **last.get("sleep", {})}
    return days, k


def test_readiness_normal_day_is_green():
    days, k = _days(rhr=50, bb_wake=82, sleep={"avg_stress": 19.5, "resp": 14.1})
    r = m.readiness(k, days, {"score": 85, "label": "Good", "hours": 7.5}, {"tsb": 0, "acwr": 1.0})
    assert r["score"] >= 75 and not r["illness"]


def test_readiness_flags_illness():
    days, k = _days(rhr=58, sleep={"resp": 16.0, "avg_stress": 35})
    r = m.readiness(k, days, {"score": 70, "label": "Fair", "hours": 7}, None)
    assert r["illness"]
    assert m.recommend(r)["level"] == "rest"


def test_readiness_needs_baseline():
    days, k = _days(n=10)
    assert m.readiness(k, days, None, None) is None


def test_readiness_only_ever_eases_the_plan():
    plan_day = {"level": "hard", "title": "Key session", "session": "VO2", "minutes": 75}
    assert m.recommend({"score": 50, "illness": False}, plan_day)["level"] == "easy"
    assert m.recommend({"score": 90, "illness": False}, {**plan_day, "level": "rest"})["level"] == "rest"
    assert m.recommend({"score": 90, "illness": False}, plan_day)["detail"] == "VO2 — about 1h15"


def test_spearman_and_insights():
    assert m.spearman([1, 2, 3, 4], [10, 20, 30, 40]) == pytest.approx(1)
    rows = [(x, 90 - x * 0.5) for x in range(40)]
    out = m.insights({"load→sleep": rows})
    assert out and out[0]["rho"] == pytest.approx(-1) and "lowers" in out[0]["text"]
    assert m.insights({"load→sleep": rows[:10]}) == []


def test_roles_from_pattern():
    assert roles([0.0, 1.3, 0.8, 1.2, 0.4, 1.7, 0.9]) == ["rest", "key", "endurance", "key", "easy", "long", "endurance"]


def test_plan_lands_in_target_band(cfg):
    p = plan_race(date(2026, 10, 8), date(2026, 11, 7), 45.0, 50.0, cfg)
    assert p["days"][-1]["phase"] == "race" and p["days"][-2]["phase"] == "openers"
    assert p["in_band"], p["race_tsb"]
    assert cfg["plan"]["taper_days"][0] <= p["taper_days"] <= cfg["plan"]["taper_days"][1]
    assert plan_race(date(2026, 11, 8), date(2026, 11, 7), 45, 50, cfg) is None


def test_classify():
    assert classify("mountain_biking") == ("ride", True)
    assert classify("MountainBikeRide") == ("ride", True)
    assert classify("Fat Bike Ride")[0] == "ride"


def test_merge_garmin_and_strava_twins():
    g = activity(id="garmin:1", source="garmin", start=datetime(2026, 9, 1, 8), kind="mountain_biking", name="Kalkaska Mountain Biking", duration_s=3600)
    s = activity(id="strava:9", source="strava", start=datetime(2026, 9, 1, 8, 1), kind="MountainBikeRide", name="Vasa loop", duration_s=3500, np=210)
    other = activity(id="strava:10", source="strava", start=datetime(2026, 9, 2, 8), kind="Ride", duration_s=3600)
    out = merge([s, g, other])
    assert [a["id"] for a in out] == ["garmin:1", "strava:10"]
    assert out[0]["np"] == 210 and out[0]["name"] == "Vasa loop" and out[0]["links"] == {"strava": "strava:9"}


def test_parse_garmin_day_venu_sq_shape():
    summary = {"restingHeartRate": 51, "averageStressLevel": 28, "bodyBatteryHighestValue": 88, "bodyBatteryAtWakeTime": 85, "totalSteps": 9000,
               "moderateIntensityMinutes": 10, "vigorousIntensityMinutes": 20}
    sleep = {"dailySleepDTO": {"sleepTimeSeconds": 26000, "deepSleepSeconds": 5000, "lightSleepSeconds": 15000, "remSleepSeconds": 6000,
                               "awakeSleepSeconds": 900, "sleepStartTimestampLocal": 1759876200000, "sleepEndTimestampLocal": 1759903200000,
                               "avgSleepStress": 17.0, "averageRespirationValue": 13.9, "sleepScores": None}, "restlessMomentsCount": 40}
    d = parse_day(summary, sleep)
    assert d["rhr"] == 51 and d["bb_wake"] == 85 and d["intensity_min"] == 50
    assert d["sleep"]["start"] == "2025-10-07T22:30" and d["sleep"]["garmin_score"] is None and d["sleep"]["avg_stress"] == 17.0
    assert parse_day({}, {}) == {"empty": True}


def test_parse_garmin_activity():
    a = parse_activity({"activityId": 5, "startTimeLocal": "2026-09-01 07:30:00", "activityType": {"typeKey": "mountain_biking"}, "duration": 3700,
                        "movingDuration": 3600, "distance": 30000, "averageHR": 150, "hrTimeInZone_2": 1200})
    assert a["id"] == "garmin:5" and a["offroad"] and a["hr_zones"] == [None, 1200, None, None, None]


def test_parse_strava_api_ignores_estimated_power():
    a = parse_api({"id": 3, "start_date_local": "2026-09-01T07:30:00Z", "sport_type": "GravelRide", "elapsed_time": 3700, "moving_time": 3600,
                   "average_watts": 180, "weighted_average_watts": 195, "device_watts": False})
    assert a["start"] == "2026-09-01T07:30:00" and a["np"] is None and a["offroad"]


def test_parse_strava_export_duplicate_headers():
    csv = ('Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Max Heart Rate,Relative Effort,Elapsed Time,Moving Time,Distance,'
           'Elevation Gain,Average Heart Rate,Average Watts,Device Watts,Weighted Average Power\n'
           '77,"Nov 2, 2024, 3:00:00 PM",Iceman!,Mountain Bike Ride,7300,48.9,180,250,7300,7200,48900.5,575,163,,false,\n')
    (a, _), = parse_export(csv, "America/Detroit")
    assert a["start"] == "2024-11-02T11:00:00" and a["distance_m"] == 48900.5 and a["avg_hr"] == 163 and a["offroad"] and a["suffer_score"] == 250


def test_build_end_to_end(tmp_path, cfg):
    today = date(2026, 10, 8)
    with Store(tmp_path / "d.db") as store:
        demo.populate(store, today, days=200)
        data = build.assemble(cfg, store.days(), store.activities(), today)
    assert data["now"]["readiness"] and data["plan"]["days"][-1]["date"] == "2026-11-07"
    assert len(data["sleep"]) == build.SLEEP_DAYS and len(data["weeks"]) == build.WEEKS
    assert {c["field"] for c in data["coverage"]} >= {"Garmin Sleep Score", "Overnight HRV (ms)"}
    out = build.render(data, tmp_path / "index.html")
    html = out.read_text()
    assert "/*__APP__*/" not in html and "__DATA__" not in html
    payload = html.split('<script type="application/json" id="data">')[1].split("</script>")[0]
    assert json.loads(payload)["today"] == "2026-10-08"
