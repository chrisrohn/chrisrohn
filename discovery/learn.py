"""Learn from outcomes: which sources, blogs, tags and artists actually get kept.

Everything here is quota-free. The signals are the year playlists (every Keep lands there and the profile build reads
them without auth), the Skipped playlist when skips are filed on YouTube, the ratings file the site pushes back into
the repo (data/ratings.json: every keep and skip the curator made, including the free local skips), and the daily
history files under site/data/history/ (what the feed showed on which day, with each item's sources, tags and rank).

A track shown `grace_days` ago or earlier that sits in a year playlist now (or was thumbed up) was kept; one in the
Skipped playlist or thumbed down was skipped; anything that reached the screen that long ago and was never filed
anywhere counts as a weak pass (`pass_weight`), because a track the curator never got round to is not the same as one
they rejected. "Reached the screen" means it ranked within `shown_rank` of that day's build: the site shows a
shortlist, so a source that emits 900 tracks a day is not punished for the 850 nobody ever saw.

Each source, tag and artist then gets a smoothed keep rate against the overall keep rate, expressed as a bounded
log2 ratio that score.py adds to the score. Old outcomes fade with a half-life (`half_life_days`) so last season's
taste does not outweigh this month's. Features with few sightings get an exploration bonus (`explore`, a UCB-style
term that shrinks with every sighting) so an unfamiliar blog or a brand-new artist gets a fair look before the
keep rate has anything to say. With no history yet every adjustment is 0 and ranking is exactly what it was.
"""
from __future__ import annotations

import math
from datetime import date, timedelta
from pathlib import Path

from .util import DATA_DIR, log, norm, read_json

DEFAULTS = {"grace_days": 3, "pass_weight": 0.35, "prior": 8.0, "max_adjust": 1.5, "min_exposures": 3, "keep_days": 90,
            "shown_rank": 80, "half_life_days": 21.0, "explore": 0.4, "explore_max": 0.6}
RATINGS_PATH = DATA_DIR / "ratings.json"


def history_rows(history_dir: Path, *, today: date, grace_days: int, keep_days: int) -> dict[str, dict]:
    """The newest snapshot of every item shown at least `grace_days` ago, keyed by item id."""
    rows: dict[str, dict] = {}
    if not history_dir.exists():
        return rows
    latest = today - timedelta(days=grace_days)
    oldest = today - timedelta(days=keep_days)
    for f in sorted(history_dir.glob("*.json")):
        try:
            day = date.fromisoformat(f.stem)
        except ValueError:
            continue
        if day > latest or day < oldest:
            continue
        data = read_json(f, {})
        for it in data.get("items") or []:
            if not it.get("id"):
                continue
            prev = rows.get(it["id"]) or {}
            # the best rank it ever had is the one that decides whether it was on screen
            ranks = [r for r in (it.get("r"), prev.get("r")) if r is not None]
            rows[it["id"]] = {**it, "shown": day.isoformat(), "r": min(ranks) if ranks else None, "first_shown": prev.get("first_shown") or day.isoformat()}
    return rows


def load_ratings(path: Path | None = None) -> dict[str, dict]:
    """The site's ratings file (data/ratings.json), as {item id: {decision, videoId, ...}}; undo tombstones dropped."""
    data = read_json(path or RATINGS_PATH, None) or {}
    rated = data.get("rated") if isinstance(data, dict) else None
    out: dict[str, dict] = {}
    for k, v in (rated or {}).items():
        if isinstance(v, dict) and v.get("decision") in ("up", "down"):
            out[k] = v
    return out


def merge_ratings(saved: dict, ratings: dict[str, dict]) -> int:
    """Fold the site's ratings into the profile's saved map: a thumbs-down becomes a `down` row (hidden from the feed,
    a skip for the learner), a thumbs-up an `up` row until the playlist scan catches up. Returns how many rows changed."""
    n = 0
    for k, r in ratings.items():
        cur = saved.get(k)
        if isinstance(cur, dict) and cur.get("decision", "up") == r["decision"]:
            continue
        saved[k] = {"artist": r.get("artist"), "title": r.get("title"), "year": r.get("year"), "videoId": r.get("videoId"), "decision": r["decision"], "via": "site"}
        n += 1
    return n


def outcomes(rows: dict[str, dict], saved: dict, *, shown_rank: int | None = None) -> list[dict]:
    """Attach a verdict to every shown item: kept (1), skipped (0), or pass (0, weighted down by the caller). A pass
    needs the item to have been on screen (rank within `shown_rank`); rows without a rank are from before ranks were
    recorded and never count as a pass."""
    kept_keys = {k for k, v in saved.items() if isinstance(v, dict) and v.get("decision", "up") == "up"}
    skipped_keys = {k for k, v in saved.items() if isinstance(v, dict) and v.get("decision") == "down"}
    kept_videos = {v.get("videoId") for k, v in saved.items() if k in kept_keys and isinstance(v, dict) and v.get("videoId")}
    skipped_videos = {v.get("videoId") for k, v in saved.items() if k in skipped_keys and isinstance(v, dict) and v.get("videoId")}
    out = []
    for iid, r in rows.items():
        vid = r.get("v")
        if iid in kept_keys or (vid and vid in kept_videos):
            verdict = "kept"
        elif iid in skipped_keys or (vid and vid in skipped_videos):
            verdict = "skipped"
        else:
            rank = r.get("r")
            if shown_rank is not None and (rank is None or rank > shown_rank):
                continue
            verdict = "pass"
        out.append({**r, "verdict": verdict})
    return out


def _features(o: dict) -> dict[str, list[str]]:
    sources = [s for s in (o.get("s") or []) if s]
    fams = sorted({s.split(":")[0] for s in sources})
    # blogs and radio stations are judged one by one (rss:Stereogum), the catalogue sources as a family (deezer)
    per = [s for s in sources if ":" in s] + [f for f in fams if not any(s.startswith(f + ":") for s in sources)]
    return {"sources": per, "tags": [norm(t) for t in (o.get("t") or []) if t], "artists": [norm(o.get("a"))] if o.get("a") else []}


def learn(outs: list[dict], cfg: dict | None = None, *, today: date | None = None) -> dict:
    """Smoothed keep rates per source / tag / artist → bounded log2 adjustments. Empty input → nothing learned."""
    c = {**DEFAULTS, **((cfg or {}).get("learn") or {})}
    prior = float(c["prior"])
    pass_w = float(c["pass_weight"])
    cap = float(c["max_adjust"])
    min_n = float(c["min_exposures"])
    half_life = float(c.get("half_life_days") or 0)
    today = today or date.today()
    weight = {"kept": 1.0, "skipped": 1.0, "pass": pass_w}

    def decay(o: dict) -> float:
        if half_life <= 0 or not o.get("shown"):
            return 1.0
        try:
            age = (today - date.fromisoformat(o["shown"])).days
        except ValueError:
            return 1.0
        return 0.5 ** (max(0, age) / half_life)

    n_all = sum(weight[o["verdict"]] * decay(o) for o in outs)
    k_all = sum(decay(o) for o in outs if o["verdict"] == "kept")
    if n_all <= 0:
        return {"outcomes": 0, "keep_rate": 0.0, "sources": {}, "tags": {}, "artists": {}}
    base = (k_all + 1.0) / (n_all + 2.0)
    counts: dict[str, dict[str, list[float]]] = {"sources": {}, "tags": {}, "artists": {}}
    for o in outs:
        d = decay(o)
        w = weight[o["verdict"]] * d
        k = d if o["verdict"] == "kept" else 0.0
        for kind, names in _features(o).items():
            for name in names:
                row = counts[kind].setdefault(name, [0.0, 0.0, 0.0, 0.0])   # exposures (weighted), keeps (weighted), raw shown, raw keeps
                row[0] += w
                row[1] += k
                row[2] += 1
                row[3] += 1.0 if o["verdict"] == "kept" else 0.0
    result: dict = {"outcomes": len(outs), "cap": cap, "kept": sum(1 for o in outs if o["verdict"] == "kept"), "skipped": sum(1 for o in outs if o["verdict"] == "skipped"),
                    "keep_rate": round(base, 4), "since": min((o["shown"] for o in outs), default=None), "half_life_days": half_life,
                    "explore": float(c.get("explore") or 0), "explore_max": float(c.get("explore_max") or 0),
                    "sources": {}, "tags": {}, "artists": {}}
    for kind, table in counts.items():
        for name, (n, k, shown, raw_k) in table.items():
            rate = (k + prior * base) / (n + prior)
            adj = max(-cap, min(cap, math.log2(rate / base))) if shown >= min_n else 0.0
            result[kind][name] = {"n": int(shown), "k": int(raw_k), "rate": round(rate, 4), "adj": round(adj, 3)}
    return result


def learn_from_history(profile: dict, cfg: dict, history_dir: Path, *, today: date | None = None) -> dict:
    c = {**DEFAULTS, **(cfg.get("learn") or {})}
    today = today or date.today()
    rows = history_rows(history_dir, today=today, grace_days=int(c["grace_days"]), keep_days=int(c["keep_days"]))
    learned = learn(outcomes(rows, profile.get("saved") or {}, shown_rank=int(c["shown_rank"])), cfg, today=today)
    if learned["outcomes"]:
        log.info("learned from %d shown tracks (%d kept, %d skipped): base keep rate %.1f%%", learned["outcomes"], learned["kept"], learned["skipped"], learned["keep_rate"] * 100)
    return learned


def exploration(learned: dict | None, sources: list[str], tags: list[str], artist: str) -> float:
    """A UCB-style bonus for what the curator has barely been shown: `explore · sqrt(ln N / (n + 1))` per feature,
    averaged within each family and across the families, capped at `explore_max`. Zero until there is history."""
    if not learned or not learned.get("outcomes"):
        return 0.0
    c = float(learned.get("explore") or 0)
    cap = float(learned.get("explore_max") or 0)
    if c <= 0 or cap <= 0:
        return 0.0
    big_n = math.log(float(learned["outcomes"]) + 1.0)
    f = _features({"s": sources, "t": tags, "a": artist})
    parts: list[float] = []
    for kind, names in f.items():
        if not names:
            continue
        table = learned.get(kind) or {}
        vals = [c * math.sqrt(big_n / (float((table.get(n) or {}).get("n", 0)) + 1.0)) for n in names]
        parts.append(sum(vals) / len(vals))
    if not parts:
        return 0.0
    return round(min(cap, sum(parts) / len(parts)), 3)


def adjustment(learned: dict | None, sources: list[str], tags: list[str], artist: str) -> tuple[float, list[str]]:
    """The learned bonus (or penalty) for one item, with the reasons a card can show."""
    if not learned or not learned.get("outcomes"):
        return 0.0, []
    cap = float(learned.get("cap") or DEFAULTS["max_adjust"])
    f = _features({"s": sources, "t": tags, "a": artist})
    total = 0.0
    reasons: list[str] = []
    for kind, names in f.items():
        table = learned.get(kind) or {}
        vals = [table[n] for n in names if n in table and table[n].get("adj")]
        if not vals:
            continue
        part = sum(v["adj"] for v in vals) / len(vals)
        total += part
        best = max(vals, key=lambda v: abs(v["adj"]))
        if abs(best["adj"]) >= 0.5:
            label = next(n for n in names if table.get(n) is best)
            pct = round(best["rate"] * 100)
            if kind == "sources":
                reasons.append(f"you keep {pct}% from {label.split(':', 1)[-1]}" if best["adj"] > 0 else f"you rarely keep {label.split(':', 1)[-1]}")
            elif kind == "tags":
                reasons.append(f"you keep {pct}% of {label}" if best["adj"] > 0 else f"you rarely keep {label}")
            else:
                reasons.append(f"you keep {best['k']} of {best['n']} by them" if best["adj"] > 0 else f"passed on them {best['n']} times")
    return max(-cap, min(cap, total)), reasons


def public_summary(learned: dict, *, top: int = 40) -> dict:
    """What feed.json carries: the rates the site's stats panel shows, trimmed to features seen a few times."""
    def trim(table: dict, key) -> dict:
        rows = sorted(((n, v) for n, v in table.items() if v["n"] >= 3), key=key)[:top]
        return {n: v for n, v in rows}
    return {"outcomes": learned.get("outcomes", 0), "kept": learned.get("kept", 0), "skipped": learned.get("skipped", 0),
            "keep_rate": learned.get("keep_rate", 0.0), "since": learned.get("since"),
            "sources": trim(learned.get("sources") or {}, lambda kv: -kv[1]["n"]),
            "tags": trim(learned.get("tags") or {}, lambda kv: -kv[1]["n"])}
