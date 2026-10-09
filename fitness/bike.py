"""Bike upkeep: what's due on the bike, from the riding itself.

Distance and ride time come from your rides (trainer rides count toward the drivetrain only, with `bike.trainer`);
wet rides come from the weather history (weather.py), and a wet ride makes the chain due at once and wears pads twice
as fast. "Done" in the app starts a `service` run that stamps the job; until the first stamp, counting starts on the
day this was first seen. Tire pressures come from Silca's calculator: you enter them in the app per surface, and it
says when to run the calculator again (your weight moved, or a race needs its own).

The defaults are for a 2022 Cube Nuroad C:62 SL waxed with Silca Super Secret from the bottle (drip): SRAM GX Eagle
AXS 1×12 with Rival AXS levers, Rival hydraulic brakes, Newmen Evolution SL X.R.25 rims and WTB Riddler 45 tubeless.
Override any interval in config.toml under [bike.every].
"""
from __future__ import annotations

import json
from datetime import date, datetime

from fitness.weather import Wx

KM_PER_MI = 1.609344
BIKE_KG = 8.4                   # the C:62 SL as specified (18.5 lb); bottles, bag and tools are added on top
KIT_KG = 2.5                    # two full bottles, a saddle bag, pump / CO2, shoes, helmet: what Silca calls "everything on the bike"

# key: (job, how, every mi, every riding h, every days, counts trainer rides, wet rides)
ITEMS: dict[str, tuple[str, str, float | None, float | None, int | None, bool, str | None]] = {
    "drip": ("Re-drip the chain", "Silca Super Secret on a clean, dry chain, one drop per roller, spin, wipe; let it set overnight", 200, None, None, True, "now"),
    "clean": ("Clean the chain", "Wipe and degrease the chain and cassette, then re-drip from fresh: grit under the wax wears it", 800, None, None, True, None),
    "chain": ("Check chain wear", "Chain checker at 0.5%: replace there and the Eagle cassette lasts", 1000, None, None, True, None),
    "axs": ("Charge the AXS battery", "The rear derailleur's battery (about 20 h of riding); the night before every race too", None, 15, None, True, None),
    "sealant": ("Top up tubeless sealant", "About 60 ml per WTB Riddler 45; it dries out with time, not miles", None, None, 90, False, None),
    "pads": ("Check brake pads", "SRAM Rival: replace under 3 mm including the backing plate; wet grit wears them twice as fast", 1000, None, None, False, "double"),
    "tires": ("Inspect the tires", "Cuts, worn center knobs, sidewall damage; spin each one and look", 750, None, None, False, None),
    "bleed": ("Bleed the brakes", "SRAM Rival hydraulic, DOT 5.1: yearly, or sooner if a lever feels soft", None, None, 365, False, None),
    "coins": ("Replace the shifter batteries", "A CR2032 in each Rival AXS lever", None, None, 730, False, None),
    "service": ("Full service", "Hub and headset bearings, bolt torques, thru-axles, derailleur hanger alignment", 3000, None, 365, False, None),
}
SURFACES = {"commute": "Commute (pavement)", "gravel": "Gravel"}


def _ts(s: str) -> datetime:
    return datetime.fromisoformat(s)


def state(store, today: date | None = None) -> dict:
    """The jobs done and pressures set; the first time it's read, the day counting starts."""
    st = json.loads(store.get("bike") or "null") or {}
    if today and not st.get("since"):
        st["since"] = today.isoformat()
        store.set("bike", json.dumps(st))
    return st


def log(store, code: str, now: datetime, weight_kg: float | None) -> str:
    """A `service` run: "drip" (a job done), or "pressure:<surface>:<front>/<rear>" (Silca's numbers, psi)."""
    st = state(store)
    code = code.strip()
    if code.startswith("pressure:"):
        _, where, pair = code.split(":", 2)
        front, rear = (float(x) for x in pair.split("/"))
        if not (5 <= front <= 120 and 5 <= rear <= 120):
            raise ValueError("pressures are psi between 5 and 120")
        st.setdefault("pressure", {})[where[:40]] = {"front": front, "rear": rear, "at": now.isoformat(timespec="minutes"), "weight_kg": weight_kg}
        what = f"{where} pressures {front:g}/{rear:g} psi"
    elif code in ITEMS:
        st.setdefault("done", {})[code] = now.isoformat(timespec="minutes")
        what = ITEMS[code][0].lower()
    else:
        raise ValueError(f"unknown bike job {code!r}")
    store.set("bike", json.dumps(st))
    return what


def upkeep(acts: list[dict], st: dict, cfg: dict, today: date, wx: Wx | None, weight_kg: float | None, races: list[dict]) -> dict:
    """Every job's progress toward due, the pressures and when to recalculate them, and the week-before-a-race list."""
    b = cfg.get("bike") or {}
    every = b.get("every") or {}
    trainer = b.get("trainer", True)
    since = st.get("since") or today.isoformat()
    rides = [a for a in acts if a.get("group") == "ride"]
    imperial = cfg["athlete"]["units"] == "imperial"
    items = []
    for key, (job, how, mi, hours, days, drivetrain, wet_rule) in ITEMS.items():
        mi = every.get(key, mi)
        done = st.get("done", {}).get(key)
        start = _ts(done) if done else datetime.fromisoformat(since)
        mine = [a for a in rides if _ts(a["start"]) > start and (not a.get("indoor") or (drivetrain and trainer))]
        wet = [a for a in mine if not a.get("indoor") and wx and wx.wet_during(_ts(a["start"]), a["moving_s"] / 60)]
        dist_mi = sum(a["distance_m"] for a in mine) / 1609.344 + (sum(a["distance_m"] for a in wet) / 1609.344 if wet_rule == "double" else 0)
        ride_h = sum(a["moving_s"] for a in mine) / 3600
        age = (today - start.date()).days
        parts = [x for x in (dist_mi / mi if mi else None, ride_h / hours if hours else None, age / days if days else None) if x is not None]
        pct = max(parts) if parts else 0.0
        why = None
        if wet_rule == "now" and wet:
            pct, why = max(pct, 1.0), f"a wet ride on {_ts(wet[-1]['start']).strftime('%a %b %-d')}"
        used = []
        if mi:
            used.append(f"{round(dist_mi)} of {mi:g} mi" if imperial else f"{round(dist_mi * KM_PER_MI)} of {round(mi * KM_PER_MI)} km")
        if hours:
            used.append(f"{ride_h:.1f} of {hours:g} h riding")
        if days:
            used.append(f"{age} of {days} days")
        items.append({"key": key, "job": job, "how": how, "pct": round(min(pct, 9.99), 2), "used": " · ".join(used), "why": why,
                      "status": "due" if pct >= 1 else "soon" if pct >= 0.8 else "ok", "done": done, "counting_since": None if done else since})
    items.sort(key=lambda i: -i["pct"])

    pressures = st.get("pressure") or {}
    system_kg = round((weight_kg or 0) + BIKE_KG + KIT_KG, 1) if weight_kg else None
    notes = []
    for where, p in pressures.items():
        if weight_kg and p.get("weight_kg") and abs(weight_kg - p["weight_kg"]) >= 2:
            notes.append(f"{where.capitalize()}: you weigh {abs(weight_kg - p['weight_kg']):.1f} kg {'more' if weight_kg > p['weight_kg'] else 'less'} than when you set these. Run Silca's calculator again.")
    next_race = next((r for r in races if 0 <= r["days_out"] <= 21), None)
    if next_race:
        key = _race_key(next_race["name"])
        if key not in pressures:
            notes.append(f"No pressures for {next_race['name']} yet: run Silca's calculator for its surface and add them.")
    return {"name": b.get("name", "Bike"), "parts": b.get("parts", ""), "items": items, "pressure": pressures, "pressure_notes": notes,
            "surfaces": {**SURFACES, **{_race_key(r["name"]): r["name"] for r in races}},
            "silca": {"system_kg": system_kg, "system_lb": round(system_kg * 2.20462) if system_kg else None, "tire": b.get("tire", ""),
                      "rim": b.get("rim", "")}}


def _race_key(name: str) -> str:
    return "".join(c for c in name.lower() if c.isalnum())[:24]


def prerace(up: dict, race: dict) -> list[dict]:
    """The bike, the week before a race: what's left to do, in order."""
    by = {i["key"]: i for i in up["items"]}
    p = up["pressure"].get(_race_key(race["name"]))
    out = [
        {"job": "Re-drip the chain 1–2 days before", "ok": False, "note": "Super Secret needs a night to set; not the morning of"},
        {"job": "Charge the AXS battery the night before", "ok": False, "note": ""},
        {"job": "Sealant topped up", "ok": by.get("sealant", {}).get("pct", 1) < 0.35, "note": "fresh within the last month"},
        {"job": f"Tire pressure: {p['front']:g} front / {p['rear']:g} rear psi" if p else "Tire pressure from Silca's calculator", "ok": bool(p),
         "note": "set the morning of, with a gauge" if p else "not set yet"},
        {"job": "Brake pads and tires checked", "ok": by.get("pads", {}).get("status") == "ok" and by.get("tires", {}).get("status") == "ok", "note": ""},
        {"job": "Bolts and thru-axles torqued; spare tube or plugs, CO2, multi-tool packed", "ok": False, "note": ""},
    ]
    return out
