"""Turns the store into the site: one self-contained dist/index.html with the numbers inlined (no server, no CDN)."""
from __future__ import annotations

import base64
import hashlib
import json
import re
import shutil
import statistics
import zlib
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

from fitness import bike, fuel, raceday
from fitness import metrics as m
from fitness import weather as wxm
from fitness.activities import merge
from fitness.config import DIST_DIR, SITE_DIR, nth_weekday, workday
from fitness.plan import _replaced, adapt, fit, in_indoor, season

CHART_DAYS, SLEEP_DAYS, WEEKS = 180, 90, 16


def _iso(d: date) -> str:
    return d.isoformat()


def assemble(cfg: dict, days: dict[str, dict], raw_acts: list[dict], today: date, profile: dict | None = None,
             now: datetime | None = None, weather: dict | None = None, bike_state: dict | None = None) -> dict:
    days = {k: v for k, v in days.items() if not v.get("empty") and k <= _iso(today)}
    acts = [a for a in merge(raw_acts) if a["start"][:10] <= _iso(today)]
    th = m.thresholds(cfg, acts, days, today)
    m.mark_commutes(acts, cfg)
    for a in acts:
        a["load"], a["load_src"] = m.session_load(a, th)
        a["end"] = (datetime.fromisoformat(a["start"]) + timedelta(seconds=a["duration_s"])).isoformat()

    first = min([date.fromisoformat(a["start"][:10]) for a in acts] + [date.fromisoformat(k) for k in days] + [today - timedelta(days=CHART_DAYS)])
    load = m.daily_load(acts, first, today)
    rows = m.pmc(load)
    by_day = {r["date"]: r for r in rows}
    need = cfg["athlete"]["sleep_need_hours"]

    sleep = {k: s for k, d in days.items() if (s := m.sleep_score(d.get("sleep"), need))}
    ready = {}
    for k in sorted(days):
        prev = by_day.get(_iso(date.fromisoformat(k) - timedelta(days=1)))
        form = {"tsb": by_day[k]["tsb"], "acwr": prev["acwr"] if prev else None} if k in by_day else None
        if r := m.readiness(k, days, sleep.get(k), form):
            ready[k] = r

    t, y = _iso(today), _iso(today - timedelta(days=1))
    commute = m.commute_profile(acts, cfg, today)
    cfg = {**cfg, "commute": {**cfg["commute"], "profile": commute}}   # the planner prices commutes from your own history
    # the forecast (weather.py): the planner keeps commutes and long rides off wet days, and the calls get what to wear
    route = wxm.route(acts, cfg, today)
    wx = wxm.Wx(weather) if weather else None
    if wx:
        cfg = {**cfg, "forecast": _forecast(wx, route, cfg, today, commute)}
    habits = m.habits(acts, today)
    cfg, fit_notes = fit(cfg, habits)                                     # the plan fitted to how you actually ride
    state = by_day.get(y, {"ctl": 0, "atl": 0})
    # what this week has to absorb: sessions that didn't happen (plan.adapt), judged by the local time of this build
    now = now or datetime.now()
    hour = now.hour if now.date() == today else 6
    commute_days = {date.fromisoformat(a["start"][:10]) for a in acts if a.get("commute")}
    adjust = adapt(today, hour, cfg, load, commute_days, by_day)
    plan = season(today, state["ctl"], state["atl"], cfg, done_today=load.get(t, 0), adapt=adjust)
    # every other distance option of every race, so the page can compare "100k or 50k?" side by side
    variants = {}
    if plan:
        for r in plan["races"]:
            for o in r["options"]:
                if o["key"] != r["option"]:
                    variants[f"{r['name']}|{o['key']}"] = season(today, state["ctl"], state["atl"], cfg, load.get(t, 0), {r["name"]: o["key"]}, adjust)
    if plan:
        plan["adjustments"] = adjust["notes"] + _rebooked(plan, adjust, today)
        if adjust.get("week_scale"):
            plan["adjustments"].append(f"You've ridden {adjust['week_done']} TSS since Monday, so the rest of this week is trimmed to about "
                                       f"{round(adjust['week_scale'] * 100)}% of plan: the week lands on its target instead of over it.")
        fit_notes += _outlook(plan, variants, habits)
    plan_today = plan["days"][0] if plan else None
    ready_today = ready.get(t)
    rec = m.recommend(ready_today, plan_today)
    # room for an extra, optional commute: this week's ridden and still-booked commutes under commute.per_week's most
    sunday = _iso(today + timedelta(days=6 - today.weekday()))
    booked = adjust["commutes_done"] + sum(1 for d in (plan["days"] if plan else []) if d["date"] <= sunday and d.get("commute"))
    room = booked < cfg["commute"]["per_week"][1]
    commute_wx = _commute_wx(wx, route, today, commute) if wx and commute else None
    commute_today = None if today in adjust["no_commute"] else m.commute_call(ready_today, plan_today, today, cfg, commute, th, room, commute_wx)
    if commute_today and plan_today and plan_today.get("commute"):   # on a commute day the commute call is the day's call
        if commute_today.get("weather") and commute_today["verdict"] == "skip":   # the weather's no, not the body's: train later
            rec = {"level": plan_today["level"], "title": "Drive today, train this evening",
                   "detail": f"{commute_today['detail']} {_replaced(plan_today)[:1].upper()}{_replaced(plan_today)[1:]}."}
        else:
            level = {"skip": "rest", "easy": "easy", "optional": "easy"}.get(commute_today["verdict"], plan_today["level"])
            rec = {"level": level, "title": commute_today["title"], "detail": commute_today["detail"]}
    today_wx = _today_wx(wx, plan_today, cfg, today, now or datetime.now(), commute_today) if wx else None
    if plan:
        for d in plan["days"][:16]:
            d["wx"] = wx.outlook(date.fromisoformat(d["date"])) if wx else None

    # sleep debt and regularity over the last week / fortnight
    recent_nights = [days[_iso(today - timedelta(days=i))].get("sleep") for i in range(14) if _iso(today - timedelta(days=i)) in days]
    recent_nights = [n for n in recent_nights if n and n.get("total")]
    debt = sum(need - n["total"] / 3600 for n in recent_nights[:7]) if recent_nights else None
    mids = [x for x in (m.midpoint_minutes(n) for n in recent_nights) if x is not None]
    regularity = statistics.pstdev(mids) if len(mids) >= 5 else None

    now_row = by_day.get(t, {})
    week_ago = by_day.get(_iso(today - timedelta(days=7)), {})
    form_now = {"ctl": now_row.get("ctl"), "atl": now_row.get("atl"), "tsb": now_row.get("tsb"), "acwr": by_day.get(y, {}).get("acwr"),
                "monotony": by_day.get(y, {}).get("monotony"), "ramp": round(now_row.get("ctl", 0) - week_ago.get("ctl", 0), 1) if week_ago else None}

    chart_from = _iso(today - timedelta(days=CHART_DAYS - 1))
    sleep_from = _iso(today - timedelta(days=SLEEP_DAYS - 1))

    markers = {}
    for key in m.MARKERS:
        series = []
        for d in m.daterange(today - timedelta(days=SLEEP_DAYS - 1), today):
            k = _iso(d)
            prior = [v for v in (m.markers_for(days[x]).get(key) for x in (_iso(d - timedelta(days=i)) for i in range(1, 61)) if x in days) if v is not None]
            base = m.baseline(prior, m.MARKERS[key][2])
            v = m.markers_for(days[k]).get(key) if k in days else None
            series.append({"date": k, "v": v, "mean": round(base[0], 2) if base else None, "sd": round(base[1], 2) if base else None})
        markers[key] = {"label": m.MARKERS[key][3], "unit": m.MARKERS[key][4], "better": "higher" if m.MARKERS[key][0] > 0 else "lower", "series": series}

    sleep_rows = []
    for d in m.daterange(today - timedelta(days=SLEEP_DAYS - 1), today):
        k = _iso(d)
        n = (days.get(k) or {}).get("sleep")
        s = sleep.get(k)
        sleep_rows.append({"date": k, "score": s["score"] if s else None, "label": s["label"] if s else None, "parts": s["parts"] if s else None,
                           "hours": s["hours"] if s else None, "garmin_score": n.get("garmin_score") if n else None,
                           **{st: round((n.get(st) or 0) / 3600, 2) if n else None for st in ("deep", "light", "rem", "awake")},
                           "start": n.get("start") if n else None, "end": n.get("end") if n else None})

    weeks = _weeks(acts, today)
    pairs = _pairs(days, acts, load, sleep, ready)

    editions = {}
    for race in cfg["races"]:
        match = [w.lower() for w in race.get("match", [])]
        rows_e = []
        for a in acts:
            day = date.fromisoformat(a["start"][:10])
            near = not race["every"] or abs((day - nth_weekday(race["every"], day.year)).days) <= 7   # skips recon rides and watch parties
            if match and any(w in a["name"].lower() for w in match) and near and a["group"] == "ride" and not a.get("indoor"):
                r = by_day.get(a["start"][:10], {})
                rows_e.append({"date": a["start"][:10], "name": a["name"], "moving_s": a["moving_s"], "distance_m": a["distance_m"],
                               "elev_m": a["elev_m"], "avg_hr": a["avg_hr"], "np": a.get("np"), "ctl": r.get("ctl"), "tsb": r.get("tsb"),
                               "speed_kph": round(a["distance_m"] / a["moving_s"] * 3.6, 1) if a["moving_s"] else None})
        editions[race["name"]] = rows_e

    zones = [0.0] * 5
    for a in acts:
        if a.get("hr_zones") and a["start"][:10] >= _iso(today - timedelta(days=27)):
            zones = [z + (v or 0) for z, v in zip(zones, a["hr_zones"], strict=True)]

    weight = cfg["athlete"].get("weight_kg") or (profile or {}).get("weight_kg")
    upkeep = bike.upkeep(acts, bike_state or {}, cfg, today, wx, weight, plan["races"] if plan else [])
    races_soon = raceday.pages(plan, cfg, wx, th, weight, upkeep, today)

    ytd = [a for a in acts if a["start"][:4] == str(today.year) and a["group"] == "ride"]
    indoor = _indoor_season(acts, cfg, today)
    coverage = _coverage(days, today)

    return {
        "generated": datetime.now().isoformat(timespec="minutes"), "today": t, "athlete": th, "need_hours": need, "units": cfg["athlete"]["units"],
        "now": {"readiness": ready_today, "recommendation": rec, "base_call": m.recommend(ready_today, None), "sleep": sleep.get(t), "form": form_now,
                "sleep_debt": round(debt, 1) if debt is not None else None, "regularity_min": round(regularity) if regularity is not None else None,
                "last_night": (days.get(t) or {}).get("sleep"), "weather": today_wx},
        "pmc": [r for r in rows if r["date"] >= chart_from],
        "plan": plan,
        "variants": variants,
        "fit": {"habits": habits, "notes": fit_notes} if habits else None,
        "indoor": indoor,
        "sleep": sleep_rows,
        "markers": markers,
        "readiness": [{"date": k, "score": v["score"]} for k, v in sorted(ready.items()) if k >= sleep_from],
        "weeks": weeks,
        "zones": {"seconds": zones, "days": 28} if any(zones) else None,
        "insights": m.insights(pairs),
        "editions": editions,
        "recent": [{k: a.get(k) for k in ("start", "name", "kind", "group", "offroad", "indoor", "commute", "leg", "moving_s", "distance_m", "elev_m", "avg_hr", "np", "load", "load_src")}
                   for a in reversed(acts[-25:])],
        "ytd": {"rides": len(ytd), "hours": round(sum(a["moving_s"] for a in ytd) / 3600, 1), "km": round(sum(a["distance_m"] for a in ytd) / 1000),
                "elev_m": round(sum(a["elev_m"] for a in ytd))},
        "coverage": coverage,
        "ride": ride_config(cfg, th, plan, wx, now),
        "commute": {**commute, "today": commute_today} if commute else None,
        "fuel": _fuel(cfg, plan, rec, commute_today, today, profile),
        "bike": upkeep,
        "race_day": races_soon,
        "counts": {"days": len(days), "activities": len(acts), "first": _iso(first)},
    }


def forecast_for(store, cfg: dict, today: date, now: datetime, get=None) -> dict | None:
    """The forecast for the store's rides (weather.py): where they start, fetched or from the 50-minute cache."""
    acts = merge(store.activities())
    m.mark_commutes(acts, cfg)
    where = wxm.route(acts, cfg, today)["where"]
    return wxm.load(store, where, cfg["athlete"]["timezone"], now, get) if get else wxm.load(store, where, cfg["athlete"]["timezone"], now)


def _commute_wx(wx: wxm.Wx, route: dict, d: date, commute: dict) -> dict | None:
    """The forecast for each leg of a commute on day `d`, at your usual departure times and along the route."""
    legs, head = commute["legs"], route.get("bearing_in")
    out = {}
    for leg, heading in (("in", head), ("home", (head + 180) % 360 if head is not None else None)):
        hh, mm = (int(x) for x in route["depart"][leg].split(":"))
        out[leg] = wx.window(datetime.combine(d, datetime.min.time()).replace(hour=hh, minute=mm), legs[leg]["minutes"], heading)
    sun = wx.sun(d)
    out["sun"] = [x.strftime("%-I:%M") for x in sun] if sun else None
    return out if out["in"] or out["home"] else None


def _forecast(wx: wxm.Wx, route: dict, cfg: dict, today: date, commute: dict | None) -> dict[str, dict]:
    """For each of the next 16 days: is it a wet day for a long ride, and would a commute get rained on (or worse)?"""
    out = {}
    for i in range(16):
        d = today + timedelta(days=i)
        if d.isoformat() not in wx.days:
            break
        f = {"rain_day": wx.rain_day(d)}
        if commute and workday(d, cfg):
            legs = _commute_wx(wx, route, d, commute) or {}
            f["commute_wet"] = any(w and w["verdict"] in ("wet", "storm", "ice") for w in (legs.get("in"), legs.get("home")))
        out[d.isoformat()] = f
    return out


def _today_wx(wx: wxm.Wx, day: dict | None, cfg: dict, today: date, now: datetime, commute_today: dict | None) -> dict | None:
    """Today's weather for the Today card: on a commute day what the call already worked out; on an outdoor
    training day the best window to ride in, what to wear and whether you'll need lights."""
    units = cfg["athlete"]["units"]
    o = wx.outlook(today)
    if not o:
        return None
    out = {"outlook": o, "summary": f"{wxm.temp(o['lo'], units)} to {wxm.temp(o['hi'], units)}"
                                     + (f", {o['pop']}% chance of rain" if o["pop"] >= 30 else ", dry") + f", wind up to {wxm.speed(o['wind'], units)}"}
    if commute_today and commute_today.get("weather"):
        return {**out, "commute": commute_today["weather"]}
    if not day or day.get("indoor") or day.get("commute") or not day.get("minutes") or day["role"] in ("rest", "race", "strength"):
        return out
    evening = workday(today, cfg) and cfg["nutrition"].get("weekday_ride", "evening") == "evening"
    earliest = max(now if now.date() == today else datetime.min, datetime.combine(today, datetime.min.time()).replace(hour=17 if evening else 8))
    w = wxm.best_window(wx, today, day["minutes"], earliest)
    if not w:
        return out
    start = datetime.fromisoformat(w["start"])
    out["ride"] = {"when": f"{start.strftime('%-I:%M %p')}–{(start + timedelta(minutes=w['minutes'])).strftime('%-I:%M %p')}",
                   "line": wxm.describe(w, units), "kit": wxm.kit(w["feels"], w["verdict"] in ("wet", "showers")), "verdict": w["verdict"],
                   "lights": "Lights front and rear: part of it is in the dark." if w["dark"] else None}
    if w["verdict"] in ("wet", "storm", "ice"):
        out["ride"]["advice"] = "No dry window today: take the Plan B indoors." if day.get("alt") else "No dry window today: ride indoors."
    return out


def _outlook(plan: dict, variants: dict, habits: dict | None) -> list[str]:
    """An honest line when what you realistically ride doesn't reach a race's fitness target, and which option does."""
    if not habits:
        return []
    out = []
    for r in plan["races"]:
        if r["race_ctl"] >= r["target_ctl"] - 4:
            continue
        peak = f"peak week about {r['peak_week_h']:g} h" if r.get("peak_week_h") else f"about {habits['hours']['p75'] * 1.15:.1f} h a week"
        line = (f"Building safely from where you are ({peak}), {r['name']} race-morning "
                f"fitness lands near {r['race_ctl']:.0f} against the {r['label']}'s {r['target_ctl']:.0f}.")
        for o in r["options"]:
            v = variants.get(f"{r['name']}|{o['key']}")
            alt = next((x for x in (v or {}).get("races", []) if x["name"] == r["name"]), None)
            if alt and alt["race_ctl"] >= alt["target_ctl"] - 2:
                line += f" The {alt['label']} fits that ({alt['race_ctl']:.0f} of {alt['target_ctl']:.0f})."
                break
        else:
            line += " An extra hour a week, or a longer weekend ride, closes most of that gap."
        out.append(line)
    return out


def _rebooked(plan: dict, adjust: dict, today: date) -> list[str]:
    """Commutes the rebuilt week booked that Monday's plan didn't have: where a missed one went."""
    if not any("commute didn't happen" in n or "no commute today" in n for n in adjust["notes"]):
        return []
    sunday = today + timedelta(days=6 - today.weekday())
    new = [date.fromisoformat(d["date"]) for d in plan["days"] if d.get("commute") and today <= date.fromisoformat(d["date"]) <= sunday]
    added = [d for d in new if d not in adjust.get("base_commutes", set())]
    if added:
        days = " and ".join(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][d.weekday()] for d in added)
        return [f"To keep the week's riding, {days} {'is' if len(added) == 1 else 'are'} now a commute day."]
    return []


def _fuel(cfg: dict, plan: dict | None, rec: dict, commute_today: dict | None, today: date, profile: dict | None) -> dict | None:
    """Today's and tomorrow's meals (fitness/fuel.py), with today as readiness and the commute call left it."""
    if not plan:
        return None
    days = [dict(d) for d in plan["days"]]
    if days and days[0]["date"] == _iso(today):
        d0 = days[0]
        if commute_today and d0.get("commute") and commute_today["verdict"] == "skip" and commute_today.get("weather"):
            d0.update(commute=None)              # driving for the weather: the session moves to the evening, the eating stays
        elif commute_today and d0.get("commute") and commute_today["verdict"] == "skip":
            d0.update(commute=None, role="rest", minutes=0, load=0)
        elif commute_today and d0.get("commute") and commute_today["verdict"] in ("easy", "optional"):
            d0.update(commute="easy", commute_workout=None)
        order = ["rest", "easy", "moderate", "hard"]
        if rec.get("level") in order and d0.get("level") in order and order.index(rec["level"]) < order.index(d0["level"]):
            d0["level"] = rec["level"]          # readiness eased the day: so does the eating
            if rec["level"] == "rest":
                d0.update(role="rest", minutes=0, load=0)
    weight = cfg["athlete"].get("weight_kg") or (profile or {}).get("weight_kg")
    return fuel.plan(days, today, cfg, weight, profile)


def _weeks(acts: list[dict], today: date) -> list[dict]:
    monday = today - timedelta(days=today.weekday())
    starts = [monday - timedelta(weeks=i) for i in range(WEEKS - 1, -1, -1)]
    out = {_iso(s): {"week": _iso(s), "ride": 0.0, "commute": 0.0, "indoor": 0.0, "other": 0.0, "km": 0.0, "elev_m": 0.0, "load": 0.0} for s in starts}
    for a in acts:
        d = date.fromisoformat(a["start"][:10])
        k = _iso(d - timedelta(days=d.weekday()))
        if k not in out:
            continue
        w = out[k]
        bucket = ("indoor" if a.get("indoor") else "commute" if a.get("commute") else "ride") if a["group"] == "ride" else "other"
        w[bucket] += a["moving_s"] / 3600
        w["km"] += a["distance_m"] / 1000
        w["elev_m"] += a["elev_m"]
        w["load"] += a["load"]
    return [{k: round(v, 2) if isinstance(v, float) else v for k, v in w.items()} for w in out.values()]


def _indoor_season(acts: list[dict], cfg: dict, today: date) -> dict | None:
    """The trainer season under way, or the last one: rides, hours, load and power, and how the FTP moved."""
    if not cfg["indoor"].get("start"):
        return None
    d = today
    while not in_indoor(d, cfg) and (today - d).days < 370:
        d -= timedelta(days=1)
    if not in_indoor(d, cfg):
        return None
    start = d
    while in_indoor(start - timedelta(days=1), cfg):
        start -= timedelta(days=1)
    end = d
    while in_indoor(end + timedelta(days=1), cfg):
        end += timedelta(days=1)
    rides = [a for a in acts if a["group"] == "ride" and a.get("indoor") and _iso(start) <= a["start"][:10] <= _iso(end)]
    outdoor = [a for a in acts if a["group"] == "ride" and not a.get("indoor") and _iso(start) <= a["start"][:10] <= _iso(end)]
    nps = [a["np"] for a in rides if a.get("np")]
    return {"start": _iso(start), "end": _iso(end), "current": in_indoor(today, cfg), "rides": len(rides), "outdoor_rides": len(outdoor),
            "hours": round(sum(a["moving_s"] for a in rides) / 3600, 1), "load": round(sum(a["load"] for a in rides)),
            "avg_np": round(sum(nps) / len(nps)) if nps else None, "with_power": len(nps),
            "ftp_start": m.estimate_ftp([a for a in rides if a["start"][:10] < _iso(start + timedelta(days=30))], start + timedelta(days=30), 30) or None,
            "ftp_end": m.estimate_ftp(rides, min(end, today), 30) or None}


def _pairs(days, acts, load, sleep, ready) -> dict[str, list[tuple[float, float]]]:
    late = defaultdict(bool)
    trained = set()
    for a in acts:
        k = a["start"][:10]
        trained.add(k)
        late[k] |= a["end"][11:13] >= "19"
    pairs: dict[str, list] = defaultdict(list)
    for k in sorted(days):
        nxt = _iso(date.fromisoformat(k) + timedelta(days=1))
        s_next = sleep.get(nxt)
        if s_next:
            pairs["load→sleep"].append((load.get(k, 0), s_next["score"]))
            if k in trained:
                pairs["late→sleep"].append((1 if late[k] else 0, s_next["score"]))
            if days[k].get("steps"):
                pairs["steps→sleep"].append((days[k]["steps"], s_next["score"]))
            if days[k].get("stress") is not None:
                pairs["stress→sleep"].append((days[k]["stress"], s_next["score"]))
        if nxt in ready:
            pairs["load→ready"].append((load.get(k, 0), ready[nxt]["score"]))
        n = days[k].get("sleep")
        if n and k in sleep and n.get("start"):
            start = datetime.fromisoformat(n["start"])
            pairs["bedtime→sleep"].append(((start.hour * 60 + start.minute - 720) % 1440, sleep[k]["score"]))
    return pairs


def _coverage(days: dict[str, dict], today: date) -> list[dict]:
    """What the watch actually delivered over the last 30 days: answers "is it the hardware or a paywall?"."""
    window = [days[k] for k in (_iso(today - timedelta(days=i)) for i in range(30)) if k in days]
    nights = [d.get("sleep") or {} for d in window]
    total = max(1, len(window))
    checks = [
        ("Sleep duration", sum(1 for n in nights if n.get("total")), "Yes", "Recorded by the Venu Sq"),
        ("Deep / light sleep", sum(1 for n in nights if n.get("deep")), "Yes", "Stage estimates from HR + motion"),
        ("REM sleep", sum(1 for n in nights if n.get("rem")), "Yes", "Stage estimates from HR + motion"),
        ("Overnight stress", sum(1 for n in nights if n.get("avg_stress") is not None), "Yes", "HRV-derived; the site's HRV stand-in"),
        ("Sleeping respiration", sum(1 for n in nights if n.get("resp")), "Yes", "From the optical HR signal"),
        ("Overnight Pulse Ox", sum(1 for n in nights if n.get("spo2")), "Optional", "Turn on Pulse Ox → During Sleep (costs battery)"),
        ("Resting HR", sum(1 for d in window if d.get("rhr")), "Yes", ""),
        ("Body Battery", sum(1 for d in window if d.get("bb_high") is not None), "Yes", ""),
        ("Overnight HRV (ms)", sum(1 for n in nights if n.get("hrv")), "No", "Needs Elevate v4+ HRV Status hardware (Venu 2 and later)"),
        ("Garmin Sleep Score", sum(1 for n in nights if n.get("garmin_score")), "No", "Firmware-gated; this site scores sleep itself"),
    ]
    return [{"field": f, "days": n, "of": total, "device": dev, "note": note} for f, n, dev, note in checks]


def ride_config(cfg: dict, th: dict, plan: dict | None, wx: wxm.Wx | None = None, now: datetime | None = None) -> dict:
    """What ride mode needs, and nothing else: HR anchors, the next week of sessions with their steps, and the next
    day and a half of hourly weather (ride mode's fallback when it can't fetch the conditions where you are)."""
    days = []
    for d in (plan or {}).get("days", []):
        if d.get("legs"):
            days += [{"date": d["date"], "title": leg["title"], "session": d["session"], "minutes": leg["minutes"], "load": round(d["load"] / 2),
                      "indoor": False, "steps": leg["steps"], "leg": leg["leg"], "check": True} for leg in d["legs"]]
        elif d.get("steps") is not None:
            days.append({k: d[k] for k in ("date", "title", "session", "minutes", "load", "indoor", "steps")})
    prof = cfg["commute"].get("profile")
    models = {leg: {"model": v["model"], "speed": v["speed"], "hr": v["hr"]} for leg, v in prof["legs"].items()} if prof else None
    nxt = (plan or {}).get("races", [{}])[0] if plan else {}
    return {"lthr": th["lthr"], "max_hr": th["max_hr"], "rest_hr": round(th["rest_hr"]), "sex": th["sex"], "days": days,
            "race": {"name": nxt.get("name"), "date": nxt.get("date")} if nxt else None,
            "wheel_m": cfg["ride"]["wheel_m"], "fuel_every_min": cfg["ride"]["fuel_every_min"], "units": cfg["athlete"]["units"], "commute": models,
            "drink": {k: v for k, v in {**fuel.RIDE_FUEL, **cfg.get("nutrition", {}).get("ride_fuel", {})}.items() if k in ("name", "carbs")},
            "wx": _ride_wx(wx, now or datetime.now()) if wx else None}


def _ride_wx(wx: wxm.Wx, now: datetime) -> list[list]:
    """[hour, temp °C, feels °C, wind km/h, from °, gusts km/h, rain %] for the next 36 hours."""
    start = now.replace(minute=0, second=0, microsecond=0)
    out = []
    for i in range(36):
        key = (start + timedelta(hours=i)).strftime("%Y-%m-%dT%H:00")
        r = wx.hours.get(key)
        if r and r["temperature_2m"] is not None:
            out.append([key, round(r["temperature_2m"], 1), round(r["apparent_temperature"] if r["apparent_temperature"] is not None else r["temperature_2m"], 1),
                        round(r["wind_speed_10m"] or 0), round(r["wind_direction_10m"] or 0), round(r["wind_gusts_10m"] or 0), r["precipitation_probability"] or 0])
    return out


def _pack(obj: dict) -> str:
    packer = zlib.compressobj(9, zlib.DEFLATED, -15)
    packed = packer.compress(json.dumps(obj, separators=(",", ":")).encode()) + packer.flush()
    return base64.urlsafe_b64encode(packed).decode().rstrip("=")


def app_url(cfg: dict) -> str:
    """Where the installable app is hosted ([app] url), or "" for local-only use."""
    url = cfg.get("app", {}).get("url") or ""
    return url if not url or url.endswith("/") else url + "/"


def ride_link(cfg: dict, ride: dict, local: str) -> str:
    """The hosted ride page with the config deflated into the #fragment (never sent to the server; short enough for
    a QR code), or the local copy when no hosted page is configured."""
    base = app_url(cfg)
    return f"{base}ride.html#z={_pack(ride)}" if base else local


def phone_link(cfg: dict, data: dict) -> str | None:
    """The whole dashboard for the installed app on the phone, deflated into the #fragment (about 40 KB: a link to send
    yourself, not a QR code). The app keeps it in the phone's own storage."""
    base = app_url(cfg)
    return f"{base}#d={_pack(phone_data(data))}" if base else None


def phone_data(data: dict) -> dict:
    return {k: v for k, v in data.items() if k not in ("ride_qr", "phone_href", "ride_href")}


def ride_qr(link: str) -> str | None:
    """An inline SVG QR code of the ride link, for the phone's camera (needs the optional segno package)."""
    if not link.startswith("https://"):
        return None
    try:
        import segno
    except ImportError:
        return None
    return segno.make(link, error="l", micro=False).svg_inline(scale=1, border=4, dark="#0b0b0b", light="#ffffff", omitsize=True)   # viewBox only: CSS sizes it


def csp(html: str) -> str:
    """Fill the page's Content-Security-Policy: only its own inline scripts (by hash) may run, nothing may load, and the
    only place it may talk to is GitHub's API (the sync's private repository)."""
    hashes = [f"'sha256-{base64.b64encode(hashlib.sha256(m.group(1).encode()).digest()).decode()}'"
              for m in re.finditer(r"<script(?![^>]*application/json)[^>]*>(.*?)</script>", html, re.S)]
    policy = (f"default-src 'none'; script-src {' '.join(hashes)}; style-src 'unsafe-inline'; img-src 'self' data:; connect-src https://api.github.com https://api.open-meteo.com; manifest-src 'self'; worker-src 'self'; "
              "base-uri 'none'; form-action 'none'")   # the same policy fitness/build-app.mjs sets on the hosted pages
    return html.replace("__CSP__", policy)


def _inline(text: str, data: dict, token: str) -> str:
    return text.replace(token, json.dumps(data, separators=(",", ":")).replace("</", "<\\/"))


def ride_page(ride: dict | None) -> str:
    page = (SITE_DIR / "ride.html").read_text()
    page = (page.replace("/*__STYLE__*/", (SITE_DIR / "style.css").read_text())
                .replace("/*__RIDE_STYLE__*/", (SITE_DIR / "ride.css").read_text())
                .replace("/*__RIDE_APP__*/", (SITE_DIR / "ride.js").read_text()))
    return csp(_inline(page, ride, "__RIDE_DATA__") if ride else page.replace("__RIDE_DATA__", ""))


def render_public_ride(out: Path | None = None) -> Path:
    """ride.html with no data in it, safe to host anywhere: it gets zones and sessions from the #z= link."""
    out = out or DIST_DIR / "public" / "ride.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(ride_page(None))
    return out


def app_files(out_dir: Path, pages: list[str]) -> None:
    """The manifest, icons and service worker that make a built folder installable (when it's served over HTTPS)."""
    shutil.copytree(SITE_DIR / "icons", out_dir / "icons", dirs_exist_ok=True)
    (out_dir / "manifest.webmanifest").write_text((SITE_DIR / "manifest.webmanifest").read_text())
    version = hashlib.sha256("".join((out_dir / p).read_text() for p in pages if (out_dir / p).exists()).encode()).hexdigest()[:10]
    (out_dir / "sw.js").write_text((SITE_DIR / "sw.js").read_text().replace("__VERSION__", version))


def render(data: dict, out: Path | None = None, cfg: dict | None = None) -> Path:
    out = out or DIST_DIR / "index.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    ride_name = "ride.html" if out.name == "index.html" else f"{out.stem}-ride.html"
    if data.get("ride"):
        out.with_name(ride_name).write_text(ride_page(data["ride"]))
        href = ride_link(cfg, data["ride"], ride_name) if cfg else ride_name
        data = {**data, "ride_href": href, "ride_qr": ride_qr(href)}
    if cfg:
        data = {**data, "phone_href": phone_link(cfg, data)}
        # the data file for the phone app's Import (and an optional copy where a phone can pick it up, e.g. iCloud Drive)
        blob = json.dumps(phone_data(data), separators=(",", ":"))
        out.with_name(f"{out.stem}-data.json" if out.name != "index.html" else "fitness-data.json").write_text(blob)
        export = cfg.get("app", {}).get("export_dir")
        if export:
            target = Path(export).expanduser()
            target.mkdir(parents=True, exist_ok=True)
            (target / "fitness-data.json").write_text(blob)
    html = (SITE_DIR / "index.html").read_text()
    payload = json.dumps(data, separators=(",", ":")).replace("</", "<\\/")
    html = (html.replace("/*__STYLE__*/", (SITE_DIR / "style.css").read_text())
                .replace("/*__SHELL__*/", (SITE_DIR / "shell.js").read_text())
                .replace("/*__APP__*/", (SITE_DIR / "app.js").read_text())
                .replace("__DATA__", payload))
    out.write_text(csp(html))
    app_files(out.parent, [out.name, ride_name])
    return out
