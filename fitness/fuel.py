"""What to eat, day by day, built around Bryan Johnson's Blueprint meals (made at home) and the day's training.

Weekdays start from the Nutty Pudding at breakfast and the Super Veggie at lunch ([nutrition] in config.toml); the
rest of the day is planned around them and around what's on the bike today and tomorrow:

- Daily carbohydrate scales with the day's training (g per kg of body weight: rest 3, easy 4, moderate 5, hard 6.5,
  long 8, the day before a race 9; Burke et al., J Sports Sci 2011 / IOC consensus), including what's eaten on the bike.
  Protein stays at 1.8 g/kg whatever the day (Jäger et al., ISSN position stand 2017).
- Blueprint is high in fiber and fat and fairly low in carbs (Pudding + Super Veggie ≈ 110 g carbs, ~45 g fiber):
  right for rest days, short on hard ones. So hard days add carbs to the Blueprint meals rather than replacing them,
  and the day before a race and race morning swap them for low-fiber meals (GI comfort).
- Evenings are free: the dinner line says how much carbohydrate and protein is still to come, and how tacos or pizza
  can deliver it (a carb dinner before a long ride is a feature, not a lapse).
- Body weight comes from Garmin's profile (or [athlete] weight_kg); without one, targets are given per kg.
"""
from __future__ import annotations

from datetime import date, timedelta

CARBS_PER_KG = {"rest": 3.0, "easy": 4.0, "moderate": 5.0, "hard": 6.5, "long": 8.0, "race": 8.0, "load": 9.0}
PROTEIN_PER_KG = 1.8
LABEL = {"rest": "Rest day", "easy": "Easy day", "moderate": "Training day", "hard": "Hard day", "long": "Long-ride day",
         "race": "Race day", "load": "Carb-load day"}
DOW = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

# Nutrition per serving of the home-made recipes, from their ingredients (USDA FoodData Central; labels for the
# whey and the canned lentils). Rounded: these are planning numbers, not a food log.
RECIPES = {
    "pudding": {"name": "Nutty Pudding", "kcal": 620, "protein": 44, "carbs": 41, "fiber": 21, "fat": 36,
                "note": "of the protein, 11 g is collagen, which doesn't build muscle"},
    "veggie": {"name": "Super Veggie", "kcal": 550, "protein": 28, "carbs": 69, "fiber": 25, "fat": 21, "note": "with the black lentils"},
    "veggie_chicken": {"name": "Super Veggie with chicken", "kcal": 520, "protein": 45, "carbs": 34, "fiber": 13, "fat": 25,
                       "note": "100 g chicken instead of the lentils"},
}
BANANA, CARB_SIDE, SNACK, SHAKE = 27, 45, 35, 24   # grams: a banana's carbs; a cup of black rice / a sweet potato; a pre-ride snack; whey


def tier(day: dict | None) -> str:
    """How hard a planned day is, for eating."""
    if not day:
        return "rest"
    role, mins, load, level = day.get("role"), day.get("minutes") or 0, day.get("load") or 0, day.get("level")
    if role == "race":
        return "race"
    if role == "rest" or level == "rest" or mins == 0:
        return "rest"
    if mins >= 150 or (role == "long" and mins >= 120):
        return "long"
    if level == "hard" or load >= 80:
        return "hard"
    if level == "moderate" or load >= 40:
        return "moderate"
    return "easy"


def on_bike_rate(minutes: float, race: bool = False) -> int:
    """Carbs per hour while riding (g): nothing needed under 75 min, 45 g/h up to 2.5 h, 75 g/h beyond (80 racing)."""
    if minutes < 75:
        return 0
    if race:
        return 80 if minutes >= 150 else 60       # the rate the long rides have been practising
    return 75 if minutes >= 150 else 45


def _r10(x: float) -> int:
    return int(round(x / 10.0) * 10)


def day_plan(day: dict | None, tomorrow: dict | None, on: date, cfg: dict, weight_kg: float | None) -> dict:
    """Meals for one day: targets, the Blueprint meals and their add-ons, the snack, on-bike fuel, and what dinner owes."""
    n = cfg.get("nutrition", {})
    t, t_next = tier(day), tier(tomorrow)
    race_eve = t_next == "race"
    if race_eve and t in ("rest", "easy", "moderate"):
        t = "load"
    blueprint = DOW[on.weekday()] in n.get("blueprint_days", ["mon", "tue", "wed", "thu", "fri"])
    mins = (day or {}).get("minutes") or 0
    commute = (day or {}).get("commute")
    ride_when = "commute" if commute else ("morning" if not blueprint else n.get("weekday_ride", "evening"))
    rides = t not in ("rest", "load") or (t == "load" and mins > 0)
    kg = weight_kg or None
    carb_target = CARBS_PER_KG[t] * kg if kg else None
    protein_target = PROTEIN_PER_KG * kg if kg else None
    pudding, lunch_key = RECIPES["pudding"], n.get("lunch", "veggie")
    meals: list[dict] = []
    carbs = protein = 0.0
    big = t in ("hard", "long", "race") or t_next == "long"

    # ── breakfast ──
    if t == "race":
        rate = on_bike_rate(mins, race=True)
        g = f"{_r10(1.5 * kg)}–{_r10(2.5 * kg)} g" if kg else "1.5–2.5 g/kg"
        meals.append({"slot": "Breakfast", "what": f"3 h before the start: {g} of low-fiber carbs, e.g. oatmeal with banana and honey, or a bagel with jam, plus a little protein",
                      "why": "Not the Pudding today: its 21 g of fiber and 36 g of fat sit in your gut for the race. Have it tomorrow."})
        carbs += 2 * kg if kg else 0
    elif blueprint:
        add = []
        if t == "load":
            add.append("plus toast or a bagel with honey and a banana (+80 g carbs): today is about carbs, and it's early enough for the fiber")
            carbs += 80
        elif big or (rides and ride_when == "morning" and t != "easy"):
            add.append(f"a banana alongside (+{BANANA} g carbs)")
            carbs += BANANA
        when = ""
        if commute or (rides and ride_when == "morning"):
            when = " at least 45 min before you leave: its fat and fiber digest slowly"
        meals.append({"slot": "Breakfast", "what": "Nutty Pudding" + (f", {add[0]}" if add else "") + when,
                      "why": f"{pudding['protein']} g protein, {pudding['carbs']} g carbs, {pudding['fiber']} g fiber ({pudding['note']})."})
        carbs += pudding["carbs"]
        protein += pudding["protein"] - 11
    elif t == "long" or (rides and t == "hard"):
        g = f"{_r10(1 * kg)}–{_r10(2 * kg)} g" if kg else "1–2 g/kg"
        meals.append({"slot": "Breakfast", "what": f"2–3 h before riding: {g} of carbs, e.g. oatmeal or toast, banana, honey, eggs or yogurt",
                      "why": "The Pudding is too slow right before a long ride (36 g fat, 21 g fiber); have it afterwards as the recovery meal instead."})
        carbs += 1.5 * kg if kg else 0
        protein += 20
    else:
        meals.append({"slot": "Breakfast", "what": "Nutty Pudding works any day", "why": "A free morning: the Blueprint breakfast is the easy default."})
        carbs += pudding["carbs"]
        protein += pudding["protein"] - 11

    # ── lunch ──
    if t == "load" or t == "race":
        meals.append({"slot": "Lunch", "what": "Low-fiber carbs and lean protein: chicken or fish with white rice or pasta, cooked carrots or zucchini",
                      "why": "Skip the Super Veggie the day before a race and on race day: lentils and crucifers (~25 g fiber) are asking for GI trouble."
                      if t == "load" else "Refuel after the finish; normal eating resumes tomorrow."})
        carbs += 150 if t == "load" else 100
        protein += 35
        if t == "load":
            g = f"~{_r10(2 * kg)} g" if kg else "about 2 g/kg"
            meals.append({"slot": "Afternoon", "what": f"Carb snacks every couple of hours ({g} in all): bagel, rice cakes with honey, bananas, juice, pretzels",
                          "why": "Topping up glycogen takes the whole day; one big dinner can't hold it all."})
            carbs += 2 * kg if kg else 0
    elif blueprint:
        if big or (t == "moderate" and ride_when in ("evening", "commute")):
            recipe = RECIPES["veggie"]
            side = big
            what = "Super Veggie with the lentils" + (f", plus a cup of cooked black rice or a medium sweet potato (+{CARB_SIDE} g carbs)" if side else "")
            why = f"{recipe['carbs']} g carbs from the lentils{' and the side' if side else ''} for the riding still to come."
            carbs += recipe["carbs"] + (CARB_SIDE if side else 0)
        else:
            recipe = RECIPES["veggie_chicken"] if t in ("rest", "easy") else RECIPES[lunch_key]
            what = recipe["name"] + (" (or with lentils; either fits)" if recipe is RECIPES["veggie_chicken"] else "")
            day_kind = LABEL[t].lower()
            why = f"{recipe['protein']} g protein, {recipe['carbs']} g carbs: on {'an' if day_kind[0] in 'aeiou' else 'a'} {day_kind} the chicken version's extra protein and fewer carbs suit."
            carbs += recipe["carbs"]
        protein += recipe["protein"]
        meals.append({"slot": "Lunch", "what": what, "why": why})

    # ── before, during and after the ride ──
    if rides and t != "race" and (ride_when in ("evening", "commute") or not blueprint) and mins >= 45:
        if ride_when == "commute":
            home = (day or {}).get("commute_workout") and commute == "workout"
            meals.append({"slot": "Afternoon", "what": f"60–90 min before the ride home: a banana or 3 dates (~{SNACK if not home else 40} g carbs) and water",
                          "why": "The ride home " + ("carries the workout: start it fuelled." if home else "is the second half of the day's riding.")})
            carbs += SNACK if not home else 40
        elif ride_when == "evening" and blueprint and t in ("moderate", "hard", "long"):
            meals.append({"slot": "Afternoon", "what": f"60–90 min before riding: a banana or 3 dates (~{SNACK} g carbs)",
                          "why": "Lunch was hours ago; top up so the session starts fuelled."})
            carbs += SNACK
    longest = mins / 2 if commute else mins          # a commute is two rides of about an hour, not one long one
    rate = on_bike_rate(longest, race=t == "race")
    if rides and rate:
        on_bike = rate * mins / 60
        meals.append({"slot": "On the bike", "what": f"{rate} g carbs an hour from the first 20 min (about {_r10(on_bike)} g in all): drink mix, gels, rice cakes, bananas",
                      "why": "Above 75 minutes, riding fed is faster and recovers better than riding empty."})
        carbs += on_bike
    if t in ("hard", "long", "race"):
        meals.append({"slot": "After", "what": f"Within an hour: a whey shake (+{SHAKE} g protein) with fruit, or dinner if it's that soon"
                      + ("; or the Nutty Pudding you skipped this morning" if not blueprint and t in ("hard", "long") else ""),
                      "why": "Protein and carbs early start the repair and refill the glycogen tomorrow's riding needs."})
        protein += SHAKE
        carbs += 30

    # ── dinner: what's left ──
    left_c = (carb_target - carbs) if carb_target else None
    left_p = (protein_target - protein) if protein_target else None
    if t_next == "race" or t == "load":
        idea = "Tonight is the carb night: pasta, rice, or pizza (thin crust, go easy on heavy toppings) with lean protein. Keep fiber and fat moderate, eat by 7, no new foods."
    elif t_next == "long":
        idea = "Tomorrow's long ride starts here: pizza (thin crust) with a side salad, or rice-and-bean tacos on corn tortillas, is exactly right tonight."
    elif t in ("hard", "long", "race"):
        idea = "Pizza or tacos both work: 4 slices, or 4 corn-tortilla tacos with rice and beans; add chicken, fish or steak for the protein."
    elif t == "moderate" or (t == "easy" and left_c is not None and left_c >= 150):
        idea = "Tacos: 3 corn tortillas with chicken, fish or steak, cabbage, salsa and a few beans. Pizza night: 2–3 slices, salad first."
    else:
        idea = "Lighter tonight: veg-heavy tacos (2 tortillas or lettuce wraps) with ~150 g chicken or fish. Pizza night: 2 slices and a big salad."
    need = []
    if left_c is not None:
        need.append(f"{'up to ' if t in ('rest', 'easy') else ''}~{max(0, _r10(left_c))} g carbs")
    if left_p is not None:
        need.append(f"~{max(0, _r10(left_p))} g protein")
    meals.append({"slot": "Dinner", "what": idea, "why": ("Still to come after the meals above: " + ", ".join(need) + ".") if need else
                  f"Aim for about {CARBS_PER_KG[t]:g} g carbs and {PROTEIN_PER_KG:g} g protein per kg over the whole day."})

    return {"date": on.isoformat(), "tier": t, "label": LABEL[t], "blueprint": blueprint,
            "carbs_g": _r10(carb_target) if carb_target else None, "protein_g": _r10(protein_target) if protein_target else None,
            "carbs_per_kg": CARBS_PER_KG[t], "protein_per_kg": PROTEIN_PER_KG, "meals": meals}


def plan(days: list[dict], today: date, cfg: dict, weight_kg: float | None) -> dict | None:
    """Today's and tomorrow's meals from the season plan's next days (today's entry already eased by readiness)."""
    if not days:
        return None
    by = {d["date"]: d for d in days}
    d0, d1, d2 = (by.get((today + timedelta(days=i)).isoformat()) for i in range(3))
    return {"weight_kg": round(weight_kg, 1) if weight_kg else None,
            "today": day_plan(d0, d1, today, cfg, weight_kg),
            "tomorrow": day_plan(d1, d2, today + timedelta(days=1), cfg, weight_kg),
            "recipes": {k: {f: v[f] for f in ("name", "kcal", "protein", "carbs", "fiber", "fat")} for k, v in RECIPES.items()}}
