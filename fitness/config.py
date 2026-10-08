"""Paths and settings: fitness/config.toml merged over the defaults below."""
from __future__ import annotations

import os
import tomllib
from datetime import date
from pathlib import Path

PKG = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("FITNESS_DATA_DIR", PKG / "data"))
DIST_DIR = Path(os.environ.get("FITNESS_DIST_DIR", PKG / "dist"))
SITE_DIR = PKG / "site"
DB_PATH = DATA_DIR / "fitness.db"
STRAVA_TOKEN = DATA_DIR / "strava_token.json"

DEFAULTS: dict = {
    "athlete": {"sex": "male", "max_hr": 0, "resting_hr": 0, "lthr": 0, "ftp": 0, "sleep_need_hours": 8.0, "timezone": "America/Detroit"},
    "race": {"name": "", "date": None, "distance_mi": 0, "climbing_ft": 0, "target_tsb": [10, 20], "match": []},
    "plan": {"weekly_pattern": [0.0, 1.3, 0.8, 1.2, 0.4, 1.7, 0.9], "max_ramp": 6, "taper_days": [6, 14]},
    "sync": {"garmin_tokens": "~/.garminconnect", "history_days": 400, "resync_days": 3},
}


def load(path: Path | None = None) -> dict:
    path = path or Path(os.environ.get("FITNESS_CONFIG", PKG / "config.toml"))
    user = tomllib.loads(path.read_text()) if path.exists() else {}
    cfg = {section: {**values, **user.get(section, {})} for section, values in DEFAULTS.items()}
    race_date = cfg["race"]["date"]
    if isinstance(race_date, str):
        cfg["race"]["date"] = date.fromisoformat(race_date)
    if len(cfg["plan"]["weekly_pattern"]) != 7:
        raise ValueError("plan.weekly_pattern needs seven values, Monday first")
    return cfg
