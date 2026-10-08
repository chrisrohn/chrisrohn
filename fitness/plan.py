"""Season planner: a day-by-day load target from today through every configured race, chosen by simulating the
fitness model.

Each stretch to the next race is periodized. After a race comes a recovery week. Before the trainer season it's
transition: strength, unstructured riding, and fitness allowed to drift down. Then the indoor base on Zwift or
MyWoosh, which climbs at most plan.base_ramp CTL a week with every 4th week easy. Then the outdoor build, at
most plan.max_ramp a week, and finally the taper. Each phase steers toward the race option's target_ctl.

The taper follows the evidence: a progressive (fast-decay) taper of 8-14 days cutting volume 41-60% while keeping
intensity and frequency (Bosquet et al. 2007 meta-analysis; Mujika & Padilla 2003). Every taper length in the
option's taper_days range and every volume floor from 35% to 65% is simulated. The plan kept is the one that lands
race-morning form inside the race's target_tsb with the most fitness left.
"""
from __future__ import annotations

import math
from collections import Counter
from datetime import date, timedelta

from fitness.config import race_dates
from fitness.metrics import ATL_DAYS, CTL_DAYS
from fitness.workouts import steps_for

KC, KA = 1 - math.exp(-1 / CTL_DAYS), 1 - math.exp(-1 / ATL_DAYS)
FLOORS = (0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65)
RACE_IF = 0.88                                    # race-day TSS per hour = IF² × 100
RATE = {"rest": 1, "easy": 30, "endurance": 50, "key": 70, "long": 55, "openers": 40, "race": 1, "strength": 25, "fun": 45}   # TSS / hour outdoors
INDOOR_RATE = 1.15                                # no coasting on a trainer: more TSS per hour
LEVEL = {"rest": "rest", "easy": "easy", "endurance": "moderate", "fun": "moderate", "strength": "moderate", "key": "hard", "long": "hard",
         "openers": "easy", "race": "hard"}
HORIZON = 400
STEP_DAYS = 7                                     # days that carry structured steps for ride mode

SESSIONS = {
    "mtb": [
        "VO2 max: 5 × 3 min hard (Z5, RPE 9), 3 min easy between",
        "Race-start simulation: 3 × (2 min all-out + 8 min tempo), 5 min easy between — Iceman starts in waves at full gas",
        "Sweet spot: 3 × 12 min at 88–93% FTP (high Z3), 4 min easy between",
        "Over-unders: 3 × 9 min alternating 1 min Z4+ / 2 min Z3",
    ],
    "gravel": [
        "Gravel threshold: 3 × 12 min at 95–100% FTP on rolling dirt roads, 5 min easy between",
        "VO2 max: 5 × 4 min at 110–120% FTP, 4 min easy between",
        "Punchy hills: 8–10 × 1 min hard over short climbs, roll back down easy — the shape of a Barry-Roubaix hill",
        "Race simulation: 90 min with 4 × 8 min at race effort and a fast first 10 min; practice drinking at speed",
    ],
    "indoor": [
        "Sweet spot: 3 × 15 min at 88–93% FTP in ERG, 5 min easy between",
        "Tempo: 2 × 25 min at 80–85% FTP, cadence 85–95",
        "Threshold: 4 × 8 min at 95–100% FTP, 4 min easy between",
        "Over-unders: 3 × 10 min alternating 2 min at 105% / 2 min at 90% FTP",
        "Cadence + sweet spot: 5 × 1 min at 110 rpm, then 2 × 20 min at 88–90% FTP",
    ],
    "indoor_late": [   # the last month of the trainer season adds the top end the outdoor build will need
        "VO2 max: 5 × 4 min at 110–120% FTP in ERG, 4 min easy between",
        "Threshold: 3 × 12 min at 95–100% FTP, 5 min easy between",
        "30/30s: 3 sets of 8 × (30 s at 130% / 30 s at 50% FTP), 5 min between",
        "Sweet spot long: 2 × 30 min at 88–92% FTP",
    ],
    "taper": [
        "Sharpener: 5 × 1 min at race pace, 2 min easy, inside an endurance ride",
        "Race-start primer: 2 × (90 s all-out + 5 min tempo), the rest easy",
    ],
}


def roles(pattern: list[float]) -> list[str]:
    long_day = max(range(7), key=lambda i: pattern[i])
    ranked = sorted((i for i in range(7) if i != long_day and pattern[i] >= 1.1), key=lambda i: -pattern[i])[:2]
    out = []
    for i, p in enumerate(pattern):
        out.append("rest" if p <= 0 else "long" if i == long_day else "key" if i in ranked else "easy" if p < 0.6 else "endurance")
    return out


def in_indoor(d: date, cfg: dict) -> bool:
    ind = cfg["indoor"]
    if not ind.get("start") or not ind.get("end"):
        return False
    sm, sd = (int(x) for x in ind["start"].split("-"))
    em, ed = (int(x) for x in ind["end"].split("-"))
    end = (em, 29) if (em, ed) == (2, 28) else (em, ed)     # "through Feb 28" means through the end of February
    md = (d.month, d.day)
    return (sm, sd) <= md <= end if (sm, sd) <= end else (md >= (sm, sd) or md <= end)


def simulate(ctl: float, atl: float, loads: list[float]) -> list[tuple[float, float, float]]:
    out = []
    for load in loads:
        tsb = ctl - atl
        ctl += (load - ctl) * KC
        atl += (load - atl) * KA
        out.append((ctl, atl, tsb))
    return out


def upcoming(cfg: dict, today: date, choices: dict[str, str] | None = None) -> tuple[list[dict], date | None]:
    """The races ahead (soonest first, each with its chosen option resolved) and the most recent race day behind."""
    ahead, last = [], None
    for r in cfg["races"]:
        past, nxt = race_dates(r, today)
        if past and (last is None or past > last):
            last = past
        if nxt >= today and (nxt - today).days <= HORIZON:
            key = (choices or {}).get(r["name"], r["distance"])
            key = key if key in r["options"] else r["distance"]
            ahead.append({**r, "date": nxt, "option": key, "opt": r["options"][key]})
    return sorted(ahead, key=lambda r: r["date"]), last


def _generate(start: date, race: dict, ctl: float, atl: float, cfg: dict, prev_race: date | None, taper: int, floor: float, done_today: float) -> list[dict]:
    opt, pattern = race["opt"], cfg["plan"]["weekly_pattern"]
    mean_p = sum(pattern) / 7 or 1
    role_of = roles(pattern)
    taper_start = race["date"] - timedelta(days=taper)
    rows, mean, phase_now, week, taper_base = [], None, None, 0, None
    d = start
    while d <= race["date"]:
        left = (race["date"] - d).days
        indoor = in_indoor(d, cfg)
        if left == 0:
            phase = "race"
        elif left == 1:
            phase = "openers"
        elif d >= taper_start:
            phase = "taper"
        elif prev_race and 0 < (d - prev_race).days <= 7:
            phase = "recovery"
        elif indoor:
            phase = "base"
        elif left > 16 * 7:
            phase = "transition"
        else:
            phase = "build"
        if phase != phase_now:
            phase_now, week, mean = phase, 0, None
        elif d.weekday() == 0:
            week, mean = week + 1, None
        recovery_week = phase in ("base", "build") and week % 4 == 3
        if mean is None and phase in ("base", "build", "transition", "recovery"):
            if phase == "recovery":
                mean = 0.35 * ctl
            elif phase == "transition":
                mean = max(15.0, 0.8 * ctl)
            elif recovery_week:
                mean = 0.65 * ctl
            else:
                weeks_left = max(1.0, (taper_start - d).days / 7 * 0.7)   # recovery weeks and long-ride caps give some back
                cap = cfg["plan"]["base_ramp"] if phase == "base" else cfg["plan"]["max_ramp"]
                ramp = max(-2.0, min(cap, (opt["target_ctl"] - ctl) / weeks_left))
                mean = max(15.0, ctl + 6.45 * ramp)        # Δctl over a week ≈ (mean − ctl) × 0.155
        role = role_of[d.weekday()]
        if phase == "recovery":
            role = {"key": "easy", "long": "endurance", "endurance": "easy"}.get(role, role)
        elif phase == "transition":
            role = {"key": "strength", "endurance": "fun"}.get(role, role)
        elif phase in ("race", "openers"):
            role = phase
        elif phase == "taper" and left == 2:
            role = "easy"
        rel = pattern[d.weekday()] / mean_p
        rate = RATE[role] * (INDOOR_RATE if indoor else 1)
        if phase == "race":
            load = opt["hours"] * RACE_IF ** 2 * 100
        elif phase == "openers":
            load = max(20.0, 0.5 * ctl)
        elif phase == "taper":
            if taper_base is None:
                taper_base = max(20.0, ctl * 1.15)
            if left == 2:
                load = 0.2 * ctl
            else:
                j = (d - taper_start).days
                load = taper_base * rel * (floor + (1 - floor) * math.exp(-(j + 1) / max(1.0, taper / 3)))
        else:
            load = mean * rel
        if role == "strength":
            load = min(load, 25.0)
        elif role == "long" and phase not in ("race", "openers"):
            cap_h = min(opt["long_ride_h"], cfg["indoor"]["long_ride_h"]) if indoor else opt["long_ride_h"]
            load = min(load, (2.5 if phase == "transition" else cap_h) * rate)
        elif role == "key":
            load = min(load, 2.0 * rate)
        if role not in ("rest", "race", "openers") and load < 10:
            role, load = "rest", 0.0
        sim = done_today if (d == start and done_today) else load
        tsb = ctl - atl
        ctl += (sim - ctl) * KC
        atl += (sim - atl) * KA
        rows.append({"date": d, "phase": phase, "role": role, "load": load, "indoor": indoor, "recovery_week": recovery_week,
                     "ctl": ctl, "atl": atl, "tsb": tsb, "left": left, "rate": rate})
        d += timedelta(days=1)
    return rows


def _segment(start: date, race: dict, ctl: float, atl: float, cfg: dict, prev_race: date | None, done_today: float) -> tuple[list[dict], dict]:
    lo, hi = race["target_tsb"]
    t_lo, t_hi = race["opt"]["taper_days"]
    best = None
    for taper in range(t_lo, t_hi + 1):
        for floor in FLOORS:
            rows = _generate(start, race, ctl, atl, cfg, prev_race, taper, floor, done_today)
            morning = rows[-1]
            race_ctl = rows[-2]["ctl"] if len(rows) > 1 else ctl
            miss = 0 if lo <= morning["tsb"] <= hi else min(abs(morning["tsb"] - lo), abs(morning["tsb"] - hi))
            score = miss * 10 - race_ctl
            if best is None or score < best[0]:
                best = (score, taper, floor, rows, race_ctl)
    _, taper, floor, rows, race_ctl = best
    tsb = rows[-1]["tsb"]
    summary = {"name": race["name"], "date": race["date"].isoformat(), "kind": race["kind"], "option": race["option"], "label": race["opt"]["label"],
               "options": [{"key": k, "label": v["label"]} for k, v in race["options"].items()], "km": race["opt"]["km"],
               "climbing_ft": race["opt"]["climbing_ft"], "hours": race["opt"]["hours"], "target_ctl": race["opt"]["target_ctl"],
               "race_ctl": round(race_ctl, 1), "race_tsb": round(tsb, 1), "in_band": lo <= tsb <= hi, "target_tsb": [lo, hi],
               "taper_days": taper, "volume_floor": floor, "match": race["match"]}
    return rows, summary


def season(today: date, ctl0: float, atl0: float, cfg: dict, done_today: float = 0.0, choices: dict[str, str] | None = None) -> dict | None:
    races, last = upcoming(cfg, today, choices)
    if not races:
        return None
    rows, summaries = [], []
    start, ctl, atl, prev = today, ctl0, atl0, last
    for race in races:
        seg, summary = _segment(start, race, ctl, atl, cfg, prev, done_today if start == today else 0.0)
        summary["days_out"] = (race["date"] - today).days
        for r in seg:
            r["race"] = race["name"]
        rows += seg
        summaries.append(summary)
        ctl, atl, start, prev = seg[-1]["ctl"], seg[-1]["atl"], race["date"] + timedelta(days=1), race["date"]
    days = _dress(rows, races, cfg, done_today)
    weeks = _weeks(days)
    for s in summaries:
        mine = [d for d in days if d["race"] == s["name"]]
        s["build_start"] = next((d["date"] for d in mine if d["phase"] == "build"), None)
        s["peak_week_h"] = max((w["hours"] for w in weeks if w["days"] == 7 and mine[0]["date"] <= w["week"] <= s["date"]), default=None)
    return {"races": summaries, "days": days, "weeks": weeks}


def _dress(rows: list[dict], races: list[dict], cfg: dict, done_today: float) -> list[dict]:
    by_name = {r["name"]: r for r in races}
    counters: Counter = Counter()
    ftp_tests: set[str] = set()
    out = []
    for i, r in enumerate(rows):
        race = by_name[r["race"]]
        d = r["date"]
        minutes = 0 if r["role"] in ("rest", "race") else int(round(r["load"] / r["rate"] * 60 / 5) * 5)
        title, session = _session(r, race, cfg, counters, ftp_tests)
        steps = steps_for(r.get("key"), title, minutes, race["opt"]["hours"], race["opt"]["long_ride_h"]) if i < STEP_DAYS else None
        out.append({"steps": steps,"date": d.isoformat(), "phase": r["phase"], "role": r["role"], "indoor": r["indoor"], "recovery_week": r["recovery_week"],
                    "race": r["race"], "load": 0 if r["role"] in ("rest", "race") else round(r["load"] / 5) * 5, "minutes": minutes,
                    "title": title, "session": session, "level": LEVEL[r["role"]],
                    "ctl": round(r["ctl"], 1), "atl": round(r["atl"], 1), "tsb": round(r["tsb"], 1),
                    "done": round(done_today) if i == 0 and done_today else None})
    return out


def _session(r: dict, race: dict, cfg: dict, counters: Counter, ftp_tests: set[str]) -> tuple[str, str]:
    role, phase, d, indoor = r["role"], r["phase"], r["date"], r["indoor"]
    gravel = race["kind"] == "gravel"
    apps = " / ".join(a.capitalize() if a != "mywoosh" else "MyWoosh" for a in cfg["indoor"]["apps"]) or "the trainer"
    if role == "race":
        if gravel:
            return f"Race day — {race['name']} ({race['opt']['label']})", "Warm up 15 min with two 30 s efforts; line up early and expect a fast start — position before the first dirt; 80–90 g carbs an hour"
        return f"Race day — {race['name']}", "Warm up 15 min with two 30 s efforts; 60–90 g carbs an hour from the gun; start hard, settle by the first two-track"
    if role == "openers":
        tires = "gravel tire pressure dialed" if gravel else "tire pressure set for sand"
        return "Openers", f"40 min easy with 3 × 1 min at race pace and 3 × 10 s sprints; last bike check, {tires}"
    if role == "rest":
        return "Rest", "Off the bike. Walk, mobility, sleep" + (" — travel and packet pickup" if r["left"] == 2 else "")
    if role == "strength":
        return "Strength", "45–60 min: squats or leg press, Romanian deadlifts, step-ups, core — heavy, low reps (it carries over to on-bike power)"
    if role == "fun":
        return "Ride for fun", "Unstructured: outdoor ride, hike, run or ski while you still can — no numbers"
    if role == "easy":
        return ("Recovery spin", f"{apps}: Z1 ≤ 55% FTP, free ride, no ERG") if indoor else ("Recovery spin", "Z1, conversational, flat")
    if role == "endurance":
        if phase == "recovery":
            return "Easy endurance", "Z2 only, as long as it feels good, then stop"
        return ("Endurance", f"{apps}: Z2 at 65–75% FTP in ERG, cadence 85–95") if indoor else ("Endurance", "Z2 steady, cadence 85–95")
    if role == "long":
        if phase == "transition":
            return "Long easy ride", "Outdoors while the weather allows, Z2, no structure"
        if indoor:
            return "Long trainer ride", f"{apps}: Z2 with a group ride or event to keep it honest; practice 80 g carbs an hour"
        if phase == "taper":
            return "Shorter long ride", "Endurance pace with 3 × 3 min at race effort — keep the intensity, lose the volume"
        if gravel:
            fuel = "eat 80–90 g carbs an hour and run your race tires and pressures" if race["opt"]["long_ride_h"] >= 3.5 else "with 3 × 15 min at race pace"
            return "Long gravel ride", f"Build toward {race['opt']['long_ride_h']:g} h, mostly on dirt roads; {fuel}" + (" (trainer if the roads are snowed in)" if d.month == 3 else "")
        return "Long ride", "MTB or gravel on sandy two-track or singletrack if you can, with 3 × 5 min surges near race effort"
    # key sessions
    if r["recovery_week"]:
        return "Recovery-week tune-up", ("In ERG: " if indoor else "") + "3 × 5 min at sweet spot, everything else easy"
    if indoor:
        tag = f"{d.year if d.month >= 7 else d.year - 1}-{d.month}"   # one test as the trainer season opens, one in February
        if d.month in (12, 2) and tag not in ftp_tests:
            ftp_tests.add(tag)
            return "FTP ramp test", f"{apps} ramp test, then 20 min Z2. Put the new number in config.toml (ftp) so power drives the load math"
        lib = SESSIONS["indoor_late"] if d.month == 2 else SESSIONS["indoor"]
        name = "indoor_late" if d.month == 2 else "indoor"
    elif phase == "taper":
        lib, name = SESSIONS["taper"], "taper"
    else:
        name = "gravel" if gravel else "mtb"
        lib = SESSIONS[name]
    idx = counters[name] % len(lib)
    session = lib[idx]
    counters[name] += 1
    r["key"] = (name, idx)   # workouts.LIBRARY turns it into steps
    title = "Trainer workout" if indoor else "Taper sharpener" if phase == "taper" else "Key session"
    return title, (f"{apps}: " if indoor else "") + session


def _weeks(days: list[dict]) -> list[dict]:
    weeks: dict[str, list[dict]] = {}
    for d in days:
        day = date.fromisoformat(d["date"])
        weeks.setdefault((day - timedelta(days=day.weekday())).isoformat(), []).append(d)
    out = []
    for wk, ds in weeks.items():
        phases = Counter(d["phase"] for d in ds)
        phase = next((p for p in ("race", "taper", "recovery") if p in phases), phases.most_common(1)[0][0])
        out.append({"week": wk, "phase": phase, "indoor": sum(d["indoor"] for d in ds) * 2 > len(ds), "recovery_week": sum(d["recovery_week"] for d in ds) * 2 > len(ds),
                    "hours": round(sum(d["minutes"] for d in ds) / 60, 1), "load": sum(d["load"] for d in ds), "ctl": ds[-1]["ctl"], "tsb": ds[-1]["tsb"],
                    "keys": [d["title"] for d in ds if d["role"] in ("key", "long", "race")], "race": next((d["race"] for d in ds if d["phase"] == "race"), None),
                    "days": len(ds)})
    return out
