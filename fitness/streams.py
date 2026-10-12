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
