"""The day's share of new artists: acts the station has never played, chosen for how well they fit its sound.

An act the station has played is vetted, so it is kept far more often (26–37% against a few percent) — but a feed of
only those would never find anyone new, and finding new acts is half the point. So the day is two lists: the
established acts (played on the station, or in your profile or playlists), ranked as ever, and the newcomers, ranked
among themselves, which hold `share` of the day (more, up to `max_share`, when the established acts run short). The
newcomers are spread evenly through the list, not left at the bottom: every few cards one is new.

A newcomer must fit the format to be in the share at all: Last.fm listeners play it next to the station's own songs
(sources/lastfm_similar.py: `fit`, `similar_to`), it is Last.fm-similar to an act you play or a top act of your
genres (profile kinds "similar" / "genre"), or its genre tags score at least `min_tag_score` in your tag profile.
A newcomer with none of that — a blog headline, a radio spin, a tag crawl's stray — is not shown."""
from __future__ import annotations

from .models import Item
from .util import log, norm


def is_newcomer(it: Item, history) -> bool:
    """An act the station has never played and that your profile does not count as yours (played under another
    name, or in your playlists). Without a history snapshot nobody is a newcomer: there is no evidence to judge by."""
    return bool(history) and not it.station_plays and it.match_kind not in ("direct", "saved")


def fit_evidence(it: Item, profile: dict, ncfg: dict) -> str | None:
    """Why a newcomer fits the station's sound, or None when nothing says it does."""
    if it.fit > 0 and it.similar_to:
        return "like " + ", ".join(it.similar_to[:2])
    if it.match_kind in ("similar", "genre") and it.matched_artist:
        return "similar to your artists" if it.match_kind == "similar" else "a top act of your genres"
    tags = profile.get("tags") or {}
    score = sum(float(tags.get(norm(t), 0) or 0) for t in it.tags)
    if score >= float(ncfg.get("min_tag_score", 0.3)):
        return "your genres: " + ", ".join(t for t in it.tags if float(tags.get(norm(t), 0) or 0) > 0)[:60]
    return None


def compose(items: list[Item], cfg: dict, profile: dict, max_items: int) -> tuple[list[Item], dict]:
    """The day: the best established cards and the best fitting newcomers, `share` of the day for the newcomers
    (up to `max_share` when the established run short), the newcomers spread evenly through the list. Each newcomer's
    score is set between its neighbours', so the order survives the site's sort by score. Returns the list and the
    counts for the log and the payload."""
    ncfg = cfg.get("newcomers") or {}
    history = profile.get("history")
    stats = {"shown": 0, "fitting": 0, "unfitting": 0, "share": 0.0}
    if not ncfg.get("enabled", True) or not history:
        return items[:max_items], stats
    new = [i for i in items if is_newcomer(i, history)]
    est = [i for i in items if not is_newcomer(i, history)]
    fitting: list[Item] = []
    for it in new:
        why = fit_evidence(it, profile, ncfg)
        if why:
            fitting.append(it)
    stats["fitting"], stats["unfitting"] = len(fitting), len(new) - len(fitting)
    share = min(1.0, max(0.0, float(ncfg.get("share", 0.3))))
    cap = round(max_items * max(share, min(1.0, float(ncfg.get("max_share", 0.5)))))
    n_new = min(len(fitting), cap, max(round(max_items * share), max_items - len(est)))
    n_est = min(len(est), max_items - n_new)
    chosen_new, chosen_est = fitting[:n_new], est[:n_est]
    for it in chosen_new:
        it.newcomer = True
        if "new to the station" not in it.reasons:
            it.reasons.insert(0, "new to the station")
        why = fit_evidence(it, profile, ncfg)
        if why and why not in it.reasons and not any(r.startswith("like ") for r in it.reasons):
            it.reasons.append(why)
    out = interleave(chosen_est, chosen_new)
    stats["shown"] = len(chosen_new)
    stats["share"] = round(len(chosen_new) / len(out), 3) if out else 0.0
    log.info("newcomers: %d of the day's %d cards are acts new to the station (%d fit the format, %d did not and are left out)",
             len(chosen_new), len(out), len(fitting), len(new) - len(fitting))
    return out, stats


def lookup_order(est: list[Item], new: list[Item], share: float) -> list[Item]:
    """The order the resolver takes the candidates in: each list in its own order, a newcomer after every few vetted
    candidates so they get about `share` of the YouTube lookups. Resolution stops when its time is up; in score order
    the newcomers, which score lower, were the ones left unresolved."""
    if not new or not est:
        return est + new
    share = min(0.9, max(0.05, share))
    out: list[Item] = []
    ei = ni = 0
    while ei < len(est) or ni < len(new):
        if ni < len(new) and (ei >= len(est) or ni < (len(out) + 1) * share):
            out.append(new[ni])
            ni += 1
        else:
            out.append(est[ei])
            ei += 1
    return out


def interleave(est: list[Item], new: list[Item]) -> list[Item]:
    """Both lists in their own order, the newcomers spread evenly among the established cards, and every newcomer's
    score placed between its neighbours' so a sort by score keeps the spread."""
    total = len(est) + len(new)
    out: list[Item] = []
    ei = ni = 0
    for idx in range(total):
        due = (idx + 1) * len(new) // total > ni if total else False
        if ni < len(new) and (ei >= len(est) or due):
            out.append(new[ni])
            ni += 1
        else:
            out.append(est[ei])
            ei += 1
    for p, it in enumerate(out):
        if not it.newcomer:
            continue
        above = next((out[q].score for q in range(p - 1, -1, -1) if not out[q].newcomer), None)
        below = next((out[q].score for q in range(p + 1, len(out)) if not out[q].newcomer), None)
        prev = out[p - 1].score if p else None
        if above is not None and below is not None:
            target = (above + below) / 2
        elif above is not None:
            target = above - 0.01
        elif below is not None:
            target = below + 0.01 * (len(new))
        else:
            target = it.score
        if prev is not None:
            target = min(target, prev - 0.001)
        it.score = round(target, 3)
    return out
