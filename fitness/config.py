"""Paths and settings: fitness/config.toml merged over the defaults below."""
from __future__ import annotations

import calendar
import os
import tomllib
from datetime import date, timedelta
from pathlib import Path

PKG = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("FITNESS_DATA_DIR", PKG / "data"))
DIST_DIR = Path(os.environ.get("FITNESS_DIST_DIR", PKG / "dist"))
SITE_DIR = PKG / "site"
DB_PATH = DATA_DIR / "fitness.db"
STRAVA_TOKEN = DATA_DIR / "strava_token.json"

DEFAULTS: dict = {
    "athlete": {"sex": "male", "max_hr": 0, "resting_hr": 0, "lthr": 0, "ftp": 0, "sleep_need_hours": 8.0, "timezone": "America/Detroit", "units": "imperial", "weight_kg": 0},
    "nutrition": {"lunch": "veggie", "weekday_ride": "evening", "bottle_cages": 2, "bladder_l": 0, "ride_fuel": {}},
    "indoor": {"start": "", "end": "", "apps": ["zwift", "mywoosh"], "long_ride_h": 2.5},
    "plan": {"weekly_pattern": [0.0, 1.3, 0.8, 1.2, 0.4, 1.7, 0.9], "max_ramp": 6, "base_ramp": 3, "fit": True},
    "sync": {"garmin_tokens": "~/.garminconnect", "history_days": 400, "resync_days": 3},
    "ride": {"url": "", "wheel_m": 2.29, "fuel_every_min": 20},
    "app": {"url": "", "export_dir": ""},
    "bike": {"name": "Bike", "parts": "", "tire": "", "rim": "", "trainer": True, "every": {}},
    "weather": {"enabled": True, "lat": 0, "lon": 0},
    "commute": {"enabled": False, "km_each_way": 0, "climb_m": [0, 0], "days": ["tue", "thu", "wed", "mon", "fri"], "per_week": [1, 3], "winter": False, "holidays": "us-federal"},
}
OPTION_DEFAULTS = {"label": "", "km": 0, "climbing_ft": 0, "hours": 2.0, "target_ctl": 55, "long_ride_h": 3.0, "taper_days": [6, 14]}
RACE_DEFAULTS = {"name": "Race", "date": None, "every": "", "kind": "gravel", "distance": "", "target_tsb": [10, 20], "match": [], "options": {}, "start": ""}
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
MONTHS = [m.lower() for m in calendar.month_abbr]


def nth_weekday(rule: str, year: int) -> date:
    """"3rd Sat Apr" → that date in `year`."""
    n, dow, mon = rule.split()
    n, dow, mon = int(n[0]), DAYS.index(dow[:3].lower()), MONTHS.index(mon[:3].lower())
    first = date(year, mon, 1)
    return first + timedelta(days=(dow - first.weekday()) % 7 + 7 * (n - 1))


def us_federal_holidays(year: int) -> set[date]:
    """The eleven US federal holidays (5 U.S.C. 6103), with Saturday ones observed Friday and Sunday ones Monday."""
    def observed(d: date) -> date:
        return d - timedelta(days=1) if d.weekday() == 5 else d + timedelta(days=1) if d.weekday() == 6 else d
    last_mon_may = date(year, 5, 31) - timedelta(days=date(year, 5, 31).weekday())
    fixed = [date(year, 1, 1), date(year, 6, 19), date(year, 7, 4), date(year, 11, 11), date(year, 12, 25)]
    rules = ["3rd Mon Jan", "3rd Mon Feb", "1st Mon Sep", "2nd Mon Oct", "4th Thu Nov"]
    out = {observed(d) for d in fixed} | {nth_weekday(r, year) for r in rules} | {last_mon_may}
    if date(year + 1, 1, 1).weekday() == 5:          # next New Year's Day on a Saturday is observed on Dec 31
        out.add(date(year, 12, 31))
    return out


def workday(d: date, cfg: dict) -> bool:
    """Monday to Friday, except holidays (cfg commute.holidays = "us-federal", the default; "" for none)."""
    return d.weekday() < 5 and not (cfg.get("commute", {}).get("holidays", "us-federal") == "us-federal" and d in us_federal_holidays(d.year))


def _race(raw: dict) -> dict:
    race = {**RACE_DEFAULTS, **raw}
    if isinstance(race["date"], str):
        race["date"] = date.fromisoformat(race["date"])
    opts = {k: {**OPTION_DEFAULTS, "label": k, **v} for k, v in (race.get("options") or {}).items()}
    if not opts:   # a race with no options block is its own single option
        opts = {"race": {**OPTION_DEFAULTS, **{k: raw[k] for k in OPTION_DEFAULTS if k in raw}, "label": raw.get("distance") or "race"}}
    race["options"] = opts
    if race["distance"] not in opts:
        race["distance"] = next(iter(opts))
    return race


def load(path: Path | None = None) -> dict:
    path = path or Path(os.environ.get("FITNESS_CONFIG", PKG / "config.toml"))
    user = tomllib.loads(path.read_text()) if path.exists() else {}
    cfg = {section: {**values, **user.get(section, {})} for section, values in DEFAULTS.items()}
    if not cfg["app"]["url"] and cfg["ride"].get("url"):   # the older layout named the hosted ride page itself
        cfg["app"]["url"] = cfg["ride"]["url"].rsplit("/", 1)[0] + "/"
    races = list(user.get("races", []))
    if "race" in user:   # the original single-race layout
        legacy = dict(user["race"])
        legacy.setdefault("km", round(legacy.get("distance_mi", 0) * 1.609))
        races.append(legacy)
    cfg["races"] = [_race(r) for r in races if r.get("date")]
    if len(cfg["plan"]["weekly_pattern"]) != 7:
        raise ValueError("plan.weekly_pattern needs seven values, Monday first")
    return cfg


def race_dates(race: dict, today: date) -> tuple[date | None, date]:
    """(the most recent past edition, the next one) for a race; rolls `every` races forward a year at a time."""
    when = race["date"]
    past = None
    while race["every"] and when < today:
        past = when
        when = nth_weekday(race["every"], when.year + 1)
    if when < today:   # a one-off race already run
        return when, when
    return past, when
