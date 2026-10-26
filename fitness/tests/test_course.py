"""A race's course from the organizer's GPX (fitness/course.py): the numbers, the hills, the wind along it, the race
time scaled to it, the race-day plan it writes, and the copy ride mode keeps."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from fitness import build, config, course, raceday, racewx  # noqa: E402
from fitness import weather as wxm  # noqa: E402
from fitness.plan import season  # noqa: E402

GPX = "courses/iceman-2026.gpx"
FITNESS = Path(__file__).resolve().parents[1]
GUN = datetime(2026, 11, 7, 9, 24)


@pytest.fixture(scope="module")
def cfg():
    return config.load()


@pytest.fixture(scope="module")
def iceman():
    return course.load(GPX)


def gpx(points, tag="trkpt", name="Test course") -> str:
    pts = "".join(f'<{tag} lat="{la}" lon="{lo}">' + (f"<ele>{e}</ele>" if e is not None else "") + f"</{tag}>" for la, lo, e in points)
    wrap = f"<trk><name>{name}</name><trkseg>{pts}</trkseg></trk>" if tag == "trkpt" else f"<rte><name>{name}</name>{pts}</rte>"
    return f'<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1">{wrap}</gpx>'


def test_the_2026_iceman_course(iceman):
    c = iceman
    assert c["name"] == "2026 Iceman" and c["km"] == pytest.approx(44.12, abs=0.01) and c["mi"] == pytest.approx(27.41, abs=0.01)
    assert c["start_ll"] == [44.72617, -85.21165] and c["finish_ll"] == [44.71389, -85.49165] and not c["loop"]   # Kalkaska → Timber Ridge
    assert 250 <= c["heading"] <= 280 and sum(c["facing"]) == pytest.approx(1, abs=0.01)                       # westward, every metre counted
    assert 470 <= c["gain_m"] <= 520                                   # as a recorder counts it: your 2023 and 2024 editions logged 472–521 m
    assert c["ride_gain_m"] == 331 and len(c["climbs"]) == 3           # ride mode's smoothing: three ClimbPro climbs, all after mile 20
    assert all(x["start_m"] > 32000 for x in c["climbs"])
    assert c["kicks"]["n"] >= 25 and c["kicks"]["median_gain_m"] < 15 and len(c["hills"]) == 14   # rolling, not climbing
    third = [t["gain_m"] for t in c["thirds"]]
    assert third[2] == max(third) and third[2] / sum(third) > 0.4      # back-loaded
    last = c["finale"]["last"]
    assert last["grade"] == pytest.approx(10, abs=1) and last["max_grade"] >= 14 and c["km"] * 1000 - last["start_m"] < 1000   # the wall before the line


def test_the_profile_and_climbs_match_ride_mode(iceman):
    """The race card and the phone on the bars give the same distance, gain and climbs: ride-core.js run on the same file."""
    node = shutil.which("node")
    if not node:
        pytest.skip("node isn't installed")
    script = """
    global.self = global;
    require("vm").runInThisContext(require("fs").readFileSync(process.argv[1], "utf8"));
    const C = self.RideCore, r = C.analyze(C.parseRoute(require("fs").readFileSync(process.argv[2], "utf8"), "c.gpx"));
    process.stdout.write(JSON.stringify({ total: r.total, gain: r.gain, climbs: r.climbs.map(c => [c.start, c.len, Math.round(c.gain * 10) / 10]) }));
    """
    out = json.loads(subprocess.run([node, "-e", script, str(FITNESS / "site/ride-core.js"), str(FITNESS / GPX)], capture_output=True, text=True, check=True).stdout)
    assert out["total"] / 1000 == pytest.approx(iceman["km"], abs=0.01)
    assert round(out["gain"]) == iceman["ride_gain_m"]
    assert out["climbs"] == [[x["start_m"], x["len_m"], x["gain_m"]] for x in iceman["climbs"]]


def test_the_phone_copy_is_light_and_keeps_the_course(iceman):
    pts = iceman["points"]
    assert 500 < len(pts) < 2500 and len(json.dumps(pts)) < 60_000
    thin = course.analyze("thin", [tuple(p) for p in pts])
    assert abs(thin["km"] - iceman["km"]) / iceman["km"] < 0.004                   # within 0.4% of the organizer's length
    assert abs(thin["ride_gain_m"] - iceman["ride_gain_m"]) <= 0.05 * iceman["ride_gain_m"] and len(thin["climbs"]) == len(iceman["climbs"])
    s = course.share(iceman, "Bell's Iceman Cometh Challenge", 2026)
    assert s["id"] == "course-bell-s-iceman-cometh-challenge-2026" and s["points"] is pts and s["name"] == "2026 Iceman"


def test_a_route_file_without_a_track_or_heights(tmp_path):
    line = [(44.0, -85.0 + i * 0.001, None) for i in range(60)]                       # ~4.8 km due east, no heights
    name, pts = course.parse(gpx(line, tag="rtept", name="Flat"))
    assert name == "Flat" and len(pts) == 60
    c = course.analyze(name, pts)
    assert not c["has_ele"] and c["gain_m"] == 0 and c["climbs"] == [] and c["profile"] == [] and c["finale"] is None
    assert c["km"] == pytest.approx(4.75, abs=0.05) and 85 <= c["heading"] <= 95 and len(c["points"]) == 2   # a straight line is two points
    with pytest.raises(ValueError, match="no track"):
        course.parse(gpx([(44.0, -85.0, 200)]))
    with pytest.raises(ValueError, match="GPX"):
        course.parse("<TrainingCenterDatabase/>")
    with pytest.raises(ValueError, match="not found"):
        course.load(str(tmp_path / "nope.gpx"))
    assert course.load("") is None


def test_a_hill_on_a_made_up_course():
    # 3 km flat at 200 m, a 600 m climb of 30 m (5%), then 2 km flat on top
    east = lambda m: -85.0 + m / (111320 * 0.7193)   # noqa: E731
    pts = [(44.0, east(m), 200 + min(30, max(0, (m - 3000) * 0.05))) for m in range(0, 5600, 10)]
    c = course.analyze("Hill", pts)
    assert len(c["climbs"]) == 1 and c["climbs"][0]["gain_m"] == pytest.approx(30, abs=3) and c["climbs"][0]["grade"] == pytest.approx(5, abs=0.6)
    assert len(c["hills"]) == 1 and c["hills"][0]["start_m"] == pytest.approx(3000, abs=100)
    assert c["gain_m"] == pytest.approx(30, abs=2) and c["thirds"][1]["gain_m"] >= 25


def test_the_wind_along_the_course_not_the_straight_line(iceman):
    west = course.along(20, 270, iceman["facing"])   # from the west: in your face on a westbound course
    east = course.along(20, 90, iceman["facing"])
    assert west["head"] > 5 and east["head"] < -5 and west["into_pct"] > 60 and east["into_pct"] < 20
    assert course.along(20, None, iceman["facing"]) is None
    north_south = [0.0] * course.BINS
    north_south[0] = north_south[18] = 0.5                   # out and back north–south: a west wind is all crosswind
    assert course.along(20, 270, north_south)["head"] == 0


def test_race_time_scales_past_editions_to_this_years_course():
    eds = [{"date": "2023-11-04", "moving_s": 8561, "elapsed_s": 8799, "distance_m": 47290},
           {"date": "2024-11-02", "moving_s": 8516, "elapsed_s": 8516, "distance_m": 51450}]
    took = racewx.expected(eds, 2.25, km=44.12)
    assert took["scaled"] and took["minutes"] == pytest.approx((8799 * 44120 / 47290 + 8516 * 44120 / 51450) / 120, abs=1)   # 2:09, not 2:24
    assert "2:27 in 2023" in took["from"] and "at your pace over this year's 27.4 mi" in took["from"]
    assert "27.4 mi" not in racewx.expected(eds, 2.25, km=44.12, units="metric")["from"]
    same = racewx.expected(eds[:1], 2.25, km=47.0)                      # within 3%: the recording's own wobble, not a new course
    assert not same["scaled"] and same["minutes"] == round(8799 / 60)
    odd = racewx.expected([{**eds[0], "distance_m": 90000}], 2.25, km=44.12)   # twice as far: a ride there and back, not a course change
    assert not odd["scaled"]
    assert racewx.expected(eds, 2.25)["minutes"] == 144                 # no course length: the editions as they were


def test_the_wind_line_names_the_course(iceman):
    w = {"wind": 24, "head": 18, "into_pct": 71}
    line = racewx.heading_line(267, w, "imperial", "mtb")
    assert line.startswith("A headwind of about 11 mph along the course (71% of it into the wind; overall it heads W)")
    assert "on a course that heads W" in racewx.heading_line(267, {"wind": 24, "head": 18}, "imperial", "mtb")


def test_race_day_carries_the_course(cfg):
    today = date(2026, 10, 25)
    plan = season(today, 45, 45, cfg)
    raw = {"hourly": {"time": [], **{k: [] for k in wxm.HOURLY}}, "daily": {"time": []}}
    for i in range(16 * 24):
        t = datetime.combine(today, datetime.min.time()) + timedelta(hours=i)
        raw["hourly"]["time"].append(t.strftime("%Y-%m-%dT%H:00"))
        for k, v in zip(wxm.HOURLY, (6.0, 3.0, 0.0, 5, 1, 25.0, 270.0, 35.0), strict=True):
            raw["hourly"][k].append(v)
    for k in wxm.DAILY:
        raw["daily"][k] = []
    for i in range(16):
        d = (today + timedelta(days=i)).isoformat()
        raw["daily"]["time"].append(d)
        for k, v in zip(wxm.DAILY, (f"{d}T07:20", f"{d}T17:15", 8.0, 0.0, 0.0, 5, 1, 25.0), strict=True):
            raw["daily"][k].append(v)
    venue = {"Bell's Iceman Cometh Challenge": {"start": wxm.Wx(raw), "finish": wxm.Wx(raw)}}
    eds = {"Bell's Iceman Cometh Challenge": [{"date": "2024-11-02", "moving_s": 8516, "elapsed_s": 8516, "distance_m": 51450}]}
    page = raceday.pages(plan, cfg, None, {"lthr": 160}, 84, None, today, editions=eds, venue=venue)[0]
    c = page["course"]
    assert c["distance"] == "27.4 mi" and c["climbs"] == 3 and len(c["hills"]) == 14 and len(c["checkpoints"]) == 3
    assert page["expected"]["scaled"] and page["finish"] == "11:26 AM"                         # 2:22 over 32 mi → 2:02 over 27.4
    assert c["checkpoints"][-1]["clock"] == page["finish"] and c["checkpoints"][0]["clock"] < c["checkpoints"][1]["clock"]
    assert any("back-loaded" in n for n in c["notes"]) and any("tops out" in n for n in c["notes"]) and any("on your phone" in n for n in c["notes"])
    assert c["hills"][-1]["how"].startswith("a surge") and c["hills"][0]["how"].startswith("a drag")
    wind = next(x for x in page["conditions"]["ride"] if x.startswith("A headwind"))           # a west wind, along the course itself
    assert "along the course" in wind and page["conditions"]["race_w"]["into_pct"] > 60


def test_the_course_stays_with_its_edition_and_reaches_ride_mode(cfg):
    iceman = next(r for r in cfg["races"] if "Iceman" in r["name"])
    assert raceday.edition_course(iceman, "2026-11-07")["km"] == pytest.approx(44.12, abs=0.01)
    assert raceday.edition_course(iceman, "2027-11-06") is None              # next year's course isn't this one
    th = {"lthr": 160, "max_hr": 185, "rest_hr": 50, "sex": "male"}
    near = build.ride_config(cfg, th, season(date(2026, 10, 25), 45, 45, cfg))
    assert near["race"]["course"]["id"] == "course-bell-s-iceman-cometh-challenge-2026" and len(near["race"]["course"]["points"]) > 500
    far = build.ride_config(cfg, th, season(date(2026, 9, 1), 45, 45, cfg))
    assert "course" not in far["race"]                                       # more than six weeks out: not yet
    assert "course" not in json.dumps(build.ride_link(cfg, near, "ride.html"))   # and never in the QR code


def test_config_takes_the_start_and_finish_from_the_course():
    r = config._race({"name": "X", "date": "2026-11-07", "course": GPX})
    assert r["start_ll"] == [44.72617, -85.21165] and r["finish_ll"] == [44.71389, -85.49165]
    r = config._race({"name": "X", "date": "2026-11-07", "course": GPX, "finish_ll": [44.7, -85.5]})
    assert r["finish_ll"] == [44.7, -85.5]                                   # what config.toml says wins
    with pytest.raises(ValueError, match="not found"):
        config._race({"name": "X", "date": "2026-11-07", "course": "courses/missing.gpx"})
