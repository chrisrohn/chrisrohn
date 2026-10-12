"""Your power-duration curve: the best average power you've held for each duration, now against the year, and the
critical-power model fitted to it.

- **Mean-maximal power** for 1 to 120 minutes, from each ride's minute-by-minute power (streams.py). A ride with no
  trace but an average power (a Zwift ride from Strava) still counts: its average is a floor on every duration up
  to its length. Minute resolution makes the 1-2 minute bests a little conservative; from 3 minutes on it's exact
  enough.
- **Critical power** (Monod & Scherrer 1965; Jones et al. 2010): total work over time is close to a straight line
  for efforts of about 3 to 20 minutes, W = CP·t + W′. CP is the highest power you can sustain from your aerobic
  engine (close to, and a little above, FTP); W′ is the fixed reserve of work above it that a surge or a sprint
  spends. Fitted to the best 3-20 minute efforts of the last 90 days, when there are enough of them to be honest.
- **eFTP** is 95% of the best 20 minutes (Allen & Coggan), set beside the FTP the load math uses, so an out-of-date
  number in config.toml shows up.
"""
from __future__ import annotations

from datetime import date, timedelta

DURATIONS = (1, 2, 3, 5, 8, 10, 12, 15, 20, 30, 45, 60, 90, 120)   # minutes
CP_FIT = (3, 5, 8, 10, 12, 15, 20)
RECENT_DAYS, CP_DAYS, YEAR_DAYS = 42, 90, 365
MIN_COVER = 0.6            # a trace needs power on 60% of its minutes; the rest of its minutes count as coasting


def mean_max(p: list[float | None]) -> dict[int, float]:
    """Best average power for each duration in DURATIONS that fits in the ride (minute values; gaps are zero)."""
    xs = [v or 0.0 for v in p]
    pre = [0.0]
    for v in xs:
        pre.append(pre[-1] + v)
    out = {}
    for d in DURATIONS:
        if d > len(xs):
            break
        best = max(pre[i + d] - pre[i] for i in range(len(xs) - d + 1)) / d
        if best > 0:
            out[d] = round(best)
    return out


def bests(acts: list[dict], traces: dict[str, dict], start: str, end: str) -> dict[int, dict]:
    """Each duration's best effort between two dates: watts, the day and the ride."""
    out: dict[int, dict] = {}
    for a in acts:
        day = a["start"][:10]
        if a.get("group") != "ride" or not start <= day <= end:
            continue
        s = traces.get(a["id"]) or {}
        p = s.get("p")
        if p and sum(1 for v in p if v) >= MIN_COVER * len(p):
            mm = mean_max(p)
        elif a.get("avg_power") and a.get("moving_s"):
            mins = int(a["moving_s"] // 60)
            mm = {d: round(a["avg_power"]) for d in DURATIONS if d <= mins}
        else:
            continue
        for d, w in mm.items():
            if w > out.get(d, {}).get("w", 0):
                out[d] = {"w": w, "date": day, "name": a.get("name") or ""}
    return out


def critical_power(best: dict[int, dict]) -> dict | None:
    """Least squares of work (kJ) on time (s) over the 3-20 minute bests: the slope is CP, the intercept W′."""
    pts = [(d * 60, best[d]["w"] * d * 60 / 1000) for d in CP_FIT if d in best]
    if len(pts) < 3 or max(t for t, _ in pts) < 12 * 60 or min(t for t, _ in pts) > 5 * 60:
        return None
    n = len(pts)
    mt, mw = sum(t for t, _ in pts) / n, sum(w for _, w in pts) / n
    sxx = sum((t - mt) ** 2 for t, _ in pts)
    slope = sum((t - mt) * (w - mw) for t, w in pts) / sxx
    w_prime = mw - slope * mt
    ss_tot = sum((w - mw) ** 2 for _, w in pts)
    r2 = 1 - sum((w - (slope * t + w_prime)) ** 2 for t, w in pts) / ss_tot if ss_tot else 1.0
    cp = slope * 1000
    if cp <= 0 or not 1 <= w_prime <= 60:            # no physiology fits that: maximal efforts are missing
        return None
    return {"cp": round(cp), "w_prime_kj": round(w_prime, 1), "r2": round(r2, 3), "points": len(pts)}


def profile(acts: list[dict], traces: dict[str, dict], today: date, weight_kg: float | None, ftp: int | None) -> dict | None:
    """The curve now (last 6 weeks) against the year's, critical power, eFTP and what they say."""
    t = today.isoformat()

    def iso(n: int) -> str:
        return (today - timedelta(days=n)).isoformat()
    year, recent = bests(acts, traces, iso(YEAR_DAYS), t), bests(acts, traces, iso(RECENT_DAYS), t)
    if not year:
        return None
    quarter = bests(acts, traces, iso(CP_DAYS), t)
    cp = critical_power(quarter)
    b20 = (quarter.get(20) or {}).get("w")
    eftp = round(0.95 * b20) if b20 else None
    notes = []
    if eftp and ftp and abs(eftp - ftp) / ftp > 0.05:
        notes.append(f"Your best 20 minutes of the last 90 days puts FTP near {eftp} W, against {ftp} W in use. "
                     + ("Set the higher number in config.toml so the load math keeps up with you." if eftp > ftp else
                        "A ramp test settles it; until then the load math may be scoring rides as easier than they were."))
    elif eftp and not ftp:
        notes.append(f"No FTP is set, so rides are scored from heart rate. Your curve says about {eftp} W: put it in config.toml "
                     "(athlete.ftp) and rides with power are scored from power.")
    gaps = [d for d in (5, 20) if d in year and (recent.get(d) or {}).get("w", 0) < 0.92 * year[d]["w"]]
    if gaps:
        notes.append("The last 6 weeks are more than 8% under the year's best at " + " and ".join(f"{d} min" for d in gaps)
                     + ": a hard session at those durations, rested, would show whether that's fitness or just no recent all-out effort.")
    if cp:
        notes.append(f"Critical power {cp['cp']} W with a W′ of {cp['w_prime_kj']} kJ: above {cp['cp']} W every surge spends the reserve, "
                     f"and a {round(cp['w_prime_kj'] * 1000 / max(1, round(cp['cp'] * 0.2)) / 60, 1)} min effort at 120% of CP empties it.")

    def wkg(w: float | None) -> float | None:
        return round(w / weight_kg, 2) if w and weight_kg else None
    return {
        "durations": list(DURATIONS),
        "recent": [(recent.get(d) or {}).get("w") for d in DURATIONS],
        "year": [(year.get(d) or {}).get("w") for d in DURATIONS],
        "year_when": [(year.get(d) or {}).get("date") for d in DURATIONS],
        "cp": cp, "eftp": eftp, "ftp": ftp or None, "wkg_20": wkg(b20), "wkg_cp": wkg(cp["cp"] if cp else None),
        "notes": notes,
    }
