"""What to eat, day by day: Bryan Johnson's Blueprint meals (made at home) when they fit, and a vegetarian base for
everything else, sized to the day's training.

- **Targets** scale with the riding today (g per kg of body weight: carbohydrate 3 on rest days, 4 easy, 5 moderate,
  6.5 hard, 8 long, 9 the day before a race; on-bike fuel included; Burke et al., J Sports Sci 2011 / IOC consensus).
  Protein stays at 1.8 g/kg whatever the day (Jäger et al., ISSN position stand 2017).
- **The Nutty Pudding and the Super Veggie** are recommended whenever they fit: the Pudding at breakfast unless a hard
  ride is about to start (then it moves to after the ride) or it's race morning; the Super Veggie at lunch unless a
  race is today or tomorrow. Both are high in fiber and fat and fairly low in carbs (≈ 110 g carbs, ~45 g fiber
  together): right for rest days, short on hard ones, so hard days add carbs alongside them.
- **Everything else** gets a vegetarian base: how many grams of carbs and protein the meal or snack should carry, and
  what that is in rice, tortillas, potatoes or pasta and in tofu, tempeh, eggs, Greek yogurt or beans. Dinner is
  sized to what the day still owes, so taco or pizza night can be planned to hit it.
- Body weight comes from Garmin's profile (or [athlete] weight_kg); without one, targets are given per kg.
"""
from __future__ import annotations

from datetime import date, timedelta

CARBS_PER_KG = {"rest": 3.0, "easy": 3.5, "moderate": 5.0, "hard": 6.0, "long": 7.0, "race": 8.0, "load": 8.0}
FAT_PER_KG = 0.9                                    # what the Pudding, the Super Veggie and dinner add up to, roughly
METS = {"easy": 6.0, "moderate": 7.5, "hard": 9.0, "race": 10.0}   # riding, by the session's intensity
DAILY_LIFE = 1.35                                  # resting burn × this = a desk day without the ride
PROTEIN_PER_KG = 1.8
LABEL = {"rest": "Rest day", "easy": "Easy day", "moderate": "Training day", "hard": "Hard day", "long": "Long-ride day",
         "race": "Race day", "load": "Carb-load day"}

# Nutrition per serving of the home-made recipes, from their ingredients (USDA FoodData Central; labels for the
# whey and the canned lentils). Rounded: these are planning numbers, not a food log.
RECIPES = {
    "pudding": {"name": "Nutty Pudding", "kcal": 620, "protein": 44, "carbs": 41, "fiber": 21, "fat": 36,
                "note": "of the protein, 11 g is collagen, which doesn't build muscle"},
    "veggie": {"name": "Super Veggie", "kcal": 550, "protein": 28, "carbs": 69, "fiber": 25, "fat": 21, "note": "with the black lentils"},
    "veggie_chicken": {"name": "Super Veggie with chicken", "kcal": 520, "protein": 45, "carbs": 34, "fiber": 13, "fat": 25,
                       "note": "100 g chicken instead of the lentils"},
}
COLLAGEN = 11                                         # g of the Pudding's protein that doesn't count toward muscle
BANANA, CARB_SIDE, SHAKE = 27, 45, 24                # g: a banana's carbs; a cup of black rice / a sweet potato; a whey scoop

# Vegetarian building blocks, per unit: carbs and protein (g). Meals are sized as two-part combinations (a main and a
# side that makes up the rest), the way a plate is actually built, not as one ingredient in an impossible amount.
FOODS = {
    "corn tortilla": (12, 1.5), "cup cooked rice": (45, 4), "cup cooked pasta": (43, 8), "medium potato": (37, 4),
    "slice thin-crust pizza": (30, 11), "g extra-firm tofu": (0.02, 0.15), "g tempeh": (0.09, 0.20), "egg": (0.5, 6),
    "cup Greek yogurt": (9, 23), "cup black beans": (40, 15), "oz cheese": (0.5, 7), "cup edamame": (14, 18),
}
SNACK_BLOCKS = "1 cup Greek yogurt ≈ 23 g protein; a banana ≈ 27 g carbs, ¼ cup granola ≈ 18 g, 1 tbsp honey ≈ 17 g, 3 dates ≈ 54 g"
BREAKFAST_BLOCKS = "1 cup dry oats ≈ 54 g carbs, a banana ≈ 27 g, 1 tbsp honey ≈ 17 g, a slice of toast ≈ 15 g; 2 eggs ≈ 12 g protein, ¾ cup Greek yogurt ≈ 17 g"


def tier(day: dict | None) -> str:
    """How hard a planned day is, for eating: the plan's intensity, then how long the riding is. (Not the training-load
    number: two easy hours of commuting score like a hard session but don't eat like one.)"""
    if not day:
        return "rest"
    role, mins, load, level = day.get("role"), day.get("minutes") or 0, day.get("load") or 0, day.get("level")
    if role == "race":
        return "race"
    if role == "rest" or level == "rest" or mins == 0:
        return "rest"
    if level == "easy":
        return "moderate" if mins >= 120 else "easy"
    if role == "long" or mins >= 150:
        return "long"
    if level == "hard":
        return "hard"
    if level == "moderate":
        return "moderate"
    return "hard" if load >= 80 else "moderate" if load >= 40 else "easy"


def burn(t: str, minutes: float, body: dict, level: str | None = None) -> dict:
    """Roughly what the day burns: resting (Mifflin-St Jeor from Garmin's weight, height and age; 22 kcal/kg without
    them) × daily life, plus the riding (METs by kind of day × kg × hours)."""
    kg = body["kg"]
    sex = 5 if body.get("sex", "male") == "male" else -161
    rest = 10 * kg + 6.25 * body["height_cm"] - 5 * body["age"] + sex if body.get("height_cm") and body.get("age") else 22 * kg
    mets = METS["race"] if t == "race" else METS.get(level or "", METS["moderate"])
    ride = mets * kg * minutes / 60 if t != "rest" else 0
    return {"base": round(rest * DAILY_LIFE), "ride": round(ride), "total": round(rest * DAILY_LIFE + ride)}


def on_bike_rate(minutes: float, race: bool = False) -> int:
    """Carbs per hour while riding (g): nothing needed under 75 min, 45 g/h up to 2.5 h, 75 g/h beyond (80 racing)."""
    if minutes < 75:
        return 0
    if race:
        return 80 if minutes >= 150 else 60       # the rate the long rides have been practising
    return 75 if minutes >= 150 else 45


def _r10(x: float) -> int:
    return int(round(x / 10.0) * 10)


def _amount(n: float, unit: str, step: float = 0.5) -> str:
    """'1½ cups cooked rice', '4 corn tortillas', '200 g extra-firm tofu': rounded to something you can measure."""
    if unit.startswith("g "):
        return f"{max(50, int(round(n / 25) * 25))} {unit}"
    n = max(step, round(n / step) * step)
    whole, half = int(n), (n - int(n)) >= 0.5
    num = (f"{whole}½" if whole else "½") if half else f"{whole}"
    plural = n > 1
    word = unit
    if plural:
        head, _, rest = unit.partition(" ")
        word = (head + ("es" if head.endswith("o") else "s") + (" " + rest if rest else "")) if head in ("cup", "slice", "egg", "corn", "medium") else unit
        if head == "corn":
            word = "corn tortillas"
        if head == "medium":
            word = "medium potatoes"
        if head == "egg":
            word = "eggs"
        if head == "oz":
            word = unit
    return f"{num} {word}"


def _split(total: float, main: str, side: str, idx: int, share: float = 0.65, main_cap: float | None = None) -> str:
    """`total` grams of nutrient idx (0 carbs, 1 protein) from a main food and a side making up the rest."""
    per_main, per_side = FOODS[main][idx], FOODS[side][idx]
    want = total * share
    n_main = want / per_main
    if main_cap is not None:
        n_main = min(n_main, main_cap)
    step = 1 if main in ("corn tortilla", "egg", "slice thin-crust pizza") else 0.5
    n_main = round(n_main / 25) * 25 if main.startswith("g ") else max(step, round(n_main / step) * step)
    rest = max(0.0, total - n_main * per_main)
    side_n = rest / per_side
    out = _amount(n_main, main, step)
    if side_n * per_side >= (15 if idx == 0 else 5):   # a ½ cup of rice is noise; 10 g of protein is not
        out += f" + {_amount(side_n, side, 1 if side in ('egg',) else 0.5)}"
    return out


def base(carbs: float | None, protein: float | None, low_fiber: bool = False, kind: str = "meal") -> str:
    """A vegetarian meal or snack sized in grams, and what that means on the plate."""
    if kind == "snack":
        return f"Vegetarian base: ~{_r10(carbs or 0)} g carbs + ~{_r10(protein or 0)} g protein. Blocks: {SNACK_BLOCKS}."
    if kind == "breakfast":
        return f"Vegetarian base: ~{_r10(carbs or 0)} g carbs + ~{_r10(protein or 0)} g protein. Blocks: {BREAKFAST_BLOCKS}."
    parts = []
    if carbs and carbs >= 15:
        if low_fiber:
            opts = [_split(carbs, "cup cooked pasta", "cup cooked rice", 0, 1.0), _amount(carbs / 30, "slice thin-crust pizza", 1)]
        else:
            opts = [_split(carbs, "corn tortilla", "cup cooked rice", 0, 0.5, main_cap=5), _split(carbs, "cup cooked pasta", "cup cooked rice", 0, 1.0),
                    _split(carbs, "medium potato", "cup black beans", 0, 0.7)]
        parts.append(f"~{_r10(carbs)} g carbs ({' / '.join(opts)})")
    if protein and protein >= 10:
        if low_fiber:
            opts = [_split(protein, "egg", "cup Greek yogurt", 1, 0.6, main_cap=4), _split(protein, "g extra-firm tofu", "oz cheese", 1)]
        else:
            opts = [_split(protein, "g extra-firm tofu", "cup black beans", 1), _split(protein, "g tempeh", "oz cheese", 1),
                    _split(protein, "egg", "cup Greek yogurt", 1, 0.5, main_cap=4)]
        parts.append(f"~{_r10(protein)} g protein ({' / '.join(opts)})")
    return "Vegetarian base: " + " + ".join(parts) + "." if parts else ""


# The on-bike drink mix, per serving (one packet): Infinit Go Far's label. [nutrition.ride_fuel] overrides any of it.
RIDE_FUEL = {"name": "Infinit Go Far", "carbs": 66, "sodium": 379, "protein": 4, "bottle_oz": 24}


def bottles(minutes: float, rate: int, drink: dict, cages: int = 2, bladder_l: float = 0, temp_c: float | None = None,
            units: str = "imperial") -> dict:
    """How to set the bottles for a ride and when to drink them. One serving per bottle at normal strength (Infinit's
    design: a bottle an hour), so the drink is also the water; when the day's carbs-an-hour target is above what a
    bottle an hour carries, a gel or chews make up the difference rather than a syrupy double-strength bottle. Past
    what the cages hold, the plan is a refill; the back bladder (water only) is the fallback when there's none."""
    hours = minutes / 60
    per_hour = min(1.0, rate / drink["carbs"])          # bottles an hour: never more than one
    servings = max(0.5, round(per_hour * hours * 2) / 2)
    top_up = max(0, rate - drink["carbs"])               # g an hour from a gel / chews on top
    full = min(cages, int(servings + 0.999))
    bag = max(0.0, servings - cages)
    pace = "⅓" if per_hour >= 0.9 else "¼"
    sips = f"about {pace} of a bottle every 20 min (~{round(drink['carbs'] * (1 / 3 if pace == '⅓' else 1 / 4))} g carbs)"
    half = per_hour < 0.9 and hours > 1.5
    def num(x: float) -> str:
        return f"{int(x)}½" if x % 1 and x > 1 else "½" if x % 1 else f"{int(x)}"

    setup = (f"{full} × {drink['bottle_oz']} oz with 1 serving of {drink['name']} in {'each' if full > 1 else 'it'}"
             + (f", plus {num(bag)} serving{'s' if bag > 1 else ''} of powder in a bag to mix at a refill (an aid station, or a store stop at about the 2-hour mark)" if bag else "")
             + (" and a bottle of plain water" if full < cages else "")
             + ("; the second lasts into the third hour at this pace" if half and not bag and full >= 2 else ""))
    # no refill on the route: the drink mixed double strength in the cages, the back bladder carrying the water
    no_refill = (f"No refill on the route? Mix {num(servings / cages)} servings into each bottle and take the "
                 f"{bladder_l:g} L bladder with water only: a sip of water with every swig of the strong mix, or it sits in your gut."
                 if bag and bladder_l else "")
    sodium = round(drink["sodium"] * per_hour)
    return {"servings": servings, "setup": setup, "sips": sips, "top_up": top_up, "sodium": sodium, "no_refill": no_refill,
            "climate": climate(temp_c, per_hour, drink, sodium, bladder_l, units) if temp_c is not None else ""}


def climate(temp_c: float, per_hour: float, drink: dict, sodium: int, bladder_l: float, units: str) -> str:
    """Drinking for the day's temperature: sweat rate climbs steeply past the mid-20s °C, and with it the water and
    sodium a bottle of mix an hour doesn't cover (ACSM fluid replacement position stand, 2007: 0.4–0.8 L an hour,
    more in heat; ~300–600 mg sodium per litre of sweat lost, more for salty sweaters)."""
    t = f"{round(temp_c * 9 / 5 + 32)}°F" if units == "imperial" else f"{round(temp_c)}°C"
    vol = (lambda litres: f"{round(litres * 33.814)} oz") if units == "imperial" else (lambda litres: f"{round(litres * 1000, -1):g} ml")
    mix_l = per_hour * drink["bottle_oz"] * 0.0295735
    if temp_c >= 24:
        want_l, want_na = (1.0, 800) if temp_c >= 29 else (0.8, 600)
        extra = max(0.0, want_l - mix_l)
        return (f"Hot ({t}): aim for about {vol(want_l)} of fluid and {want_na} mg of sodium an hour. The mix gives {vol(mix_l)} and {sodium} mg, "
                f"so add {vol(extra)} of water an hour with an electrolyte tab"
                + (", from the bladder if there's no refill" if bladder_l else " (refill at a store stop)") +
                ". Drink 500 ml with a pinch of salt in the hour before you start, and slow down before you cook.")
    if temp_c <= 5:
        return (f"Cold ({t}): you won't feel thirsty, but drink on schedule anyway: cold-weather dehydration sneaks up. Fill an insulated "
                "bottle with warm water so the mix stays drinkable and the valve doesn't freeze; keep gels in an inside pocket.")
    return ""


def day_plan(day: dict | None, tomorrow: dict | None, on: date, cfg: dict, weight_kg: float | None, body: dict | None = None) -> dict:
    """Meals for one day: targets, the Blueprint meals when they fit, and a vegetarian base for the rest."""
    n = cfg.get("nutrition", {})
    t, t_next = tier(day), tier(tomorrow)
    if t_next == "race" and t in ("rest", "easy", "moderate"):
        t = "load"
    weekday = on.weekday() < 5
    mins = (day or {}).get("minutes") or 0
    commute = (day or {}).get("commute")
    ride_when = "commute" if commute else (n.get("weekday_ride", "evening") if weekday else "morning")
    rides = mins > 0 and t != "rest"
    body = body or ({"kg": weight_kg} if weight_kg else None)
    kg = body["kg"] if body else None
    carb_target = CARBS_PER_KG[t] * kg if kg else None
    protein_target = PROTEIN_PER_KG * kg if kg else None
    energy = burn(t, mins, body, (day or {}).get("level")) if kg else None
    if energy and t not in ("race", "load"):
        # no more carbohydrate than the day's burn has room for once protein and fat are in (race days and the day
        # before are the deliberate exceptions: that's what filling the tank means)
        room = (energy["total"] - protein_target * 4 - FAT_PER_KG * kg * 9) / 4
        carb_target = max(CARBS_PER_KG["rest"] * kg, min(carb_target, room))
    pudding, veggie = RECIPES["pudding"], RECIPES[n.get("lunch", "veggie")]
    big = t in ("hard", "long", "race") or t_next == "long"
    meals: list[dict] = []
    carbs = protein = 0.0
    pudding_later = False

    def add(slot: str, what: str, why: str, c: float = 0, p: float = 0, base_line: str = "", recipe: str = "") -> None:
        nonlocal carbs, protein
        meals.append({"slot": slot, "what": what, "why": why, **({"base": base_line} if base_line else {}), **({"recipe": recipe} if recipe else {})})
        carbs, protein = carbs + c, protein + p

    # ── breakfast ──
    if t == "race":
        c = 2 * kg if kg else 0
        add("Breakfast", "3 h before the start: oatmeal with banana and honey, or a bagel with jam and a little Greek yogurt",
            "Not the Pudding today: its 21 g of fiber and 36 g of fat sit in your gut for the race. Have it tomorrow.",
            c, 15, base(c, 15, kind="breakfast") if kg else "Vegetarian base: 1.5–2.5 g carbs per kg, low fiber, a little protein.")
    elif rides and ride_when == "morning" and t in ("hard", "long"):
        c = 1.5 * kg if kg else 0
        pudding_later = True
        add("Breakfast", "2–3 h before riding: oatmeal or toast with banana and honey, plus eggs or Greek yogurt",
            "The Pudding is too slow right before a hard ride (36 g fat, 21 g fiber): it's your recovery meal today instead.",
            c, 20, base(c, 20, kind="breakfast") if kg else "Vegetarian base: 1–2 g carbs per kg and ~20 g protein.")
    else:
        extra, c = "", pudding["carbs"]
        if t == "load":
            extra, c = ", plus toast or a bagel with honey and a banana (+80 g carbs): today is about carbs, and it's early enough for the fiber", c + 80
        elif big or (rides and ride_when == "morning" and t != "easy"):
            extra, c = f", with a banana (+{BANANA} g carbs)", c + BANANA
        when = " at least 45 min before you leave: its fat and fiber digest slowly" if commute or (rides and ride_when == "morning") else ""
        add("Breakfast", f"Nutty Pudding{extra}{when}",
            f"{pudding['protein']} g protein, {pudding['carbs']} g carbs, {pudding['fiber']} g fiber ({pudding['note']}).",
            c, pudding["protein"] - COLLAGEN, recipe="pudding")

    # ── lunch ──
    if t in ("load", "race"):
        c = 150 if t == "load" else 100
        add("Lunch", "Low-fiber: white rice or pasta with eggs or tofu, cooked carrots or zucchini",
            "Not the Super Veggie today: lentils and crucifers (~25 g fiber) around a race are asking for GI trouble."
            if t == "load" else "Refuel after the finish; the Super Veggie is back tomorrow.", c, 25, base(c, 25, low_fiber=True))
        if t == "load":
            c = 2 * kg if kg else 0
            add("Snacks", "Carb snacks every couple of hours: bagel, rice cakes with honey, bananas, juice, pretzels",
                "Topping up glycogen takes the whole day; one big dinner can't hold it all.", c, 0,
                f"Vegetarian base: ~{_r10(c)} g carbs across the afternoon." if kg else "")
    else:
        side = big or (t == "moderate" and ride_when in ("evening", "commute"))
        what = veggie["name"] + (" with the lentils" if veggie is RECIPES["veggie"] else "")
        if side:
            what += f", plus a cup of cooked black rice or a medium sweet potato (+{CARB_SIDE} g carbs)"
        if pudding_later and not weekday:
            what += ", after the ride"
        why = (f"{veggie['carbs'] + (CARB_SIDE if side else 0)} g carbs to refill what the ride used." if side and pudding_later and not weekday
               else f"{veggie['carbs'] + (CARB_SIDE if side else 0)} g carbs for the riding still to come." if side
               else f"{veggie['protein']} g protein, {veggie['carbs']} g carbs, {veggie['fiber']} g fiber: as it is, it fits the day.")
        add("Lunch", what, why, veggie["carbs"] + (CARB_SIDE if side else 0), veggie["protein"], recipe=n.get("lunch", "veggie"))

    # ── before, during and after the ride ──
    if rides and t != "race" and mins >= 45 and t in ("moderate", "hard", "long") and ride_when in ("evening", "commute"):
        workout_home = commute == "workout"
        c = 40 if workout_home else 35
        lead = "the ride home" if commute else "riding"
        add("Snack", f"60–90 min before {lead}: a banana or 3 dates, or rice cakes with honey",
            "The ride home carries the workout: start it fuelled." if workout_home else "Lunch was hours ago; top up so the session starts fuelled.",
            c, 0, f"Vegetarian base: ~{c} g fast carbs, little fat or fiber.")
    longest = mins / 2 if commute else mins          # a commute is two rides of about an hour, not one long one
    rate = on_bike_rate(longest, race=t == "race")
    if rides and rate:
        on_bike = rate * mins / 60
        drink = {**RIDE_FUEL, **n.get("ride_fuel", {})}
        b = bottles(mins, rate, drink, n.get("bottle_cages", 2), n.get("bladder_l", 0), (day or {}).get("ride_temp"), cfg.get("athlete", {}).get("units", "imperial"))
        extra = f" On top, a gel or a few chews every hour (~{b['top_up']} g carbs)." if b["top_up"] >= 10 else ""
        add("On the bike", f"{rate} g carbs an hour, ~{_r10(on_bike)} g in all. Bottles: {b['setup']}. Start sipping in the first 15 min, "
            f"then {b['sips']}.{extra}",
            "Little and often absorbs best, and ride mode reminds you every 20 min. "
            + (b["climate"] if b["climate"] else f"{drink['name']} carries ~{b['sodium']} mg sodium an hour: in heat, or if you finish crusted in salt, add an electrolyte tab to one bottle.")
            + (f" {b['no_refill']}" if b["no_refill"] else ""),
            on_bike, drink["protein"] * b["servings"])
    if t in ("hard", "long", "race"):
        if pudding_later:
            add("After the ride", "The Nutty Pudding, within an hour of finishing, with a banana",
                "Its protein and the banana's carbs start the repair; this is when its fat and fiber don't get in the way.",
                pudding["carbs"] + BANANA, pudding["protein"] - COLLAGEN, recipe="pudding")
        else:
            add("After the ride", "Within an hour: a whey shake with fruit, or Greek yogurt with berries and honey",
                "Protein and carbs early start the repair and refill the glycogen tomorrow's riding needs.",
                40, SHAKE, base(40, SHAKE, kind="snack"))

    # ── dinner (and an evening snack when the day still owes a lot) ──
    left_c = (carb_target - carbs) if carb_target else None
    left_p = (protein_target - protein) if protein_target else None
    snack_c = snack_p = 0.0
    light = t in ("rest", "easy")
    if left_c is not None and light:
        # on a light day the carb figure is a ceiling, not a quota: dinner stays light and any late snack is protein
        left_c = min(left_c, 1.0 * kg)
        if left_p > 50:
            snack_p = left_p - 50
    elif left_c is not None and (left_c > 200 or left_p > 60):
        snack_c, snack_p = max(0.0, left_c * 0.3), max(0.0, left_p * 0.35)
    low_fiber = t == "load" or t_next == "race"
    if low_fiber:
        idea = "The carb night: pasta with marinara and parmesan, or a cheese pizza, with eggs, tofu or Greek yogurt for protein. Skip the beans tonight (fiber), keep fat moderate, eat by 7."
    elif t_next == "long":
        idea = "Tomorrow's long ride starts here: veggie pizza (thin crust) with edamame on the side, or rice-and-bean tacos with eggs or tofu."
    elif t in ("hard", "long", "race"):
        idea = "A big plate: bean-and-tofu tacos on corn tortillas with rice, or veggie pizza with edamame or a Greek-yogurt dip on the side."
    elif t == "moderate":
        idea = "Tacos: corn tortillas, black beans, tofu or tempeh crumble or eggs, cabbage, salsa, avocado. Pizza night: veggie, 2–3 slices, salad first."
    else:
        idea = "Lighter: veg-heavy tacos (2 tortillas or lettuce wraps) with tofu, tempeh or eggs, or a big salad with chickpeas and feta."
    if left_c is not None:
        dinner_c, dinner_p = max(0.0, left_c - snack_c), max(0.0, left_p - snack_p)
        line = base(dinner_c, dinner_p, low_fiber)
        if t in ("rest", "easy"):
            line = line.replace("Vegetarian base: ~", "Vegetarian base: up to ~", 1)
        add("Dinner", idea, f"Sized to what's left of the day's {_r10(carb_target)} g carbs and {_r10(protein_target)} g protein.",
            dinner_c, dinner_p, line)
    else:
        add("Dinner", idea, f"Aim for about {CARBS_PER_KG[t]:g} g carbs and {PROTEIN_PER_KG:g} g protein per kg over the whole day.")
    if snack_c >= 15 or snack_p >= 10:
        if snack_c < 15:
            add("Evening snack", "Greek yogurt or cottage cheese, plain or with a few berries",
                "Protein the light dinner didn't carry; it also helps overnight repair.", 0, snack_p,
                f"Vegetarian base: ~{_r10(snack_p)} g protein (1 cup Greek yogurt ≈ 23 g, 1 cup cottage cheese ≈ 25 g).")
        else:
            add("Evening snack", "Greek yogurt with fruit and granola, or cottage cheese with berries and honey",
                "The day still owes more than one dinner can carry comfortably.", snack_c, snack_p, base(snack_c, snack_p, kind="snack"))

    kcal = carb_target * 4 + protein_target * 4 + FAT_PER_KG * kg * 9 if kg else None
    return {"date": on.isoformat(), "tier": t, "label": LABEL[t], "weekday": weekday,
            "carbs_g": _r10(carb_target) if carb_target else None, "protein_g": _r10(protein_target) if protein_target else None,
            "kcal": int(round(kcal / 50) * 50) if kcal else None, "burn": {k: int(round(v / 50) * 50) for k, v in energy.items()} if energy else None,
            "carbs_per_kg": CARBS_PER_KG[t], "protein_per_kg": PROTEIN_PER_KG, "meals": meals}


def plan(days: list[dict], today: date, cfg: dict, weight_kg: float | None, profile: dict | None = None) -> dict | None:
    """Today's and tomorrow's meals from the season plan's next days (today's entry already eased by readiness)."""
    if not days:
        return None
    by = {d["date"]: d for d in days}
    p = profile or {}
    body = {"kg": weight_kg, "height_cm": p.get("height_cm"), "age": today.year - p["birth_year"] if p.get("birth_year") else None,
            "sex": cfg.get("athlete", {}).get("sex", "male")} if weight_kg else None
    d0, d1, d2 = (by.get((today + timedelta(days=i)).isoformat()) for i in range(3))
    return {"weight_kg": round(weight_kg, 1) if weight_kg else None,
            "today": day_plan(d0, d1, today, cfg, weight_kg, body),
            "tomorrow": day_plan(d1, d2, today + timedelta(days=1), cfg, weight_kg, body),
            "kitchen": _kitchen(by, today, cfg, weight_kg, body),
            "recipes": {k: {f: v[f] for f in ("name", "kcal", "protein", "carbs", "fiber", "fat")} for k, v in RECIPES.items()}}


def _kitchen(by: dict, today: date, cfg: dict, weight_kg: float | None, body: dict | None) -> dict | None:
    """The next seven days' Blueprint meals, as a shopping list and prep plan (grocery.py)."""
    from fitness import grocery

    start = today + timedelta(days=1)
    week = [day_plan(by.get(d.isoformat()), by.get((d + timedelta(days=1)).isoformat()), d, cfg, weight_kg, body)
            for d in grocery.days_from(start) if d.isoformat() in by]
    return grocery.week(week, cfg, start)
