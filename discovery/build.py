"""Assemble the daily feed: run sources → merge → score → resolve → write site/data/feed.json + feed.xml + history."""
from __future__ import annotations

import hashlib
import html
from datetime import date, timedelta

from .models import Item
from .profile import find_duplicates, load_profile
from .resolve import collapse_shared_videos, resolve_all
from .score import dedupe, score_items
from .sources import run_sources
from .util import DATA_DIR, SITE_DATA_DIR, Deadline, Http, log, read_json, safe_url, utcnow, write_json
from .years import annotate_duplicate_years, verify_years

FEED_PATH = SITE_DATA_DIR / "feed.json"
STATE_PATH = DATA_DIR / "state.json"


def build_feed(cfg: dict) -> dict:
    http = Http("sources", ttl_hours=20)
    profile = load_profile()
    state = read_json(STATE_PATH, {"first_seen": {}})
    first_seen: dict[str, str] = state.setdefault("first_seen", {})

    raw = [i.normalize_credit() for i in run_sources(cfg, profile, http)]
    items = dedupe(raw)
    _clean_tags(items, profile)
    log.info("%d raw sightings → %d unique items", len(raw), len(items))

    rcfg = cfg["ranking"]
    deadline = Deadline(float((cfg.get("resolve") or {}).get("time_budget_minutes") or 0) or None)
    # drop things already in your year playlists (kept) or the Skipped playlist (skipped)
    saved = profile.get("saved") or {}
    saved_videos = {v.get("videoId") for v in saved.values() if isinstance(v, dict) and v.get("videoId")}
    if rcfg.get("hide_seen", True):
        before = len(items)
        items = [i for i in items if i.key not in saved]
        log.info("hid %d already-saved/skipped items", before - len(items))

    items = score_items(items, profile, cfg)
    items = [i for i in items if i.score >= float(rcfg.get("min_score", 0))][: int(rcfg.get("max_items", 200)) + 60]
    resolve_all(items, cfg, deadline)
    items = collapse_shared_videos(items)   # several items on one video are one song: one card
    # after resolution, drop things with no playable YouTube result unless they are strong matches
    items = [i for i in items if i.youtube or i.match_kind == "direct" or i.editorial]
    if rcfg.get("hide_seen", True):
        # resolution can rename a release to its first track (new key) or land on a video that is already filed
        # under a different spelling: the video id is the exact test, so apply it now that we have one
        before = len(items)
        items = [i for i in items if i.key not in saved and not (i.youtube and i.youtube.get("videoId") in saved_videos)]
        if before - len(items):
            log.info("hid %d more items whose YouTube video is already in a playlist", before - len(items))
    items = score_items(items, profile, cfg)[: int(rcfg.get("max_items", 200))]
    verify_years(items, cfg, http, deadline)
    # the duplicate report is derived from the profile's raw playlist scan on every build, so a change to what
    # counts as a duplicate never waits for the next profile rebuild
    ymeta = profile.get("youtube") or {}
    dups = find_duplicates(ymeta.get("entries") or []) if ymeta.get("entries") else list(ymeta.get("duplicates") or [])
    annotate_duplicate_years(dups, cfg, http, deadline)
    dup_kinds: dict[str, int] = {}
    for d in dups:
        dup_kinds[d.get("kind", "?")] = dup_kinds.get(d.get("kind", "?"), 0) + 1
    checked_at = (profile.get("youtube") or {}).get("checked_at")
    # the full report lives in its own file (thousands of rows on a big library); feed.json only carries the counts
    write_json(SITE_DATA_DIR / "duplicates.json", {"checked_at": checked_at, "count": len(dups), "kinds": dup_kinds, "duplicates": dups}, compact=True)

    today_s = date.today().isoformat()
    for it in items:
        first_seen.setdefault(it.key, today_s)
        if not it.release_date:
            # the day we first saw it is a sighting, never a release date: the site must not file by it
            it.release_date, it.date_kind = date.fromisoformat(first_seen[it.key]), "sighting"
    cutoff_keys = {i.key for i in items}
    # keep first_seen bounded to the last ~60 days of items
    state["first_seen"] = {k: v for k, v in first_seen.items() if k in cutoff_keys or (date.today() - date.fromisoformat(v)).days < 60}
    write_json(STATE_PATH, state, compact=True)

    ycfg = cfg.get("youtube_music") or {}
    gcfg = cfg.get("google") or {}
    payload = {
        "generated_at": utcnow().isoformat(),
        "station": cfg["station"]["name"],
        "site_name": cfg["station"].get("site_name") or cfg["station"]["name"],
        # curator accounts are published as SHA-256 of the lower-cased address: enough for the site to recognise the
        # signed-in account, without printing anyone's email in a public file
        "google": {"client_id": gcfg.get("client_id") or "", "curator_hashes": [_email_hash(c) for c in (gcfg.get("curators") or [])],
                   "guests": bool(gcfg.get("guests", False)), "guest_playlist_title_pattern": gcfg.get("guest_playlist_title_pattern") or "{year} Picks from chrisrohn.com"},
        "youtube": {
            "playlist_title_pattern": ycfg.get("playlist_title_pattern", "{year} | Indie Discotheque"),
            "skipped_playlist_title": ycfg.get("skipped_playlist_title", "Skipped"),
            # config ids are authoritative; anything the profile discovered by title only fills gaps
            "playlists": {**((profile.get("youtube") or {}).get("years") or {}), **{str(y): p for y, p in (ycfg.get("playlists") or {}).items()}},
            "skipped_playlist_id": (profile.get("youtube") or {}).get("skipped") or ycfg.get("skipped_playlist_id") or "",
            "skips_in_youtube": bool(ycfg.get("skips_in_youtube", False)),
            "channel_id": (profile.get("youtube") or {}).get("channel") or ycfg.get("channel_id") or "",
            # songs that appear more than once across the year playlists: counts here, the full list in data/duplicates.json
            "duplicates_count": len(dups),
            "duplicates_kinds": dup_kinds,
            "duplicates_checked_at": checked_at,
        },
        "picks": profile.get("picks") or [],
        "feed_health": _feed_health(),
        "lastfm_user": cfg["station"]["lastfm_user"],
        "profile": {"built_at": profile.get("built_at"), "counts": profile.get("counts")},
        "years": _year_range(cfg),
        "count": len(items),
        "new_today": sum(1 for i in items if first_seen.get(i.key) == today_s),
        "sources": sorted({s.split(":")[0] for i in items for s in i.sources}),
        "blogs": sorted({s.split(":", 1)[1] for i in items for s in i.sources if s.startswith("rss:")}),
        "items": [_public_item(i, first_seen.get(i.key)) for i in items],
    }
    write_json(FEED_PATH, payload, compact=True)
    _write_history(today_s, items)
    _write_rss(cfg, payload)
    http.save()
    log.info("feed: %d items (%d new today)", payload["count"], payload["new_today"])
    return payload


def _email_hash(email: str) -> str:
    return hashlib.sha256(email.strip().lower().encode("utf-8")).hexdigest()


_PRIVATE_FIELDS = ("artist_mbids", "listen_count", "featuring", "remixer", "remix_kind", "blurb", "stated_year")
_PRIVATE_YT_FIELDS = ("title", "artists", "via", "albumBrowseId", "trackCount", "duration")


def _public_item(it: Item, first_seen: str | None) -> dict:
    """What feed.json carries per item: everything the site reads, nothing it doesn't (about a third of the bytes)."""
    d = it.to_dict()
    for k in _PRIVATE_FIELDS:
        d.pop(k, None)
    if d.get("youtube"):
        d["youtube"] = {k: v for k, v in d["youtube"].items() if k not in _PRIVATE_YT_FIELDS}
    d["links"] = {k: s for k, u in (d.get("links") or {}).items() if (s := safe_url(u))}
    d["first_seen"] = first_seen
    return d


def _write_history(today_s: str, items: list[Item], keep_days: int = 90) -> None:
    hist = SITE_DATA_DIR / "history"
    write_json(hist / f"{today_s}.json", {"date": today_s, "ids": [i.key for i in items]}, compact=True)
    cutoff = (date.today() - timedelta(days=keep_days)).isoformat()
    for f in hist.glob("*.json"):
        if f.stem < cutoff:
            f.unlink()


def _clean_tags(items: list[Item], profile: dict) -> None:
    """Blog/radio/channel feeds ship article categories ("news", "video", artist names) as tags. Keep only genre words:
    tags the profile knows, or ones that look like genres. Catalogue sources (MusicBrainz, Bandcamp) already send genres."""
    known = set(profile.get("tags") or {})
    genre_words = ("pop", "disco", "house", "electro", "synth", "wave", "punk", "rock", "soul", "funk", "indie", "dance", "techno",
                   "ambient", "folk", "jazz", "psych", "shoegaze", "dream", "lo-fi", "lofi", "r&b", "rnb", "hip hop", "garage", "balearic",
                   "boogie", "italo", "krautrock", "downtempo", "trip hop", "breakbeat", "bass", "club", "alternative", "electronic")
    for it in items:
        if not it.tags:
            continue
        cleaned = []
        for t in it.tags:
            tn = t.lower().strip()
            genre = tn.startswith("label:") or tn in known or any(w in tn for w in genre_words)
            if genre and tn not in cleaned and tn not in (it.artist or "").lower():
                cleaned.append(tn)
        it.tags = cleaned[:6]


def _feed_health() -> dict:
    from .sources import HEALTH
    return dict(HEALTH)


def _year_range(cfg: dict) -> list[int]:
    ycfg = cfg.get("youtube_music") or {}
    lo = int(ycfg.get("first_year", 1979))
    hi = max(date.today().year, int(ycfg.get("last_year", date.today().year)))
    return list(range(hi, lo - 1, -1))


def _write_rss(cfg: dict, payload: dict) -> None:
    domain = cfg["station"].get("domain", "chrisrohn.com")
    esc = html.escape
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>',
        f"<title>{esc(cfg['station'].get('site_name') or payload['station'])}</title>",
        f"<link>https://{domain}/</link>",
        f"<description>Daily new-music discovery feed: candidates for the {esc(payload['station'])} playlists on YouTube Music</description>",
        f'<atom:link href="https://{domain}/feed.xml" rel="self" type="application/rss+xml"/>',
    ]
    for it in payload["items"][:100]:
        yt = it.get("youtube") or {}
        link = f"https://music.youtube.com/watch?v={yt['videoId']}" if yt.get("videoId") else next(iter(it.get("links", {}).values()), f"https://{domain}/")
        desc = f"{it.get('release_type') or ''} {it.get('release') or ''} · score {it['score']} · {', '.join(it.get('reasons', []))}".strip()
        parts.append(
            "<item>"
            f"<title>{esc(it.get('display') or (it['artist'] + ' - ' + it['title']))}</title>"
            f"<link>{esc(link)}</link>"
            f"<guid isPermaLink=\"false\">{it['id']}</guid>"
            f"<description>{esc(desc)}</description>"
            "</item>"
        )
    parts.append("</channel></rss>")
    (SITE_DATA_DIR.parent / "feed.xml").write_text("\n".join(parts), encoding="utf-8")
