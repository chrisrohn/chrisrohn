"""What happened inside a ride, from Garmin's second-by-second record: kept as one value a minute (heart rate,
speed, power), which is all these need and keeps the encrypted state small.

- **Aerobic decoupling** on long steady rides: output per heartbeat (power if there is any, else speed) in the
  second half against the first. Under 5% means the aerobic engine holds for that duration; above it, the second
  half costs more heartbeats for the same work, which is what long Z2 rides fix (Friel, The Cyclist's Training
  Bible; TrainingPeaks' Pa:HR / Pw:HR). Speed is noisy outdoors (wind, hills), so only the trend of several rides
  says much; trainer rides with power are the cleanest reading.
- **Time at target**: the minutes a session's hard steps asked for, against the minutes your heart rate actually
  spent there. Heart rate lags short efforts, so a rep under 4 minutes is expected to show only half its length.
"""
from __future__ import annotations

import statistics

MIN_DECOUPLE_MIN = 60       # shorter rides don't drift enough to measure
WARMUP_MIN = 10             # left out: HR is still settling


def compact(details: dict) -> dict | None:
    """Garmin's activity details (metricDescriptors + activityDetailMetrics) → one value a minute."""
    idx = {d["key"]: d["metricsIndex"] for d in details.get("metricDescriptors") or []}
    rows = [r.get("metrics") or [] for r in details.get("activityDetailMetrics") or []]
    if not rows or "directHeartRate" not in idx:
        return None

    def col(key: str, row: list):
        i = idx.get(key)
        return row[i] if i is not None and i < len(row) else None

    t0 = None
    buckets: dict[int, dict[str, list[float]]] = {}
    for n, r in enumerate(rows):
        if (dur := col("sumDuration", r)) is not None:
            t = dur
        elif (ts := col("directTimestamp", r)) is not None:
            t0 = ts if t0 is None else t0
            t = (ts - t0) / 1000
        else:
            t = n
        b = buckets.setdefault(int(t // 60), {"hr": [], "v": [], "p": []})
        for key, name in (("directHeartRate", "hr"), ("directSpeed", "v"), ("directPower", "p")):
            if (v := col(key, r)) is not None and v > 0:
                b[name].append(v)
    if not buckets:
        return None
    n = max(buckets) + 1
    out = {k: [round(statistics.mean(buckets[m][k]), 1) if m in buckets and buckets[m][k] else None for m in range(n)] for k in ("hr", "v", "p")}
    if not any(out["p"]):
        out["p"] = None
    return out


def decoupling(s: dict, indoor: bool = False) -> dict | None:
    """Output per heartbeat, second half against first, over the moving minutes after the warm-up."""
    use_power = bool(s.get("p")) and sum(1 for x in s["p"] if x) > 0.8 * len(s["p"])
    out_series = s["p"] if use_power else s["v"]
    if out_series is None:
        return None
    pts = [(o, h) for i, (o, h) in enumerate(zip(out_series, s["hr"], strict=False))
           if i >= WARMUP_MIN and o and h and (use_power or o > 2.0)]     # moving (over 7 km/h) with a heartbeat
    if len(pts) < MIN_DECOUPLE_MIN - WARMUP_MIN:
        return None
    half = len(pts) // 2
    ef = [sum(o for o, _ in part) / sum(h for _, h in part) for part in (pts[:half], pts[half:])]
    outs = [o for o, _ in pts]
    cv = statistics.pstdev(outs) / statistics.mean(outs)
    if cv > (0.35 if use_power else 0.30):           # an interval session or stop-start riding: not a steady effort
        return None
    pct = round((ef[0] - ef[1]) / ef[0] * 100, 1)
    return {"pct": pct, "minutes": len(pts) + WARMUP_MIN, "by": "power" if use_power else "speed", "indoor": indoor}


def minutes_at(s: dict, lo_bpm: float) -> int:
    """Minutes with heart rate at or above `lo_bpm`."""
    return sum(1 for h in s.get("hr") or [] if h and h >= lo_bpm)


def verdict(pct: float) -> str:
    if pct < 5:
        return "holding: the aerobic engine lasts this long"
    if pct < 10:
        return "fading in the second half: more long Z2 riding fixes it"
    return "a big fade: heat, under-fueling or fatigue, or the duration is past your aerobic base"


def best_mean(series: list | None, minutes: int) -> float | None:
    """The highest average over `minutes` consecutive minutes with a value in every one (no gaps, no stops)."""
    if not series or len(series) < minutes:
        return None
    best, run, total = None, 0, 0.0
    window: list[float] = []
    for v in series:
        if not v:
            window, total, run = [], 0.0, 0
            continue
        window.append(v)
        total += v
        run += 1
        if len(window) > minutes:
            total -= window.pop(0)
        if len(window) == minutes:
            best = total / minutes if best is None or total / minutes > best else best
    return best


def lthr_from(acts: list[dict], traces: dict[str, dict], today, max_hr: float, days: int = 365) -> dict | None:
    """Your lactate-threshold heart rate, learned from what you've ridden instead of guessed from max HR.

    Friel's field markers: a hard 20 minutes averages about 105% of LTHR, and an hour flat out (a race) about 100%.
    Each ride of the last year with a heart-rate trace gives its best gap-free 20 and 60 minutes; the estimate is the
    highest of best-20 × 0.95 and best-60 across them, the second-highest when there are 5+ hard rides (one strap glitch
    can't set your zones), bounded to 80–95% of max HR. It needs 3 rides with a genuinely hard 20 minutes (85%+ of
    max HR); until then the 89%-of-max default stands."""
    from datetime import timedelta
    since = (today - timedelta(days=days)).isoformat()
    cands = []
    for a in acts:
        s = traces.get(a.get("id"))
        if a.get("group") != "ride" or a["start"][:10] < since or not s or s.get("none"):
            continue
        b20, b60 = best_mean(s.get("hr"), 20), best_mean(s.get("hr"), 60)
        if b20 and b20 >= 0.85 * max_hr:
            v = max(b20 * 0.95, b60 or 0)
            cands.append({"lthr": v, "date": a["start"][:10], "name": a.get("name") or "a ride", "by": "60 min" if b60 and b60 >= b20 * 0.95 else "20 min"})
    if len(cands) < 3:
        return None
    cands.sort(key=lambda c: c["lthr"], reverse=True)
    pick = cands[1] if len(cands) >= 5 else cands[0]
    lthr = round(min(0.95 * max_hr, max(0.80 * max_hr, pick["lthr"])))
    return {"lthr": lthr, "from": pick["name"], "date": pick["date"], "by": pick["by"], "rides": len(cands)}
