"""Race planner: a day-by-day load target from today to race morning, chosen by simulating the fitness model.

The taper follows the evidence: a progressive (fast-decay) taper of 8-14 days cutting volume 40-60% while keeping
intensity and frequency (Bosquet et al. 2007 meta-analysis; Mujika & Padilla 2003). Every taper length in
plan.taper_days and every volume floor from 35% to 65% is simulated; the plan kept is the one that lands race-morning
form inside race.target_tsb with the most fitness left.
"""
from __future__ import annotations

import math
from datetime import date, timedelta

from fitness.metrics import ATL_DAYS, CTL_DAYS

RATE = {"rest": 1, "easy": 30, "endurance": 50, "key": 70, "long": 55, "openers": 40, "race": 1}   # TSS per hour
KEYS_BUILD = [
    "VO2 max: 5 × 3 min hard (Z5, RPE 9), 3 min easy between",
    "Race-start simulation: 3 × (2 min all-out + 8 min tempo), 5 min easy between — Iceman starts in waves at full gas",
    "Sweet spot: 3 × 12 min at 88–93% FTP (high Z3), 4 min easy between",
    "Over-unders: 3 × 9 min alternating 1 min Z4+ / 2 min Z3",
]
KEYS_TAPER = [
    "Sharpener: 5 × 1 min at race pace, 2 min easy, inside an endurance ride",
    "Race-start primer: 2 × (90 s all-out + 5 min tempo), the rest easy",
]


def roles(pattern: list[float]) -> list[str]:
    long_day = max(range(7), key=lambda i: pattern[i])
    ranked = sorted((i for i in range(7) if i != long_day and pattern[i] >= 1.1), key=lambda i: -pattern[i])[:2]
    out = []
    for i, p in enumerate(pattern):
        out.append("rest" if p <= 0 else "long" if i == long_day else "key" if i in ranked else "easy" if p < 0.6 else "endurance")
    return out


def simulate(ctl: float, atl: float, loads: list[float]) -> list[tuple[float, float, float]]:
    kc, ka = 1 - math.exp(-1 / CTL_DAYS), 1 - math.exp(-1 / ATL_DAYS)
    out = []
    for load in loads:
        tsb = ctl - atl
        ctl += (load - ctl) * kc
        atl += (load - atl) * ka
        out.append((ctl, atl, tsb))
    return out


def _loads(start: date, race: date, ctl0: float, pattern: list[float], taper: int, floor: float, ramp: float) -> tuple[list[float], list[str]]:
    mean_p = sum(pattern) / 7 or 1
    build = max(20.0, ctl0 + 6 * ramp)          # a daily mean that adds `ramp` CTL a week
    loads, phases = [], []
    for i in range((race - start).days + 1):
        d = start + timedelta(days=i)
        left = (race - d).days
        rel = pattern[d.weekday()] / mean_p
        if left == 0:
            loads.append(0.0); phases.append("race")
        elif left == 1:
            loads.append(max(20.0, 0.5 * ctl0)); phases.append("openers")
        elif left == 2:
            loads.append(0.2 * ctl0); phases.append("taper")
        elif left <= taper:
            j = taper - left
            factor = floor + (1 - floor) * math.exp(-(j + 1) / max(1.0, taper / 3))
            loads.append(build * factor * rel); phases.append("taper")
        else:
            loads.append(build * rel); phases.append("build")
    return loads, phases


def plan_race(today: date, race: date, ctl0: float, atl0: float, cfg: dict, done_today: float = 0.0) -> dict | None:
    days_out = (race - today).days
    if days_out < 0 or days_out > 70:
        return None
    pattern = cfg["plan"]["weekly_pattern"]
    lo, hi = cfg["race"]["target_tsb"]
    ramp = min(cfg["plan"]["max_ramp"], max(2.0, 0.1 * ctl0 + 1))
    t_lo, t_hi = cfg["plan"]["taper_days"]
    best = None
    for taper in range(t_lo, t_hi + 1):
        for floor in (0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65):
            loads, phases = _loads(today, race, ctl0, pattern, taper, floor, ramp)
            if done_today:
                loads[0] = done_today
            sim = simulate(ctl0, atl0, loads)
            race_ctl, _, race_tsb = sim[-1]
            miss = 0 if lo <= race_tsb <= hi else min(abs(race_tsb - lo), abs(race_tsb - hi))
            score = miss * 10 - race_ctl
            if best is None or score < best[0]:
                best = (score, taper, floor, loads, phases, sim)
    _, taper, floor, loads, phases, sim = best
    loads = _loads(today, race, ctl0, pattern, taper, floor, ramp)[0]   # show today's target even when it is already done
    role = roles(pattern)
    rows, key_n = [], {"build": 0, "taper": 0}
    for i, (load, phase, (ctl, atl, tsb)) in enumerate(zip(loads, phases, sim, strict=True)):
        d = today + timedelta(days=i)
        r = role[d.weekday()] if phase in ("build", "taper") else phase
        if phase == "taper" and (race - d).days == 2:
            r = "easy"
        if r not in ("rest", "race", "openers") and load < 10:
            r = "rest"
        title, session, level = _session(r, phase, key_n, cfg, (race - d).days)
        minutes = 0 if r in ("rest", "race") else int(round(load / RATE[r] * 60 / 5) * 5)
        rows.append({"date": d.isoformat(), "phase": phase, "role": r, "load": 0 if r in ("rest", "race") else round(load / 5) * 5, "minutes": minutes,
                     "title": title, "session": session,
                     "level": level, "ctl": round(ctl, 1), "atl": round(atl, 1), "tsb": round(tsb, 1), "done": round(done_today) if i == 0 and done_today else None})
    race_row = rows[-1]
    return {"race": race.isoformat(), "days_out": days_out, "taper_days": taper, "volume_floor": floor, "ramp": round(ramp, 1),
            "race_ctl": race_row["ctl"], "race_tsb": race_row["tsb"], "in_band": lo <= race_row["tsb"] <= hi, "target_tsb": [lo, hi], "days": rows}


def _session(role: str, phase: str, key_n: dict, cfg: dict, left: int) -> tuple[str, str, str]:
    name = cfg["race"]["name"] or "Race"
    if role == "race":
        return f"Race day — {name}", "Warm up 15 min with two 30 s efforts; 60–90 g carbs an hour from the gun; start hard, settle by the first two-track", "hard"
    if role == "openers":
        return "Openers", "40 min easy with 3 × 1 min at race pace and 3 × 10 s sprints; set tire pressure for sand, check the bike", "easy"
    if role == "rest":
        return "Rest", "Off the bike. Walk, mobility, sleep" + (" — travel and packet pickup" if left == 2 else ""), "rest"
    if role == "easy":
        return "Recovery spin", "Z1, conversational, flat", "easy"
    if role == "endurance":
        return "Endurance", "Z2 steady, cadence 85–95", "moderate"
    if role == "long":
        if phase == "build":
            return "Long ride", "MTB or gravel on sandy two-track or singletrack if you can, with 3 × 5 min surges near race effort", "hard"
        return "Shorter long ride", "Endurance pace with 3 × 3 min at race effort — keep the intensity, lose the volume", "moderate"
    lib = KEYS_BUILD if phase == "build" else KEYS_TAPER
    session = lib[key_n[phase] % len(lib)]
    key_n[phase] += 1
    return ("Key session" if phase == "build" else "Taper sharpener"), session, "hard"
