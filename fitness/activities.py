"""Activity normalization shared by the Garmin and Strava importers, and the merge of the two feeds."""
from __future__ import annotations

import bisect
from datetime import datetime, timedelta

# Garmin typeKey and Strava sport_type → (group, off-road). Groups drive the weekly-volume chart and the
# duration-only load estimate; off-road marks the rides that look like Iceman (sand, two-track, singletrack).
SPORTS: dict[str, tuple[str, bool]] = {
    # Garmin
    "cycling": ("ride", False), "road_biking": ("ride", False), "mountain_biking": ("ride", True), "gravel_cycling": ("ride", True),
    "cyclocross": ("ride", True), "indoor_cycling": ("ride", False), "virtual_ride": ("ride", False), "e_bike_mountain": ("ride", True),
    "e_bike_fitness": ("ride", False), "bmx": ("ride", True), "track_cycling": ("ride", False),
    "running": ("run", False), "trail_running": ("run", True), "treadmill_running": ("run", False), "track_running": ("run", False),
    "virtual_run": ("run", False), "walking": ("walk", False), "hiking": ("walk", True), "casual_walking": ("walk", False),
    "speed_walking": ("walk", False), "strength_training": ("strength", False), "indoor_cardio": ("other", False), "yoga": ("other", False),
    "lap_swimming": ("swim", False), "open_water_swimming": ("swim", False), "resort_skiing_snowboarding_ws": ("other", False),
    "cross_country_skiing_ws": ("other", True), "skate_skiing_ws": ("other", True), "backcountry_skiing_snowboarding_ws": ("other", True),
    # Strava
    "Ride": ("ride", False), "MountainBikeRide": ("ride", True), "GravelRide": ("ride", True), "VirtualRide": ("ride", False),
    "EBikeRide": ("ride", False), "EMountainBikeRide": ("ride", True), "Velomobile": ("ride", False), "Handcycle": ("ride", False),
    "Run": ("run", False), "TrailRun": ("run", True), "VirtualRun": ("run", False), "Walk": ("walk", False), "Hike": ("walk", True),
    "WeightTraining": ("strength", False), "Workout": ("other", False), "Crossfit": ("strength", False), "Yoga": ("other", False),
    "Swim": ("swim", False), "NordicSki": ("other", True), "BackcountrySki": ("other", True), "AlpineSki": ("other", False),
    "Snowshoe": ("walk", True), "Rowing": ("other", False), "Elliptical": ("other", False), "StairStepper": ("other", False),
    # Strava bulk-export CSV names
    "Mountain Bike Ride": ("ride", True), "Gravel Ride": ("ride", True), "Virtual Ride": ("ride", False), "E-Bike Ride": ("ride", False),
    "Trail Run": ("run", True), "Virtual Run": ("run", False), "Weight Training": ("strength", False), "Nordic Ski": ("other", True),
}


def classify(kind: str) -> tuple[str, bool]:
    if kind in SPORTS:
        return SPORTS[kind]
    low = kind.lower()
    for word, group in (("bik", "ride"), ("ride", "ride"), ("cycl", "ride"), ("run", "run"), ("walk", "walk"), ("hik", "walk"), ("swim", "swim")):
        if word in low:
            return group, any(w in low for w in ("mountain", "gravel", "trail", "cross"))
    return "other", False


INDOOR_KINDS = {"virtual_ride", "indoor_cycling", "VirtualRide", "Virtual Ride", "treadmill_running", "VirtualRun", "Virtual Run", "indoor_cardio",
                "indoor_rowing", "Elliptical", "StairStepper"}
INDOOR_APPS = ("zwift", "mywoosh", "trainerroad", "rouvy", "wahoo systm", "fulgaz")


def activity(*, id: str, source: str, start: datetime, kind: str, name: str = "", duration_s: float = 0, moving_s: float | None = None,
             distance_m: float | None = None, elev_m: float | None = None, avg_hr: float | None = None, max_hr: float | None = None,
             avg_power: float | None = None, np: float | None = None, kj: float | None = None, calories: float | None = None,
             **extra) -> dict:
    group, offroad = classify(kind)
    trainer = extra.pop("trainer", None)
    indoor = bool(trainer) or kind in INDOOR_KINDS or any(app in (name or "").lower() for app in INDOOR_APPS)
    return {
        "id": id, "source": source, "start": start.replace(microsecond=0, tzinfo=None).isoformat(), "kind": kind, "group": group, "offroad": offroad and not indoor, "indoor": indoor,
        "name": name, "duration_s": float(duration_s or 0), "moving_s": float(moving_s or duration_s or 0), "distance_m": distance_m or 0.0,
        "elev_m": elev_m or 0.0, "avg_hr": avg_hr or None, "max_hr": max_hr or None, "avg_power": avg_power or None, "np": np or None,
        "kj": kj or None, "calories": calories or None, **{k: v for k, v in extra.items() if v is not None},
    }


def merge(acts: list[dict]) -> list[dict]:
    """One row per real-world session. Garmin auto-uploads to Strava, so the same ride arrives twice: a Garmin and a
    Strava record that start within 10 minutes of each other and last within 25% of each other are one ride. The
    Garmin record wins (it carries HR zones and training effect) and borrows what only Strava has (power, its name)."""
    garmin = [dict(a) for a in sorted((a for a in acts if a["source"] == "garmin"), key=lambda a: a["start"])]
    starts = [datetime.fromisoformat(a["start"]) for a in garmin]
    out = list(garmin)
    for a in (a for a in acts if a["source"] != "garmin"):
        t = datetime.fromisoformat(a["start"])
        lo = bisect.bisect_left(starts, t - timedelta(minutes=10))
        hi = bisect.bisect_right(starts, t + timedelta(minutes=10))
        twin = next((garmin[i] for i in range(lo, hi) if _close(garmin[i]["duration_s"], a["duration_s"])), None)
        if twin is None:
            out.append(dict(a))
            continue
        twin.setdefault("links", {})[a["source"]] = a["id"]
        for key in ("avg_power", "np", "kj", "suffer_score"):
            if not twin.get(key) and a.get(key):
                twin[key] = a[key]
        if twin["name"] in ("", None) or twin["name"].endswith((" Cycling", " Mountain Biking", " Riding", " Running", "Indoor Cycling", "Virtual Cycling")):
            twin["name"] = a["name"] or twin["name"]
        if a.get("offroad") and not twin.get("offroad"):
            twin["offroad"] = True
        if a.get("indoor") and not twin.get("indoor"):   # a watch-recorded "cycling" that Zwift / MyWoosh also uploaded
            twin["indoor"], twin["offroad"] = True, False
    return sorted(out, key=lambda a: a["start"])


def _close(a: float, b: float) -> bool:
    return max(a, b) == 0 or abs(a - b) / max(a, b) <= 0.25
