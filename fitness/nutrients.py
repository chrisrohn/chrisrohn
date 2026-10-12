"""Beyond carbs and protein: the vitamins, minerals and fats a day of eating has to bring, and whether it does.

The Nutty Pudding and the Super Veggie are worked out ingredient by ingredient (USDA FoodData Central, SR Legacy;
the whey and the canned lentils from their labels), so what they bring is known. Against the Dietary Reference
Intakes for your age and sex (National Academies; potassium and sodium from the 2019 update), with the two
vegetarian adjustments the DRIs make (iron × 1.8 and zinc up to × 1.5: plant iron and zinc absorb less, Institute
of Medicine 2001), they carry a lot of the day: fiber, folate, vitamins C and K, magnesium, iron and plant omega-3.
What they can't carry is the same every day:

- **Vitamin B12, iodine, choline, calcium and selenium** come from the gap fillers: a cup of plain Greek yogurt
  (at lunch, where it also lifts the Super Veggie's plant protein past the ~2.5 g of leucine a meal needs to
  build muscle), two eggs, a handful of pumpkin seeds (zinc), and iodized salt in the cooking (sea and pink salt
  aren't iodized).
- **Vitamin D** has almost no food source here, and at 42° N the skin makes next to none from November to February
  (Webb et al., J Clin Endocrinol Metab 1988): the RDA's 600 IU as D3 in those months, or a 25(OH)D test.
- **EPA and DHA** (the long-chain omega-3s) aren't in a vegetarian diet: the chia, flax, walnuts and hemp give ALA,
  which the body turns into EPA at a few percent and DHA at under one. Algae oil is the vegetarian source.

Everything here is a planning estimate, not a food log: it says what a day of these meals brings and what to add,
and leaves dinner (tacos, pizza, beans) as the margin on top. `[nutrition.supplements]` lists what you already
take, so it isn't suggested again.
"""
from __future__ import annotations

from datetime import date

# what each nutrient is called, its unit, and how to round it on the page
NUTRIENTS = {
    "fiber": ("Fiber", "g", 0), "iron": ("Iron", "mg", 1), "zinc": ("Zinc", "mg", 1), "magnesium": ("Magnesium", "mg", 0),
    "calcium": ("Calcium", "mg", 0), "potassium": ("Potassium", "mg", 0), "vitamin_c": ("Vitamin C", "mg", 0),
    "folate": ("Folate", "µg", 0), "b12": ("Vitamin B12", "µg", 1), "vitamin_d": ("Vitamin D", "IU", 0), "iodine": ("Iodine", "µg", 0),
    "selenium": ("Selenium", "µg", 0), "choline": ("Choline", "mg", 0), "vitamin_k": ("Vitamin K", "µg", 0),
    "ala": ("Omega-3 ALA", "g", 1), "epa_dha": ("Omega-3 EPA + DHA", "mg", 0),
}
ORDER = list(NUTRIENTS)

# per 100 g: fiber g, iron mg, zinc mg, magnesium mg, calcium mg, potassium mg, vitamin C mg, folate µg (DFE),
# B12 µg, vitamin D IU, iodine µg, selenium µg, choline mg, vitamin K µg, ALA g, EPA+DHA mg; then protein g, leucine g
_COLS = ORDER + ["protein", "leucine"]
_PER_100G = {
    "berries":   (5.0, 0.6, 0.3, 20, 25, 140, 15, 20, 0, 0, 0, 0.3, 8, 15, 0.1, 0, 1.0, 0.05),     # frozen raspberry/blackberry/blueberry
    "cherries":  (1.6, 0.4, 0.1, 11, 13, 200, 5, 4, 0, 0, 0, 0, 6, 2, 0, 0, 1.0, 0.03),
    "macadamia": (8.6, 3.7, 1.3, 130, 85, 368, 1.2, 11, 0, 0, 0, 3.6, 0, 0, 0.2, 0, 7.9, 0.6),
    "walnut":    (6.7, 2.9, 3.1, 158, 98, 441, 1.3, 98, 0, 0, 0, 4.9, 39, 2.7, 9.1, 0, 15.2, 1.17),
    "chia":      (34.4, 7.7, 4.6, 335, 631, 407, 1.6, 49, 0, 0, 0, 55, 0, 0, 17.8, 0, 16.5, 1.37),
    "flax":      (27.3, 5.7, 4.3, 392, 255, 813, 0.6, 87, 0, 0, 0, 25, 79, 4.3, 22.8, 0, 18.3, 1.24),
    "cocoa":     (37.0, 13.9, 6.8, 499, 128, 1524, 0, 32, 0, 0, 0, 14, 12, 2.5, 0, 0, 19.6, 1.2),
    "lecithin":  (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3000, 0, 0, 0, 0, 0),                     # sunflower: phosphatidylcholine
    "cinnamon":  (53, 8.3, 1.8, 60, 1002, 431, 3.8, 6, 0, 0, 0, 3, 11, 31, 0, 0, 4.0, 0.25),
    "prebiotic": (100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),                      # inulin, GOS, 2'-FL
    "pomegranate": (0, 0, 0, 0, 0, 2000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
    "collagen":  (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 92, 2.7),
    "whey":      (0, 0, 0, 0, 430, 530, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 79, 8.6),                 # Gold Standard, per its label
    "lentils":   (7.9, 3.3, 1.3, 36, 19, 369, 1.5, 181, 0, 0, 0, 2.8, 33, 1.7, 0.1, 0, 9.0, 0.65),
    "chicken":   (0, 1.0, 1.0, 29, 15, 256, 0, 4, 0.34, 5, 0, 27.6, 85, 0.3, 0, 30, 31.0, 2.5),
    "broccoli":  (3.0, 0.6, 0.3, 13, 51, 142, 40, 56, 0, 0, 0, 1.6, 19, 88, 0.1, 0, 2.8, 0.13),  # frozen, cooked
    "cauliflower": (2.7, 0.4, 0.2, 9, 16, 139, 31, 36, 0, 0, 0, 0.6, 39, 10, 0, 0, 1.6, 0.1),
    "shiitake":  (2.1, 0.4, 1.3, 14, 3, 117, 0.3, 21, 0, 0, 0, 24, 37, 0, 0, 0, 1.6, 0.1),
    "olive_oil": (0, 0.6, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0.3, 60, 0.76, 0, 0, 0),
    "lime":      (0.4, 0.1, 0.1, 8, 14, 117, 30, 10, 0, 0, 0, 0.1, 5, 0.6, 0, 0, 0.4, 0),
    "ginger":    (2.0, 0.6, 0.3, 43, 16, 415, 5, 11, 0, 0, 0, 0.7, 29, 0.1, 0, 0, 1.8, 0.07),
    "garlic":    (2.1, 1.7, 1.2, 25, 181, 401, 31, 3, 0, 0, 0, 14, 23, 1.7, 0, 0, 6.4, 0.3),
    "cumin":     (10.5, 66.4, 4.8, 366, 931, 1788, 7.7, 10, 0, 0, 0, 5.2, 25, 5.4, 0.2, 0, 17.8, 0.6),
    "hemp":      (4.0, 7.95, 9.9, 700, 70, 1200, 0.5, 110, 0, 0, 0, 0, 0, 0, 8.7, 0, 31.6, 2.16),
}
# grams per serving, the recipes in grocery.py
RECIPE_GRAMS = {
    "pudding": {"berries": 70, "cherries": 24, "macadamia": 25, "walnut": 5, "chia": 24, "flax": 2.5, "cocoa": 5, "lecithin": 3,
                "cinnamon": 1.3, "prebiotic": 4, "pomegranate": 5, "collagen": 12, "whey": 30.4},
    "veggie": {"lentils": 150, "broccoli": 250, "cauliflower": 150, "shiitake": 50, "olive_oil": 14, "lime": 15, "ginger": 5,
               "garlic": 5, "cumin": 6, "hemp": 10},
}
RECIPE_GRAMS["veggie_chicken"] = {**{k: v for k, v in RECIPE_GRAMS["veggie"].items() if k != "lentils"}, "chicken": 100}

# the gap fillers, per portion: what they bring (same columns), what they're called, and carbs for the day's sums
FILLERS = {
    "yogurt":  {"what": "1 cup plain Greek yogurt", "carbs": 9, "per": (0, 0.2, 1.3, 27, 270, 345, 0, 17, 1.8, 0, 50, 24, 37, 0, 0, 0, 25, 2.5)},
    "eggs":    {"what": "2 eggs", "carbs": 1, "per": (0, 1.8, 1.3, 12, 56, 138, 0, 47, 0.9, 82, 52, 31, 294, 0.6, 0.04, 0, 12.6, 1.1)},
    "pumpkin": {"what": "¼ cup pumpkin seeds", "carbs": 4, "per": (1.7, 2.3, 2.2, 156, 13, 223, 0.5, 16, 0, 0, 0, 2.6, 18, 2.0, 0.05, 0, 8.5, 0.7)},
    "salt":    {"what": "¼ tsp iodized salt in the cooking", "carbs": 0, "per": (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 70, 0, 0, 0, 0, 0, 0, 0)},
}
LEUCINE_MEAL = 2.5      # g of leucine a meal needs to switch on muscle building fully (Norton & Layman; ISSN 2017)

# supplements [nutrition.supplements] can name: what they cover, and how much
SUPPLEMENTS = {"vitamin_d_iu": "vitamin_d", "epa_dha_mg": "epa_dha", "b12_ug": "b12", "iodine_ug": "iodine", "calcium_mg": "calcium",
               "zinc_mg": "zinc", "iron_mg": "iron", "magnesium_mg": "magnesium"}


def _vec(name: str, grams: float) -> dict[str, float]:
    return {k: v * grams / 100 for k, v in zip(_COLS, _PER_100G[name], strict=True)}


def recipe(key: str) -> dict[str, float]:
    """What one serving of a home-made recipe brings, nutrient by nutrient (plus protein and leucine)."""
    out = dict.fromkeys(_COLS, 0.0)
    for name, g in RECIPE_GRAMS[key].items():
        for k, v in _vec(name, g).items():
            out[k] += v
    return out


def filler(key: str) -> dict[str, float]:
    return dict(zip(_COLS, FILLERS[key]["per"], strict=True))


def needs(age: int | None, sex: str = "male", vegetarian: bool = True) -> dict[str, float]:
    """The day's Dietary Reference Intakes (RDA, or AI where there's no RDA). EPA + DHA has no DRI: 250 mg is the
    amount most health bodies use (EFSA 2010)."""
    male, a = sex != "female", age or 40
    n = {"fiber": 38 if male and a <= 50 else 30 if male else 25 if a <= 50 else 21,
         "iron": 8 if male or a > 50 else 18, "zinc": 11 if male else 8, "magnesium": (400 if a <= 30 else 420) if male else (310 if a <= 30 else 320),
         "calcium": 1000 if (male and a <= 70) or (not male and a <= 50) else 1200, "potassium": 3400 if male else 2600,
         "vitamin_c": 90 if male else 75, "folate": 400, "b12": 2.4, "vitamin_d": 600 if a <= 70 else 800, "iodine": 150, "selenium": 55,
         "choline": 550 if male else 425, "vitamin_k": 120 if male else 90, "ala": 1.6 if male else 1.1, "epa_dha": 250}
    if vegetarian:
        n["iron"] *= 1.8
        n["zinc"] *= 1.5
    return n


def low_sun(on: date, lat: float | None) -> bool:
    """Months when the skin makes next to no vitamin D at this latitude (Webb 1988: none at 42° N Nov–Feb)."""
    lat = abs(lat) if lat else 42.0                     # unknown (or unset, 0): the Great Lakes
    return (lat >= 35 and on.month in (11, 12, 1, 2)) or (lat >= 45 and on.month in (10, 3))


def day(recipes: list[str], fillers: list[str], on: date, cfg: dict, age: int | None) -> dict:
    """Coverage for one day: what the Blueprint meals bring, what the gap fillers add, and what's left to a supplement."""
    n = cfg.get("nutrition", {})
    vegetarian = n.get("diet", "vegetarian") == "vegetarian"
    need = needs(age, cfg.get("athlete", {}).get("sex", "male"), vegetarian)
    taken = {SUPPLEMENTS[k]: float(v) for k, v in (n.get("supplements") or {}).items() if k in SUPPLEMENTS}
    core = dict.fromkeys(_COLS, 0.0)
    for r in recipes:
        for k, v in recipe(r).items():
            core[k] += v
    fill = dict.fromkeys(_COLS, 0.0)
    for f in fillers:
        for k, v in filler(f).items():
            fill[k] += v
    rows = []
    for k in ORDER:
        label, unit, nd = NUTRIENTS[k]
        total = core[k] + fill[k] + taken.get(k, 0.0)
        pct = round(100 * total / need[k]) if need[k] else None
        rows.append({"key": k, "label": label, "unit": unit, "need": round(need[k], nd) if nd else round(need[k]),
                     "core": round(core[k], nd) if nd else round(core[k]), "fillers": round(fill[k], nd) if nd else round(fill[k]),
                     "supplement": round(taken[k]) if k in taken else None, "pct": pct,
                     "status": "ok" if pct >= 90 else "near" if pct >= 67 else "low"})
    lat = (cfg.get("weather") or {}).get("lat")
    advice = []
    if "vitamin_d" not in taken:
        advice.append({"name": "Vitamin D3", "dose": "600–1,000 IU a day" if low_sun(on, lat) else "600–1,000 IU a day, November to February",
                       "why": ("At this latitude the skin makes next to none from November to February, and food has almost none: "
                               "the RDA's 600 IU as D3 (up to 1,000 is well under the 4,000 IU upper limit), or ask for a 25(OH)D test."
                               if low_sun(on, lat) else
                               "Riding in summer kit makes plenty now; from November to February the skin makes next to none at this "
                               "latitude, so plan on 600–1,000 IU of D3 then, or a 25(OH)D test in late winter.")})
    if "epa_dha" not in taken:
        advice.append({"name": "Algae oil (EPA + DHA)", "dose": "250–500 mg a day",
                       "why": "The chia, flax, walnuts and hemp give plenty of ALA, but the body turns only a few percent of it into EPA "
                              "and under 1% into DHA; algae oil is where fish get theirs. No DRI: 250 mg is the usual health target."})
    if not n.get("creatine"):
        advice.append({"name": "Creatine monohydrate (optional)", "dose": "3–5 g a day, any time",
                       "why": "Helps the repeated hard surges (a mass start, punchy climbs, sprints for position) more than steady riding; "
                              "vegetarians start with lower muscle stores and respond more (Burke et al. 2003; ISSN position stand 2017). "
                              "Expect about 1 kg of water weight. Your call."})
    return {"rows": rows, "advice": advice, "taken": sorted(taken), "vegetarian": vegetarian,
            "leucine": {"core": round(core["leucine"], 1)}, "fillers": [FILLERS[f]["what"] for f in fillers]}


def lunch_leucine(key: str, with_yogurt: bool) -> float:
    return round(recipe(key)["leucine"] + (filler("yogurt")["leucine"] if with_yogurt else 0), 1)
