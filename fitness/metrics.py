"""The models. All pure functions over plain dicts, so every number on the site is reproducible and testable.

Training load   per-session stress in TSS units: power TSS when there's a power meter and an FTP, else heart-rate
                TSS from Banister's TRIMP scaled so an hour at threshold HR = 100, else a duration estimate.
Fitness model   the performance-manager model: CTL (fitness, 42-day EWMA), ATL (fatigue, 7-day), TSB (form = CTL −
                ATL as of the night before), plus ACWR and Foster's monotony/strain.
Sleep score     0-100 from duration vs your need, deep and REM share against Garmin's own target ranges,
                continuity (awake time and wake-ups) and overnight stress, weighted 40/15/15/15/15.
Readiness       each overnight marker against your own 60-day normal (z-scores, HRV4Training style; the Venu Sq's
                overnight stress stands in for HRV), blended with the sleep score and penalized for deep fatigue.
"""
from __future__ import annotations

import math
import statistics
from collections import defaultdict
from datetime import date, datetime, timedelta

CTL_DAYS, ATL_DAYS = 42, 7
DURATION_IF = {"ride": 0.68, "run": 0.78, "walk": 0.45, "swim": 0.7, "strength": 0.6, "other": 0.6}


# ── thresholds ────────────────────────────────────────────────────────────────────────────────────────────

def thresholds(cfg: dict, acts: list[dict], days: dict[str, dict], today: date) -> dict:
    a = cfg["athlete"]
    recent = [x for x in acts if x.get("max_hr") and x["start"][:10] >= (today - timedelta(days=730)).isoformat()]
    maxes = sorted((x["max_hr"] for x in recent), reverse=True)
    max_hr = a["max_hr"] or (maxes[1] if len(maxes) > 1 else maxes[0] if maxes else 190)
    rhrs = [d["rhr"] for k, d in days.items() if d.get("rhr") and k >= (today - timedelta(days=30)).isoformat()]
    rest = a["resting_hr"] or (statistics.median(rhrs) if rhrs else 55)
    lthr = a["lthr"] or round(0.89 * max_hr)
    ftp = a["ftp"] or estimate_ftp(acts, today)
    return {"max_hr": max_hr, "rest_hr": rest, "lthr": lthr, "ftp": ftp, "sex": a["sex"],
            "estimated": [k for k, v in (("max_hr", a["max_hr"]), ("resting_hr", a["resting_hr"]), ("lthr", a["lthr"]), ("ftp", a["ftp"])) if not v and (k != "ftp" or ftp)]}


def estimate_ftp(acts: list[dict], today: date, days: int = 365) -> int:
    """Best normalized power over a hard 20-90 min ride in the last year (so last winter's trainer rides count in the fall), scaled to an hour: NP for 20 min
    ≈ 105% of FTP, for 60+ min ≈ FTP. A floor, not a test: the plan books ramp tests on the trainer to replace it."""
    since = (today - timedelta(days=days)).isoformat()
    best = 0.0
    for a in acts:
        minutes = a.get("moving_s", 0) / 60
        if a["group"] == "ride" and a.get("np") and 20 <= minutes <= 90 and a["start"][:10] >= since:
            best = max(best, a["np"] * (0.95 + 0.05 * min(1.0, (minutes - 20) / 40)))
    return round(best)


def trimp(minutes: float, avg_hr: float, th: dict) -> float:
    hrr = max(0.0, min(1.0, (avg_hr - th["rest_hr"]) / max(1, th["max_hr"] - th["rest_hr"])))
    k1, k2 = (0.86, 1.67) if th["sex"] == "female" else (0.64, 1.92)
    return minutes * hrr * k1 * math.exp(k2 * hrr)


def session_load(act: dict, th: dict) -> tuple[float, str]:
    hours = (act.get("moving_s") or act["duration_s"]) / 3600
    if hours <= 0:
        return 0.0, "none"
    if th["ftp"] and act.get("np") and act["group"] == "ride":
        intensity = act["np"] / th["ftp"]
        return round(hours * intensity * intensity * 100, 1), "power"
    if act.get("avg_hr") and act["avg_hr"] > th["rest_hr"] + 10:
        return round(trimp(hours * 60, act["avg_hr"], th) / trimp(60, th["lthr"], th) * 100, 1), "hr"
    intensity = 0.72 if act.get("indoor") and act["group"] == "ride" else DURATION_IF.get(act["group"], 0.6)
    return round(hours * intensity * intensity * 100, 1), "duration"


# ── fitness / fatigue / form ──────────────────────────────────────────────────────────────────────────────

def daterange(start: date, end: date) -> list[date]:
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


def daily_load(acts: list[dict], start: date, end: date) -> dict[str, float]:
    load = {d.isoformat(): 0.0 for d in daterange(start, end)}
    for a in acts:
        k = a["start"][:10]
        if k in load:
            load[k] += a.get("load", 0)
    return load


def pmc(load: dict[str, float], ctl0: float = 0.0, atl0: float = 0.0) -> list[dict]:
    """Rows per day: load, ctl/atl at the END of the day, tsb = form going INTO the day (yesterday's ctl − atl)."""
    kc, ka = 1 - math.exp(-1 / CTL_DAYS), 1 - math.exp(-1 / ATL_DAYS)
    rows, ctl, atl = [], ctl0, atl0
    keys = sorted(load)
    for i, k in enumerate(keys):
        tsb = ctl - atl
        ctl += (load[k] - ctl) * kc
        atl += (load[k] - atl) * ka
        week = [load[x] for x in keys[max(0, i - 6): i + 1]]
        month = [load[x] for x in keys[max(0, i - 27): i + 1]]
        acwr = (sum(week) / 7) / (sum(month) / 28) if sum(month) > 0 and i >= 27 else None
        sd = statistics.pstdev(week) if len(week) == 7 else 0
        monotony = statistics.mean(week) / sd if sd > 0 else None
        rows.append({"date": k, "load": round(load[k], 1), "ctl": round(ctl, 1), "atl": round(atl, 1), "tsb": round(tsb, 1),
                     "acwr": round(acwr, 2) if acwr else None, "monotony": round(monotony, 2) if monotony else None,
                     "strain": round(sum(week) * monotony) if monotony else None})
    return rows


# ── sleep ─────────────────────────────────────────────────────────────────────────────────────────────────

def clamp(x: float, lo: float = 0, hi: float = 100) -> float:
    return max(lo, min(hi, x))


def band_score(pct: float, lo: float, hi: float, below: float, above: float) -> float:
    if pct < lo:
        return clamp(100 - (lo - pct) * below)
    if pct > hi:
        return clamp(100 - (pct - hi) * above)
    return 100.0


def sleep_score(night: dict | None, need_hours: float) -> dict | None:
    if not night or not night.get("total"):
        return None
    total = night["total"]
    hours = total / 3600
    ratio = hours / need_hours
    parts = {"duration": 100.0 if ratio >= 1 else clamp(100 - (1 - ratio) * 220)}
    weights = {"duration": 0.40}
    if night.get("deep") or night.get("rem"):
        parts["deep"] = band_score(100 * (night.get("deep") or 0) / total, 16, 33, 6, 3)
        parts["rem"] = band_score(100 * (night.get("rem") or 0) / total, 21, 31, 5, 2)
        weights |= {"deep": 0.15, "rem": 0.15}
    awake_min = (night.get("awake") or 0) / 60
    parts["continuity"] = clamp(100 - max(0, awake_min - 10) * 1.5 - max(0, (night.get("awake_count") or 0) - 2) * 5)
    weights["continuity"] = 0.15
    if night.get("avg_stress") is not None:
        parts["calm"] = clamp(100 - max(0, night["avg_stress"] - 15) * 2.5)
        weights["calm"] = 0.15
    score = sum(parts[k] * w for k, w in weights.items()) / sum(weights.values())
    return {"score": round(score), "label": quality(score), "hours": round(hours, 2), "parts": {k: round(v) for k, v in parts.items()}}


def quality(score: float) -> str:
    return "Excellent" if score >= 90 else "Good" if score >= 80 else "Fair" if score >= 60 else "Poor"


def midpoint_minutes(night: dict) -> float | None:
    """Sleep midpoint as minutes from the previous noon, so 23:00-07:00 → 15h → 900."""
    if not night.get("start") or not night.get("end"):
        return None
    s, e = datetime.fromisoformat(night["start"]), datetime.fromisoformat(night["end"])
    mid = s + (e - s) / 2
    return (mid.hour * 60 + mid.minute - 720) % 1440


# ── readiness ─────────────────────────────────────────────────────────────────────────────────────────────

# marker → (direction where +1 means higher is better, weight, SD floor, label, unit)
MARKERS = {
    "rhr": (-1, 0.25, 1.5, "Resting HR", "bpm"),
    "sleep_stress": (-1, 0.25, 2.0, "Overnight stress (HRV proxy)", ""),
    "bb_wake": (1, 0.15, 5.0, "Body Battery at wake", ""),
    "resp": (-1, 0.10, 0.3, "Sleeping respiration", "brpm"),
}


def markers_for(day: dict) -> dict:
    night = day.get("sleep") or {}
    bb = day.get("bb_wake", day.get("bb_high"))   # older firmware reports no wake value; the day's peak is the morning one
    return {"rhr": day.get("rhr"), "sleep_stress": night.get("avg_stress"), "bb_wake": bb, "resp": night.get("resp")}


def baseline(series: list[float], floor: float) -> tuple[float, float] | None:
    if len(series) < 14:
        return None
    return statistics.mean(series), max(statistics.pstdev(series), floor)


def readiness(today: str, days: dict[str, dict], sleep: dict | None, form: dict | None, window: int = 60) -> dict | None:
    if today not in days or days[today].get("empty"):
        return None
    t = date.fromisoformat(today)
    prior = [days[k] for k in (d.isoformat() for d in daterange(t - timedelta(days=window), t - timedelta(days=1))) if k in days]
    now = markers_for(days[today])
    comps, reasons, z = {}, [], {}
    for key, (direction, weight, floor, label, unit) in MARKERS.items():
        value = now.get(key)
        base = baseline([m for m in (markers_for(d).get(key) for d in prior) if m is not None], floor)
        if value is None or base is None:
            continue
        mean, sd = base
        z[key] = (value - mean) / sd
        good = z[key] * direction
        if key == "resp":
            good = min(good, 0.5)      # a low breathing rate earns little; a high one is the illness signal
        comps[key] = clamp(75 + 12.5 * good)
        delta = value - mean
        if abs(z[key]) >= 1:
            word = "above" if delta > 0 else "below"
            tone = "good" if good > 0 else "bad"
            reasons.append({"tone": tone, "text": f"{label} {value:g}{(' ' + unit) if unit else ''} — {abs(delta):.1f} {word} your 60-day norm ({mean:.1f} ± {sd:.1f})"})
    weights = {k: MARKERS[k][1] for k in comps}
    if sleep:
        comps["sleep"] = sleep["score"]
        weights["sleep"] = 0.25
        if sleep["score"] < 60:
            reasons.append({"tone": "bad", "text": f"Sleep score {sleep['score']} ({sleep['label']}), {sleep['hours']:.1f} h"})
        elif sleep["score"] >= 85:
            reasons.append({"tone": "good", "text": f"Sleep score {sleep['score']} ({sleep['label']}), {sleep['hours']:.1f} h"})
    if not comps:
        return None
    score = sum(comps[k] * w for k, w in weights.items()) / sum(weights.values())
    penalty = 0.0
    if form:
        if form["tsb"] < -10:
            p = min(20, (-10 - form["tsb"]) * 0.6)
            penalty += p
            reasons.append({"tone": "bad", "text": f"Form {form['tsb']:+.0f}: carrying real fatigue (−{p:.0f})"})
        if form.get("acwr") and form["acwr"] > 1.3:
            p = min(15, (form["acwr"] - 1.3) * 40)
            penalty += p
            reasons.append({"tone": "bad", "text": f"Acute:chronic load {form['acwr']:.2f} — a spike over your 4-week norm (−{p:.0f})"})
    score = clamp(score - penalty)
    illness = z.get("rhr", 0) >= 2 and (z.get("resp", 0) >= 1.5 or z.get("sleep_stress", 0) >= 1.5)
    if not reasons:
        reasons.append({"tone": "good", "text": "Every overnight marker inside your normal range"})
    return {"date": today, "score": round(score), "components": {k: round(v) for k, v in comps.items()}, "z": {k: round(v, 2) for k, v in z.items()},
            "illness": illness, "reasons": reasons}


def recommend(ready: dict | None, plan_today: dict | None = None) -> dict:
    """The day's call. A race-plan session is the default; readiness can only make it easier, never harder."""
    if not ready:
        base = {"level": "unknown", "title": "No overnight data yet", "detail": "Wear the watch to bed; the first call comes after 14 nights of baseline."}
    elif ready["illness"]:
        base = {"level": "rest", "title": "Rest — possible illness or deep strain",
                "detail": "Resting HR is well above normal together with breathing rate or overnight stress. Skip training; reassess tomorrow."}
    elif ready["score"] >= 75:
        base = {"level": "hard", "title": "Green light — key session", "detail": "Recovered. Do the hard day: intervals, race-pace efforts or the long ride."}
    elif ready["score"] >= 60:
        base = {"level": "moderate", "title": "Train as planned", "detail": "Normal readiness. Quality is fine; keep hard efforts to the planned volume."}
    elif ready["score"] >= 45:
        base = {"level": "easy", "title": "Keep it easy", "detail": "Below your norm. Zone 1–2 only, 45–75 minutes, or swap with the next easy day."}
    else:
        base = {"level": "rest", "title": "Rest or recovery spin", "detail": "Markers well below normal. Off the bike, or 30 minutes truly easy."}
    if plan_today:
        order = ["rest", "easy", "moderate", "hard"]
        planned = plan_today["level"]
        if base["level"] in order and order.index(base["level"]) < order.index(planned):
            base["detail"] = f"Planned: {plan_today['session']}. Readiness says scale it back — {base['detail'][:1].lower()}{base['detail'][1:]}"
        else:
            mins = plan_today.get("minutes") or 0
            took = f" — about {mins // 60}h{mins % 60:02d}" if mins >= 60 else f" — about {mins} min" if mins else ""
            base = {**base, "level": planned, "title": plan_today["title"], "detail": plan_today["session"] + took}
    return base


# ── insights ──────────────────────────────────────────────────────────────────────────────────────────────

def ranks(xs: list[float]) -> list[float]:
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    r = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        for k in range(i, j + 1):
            r[order[k]] = (i + j) / 2
        i = j + 1
    return r


def spearman(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 3:
        return None
    rx, ry = ranks(xs), ranks(ys)
    try:
        return statistics.correlation(rx, ry)
    except statistics.StatisticsError:
        return None


def insights(pairs: dict[str, list[tuple[float, float]]], min_n: int = 30) -> list[dict]:
    """pairs: name → [(driver, outcome)], e.g. "load→sleep": [(tss on day d, sleep score of night d→d+1)].
    Reported when |ρ| ≥ 0.2 over at least min_n days, with the top-quartile vs rest difference in plain numbers."""
    text = {
        "load→sleep": ("training load", "that night's sleep score", "points"),
        "late→sleep": ("finishing a workout after 7 pm", "that night's sleep score", "points"),
        "steps→sleep": ("daily steps", "that night's sleep score", "points"),
        "stress→sleep": ("daytime stress", "that night's sleep score", "points"),
        "load→ready": ("training load", "next morning's readiness", "points"),
        "bedtime→sleep": ("a later bedtime", "sleep score", "points"),
        "sleep→ready": ("sleep score", "next morning's readiness", "points"),
    }
    out = []
    for key, rows in pairs.items():
        if len(rows) < min_n or key not in text:
            continue
        xs, ys = [r[0] for r in rows], [r[1] for r in rows]
        rho = spearman(xs, ys)
        if rho is None or abs(rho) < 0.2:
            continue
        cut = 1 if set(xs) <= {0, 1} else sorted(xs)[int(len(xs) * 0.75)]   # yes/no drivers split on yes
        hi = [y for x, y in rows if x >= cut]
        lo = [y for x, y in rows if x < cut]
        if not hi or not lo:
            continue
        driver, outcome, unit = text[key]
        diff = statistics.mean(hi) - statistics.mean(lo)
        direction = "raises" if diff > 0 else "lowers"
        lead = f"High {driver}" if key not in ("late→sleep", "bedtime→sleep") else driver[0].upper() + driver[1:]
        out.append({"key": key, "rho": round(rho, 2), "n": len(rows), "diff": round(diff, 1),
                    "text": f"{lead} {direction} {outcome} by {abs(diff):.0f} {unit} on average ({statistics.mean(hi):.0f} vs {statistics.mean(lo):.0f}; ρ = {rho:+.2f}, n = {len(rows)})."})
    return sorted(out, key=lambda r: -abs(r["rho"]))


# ── commuting ─────────────────────────────────────────────────────────────────────────────────────────────

COMMUTE_HOURS = ((5, 10), (14, 20))   # a ride that starts in one of these windows on a weekday can be a commute


def mark_commutes(acts: list[dict], cfg: dict) -> None:
    """Flag commutes: Strava's commute tick, or an outdoor weekday ride of about the commute's length that starts at
    commuting hours. Each gets its leg: "in" (morning) or "home"."""
    c = cfg["commute"]
    km = c.get("km_each_way") or 0
    for a in acts:
        start = datetime.fromisoformat(a["start"])
        looks = (bool(km) and a["group"] == "ride" and not a.get("indoor") and start.weekday() < 5
                 and abs(a["distance_m"] / 1000 - km) <= 0.25 * km and any(lo <= start.hour < hi for lo, hi in COMMUTE_HOURS))
        if a.get("commute") or (c.get("enabled") and looks):
            a["commute"] = True
            a["leg"] = "in" if start.hour < 12 else "home"


def _fit(xs: list[float], ys: list[float]) -> list[float] | None:
    """Least-squares line y = a + b·x, or None when the points can't support one."""
    if len(xs) < 6 or statistics.pstdev(xs) < 0.5:
        return None
    mx, my = statistics.mean(xs), statistics.mean(ys)
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True)) / sum((x - mx) ** 2 for x in xs)
    return [round(my - b * mx, 2), round(b, 3)]


def commute_profile(acts: list[dict], cfg: dict, today: date) -> dict | None:
    """What your commute costs and how it's trending, learned from the commutes you've ridden; config defaults until
    there are enough of them. Efficiency (km/h per 100 bpm) on the same flat route is a free weekly aerobic test."""
    c = cfg["commute"]
    if not c.get("enabled") or not c.get("km_each_way"):
        return None
    since = (today - timedelta(days=365)).isoformat()
    rides = [a for a in acts if a.get("commute") and a["start"][:10] >= since and a["moving_s"] > 0]
    km = c["km_each_way"]
    legs = {}
    for leg in ("in", "home"):
        mine = [a for a in rides if a.get("leg") == leg]
        with_hr = [a for a in mine if a.get("avg_hr")]
        recent = [a for a in with_hr if a["start"][:10] >= (today - timedelta(days=120)).isoformat()]
        minutes = statistics.median([a["moving_s"] / 60 for a in mine]) if len(mine) >= 3 else km / 26 * 60
        load = statistics.median([a["load"] for a in with_hr]) if len(with_hr) >= 3 else round(minutes / 60 * 50)
        legs[leg] = {
            "minutes": round(minutes), "load": round(load), "rides": len(mine),
            "hr": round(statistics.median([a["avg_hr"] for a in with_hr])) if len(with_hr) >= 3 else None,
            "speed": round(statistics.median([a["distance_m"] / a["moving_s"] * 3.6 for a in mine]), 1) if len(mine) >= 3 else 26.0,
            "model": _fit([a["distance_m"] / a["moving_s"] * 3.6 for a in recent], [a["avg_hr"] for a in recent]),   # HR expected at a speed
        }
    series = sorted(({"date": a["start"][:10], "leg": a["leg"], "speed": round(a["distance_m"] / a["moving_s"] * 3.6, 1), "hr": a["avg_hr"],
                      "ef": round(a["distance_m"] / a["moving_s"] * 3.6 / a["avg_hr"] * 100, 2)} for a in rides if a.get("avg_hr")), key=lambda r: r["date"])
    weeks = defaultdict(int)
    for a in rides:
        d = date.fromisoformat(a["start"][:10])
        weeks[(d - timedelta(days=d.weekday())).isoformat()] += 1
    last8 = [weeks.get((today - timedelta(days=today.weekday() + 7 * i)).isoformat(), 0) / 2 for i in range(1, 9)]   # round trips
    trend = None
    if len(series) >= 12:
        recent = [r["ef"] for r in series[-6:]]
        earlier = [r["ef"] for r in series[:-6][-30:]]
        if earlier:
            trend = round((statistics.median(recent) / statistics.median(earlier) - 1) * 100, 1)
    year = [a for a in rides if a["start"][:4] == str(today.year)]
    return {"km": km, "climb_m": c["climb_m"], "legs": legs, "series": series, "per_week_8": round(statistics.mean(last8), 1), "ef_trend_pct": trend,
            "year": {"legs": len(year), "km": round(sum(a["distance_m"] for a in year) / 1000), "hours": round(sum(a["moving_s"] for a in year) / 3600, 1)}}


def zone_bpm(th: dict, lo: float, hi: float) -> str:
    return f"under {round(th['lthr'] * hi / 100)} bpm" if lo <= 0 else f"{round(th['lthr'] * lo / 100)}–{round(th['lthr'] * hi / 100)} bpm"


def commute_call(ready: dict | None, plan_today: dict | None, today: date, cfg: dict, profile: dict | None, th: dict) -> dict | None:
    """This morning's commute decision and how to ride it. The plan proposes; readiness can only make it easier."""
    if not profile:
        return None
    dow = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"][today.weekday()]
    if dow not in cfg["commute"]["days"]:
        return None
    legs = profile["legs"]
    planned = plan_today.get("commute") if plan_today else None
    role = plan_today.get("role") if plan_today else None
    score = ready["score"] if ready else None
    z1, z2 = zone_bpm(th, 0, 81), zone_bpm(th, 81, 89)
    tin, thome = legs["in"]["minutes"], legs["home"]["minutes"]
    fuel = "Breakfast before you leave; something with carbs and protein at work; a snack (30–40 g carbs) mid-afternoon before the ride home."
    easy = {"verdict": "easy", "title": "Ride in — easy both ways",
            "detail": f"Z1 the whole way, {z1}, about {tin} min in and {thome} min home. Spin, don't push; no intervals today.", "fuel": fuel}
    if ready and ready.get("illness"):
        return {"verdict": "skip", "title": "Leave the bike at home", "detail": "Resting HR and breathing rate say you may be fighting something off. Drive or take the bus; 60 km won't help.", "fuel": ""}
    if score is not None and score < 45:
        return {"verdict": "skip", "title": "Leave the bike at home", "detail": f"Readiness {score}: recovery is the job today. If you must ride, Z1 only ({z1}) both ways.", "fuel": ""}
    if not planned:
        if role in ("rest", "race", "openers"):
            return {"verdict": "skip", "title": "Not a bike day", "detail": "The plan has you resting today; driving keeps the week's load where the plan needs it.", "fuel": ""}
        if score is not None and score >= 60:
            return {**easy, "verdict": "optional", "title": "Not a planned commute — optional, easy",
                    "detail": f"If you want to ride in anyway: Z1 both ways ({z1}), and treat it as that day's whole session — no extra workout tonight."}
        return {"verdict": "skip", "title": "Not a planned commute", "detail": "Keep this one in the car; the plan's commute days carry the week's volume.", "fuel": ""}
    if score is not None and score < 60:
        return {**easy, "detail": f"Readiness {score} is below your norm, so the planned {planned} commute becomes an easy one: Z1 both ways ({z1}), no intervals."}
    if planned == "easy":
        return easy
    if planned == "endurance":
        return {"verdict": "ride", "title": "Ride in — steady Z2 both ways",
                "detail": f"Z2, {z2}, about {tin} min in and {thome} min home. Even effort, no surges at lights; the ride home's {profile['climb_m'][1]} m is gentle — keep HR in range on it.",
                "fuel": fuel}
    workout = plan_today.get("commute_workout", "intervals")
    check = " If the first 15 minutes home feel heavy — ride mode flags HR running 6+ bpm over your usual for the speed — skip them and ride it easy." if score is None or score < 75 else ""
    return {"verdict": "ride", "title": "Ride in easy, workout on the way home",
            "detail": f"In: Z1–Z2, {zone_bpm(th, 0, 85)}, arrive fresh. Home: 10 min easy, then {workout} on the flattest open stretch, the rest Z2.{check}",
            "fuel": fuel}
