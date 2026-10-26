"""A race's course from the organizer's GPX (`course = "courses/…gpx"` in the race's config block): its length, the
climbing, the hills and where along it they sit, the profile for the race card, the way it faces for the wind, and a
light copy of the line that ride mode loads as a route on the phone.

Two counts of climbing, because they answer different questions. `gain_m` is what a GPS or barometric recorder
reports (every rise of a metre or more on a 20 m profile: Strava's and Garmin's number, so it compares with your past
editions). `ride_gain_m` and `climbs` are worked out exactly as ride mode does (site/ride-core.js: a 20 m profile
smoothed over ±40 m, 3 m of hysteresis, ClimbPro-style climbs), so the race card and the phone on the bars agree.
`kicks` are the short rises in between (5 m+ up, ended by a 3 m dip): on a rolling course like Iceman they, not the
climbs, are where the race is ridden.
"""
from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET
from functools import lru_cache
from pathlib import Path

PKG = Path(__file__).resolve().parent   # fitness/: course paths are relative to it (config.PKG, kept here so config can load courses)
STEP = 20.0                # m between profile samples (ride-core.js STEP)
R = 6371000.0
MI = 1609.344
BINS = 36                  # the course's facing, in 10° bins, weighted by distance
SHARE_TOL_M = 1.5          # the phone's copy keeps the line within 1.5 m of the organizer's (and its length within 0.3%)


def _hav(a: tuple[float, float], b: tuple[float, float]) -> float:
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    return 2 * R * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))


def _bearing(a: tuple[float, float], b: tuple[float, float]) -> float:
    la1, la2, dl = math.radians(a[0]), math.radians(b[0]), math.radians(b[1] - a[1])
    y = math.sin(dl) * math.cos(la2)
    x = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def parse(text: str) -> tuple[str, list[tuple[float, float, float | None]]]:
    """A GPX's name and its track points (or route points when there's no track) as (lat, lon, ele)."""
    root = ET.fromstring(re.sub(r"^﻿", "", text).strip())
    local = lambda e: e.tag.rsplit("}", 1)[-1]   # noqa: E731
    if local(root) != "gpx":
        raise ValueError("a course needs to be a GPX file")
    def pts(name: str) -> list[tuple[float, float, float | None]]:
        out = []
        for e in root.iter():
            if local(e) != name:
                continue
            try:
                lat, lon = float(e.get("lat")), float(e.get("lon"))
            except (TypeError, ValueError):
                continue
            ele = next((c.text for c in e if local(c) == "ele"), None)
            try:
                ele = float(ele) if ele is not None else None
            except ValueError:
                ele = None
            if abs(lat) <= 90 and abs(lon) <= 180:
                out.append((lat, lon, ele))
        return out
    points = pts("trkpt")
    if len(points) < 2:
        points = pts("rtept")
    if len(points) < 2:
        raise ValueError("the course GPX has no track in it")
    name = ""
    for parent in ("trk", "rte", "metadata"):
        el = next((e for e in root.iter() if local(e) == parent), None)
        nm = next((c.text for c in el if local(c) == "name"), None) if el is not None else None
        if nm and nm.strip():
            name = nm.strip()
            break
    return name, points


def _profile(pts: list[tuple[float, float, float]], cum: list[float]) -> list[float]:
    """Heights every 20 m along the line (ride-core.js profile, before its smoothing)."""
    total = cum[-1]
    m = max(2, math.ceil(total / STEP) + 1)
    raw, j = [], 0
    for k in range(m):
        d = min(total, k * STEP)
        while j < len(pts) - 2 and cum[j + 1] < d:
            j += 1
        f = min(1.0, max(0.0, (d - cum[j]) / max(1e-6, cum[j + 1] - cum[j])))
        raw.append(pts[j][2] + (pts[j + 1][2] - pts[j][2]) * f)
    return raw


def _smooth(ele: list[float], w: int) -> list[float]:
    return [sum(ele[max(0, k - w):k + w + 1]) / len(ele[max(0, k - w):k + w + 1]) for k in range(len(ele))]


def _gain(ele: list[float], h: float = 3.0) -> tuple[float, float]:
    """Gain and loss, counting a change once it reaches `h` metres."""
    gain = loss = 0.0
    ref = ele[0]
    for e in ele[1:]:
        if e - ref >= h:
            gain, ref = gain + e - ref, e
        elif e - ref <= -h:
            loss, ref = loss + ref - e, e
    return gain, loss


def kicks(ele: list[float], min_up: float = 5.0, dip: float = 3.0) -> list[dict]:
    """Every short rise: from a low point to its top, ended by a dip of `dip` m, kept when it gains `min_up` m."""
    out, lo, hi = [], 0, 0

    def close(lo: int, hi: int) -> None:
        while hi - lo > 1 and ele[lo + 1] - ele[lo] < 0.01 * STEP:   # the flat run-in and the flat top aren't the hill
            lo += 1
        while hi - lo > 1 and ele[hi] - ele[hi - 1] < 0.01 * STEP:
            hi -= 1
        up, length = ele[hi] - ele[lo], (hi - lo) * STEP
        if up >= min_up and length > 0:
            steep = max([(ele[k + 3] - ele[k]) / (3 * STEP) for k in range(lo, hi - 2)] or [up / length])
            out.append({"start_m": round(lo * STEP), "len_m": round(length), "gain_m": round(up, 1), "grade": round(up / length * 100, 1),
                        "max_grade": round(max(steep, up / length) * 100, 1)})

    for k in range(1, len(ele)):
        if ele[k] > ele[hi]:
            hi = k
        if hi == lo:
            if ele[k] < ele[lo]:
                lo = hi = k
            continue
        if ele[k] < ele[lo] or ele[hi] - ele[k] > dip:
            close(lo, hi)
            lo = hi = k
    if hi > lo:
        close(lo, hi)
    return out


def climbs(ele: list[float], total: float) -> list[dict]:
    """ClimbPro's climbs (ride-core.js findClimbs): low point to top, ended by a dip of 10 m or a fifth of the gain,
    300 m+ long, 15 m+ up and 3%+ on average once the gentle run-in and flat top are trimmed."""
    out, m = [], len(ele)
    lo = hi = 0

    def close(lo: int, hi: int) -> None:
        while hi - lo > 2 and (ele[lo + 2] - ele[lo]) / (2 * STEP) < 0.02:
            lo += 1
        while hi - lo > 2 and (ele[hi] - ele[hi - 2]) / (2 * STEP) < 0.02:
            hi -= 1
        length, up = (hi - lo) * STEP, ele[hi] - ele[lo]
        if length >= 300 and up >= 15 and up / length >= 0.03:
            steep = max([(ele[k + 5] - ele[k]) / (5 * STEP) for k in range(lo, hi - 4)] or [0])
            out.append({"start_m": round(lo * STEP), "end_m": round(min(total, hi * STEP)), "len_m": round(length), "gain_m": round(up, 1),
                        "grade": round(up / length * 100, 1), "max_grade": round(max(steep, up / length) * 100, 1), "top_m": round(ele[hi], 1)})

    for k in range(1, m):
        if ele[k] > ele[hi]:
            hi = k
        if hi == lo:
            if ele[k] < ele[lo]:
                lo = hi = k
            continue
        drop, gained = ele[hi] - ele[k], ele[hi] - ele[lo]
        if ele[k] < ele[lo] or drop > max(10, gained * 0.2):
            close(lo, hi)
            lo = hi = k
    if hi > lo:
        close(lo, hi)
    return out


def _simplify(pts: list[tuple[float, float, float]], tol: float, z: float = 3.0) -> list[int]:
    """Douglas–Peucker in 3-D on a local flat frame: the indices of the points that keep the line within `tol` m across
    and `tol / z` m in height, so the thinned copy keeps its climbs as well as its corners."""
    lat0 = math.radians(pts[len(pts) // 2][0])
    kx, ky = R * math.radians(1) * math.cos(lat0), R * math.radians(1)
    xyz = [(p[1] * kx, p[0] * ky, (p[2] or 0.0) * z) for p in pts]
    keep, stack = {0, len(pts) - 1}, [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay, az), (bx, by, bz) = xyz[a], xyz[b]
        dx, dy, dz = bx - ax, by - ay, bz - az
        L2 = dx * dx + dy * dy + dz * dz or 1e-9
        far, at = 0.0, -1
        for i in range(a + 1, b):
            px, py, pz = xyz[i]
            t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / L2))
            d = math.dist((px, py, pz), (ax + t * dx, ay + t * dy, az + t * dz))
            if d > far:
                far, at = d, i
        if far > tol and at > 0:
            keep.add(at)
            stack += [(a, at), (at, b)]
    return sorted(keep)


def analyze(name: str, points: list[tuple[float, float, float | None]]) -> dict:
    """Everything the race card, the planner and race day use from the line."""
    pts: list[tuple[float, float, float | None]] = []
    for p in points:
        if not pts or _hav(pts[-1][:2], p[:2]) >= 1:
            pts.append(p)
    if len(pts) < 2:
        raise ValueError("the course is too short")
    cum = [0.0]
    for a, b in zip(pts, pts[1:], strict=False):
        cum.append(cum[-1] + _hav(a[:2], b[:2]))
    total = cum[-1]
    known = [i for i, p in enumerate(pts) if p[2] is not None]
    has_ele = len(known) / len(pts) > 0.5
    if has_ele:   # gaps filled along the line, ends held level
        filled = [p[2] for p in pts]
        for a, b in zip(known, known[1:], strict=False):
            for i in range(a + 1, b):
                filled[i] = filled[a] + (filled[b] - filled[a]) * (cum[i] - cum[a]) / max(1e-6, cum[b] - cum[a])
        for i in range(known[0]):
            filled[i] = filled[known[0]]
        for i in range(known[-1] + 1, len(pts)):
            filled[i] = filled[known[-1]]
        pts = [(p[0], p[1], e) for p, e in zip(pts, filled, strict=True)]
    bins = [0.0] * BINS
    for a, b, d0, d1 in zip(pts, pts[1:], cum, cum[1:], strict=False):
        bins[round(_bearing(a[:2], b[:2]) / (360 / BINS)) % BINS] += d1 - d0
    bins = [round(x / total, 4) for x in bins]
    out = {"name": name or "Course", "km": round(total / 1000, 2), "mi": round(total / MI, 2), "start_ll": [round(pts[0][0], 5), round(pts[0][1], 5)],
           "finish_ll": [round(pts[-1][0], 5), round(pts[-1][1], 5)], "loop": _hav(pts[0][:2], pts[-1][:2]) < 250,
           "heading": round(_bearing(pts[0][:2], pts[-1][:2])), "facing": bins, "has_ele": has_ele,
           "gain_m": 0, "loss_m": 0, "ride_gain_m": 0, "climbs": [], "kicks": None, "hills": [], "profile": [], "thirds": [], "finale": None}
    if has_ele:
        raw = _profile(pts, cum)
        ele = _smooth(raw, 2)
        out["gain_m"], out["loss_m"] = (round(x) for x in _gain(raw, 1.0))
        out["ride_gain_m"] = round(_gain(ele)[0])
        out["climbs"] = climbs(ele, total)
        ks = kicks(_smooth(raw, 1))
        if ks:
            lens, ups = sorted(k["len_m"] for k in ks), sorted(k["gain_m"] for k in ks)
            out["kicks"] = {"n": len(ks), "median_len_m": lens[len(lens) // 2], "median_gain_m": ups[len(ups) // 2],
                            "gain_m": round(sum(ups)), "over_6pct": sum(1 for k in ks if k["max_grade"] >= 6)}
            out["hills"] = [k for k in ks if k["gain_m"] >= 12]   # the ones worth a plan: 40 ft and up
        every = max(1, round(len(ele) / 220))   # ~220 points: enough for a phone-wide chart, small in the data
        out["profile"] = [[round(k * STEP / 1000, 2), round(ele[k], 1)] for k in range(0, len(ele), every)]
        if out["profile"][-1][0] < round(total / 1000, 2):
            out["profile"].append([round(total / 1000, 2), round(ele[-1], 1)])
        n = len(ele)
        for t in range(3):   # where the climbing sits: each third's share
            seg = raw[t * n // 3:(t + 1) * n // 3 + 1]
            g = _gain(seg, 1.0)[0] if len(seg) > 1 else 0
            out["thirds"].append({"from_km": round(t * total / 3000, 1), "to_km": round((t + 1) * total / 3000, 1), "gain_m": round(g),
                                  "hills": sum(1 for c in out["hills"] if t * total / 3 <= c["start_m"] < (t + 1) * total / 3)})
        tail = raw[max(0, n - round(8000 / STEP)):]   # the last 8 km, where a point-to-point race is decided
        out["finale"] = {"km": round(min(8.0, total / 1000), 1), "gain_m": round(_gain(tail, 1.0)[0]) if len(tail) > 1 else 0,
                         "hills": sum(1 for c in out["hills"] if c["start_m"] >= total - 8000),
                         "last": next((c for c in reversed(out["hills"]) if c["start_m"] >= total - 2000), None)}
    keep = _simplify(pts if has_ele else [(p[0], p[1], 0.0) for p in pts], SHARE_TOL_M)
    out["points"] = [[round(pts[i][0], 5), round(pts[i][1], 5), None if pts[i][2] is None else round(pts[i][2], 1)] for i in keep]
    return out


@lru_cache(maxsize=8)
def _load(path: str, mtime: float) -> dict:
    name, points = parse(Path(path).read_text(encoding="utf-8"))
    return analyze(name, points)


def load(spec: str) -> dict | None:
    """The course a race's `course` setting names (relative to fitness/), or None when it isn't set."""
    if not spec:
        return None
    p = Path(spec).expanduser()
    p = p if p.is_absolute() else PKG / p
    if not p.exists():
        raise ValueError(f"course file not found: {spec}")
    return _load(str(p), p.stat().st_mtime)


def along(wind: float, wind_from: float | None, facing: list[float]) -> dict | None:
    """The wind along the whole course, not the straight line: the distance-weighted head (+) or tail (−) part, and the
    share of the course ridden into it."""
    if wind_from is None or not facing:
        return None
    head = into = 0.0
    for i, f in enumerate(facing):
        c = math.cos(math.radians(wind_from - i * 360 / BINS))
        head += f * c
        into += f if c > 0.25 else 0
    return {"head": round(wind * head), "into_pct": round(into * 100)}


def share(c: dict, race: str, year: int) -> dict:
    """The light copy ride mode keeps as a route: a stable id (the same course is never loaded twice), the line and the
    climbs it can check against its own."""
    slug = re.sub(r"[^a-z0-9]+", "-", race.lower()).strip("-")
    return {"id": f"course-{slug}-{year}", "name": c["name"], "points": c["points"], "km": c["km"], "gain_m": c["gain_m"]}
