"""How you feel, from the app: the morning check-in and each ride's rating, synced so the morning call (and the
notification that carries it) and every device see them.

- **The check-in**: legs, energy, life stress and mood (1-5, 3 = your normal) and the neck check (no / a head cold /
  below the neck). Subjective wellness tracks load, fatigue and coming illness more sensitively than resting HR or
  heart-rate measures (Saw, Main & Gastin 2016). Readiness becomes 70% the watch and 30% you, and the call can only
  get easier: the same bands as metrics.recommend, very sore legs or no energy cap it at easy, a head cold rides easy
  at most and anything below the neck rests. Mirrored by the app's feelCall, which applies it the moment you tap.
- **Ride ratings**: Foster's session RPE, how hard a ride was on the CR-10 scale (Foster et al. 2001). Rated rides
  sit beside their heart-rate load, and the app says when rides start feeling harder than their load (fatigue).

The phone sends them as a `service` run's code, "feel:" + base64url JSON, so the private repository's workflow needs
no new input. Kept in the store as kv "feel:<date>" and "rpe:<activity id>".
"""
from __future__ import annotations

import base64
import json
import re
import statistics
from datetime import date, timedelta

ITEMS = ("legs", "energy", "stress", "mood")
SICK = ("none", "above", "below")
ORDER = ("rest", "easy", "moderate", "hard")
KEEP_DAYS = 90
_ID = re.compile(r"^[a-z]+:[0-9A-Za-z_-]{1,40}$")


def parse(code: str, today: date) -> dict:
    """A "feel:" code → {"checkins": {date: {...}}, "rpe": {id: n}}, checked field by field: nothing else gets stored."""
    raw = code.strip().removeprefix("feel:")
    try:
        body = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    except (ValueError, json.JSONDecodeError) as e:
        raise ValueError("that check-in couldn't be read") from e
    if not isinstance(body, dict):
        raise ValueError("that check-in couldn't be read")
    out: dict[str, dict] = {"checkins": {}, "rpe": {}}
    for day, c in (body.get("checkins") or {}).items():
        try:
            d = date.fromisoformat(day)
        except (TypeError, ValueError):
            continue
        if not isinstance(c, dict) or abs((d - today).days) > 31:
            continue
        clean = {k: int(c[k]) for k in ITEMS if isinstance(c.get(k), int) and 1 <= c[k] <= 5}
        if c.get("sick") in SICK:
            clean["sick"] = c["sick"]
        if clean:
            out["checkins"][day] = clean
    for aid, n in (body.get("rpe") or {}).items():
        if isinstance(aid, str) and _ID.match(aid) and isinstance(n, int) and 1 <= n <= 10:
            out["rpe"][aid] = n
    if not out["checkins"] and not out["rpe"]:
        raise ValueError("that check-in had nothing in it")
    return out


def save(store, code: str, today: date) -> str:
    got = parse(code, today)
    for day, c in got["checkins"].items():
        store.set(f"feel:{day}", json.dumps(c, separators=(",", ":")))
    for aid, n in got["rpe"].items():
        store.set(f"rpe:{aid}", str(n))
    parts = [f"{len(got['checkins'])} check-in(s)" if got["checkins"] else "", f"{len(got['rpe'])} ride rating(s)" if got["rpe"] else ""]
    return " and ".join(p for p in parts if p)


def load(store, today: date) -> dict:
    since = (today - timedelta(days=KEEP_DAYS)).isoformat()
    checkins = {d: json.loads(v) for d, v in store.prefixed("feel:").items() if d >= since}
    rpe = {a: int(v) for a, v in store.prefixed("rpe:").items()}
    return {"checkins": checkins, "rpe": rpe}


def score(c: dict | None) -> int | None:
    """3 is your normal = 75 (like the watch's markers), each step either way 15 points."""
    vals = [c[k] for k in ITEMS if c and isinstance(c.get(k), int)]
    return max(0, min(100, round(75 + 15 * (statistics.mean(vals) - 3)))) if vals else None


def _level(s: float) -> str:
    return "hard" if s >= 75 else "moderate" if s >= 60 else "easy" if s >= 45 else "rest"


def blended(ready: dict | None, c: dict | None) -> dict | None:
    """Readiness with the check-in in it, the most the day may ask for, and why."""
    if not c:
        return None
    f = score(c)
    s = (round(0.7 * ready["score"] + 0.3 * f) if ready else f) if f is not None else (ready["score"] if ready else None)
    cap = _level(s) if s is not None else None
    why = f"how you feel ({f}) moves readiness to {s}" if f is not None and ready and _level(s) != _level(ready["score"]) else ""
    words = {"legs": ("legs", "very sore"), "energy": ("energy", "drained"), "stress": ("life stress", "very high"), "mood": ("mood", "low")}
    low = [f"{words[k][0]} {words[k][1]}" for k in ITEMS if c.get(k) == 1]
    if low:
        cap, why = ("rest" if cap == "rest" else "easy"), ", ".join(low)
    if c.get("sick") == "above":
        cap, why = ("rest" if cap == "rest" else "easy"), "a head cold: easy only, and stop if it gets worse"
    if c.get("sick") == "below":
        cap, why = "rest", "symptoms below the neck: rest until they're gone"
    return {"score": s, "feel": f, "cap": cap, "why": why}


def ease(rec: dict, b: dict | None, plan_today: dict | None) -> dict:
    """The call, eased by the check-in when it says so; never made harder."""
    if not b or not b["cap"] or rec.get("level") not in ORDER or ORDER.index(b["cap"]) >= ORDER.index(rec["level"]):
        return rec
    planned = f"Planned: {plan_today['session']}. " if plan_today else ""
    if b["cap"] == "rest":
        return {"level": "rest", "title": "Rest today", "eased": True,
                "detail": f"{planned}Your check-in says rest — {b['why']}. Off the bike, or 20–30 min truly easy if you're well."}
    commute = " On the bike to work: Z1 both ways, or leave it." if plan_today and plan_today.get("commute") else ""
    return {"level": "easy", "title": "Keep it easy", "eased": True,
            "detail": f"{planned}Your check-in says ease off — {b['why']}. Z1–Z2 only, 45–75 min, no intervals.{commute}"}
