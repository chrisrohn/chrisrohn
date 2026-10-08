"""Turns the store into the site: one self-contained dist/index.html with the numbers inlined (no server, no CDN)."""
from __future__ import annotations

import json
import statistics
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

from fitness import metrics as m
from fitness.activities import merge
from fitness.config import DIST_DIR, SITE_DIR, nth_weekday
from fitness.plan import in_indoor, season

CHART_DAYS, SLEEP_DAYS, WEEKS = 180, 90, 16


def _iso(d: date) -> str:
    return d.isoformat()


def assemble(cfg: dict, days: dict[str, dict], raw_acts: list[dict], today: date) -> dict:
    days = {k: v for k, v in days.items() if not v.get("empty") and k <= _iso(today)}
    acts = [a for a in merge(raw_acts) if a["start"][:10] <= _iso(today)]
    th = m.thresholds(cfg, acts, days, today)
    for a in acts:
        a["load"], a["load_src"] = m.session_load(a, th)
        a["end"] = (datetime.fromisoformat(a["start"]) + timedelta(seconds=a["duration_s"])).isoformat()

    first = min([date.fromisoformat(a["start"][:10]) for a in acts] + [date.fromisoformat(k) for k in days] + [today - timedelta(days=CHART_DAYS)])
    load = m.daily_load(acts, first, today)
    rows = m.pmc(load)
    by_day = {r["date"]: r for r in rows}
    need = cfg["athlete"]["sleep_need_hours"]

    sleep = {k: s for k, d in days.items() if (s := m.sleep_score(d.get("sleep"), need))}
    ready = {}
    for k in sorted(days):
        prev = by_day.get(_iso(date.fromisoformat(k) - timedelta(days=1)))
        form = {"tsb": by_day[k]["tsb"], "acwr": prev["acwr"] if prev else None} if k in by_day else None
        if r := m.readiness(k, days, sleep.get(k), form):
            ready[k] = r

    t, y = _iso(today), _iso(today - timedelta(days=1))
    state = by_day.get(y, {"ctl": 0, "atl": 0})
    plan = season(today, state["ctl"], state["atl"], cfg, done_today=load.get(t, 0))
    # every other distance option of every race, so the page can compare "100k or 50k?" side by side
    variants = {}
    if plan:
        for r in plan["races"]:
            for o in r["options"]:
                if o["key"] != r["option"]:
                    variants[f"{r['name']}|{o['key']}"] = season(today, state["ctl"], state["atl"], cfg, load.get(t, 0), {r["name"]: o["key"]})
    plan_today = plan["days"][0] if plan else None
    ready_today = ready.get(t)
    rec = m.recommend(ready_today, plan_today)

    # sleep debt and regularity over the last week / fortnight
    recent_nights = [days[_iso(today - timedelta(days=i))].get("sleep") for i in range(14) if _iso(today - timedelta(days=i)) in days]
    recent_nights = [n for n in recent_nights if n and n.get("total")]
    debt = sum(need - n["total"] / 3600 for n in recent_nights[:7]) if recent_nights else None
    mids = [x for x in (m.midpoint_minutes(n) for n in recent_nights) if x is not None]
    regularity = statistics.pstdev(mids) if len(mids) >= 5 else None

    now_row = by_day.get(t, {})
    week_ago = by_day.get(_iso(today - timedelta(days=7)), {})
    form_now = {"ctl": now_row.get("ctl"), "atl": now_row.get("atl"), "tsb": now_row.get("tsb"), "acwr": by_day.get(y, {}).get("acwr"),
                "monotony": by_day.get(y, {}).get("monotony"), "ramp": round(now_row.get("ctl", 0) - week_ago.get("ctl", 0), 1) if week_ago else None}

    chart_from = _iso(today - timedelta(days=CHART_DAYS - 1))
    sleep_from = _iso(today - timedelta(days=SLEEP_DAYS - 1))

    markers = {}
    for key in m.MARKERS:
        series = []
        for d in m.daterange(today - timedelta(days=SLEEP_DAYS - 1), today):
            k = _iso(d)
            prior = [v for v in (m.markers_for(days[x]).get(key) for x in (_iso(d - timedelta(days=i)) for i in range(1, 61)) if x in days) if v is not None]
            base = m.baseline(prior, m.MARKERS[key][2])
            v = m.markers_for(days[k]).get(key) if k in days else None
            series.append({"date": k, "v": v, "mean": round(base[0], 2) if base else None, "sd": round(base[1], 2) if base else None})
        markers[key] = {"label": m.MARKERS[key][3], "unit": m.MARKERS[key][4], "better": "higher" if m.MARKERS[key][0] > 0 else "lower", "series": series}

    sleep_rows = []
    for d in m.daterange(today - timedelta(days=SLEEP_DAYS - 1), today):
        k = _iso(d)
        n = (days.get(k) or {}).get("sleep")
        s = sleep.get(k)
        sleep_rows.append({"date": k, "score": s["score"] if s else None, "label": s["label"] if s else None, "parts": s["parts"] if s else None,
                           "hours": s["hours"] if s else None, "garmin_score": n.get("garmin_score") if n else None,
                           **{st: round((n.get(st) or 0) / 3600, 2) if n else None for st in ("deep", "light", "rem", "awake")},
                           "start": n.get("start") if n else None, "end": n.get("end") if n else None})

    weeks = _weeks(acts, today)
    pairs = _pairs(days, acts, load, sleep, ready)

    editions = {}
    for race in cfg["races"]:
        match = [w.lower() for w in race.get("match", [])]
        rows_e = []
        for a in acts:
            day = date.fromisoformat(a["start"][:10])
            near = not race["every"] or abs((day - nth_weekday(race["every"], day.year)).days) <= 7   # skips recon rides and watch parties
            if match and any(w in a["name"].lower() for w in match) and near and a["group"] == "ride" and not a.get("indoor"):
                r = by_day.get(a["start"][:10], {})
                rows_e.append({"date": a["start"][:10], "name": a["name"], "moving_s": a["moving_s"], "distance_m": a["distance_m"],
                               "elev_m": a["elev_m"], "avg_hr": a["avg_hr"], "np": a.get("np"), "ctl": r.get("ctl"), "tsb": r.get("tsb"),
                               "speed_kph": round(a["distance_m"] / a["moving_s"] * 3.6, 1) if a["moving_s"] else None})
        editions[race["name"]] = rows_e

    zones = [0.0] * 5
    for a in acts:
        if a.get("hr_zones") and a["start"][:10] >= _iso(today - timedelta(days=27)):
            zones = [z + (v or 0) for z, v in zip(zones, a["hr_zones"], strict=True)]

    ytd = [a for a in acts if a["start"][:4] == str(today.year) and a["group"] == "ride"]
    indoor = _indoor_season(acts, cfg, today)
    coverage = _coverage(days, today)

    return {
        "generated": datetime.now().isoformat(timespec="minutes"), "today": t, "athlete": th, "need_hours": need,
        "now": {"readiness": ready_today, "recommendation": rec, "base_call": m.recommend(ready_today, None), "sleep": sleep.get(t), "form": form_now,
                "sleep_debt": round(debt, 1) if debt is not None else None, "regularity_min": round(regularity) if regularity is not None else None,
                "last_night": (days.get(t) or {}).get("sleep")},
        "pmc": [r for r in rows if r["date"] >= chart_from],
        "plan": plan,
        "variants": variants,
        "indoor": indoor,
        "sleep": sleep_rows,
        "markers": markers,
        "readiness": [{"date": k, "score": v["score"]} for k, v in sorted(ready.items()) if k >= sleep_from],
        "weeks": weeks,
        "zones": {"seconds": zones, "days": 28} if any(zones) else None,
        "insights": m.insights(pairs),
        "editions": editions,
        "recent": [{k: a.get(k) for k in ("start", "name", "kind", "group", "offroad", "moving_s", "distance_m", "elev_m", "avg_hr", "np", "load", "load_src")}
                   for a in reversed(acts[-25:])],
        "ytd": {"rides": len(ytd), "hours": round(sum(a["moving_s"] for a in ytd) / 3600, 1), "km": round(sum(a["distance_m"] for a in ytd) / 1000),
                "elev_m": round(sum(a["elev_m"] for a in ytd))},
        "coverage": coverage,
        "counts": {"days": len(days), "activities": len(acts), "first": _iso(first)},
    }


def _weeks(acts: list[dict], today: date) -> list[dict]:
    monday = today - timedelta(days=today.weekday())
    starts = [monday - timedelta(weeks=i) for i in range(WEEKS - 1, -1, -1)]
    out = {_iso(s): {"week": _iso(s), "ride": 0.0, "indoor": 0.0, "run": 0.0, "other": 0.0, "km": 0.0, "elev_m": 0.0, "load": 0.0} for s in starts}
    for a in acts:
        d = date.fromisoformat(a["start"][:10])
        k = _iso(d - timedelta(days=d.weekday()))
        if k not in out:
            continue
        w = out[k]
        bucket = ("indoor" if a.get("indoor") else "ride") if a["group"] == "ride" else a["group"] if a["group"] == "run" else "other"
        w[bucket] += a["moving_s"] / 3600
        w["km"] += a["distance_m"] / 1000
        w["elev_m"] += a["elev_m"]
        w["load"] += a["load"]
    return [{k: round(v, 2) if isinstance(v, float) else v for k, v in w.items()} for w in out.values()]


def _indoor_season(acts: list[dict], cfg: dict, today: date) -> dict | None:
    """The trainer season under way, or the last one: rides, hours, load and power, and how the FTP moved."""
    if not cfg["indoor"].get("start"):
        return None
    d = today
    while not in_indoor(d, cfg) and (today - d).days < 370:
        d -= timedelta(days=1)
    if not in_indoor(d, cfg):
        return None
    start = d
    while in_indoor(start - timedelta(days=1), cfg):
        start -= timedelta(days=1)
    end = d
    while in_indoor(end + timedelta(days=1), cfg):
        end += timedelta(days=1)
    rides = [a for a in acts if a["group"] == "ride" and a.get("indoor") and _iso(start) <= a["start"][:10] <= _iso(end)]
    outdoor = [a for a in acts if a["group"] == "ride" and not a.get("indoor") and _iso(start) <= a["start"][:10] <= _iso(end)]
    nps = [a["np"] for a in rides if a.get("np")]
    return {"start": _iso(start), "end": _iso(end), "current": in_indoor(today, cfg), "rides": len(rides), "outdoor_rides": len(outdoor),
            "hours": round(sum(a["moving_s"] for a in rides) / 3600, 1), "load": round(sum(a["load"] for a in rides)),
            "avg_np": round(sum(nps) / len(nps)) if nps else None, "with_power": len(nps),
            "ftp_start": m.estimate_ftp([a for a in rides if a["start"][:10] < _iso(start + timedelta(days=30))], start + timedelta(days=30), 30) or None,
            "ftp_end": m.estimate_ftp(rides, min(end, today), 30) or None}


def _pairs(days, acts, load, sleep, ready) -> dict[str, list[tuple[float, float]]]:
    late = defaultdict(bool)
    trained = set()
    for a in acts:
        k = a["start"][:10]
        trained.add(k)
        late[k] |= a["end"][11:13] >= "19"
    pairs: dict[str, list] = defaultdict(list)
    for k in sorted(days):
        nxt = _iso(date.fromisoformat(k) + timedelta(days=1))
        s_next = sleep.get(nxt)
        if s_next:
            pairs["load→sleep"].append((load.get(k, 0), s_next["score"]))
            if k in trained:
                pairs["late→sleep"].append((1 if late[k] else 0, s_next["score"]))
            if days[k].get("steps"):
                pairs["steps→sleep"].append((days[k]["steps"], s_next["score"]))
            if days[k].get("stress") is not None:
                pairs["stress→sleep"].append((days[k]["stress"], s_next["score"]))
        if nxt in ready:
            pairs["load→ready"].append((load.get(k, 0), ready[nxt]["score"]))
        n = days[k].get("sleep")
        if n and k in sleep and n.get("start"):
            start = datetime.fromisoformat(n["start"])
            pairs["bedtime→sleep"].append(((start.hour * 60 + start.minute - 720) % 1440, sleep[k]["score"]))
    return pairs


def _coverage(days: dict[str, dict], today: date) -> list[dict]:
    """What the watch actually delivered over the last 30 days: answers "is it the hardware or a paywall?"."""
    window = [days[k] for k in (_iso(today - timedelta(days=i)) for i in range(30)) if k in days]
    nights = [d.get("sleep") or {} for d in window]
    total = max(1, len(window))
    checks = [
        ("Sleep duration", sum(1 for n in nights if n.get("total")), "Yes", "Recorded by the Venu Sq"),
        ("Deep / light sleep", sum(1 for n in nights if n.get("deep")), "Yes", "Stage estimates from HR + motion"),
        ("REM sleep", sum(1 for n in nights if n.get("rem")), "Yes", "Stage estimates from HR + motion"),
        ("Overnight stress", sum(1 for n in nights if n.get("avg_stress") is not None), "Yes", "HRV-derived; the site's HRV stand-in"),
        ("Sleeping respiration", sum(1 for n in nights if n.get("resp")), "Yes", "From the optical HR signal"),
        ("Overnight Pulse Ox", sum(1 for n in nights if n.get("spo2")), "Optional", "Turn on Pulse Ox → During Sleep (costs battery)"),
        ("Resting HR", sum(1 for d in window if d.get("rhr")), "Yes", ""),
        ("Body Battery", sum(1 for d in window if d.get("bb_high") is not None), "Yes", ""),
        ("Overnight HRV (ms)", sum(1 for n in nights if n.get("hrv")), "No", "Needs Elevate v4+ HRV Status hardware (Venu 2 and later)"),
        ("Garmin Sleep Score", sum(1 for n in nights if n.get("garmin_score")), "No", "Firmware-gated; this site scores sleep itself"),
    ]
    return [{"field": f, "days": n, "of": total, "device": dev, "note": note} for f, n, dev, note in checks]


def render(data: dict, out: Path | None = None) -> Path:
    out = out or DIST_DIR / "index.html"
    html = (SITE_DIR / "index.html").read_text()
    payload = json.dumps(data, separators=(",", ":")).replace("</", "<\\/")
    html = (html.replace("/*__STYLE__*/", (SITE_DIR / "style.css").read_text())
                .replace("/*__APP__*/", (SITE_DIR / "app.js").read_text())
                .replace("__DATA__", payload))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html)
    return out
