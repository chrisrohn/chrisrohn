"""The week's shopping and Sunday prep for the home-made Blueprint meals: how many Nutty Puddings and Super Veggies
the next seven days' fuel plan calls for (fuel.py), your recipes scaled to that, what to buy, what to check you
still have, and what to prep ahead.

Amounts per serving are your recipes, with spoon measures converted to grams (USDA household weights) so they add up.
"""
from __future__ import annotations

import math
from datetime import date, timedelta

DAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

# per serving: (item, grams or count, kind, aisle, note)  kind "g" weighs, "n" counts, "can" is cans, "scoop"
PUDDING = [
    ("Frozen mixed berries (raspberry, blackberry, blueberry)", 70, "g", "freezer", "½ cup"),
    ("Frozen cherries", 3, "n", "freezer", "3 cherries"),
    ("Macadamia nuts", 25, "g", "pantry", ""),
    ("Walnuts", 5, "g", "pantry", ""),
    ("Chia seeds", 24, "g", "pantry", "2 tbsp"),
    ("Flaxseed meal", 2.5, "g", "pantry", "1 tsp"),
    ("Cocoa powder", 5, "g", "pantry", "1 tbsp"),
    ("Sunflower lecithin", 3, "g", "supplements", "1 tsp"),
    ("Ceylon cinnamon", 1.3, "g", "pantry", "½ tsp"),
    ("2'-Fucosyllactose", 1, "g", "supplements", "1,000 mg"),
    ("GOS", 1, "g", "supplements", "1,000 mg"),
    ("Inulin (FOS)", 2, "g", "supplements", "2,000 mg"),
    ("Pomegranate juice powder", 5, "g", "supplements", ""),
    ("Bovine collagen peptides", 12, "g", "supplements", ""),
    ("Optimum Nutrition Gold Standard whey", 1, "scoop", "supplements", "1 scoop"),
]
VEGGIE = [
    ("Westbrae organic black lentils (15 oz can)", 0.5, "can", "pantry", "½ can"),
    ("Frozen broccoli", 250, "g", "freezer", ""),
    ("Frozen cauliflower", 150, "g", "freezer", ""),
    ("Frozen shiitake mushrooms", 50, "g", "freezer", ""),
    ("Extra virgin olive oil", 14, "g", "pantry", "1 tbsp"),
    ("Apple cider vinegar", 15, "g", "pantry", "1 tbsp"),
    ("Limes", 0.5, "n", "fresh", "1 tbsp juice"),
    ("Ginger paste", 5, "g", "pantry", "1 tsp"),
    ("Minced garlic", 5, "g", "pantry", "1 tsp"),
    ("Ground cumin", 6, "g", "pantry", "1 tbsp"),
    ("Hemp seeds", 10, "g", "pantry", "1 tbsp"),
]
CHICKEN = ("Cooked chicken, shredded", 100, "g", "fresh", "instead of the lentils")
BAG_OZ = {"Frozen broccoli": 12, "Frozen cauliflower": 12, "Frozen mixed berries (raspberry, blackberry, blueberry)": 16}


def _weight(g: float, imperial: bool) -> str:
    if not imperial:
        return f"{g / 1000:.1f} kg" if g >= 1000 else f"{round(g)} g"
    oz = g / 28.3495
    return f"{oz / 16:.1f} lb" if oz >= 32 else f"{round(oz, 1):g} oz"


def _line(name: str, total: float, kind: str, imperial: bool, aisle: str = "", note: str = "", servings: int = 0) -> str:
    spoon = note.split(" ") if note.endswith(("tbsp", "tsp")) else None
    if spoon and servings:          # measured with a spoon: say it in spoons, the weight alongside
        qty = 0.5 if spoon[0] == "½" else float(spoon[0])
        return f"{qty * servings:g} {spoon[1]} ({_weight(total, imperial) if total >= 57 else f'{round(total)} g'})"
    if kind == "g" and (aisle == "supplements" or total < 57):   # scoops and pinches are weighed in grams
        return f"{round(total)} g"
    if kind == "can":
        return f"{math.ceil(total)} can{'s' if math.ceil(total) != 1 else ''}"
    if kind == "n":
        n = math.ceil(total)
        return f"{n}" if not name.startswith("Limes") else f"{n} lime{'s' if n != 1 else ''}"
    if kind == "scoop":
        return f"{total:g} scoop{'s' if total != 1 else ''}"
    out = _weight(total, imperial)
    if name in BAG_OZ:
        bags = math.ceil(total / 28.3495 / BAG_OZ[name])
        out += f" (≈ {bags} × {BAG_OZ[name]} oz bag{'s' if bags != 1 else ''})"
    return out


def week(fuel_days: list[dict], cfg: dict, start: date) -> dict | None:
    """From the next seven days' meal plans (fuel.day_plan output): servings, the list, and the prep."""
    if not fuel_days:
        return None
    imperial = cfg["athlete"]["units"] == "imperial"
    pud_days, veg_days, chicken = [], [], False
    for d in fuel_days:
        recipes = [m.get("recipe") for m in d["meals"]]
        dow = DAY[date.fromisoformat(d["date"]).weekday()]
        if "pudding" in recipes:
            pud_days.append(dow)
        if any(r and r.startswith("veggie") for r in recipes):
            veg_days.append(dow)
            chicken = chicken or "veggie_chicken" in recipes
    np, nv = len(pud_days), len(veg_days)
    if not np and not nv:
        return None
    rows = [(item, per * np, kind, aisle, note, np) for item, per, kind, aisle, note in PUDDING if np]
    veg = [CHICKEN if chicken and item.startswith("Westbrae") else (item, per, kind, aisle, note) for item, per, kind, aisle, note in VEGGIE]
    rows += [(item, per * nv, kind, aisle, note, nv) for item, per, kind, aisle, note in veg if nv]
    buy = [{"item": i, "amount": _line(i, t, k, imperial, a)} for i, t, k, a, _, _ in rows if a in ("freezer", "fresh") or k == "can"]
    check = [{"item": i, "amount": _line(i, t, k, imperial, a, note, n), "aisle": a}
             for i, t, k, a, note, n in rows if a in ("pantry", "supplements") and k != "can"]
    prep = []
    if np:
        prep.append(f"Pudding jars ({np}): in each, 25 g macadamias, 5 g walnuts, 2 tbsp chia, 1 tsp flax meal, 1 tbsp cocoa, 1 tsp lecithin, "
                    "½ tsp cinnamon, the prebiotics (1 g 2'-FL, 1 g GOS, 2 g inulin), 5 g pomegranate powder, 12 g collagen and a scoop of whey. "
                    "In the morning: jar + ½ cup water + ½ cup frozen berries + 3 cherries, into the Vitamix.")
    if nv:
        prep.append(f"Super Veggie dressing for {nv}: {nv} tbsp olive oil, {nv} tbsp apple cider vinegar, {nv} tbsp lime juice "
                    f"(about {math.ceil(nv / 2)} lime{'s' if nv > 2 else ''}), {nv} tsp ginger paste, {nv} tsp minced garlic and {nv} tbsp cumin, "
                    "shaken in one jar (a week in the fridge). The hemp seeds go on at the table, so they stay crunchy.")
        prep.append("Lunches: cook the frozen broccoli, cauliflower and shiitake for up to four days at a time (cooked, they keep 3–4 days "
                    "in the fridge) with the lentils rinsed in" + (", or 100 g shredded chicken instead" if chicken else "")
                    + "; dress each bowl when you eat it.")
    end = date.fromisoformat(fuel_days[-1]["date"])
    return {"from": start.isoformat(), "to": end.isoformat(), "pudding": np, "veggie": nv, "pudding_days": pud_days, "veggie_days": veg_days,
            "chicken": chicken, "buy": buy, "check": check, "prep": prep}


def days_from(start: date, n: int = 7) -> list[date]:
    return [start + timedelta(days=i) for i in range(n)]
