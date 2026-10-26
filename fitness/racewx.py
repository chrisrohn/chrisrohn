"""Race conditions at the venue: the forecast where you'll stand and ride (not at home), the trail the two days before
leave behind, and what each case asks of you, the bike and the bottles.

Every case is written out in PLAYBOOK, so the page shows the whole set with the forecast's picks first; the picks are
made again on every sync, and a change that matters goes out as a notification (cloud.race_notify).

The bike lines are for the Cube Nuroad C:62 SL in [bike]: WTB Riddler 45 tubeless on Newmen 25 mm rims, SRAM GX Eagle
AXS 1×12 with Rival AXS levers and hydraulic brakes, a Silca Super Secret drip-waxed chain. Tire pressures start from
the race's Silca numbers (bike.py) and move by the case; the cold correction is Gay-Lussac's law (pressure ∝ absolute
temperature), so numbers pumped in a warm house read low at a cold start line.
"""
from __future__ import annotations

import statistics
from datetime import datetime, timedelta

from fitness import course
from fitness import weather as wxm

ATM_PSI = 14.7
ROOM_C = 20.0             # where pressures usually get set: indoors
RACE_WARMTH_C = 6.0       # racing effort makes it feel about this much warmer than the forecast (≈ 10 °F)
PSI_FLOOR = -3.0          # never more than this under Silca's number: the 25 mm rims start meeting rocks and roots

# key: label, when it applies, and what it changes. `psi` moves the race's Silca pressures (front and rear).
PLAYBOOK: dict[str, dict] = {
    "sand": {
        "label": "Dry and loose", "psi": -1.5,
        "when": "Little or no rain in the two days before: the sand is at its deepest and slowest.",
        "wear": ["Clear or light-tint glasses: the dust off the wave ahead is thick"],
        "bike": ["1–2 psi under your Silca number: the 45 mm Riddler floats instead of plowing, and the 25 mm rims keep it from squirming",
                 "Re-drip the Super Secret the day before, not earlier: dry sand strips wax fast, and dust can't stick to set wax",
                 "Wipe the chain and cassette with a dry rag after the finish; nothing wet on it in the sand"],
        "ride": ["Sit back and keep the front light: weight off the bars, hands loose on the hoods",
                 "Shift one or two easier before the sand and keep the pedals turning smoothly: a stall in deep sand is a walk",
                 "Take the firm line at the edge or the one the leaders packed; never swerve into the soft middle",
                 "On fast sandy descents, ride the drops: lower and further back, with the brakes in reach"],
        "fuel": [],
    },
    "tacky": {
        "label": "Damp and packed", "psi": -0.5,
        "when": "Some rain in the two days before and dry for the race: the sand packs down and the course runs fast.",
        "wear": [],
        "bike": ["Your Silca number, or half a psi under: grip is good and the tires roll fast",
                 "The drip from 1–2 days before is right; nothing more to do"],
        "ride": ["A fast year: the start goes harder and groups hold together longer, so fight for the wheel ahead on the two-track",
                 "Roots and wet leaves in the singletrack stay slick: brake before them, not on them"],
        "fuel": [],
    },
    "rain": {
        "label": "Rain during the race", "psi": -1.0,
        "when": "Rain or showers while you race.",
        "wear": ["A packable waterproof jacket you can race in (unzip to vent) over the layers for the temperature",
                 "Waterproof shoe covers, and waterproof or neoprene gloves",
                 "A cycling cap under the helmet keeps rain off the glasses; clear or yellow lenses with anti-fog"],
        "bike": ["1 psi under your Silca number for grip on wet roots",
                 "Fresh drip the day before: set wax sheds water, but grit gets in. The bike page marks it due again after the race",
                 "Rival pads over 3 mm and bedded in: wet grit wears them twice as fast",
                 "No fenders on race day: they pack with sand and mud"],
        "ride": ["Brake earlier and in a straight line: wet rotors take a moment to bite, so drag the brakes lightly before a descent to clear them",
                 "Roots, boards and bridges straight and off the brakes"],
        "fuel": ["Rain hides the sweat, not the loss: keep to the bottle schedule"],
    },
    "mud": {
        "label": "Soaked or muddy", "psi": -1.5,
        "when": "Heavy rain before (15 mm, 0.6 in, or more in two days) or during: standing water, grit and clay in the low spots.",
        "wear": ["A small rag in the pocket for glasses and chain"],
        "bike": ["Silicone spray inside the fork, the chainstays and the seatstay bridge so mud sheds: the Nuroad's clearance around a 45 mm tire is tight",
                 "Spin each wheel with some mud on before the start; if it rubs, the 45s are too much for the day's mud and you'll be carrying the bike",
                 "Shift less and earlier: a gritty chain skips under load. The AXS shifts cleanly, but the chain still has to catch",
                 "After: rinse with low pressure (not at the bearings), dry it, then strip and re-drip the chain before the next ride"],
        "ride": ["Through puddles you can't see the bottom of: the middle, straight and seated",
                 "Run what you can't ride: on a clogged bike, running beats spinning a slipping wheel"],
        "fuel": [],
    },
    "cold_wet": {
        "label": "Cold and wet", "psi": 0.0,
        "when": "Rain, sleet or wet snow under 8 °C (46 °F): what ends races by hypothermia, not fatigue.",
        "wear": ["Waterproof jacket over a wool or synthetic thermal base layer: nothing cotton",
                 "Waterproof winter gloves, plus a dry spare pair in a zip bag in your pocket",
                 "Waterproof shoe covers over wool socks, with chemical toe warmers on top of the toes",
                 "Embrocation on the legs under knee warmers or tights",
                 "A dry change of everything in the finish bag, with a hat and a warm jacket for the moment you stop"],
        "bike": ["Keep the bike in the warm car until the warm-up: cold sealant seals poorly and the AXS battery runs down faster"],
        "ride": ["No standing around after the warm-up: into the corral with a throwaway layer, dropped at the gun",
                 "Can't feel the brake levers, or the shivering won't stop when you push? Stop at the next aid station: it's a medical call, not a fitness one"],
        "fuel": ["A hot drink with breakfast and warm water in the bottles; eat a little more, since staying warm costs energy"],
    },
    "snow": {
        "label": "Snow", "psi": -2.5,
        "when": "Snow on the ground or falling.",
        "wear": ["Clear or yellow lenses with anti-fog; ski goggles if it's falling hard"],
        "bike": ["2–3 psi under your Silca number for traction, not lower: the 25 mm rims meet the rocks and roots hiding under the snow",
                 "Silicone spray on the frame, fork and derailleur so snow doesn't pack and freeze",
                 "Bike inside overnight and in the warm car until the warm-up: sealant and the AXS battery both like it warm",
                 "Squeeze the brakes a few times before the start: snow on the rotors needs a moment to clear"],
        "ride": ["Ride the ruts the wave ahead cut: leaving a rut costs more than riding it",
                 "Weight back, no sudden steering or braking in the turns; dab a foot rather than fight a slide",
                 "Shift easier before you stop: an iced derailleur hates shifting under load"],
        "fuel": [],
    },
    "frozen": {
        "label": "Frozen ground", "psi": -0.5,
        "when": "A hard frost overnight and below freezing at the gun: the sand is frozen and fast, and ruts and roots are like rock.",
        "wear": [],
        "bike": ["Half a psi under your Silca number: frozen ruts are harsh on a 45 mm tire at full pressure",
                 "Set the pressures outside at the start, or use the cold-corrected numbers",
                 "AXS battery in a warm pocket until the warm-up, then clicked in firmly"],
        "ride": ["The first hour is fast and rattly: loosen the grip and let the bike move under you",
                 "Frozen puddles: ride the edge where there's ground, never across the ice"],
        "fuel": [],
    },
    "ice": {
        "label": "Freezing rain or ice", "psi": -2.0,
        "when": "Freezing rain, or rain onto frozen ground: glaze on roads, bridges and roots.",
        "wear": [],
        "bike": ["2 psi under your Silca number for every bit of grip the tire has",
                 "Check the race's site and email for a delay or course change before you leave"],
        "ride": ["Ice on bridges, boardwalks and paved crossings: no braking or turning on them",
                 "Off the brakes in the turns; scrub speed in a straight line before them"],
        "fuel": [],
    },
    "freezing": {
        "label": "Bitter cold", "psi": 0.0,
        "when": "Feels like −4 °C (25 °F) or colder.",
        "wear": ["Thin liner gloves under windproof lobster gloves: still enough feel to press the AXS buttons",
                 "A balaclava or neck gaiter you can pull down once warm; a windproof-front base layer"],
        "bike": ["AXS battery charged the night before; carry a spare in an inside pocket if you have one: cold can halve the run time",
                 "Bottles in the cages upside down: water freezes from the top, so the valve stays clear"],
        "ride": ["A longer warm-up (20–25 min) just before the corral, then a jacket over everything until the gun"],
        "fuel": ["Insulated bottles with warm water (about 40 °C, 105 °F) in the mix",
                 "Gels and chews in an inside pocket: cold ones go hard and won't squeeze out"],
    },
    "warm": {
        "label": "Warm", "psi": 0.0,
        "when": "16 °C (60 °F) or warmer while racing: rare for November, but it happens.",
        "wear": ["Short sleeves and shorts, arm warmers you can push down; pin the number where the jersey can open"],
        "bike": [],
        "ride": ["A start in the sun feels harder than it is: hold the heart-rate cap"],
        "fuel": ["A third bottle of plain water or an electrolyte tab: warm racing can double your sweat rate"],
    },
    "wind": {
        "label": "Windy", "psi": 0.0,
        "when": "Wind of 25 km/h (15 mph) or more, or gusts over 45 km/h (28 mph).",
        "wear": ["A wind vest or a windproof-front jacket even if it's mild: the windchill on open two-track is real"],
        "bike": ["Pin the number flat so it doesn't flap"],
        "ride": [],
        "fuel": [],
    },
    "storm": {
        "label": "Thunderstorms or damaging gusts", "psi": 0.0,
        "when": "Thunder in the forecast, or gusts of 60 km/h (37 mph) or more.",
        "wear": [],
        "bike": ["Check the race's site and social for a delay before you leave the car"],
        "ride": ["Lightning close by: off the open two-track and away from the bike; no result is worth it",
                 "Gusts bring branches down in the woods: look up as well as ahead"],
        "fuel": [],
    },
}
ORDER = ["storm", "ice", "snow", "cold_wet", "mud", "rain", "frozen", "freezing", "sand", "tacky", "wind", "warm"]


def expected(editions: list[dict] | None, hours: float, km: float = 0, units: str = "imperial") -> dict:
    """How long you'll race: the median elapsed time of your last three editions, else the config's estimate. When this
    year's course (`km`) is a different length from an edition (more than 3% and less than 30% off: a recording, not a
    ride to the start), that edition counts at its own pace over this year's distance."""
    eds = sorted(editions or [], key=lambda e: e["date"])[-3:]
    if not eds:
        return {"minutes": round(hours * 60), "from": "your estimate in config.toml", "history": False, "scaled": False}
    times, scaled = [], False
    for e in eds:
        t = (e.get("elapsed_s") or e["moving_s"]) / 60
        ratio = km * 1000 / e["distance_m"] if km and e.get("distance_m") else 1.0
        if 0.7 <= ratio <= 1.3 and abs(ratio - 1) > 0.03:
            t, scaled = t * ratio, True
        times.append(t)
    clock = lambda t: f"{int(t // 60)}:{round(t % 60):02d}"   # noqa: E731
    raw = [(e.get("elapsed_s") or e["moving_s"]) / 60 for e in eds]
    said = ", ".join(f"{clock(t)} in {e['date'][:4]}" for t, e in zip(raw, eds, strict=True))
    length = f"{km / 1.609344:.1f} mi" if units == "imperial" else f"{km:.1f} km"
    return {"minutes": round(statistics.median(times)), "from": f"your {said}" + (f", at your pace over this year's {length}" if scaled else ""),
            "history": True, "scaled": scaled}


def trail(wx: wxm.Wx, gun: datetime) -> dict:
    """What the last two days left on the course: dry sand, damp and packed, soaked, snow-covered or frozen."""
    before = wx.span(gun - timedelta(hours=48), 48 * 60)
    night = [r["temperature_2m"] for r in wx.span(gun - timedelta(hours=10), 10 * 60) if r["temperature_2m"] is not None]
    rain = round(sum(r["precipitation"] or 0 for r in before), 1)
    snow = any((r["weather_code"] or 0) in wxm.SNOW and (r["precipitation"] or 0) > 0 for r in before)
    if not before:
        return {"state": "unknown", "rain_mm": None, "low_c": None}
    low = min(night) if night else None
    state = ("snow" if snow else "frozen" if low is not None and low <= -2 and night[-1] <= 0
             else "soaked" if rain >= 15 else "damp" if rain >= 2 else "dry")
    return {"state": state, "rain_mm": rain, "low_c": low}


def cases(race_w: dict, pre_w: dict | None, tr: dict) -> list[str]:
    """The playbook entries this forecast picks, most serious first."""
    v, code = race_w["verdict"], race_w["code"]
    picked = set()
    if v == "storm" or (pre_w and pre_w["verdict"] == "storm"):
        picked.add("storm")
    snowing = tr["state"] == "snow" or code in wxm.SNOW
    if code in wxm.FREEZING or (v == "ice" and not snowing and race_w["temp_min"] <= 0):   # glaze, not snow or a cold rain
        picked.add("ice")
    if snowing:
        picked.add("snow")
    elif v in ("wet", "showers") or race_w["rain_mm"] >= 0.2:
        picked.add("rain")
    if tr["state"] == "soaked" or race_w["rain_mm"] >= 5:
        picked.add("mud")
    if picked & {"rain", "snow", "ice", "mud"} and race_w["temp_min"] <= 8:
        picked.add("cold_wet")
    if tr["state"] == "frozen":
        picked.add("frozen")
    if not picked & {"rain", "mud", "snow", "ice", "frozen"}:
        picked.add("tacky" if tr["state"] == "damp" else "sand")
    if min(race_w["feels"], (pre_w or race_w)["feels"]) <= -4:
        picked.add("freezing")
    if race_w["temp_max"] >= 16:
        picked.add("warm")
    if race_w["wind"] >= 25 or race_w["gust"] >= 45:
        picked.add("wind")
    return [k for k in ORDER if k in picked]


def cold_psi(target: float, outside_c: float, set_c: float = ROOM_C) -> float:
    """What to pump to at `set_c` so the gauge reads `target` once the tire is at `outside_c`."""
    return (target + ATM_PSI) * (set_c + 273.15) / (outside_c + 273.15) - ATM_PSI


def pressures(silca: dict | None, picked: list[str], start_c: float | None, units: str) -> dict:
    """The day's race pressures from the Silca numbers, moved by the cases, with the cold correction for pumping indoors."""
    delta = max(PSI_FLOOR, min([PLAYBOOK[k]["psi"] for k in picked] or [0.0]))
    why = next((PLAYBOOK[k]["label"].lower() for k in picked if PLAYBOOK[k]["psi"] == delta), "")
    if not silca:
        line = (f"Run Silca's calculator for this race, then {abs(delta):g} psi under it for {why}" if delta
                else "Run Silca's calculator for this race and use its numbers")
        return {"front": None, "rear": None, "delta": delta, "line": line + ".", "indoors": ""}
    front, rear = round((silca["front"] + delta) * 2) / 2, round((silca["rear"] + delta) * 2) / 2
    line = f"{front:g} front / {rear:g} rear psi" + (f": your Silca {silca['front']:g} / {silca['rear']:g}, {delta:+g} for {why}" if delta else ", your Silca numbers")
    indoors = ""
    if start_c is not None and ROOM_C - start_c >= 5:
        f_in, r_in = cold_psi(front, start_c), cold_psi(rear, start_c)
        if f_in - front >= 0.5:
            indoors = (f"Pumping indoors at {wxm.temp(ROOM_C, units)}? Set {f_in:.1f} / {r_in:.1f} psi: they'll read {front:g} / {rear:g} at the "
                       f"start's {wxm.temp(start_c, units)}. Better still, check with the gauge at the start line.")
    return {"front": front, "rear": rear, "delta": delta, "line": line + ".", "indoors": indoors}


def race_kit(pre_w: dict | None, race_w: dict, finish_w: dict | None, units: str) -> list[str]:
    """Dressing for the effort, the wait before it and the stop after it."""
    racing = race_w["feels"] + RACE_WARMTH_C
    out = [f"Racing (feels like {wxm.temp(race_w['feels'], units)}, dress for {wxm.temp(racing, units)}): {wxm.kit(racing, False)}"]
    if pre_w:
        out.append(f"Warm-up and corral ({wxm.temp(pre_w['feels'], units)}): {wxm.kit(pre_w['feels'], False).lower()}, "
                   "or the race kit plus a throwaway layer you drop at the gun")
    end = finish_w or race_w
    out.append(f"At the finish ({wxm.temp(end['feels'], units)}): a warm jacket, a hat and dry gloves in the finish bag; "
               "you cool fast once you stop")
    return out


def heading_line(heading: float | None, w: dict, units: str, kind: str) -> str:
    """The wind along a point-to-point course: along the course's own line when there is one (w["into_pct"]: the share
    of it ridden into the wind), else the straight line from start to finish."""
    if heading is None or w.get("head") is None:
        return ""
    head, cross = w["head"], abs(w["wind"] ** 2 - w["head"] ** 2) ** 0.5
    way = wxm.compass(heading)
    on = (f"along the course ({w['into_pct']}% of it into the wind; overall it heads {way})" if w.get("into_pct") is not None
          else f"on a course that heads {way}")
    if head >= 10:
        return (f"A headwind of about {wxm.speed(head, units)} {on}: sit in on the open two-track and keep "
                "your turns on the front short; the woods are where you can push")
    if head <= -10:
        return (f"A tailwind of about {wxm.speed(-head, units)} {on}: the open two-track goes fast, so push "
                "there and recover in the woods")
    if cross >= 15:
        return f"A crosswind {on}: ride on the sheltered side of the wheel ahead on open two-track"
    return ""


def advise(*, start_wx: wxm.Wx, finish_wx: wxm.Wx | None, gun: datetime, minutes: float, heading: float | None, silca: dict | None,
           units: str, kind: str, where: str, facing: list[float] | None = None) -> dict | None:
    """Everything the forecast asks for on race morning, or None while it's beyond the forecast's reach. `facing` (the
    course's distance by compass bearing, fitness/course.py) turns the wind along the course itself."""
    race_w = start_wx.window(gun, minutes, heading)
    if not race_w:
        return None
    if facing and (a := course.along(race_w["wind"], race_w.get("wind_dir"), facing)):
        race_w = {**race_w, **a}
    pre_w = start_wx.window(gun - timedelta(minutes=45), 45)
    finish_w = (finish_wx or start_wx).window(gun + timedelta(minutes=minutes), 60)
    tr = trail(start_wx, gun)
    picked = cases(race_w, pre_w, tr)
    if "ice" not in picked:   # a cold rain above freezing is rain, not "icy"
        race_w, pre_w, finish_w = (_unice(w) for w in (race_w, pre_w, finish_w))
    tires = pressures(silca, picked, (pre_w or race_w)["temp_min"], units)
    merged = {part: list(dict.fromkeys(x for k in picked for x in PLAYBOOK[k][part])) for part in ("wear", "bike", "ride", "fuel")}
    merged["wear"] = race_kit(pre_w, race_w, finish_w, units) + merged["wear"]
    merged["bike"] = [f"Tire pressure: {tires['line']}", *([tires["indoors"]] if tires["indoors"] else []), *merged["bike"]]
    if wind := heading_line(heading, race_w, units, kind):
        merged["ride"].insert(0, wind)
    trail_words = {"dry": "dry and loose", "damp": "damp and packed", "soaked": "soaked", "snow": "snow-covered", "frozen": "frozen",
                   "unknown": "not known yet"}[tr["state"]]
    trail_line = (f"Trail: {trail_words}" + (f" ({_mm(tr['rain_mm'], units)} of rain in the 48 hours before the gun" if tr["rain_mm"] is not None else "")
                  + (f", an overnight low of {wxm.temp(tr['low_c'], units)})" if tr["low_c"] is not None else ")" if tr["rain_mm"] is not None else ""))
    sig = "|".join([",".join(picked), str(round(race_w["feels"] / 3)), race_w["verdict"]])
    return {
        "where": where, "picked": picked, "trail": {**tr, "line": trail_line},
        "windows": {"pre": wxm.describe(pre_w, units) if pre_w else None, "race": wxm.describe(race_w, units),
                    "finish": wxm.describe(finish_w, units) if finish_w else None},
        "race_w": {k: race_w.get(k) for k in ("temp_min", "temp_max", "feels", "rain_mm", "pop", "wind", "gust", "verdict", "head", "into_pct")},
        "tires": tires, **merged, "sig": sig,
    }


def _unice(w: dict | None) -> dict | None:
    if not w or w["verdict"] != "ice" or w["temp_min"] <= 0:
        return w
    return {**w, "verdict": "snow" if w["code"] in wxm.SNOW else "wet" if w["rain_mm"] >= 1.0 else "showers"}


def playbook(picked: list[str]) -> list[dict]:
    """Every case, the forecast's picks first, for the "every situation" list."""
    keys = picked + [k for k in ORDER if k not in picked]
    return [{"key": k, "picked": k in picked, **{f: PLAYBOOK[k][f] for f in ("label", "when", "wear", "bike", "ride", "fuel", "psi")}} for k in keys]


def _mm(mm: float, units: str) -> str:
    return f"{mm / 25.4:.2f} in" if units == "imperial" else f"{mm:g} mm"
