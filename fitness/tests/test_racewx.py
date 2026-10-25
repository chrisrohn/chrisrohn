"""Race-day conditions: the venue forecast, the trail, every case on the Cube, the pressures and the race notices."""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from fitness import bike, build, cloud, config, raceday, racewx, webpush  # noqa: E402
from fitness import weather as wxm  # noqa: E402
from fitness.plan import season  # noqa: E402
from fitness.store import Store  # noqa: E402

GUN = datetime(2026, 11, 7, 9, 24)


@pytest.fixture(scope="module")
def cfg():
    return config.load()


def openmeteo(start: date, days: int = 16, temp=lambda t: 5.0, rain=lambda t: 0.0, code=lambda t: 1, wind: float = 12.0,
              wind_from: float = 270.0) -> dict:
    """An Open-Meteo-shaped response; temp / rain / code are functions of the local hour."""
    h, times = {k: [] for k in wxm.HOURLY}, []
    for i in range(days * 24):
        t = datetime.combine(start, datetime.min.time()) + timedelta(hours=i)
        times.append(t.strftime("%Y-%m-%dT%H:00"))
        h["temperature_2m"].append(temp(t))
        h["apparent_temperature"].append(temp(t) - 3)
        h["precipitation"].append(rain(t))
        h["precipitation_probability"].append(90 if rain(t) else 5)
        h["weather_code"].append(code(t) if not rain(t) or code(t) != 1 else 63)
        h["wind_speed_10m"].append(wind)
        h["wind_direction_10m"].append(wind_from)
        h["wind_gusts_10m"].append(wind * 1.5)
    dates = [(start + timedelta(days=i)).isoformat() for i in range(days)]
    daily = {"time": dates, "sunrise": [f"{d}T07:20" for d in dates], "sunset": [f"{d}T17:15" for d in dates],
             "temperature_2m_max": [8.0] * days, "temperature_2m_min": [0.0] * days, "weather_code": [1] * days,
             "precipitation_sum": [0.0] * days, "precipitation_probability_max": [5] * days, "wind_speed_10m_max": [wind] * days}
    return {"hourly": {"time": times, **h}, "daily": daily}


def advise(raw: dict, silca=None, heading=None) -> dict:
    return racewx.advise(start_wx=wxm.Wx(raw), finish_wx=None, gun=GUN, minutes=144, heading=heading, silca=silca, units="imperial",
                         kind="mtb", where="venue")


def test_race_time_comes_from_past_editions_not_the_ride_back():
    eds = [{"date": "2023-11-04", "moving_s": 8561, "elapsed_s": 8799}, {"date": "2024-11-02", "moving_s": 8516, "elapsed_s": 8516}]
    took = racewx.expected(eds, 2.25)
    assert took["minutes"] == 144 and took["history"] and "2:22 in 2024" in took["from"] and "2:27 in 2023" in took["from"]
    assert racewx.expected([], 2.25) == {"minutes": 135, "from": "your estimate in config.toml", "history": False, "scaled": False}


def test_editions_keep_the_race_and_drop_the_same_day_ride_back(cfg):
    from fitness.activities import activity
    race = activity(id="strava:1", source="strava", start=datetime(2024, 11, 2, 9, 54), kind="ride", name="ICEMAN",
                    duration_s=8516, distance_m=51451)
    back = activity(id="strava:2", source="strava", start=datetime(2024, 11, 2, 12, 19), kind="ride",
                    name="Post Iceman: Timber Ridge to Kalkaska", duration_s=5380, moving_s=5101, distance_m=30056)
    data = build.assemble(cfg, {}, [race, back], date(2026, 10, 20))
    eds = data["editions"]["Bell's Iceman Cometh Challenge"]
    assert [(e["date"], e["name"], e["elapsed_s"]) for e in eds] == [("2024-11-02", "ICEMAN", 8516)]


@pytest.mark.parametrize("weather, picks, trail", [
    ({}, ["sand"], "dry"),                                                                                 # dry week: loose sand
    ({"rain": lambda t: 0.5 if t.date() == date(2026, 11, 6) and t.hour < 12 else 0.0}, ["tacky"], "damp"),
    ({"rain": lambda t: 1.5 if t.date() == date(2026, 11, 6) else 0.0}, ["mud"], "soaked"),                # 36 mm the day before
    ({"rain": lambda t: 1.0 if t.date() == date(2026, 11, 7) else 0.0}, ["cold_wet", "rain"], "damp"),     # raining at 5 °C
    ({"temp": lambda t: -6.0 if t.hour < 9 else -3.0}, ["frozen", "freezing"], "frozen"),
    ({"temp": lambda t: -1.0, "rain": lambda t: 0.3 if t.date() >= date(2026, 11, 6) else 0.0, "code": lambda t: 73},
     ["snow", "cold_wet", "freezing"], "snow"),
    ({"temp": lambda t: 0.0, "rain": lambda t: 0.5 if t.date() == date(2026, 11, 7) else 0.0, "code": lambda t: 66},
     ["ice", "rain", "cold_wet"], "damp"),
    ({"temp": lambda t: 2.0, "rain": lambda t: 0.8 if t.date() == date(2026, 11, 7) else 0.0}, ["rain", "cold_wet"], "damp"),
    ({"temp": lambda t: 19.0}, ["sand", "warm"], "dry"),
    ({"code": lambda t: 95 if t.date() == date(2026, 11, 7) and t.hour == 10 else 1}, ["storm", "sand"], "dry"),
])
def test_the_forecast_picks_its_cases(weather, picks, trail):
    c = advise(openmeteo(date(2026, 11, 1), 10, **weather))
    assert c["trail"]["state"] == trail
    assert set(picks) <= set(c["picked"]), c["picked"]
    assert not ({"sand", "tacky"} & set(c["picked"]) and {"rain", "mud", "snow", "ice", "frozen"} & set(c["picked"]))
    assert "ice" not in c["picked"] or trail != "snow"
    assert "ice" not in c["picked"] or c["race_w"]["temp_min"] <= 0
    assert c["picked"] == [k for k in racewx.ORDER if k in c["picked"]]                                    # most serious first
    assert c["wear"][0].startswith("Racing") and any(x.startswith("At the finish") for x in c["wear"])
    assert c["bike"][0].startswith("Tire pressure: Run Silca's calculator")


def test_windy_head_and_tail_along_the_course():
    heading = wxm.bearing((44.73, -85.18), (44.72, -85.52))                                                 # Kalkaska → Traverse City: west
    assert wxm.compass(heading) == "W"
    head = advise(openmeteo(date(2026, 11, 1), 10, wind=30, wind_from=270), heading=heading)
    assert "wind" in head["picked"] and head["ride"][0].startswith("A headwind of about 19 mph on a course that heads W")
    tail = advise(openmeteo(date(2026, 11, 1), 10, wind=30, wind_from=90), heading=heading)
    assert tail["ride"][0].startswith("A tailwind")


def test_pressures_move_with_the_case_and_correct_for_the_cold():
    silca = {"front": 24, "rear": 26}
    p = racewx.pressures(silca, ["sand"], 1.0, "imperial")
    assert (p["front"], p["rear"]) == (22.5, 24.5) and "−1.5" not in p["line"] and "-1.5 for dry and loose" in p["line"]
    assert "Set 25.1 / 27.2 psi" in p["indoors"] and "read 22.5 / 24.5 at the start's 34°F" in p["indoors"]   # 68 °F → 34 °F
    assert racewx.pressures(silca, ["snow", "mud"], 10.0, "imperial")["front"] == 21.5                     # the biggest drop wins
    assert racewx.pressures(silca, ["tacky"], 18.0, "imperial")["indoors"] == ""                            # warm enough: no correction
    assert racewx.pressures(None, ["sand"], 1.0, "imperial")["line"].startswith("Run Silca's calculator")
    assert abs(racewx.cold_psi(25, -10) - 29.5) < 0.1                                             # 39.7 psia × 293 K / 263 K


def test_every_case_is_written_out_for_the_bike():
    book = racewx.playbook(["mud"])
    assert book[0]["key"] == "mud" and book[0]["picked"] and len(book) == len(racewx.ORDER)
    for c in book:
        assert c["label"] and c["when"] and (c["wear"] or c["bike"] or c["ride"] or c["fuel"])
    text = json.dumps(racewx.PLAYBOOK)
    for word in ("AXS", "Riddler", "Rival", "Super Secret", "drip", "sealant", "clearance"):
        assert word.lower() in text.lower(), word


def test_race_page_uses_the_venue_forecast_and_your_race_time(cfg):
    today = date(2026, 10, 25)
    plan = season(today, 45, 45, cfg)
    up = bike.upkeep([], {"since": "2026-10-01", "pressure": {bike._race_key(plan["races"][0]["name"]): {"front": 24, "rear": 26}}},
                     cfg, today, None, 84, plan["races"])
    home = wxm.Wx(openmeteo(date(2026, 10, 25), 16, temp=lambda t: 15.0))
    venue = {"Bell's Iceman Cometh Challenge": {"start": wxm.Wx(openmeteo(date(2026, 10, 25), 16, rain=lambda t: 1.0 if t.date() == date(2026, 11, 7) else 0.0)),
                                                "finish": wxm.Wx(openmeteo(date(2026, 10, 25), 16))}}
    eds = {"Bell's Iceman Cometh Challenge": [{"date": "2023-11-04", "moving_s": 8561, "elapsed_s": 8799},
                                              {"date": "2024-11-02", "moving_s": 8516, "elapsed_s": 8516}]}
    page = raceday.pages(plan, cfg, home, {"lthr": 160}, 84, up, today, editions=eds, venue=venue)[0]
    c = page["conditions"]
    assert c["where"] == "venue" and "rain" in c["picked"] and "cold_wet" in c["picked"]                    # the venue's rain, not home's 59°F
    assert page["finish"] == "11:48 AM" and page["expected"]["history"]
    assert any(t["what"].startswith("Finish, about 2:24") and t["at"] == "11:48 AM" for t in page["timeline"])
    assert "(23 / 25 psi)" in page["timeline"][4]["what"]
    assert c["bike"][0] == "Tire pressure: 23 front / 25 rear psi: your Silca 24 / 26, -1 for rain during the race."
    assert any("headwind" in x or "tailwind" in x or "crosswind" in x for x in c["ride"]) or c["race_w"]["wind"] < 15
    assert page["playbook"][0]["picked"] and len(page["playbook"]) == len(racewx.ORDER)
    no_venue = raceday.pages(plan, cfg, home, {"lthr": 160}, 84, up, today, editions=eds, venue={})[0]
    assert no_venue["conditions"]["where"] == "home" and "warm" not in no_venue["conditions"]["picked"]


def test_race_forecasts_only_inside_the_forecast_reach(cfg, tmp_path):
    calls = []
    get = lambda url: calls.append(url) or openmeteo(date(2026, 10, 22), 16)   # noqa: E731
    with Store(tmp_path / "s.db") as store:
        assert build.race_forecasts(store, cfg, date(2026, 10, 20), datetime(2026, 10, 20, 8), get) == {}   # 18 days out
        got = build.race_forecasts(store, cfg, date(2026, 10, 23), datetime(2026, 10, 23, 8), get)
        assert set(got["Bell's Iceman Cometh Challenge"]) == {"start", "finish"} and len(calls) == 2
        assert "latitude=44.73" in calls[0] and "longitude=-85.49" in calls[1]   # Kalkaska to Timber Ridge, from the course
        build.race_forecasts(store, cfg, date(2026, 10, 23), datetime(2026, 10, 23, 8, 30), get)
        assert len(calls) == 2                                                                             # cached per point


def test_race_notices_new_changed_eve_and_morning(tmp_path):
    def data(today: str, days_out: int, sig: str) -> dict:
        r = {"name": "Bell's Iceman Cometh Challenge", "date": "2026-11-07", "days_out": days_out, "wave": 14, "start": "9:24 AM",
             "timeline": [{"at": "5:54 AM", "what": "Up."}],
             "conditions": {"where": "venue", "sig": sig, "windows": {"race": "34°F, rain (4 mm), wind 12 mph W (a headwind)"},
                            "wear": ["Racing (feels like 30°F, dress for 41°F): Thermal jacket, tights"],
                            "tires": {"front": 23, "rear": 25}},
             "playbook": [{"label": "Rain during the race", "picked": True}, {"label": "Cold and wet", "picked": True}, {"label": "Warm", "picked": False}]}
        return {"today": today, "race_day": [r]}
    sent = []
    send = lambda sub, msg, key: sent.append(msg) or 201   # noqa: E731
    with Store(tmp_path / "s.db") as store:
        assert cloud.race_notify(store, data("2026-10-23", 15, "a"), datetime(2026, 10, 23, 8), send) == []   # no devices yet
        cloud.subscribe(store, webpush.b64u(json.dumps({"endpoint": "https://push.example/x", "keys": {"p256dh": "k", "auth": "a"}}).encode()))
        assert cloud.race_notify(store, data("2026-10-23", 15, "a"), datetime(2026, 10, 23, 6), send) == []   # too early
        assert cloud.race_notify(store, data("2026-10-23", 15, "a"), datetime(2026, 10, 23, 8), send) == ["new"]
        assert cloud.race_notify(store, data("2026-10-23", 15, "a"), datetime(2026, 10, 23, 9), send) == []
        assert cloud.race_notify(store, data("2026-10-23", 15, "b"), datetime(2026, 10, 23, 10), send) == []  # once a day
        assert cloud.race_notify(store, data("2026-10-24", 14, "b"), datetime(2026, 10, 24, 8), send) == ["changed"]
        assert cloud.race_notify(store, data("2026-11-06", 1, "b"), datetime(2026, 11, 6, 18), send) == ["eve"]
        assert cloud.race_notify(store, data("2026-11-06", 1, "b"), datetime(2026, 11, 6, 19), send) == []
        assert cloud.race_notify(store, data("2026-11-07", 0, "b"), datetime(2026, 11, 7, 5, 10), send) == ["morning"]
    assert sent[0]["title"] == "Iceman: the race forecast is in" and "Rain during the race and cold and wet" in sent[0]["body"]
    assert sent[2]["title"] == "Iceman tomorrow · wave 14, 9:24 AM" and sent[2]["body"].startswith("Up at 5:54 AM · 34°F")
    assert "Tires 23/25 psi" in sent[2]["body"] and "Wear thermal jacket" in sent[2]["body"] and len(sent[2]["body"]) <= 230
    assert sent[3]["title"] == "Iceman today · wave 14, 9:24 AM"
