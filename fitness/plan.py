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

from fitness.config import race_dates, workday
from fitness.metrics import ATL_DAYS, CTL_DAYS
from fitness.workouts import commute_legs, steps_for

KC, KA = 1 - math.exp(-1 / CTL_DAYS), 1 - math.exp(-1 / ATL_DAYS)
FLOORS = (0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65)
RACE_IF = 0.88                                    # race-day TSS per hour = IF² × 100
RATE = {"rest": 1, "easy": 30, "endurance": 50, "key": 70, "long": 55, "openers": 40, "race": 1, "strength": 25, "fun": 45}   # TSS / hour outdoors
INDOOR_RATE = 1.15                                # no coasting on a trainer: more TSS per hour
LEVEL = {"rest": "rest", "easy": "easy", "endurance": "moderate", "fun": "moderate", "strength": "moderate", "key": "hard", "long": "hard",
         "openers": "easy", "race": "hard"}
HORIZON = 400
DOW = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
# rides home that suit a flat, open commute: steady efforts, nothing that needs a climb or an empty road to sprint on
COMMUTE_WORKOUTS = [
    "2 × 15 min sweet spot (92–97% of threshold HR), 5 min easy between",
    "30 min steady tempo (88–93% of threshold HR)",
    "3 × 8 min at threshold (95–100% of threshold HR), 4 min easy between",
    "3 × 10 min at race effort (90–96% of threshold HR), 5 min easy between",
]
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

# weekend endurance rides outdoors in base and build: Z2 riding with the handling and racecraft the next race asks for
SKILLS = {
    "mtb": [   # Iceman: a fast wave start, then sandy two-track and singletrack where handling saves more than watts
        "Singletrack flow: Z2 on singletrack; lap one twisty section 4–5 times — brake before the corner, eyes through it, off the brakes at the apex",
        "Sand and two-track: Z2 on sandy two-track; through the soft stuff stay seated, weight back, one gear heavier, smooth torque — don't steer, steer with the hips",
        "Race starts: Z2 with 4 × (standing start from a track stand → 30 s hard → 2 min at threshold); the wave start decides where you ride the first singletrack",
        "Short climbs and remounts: Z2 with 6 punchy climbs out of the saddle; on two of them dismount, run five steps and remount clean",
        "Fuel on rough ground: Z2 on two-track; a sip every 10 min and a bite every 20 without stopping or slowing",
    ],
    "gravel": [   # Barry-Roubaix: a fast mass start, group riding at speed, Sager Road, rolling hills
        "Paceline: Z2 group ride; hold a wheel at half a bike length, take 30–60 s pulls and pull off smoothly — the race is won in the groups",
        "Loose corners and descents: Z2 on dirt roads; descend in the drops with light hands, outside pedal down, brake before the turn",
        "Rolling hills at tempo: Z2 with 6–8 rollers crested at tempo (76–90% FTP), then back to Z2 on the far side — Barry's terrain",
        "Eating at speed: Z2 on gravel; every 20 min drink and open a gel one-handed while holding a straight line in the drops",
        "Sand and washboard: Z2 on loose gravel; pick lines through soft patches early and stay seated with a steady cadence over washboard",
    ],
}


def roles(pattern: list[float]) -> list[str]:
    """Each weekday's job: the biggest day is the long ride; the two next-biggest riding days carry the week's
    intensity, preferably not back to back with each other or the long ride; light days are easy, the rest endurance."""
    long_day = max(range(7), key=lambda i: pattern[i])
    cands = sorted((i for i in range(7) if i != long_day and pattern[i] >= 0.6), key=lambda i: -pattern[i])
    keys: list[int] = []
    for i in cands:
        if len(keys) < 2 and all((i - k) % 7 not in (1, 6) for k in [*keys, long_day]):
            keys.append(i)
    for i in cands:                                       # a crowded week: the next best, adjacent or not
        if len(keys) < 2 and i not in keys:
            keys.append(i)
    out = []
    for i, p in enumerate(pattern):
        out.append("rest" if p <= 0 else "long" if i == long_day else "key" if i in keys else "easy" if p < 0.6 else "endurance")
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


def _phase(d: date, race: dict, taper_start: date, prev_race: date | None, cfg: dict) -> str:
    left = (race["date"] - d).days
    if left == 0:
        return "race"
    if left == 1:
        return "openers"
    if d >= taper_start:
        return "taper"
    if prev_race and 0 < (d - prev_race).days <= 7:
        return "recovery"
    if in_indoor(d, cfg):
        return "base"
    return "transition" if left > 16 * 7 else "build"


def _role(phase: str, base: str, left: int) -> str:
    if phase == "recovery":
        return {"key": "easy", "long": "endurance", "endurance": "easy"}.get(base, base)
    if phase == "transition":
        return {"key": "strength", "endurance": "fun"}.get(base, base)
    if phase in ("race", "openers"):
        return phase
    if phase == "taper" and left == 2:
        return "easy"
    return base


def commute_loads(cfg: dict) -> dict:
    """Training load and minutes of a round trip, by how it's ridden: learned from past commutes when there are any."""
    prof = cfg["commute"].get("profile")
    legs = prof["legs"] if prof else {leg: {"load": round(cfg["commute"]["km_each_way"] / 26 * 50), "minutes": round(cfg["commute"]["km_each_way"] / 26 * 60)} for leg in ("in", "home")}
    z_in, z_home = legs["in"]["load"], legs["home"]["load"]
    return {"endurance": z_in + z_home, "easy": round(0.73 * (z_in + z_home)), "workout": round(0.8 * z_in + z_home + 25),
            "minutes": legs["in"]["minutes"] + legs["home"]["minutes"], "legs": legs}


def _commute_mode(phase: str, role: str, left: int, recovery_week: bool, indoor: bool, cfg: dict, d: date | None = None) -> str | None:
    """How a commute on this day would be ridden, or None when it shouldn't be a bike day. Only work days (Monday to
    Friday, not a federal holiday). A rest day is a candidate too, ridden easy, for weeks that need it."""
    if d is not None and not workday(d, cfg):
        return None
    if phase in ("race", "openers") or left < 3 or role == "long":
        return None
    if role == "rest":
        return "easy" if phase in ("base", "build", "transition") and not recovery_week and not (indoor and not cfg["commute"].get("winter")) else None
    if (indoor or phase == "base") and not cfg["commute"].get("winter"):
        return None
    if phase in ("recovery", "taper") or recovery_week:
        return "easy"
    if phase == "transition":
        return "endurance" if role == "fun" else "easy"
    return {"key": "workout", "endurance": "endurance", "easy": "easy"}.get(role)


def _plan_commutes(week: list[dict], cfg: dict, done: int = 0) -> dict[date, str]:
    """Pick this week's commute days: the most preferred days whose round trip fits the load the plan wanted that day,
    up to per_week[1]; then the closest fits until per_week[0] is met. Commutes replace that day's session. `done`
    commutes already ridden this week count toward both numbers, so a missed one is rebooked and none is doubled."""
    c = cfg["commute"]
    loads = commute_loads(cfg)
    lo, hi = max(0, c["per_week"][0] - done), max(0, c["per_week"][1] - done)
    order = {d: i for i, d in enumerate(c["days"])}
    cands = [w for w in week if w["mode"] and (DOW[w["date"].weekday()] in order or w.get("rest"))]
    for w in cands:
        w["ratio"] = loads[w["mode"]] / max(w["target"], 1.0)
    planned = [w for w in cands if not w.get("rest")]
    chosen = [w for w in sorted(planned, key=lambda w: order.get(DOW[w["date"].weekday()], 9)) if w["ratio"] <= 1.6][:hi]
    # short of the week's minimum: the closest fits, then a rest day ridden easy (its rest moves; see _generate)
    for w in sorted(cands, key=lambda w: (bool(w.get("rest")), w["ratio"])):
        if len(chosen) >= lo:
            break
        if w not in chosen and (w["ratio"] <= 3 or w.get("rest")):
            chosen.append(w)
    return {w["date"]: w["mode"] for w in chosen}


def _generate(start: date, race: dict, ctl: float, atl: float, cfg: dict, prev_race: date | None, taper: int, floor: float, done_today: float,
              adapt: dict | None = None) -> list[dict]:
    opt, pattern = race["opt"], cfg["plan"]["weekly_pattern"]
    mean_p = sum(pattern) / 7 or 1
    role_of = roles(pattern)
    taper_start = race["date"] - timedelta(days=taper)
    rows, mean, phase_now, week, taper_base, commutes = [], None, None, 0, None, {}
    rested: set[date] = set()
    d = start
    while d <= race["date"]:
        left = (race["date"] - d).days
        indoor = in_indoor(d, cfg)
        phase = _phase(d, race, taper_start, prev_race, cfg)
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
                if cfg["plan"].get("cap_mean"):            # fitted to your riding (plan.fit): your busy week + 15%
                    mean = max(15.0, min(mean, cfg["plan"]["cap_mean"]))
        role = _role(phase, role_of[d.weekday()], left)
        moved = (adapt or {}).get("roles", {}).get(d) if phase in ("base", "build", "transition") else None
        if moved:
            role = moved
        if d in rested and not moved:
            role = moved = "rest"
        if cfg["commute"].get("enabled") and (d == start or d.weekday() == 0):   # book this week's commutes
            week_days = []
            for i in range(7 - d.weekday()):
                e = d + timedelta(days=i)
                if e > race["date"]:
                    break
                ph, le = _phase(e, race, taper_start, prev_race, cfg), (race["date"] - e).days
                ro = _role(ph, role_of[e.weekday()], le)
                est = (mean if mean is not None and ph == phase else max(15.0, 0.8 * ctl)) * pattern[e.weekday()] / mean_p
                ro = ((adapt or {}).get("roles", {}).get(e) if ph in ("base", "build", "transition") else None) or ro
                gone = d == start and e in (adapt or {}).get("no_commute", ())
                week_days.append({"date": e, "target": est, "role": ro, "rest": ro == "rest",
                                  "mode": None if gone else _commute_mode(ph, ro, le, recovery_week and ph == phase, in_indoor(e, cfg), cfg, e)})
            commutes = _plan_commutes(week_days, cfg, (adapt or {}).get("commutes_done", 0) if d == start else 0)
            # a rest day that became a commute hands its rest to the week's lightest easy day: one full day off stays
            for w in week_days:
                if w["rest"] and w["date"] in commutes:
                    spare = [x for x in week_days if x["role"] == "easy" and x["date"] not in commutes and x["date"] > w["date"] - timedelta(days=7)]
                    if spare:
                        rested.add(min(spare, key=lambda x: x["target"])["date"])
        # a moved session carries the load of the day it was planned on (Saturday's long ride on Sunday is still long)
        rel = (pattern[role_of.index(moved)] if moved in role_of else pattern[d.weekday()] if not moved else 0.0) / mean_p
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
            load = max(0.75 * rate, min(load, 2.0 * rate))   # 45 min at least: shorter isn't a workout
        if role not in ("rest", "race", "openers") and load < 10:
            role, load = "rest", 0.0
        commute = commutes.get(d) if cfg["commute"].get("enabled") else None
        if commute:   # the commute is the day's session, at what a round trip actually costs
            role, load = "commute", float(commute_loads(cfg)[commute])
        sim = done_today if (d == start and done_today) else load
        tsb = ctl - atl
        ctl += (sim - ctl) * KC
        atl += (sim - atl) * KA
        rows.append({"date": d, "phase": phase, "role": role, "load": load, "indoor": indoor, "recovery_week": recovery_week, "commute": commute,
                     "ctl": ctl, "atl": atl, "tsb": tsb, "left": left, "rate": rate})
        d += timedelta(days=1)
    return rows


def _segment(start: date, race: dict, ctl: float, atl: float, cfg: dict, prev_race: date | None, done_today: float,
             adapt: dict | None = None) -> tuple[list[dict], dict]:
    lo, hi = race["target_tsb"]
    t_lo, t_hi = race["opt"]["taper_days"]
    best = None
    for taper in range(t_lo, t_hi + 1):
        for floor in FLOORS:
            rows = _generate(start, race, ctl, atl, cfg, prev_race, taper, floor, done_today, adapt)
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


def season(today: date, ctl0: float, atl0: float, cfg: dict, done_today: float = 0.0, choices: dict[str, str] | None = None,
           adapt: dict | None = None) -> dict | None:
    races, last = upcoming(cfg, today, choices)
    if not races:
        return None
    rows, summaries = [], []
    start, ctl, atl, prev = today, ctl0, atl0, last
    for race in races:
        seg, summary = _segment(start, race, ctl, atl, cfg, prev, done_today if start == today else 0.0, adapt if start == today else None)
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
        if r["role"] == "commute":
            minutes = commute_loads(cfg)["minutes"]
            workout = COMMUTE_WORKOUTS[(counters["commute"] + (3 if race["kind"] == "gravel" else 0)) % len(COMMUTE_WORKOUTS)] if r["commute"] == "workout" else None
            if workout:
                counters["commute"] += 1
            title, session = _commute_session(r["commute"], workout, cfg)
            legs = commute_legs(r["commute"], workout, commute_loads(cfg)["legs"]) if i < STEP_DAYS else None
            steps, level = None, {"workout": "hard", "endurance": "moderate", "easy": "easy"}[r["commute"]]
        else:
            minutes = 0 if r["role"] in ("rest", "race") else int(round(r["load"] / r["rate"] * 60 / 5) * 5)
            title, session = _session(r, race, cfg, counters, ftp_tests)
            steps = steps_for(r.get("key"), title, minutes, race["opt"]["hours"], race["opt"]["long_ride_h"]) if i < STEP_DAYS else None
            workout, legs, level = None, None, LEVEL[r["role"]]
        out.append({"steps": steps, "legs": legs, "commute": r["commute"], "commute_workout": workout,
                    "date": d.isoformat(), "phase": r["phase"], "role": r["role"], "indoor": r["indoor"], "recovery_week": r["recovery_week"],
                    "race": r["race"], "load": 0 if r["role"] in ("rest", "race") else round(r["load"] / 5) * 5, "minutes": minutes,
                    "title": title, "session": session, "level": level, "alt": _plan_b(r, title, minutes, cfg),
                    "ctl": round(r["ctl"], 1), "atl": round(r["atl"], 1), "tsb": round(r["tsb"], 1),
                    "done": round(done_today) if i == 0 and done_today else None})
    return out


def _plan_b(r: dict, title: str, minutes: int, cfg: dict) -> str | None:
    """The day's fallback when the weather or the clock gets in the way: what keeps most of the training for the
    least, so there's always something sensible to do instead of nothing."""
    role, phase, indoor = r["role"], r["phase"], r["indoor"]
    apps = " / ".join(a.capitalize() if a != "mywoosh" else "MyWoosh" for a in cfg["indoor"]["apps"]) or "the trainer"

    def short(m: int) -> str:
        return f"{m // 60}h{m % 60:02d}" if m >= 60 else f"{m} min"
    if role == "commute":
        return {"workout": f"No ride in (weather): the same workout on {apps} this evening, 60 min in ERG.",
                "endurance": f"No ride in (weather): 60 min Z2 on {apps} this evening, or 45 min if the day ran long.",
                }.get(r["commute"], "No ride in: a 30 min Z1 spin this evening, or simply take the day.")
    if role == "rest":
        if phase in ("race", "openers", "taper", "recovery") or r["left"] <= 3:
            return None
        return "Feeling great? A 30–45 min Z1 spin or a walk; nothing harder. Rest is what turns the week's work into fitness."
    if role in ("race", "openers", "fun", "strength"):
        return None
    if role == "long":
        if indoor:
            return f"Short on time: 90 min on {apps} with 3 × 15 min at tempo keeps most of it; skip the rest."
        return (f"Rain: swap with tomorrow if tomorrow's dry, or {short(min(minutes, 150))} on {apps} (a trainer hour is denser than a road one). "
                "Short on time: 2 h with 3 × 15 min at tempo.")
    if role == "key":
        if indoor:
            return "Short on time: warm up 10 min, do half the intervals, cool down. Quality over quantity."
        return f"Rain: the same session on {apps} in ERG. Short on time: warm up 10 min, half the intervals, cool down."
    if role == "endurance":
        if title == "Skills ride":
            return f"Rain: {short(min(minutes, 75))} Z2 on {apps}, plus 10 min of track stands and slow-speed balance in the garage."
        return f"Rain or short on time: {short(min(minutes, 60))} Z2 on {apps}." if not indoor else "Short on time: 45 min Z2 beats skipping it."
    if role == "easy":
        return "Or a 30–45 min walk: recovery counts off the bike too."
    return None


def _commute_session(mode: str, workout: str | None, cfg: dict) -> tuple[str, str]:
    km, climb = cfg["commute"]["km_each_way"], cfg["commute"]["climb_m"][1]
    if mode == "workout":
        return "Commute + workout", f"In: easy Z1–Z2. Home: 10 min easy, then {workout}; the rest Z2 ({km} km each way)"
    if mode == "endurance":
        return "Commute · endurance", f"Z2 both ways, steady — {km} km each way; hold the range on the ride home's {climb} m"
    return "Commute · easy", f"Z1 both ways, soft-pedal — {km} km each way; arrive fresh"


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
        if not indoor and d.weekday() >= 5 and phase in ("base", "build"):
            name = "gravel" if gravel else "mtb"
            lib = SKILLS[name]
            session = lib[counters["skills_" + name] % len(lib)]
            counters["skills_" + name] += 1
            return "Skills ride", session
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
                    "keys": [d["title"] for d in ds if d["role"] in ("key", "long", "race") or d.get("commute") == "workout"],
                    "commutes": sum(1 for d in ds if d.get("commute")), "race": next((d["race"] for d in ds if d["phase"] == "race"), None),
                    "days": len(ds)})
    return out


DAY = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
COMMUTE_BY, LONG_BY = 10, 19          # local hour by which a commute day's ride in, or a long ride, should be on the watch


def adapt(today: date, now_hour: int, cfg: dict, load_by_day: dict[str, float], commute_days: set[date], state: dict[str, dict]) -> dict:
    """What this week's plan has to absorb: sessions that didn't happen, and what to do about them.

    The plan is rebuilt from scratch at every sync, so this works it out the same way: the week as it was planned on
    Monday (Monday's fitness through the same planner) against the load actually logged each day.
    - A missed long ride moves to the next free day this week (Saturday's to Sunday); a missed key session to a free
      day with no hard day either side; with no such day it's dropped, not crammed in.
    - A missed commute is rebooked: commutes already ridden count toward the week's per_week, the rest are re-picked.
    - Today: no ride in by 10:00 on a commute day means no commute (the session it replaced is back, for the evening);
      nothing logged by 19:00 on a long-ride day means it moves to tomorrow if tomorrow is free.
    Recovery weeks, tapers and race weeks aren't rearranged. Fitness lost to a missed day is made up the slow way: the
    next weeks' ramp toward the race target recomputes from the fitness you actually have.
    """
    out: dict = {"roles": {}, "commutes_done": 0, "no_commute": set(), "notes": []}
    monday = today - timedelta(days=today.weekday())
    week = [monday + timedelta(days=i) for i in range(7)]
    out["commutes_done"] = sum(1 for d in commute_days if monday <= d < today)   # today's, if ridden, is today's booking
    prior = state.get((monday - timedelta(days=1)).isoformat(), {"ctl": 0.0, "atl": 0.0})
    base = season(monday, prior["ctl"], prior["atl"], cfg) if cfg.get("races") else None
    if not base:
        return out
    planned = {date.fromisoformat(d["date"]): d for d in base["days"] if date.fromisoformat(d["date"]) in week}
    done = {d: load_by_day.get(d.isoformat(), 0.0) for d in week}
    out["base_commutes"] = {d for d, p in planned.items() if p.get("commute")}

    def missed(d: date) -> bool:
        p = planned.get(d)
        if not p:
            return False
        if p.get("commute"):                      # a commute day counts when the commute was ridden, whatever its load
            return d not in commute_days
        return p["load"] >= 20 and done[d] < 0.5 * p["load"]

    misses = [d for d in week if d < today and missed(d)]
    p_today = planned.get(today)
    if p_today and p_today.get("commute") and now_hour >= COMMUTE_BY and today not in commute_days:
        out["no_commute"].add(today)
        out["notes"].append(f"No ride in this morning, so no commute today: {_replaced(p_today)}.")
    if p_today and p_today["role"] == "long" and now_hour >= LONG_BY and missed(today):
        misses.append(today)
        out["roles"][today] = "rest"

    def free(d: date) -> bool:
        p = planned.get(d)
        if not p or d < today or (d == today and (now_hour >= 12 or done[d] >= 10 or today in misses)):
            return False
        return p["role"] in ("endurance", "easy", "fun") and not p.get("commute") and p["phase"] in ("base", "build", "transition") \
            and d not in out["roles"]

    def hard(d: date) -> bool:
        role = out["roles"].get(d) or (planned.get(d) or {}).get("role")
        return role in ("key", "long", "race")

    for d in misses:
        p = planned[d]
        if p.get("commute") and d != today:
            out["notes"].append(f"{DAY[d.weekday()]}'s commute didn't happen.")
            continue
        if p["role"] not in ("long", "key") or p["phase"] not in ("base", "build", "transition"):
            continue
        what = "long ride" if p["role"] == "long" else "key session"
        when = "today's" if d == today else f"{DAY[d.weekday()]}'s"
        spot = next((e for e in week if free(e) and (p["role"] == "long" or not (hard(e - timedelta(days=1)) or hard(e + timedelta(days=1))))), None)
        if spot:
            out["roles"][spot] = p["role"]
            out["notes"].append(f"{when.capitalize()} {what} didn't happen: it's on {'today' if spot == today else DAY[spot.weekday()]} instead.")
        else:
            out["notes"].append(f"{when.capitalize()} {what} didn't happen. No free day is left this week for it, so the plan carries on "
                                "rather than cramming it in; the coming weeks' targets already account for it.")
    return out


def _replaced(p: dict) -> str:
    """What a commute day turns into when the commute doesn't happen."""
    if p.get("commute") == "workout":
        return "do the planned workout this evening instead, on the trainer or outside"
    if p.get("commute") == "endurance":
        return "an hour of steady Z2 this evening keeps the week on track, trainer or outside"
    return "an easy spin this evening, or simply take the day"


def fit(cfg: dict, habits: dict | None) -> tuple[dict, list[str]]:
    """The plan fitted to how you actually ride (metrics.habits, the last 12 weeks), so it asks for what fits your life
    and stretches it a little, instead of a template. Off with [plan] fit = false; unchanged until 6 weeks of riding.

    - Week shape: the configured weekly_pattern blended half-and-half with your own (how often you ride each weekday ×
      how long), with one full rest day. Days you rarely ride stay light options, not forced rest.
    - Volume: a week's load target is capped at your usual busy week (75th percentile) + 15%. As you ride more, the
      cap rises with you; the race target is then approached as fast as that allows.
    - Long rides: capped at your usual long ride + 25% (at least 1½ h), never above the race option's own.
    - Commutes: your commuting days, most-used first, and how many you really do in a week (25th–75th percentile).
    """
    if not habits or not cfg["plan"].get("fit", True):
        return cfg, []
    notes: list[str] = []
    cp = cfg["plan"]["weekly_pattern"]
    # commutes are booked on their own, so the week's shape comes from the rest of your riding
    obs = [d.get("free_p", d["p"]) * d.get("free_minutes", d["minutes"]) for d in habits["days"]]
    if sum(obs) <= 0:
        return cfg, []
    scale = sum(cp) / sum(obs)
    pattern = [round(0.5 * c + 0.5 * o * scale, 2) for c, o in zip(cp, obs, strict=True)]
    for i, d in enumerate(habits["days"]):            # a day you usually commute keeps room for the commute
        if d.get("commute_p", 0) >= 0.5:
            pattern[i] = max(pattern[i], cp[i])
    # one full rest day a week: the configured one, else the day you ride least. A day you rarely ride isn't forced
    # off: it keeps a small share of the week, so the planner can use it (an easy spin, an extra commute) as you grow
    if 0.0 not in pattern:
        pattern[min(range(7), key=lambda i: (cp[i] > 0, obs[i]))] = 0.0
    # the long ride stays on your long-ride day: the configured one if you ride it, else your longest free ride's day
    long_day = max(range(7), key=lambda i: cp[i])
    if habits["days"][long_day].get("free_p", habits["days"][long_day]["p"]) < 0.4:
        long_day = max(range(7), key=lambda i: obs[i])
    top = max(pattern)
    if pattern[long_day] < top:
        pattern[long_day] = round(top + 0.1, 2)
    rest = [DAY[i] + "s" for i in range(7) if pattern[i] == 0]
    notes.append(f"Rest day: {', '.join(rest)}. On a work day it can become an easy commute when the week needs the riding and you're recovered.")
    plan_cfg = {**cfg["plan"], "weekly_pattern": pattern}
    if habits["load"]["p75"] > 0:
        plan_cfg["cap_mean"] = habits["load"]["p75"] * 1.15 / 7
        notes.append(f"Weekly volume up to your usual busy week + 15% (about {habits['hours']['p75'] * 1.15:.1f} h); it grows as you do.")
    races = cfg["races"]
    if habits["long_min"]["p75"]:
        cap_h = max(1.5, habits["long_min"]["p75"] / 60 * 1.25)
        races = [{**r, "options": {k: {**o, "long_ride_h": round(min(o["long_ride_h"], cap_h), 2)} for k, o in r["options"].items()}} for r in races]
        if any(o["long_ride_h"] > cap_h for r in cfg["races"] for o in r["options"].values()):
            notes.append(f"Long rides up to {int(cap_h)}h{round(cap_h % 1 * 60):02d}: your usual long ride + 25%, growing as yours do.")
    commute_cfg = cfg["commute"]
    c = habits["commutes"]
    if commute_cfg.get("enabled") and c["p75"] >= 1:
        used = sorted((i for i, d in enumerate(habits["days"]) if d["commute_p"] >= 0.15), key=lambda i: -habits["days"][i]["commute_p"])
        days = [DOW[i] for i in used] + [d for d in commute_cfg["days"] if d not in [DOW[i] for i in used]]
        lo, hi = max(1, int(c["p25"])), max(1, int(round(c["p75"])))
        commute_cfg = {**commute_cfg, "days": days, "per_week": [min(lo, hi), hi]}
        names = [DAY[i] + "s" for i in used[:3]]
        listed = ", ".join(names[:-1]) + (" and " if len(names) > 1 else "") + names[-1] if names else ""
        notes.append(f"Commutes: {lo if lo == hi else f'{lo}–{hi}'} a week" + (f", {listed} first" if listed else "") + ", like you do.")
    return {**cfg, "plan": plan_cfg, "races": races, "commute": commute_cfg}, notes
