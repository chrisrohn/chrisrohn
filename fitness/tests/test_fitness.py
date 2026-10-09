"""Offline tests for the fitness insights site: the models, the planner, the parsers and the end-to-end build."""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]   # the repo root, so `import fitness` works from anywhere
sys.path.insert(0, str(ROOT))

from fitness import build, config, demo  # noqa: E402
from fitness import metrics as m  # noqa: E402
from fitness.activities import activity, classify, merge  # noqa: E402
from fitness.config import nth_weekday, race_dates  # noqa: E402
from fitness.garmin import parse_activity, parse_day  # noqa: E402
from fitness.plan import in_indoor, roles, season, upcoming  # noqa: E402
from fitness.store import Store  # noqa: E402
from fitness.strava import parse_api, parse_export  # noqa: E402
from fitness.workouts import LIBRARY, steps_for  # noqa: E402

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


def test_every_library_session_has_steps(cfg):
    from fitness.plan import SESSIONS
    assert set(LIBRARY) == {(name, i) for name, lib in SESSIONS.items() for i in range(len(lib))}
    for key, make in LIBRARY.items():
        steps = make()
        assert steps and all(s["min"] > 0 and 0 <= s["lo"] < s["hi"] for s in steps), key


def test_steps_fill_to_planned_time():
    st = steps_for(("mtb", 2), "Key session", 120)
    assert round(sum(s["min"] for s in st)) == 120 and st[-1]["name"] == "Cool-down" and st[-2]["name"] == "Endurance"
    assert [s["min"] for s in steps_for(None, "Recovery spin", 45)] == [45]
    assert steps_for(None, "Rest", 0) == [] and steps_for(None, "Strength", 45) == []
    race = steps_for(None, "Race day — Barry-Roubaix (Killer · 62 mi)", 0, race_hours=3.75)
    assert race[-1]["min"] == 225 and "Eat" in race[-1]["cue"]
    assert any("feel" in s["cue"] for s in steps_for(("indoor_late", 2), "Trainer workout", 70))   # 30/30s are ridden by feel


def test_ride_page_and_link(tmp_path, cfg):
    import base64
    import zlib
    today = date(2026, 10, 8)
    with Store(tmp_path / "d.db") as store:
        demo.populate(store, today, days=120)
        data = build.assemble(cfg, store.days(), store.activities(), today)
    ride = data["ride"]
    assert ride["units"] == data["units"] == "imperial"
    assert ride["lthr"] and 1 <= len({d["date"] for d in ride["days"]}) <= 7 and ride["days"][0]["date"] == "2026-10-08" and ride["days"][0]["steps"]
    assert [d["title"] for d in ride["days"][:2]] == ["Commute in", "Commute home"] and ride["days"][0]["check"] and ride["commute"]["in"]
    build.render(data, tmp_path / "index.html", cfg)
    page = (tmp_path / "ride.html").read_text()
    assert "__RIDE_DATA__" not in page and "/*__RIDE_APP__*/" not in page and '"lthr"' in page
    assert 'ride.html' in (tmp_path / "index.html").read_text()
    link = build.ride_link(cfg, ride, "ride.html")
    assert link.startswith("https://chrisrohn.com/fitness/ride.html#z=")
    blob = link.split("#z=")[1]
    assert json.loads(zlib.decompress(base64.urlsafe_b64decode(blob + "=" * (-len(blob) % 4)), -15)) == ride
    assert len(link) < 2400   # small enough for a QR code a phone camera reads off a laptop screen
    assert build.ride_link({**cfg, "app": {**cfg["app"], "url": ""}}, ride, "ride.html") == "ride.html"
    page = build.ride_page(None)
    assert "__CSP__" not in page and "script-src 'sha256-" in page and "__RIDE_DATA__" not in page


def test_installable_app_and_phone_link(tmp_path, cfg):
    import base64
    import zlib
    today = date(2026, 10, 8)
    with Store(tmp_path / "d.db") as store:
        demo.populate(store, today, days=120)
        data = build.assemble(cfg, store.days(), store.activities(), today)
    export = tmp_path / "drive"
    build.render(data, tmp_path / "index.html", {**cfg, "app": {**cfg["app"], "export_dir": str(export)}})
    manifest = json.loads((tmp_path / "manifest.webmanifest").read_text())
    assert manifest["display"] == "standalone" and manifest["start_url"].startswith("./") and manifest["scope"] == "./"
    assert manifest["id"] == "/fitness/"   # resolved against the origin: "./" would be the music app's id at the root
    assert {"192x192", "512x512"} <= {i["sizes"] for i in manifest["icons"]} and any("maskable" in i.get("purpose", "") for i in manifest["icons"])
    assert all((tmp_path / i["src"]).exists() for i in manifest["icons"])
    sw = (tmp_path / "sw.js").read_text()
    assert "__VERSION__" not in sw and 'fitness-' in sw
    html = (tmp_path / "index.html").read_text()
    assert 'rel="manifest"' in html and "manifest-src 'self'" in html and "worker-src 'self'" in html and "/*__SHELL__*/" not in html
    saved = json.loads((tmp_path / "fitness-data.json").read_text())
    assert saved["today"] == "2026-10-08" and "ride_qr" not in saved and "phone_href" not in saved
    assert (export / "fitness-data.json").read_text() == (tmp_path / "fitness-data.json").read_text()
    link = build.phone_link(cfg, data)
    assert link.startswith("https://chrisrohn.com/fitness/#d=")
    blob = link.split("#d=")[1]
    assert json.loads(zlib.decompress(base64.urlsafe_b64decode(blob + "=" * (-len(blob) % 4)), -15)) == saved
    assert build.phone_link({**cfg, "app": {"url": ""}}, data) is None


# ── commuting ─────────────────────────────────────────────────────────────────────────────────────────────

def _commute(day: date, hour: float, km: float = 30.2, flag: bool | None = None, hr: float = 135, speed: float = 27.0, kind: str = "road_biking"):
    start = datetime.combine(day, datetime.min.time()) + timedelta(hours=hour)
    return activity(id=f"x{day}{hour}{km}", source="strava" if flag else "garmin", start=start, kind=kind, duration_s=km / speed * 3600,
                    distance_m=km * 1000, avg_hr=hr, commute=flag)


def test_commute_detection(cfg):
    tue = date(2026, 9, 15)
    acts = [_commute(tue, 7), _commute(tue, 16.75), _commute(tue + timedelta(days=4), 9),       # Sat: not a commute
            _commute(tue, 12), _commute(tue, 7.5, km=60), _commute(tue, 22, flag=True)]          # noon, too long; Strava's flag wins
    m.mark_commutes(acts, cfg)
    assert [a.get("commute", False) for a in acts] == [True, True, False, False, False, True]
    assert acts[0]["leg"] == "in" and acts[1]["leg"] == "home"


def test_commute_profile_learns_cost_and_hr_at_speed(cfg):
    acts = []
    for i in range(20):
        day = date(2026, 6, 2) + timedelta(days=7 * (i // 2) + (i % 2) * 2)
        sp = 25 + (i % 5)
        acts += [_commute(day, 7, speed=sp, hr=100 + 1.5 * sp), _commute(day, 17, speed=sp - 1, hr=104 + 1.5 * (sp - 1))]
    m.mark_commutes(acts, cfg)
    th = {**TH, "lthr": 165}
    for a in acts:
        a["load"], a["load_src"] = m.session_load(a, th)
    prof = m.commute_profile(acts, cfg, date(2026, 10, 8))
    a, b = prof["legs"]["in"]["model"]
    assert b == pytest.approx(1.5, abs=0.01) and a == pytest.approx(100, abs=0.5)
    assert prof["legs"]["in"]["rides"] == 20 and prof["legs"]["home"]["load"] > 0 and len(prof["series"]) == 40


def test_commute_profile_defaults_without_history(cfg):
    prof = m.commute_profile([], cfg, date(2026, 10, 8))
    assert prof["legs"]["in"]["minutes"] == round(30 / 26 * 60) and prof["legs"]["in"]["model"] is None
    assert m.commute_profile([], {**cfg, "commute": {**cfg["commute"], "enabled": False}}, date(2026, 10, 8)) is None


def test_planner_books_commutes_inside_the_week(cfg):
    p = season(date(2026, 10, 8), 45.0, 50.0, cfg)
    days = {d["date"]: d for d in p["days"]}
    lo, hi = cfg["commute"]["per_week"]
    allowed = {"mon", "tue", "wed", "thu", "fri"} & set(cfg["commute"]["days"])
    for w in p["weeks"]:
        assert w["commutes"] <= hi
        if w["phase"] == "build" and w["days"] == 7:
            assert w["commutes"] >= lo
    for d in p["days"]:
        if d["commute"]:
            dt = date.fromisoformat(d["date"])
            assert ["mon", "tue", "wed", "thu", "fri", "sat", "sun"][dt.weekday()] in allowed
            assert not d["indoor"] and d["phase"] not in ("race", "openers", "base")
            assert (date(2026, 11, 7) - dt).days >= 3 or dt > date(2026, 11, 7)
            if d["phase"] == "taper":
                assert d["commute"] == "easy"
    first = next(d for d in p["days"] if d["commute"])
    assert first["legs"] and [leg["leg"] for leg in first["legs"]] == ["in", "home"] and all(leg["check"] for leg in first["legs"])
    assert days["2027-01-12"]["commute"] is None                       # no commuting through the trainer winter
    winter = season(date(2026, 10, 8), 45.0, 50.0, {**cfg, "commute": {**cfg["commute"], "winter": True}})
    assert any(d["commute"] for d in winter["days"] if d["date"].startswith("2027-01"))


def test_commute_call(cfg):
    prof = m.commute_profile([], cfg, date(2026, 10, 8))
    th = {**TH, "lthr": 165}
    thu = date(2026, 10, 8)
    planned = {"role": "commute", "commute": "workout", "commute_workout": "2 × 15 min sweet spot", "level": "hard"}
    ok = {"score": 82, "illness": False}
    assert m.commute_call(ok, planned, thu, cfg, prof, th)["verdict"] == "ride"
    assert m.commute_call({"score": 55, "illness": False}, planned, thu, cfg, prof, th)["verdict"] == "easy"
    assert m.commute_call({"score": 40, "illness": False}, planned, thu, cfg, prof, th)["verdict"] == "skip"
    assert m.commute_call({"score": 80, "illness": True}, planned, thu, cfg, prof, th)["verdict"] == "skip"
    assert m.commute_call(ok, {"role": "rest"}, thu, cfg, prof, th)["verdict"] == "skip"
    assert m.commute_call(ok, {"role": "endurance"}, thu, cfg, prof, th)["verdict"] == "optional"
    assert m.commute_call(ok, planned, date(2026, 10, 10), cfg, prof, th) is None   # Saturday: not a commute day
    assert "under 134 bpm" in m.commute_call({"score": 55, "illness": False}, planned, thu, cfg, prof, th)["detail"]


# ── the GitHub Actions sync ───────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def cloud_dir(tmp_path, monkeypatch):
    import time as _time

    from fitness import cloud
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(config, "DATA_DIR", data)
    monkeypatch.setattr(config, "DB_PATH", data / "fitness.db")
    monkeypatch.setattr(config, "STRAVA_TOKEN", data / "strava_token.json")
    for k in ("GARMIN_EMAIL", "GARMIN_PASSWORD", "STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("TZ", "UTC")
    yield cloud, data
    monkeypatch.undo()
    _time.tzset()


def test_cloud_run_writes_the_apps_two_files(tmp_path, cfg, cloud_dir):
    cloud, data = cloud_dir
    with Store(data / "fitness.db") as store:
        demo.populate(store, date(2026, 10, 8), days=120)
    out = tmp_path / "state"
    status = cloud.run(cfg, out=out, today=date(2026, 10, 8))
    saved = json.loads((out / "fitness-data.json").read_text())
    assert saved["today"] == "2026-10-08" and saved["ride"]["days"] and "ride_qr" not in saved
    assert json.loads((out / "status.json").read_text()) == status
    assert status["ok"] and status["garmin"]["days"] > 100 and status["garmin"]["last"] == "2026-10-08"
    assert status["strava"]["activities"] > 0 and not status["garmin"]["connected"] and not status["strava"]["connected"]


def test_cloud_run_reports_what_needs_doing(tmp_path, cfg, cloud_dir):
    cloud, _ = cloud_dir
    status = cloud.run(cfg, action="connect-strava", code="", out=tmp_path)
    assert not status["ok"] and "authorization code" in status["strava"]["error"]
    status = cloud.run(cfg, action="connect-garmin", out=tmp_path)
    assert "GARMIN_EMAIL" in status["garmin"]["error"] and not (tmp_path / "fitness-data.json").exists()


def test_garmin_code_comes_from_a_run_named_after_it():
    from datetime import UTC

    from fitness import cloud
    since = datetime(2026, 10, 9, 12, 0, tzinfo=UTC)
    pages = iter([
        {"workflow_runs": [{"display_title": "garmin-code 111111", "created_at": "2026-10-09T11:59:00Z"}]},   # an older attempt
        {"workflow_runs": [{"display_title": "sync", "created_at": "2026-10-09T12:01:00Z"},
                           {"display_title": "garmin-code 482913", "created_at": "2026-10-09T12:02:00Z"}]},
    ])
    asked = []
    code = cloud.wait_for_code("training.yml", since, fetch=lambda p: (asked.append(p), next(pages))[1], sleep=lambda s: None)
    assert code == "482913" and asked[0] == "/actions/workflows/training.yml/runs?event=workflow_dispatch&per_page=20"


def test_workflow_file_from_the_callers_ref(monkeypatch):
    from fitness import cloud
    monkeypatch.setenv("GITHUB_WORKFLOW_REF", "chrisrohn/training-data/.github/workflows/training.yml@refs/heads/main")
    assert cloud.workflow_file() == "training.yml"


def test_strava_errors_never_echo_the_reply():
    from fitness.strava import _problem
    assert _problem({"message": "Bad Request", "errors": [{"resource": "AuthorizationCode", "field": "code", "code": "invalid"}]}) == "Bad Request (code invalid)"
    assert "secret" not in _problem({"access_token": "secret", "refresh_token": "secret"})


def test_strava_client_secret_is_never_written_to_disk(tmp_path, monkeypatch):
    import time as _time

    from fitness import strava
    path = tmp_path / "strava_token.json"
    monkeypatch.setattr(strava, "STRAVA_TOKEN", path)
    monkeypatch.setenv("STRAVA_CLIENT_SECRET", "from-env")
    sent = []

    class Reply:
        def __init__(self, body):
            self.body = body

        def json(self):
            return self.body

    class Requests:
        @staticmethod
        def post(url, timeout, data):
            sent.append(data)
            return Reply({"access_token": "new", "refresh_token": "r2", "expires_at": _time.time() + 3600})

    monkeypatch.setattr(strava, "_requests", lambda: Requests)
    strava.exchange("4242", "from-env", "code")
    assert "client_secret" not in json.loads(path.read_text())
    path.write_text(json.dumps({"client_id": "4242", "client_secret": "legacy", "refresh_token": "r1", "expires_at": 0, "access_token": "old"}))
    assert strava._access_token() == "new"
    assert sent[-1]["client_secret"] == "from-env" and sent[-1]["grant_type"] == "refresh_token"
    assert "client_secret" not in json.loads(path.read_text())          # an older file is cleaned up on its next refresh


def test_cloud_imports_an_uploaded_strava_export_once(tmp_path, cfg, cloud_dir):
    cloud, data = cloud_dir
    inbox = tmp_path / "inbox" / "strava"
    inbox.mkdir(parents=True)
    (inbox / "activities.csv").write_text(
        'Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Max Heart Rate,Relative Effort,Elapsed Time,Moving Time,Distance,'
        'Elevation Gain,Average Heart Rate,Average Watts,Device Watts,Weighted Average Power,Commute\n'
        '77,"Nov 2, 2024, 3:00:00 PM",Iceman!,Mountain Bike Ride,7300,48.9,180,250,7300,7200,48900.5,575,163,,false,,false\n'
        '78,"Jan 9, 2025, 11:00:00 PM",Zwift - Watopia,Virtual Ride,3600,30.1,170,80,3600,3600,30100,200,140,190,true,200,false\n')
    status = cloud.run(cfg, out=tmp_path / "state", today=date(2026, 10, 8), inbox=tmp_path / "inbox")
    assert status["ok"] and status["strava"]["activities"] == 2 and status["strava"]["export"]["rows"] == 2
    assert status["strava"]["export"]["file"] == "activities.csv" and (tmp_path / "state" / "fitness-data.json").exists()
    with Store(data / "fitness.db") as store:
        acts = {a["id"]: a for a in store.activities()}
    assert acts["strava:78"]["indoor"] and acts["strava:78"]["avg_power"] == 190
    (inbox / "activities.csv").unlink()                                              # gone from the repository: still remembered
    again = cloud.run(cfg, out=tmp_path / "state", today=date(2026, 10, 8), inbox=tmp_path / "inbox")
    assert again["strava"]["export"]["rows"] == 2 and again["strava"]["activities"] == 2
