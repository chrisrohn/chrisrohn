"""Race day: the morning timeline, the start and how to pace it, the bottles and gels, the bike the week before,
what to wear from the forecast, and the key sessions still between you and the start line.

Built for each race in the next six weeks (the next one always). Start time is `start` in the race's config
block (your wave's, with `wave` its number), "10:00" until you set it; both apply only to the configured edition. Fueling uses fuel.py's bottles and the race-day carb rate; pacing
uses your threshold heart rate. The race lasts what your past editions took (racewx.expected); within 16 days the
forecast is the venue's own (build.race_forecasts), and racewx turns it into what to wear, how to set up the bike, how
to ride and how to fuel, with every other case listed too.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

from fitness import bike, fuel, racewx
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


def pages(plan: dict | None, cfg: dict, wx: wxm.Wx | None, th: dict, weight_kg: float | None, up: dict | None, today: date,
          editions: dict[str, list[dict]] | None = None, venue: dict[str, dict] | None = None) -> list[dict]:
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
        own = conf.get("date") is not None and conf["date"].isoformat() == r["date"]   # not a year it rolled forward to
        start, wave = (conf.get("start") or "", int(conf.get("wave") or 0)) if own else ("", 0)
        hh, mm = (int(x) for x in (start or "10:00").split(":"))
        race_day = date.fromisoformat(r["date"])
        gun = datetime.combine(race_day, datetime.min.time()).replace(hour=hh, minute=mm)
        took = racewx.expected((editions or {}).get(r["name"]), r["hours"])
        minutes = took["minutes"]
        rate = fuel.on_bike_rate(minutes, race=True) or 60
        here = (venue or {}).get(r["name"]) or {}
        start_wx = here.get("start") if here.get("start") and race_day.isoformat() in here["start"].days else None
        finish_wx = here.get("finish") if start_wx and here.get("finish") else None
        where = "venue" if start_wx else "home"
        start_wx = start_wx or (wx if wx and race_day.isoformat() in wx.days else None)
        ll0, ll1 = conf.get("start_ll"), conf.get("finish_ll")
        heading = wxm.bearing(tuple(ll0), tuple(ll1)) if ll0 and ll1 and ll0 != ll1 else None
        w = start_wx.window(gun, minutes, heading) if start_wx else None
        silca = (up or {}).get("pressure", {}).get(bike._race_key(r["name"])) if up else None
        cond = racewx.advise(start_wx=start_wx, finish_wx=finish_wx, gun=gun, minutes=minutes, heading=heading, silca=silca,
                             units=units, kind=r["kind"], where=where) if start_wx else None
        b = fuel.bottles(minutes, rate, drink, n.get("bottle_cages", 2), n.get("bladder_l", 0), w["temp_max"] if w else None, units)
        lthr = th.get("lthr")
        settle = f"{round(lthr * 0.92)}–{round(lthr * 0.97)} bpm" if lthr else "just under threshold"
        carbs_g = round(2.5 * weight_kg / 10) * 10 if weight_kg else None
        timeline = [
            (gun - timedelta(hours=3, minutes=30), "Up. A big glass of water."),
            (gun - timedelta(hours=3), f"Breakfast: {f'about {carbs_g} g of carbs' if carbs_g else '2–3 g of carbs per kg'}, low in fat and fiber: "
                                       "oatmeal or white rice with banana and honey, or bagels with jam. Not the Nutty Pudding today: its fat and fiber sit heavy."),
            (gun - timedelta(hours=2, minutes=30), "A beet-juice shot (Beet-It Sport, 70 ml ≈ 400 mg nitrate), the last of the "
                                                    "week's: one a day for the 3–5 days before primes it (IOC consensus, Maughan et al. 2018). No mouthwash."),
            (gun - timedelta(hours=1, minutes=30), f"Mix the bottles: {b['setup']}. Gels in the pocket."),
            (gun - timedelta(hours=1), "Kit on, number on, tire pressure set with a gauge"
                                       + (f" ({cond['tires']['front']:g} / {cond['tires']['rear']:g} psi)" if cond and cond["tires"]["front"] else "")
                                       + ", the finish bag handed in (dry clothes, a warm jacket), a last bathroom stop."),
            (gun - timedelta(minutes=60), f"If you use caffeine: {f'about {round(3 * weight_kg / 10) * 10} mg' if weight_kg else '3 mg per kg'} "
                                          "(a strong coffee, or caffeinated gels), the dose with the best evidence (ISSN position stand, Guest et al. 2021). "
                                          "Only what you've tried in training."),
            (gun - timedelta(minutes=45), "Warm up 15–20 min: easy spinning with 2 × 30 s at race effort, then 5 min easy."),
            (gun - timedelta(minutes=20), f"Into {f'wave {wave}’s corral' if wave else 'the start area'}"
                                          f"{' (be there before the waves ahead clear it)' if wave > 1 else ''}. A gel 10 minutes before the gun, with water."),
            (gun, f"{f'Wave {wave} goes. ' if wave else 'Go. '}Then settle at {settle} and start eating at 20 minutes: {b['sips']}"
                  + (f", plus {b['top_up']} g an hour from gels or chews" if b["top_up"] else "") + "."),
            (gun + timedelta(minutes=minutes), f"Finish, about {int(minutes // 60)}:{round(minutes % 60):02d} in ({took['from']}). "
                                               "Dry layers on within 10 minutes, then the recovery drink."),
        ]
        forecast = None
        if w:
            forecast = {"line": wxm.describe(w, units), "kit": wxm.kit(w["feels"] + racewx.RACE_WARMTH_C, False),
                        "warm": "Bring a warm jacket and dry clothes for the finish." if w["feels"] < 12 else "", "where": where}
        before = [d for d in plan["days"] if d["date"] < r["date"] and (d["role"] in ("key", "long") or d.get("commute") == "workout")]
        before = [d for d in before if date.fromisoformat(d["date"]) >= today]
        pack = ["Helmet, shoes, glasses, gloves", "Race number and timing chip", f"{b['servings']:g} servings of {drink['name']} and the gels",
                "Spare tube or plugs, CO2 and inflator, multi-tool", "Floor pump and gauge", "Warm clothes and a towel for after",
                "Recovery: a carb + protein drink or chocolate milk for the finish"]
        out.append({
            "name": r["name"], "label": r["label"], "date": r["date"], "days_out": r["days_out"], "kind": r["kind"],
            "start": _clock(gun), "start_set": bool(start), "wave": wave, "finish": _clock(gun + timedelta(minutes=minutes)),
            "expected": took, "conditions": cond, "playbook": racewx.playbook(cond["picked"] if cond else []),
            "timeline": [{"at": _clock(t), "what": w} for t, w in timeline],
            "strategy": START.get(r["kind"], START["gravel"]) + f" Hold {settle} once the start settles; above it only for the moves that matter."
                        + (f" From wave {wave} you'll be catching riders from the waves ahead: call your pass early and make it on the "
                           "two-track or a climb, not in the singletrack." if wave > 1 and r["kind"] == "mtb" else ""),
            "fuel": {"rate": rate, **{k: b[k] for k in ("setup", "sips", "top_up", "sodium", "no_refill", "climate")}},
            "forecast": forecast,
            "bike": bike.prerace(up, r) if up else [],
            "pack": pack,
            "sessions_left": [{"date": d["date"], "title": d["title"]} for d in before],
            "taper": {"days": r["taper_days"], "race_tsb": r["race_tsb"], "in_band": r["in_band"], "target_tsb": r["target_tsb"]},
        })
    return out
