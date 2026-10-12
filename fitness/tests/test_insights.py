"""Offline tests for what's read out of the data: ride traces, the afternoon check, weather-aware bottles, the
shopping list, the weekly recap, the bedtime, readiness weighted for you, and the weight trend."""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from fitness import build, config, fuel, garmin, grocery, streams  # noqa: E402
from fitness import metrics as m  # noqa: E402
from fitness.activities import activity  # noqa: E402
from fitness.store import Store  # noqa: E402


@pytest.fixture
def cfg():
    return config.load()


def details(hr: list[float], speed: list[float], power: list[float] | None = None, every_s: int = 30) -> dict:
    """A Garmin activity-details response with one sample every `every_s` seconds."""
    keys = ["sumDuration", "directHeartRate", "directSpeed"] + (["directPower"] if power else [])
    rows = [{"metrics": [i * every_s, h, v] + ([power[i]] if power else [])} for i, (h, v) in enumerate(zip(hr, speed, strict=True))]
    return {"metricDescriptors": [{"metricsIndex": i, "key": k} for i, k in enumerate(keys)], "activityDetailMetrics": rows}


# ── ride traces ──────────────────────────────────────────────────────────────────────────────────────────

def test_ride_traces_become_a_value_a_minute_and_measure_decoupling():
    n = 2 * 100                                            # 100 minutes, a sample every 30 s
    hr = [130 + (i / n) * 12 for i in range(n)]            # heart rate creeps up 12 bpm at the same speed
    s = streams.compact(details(hr, [8.0] * n))
    assert len(s["hr"]) == 100 and s["p"] is None and s["v"][0] == 8.0
    d = streams.decoupling(s)
    assert d["by"] == "speed" and 3 < d["pct"] < 8 and d["minutes"] == 100
    steady = streams.decoupling(streams.compact(details([140] * n, [8.0] * n, power=[180] * n)))
    assert steady["by"] == "power" and steady["pct"] == 0.0
    intervals = streams.compact(details([150] * n, [3.0 if (i // 10) % 2 else 12.0 for i in range(n)]))
    assert streams.decoupling(intervals) is None                                       # stop-start: not a steady ride
    assert streams.decoupling(streams.compact(details([140] * 80, [8.0] * 80))) is None   # 40 minutes: too short
    assert streams.minutes_at(s, 140) == sum(1 for h in s["hr"] if h >= 140)
    assert streams.compact({"metricDescriptors": [], "activityDetailMetrics": []}) is None


def test_this_weeks_hard_sessions_against_their_targets(cfg):
    today = date(2026, 10, 15)
    tue, thu = date(2026, 10, 13), date(2026, 10, 14)
    work = [{"name": "Threshold", "min": 12, "zone": "thr", "lo": 95, "hi": 100}] * 3
    planned = {tue: {"title": "Key session", "steps": [{"name": "Warm-up", "min": 15, "zone": "z2", "lo": 81, "hi": 89}, *work]},
               thu: {"title": "Commute + workout", "legs": [{"steps": [{"name": "In", "min": 60, "zone": "z1", "lo": 0, "hi": 81}]},
                                                             {"steps": work[:2]}]}}
    acts = [activity(id="garmin:1", source="garmin", start=datetime(2026, 10, 13, 18), kind="road_biking", duration_s=5400),
            activity(id="garmin:2", source="garmin", start=datetime(2026, 10, 14, 16), kind="road_biking", duration_s=4000)]
    th = {"lthr": 160}
    traces = {"garmin:1": json.dumps({"hr": [130] * 20 + [155] * 30 + [130] * 40, "v": [8] * 90, "p": None}),   # 30 of 36 min at 150+
              "garmin:2": json.dumps({"hr": [125] * 60 + [140] * 20, "v": [8] * 80, "p": None})}                # 0 of 24
    r = build._inside_rides(acts, traces, th, {"planned": planned}, today)
    by = {x["date"]: x for x in r["sessions"]}
    assert by["2026-10-13"]["expected"] == 36 and by["2026-10-13"]["actual"] == 30 and by["2026-10-13"]["pct"] == 83 and by["2026-10-13"]["bpm"] == 150
    assert by["2026-10-14"]["pct"] == 0 and r["hint"] is None                     # one miss is a bad day, not a wrong threshold
    low = {**traces, "garmin:1": json.dumps({"hr": [130] * 90, "v": [8] * 90, "p": None})}
    assert "threshold heart rate (160 bpm)" in build._inside_rides(acts, low, th, {"planned": planned}, today)["hint"]
    assert build._inside_rides(acts, None, th, {"planned": planned}, today) is None


def test_garmin_fetches_traces_and_weigh_ins_without_asking_twice(tmp_path):
    class Client:
        calls = 0

        def get_activity_details(self, aid, maxchart, maxpoly):
            Client.calls += 1
            return details([140] * 240, [8.0] * 240)

        def get_body_composition(self, start, end):
            return {"dateWeightList": [{"calendarDate": "2026-10-01", "weight": 84500.0}, {"calendarDate": "2026-10-08", "weight": 84100.0}]}

    with Store(tmp_path / "s.db") as store:
        for i in range(3):
            a = activity(id=f"garmin:{i}", source="garmin", start=datetime(2026, 10, 1 + i, 7), kind="road_biking", duration_s=3600)
            store.put_activity(a)
        garmin._streams(Client(), store, date(2026, 10, 9))
        garmin._streams(Client(), store, date(2026, 10, 9))
        assert Client.calls == 3 and len(store.prefixed("stream:")) == 3
        garmin._weigh_ins(Client(), store, date(2026, 10, 9))
        assert json.loads(store.get("weigh_ins")) == [["2026-10-01", 84.5], ["2026-10-08", 84.1]]


# ── the afternoon's ride-home check ──────────────────────────────────────────────────────────────────────

def test_the_afternoon_check_eases_a_workout_home_on_a_drained_day():
    call = {"verdict": "ride", "title": "Ride in easy, workout on the way home", "detail": "Home: 2 × 15 min sweet spot."}
    plan_today = {"commute": "workout"}
    at = datetime(2026, 10, 13, 15, 0)
    eased = m.ride_home(call, {"bb_now": 22, "stress": 41}, plan_today, at, "16:35")
    assert eased["verdict"] == "easy" and eased["title"] == "Ride home easy" and "Body Battery is down to 22" in eased["detail"]
    fine = m.ride_home(call, {"bb_now": 55, "stress": 30}, plan_today, at, "16:35")
    assert fine["verdict"] == "ride" and "the ride home stands" in fine["detail"]
    assert m.ride_home(call, {"bb_now": 10}, plan_today, datetime(2026, 10, 13, 9), "16:35") == call         # still morning
    assert m.ride_home(call, {"bb_now": 10}, plan_today, datetime(2026, 10, 13, 18), "16:35") == call        # already home
    stressed = m.ride_home(call, {"bb_now": 40, "stress": 55, "stress_high_s": 9000}, plan_today, at, "16:35")
    assert "today's stress has averaged 55" in stressed["detail"] and "2.5 h of high stress" in stressed["detail"]
    storm = m.ride_home({"verdict": "skip", "weather": True, "title": "Leave the bike at home", "detail": "Thunderstorms on the ride home."},
                        {}, plan_today, at, "16:35")
    assert storm["title"].startswith("Storms on the ride home") and "leave the bike at work" in storm["detail"]


# ── bottles for the weather ──────────────────────────────────────────────────────────────────────────────

def test_the_bottles_follow_the_temperature():
    drink = fuel.RIDE_FUEL
    hot = fuel.bottles(180, 75, drink, 2, 2, temp_c=31)
    assert hot["climate"].startswith("Hot (88°F)") and "800 mg" in hot["climate"] and "from the bladder" in hot["climate"]
    warm = fuel.bottles(180, 75, drink, 2, 0, temp_c=25, units="metric")
    assert warm["climate"].startswith("Hot (25°C)") and "600 mg" in warm["climate"] and "refill" in warm["climate"]
    cold = fuel.bottles(180, 75, drink, 2, 0, temp_c=2)
    assert cold["climate"].startswith("Cold (36°F)") and "insulated" in cold["climate"]
    assert fuel.bottles(180, 75, drink, 2, 0, temp_c=15)["climate"] == "" and fuel.bottles(180, 75, drink)["climate"] == ""


# ── the shopping list ────────────────────────────────────────────────────────────────────────────────────

def test_the_shopping_list_scales_your_recipes(cfg):
    days = [{"date": (date(2026, 10, 12) + timedelta(days=i)).isoformat(),
             "meals": [{"recipe": "pudding"}] + ([{"recipe": "veggie"}] if i < 5 else [])} for i in range(7)]
    k = grocery.week(days, cfg, date(2026, 10, 12))
    assert k["pudding"] == 7 and k["veggie"] == 5 and k["veggie_days"] == ["Mon", "Tue", "Wed", "Thu", "Fri"]
    buy = {b["item"]: b["amount"] for b in k["buy"]}
    assert buy["Westbrae organic black lentils (15 oz can)"] == "3 cans" and buy["Limes"] == "3 limes"
    assert buy["Frozen broccoli"].startswith("2.8 lb") and "4 × 12 oz bags" in buy["Frozen broccoli"]
    check = {c["item"]: c["amount"] for c in k["check"]}
    assert check["Chia seeds"].startswith("14 tbsp") and check["Bovine collagen peptides"] == "84 g" and check["Optimum Nutrition Gold Standard whey"] == "7 scoops"
    assert "Pudding jars (7)" in k["prep"][0] and "dressing for 5" in k["prep"][1]
    chicken = grocery.week([{**d, "meals": [{"recipe": "veggie_chicken"}]} for d in days[:2]], cfg, date(2026, 10, 12))
    assert chicken["chicken"] and {b["item"] for b in chicken["buy"]} >= {"Cooked chicken, shredded"} and not any("lentils" in b["item"] for b in chicken["buy"])
    assert grocery.week([{"date": "2026-10-12", "meals": []}], cfg, date(2026, 10, 12)) is None


def test_the_fuel_plan_carries_a_week_of_kitchen(cfg):
    from fitness.plan import season
    plan = season(date(2026, 10, 10), 40, 40, cfg)
    k = fuel.plan(plan["days"], date(2026, 10, 10), cfg, 84, {"height_cm": 180, "birth_year": 1980})["kitchen"]
    assert k["from"] == "2026-10-11" and k["to"] == "2026-10-17" and k["pudding"] >= 5 and k["buy"]


# ── the weekly recap, the bedtime, readiness weighted for you, weight ───────────────────────────────────

def test_the_weekly_recap_goes_sunday_evening_once(tmp_path):
    from cryptography.hazmat.primitives.asymmetric import ec
    from fitness import cloud, webpush
    raw = webpush._raw(ec.generate_private_key(ec.SECP256R1()).public_key())
    sub = {"endpoint": "https://fcm.googleapis.com/fcm/send/x", "keys": {"p256dh": webpush.b64u(raw), "auth": webpush.b64u(b"0123456789abcdef")}}
    data = {"today": "2026-10-18", "now": {"readiness": None, "last_night": None, "recommendation": {"title": "Rest", "detail": "Off the bike."}},
            "recap": {"week": "2026-10-12", "title": "Your week: 7.4 h ridden of 8.1 planned", "body": "5 rides, 2 commute days · Fitness 34 → 37."}}
    sent = []
    with Store(tmp_path / "s.db") as store:
        store.set("push_subs", json.dumps([sub]))
        cloud.notify(store, data, datetime(2026, 10, 18, 16, 0), "sync", lambda s, msg, k: sent.append(msg) or 201)
        cloud.notify(store, data, datetime(2026, 10, 18, 18, 0), "sync", lambda s, msg, k: sent.append(msg) or 201)
        cloud.notify(store, data, datetime(2026, 10, 18, 19, 0), "sync", lambda s, msg, k: sent.append(msg) or 201)
    assert [x["title"] for x in sent] == ["Your week: 7.4 h ridden of 8.1 planned"] and sent[0]["tag"] == "recap"


def test_recap_bedtime_and_weight_trend_from_a_built_week(cfg):
    from fitness.plan import season
    today = date(2026, 10, 18)
    plan = season(today, 40, 40, cfg)
    acts = [activity(id="a", source="garmin", start=datetime(2026, 10, 14, 7), kind="road_biking", duration_s=4000, distance_m=30000, commute=True)]
    r = build._recap(acts, {"2026-10-11": {"ctl": 34.2}, "2026-10-18": {"ctl": 37.1}}, {"planned": {}}, plan, today)
    assert r["title"] == "Your week: 1.1 h ridden" and "Fitness 34 → 37" in r["body"] and r["body"].count("Next week:") == 1

    days = {}
    for i in range(1, 30):
        d = today - timedelta(days=i)
        days[d.isoformat()] = {"sleep": {"start": f"{(d - timedelta(days=1)).isoformat()}T22:30", "end": f"{d.isoformat()}T{'06:00' if d.weekday() < 5 else '07:30'}"}}
    route = {"depart": {"in": "07:05", "home": "16:35"}}
    bed = build._bedtime(days, 8.0, 1.0, plan, today, cfg, route)            # tomorrow, Monday, is a work day
    assert bed["wake"] == "6:00 AM" and bed["workday"]
    assert bed["bed"] in ("9:45 PM", "9:30 PM")                             # 8 h + 15 min, 15 earlier before a hard day
    tired = build._bedtime(days, 8.0, 4.0, plan, today, cfg, route)
    assert "of sleep debt" in " ".join(tired["reasons"])
    assert build._bedtime({}, 8.0, None, plan, today, cfg, route) is None

    weigh = [[(today - timedelta(days=d)).isoformat(), 85.5 - 0.05 * (40 - d)] for d in range(40, -1, -4)]
    t = build._weight_trend(weigh, today)
    assert 83.5 < t["kg"] < 84.2 and t["change_4w"] < 0 and t["count"] == 11       # the 10-day average lags a falling weight
    assert build._weight_trend([["2026-08-01", 85.0]], today) is None              # nothing recent: use the profile


def test_readiness_learns_which_markers_predict_your_good_days():
    ready, acts = {}, []
    start = date(2026, 6, 1)
    for i in range(40):
        d = start + timedelta(days=i * 2)
        good = (i % 5) - 2                                             # -2..2
        ready[d.isoformat()] = {"z": {"rhr": -good * 0.8, "sleep_stress": (i % 3) - 1.0, "resp": 0.1}, "components": {"sleep": 70 + (i % 4)}}
        speed = 27 + good * 0.6                                         # low resting HR mornings ride faster for the same HR
        for leg, hour in (("in", 7), ("home", 17)):
            a = activity(id=f"{leg}{i}", source="garmin", start=datetime.combine(d, datetime.min.time()).replace(hour=hour), kind="road_biking",
                         duration_s=30 / speed * 3600, distance_m=30000, avg_hr=140, commute=True)
            a["leg"] = leg
            acts.append(a)
    p = m.personal_weights(ready, acts)
    assert p["best"] == "rhr" and p["rho"]["rhr"] > 0.9 and p["weights"]["rhr"] > m.BASE_WEIGHTS["rhr"]
    assert abs(sum(p["weights"].values()) - sum(m.BASE_WEIGHTS.values())) < 0.01
    assert m.personal_weights(dict(list(ready.items())[:10]), acts) is None        # 10 mornings: too few to learn from
