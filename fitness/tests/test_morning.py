"""Offline tests for the morning call's newer parts: a week that knows what's already ridden, the weather, the
notification, the bike's upkeep and the race-day page. Nothing here touches the network."""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from fitness import bike, build, config, demo, raceday, webpush  # noqa: E402
from fitness import metrics as m  # noqa: E402
from fitness import weather as wxm  # noqa: E402
from fitness.activities import activity  # noqa: E402
from fitness.plan import adapt, season  # noqa: E402
from fitness.store import Store  # noqa: E402

HOME, WORK = (42.300, -85.600), (42.300, -85.240)          # a made-up flat 30 km commute due east


@pytest.fixture
def cfg():
    return config.load()


def forecast(start: date, days: int = 20, rain: set[str] | None = None, temp: float = 12.0, wind: float = 15.0, wind_from: float = 90.0,
             storm: set[str] | None = None) -> dict:
    """An Open-Meteo-shaped response: `rain` / `storm` are "YYYY-MM-DDTHH" hours with 2 mm of rain / a thunderstorm."""
    rain, storm = rain or set(), storm or set()
    times, h = [], {k: [] for k in wxm.HOURLY}
    for i in range(days * 24):
        t = datetime.combine(start, datetime.min.time()) + timedelta(hours=i)
        key = t.strftime("%Y-%m-%dT%H")
        times.append(t.strftime("%Y-%m-%dT%H:00"))
        wet, bang = key in rain, key in storm
        h["temperature_2m"].append(temp)
        h["apparent_temperature"].append(temp - 2)
        h["precipitation"].append(2.0 if wet or bang else 0.0)
        h["precipitation_probability"].append(90 if wet or bang else 5)
        h["weather_code"].append(95 if bang else 63 if wet else 1)
        h["wind_speed_10m"].append(wind)
        h["wind_direction_10m"].append(wind_from)
        h["wind_gusts_10m"].append(wind * 1.5)
    dates = [(start + timedelta(days=i)).isoformat() for i in range(days)]
    daily = {"time": dates, "sunrise": [f"{d}T07:45" for d in dates], "sunset": [f"{d}T19:05" for d in dates],
             "temperature_2m_max": [temp + 3] * days, "temperature_2m_min": [temp - 4] * days, "weather_code": [1] * days,
             "precipitation_sum": [sum(2.0 for k in rain | storm if k.startswith(d)) for d in dates],
             "precipitation_probability_max": [90 if any(k.startswith(d) for k in rain | storm) else 5 for d in dates], "wind_speed_10m_max": [wind] * days}
    return {"hourly": {"time": times, **h}, "daily": daily}


# ── the week knows what's already ridden ─────────────────────────────────────────────────────────────────

def test_a_big_start_to_the_week_trims_the_rest_of_it(cfg):
    fri = date(2026, 10, 9)
    fresh = season(fri, 40, 40, cfg)["days"][:3]
    a = {"roles": {}, "no_commute": set(), "commutes_done": 0, "week_done": 600}
    tired = season(fri, 40, 40, cfg, adapt=a)["days"][:3]
    assert a["week_scale"] < 1 and sum(d["load"] for d in tired) < sum(d["load"] for d in fresh)
    light = {"roles": {}, "no_commute": set(), "commutes_done": 0, "week_done": 10}
    assert [d["load"] for d in season(fri, 40, 40, cfg, adapt=light)["days"][:3]] == [d["load"] for d in fresh]   # nothing crammed in
    assert "week_scale" not in light


# ── weather ──────────────────────────────────────────────────────────────────────────────────────────────

def test_weather_reads_a_ride_window():
    d = date(2026, 10, 13)
    wx = wxm.Wx(forecast(d, rain={"2026-10-13T17"}))
    morning = wx.window(datetime(2026, 10, 13, 7, 0), 68, heading=90)
    assert morning["verdict"] == "dry" and morning["head"] == 15 and morning["dark"]          # wind from the east, riding east; before sunrise
    evening = wx.window(datetime(2026, 10, 13, 16, 40), 72, heading=270)
    assert evening["verdict"] == "wet" and evening["head"] == -15 and not evening["dark"]
    assert wxm.describe(morning, "imperial").startswith("54°F, dry, wind 9 mph E (a headwind)")
    assert "rain jacket" in wxm.kit(evening["feels"], True) and wxm.kit(25, False) == "Short sleeves and shorts"
    assert wxm.verdict({**morning, "gust": 70}) == "storm" and wxm.verdict({**morning, "temp_min": 0, "rain_mm": 0.5}) == "ice"
    best = wxm.best_window(wx, d, 90, datetime(2026, 10, 13, 15))
    assert best["verdict"] == "dry" and best["start"] == "2026-10-13T18:00" or best["start"] < "2026-10-13T16:00"
    assert wx.rain_day(d) is False and wxm.Wx(forecast(d, rain={f"2026-10-13T{h:02d}" for h in range(9, 13)})).rain_day(d)


def test_weather_finds_the_commute_from_the_rides_and_caches_the_fetch(cfg, tmp_path):
    tue = date(2026, 9, 15)
    acts = []
    for w in range(4):
        day = tue + timedelta(weeks=w)
        acts += [activity(id=f"i{w}", source="garmin", start=datetime.combine(day, datetime.min.time()).replace(hour=7, minute=5), kind="road_biking",
                          duration_s=4000, distance_m=30000, start_ll=list(HOME), end_ll=list(WORK)),
                 activity(id=f"h{w}", source="garmin", start=datetime.combine(day, datetime.min.time()).replace(hour=16, minute=35), kind="road_biking",
                          duration_s=4300, distance_m=30000, start_ll=list(WORK), end_ll=list(HOME))]
    m.mark_commutes(acts, cfg)
    r = wxm.route(acts, cfg, date(2026, 10, 9))
    assert r["home"] == HOME and r["work"] == WORK and 85 < r["bearing_in"] < 95 and r["depart"] == {"in": "07:05", "home": "16:35"}
    calls = []
    get = lambda url: calls.append(url) or forecast(date(2026, 10, 9))   # noqa: E731
    with Store(tmp_path / "s.db") as store:
        now = datetime(2026, 10, 9, 6, 0)
        assert wxm.load(store, r["where"], "America/Detroit", now, get) and wxm.load(store, r["where"], "America/Detroit", now + timedelta(minutes=20), get)
        assert len(calls) == 1 and "latitude=42.3" in calls[0] and "past_days=31" in calls[0]
        def down(url):
            raise OSError("offline")
        assert wxm.load(store, r["where"], "America/Detroit", now + timedelta(hours=2), down)   # the last forecast, not nothing
    assert wxm.route([], {**cfg, "weather": {"lat": 1.5, "lon": 2.5}}, date(2026, 10, 9))["where"] == (1.5, 2.5)


def test_the_commute_call_reads_the_weather(cfg):
    prof = {"legs": {"in": {"minutes": 68, "load": 65}, "home": {"minutes": 72, "load": 63}}, "climb_m": [10, 50]}
    th = {"lthr": 160}
    tue = date(2026, 10, 13)
    planned = {"role": "commute", "commute": "workout", "commute_workout": "2 × 15 min sweet spot", "phase": "build", "level": "hard"}
    ready = {"score": 80, "illness": False}
    wx = wxm.Wx(forecast(tue, wind=30, wind_from=270))
    legs = {"in": wx.window(datetime(2026, 10, 13, 7), 68, 90), "home": wx.window(datetime(2026, 10, 13, 16, 35), 72, 270), "sun": ["7:45", "7:05"]}
    call = m.commute_call(ready, planned, tue, cfg, prof, th, wx=legs)
    assert call["verdict"] == "ride" and "lights" in call["weather"] and "Headwind home" in call["weather"]["wind"] and "intervals into it" in call["weather"]["wind"]
    stormy = wxm.Wx(forecast(tue, storm={"2026-10-13T17"}))
    s = m.commute_call(ready, planned, tue, cfg, prof, th, wx={"in": stormy.window(datetime(2026, 10, 13, 7), 68), "home": stormy.window(datetime(2026, 10, 13, 16, 35), 72)})
    assert s["verdict"] == "skip" and s["weather"] and "ride home" in s["detail"]
    rainy = wxm.Wx(forecast(tue, rain={"2026-10-13T16", "2026-10-13T17"}))
    r = m.commute_call(ready, planned, tue, cfg, prof, th, wx={"in": rainy.window(datetime(2026, 10, 13, 7), 68), "home": rainy.window(datetime(2026, 10, 13, 16, 35), 72)})
    assert r["verdict"] == "wet" and "your call" in r["title"] and "rain jacket" in r["weather"]["kit"]


def test_the_planner_keeps_commutes_and_long_rides_dry(cfg):
    mon = date(2026, 10, 12)
    c = {**cfg, "commute": {**cfg["commute"], "per_week": [1, 2], "days": ["tue", "thu", "wed"]}}
    dry = [d["date"] for d in season(mon, 50, 50, c)["days"][:7] if d["commute"]]
    assert "2026-10-13" in dry
    wet = {**c, "forecast": {"2026-10-13": {"rain_day": True, "commute_wet": True}}}
    assert "2026-10-13" not in [d["date"] for d in season(mon, 50, 50, wet)["days"][:7] if d["commute"]]
    state = {(mon - timedelta(days=i)).isoformat(): {"ctl": 50.0, "atl": 50.0} for i in range(1, 4)}
    fc = {(mon + timedelta(days=i)).isoformat(): {"rain_day": i == 5} for i in range(7)}            # rain Saturday only
    a = adapt(date(2026, 10, 15), 8, {**cfg, "forecast": fc}, {}, set(), state)
    assert a["roles"].get(date(2026, 10, 18)) == "long" and any("long ride moves to Sunday" in n for n in a["notes"])


def test_the_build_puts_the_weather_on_today_and_the_week(cfg):
    today = date(2026, 10, 8)
    with Store(Path(":memory:")) as store:
        demo.populate(store, today, days=120)
        days, acts = store.days(), store.activities()
    acts = [{**a, "start_ll": list(HOME), "end_ll": list(WORK)} if a.get("group") == "ride" and not a.get("indoor") else a for a in acts]
    data = build.assemble(cfg, days, acts, today, weather=forecast(today - timedelta(days=31), days=47), now=datetime(2026, 10, 8, 6))
    assert data["now"]["weather"]["summary"].endswith("mph") and all(d["wx"] for d in data["plan"]["days"][:7])
    phone = json.dumps(build.phone_data(data))
    assert "42.3" not in phone and "-85.6" not in phone                                    # where you live never reaches the phone


# ── the morning notification ─────────────────────────────────────────────────────────────────────────────

def test_web_push_encryption_matches_rfc_8291():
    from cryptography.hazmat.primitives.asymmetric import ec
    server = ec.derive_private_key(int.from_bytes(webpush.unb64u("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), "big"), ec.SECP256R1())
    out = webpush.encrypt(b"When I grow up, I want to be a watermelon",
                          "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
                          "BTBZMqHH6r4Tts7J_aSIgg", salt=webpush.unb64u("DGv6ra1nlYgDCS1FRnbzlw"), server=server)
    assert webpush.b64u(out) == ("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_y"
                                 "l95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN")


def test_vapid_signs_for_the_push_service():
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
    keys = webpush.new_keys()
    header = webpush.vapid("https://fcm.googleapis.com/fcm/send/abc", keys["private"], now=1_800_000_000)
    token, k = header.removeprefix("vapid t=").split(", k=")
    head, claims, sig = token.split(".")
    assert k == keys["public"] and json.loads(webpush.unb64u(claims)) == {"aud": "https://fcm.googleapis.com", "exp": 1_800_043_200, "sub": webpush.CONTACT}
    pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), webpush.unb64u(k))
    raw = webpush.unb64u(sig)
    pub.verify(encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")), f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))


def _sub(n: int = 1) -> dict:
    from cryptography.hazmat.primitives.asymmetric import ec
    pub = ec.generate_private_key(ec.SECP256R1()).public_key()
    raw = webpush._raw(pub)
    return {"endpoint": f"https://fcm.googleapis.com/fcm/send/device{n}", "keys": {"p256dh": webpush.b64u(raw), "auth": webpush.b64u(b"0123456789abcdef")}}


def test_the_morning_notification_goes_once_then_once_more_if_the_call_changes(tmp_path):
    from fitness import cloud
    data = {"today": "2026-10-09", "now": {"readiness": {"score": 78}, "last_night": {"total": 27000}, "weather": {"summary": "41°F to 58°F, dry"},
                                          "recommendation": {"title": "Commute + workout", "detail": "In: easy. Home: 2 × 15 min sweet spot."}}}
    sent = []
    send = lambda sub, msg, key: sent.append((sub["endpoint"], msg)) or 201   # noqa: E731
    with Store(tmp_path / "s.db") as store:
        cloud.subscribe(store, webpush.b64u(json.dumps(_sub()).encode()))
        with pytest.raises(ValueError):
            cloud.subscribe(store, webpush.b64u(json.dumps({"endpoint": "http://x"}).encode()))
        assert cloud.notify(store, data, datetime(2026, 10, 9, 4, 30), "sync", send)["devices"] == 1 and not sent     # before 5
        cloud.notify(store, data, datetime(2026, 10, 9, 6, 15), "sync", send)
        cloud.notify(store, data, datetime(2026, 10, 9, 7, 15), "sync", send)
        assert len(sent) == 1 and sent[0][1]["title"] == "Commute + workout" and sent[0][1]["body"].startswith("Readiness 78 · 41°F")
        changed = {**data, "now": {**data["now"], "recommendation": {"title": "Leave the bike at home", "detail": "Thunderstorms on the ride home."}}}
        cloud.notify(store, changed, datetime(2026, 10, 9, 11, 0), "sync", send)
        cloud.notify(store, changed, datetime(2026, 10, 9, 12, 0), "sync", send)
        assert len(sent) == 2 and sent[1][1]["title"] == "Update · Leave the bike at home"
        status = cloud.notify(store, data, datetime(2026, 10, 9, 20, 0), "push-test", lambda *a: 410)
        assert status["devices"] == 0                                                       # the browser dropped it
    assert cloud.message(data, test=True)["title"].startswith("Test · ")


# ── the bike ─────────────────────────────────────────────────────────────────────────────────────────────

def _ride(day: date, hour: int, miles: float, indoor: bool = False) -> dict:
    return activity(id=f"r{day}{hour}", source="garmin", start=datetime.combine(day, datetime.min.time()).replace(hour=hour), kind="indoor_cycling" if indoor else "gravel_cycling",
                    duration_s=miles / 16 * 3600, distance_m=miles * 1609.344, trainer=indoor)


def test_bike_upkeep_counts_the_riding_since_each_job(cfg, tmp_path):
    today = date(2026, 10, 9)
    acts = [_ride(date(2026, 10, 1), 9, 60), _ride(date(2026, 10, 3), 9, 80), _ride(date(2026, 10, 5), 18, 70, indoor=True)]
    with Store(tmp_path / "s.db") as store:
        st = bike.state(store, date(2026, 9, 30))
        assert st["since"] == "2026-09-30"
        assert bike.log(store, "pressure:gravel:28/30", datetime(2026, 9, 30, 20), 84.0) == "gravel pressures 28/30 psi"
        with pytest.raises(ValueError):
            bike.log(store, "pressure:gravel:280/30", datetime(2026, 9, 30, 20), 84.0)
        st = bike.state(store)
    up = bike.upkeep(acts, st, cfg, today, None, 86.5, [])
    by = {i["key"]: i for i in up["items"]}
    assert by["drip"]["status"] == "due" and by["drip"]["used"] == "210 of 200 mi"          # trainer miles count for the chain
    assert by["tires"]["used"].startswith("140 of 750 mi") and by["sealant"]["used"] == "9 of 90 days"
    assert any("2.5 kg more" in n for n in up["pressure_notes"]) and up["silca"]["system_lb"] == round((86.5 + 8.4 + 2.5) * 2.20462)
    with Store(tmp_path / "s.db") as store:
        bike.log(store, "drip", datetime(2026, 10, 4, 20), 86.5)
        st = bike.state(store)
    assert {i["key"]: i for i in bike.upkeep(acts, st, cfg, today, None, 86.5, [])["items"]}["drip"]["used"] == "70 of 200 mi"
    wet = wxm.Wx(forecast(date(2026, 9, 25), rain={"2026-10-03T09"}))
    st2 = {**st, "done": {}}
    assert {i["key"]: i for i in bike.upkeep(acts, st2, cfg, today, wet, 86.5, [])["items"]}["drip"]["why"] == "a wet ride on Sat Oct 3"


# ── race day ─────────────────────────────────────────────────────────────────────────────────────────────

def test_race_day_page(cfg):
    today = date(2026, 10, 9)
    plan = season(today, 40, 40, cfg)
    up = bike.upkeep([], {"since": "2026-10-01", "pressure": {bike._race_key(plan["races"][0]["name"]): {"front": 24, "rear": 26, "at": "2026-10-01T20:00", "weight_kg": 84}}},
                     cfg, today, None, 84, plan["races"])
    wx = wxm.Wx(forecast(date(2026, 10, 25), days=16, temp=2))
    pages = raceday.pages(plan, cfg, wx, {"lthr": 160}, 84, up, today)
    iceman = pages[0]
    assert iceman["name"].startswith("Bell's Iceman") and len(pages) == 1                    # Barry is months away
    assert iceman["timeline"][0]["at"] == "6:30 AM" and iceman["timeline"][-1]["at"] == "10:00 AM" and not iceman["start_set"]
    assert "Not the Nutty Pudding" in iceman["timeline"][1]["what"] and "210 g" in iceman["timeline"][1]["what"]
    assert "147–155 bpm" in iceman["strategy"] and iceman["fuel"]["rate"] >= 60
    assert iceman["forecast"]["warm"] and "Winter" in iceman["forecast"]["kit"] or "Thermal" in iceman["forecast"]["kit"]
    assert any(b["job"].startswith("Tire pressure: 24 front / 26 rear") and b["ok"] for b in iceman["bike"])
    assert iceman["sessions_left"] and all(s["date"] < iceman["date"] for s in iceman["sessions_left"])


def test_ride_mode_carries_a_day_and_a_half_of_hourly_weather(cfg):
    wx = wxm.Wx(forecast(date(2026, 10, 9), days=3, wind=18, wind_from=250))
    rows = build._ride_wx(wx, datetime(2026, 10, 9, 6, 40))
    assert len(rows) == 36 and rows[0] == ["2026-10-09T06:00", 12.0, 10.0, 18, 250, 27, 5]
    assert build.ride_config(cfg, {"lthr": 160, "max_hr": 185, "rest_hr": 50, "sex": "male"}, None)["wx"] is None
