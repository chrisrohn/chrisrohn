"""Weather for the day's call, from Open-Meteo's free forecast (no key, no account): rain, wind, temperature and
daylight for the commute's two legs and for the best window to ride on other days; a 16-day outlook the planner
uses to keep commutes and long rides on dry days; and the last month's hourly history, so the bike page knows which
rides were wet.

Where: the commute's two ends, learned from where your Garmin rides start (in → home, home → work), else the middle
of your recent rides, else `[weather] lat / lon` in config.toml. Only a ~1 km-rounded point leaves the sync, and the
coordinates never go into the phone's data. The fetch is cached in the store for 50 minutes, and the last forecast
is used when Open-Meteo can't be reached.
"""
from __future__ import annotations

import json
import math
import statistics
from collections.abc import Callable
from datetime import date, datetime, timedelta
from urllib.parse import urlencode
from urllib.request import Request, urlopen

API = "https://api.open-meteo.com/v1/forecast"
HOURLY = ("temperature_2m", "apparent_temperature", "precipitation", "precipitation_probability", "weather_code",
          "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m")
DAILY = ("sunrise", "sunset", "temperature_2m_max", "temperature_2m_min", "precipitation_sum", "precipitation_probability_max",
         "weather_code", "wind_speed_10m_max")
MAX_AGE_MIN = 50
STORM = set(range(95, 100))                       # thunderstorms (WMO weather codes)
FREEZING = {56, 57, 66, 67}                       # freezing drizzle / rain
SNOW = {71, 73, 75, 77, 85, 86}


def _get(url: str) -> dict:
    with urlopen(Request(url, headers={"User-Agent": "fitness-sync (chrisrohn.com/fitness)"}), timeout=20) as r:
        return json.load(r)


def fetch(lat: float, lon: float, tz: str, get: Callable[[str], dict] = _get) -> dict:
    """16 days ahead and 31 back, hourly and daily, metric, in your time zone."""
    q = {"latitude": round(lat, 2), "longitude": round(lon, 2), "timezone": tz, "past_days": 31, "forecast_days": 16,
         "hourly": ",".join(HOURLY), "daily": ",".join(DAILY), "wind_speed_unit": "kmh", "timeformat": "iso8601"}
    return get(f"{API}?{urlencode(q)}")


def load(store, where: tuple[float, float] | None, tz: str, now: datetime, get: Callable[[str], dict] = _get) -> dict | None:
    """The forecast for `where`, from the store when it's under MAX_AGE_MIN old; the last one if the fetch fails."""
    if not where:
        return None
    cached = json.loads(store.get("weather") or "null")
    key = [round(where[0], 2), round(where[1], 2)]
    if cached and cached["where"] == key and now - datetime.fromisoformat(cached["at"]) < timedelta(minutes=MAX_AGE_MIN):
        return cached["data"]
    try:
        data = fetch(where[0], where[1], tz, get)
    except Exception as e:
        print(f"Weather: couldn't reach Open-Meteo ({str(e)[:80]}); using the last forecast" if cached else f"Weather: unavailable ({str(e)[:80]})")
        return cached["data"] if cached else None
    store.set("weather", json.dumps({"where": key, "at": now.isoformat(timespec="minutes"), "data": data}))
    return data


def for_store(store, cfg: dict, today: date, now: datetime, get: Callable[[str], dict] = _get) -> dict | None:
    """The forecast for the store's rides: where they start, fetched or from the 50-minute cache."""
    from fitness import metrics
    from fitness.activities import merge

    acts = merge(store.activities())
    metrics.mark_commutes(acts, cfg)
    return load(store, route(acts, cfg, today)["where"], cfg["athlete"]["timezone"], now, get)


# ── where ────────────────────────────────────────────────────────────────────────────────────────────────

def _median_point(points: list[tuple[float, float]]) -> tuple[float, float] | None:
    return (statistics.median(p[0] for p in points), statistics.median(p[1] for p in points)) if len(points) >= 3 else None


def bearing(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Initial compass bearing from a to b, degrees."""
    la1, la2, dl = math.radians(a[0]), math.radians(b[0]), math.radians(b[1] - a[1])
    y = math.sin(dl) * math.cos(la2)
    x = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def route(acts: list[dict], cfg: dict, today: date) -> dict:
    """The commute's ends and usual departure times from the rides themselves (needs metrics.mark_commutes first),
    and the point to fetch weather for. Server-side only: never put this in the phone's data."""
    since = (today - timedelta(days=365)).isoformat()
    legs = {leg: [a for a in acts if a.get("commute") and a.get("leg") == leg and a["start"][:10] >= since] for leg in ("in", "home")}
    home = _median_point([tuple(a["start_ll"]) for a in legs["in"] if a.get("start_ll")] + [tuple(a["end_ll"]) for a in legs["home"] if a.get("end_ll")])
    work = _median_point([tuple(a["end_ll"]) for a in legs["in"] if a.get("end_ll")] + [tuple(a["start_ll"]) for a in legs["home"] if a.get("start_ll")])

    def depart(leg: str, default: str) -> str:
        mins = [int(a["start"][11:13]) * 60 + int(a["start"][14:16]) for a in legs[leg]]
        m = round(statistics.median(mins)) if len(mins) >= 3 else int(default[:2]) * 60 + int(default[3:])
        return f"{m // 60:02d}:{m % 60:02d}"

    recent = [tuple(a["start_ll"]) for a in acts if a.get("start_ll") and not a.get("indoor") and a["start"][:10] >= (today - timedelta(days=120)).isoformat()]
    conf = cfg.get("weather") or {}
    where = home or _median_point(recent) or ((conf["lat"], conf["lon"]) if conf.get("lat") and conf.get("lon") else None)
    return {"where": where, "home": home, "work": work, "bearing_in": bearing(home, work) if home and work and home != work else None,
            "depart": {"in": depart("in", "07:00"), "home": depart("home", "16:30")}}


# ── reading a forecast ───────────────────────────────────────────────────────────────────────────────────

class Wx:
    """An Open-Meteo response, indexed by local hour and by day."""

    def __init__(self, raw: dict):
        h = raw.get("hourly") or {}
        self.hours = {t: {k: (h.get(k) or [None] * len(h["time"]))[i] for k in HOURLY} for i, t in enumerate(h.get("time", []))}
        d = raw.get("daily") or {}
        self.days = {t: {k: (d.get(k) or [None] * len(d["time"]))[i] for k in DAILY} for i, t in enumerate(d.get("time", []))}

    def span(self, start: datetime, minutes: float) -> list[dict]:
        t, end, out = start.replace(minute=0, second=0, microsecond=0), start + timedelta(minutes=minutes), []
        while t < end:
            if (row := self.hours.get(t.strftime("%Y-%m-%dT%H:00"))) is not None:
                out.append(row)
            t += timedelta(hours=1)
        return out

    def sun(self, d: date) -> tuple[datetime, datetime] | None:
        day = self.days.get(d.isoformat())
        return (datetime.fromisoformat(day["sunrise"]), datetime.fromisoformat(day["sunset"])) if day and day.get("sunrise") else None

    def window(self, start: datetime, minutes: float, heading: float | None = None) -> dict | None:
        """What a ride from `start` for `minutes` gets: temperature, rain, wind (and its head/tail part along `heading`)."""
        rows = [r for r in self.span(start, minutes) if r["temperature_2m"] is not None]
        if not rows:
            return None
        f = lambda k: [r[k] for r in rows if r[k] is not None]   # noqa: E731
        speed, dirs = f("wind_speed_10m"), f("wind_direction_10m")
        wdir = (math.degrees(math.atan2(sum(math.sin(math.radians(x)) for x in dirs), sum(math.cos(math.radians(x)) for x in dirs))) + 360) % 360 if dirs else None
        w = {"start": start.isoformat(timespec="minutes"), "minutes": round(minutes), "temp_min": min(f("temperature_2m")), "temp_max": max(f("temperature_2m")),
             "feels": min(f("apparent_temperature") or f("temperature_2m")), "rain_mm": round(sum(f("precipitation")), 1),
             "pop": max(f("precipitation_probability") or [0]), "code": max(f("weather_code") or [0]), "wind": round(statistics.mean(speed)) if speed else 0,
             "gust": round(max(f("wind_gusts_10m") or [0])), "wind_dir": round(wdir) if wdir is not None else None}
        w["head"] = round(w["wind"] * math.cos(math.radians(wdir - heading))) if heading is not None and wdir is not None else None
        w["verdict"] = verdict(w)
        sun = self.sun(start.date())
        end = start + timedelta(minutes=minutes)
        w["dark"] = bool(sun) and (start < sun[0] + timedelta(minutes=15) or end > sun[1] - timedelta(minutes=15))
        return w

    def outlook(self, d: date) -> dict | None:
        """One day at a glance, for the week strip."""
        day = self.days.get(d.isoformat())
        if not day or day.get("temperature_2m_max") is None:
            return None
        return {"hi": round(day["temperature_2m_max"]), "lo": round(day["temperature_2m_min"]), "mm": round(day["precipitation_sum"] or 0, 1),
                "pop": day.get("precipitation_probability_max") or 0, "code": day.get("weather_code") or 0, "wind": round(day.get("wind_speed_10m_max") or 0)}

    def rain_day(self, d: date) -> bool:
        """Wet enough between 8 and 6 that an outdoor long ride is miserable or unsafe."""
        start = datetime.combine(d, datetime.min.time()) + timedelta(hours=8)
        w = self.window(start, 600)
        wet_hours = sum(1 for r in self.span(start, 600) if (r["precipitation"] or 0) >= 0.3)
        return bool(w) and (w["verdict"] in ("storm", "ice") or w["rain_mm"] >= 3 or wet_hours >= 3)

    def wet_during(self, start: datetime, minutes: float) -> bool:
        """Did it rain on this ride (for the chain)?"""
        return sum(r["precipitation"] or 0 for r in self.span(start, minutes)) >= 0.3


def verdict(w: dict) -> str:
    if w["code"] in STORM or w["gust"] >= 60:
        return "storm"
    if w["code"] in FREEZING or (w["temp_min"] <= 1 and (w["rain_mm"] >= 0.2 or w["code"] in SNOW)):
        return "ice"
    if w["rain_mm"] >= 1.0 or (w["pop"] >= 70 and w["rain_mm"] >= 0.3):
        return "wet"
    if w["rain_mm"] >= 0.2 or w["pop"] >= 40:
        return "showers"
    return "dry"


# ── words ────────────────────────────────────────────────────────────────────────────────────────────────

def temp(c: float, units: str) -> str:
    return f"{round(c * 9 / 5 + 32)}°F" if units == "imperial" else f"{round(c)}°C"


def speed(kmh: float, units: str) -> str:
    return f"{round(kmh / 1.609)} mph" if units == "imperial" else f"{round(kmh)} km/h"


def compass(deg: float | None) -> str:
    return "" if deg is None else ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][round(deg / 45) % 8]


def kit(feels_c: float, wet: bool) -> str:
    """What to wear for a ride that feels like `feels_c`."""
    if feels_c >= 21:
        k = "Short sleeves and shorts"
    elif feels_c >= 15:
        k = "Short sleeves, shorts; arm warmers in the pocket"
    elif feels_c >= 10:
        k = "Arm and knee warmers, a vest"
    elif feels_c >= 5:
        k = "Long-sleeve jersey, knee or leg warmers, light gloves, a vest or wind jacket"
    elif feels_c >= 0:
        k = "Thermal jacket, tights, full-finger winter gloves, shoe covers, a cap under the helmet"
    else:
        k = "Winter jacket, thermal tights, lobster gloves, toe warmers under shoe covers, a balaclava"
    return k + ("; rain jacket and fenders" if wet else "")


def describe(w: dict, units: str) -> str:
    """"52°F, dry, wind 9 mph SW (a headwind)" for one ride window."""
    sky = {"storm": "thunderstorms", "ice": "icy", "wet": f"rain ({w['rain_mm']:g} mm)", "showers": f"{w['pop']}% chance of showers", "dry": "dry"}[w["verdict"]]
    t = temp(w["temp_min"], units) if abs(w["temp_max"] - w["temp_min"]) < 2 else f"{temp(w['temp_min'], units)}–{temp(w['temp_max'], units)}"
    wind = f"wind {speed(w['wind'], units)} {compass(w['wind_dir'])}".rstrip()
    if w.get("head") is not None and abs(w["head"]) >= 10:
        wind += " (a headwind)" if w["head"] > 0 else " (a tailwind)"
    return f"{t}, {sky}, {wind}"


def best_window(wx: Wx, d: date, minutes: float, earliest: datetime, latest_end: datetime | None = None) -> dict | None:
    """The best window today for an outdoor ride of `minutes`: in daylight, after `earliest`, the driest; ties go to
    the warmer, then the earlier."""
    sun = wx.sun(d)
    if not sun:
        return None
    lo = max(earliest, sun[0])
    hi = min(latest_end or sun[1], sun[1]) - timedelta(minutes=minutes)
    best, t = None, lo.replace(minute=0, second=0, microsecond=0) + (timedelta(hours=1) if lo.minute else timedelta())
    rank = {"dry": 0, "showers": 1, "wet": 2, "ice": 3, "storm": 4}
    while t <= hi:
        w = wx.window(t, minutes)
        if w and (best is None or (rank[w["verdict"]], -w["feels"]) < (rank[best["verdict"]], -best["feels"])):
            best = w
        t += timedelta(hours=1)
    return best
