"""Structured steps for the planned sessions, for ride mode on the phone.

With no power meter, heart rate is the live signal, so targets are % of lactate-threshold HR using Friel's cycling
zones: Z1 < 81%, Z2 81-89%, Z3 90-93%, Z4 94-99%, Z5 100-106%. Heart rate lags short efforts by 30-90 s, so
anything of 2 minutes or less carries a ride-it-by-feel cue instead of a number to chase.
"""
from __future__ import annotations

ZONES = {  # name → (low %, high %) of LTHR
    "z1": (0, 81), "z2": (81, 89), "tempo": (88, 93), "race": (90, 96), "ss": (92, 97), "thr": (95, 100), "z5": (100, 106), "max": (100, 110),
}
LAG = "Short effort: heart rate lags — ride it by feel, RPE 9"


def step(name: str, minutes: float, zone: str, cue: str = "") -> dict:
    lo, hi = ZONES[zone]
    return {"name": name, "min": round(minutes, 2), "zone": zone, "lo": lo, "hi": hi, "cue": cue}


def reps(n: int, label: str, on: float, zone: str, off: float, off_zone: str = "z1", cue: str = "", off_label: str = "Easy") -> list[dict]:
    out = []
    for i in range(n):
        out.append(step(f"{label} {i + 1}/{n}", on, zone, cue))
        if i < n - 1 and off:
            out.append(step(off_label, off, off_zone))
    return out


def wu(minutes: float = 15) -> list[dict]:
    return [step("Warm-up", minutes, "z2", "Build gradually; a few 10 s spin-ups at the end")]


def cd(minutes: float = 10) -> list[dict]:
    return [step("Cool-down", minutes, "z1")]


def _over_unders(blocks: int, over: float, under: float, block_min: float, rest: float) -> list[dict]:
    out = []
    for b in range(blocks):
        t, i = 0.0, 0
        while t < block_min - 0.01:
            is_over = i % 2 == 0
            mins = min(over if is_over else under, block_min - t)
            out.append(step(f"Block {b + 1}/{blocks} · {'over' if is_over else 'under'}", mins, "thr" if is_over else "tempo",
                            "Just over threshold" if is_over else "Settle, don't drop to easy"))
            t, i = t + mins, i + 1
        if b < blocks - 1:
            out.append(step("Easy", rest, "z1"))
    return out


def _race_starts(n: int, hard: float, settle: float, rest: float) -> list[dict]:
    out = []
    for i in range(n):
        out += [step(f"All-out start {i + 1}/{n}", hard, "max", LAG), step(f"Settle at tempo {i + 1}/{n}", settle, "tempo")]
        if i < n - 1:
            out.append(step("Easy", rest, "z1"))
    return out


def _thirty_thirties(sets: int, per: int, rest: float) -> list[dict]:
    out = []
    for s in range(sets):
        for i in range(per):
            out += [step(f"Set {s + 1} · 30 s on ({i + 1}/{per})", 0.5, "max", LAG), step("30 s easy", 0.5, "z1")]
        if s < sets - 1:
            out.append(step("Easy between sets", rest, "z1"))
    return out


LIBRARY = {   # (session library, index in plan.SESSIONS[library]) → steps
    ("mtb", 0): lambda: wu() + reps(5, "VO2", 3, "z5", 3, cue="RPE 9 — HR catches up in the last minute") + cd(),
    ("mtb", 1): lambda: wu() + _race_starts(3, 2, 8, 5) + cd(),
    ("mtb", 2): lambda: wu() + reps(3, "Sweet spot", 12, "ss", 4) + cd(),
    ("mtb", 3): lambda: wu() + _over_unders(3, 1, 2, 9, 4) + cd(),
    ("gravel", 0): lambda: wu() + reps(3, "Threshold", 12, "thr", 5) + cd(),
    ("gravel", 1): lambda: wu() + reps(5, "VO2", 4, "z5", 4, cue="RPE 9 — HR catches up in the last minute") + cd(),
    ("gravel", 2): lambda: wu() + reps(10, "Hill", 1, "max", 2, cue="Hard over the top of a short climb — by feel") + cd(),
    ("gravel", 3): lambda: [step("Fast start", 10, "thr", "Like the first miles of the race")] + [step("Settle", 10, "z2")]
                           + reps(4, "Race effort", 8, "race", 6, "z2", cue="Drink at speed") + cd(),
    ("indoor", 0): lambda: wu(10) + reps(3, "Sweet spot", 15, "ss", 5) + cd(),
    ("indoor", 1): lambda: wu(10) + reps(2, "Tempo", 25, "tempo", 5) + cd(),
    ("indoor", 2): lambda: wu(10) + reps(4, "Threshold", 8, "thr", 4) + cd(),
    ("indoor", 3): lambda: wu(10) + _over_unders(3, 2, 2, 10, 5) + cd(),
    ("indoor", 4): lambda: wu(10) + reps(5, "Spin-up 110 rpm", 1, "z2", 1, cue="Smooth, hips still") + reps(2, "Sweet spot", 20, "ss", 5) + cd(),
    ("indoor_late", 0): lambda: wu(10) + reps(5, "VO2", 4, "z5", 4, cue="RPE 9 — HR catches up in the last minute") + cd(),
    ("indoor_late", 1): lambda: wu(10) + reps(3, "Threshold", 12, "thr", 5) + cd(),
    ("indoor_late", 2): lambda: wu(10) + _thirty_thirties(3, 8, 5) + cd(),
    ("indoor_late", 3): lambda: wu(10) + reps(2, "Sweet spot", 30, "ss", 5) + cd(),
    ("taper", 0): lambda: wu() + reps(5, "Race pace", 1, "thr", 2, "z2", cue=LAG),
    ("taper", 1): lambda: wu() + _race_starts(2, 1.5, 5, 5),
}


def steps_for(key: tuple[str, int] | None, title: str, minutes: int, race_hours: float = 2.0, long_h: float = 3.0) -> list[dict]:
    """The steps for one planned day, padded with endurance riding to the planned duration."""
    if key in LIBRARY:
        out = LIBRARY[key]()
    elif title.startswith("Race day"):
        return [step("Warm-up", 15, "z2", "Two 30 s efforts near the end"), step("Race", race_hours * 60, "race", "Eat every 20 minutes from the gun")]
    elif title == "Openers":
        out = wu() + reps(3, "Race pace", 1, "thr", 2, "z2", cue=LAG) + reps(3, "Sprint 10 s", 1 / 6, "max", 2, "z1", cue="Full gas, then spin easy")
    elif title == "FTP ramp test":
        return [step("Warm-up", 10, "z1"), step("Ramp test", 20, "max", "Let the app run it; go until you can't hold the target"), step("Easy", 20, "z2")]
    elif title == "Recovery-week tune-up":
        out = wu() + reps(3, "Sweet spot", 5, "ss", 5) + cd()
    elif title == "Recovery spin":
        return [step("Recovery", minutes, "z1", "Conversational. If it feels like work, slow down")]
    elif title in ("Endurance", "Easy endurance", "Long easy ride", "Long trainer ride"):
        return [step("Endurance", minutes, "z2", "Steady, cadence 85–95" + ("; eat 60–80 g carbs an hour" if minutes >= 90 else ""))]
    elif title == "Long ride":
        out = wu()
        rest = max(0, minutes - 15 - 15 - 10)
        for i in range(3):
            out += [step("Endurance", rest / 4, "z2"), step(f"Surge {i + 1}/3", 5, "thr", "Near race effort, sandy two-track if you have it")]
        out += cd()
    elif title == "Long gravel ride":
        if long_h >= 3.5:
            return [step("Endurance on dirt", minutes, "z2", "Eat 80–90 g carbs an hour; race tires and pressures")]
        out = wu() + reps(3, "Race pace", 15, "race", 15, "z2") + cd()
    elif title == "Shorter long ride":
        out = wu() + reps(3, "Race effort", 3, "thr", 5, "z2") + cd()
    else:   # rest, strength, ride for fun: nothing to pace
        return []
    total = sum(s["min"] for s in out)
    if minutes > total + 5:
        filler = step("Endurance", minutes - total, "z2", "Steady Z2 to fill the planned time")
        cut = len(out) - 1 if out and out[-1]["name"] == "Cool-down" else len(out)
        out.insert(cut, filler)
    return out


def commute_legs(mode: str, workout: str | None, legs: dict) -> list[dict]:
    """A commute day as two sessions for ride mode: the ride in and the ride home, each paced for the day's job.
    Both carry check=True: ride mode compares your HR with what you usually need for that speed on that leg."""
    m_in, m_home = legs["in"]["minutes"], legs["home"]["minutes"]
    z_in = "z1" if mode in ("easy", "workout") else "z2"
    ride_in = [step("Ride in", m_in, z_in, "Arrive fresh: spin, don't push" if z_in == "z1" else "Steady Z2; no surges at the lights")]
    if mode == "workout" and workout:
        work = _commute_work(workout)
        done = 10 + sum(s["min"] for s in work)
        home = [step("Settle in", 10, "z2", "Easy for 10 min; if HR runs high for the speed, skip the intervals")] + work + [step("Ride home", max(5, m_home - done), "z2")]
    else:
        home = [step("Ride home", m_home, "z1" if mode == "easy" else "z2", "Easy all the way" if mode == "easy" else "Steady Z2, gentle on the climb")]
    return [{"leg": "in", "title": "Commute in", "minutes": m_in, "steps": ride_in, "check": True},
            {"leg": "home", "title": "Commute home", "minutes": m_home, "steps": home, "check": True}]


def _commute_work(text: str) -> list[dict]:
    if text.startswith("2 × 15"):
        return reps(2, "Sweet spot", 15, "ss", 5, "z2")
    if text.startswith("30 min"):
        return [step("Tempo", 30, "tempo", "Steady; flattest open stretch")]
    if text.startswith("3 × 8"):
        return reps(3, "Threshold", 8, "thr", 4, "z2")
    return reps(3, "Race effort", 10, "race", 5, "z2")
