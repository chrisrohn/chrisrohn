"""Synthetic athlete for `python -m fitness demo`: two years of Venu Sq-shaped wellness and rides, Zwift / MyWoosh
winters (Strava-only virtual rides with power), two past Icemen and Barry-Roubaix Killers, and Strava twins of the
Garmin rides so the merge is exercised. Seeded, so the demo page is the same every run."""
from __future__ import annotations

import math
import random
from datetime import date, datetime, timedelta

from fitness.activities import activity
from fitness.store import Store


def populate(store: Store, today: date, days: int = 760, seed: int = 7) -> None:
    rnd = random.Random(seed)
    fatigue, fitness, late = 0.0, 35.0, False
    for i in range(days, -1, -1):
        d = today - timedelta(days=i)
        season = 0.75 + 0.35 * math.sin((d.timetuple().tm_yday - 100) / 365 * 2 * math.pi)
        dow = d.weekday()
        planned = [0, 70, 45, 65, 25, 120, 55][dow] * season * rnd.uniform(0.7, 1.25)
        ride = dow != 0 and rnd.random() > 0.12
        load = 0.0
        winter = d.month in (12, 1, 2)
        if ride and winter:
            ftp = 228 + 22 * min(1.0, ((d - date(d.year if d.month == 12 else d.year - 1, 12, 1)).days) / 90)
            hours = min(2.5, planned / 62)
            intensity = rnd.uniform(0.68, 0.9) if dow in (1, 3) else rnd.uniform(0.6, 0.72)
            start = datetime.combine(d, datetime.min.time()) + timedelta(hours=rnd.choice([6, 17.5, 18.5, 19.5]))
            app = rnd.choice(["Zwift - Watopia", "Zwift - Makuri Islands", "MyWoosh - Belgium", "MyWoosh - Abu Dhabi"])
            store.put_activity(activity(id=f"strava:z{d.toordinal()}", source="strava", start=start, kind="VirtualRide", name=f"{app} workout",
                                        duration_s=hours * 3600, moving_s=hours * 3600, distance_m=hours * 31000, elev_m=hours * 250,
                                        avg_hr=round(118 + 50 * intensity), max_hr=round(150 + 40 * intensity), avg_power=round(ftp * intensity * 0.95),
                                        np=round(ftp * intensity)))
            load = hours * intensity ** 2 * 100
        elif ride:
            hours = planned / 55
            kind = "mountain_biking" if dow in (5, 6) and rnd.random() > 0.3 else "road_biking"
            start = datetime.combine(d, datetime.min.time()) + timedelta(hours=rnd.choice([6.5, 7, 12, 17.5, 18, 19.5]))
            hr = rnd.uniform(128, 152)
            speed = rnd.uniform(19, 23) if kind == "mountain_biking" else rnd.uniform(24, 29)
            dur = hours * 3600
            zones = [dur * f for f in (0.25, 0.45, 0.18, 0.09, 0.03)]
            act = activity(id=f"garmin:{d.toordinal()}", source="garmin", start=start, kind=kind,
                           name="Kalkaska Mountain Biking" if kind == "mountain_biking" else "Traverse City Road Cycling",
                           duration_s=dur * 1.05, moving_s=dur, distance_m=speed * hours * 1000, elev_m=hours * rnd.uniform(180, 420),
                           avg_hr=round(hr), max_hr=round(hr + rnd.uniform(18, 32)), hr_zones=zones)
            store.put_activity(act)
            if rnd.random() > 0.2:
                twin = dict(act, id=f"strava:{d.toordinal()}", source="strava", start=(start + timedelta(seconds=40)).isoformat(),
                            name=rnd.choice(["Sandy two-track grind", "Vasa loop", "Lunch ride", "Evening spin"]))
                store.put_activity(twin)
            load = planned
        late_today = ride and start.hour >= 17
        fitness += (load - fitness) / 42
        fatigue += (load - fatigue) / 7
        strain = max(0.0, fatigue - fitness)
        total = rnd.gauss(7.4, 0.5) * 3600 - strain * 150 - (2700 if late else 0)
        late = late_today
        total = max(4.5 * 3600, total)
        deep = total * rnd.uniform(0.13, 0.24)
        rem = total * rnd.uniform(0.17, 0.27)
        awake = rnd.uniform(5, 40) * 60
        bed = datetime.combine(d - timedelta(days=1), datetime.min.time()) + timedelta(hours=22.5 + rnd.gauss(0.3, 0.5))
        sick = 0 < (today - d).days % 97 < 4
        rhr = 49 + strain * 0.18 + rnd.gauss(0, 1.1) + (6 if sick else 0)
        stress = 16 + strain * 0.35 + rnd.gauss(0, 3) + (12 if sick else 0)
        night = {"start": bed.strftime("%Y-%m-%dT%H:%M"), "end": (bed + timedelta(seconds=total + awake)).strftime("%Y-%m-%dT%H:%M"),
                 "total": round(total), "deep": round(deep), "rem": round(rem), "light": round(total - deep - rem), "awake": round(awake),
                 "awake_count": rnd.randint(0, 4), "avg_stress": round(stress, 1), "resp": round(rnd.gauss(13.6, 0.3) + (1.4 if sick else 0), 1),
                 "restless": rnd.randint(20, 70)}
        bb = max(20, min(100, round(88 - strain * 0.9 + rnd.gauss(0, 6) - (20 if sick else 0))))
        store.put_day(d.isoformat(), {"rhr": round(rhr), "stress": round(stress + 10), "bb_high": bb, "bb_wake": bb, "bb_low": max(5, bb - 60),
                                      "steps": round(rnd.gauss(8500, 2500)), "resp_awake": 15.1, "sleep": night})
    for year, mins in ((today.year - 2, 128), (today.year - 1, 121)):
        race = date(year, 11, 1) + timedelta(days=(5 - date(year, 11, 1).weekday()) % 7)
        if race < today:
            start = datetime.combine(race, datetime.min.time()) + timedelta(hours=11)
            store.put_activity(activity(id=f"garmin:iceman{year}", source="garmin", start=start, kind="mountain_biking",
                                        name=f"Bell's Iceman Cometh Challenge {year}", duration_s=mins * 60 + 90, moving_s=mins * 60,
                                        distance_m=48900, elev_m=575, avg_hr=163, max_hr=181))
    for year, mins in ((today.year - 1, 232), (today.year, 219)):
        race = date(year, 4, 1) + timedelta(days=(5 - date(year, 4, 1).weekday()) % 7 + 14)   # 3rd Saturday of April
        if race < today:
            start = datetime.combine(race, datetime.min.time()) + timedelta(hours=9)
            store.put_activity(activity(id=f"garmin:barry{year}", source="garmin", start=start, kind="gravel_cycling",
                                        name=f"Barry-Roubaix Killer {year}", duration_s=mins * 60 + 120, moving_s=mins * 60,
                                        distance_m=99800, elev_m=1220, avg_hr=158, max_hr=179))
    store.commit()
