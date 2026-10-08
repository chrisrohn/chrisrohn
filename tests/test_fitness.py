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
from fitness.config import nth_weekday, race_dates  # noqa: E402
from fitness.garmin import parse_activity, parse_day  # noqa: E402
from fitness.plan import in_indoor, roles, season, upcoming  # noqa: E402
from fitness.store import Store  # noqa: E402
from fitness.strava import parse_api, parse_export  # noqa: E402

TH = {"max_hr": 185, "rest_hr": 50, "lthr": 165, "ftp": 0, "sex": "male"}


@pytest.fixture
def cfg():
    return config.load()


def test_config_loads_races(cfg):
    names = [r["name"] for r in cfg["races"]]
    assert "Barry-Roubaix" in names and any("Iceman" in n for n in names)
    barry = next(r for r in cfg["races"] if r["name"] == "Barry-Roubaix")
    assert barry["date"] == date(2027, 4, 17) and set(barry["options"]) == {"100k", "50k"} and barry["distance"] == "100k"
    assert len(cfg["plan"]["weekly_pattern"]) == 7


def test_legacy_single_race_config(tmp_path):
    path = tmp_path / "c.toml"
    path.write_text('[race]\nname = "Old"\ndate = 2026-11-07\ndistance_mi = 30\ntarget_tsb = [10, 20]\n')
    cfg = config.load(path)
    assert cfg["races"][0]["name"] == "Old" and cfg["races"][0]["options"]["race"]["km"] == 48


def test_nth_weekday_and_rollover():
    assert nth_weekday("3rd Sat Apr", 2027) == date(2027, 4, 17)
    assert nth_weekday("1st Sat Nov", 2026) == date(2026, 11, 7)
    race = {"date": date(2026, 4, 18), "every": "3rd Sat Apr"}
    assert race_dates(race, date(2026, 10, 8)) == (date(2026, 4, 18), date(2027, 4, 17))
    assert race_dates({"date": date(2026, 4, 18), "every": ""}, date(2026, 10, 8)) == (date(2026, 4, 18), date(2026, 4, 18))


def test_indoor_window_wraps_the_new_year_and_leap_day(cfg):
    assert in_indoor(date(2026, 12, 1), cfg) and in_indoor(date(2027, 1, 15), cfg) and in_indoor(date(2028, 2, 29), cfg)
    assert not in_indoor(date(2026, 11, 30), cfg) and not in_indoor(date(2027, 3, 1), cfg)


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


def test_season_plans_both_races(cfg):
    p = season(date(2026, 10, 8), 45.0, 50.0, cfg)
    iceman, barry = p["races"]
    assert iceman["date"] == "2026-11-07" and barry["date"] == "2027-04-17" and barry["option"] == "100k"
    assert iceman["in_band"] and barry["in_band"], (iceman["race_tsb"], barry["race_tsb"])
    by_date = {d["date"]: d for d in p["days"]}
    assert by_date["2026-11-07"]["phase"] == "race" and by_date["2026-11-06"]["phase"] == "openers"
    assert by_date["2026-11-10"]["phase"] == "recovery"                       # the week after Iceman
    assert by_date["2026-11-20"]["phase"] == "transition"
    assert by_date["2027-01-12"]["phase"] == "base" and by_date["2027-01-12"]["indoor"]
    assert by_date["2027-03-09"]["phase"] == "build" and not by_date["2027-03-09"]["indoor"]
    assert by_date["2027-04-17"]["title"].startswith("Race day — Barry-Roubaix (Killer")
    indoor = [d for d in p["days"] if d["indoor"]]
    assert indoor and all(d["date"][5:] >= "12-01" or d["date"][5:] <= "02-29" for d in indoor)
    assert any(d["title"] == "FTP ramp test" and d["date"].startswith("2026-12") for d in indoor)
    assert any(d["title"] == "FTP ramp test" and d["date"].startswith("2027-02") for d in indoor)
    assert all(d["minutes"] <= cfg["indoor"]["long_ride_h"] * 60 + 5 for d in indoor)   # no 4-hour trainer rides
    assert any(w["recovery_week"] and w["phase"] == "base" for w in p["weeks"])
    assert barry["build_start"] == "2027-03-01" and barry["peak_week_h"] > 0


def test_season_distance_choice(cfg):
    long = season(date(2026, 10, 8), 45.0, 50.0, cfg)["races"][1]
    short = season(date(2026, 10, 8), 45.0, 50.0, cfg, choices={"Barry-Roubaix": "50k"})["races"][1]
    assert short["option"] == "50k" and short["label"].startswith("Thriller")
    assert short["target_ctl"] < long["target_ctl"] and short["peak_week_h"] < long["peak_week_h"]
    assert upcoming(cfg, date(2026, 10, 8), {"Barry-Roubaix": "nonsense"})[0][1]["option"] == "100k"


def test_season_none_without_races(cfg):
    assert season(date(2026, 10, 8), 45, 50, {**cfg, "races": []}) is None


def test_indoor_detection():
    z = activity(id="s", source="strava", start=datetime(2027, 1, 5, 18), kind="Ride", name="Zwift - Watopia", duration_s=3600)
    w = activity(id="w", source="strava", start=datetime(2027, 1, 5, 18), kind="Ride", name="MyWoosh - Belgium", duration_s=3600)
    v = activity(id="v", source="strava", start=datetime(2027, 1, 5, 18), kind="VirtualRide", duration_s=3600)
    t = activity(id="t", source="strava", start=datetime(2027, 1, 5, 18), kind="Ride", duration_s=3600, trainer=True)
    o = activity(id="o", source="strava", start=datetime(2027, 1, 5, 18), kind="GravelRide", duration_s=3600)
    assert z["indoor"] and w["indoor"] and v["indoor"] and t["indoor"] and not o["indoor"] and "trainer" not in t


def test_estimate_ftp_from_trainer_rides():
    acts = [activity(id=f"s{i}", source="strava", start=datetime(2027, 1, 5 + i, 18), kind="VirtualRide", duration_s=m_ * 60, np=np_)
            for i, (m_, np_) in enumerate([(20, 260), (60, 240), (120, 300), (10, 400)])]
    assert m.estimate_ftp(acts, date(2027, 2, 1)) == 247   # 20 min × 0.95 vs 60 min × 1.0; the 2 h and 10 min rides don't count
    assert m.thresholds({"athlete": {**config.DEFAULTS["athlete"]}}, acts, {}, date(2027, 2, 1))["ftp"] == 247


def test_classify():
    assert classify("mountain_biking") == ("ride", True)
    assert classify("MountainBikeRide") == ("ride", True)
    assert classify("Fat Bike Ride")[0] == "ride"


def test_merge_garmin_and_strava_twins():
    g = activity(id="garmin:1", source="garmin", start=datetime(2026, 9, 1, 8), kind="mountain_biking", name="Kalkaska Mountain Biking", duration_s=3600)
    s = activity(id="strava:9", source="strava", start=datetime(2026, 9, 1, 8, 1), kind="MountainBikeRide", name="Vasa loop", duration_s=3500, np=210)
    other = activity(id="strava:10", source="strava", start=datetime(2026, 9, 2, 8), kind="Ride", duration_s=3600)
    out = merge([other, s, g])   # a Strava-only ride listed first used to crash the merge
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
        demo.populate(store, today, days=330)   # reaches back into last winter's trainer season
        data = build.assemble(cfg, store.days(), store.activities(), today)
    assert data["now"]["readiness"] and data["plan"]["days"][-1]["date"] == "2027-04-17"
    assert len(data["sleep"]) == build.SLEEP_DAYS and len(data["weeks"]) == build.WEEKS
    assert {c["field"] for c in data["coverage"]} >= {"Garmin Sleep Score", "Overnight HRV (ms)"}
    assert set(data["variants"]) == {"Barry-Roubaix|50k"} and data["now"]["base_call"]["level"] in ("hard", "moderate", "easy", "rest")
    assert data["indoor"]["rides"] > 0 and data["indoor"]["avg_np"]
    assert [e["date"][:4] for e in data["editions"]["Barry-Roubaix"]] == ["2025", "2026"]
    out = build.render(data, tmp_path / "index.html")
    html = out.read_text()
    assert "/*__APP__*/" not in html and "__DATA__" not in html
    payload = html.split('<script type="application/json" id="data">')[1].split("</script>")[0]
    assert json.loads(payload)["today"] == "2026-10-08"
