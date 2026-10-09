"""Race day: the morning timeline, the start and how to pace it, the bottles and gels, the bike the week before,
what to wear from the forecast, and the key sessions still between you and the start line.

Built for each race in the next six weeks (the next one always). Start time is `start` in the race's config
block (your wave's), "10:00" until you set it. Fueling uses fuel.py's bottles and the race-day carb rate; pacing
uses your threshold heart rate.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

from fitness import bike, fuel
from fitness import weather as wxm

WINDOW_DAYS = 42

START = {
    "mtb": ("Wave start, and the first minutes decide where you ride the singletrack: go hard for 5–8 minutes to get position "
            "before the first two-track narrows, then settle. Ride the sand seated and smooth; walk nothing you can ride, "
            "and run the unrideable bits fast rather than fighting them."),
    "gravel": ("Mass start: get into the front third early and stay in a group, because the draft is worth more than "
               "fitness here. Take short pulls or none, ride the rollers at tempo, not threshold, and be at the front "
               "into the sections where the field splits."),
}


def _clock(t: datetime) -> str:
    return t.strftime("%-I:%M %p")


def pages(plan: dict | None, cfg: dict, wx: wxm.Wx | None, th: dict, weight_kg: float | None, up: dict | None, today: date) -> list[dict]:
    if not plan:
        return []
    units = cfg["athlete"]["units"]
    by_name = {r["name"]: r for r in cfg["races"]}
    n = cfg.get("nutrition", {})
    drink = {**fuel.RIDE_FUEL, **n.get("ride_fuel", {})}
    out = []
    for i, r in enumerate(plan["races"]):
        if r["days_out"] > WINDOW_DAYS and i:
            continue
        conf = by_name.get(r["name"], {})
        hh, mm = (int(x) for x in str(conf.get("start") or "10:00").split(":"))
        race_day = date.fromisoformat(r["date"])
        gun = datetime.combine(race_day, datetime.min.time()).replace(hour=hh, minute=mm)
        minutes = r["hours"] * 60
        rate = fuel.on_bike_rate(minutes, race=True) or 60
        b = fuel.bottles(minutes, rate, drink, n.get("bottle_cages", 2), n.get("bladder_l", 0))
        lthr = th.get("lthr")
        settle = f"{round(lthr * 0.92)}–{round(lthr * 0.97)} bpm" if lthr else "just under threshold"
        carbs_g = round(2.5 * weight_kg / 10) * 10 if weight_kg else None
        timeline = [
            (gun - timedelta(hours=3, minutes=30), "Up. A big glass of water."),
            (gun - timedelta(hours=3), f"Breakfast: {f'about {carbs_g} g of carbs' if carbs_g else '2–3 g of carbs per kg'}, low in fat and fiber: "
                                       "oatmeal or white rice with banana and honey, or bagels with jam. Not the Nutty Pudding today: its fat and fiber sit heavy."),
            (gun - timedelta(hours=1, minutes=30), f"Mix the bottles: {b['setup']}. Gels in the pocket."),
            (gun - timedelta(hours=1), "Kit on, number on, tire pressure set with a gauge, a last bathroom stop."),
            (gun - timedelta(minutes=45), "Warm up 15–20 min: easy spinning with 2 × 30 s at race effort, then 5 min easy."),
            (gun - timedelta(minutes=20), "Into the start area. A gel 10 minutes before the gun, with water."),
            (gun, f"Go. Then settle at {settle} and start eating at 20 minutes: {b['sips']}"
                  + (f", plus {b['top_up']} g an hour from gels or chews" if b["top_up"] else "") + "."),
        ]
        forecast = None
        if wx and race_day.isoformat() in wx.days:
            w = wx.window(gun, minutes)
            if w:
                forecast = {"line": wxm.describe(w, units), "kit": wxm.kit(w["feels"], w["verdict"] in ("wet", "showers")),
                            "warm": "Bring a warm jacket and dry clothes for the finish." if w["feels"] < 12 else ""}
        before = [d for d in plan["days"] if d["date"] < r["date"] and (d["role"] in ("key", "long") or d.get("commute") == "workout")]
        before = [d for d in before if date.fromisoformat(d["date"]) >= today]
        pack = ["Helmet, shoes, glasses, gloves", "Race number and timing chip", f"{b['servings']:g} servings of {drink['name']} and the gels",
                "Spare tube or plugs, CO2 and inflator, multi-tool", "Floor pump and gauge", "Warm clothes and a towel for after",
                "Recovery: a carb + protein drink or chocolate milk for the finish"]
        out.append({
            "name": r["name"], "label": r["label"], "date": r["date"], "days_out": r["days_out"], "kind": r["kind"],
            "start": _clock(gun), "start_set": bool(conf.get("start")),
            "timeline": [{"at": _clock(t), "what": w} for t, w in timeline],
            "strategy": START.get(r["kind"], START["gravel"]) + f" Hold {settle} once the start settles; above it only for the moves that matter.",
            "fuel": {"rate": rate, **{k: b[k] for k in ("setup", "sips", "top_up", "sodium", "no_refill")}},
            "forecast": forecast,
            "bike": bike.prerace(up, r) if up else [],
            "pack": pack,
            "sessions_left": [{"date": d["date"], "title": d["title"]} for d in before],
            "taper": {"days": r["taper_days"], "race_tsb": r["race_tsb"], "in_band": r["in_band"], "target_tsb": r["target_tsb"]},
        })
    return out
