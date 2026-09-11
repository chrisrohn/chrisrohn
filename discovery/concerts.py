"""Upcoming concerts near Detroit by the artists played on Indie Discotheque in the last year.

Songkick used to do this: one page listing every show near you by the acts you listen to. Songkick's API is closed
to new applications, so this draws the same list from what is still open:

  * who was played – Last.fm `user.getTopArtists` for `station.lastfm_user` over the last 12 months (the scrobbles of
    the Indie Discotheque playlists), plus every artist filed into this year's playlist (`concerts.playlist_years`).
    Without a Last.fm key the profile's 12-month artists stand in.
  * where they play – Bandsintown's artist-events API (free, but only with an app_id Bandsintown issued: an artist's
    API key from Bandsintown for Artists → Settings → General, or one from biz@bandsintown.com; the
    BANDSINTOWN_APP_ID secret carries it, `concerts.bandsintown.app_id` is the fallback, and an id Bandsintown does
    not know is refused) asked artist by artist, a rotating batch a run, kept per artist for `refresh_days`; and, when a free
    TICKETMASTER_API_KEY is set, Ticketmaster's Discovery API for every music event within the radius up to
    `months_ahead` (Ticketmaster stops paging at its 1,000th result, so the horizon is split into date windows
    small enough to fit), matched against the same artists (a second ticket link, prices, sale status and the
    venue's picture).
  * how close – a great-circle distance from `concerts.center` (Detroit); anything past `radius_miles` is dropped.
  * their most popular song – Last.fm `artist.getTopTracks` (Deezer's artist top when there is no key), resolved
    on YouTube Music through the feed's resolver and cache so the card plays it in place.

State lives in data/concerts_state.json (per artist: when it was last asked, its shows within the radius, its top
song); the public list is site/data/concerts.json for the Concerts tab. Nothing here spends YouTube API quota.
"""
from __future__ import annotations

import logging
import math
import os
import re
from collections import Counter
from datetime import date, datetime, timedelta
from typing import Any
from urllib.parse import quote, urlparse

from .models import Item
from .profile import LastFm, load_profile
from .util import DATA_DIR, SITE_DATA_DIR, Deadline, Http, item_key, log, miss_expired, miss_row, norm, parse_date, read_json, safe_url, utcnow, write_json

CONCERTS_PATH = SITE_DATA_DIR / "concerts.json"
STATE_PATH = DATA_DIR / "concerts_state.json"
STATE_VERSION = 1

BIT_API = "https://rest.bandsintown.com/artists/{name}/events/"
TM_API = "https://app.ticketmaster.com/discovery/v2/events.json"
DEEZER_API = "https://api.deezer.com"
TM_DEEP_PAGING_LIMIT = 1000     # Ticketmaster refuses page × size beyond this: a date window holding more is split
TM_MIN_WINDOW = timedelta(hours=1)   # a window this short is not split further, whatever it holds
TM_TIME = "%Y-%m-%dT%H:%M:%SZ"  # the only datetime format Ticketmaster's Discovery API accepts (UTC, no fraction)
EARTH_RADIUS_MILES = 3958.7613
SONGS_RESERVE_MINUTES = 5       # the artist loop leaves this much of the time budget for the top songs and their videos

DEFAULTS: dict[str, Any] = {
    "enabled": True,
    "center": {"name": "Detroit, MI", "lat": 42.3314, "lon": -83.0458},
    "radius_miles": 80,
    "months_ahead": 12,           # shows further out than this wait; Bandsintown lists festivals a year ahead
    "lastfm_limit": 0,            # user.getTopArtists over 12 months (200 a request); 0 = every artist Last.fm has
    "playlist_years": 1,          # artists filed into this year's playlist count as played (2 = last year's too)
    "refresh_days": 2,            # an artist's listings are asked for again after this
    "artists_per_run": 0,         # Bandsintown lookups a run, the most played first; 0 = as many as the time budget allows
    "time_budget_minutes": 20,    # wall clock for the run (the workflow times out at 30); the artist loop stops SONGS_RESERVE_MINUTES early
    "top_tracks_per_run": 300,    # Last.fm / Deezer top-song lookups a run (only artists with a show nearby)
    "resolve_per_run": 300,       # YouTube Music lookups for those songs a run
    "bandsintown": {"enabled": True, "app_id": "chrisrohn.com", "give_up_after": 10},   # BANDSINTOWN_APP_ID overrides app_id
    "ticketmaster": {"enabled": True, "size": 200, "requests_per_run": 60},   # needs TICKETMASTER_API_KEY (free)
}


def _cfg(cfg: dict) -> dict:
    raw = cfg.get("concerts") or {}
    c = {**DEFAULTS, **raw}
    for k in ("center", "bandsintown", "ticketmaster"):
        c[k] = {**DEFAULTS[k], **(raw.get(k) or {})}
    return c


# Who sells the tickets, by the link's host. TicketWeb (Ticketmaster's club-sized arm) and AXS have no public API of
# their own, but Bandsintown's offer links go to whichever of these the venue uses, so the button can say which.
TICKETERS = (("ticketmaster.", "Ticketmaster"), ("ticketweb.", "TicketWeb"), ("axs.com", "AXS"), ("etix.com", "Etix"), ("dice.fm", "DICE"), ("eventbrite.", "Eventbrite"),
             ("seetickets.", "See Tickets"), ("universe.com", "Universe"), ("frontgatetickets.", "Front Gate"), ("showclix.", "ShowClix"), ("tixr.com", "Tixr"), ("ticketon.", "Ticketon"),
             ("prekindle.", "Prekindle"), ("livenation.", "Live Nation"), ("stubhub.", "StubHub"), ("seatgeek.", "SeatGeek"), ("songkick.com", "Songkick"), ("bandsintown.com", "Bandsintown"),
             ("ticketalternative.", "Ticket Alternative"), ("freshtix.", "Freshtix"), ("eventim.", "Eventim"), ("ticketspice.", "TicketSpice"), ("ticketleap.", "TicketLeap"))


def ticketer_of(url: str | None) -> str | None:
    """The ticket seller a link leads to, when its host says ("AXS", "TicketWeb", ...); None for a redirect nobody can read."""
    try:
        host = (urlparse(str(url or "")).hostname or "").lower()
    except ValueError:
        return None
    if not host:
        return None
    return next((name for needle, name in TICKETERS if needle in host), None)


# ---------- geography ----------

def miles_between(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in miles (haversine)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_MILES * math.asin(math.sqrt(a))


def _float(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def within(ev: dict, center: dict, radius: float) -> dict | None:
    """The event with its distance from the centre filled in, or None when it is further than `radius` miles (or
    has no coordinates at all: a venue nobody placed on the map is not near anything)."""
    lat, lon = _float(ev.get("lat")), _float(ev.get("lon"))
    if lat is None or lon is None:
        return None
    d = miles_between(float(center["lat"]), float(center["lon"]), lat, lon)
    if d > radius:
        return None
    return {**ev, "miles": round(d, 1)}


# ---------- who was played ----------

def played_artists(cfg: dict, profile: dict, lastfm: LastFm) -> dict[str, dict]:
    """{norm name: {"name", "plays", "filed", "via"}} — everyone played on Indie Discotheque over the last year:
    the Last.fm 12-month chart (scrobble counts), plus anyone filed into this year's playlist (`playlist_years`)."""
    c = _cfg(cfg)
    user = cfg["station"]["lastfm_user"]
    out: dict[str, dict] = {}

    def add(name: str, *, plays: int = 0, filed: int = 0, via: str) -> None:
        n = norm(name)
        if not n:
            return
        e = out.setdefault(n, {"name": name, "plays": 0, "filed": 0, "via": []})
        e["plays"] = max(e["plays"], int(plays or 0))
        e["filed"] += int(filed or 0)
        if via not in e["via"]:
            e["via"].append(via)

    if lastfm.enabled:
        arts = lastfm.top_artists(user, "12month", int(c["lastfm_limit"]))
        for a in arts:
            add(a.get("name") or "", plays=a.get("playcount") or 0, via="lastfm:12month")
        log.info("concerts: %d artists played on Last.fm in the last 12 months", len(arts))
    else:
        for e in (profile.get("artists") or {}).values():
            if "lastfm:12month" in (e.get("via") or []):
                add(e.get("name") or "", via="lastfm:12month")
        log.warning("concerts: LASTFM_API_KEY not set; using the profile's 12-month artists (%d, no play counts)", len(out))
    years = {str(date.today().year - i) for i in range(max(0, int(c["playlist_years"])))}
    filed: dict[str, int] = {}
    for e in (profile.get("youtube") or {}).get("entries") or []:
        if str(e.get("year")) in years and e.get("artist"):
            filed[e["artist"]] = filed.get(e["artist"], 0) + 1
    for name, n in filed.items():
        add(name, filed=n, via="playlists")
    return out


def ranked(played: dict[str, dict]) -> list[str]:
    """Norm keys, the most played first (then the most filed, then by name)."""
    return sorted(played, key=lambda k: (-played[k]["plays"], -played[k]["filed"], played[k]["name"].lower()))


# ---------- Bandsintown ----------

def bit_name(name: str) -> str:
    """Bandsintown's path encoding: slashes, question marks, stars and double quotes in a name are double-escaped."""
    q = quote(name, safe="")
    return q.replace("%2F", "%252F").replace("%3F", "%253F").replace("%2A", "%252A").replace("%22", "%27C")


def failure_reason(exc: BaseException) -> str:
    """A short label for a failed request, to tally: "HTTP 403" from requests' "403 Client Error: Forbidden for
    url: …", else the exception's class ("ReadTimeout", "ConnectionError")."""
    m = re.match(r"\s*(\d{3})\b", str(exc))
    return f"HTTP {m.group(1)}" if m else type(exc).__name__


def bandsintown_events(http: Http, name: str, app_id: str, reasons: Counter | None = None) -> list[dict] | None:
    """The artist's upcoming shows, as Bandsintown lists them; [] when it does not know the act, None when the
    request failed (the old listing is then kept and the artist asked again next run; `reasons`, when given,
    counts why — Bandsintown answers 403 to an app_id it did not issue, and that must not stay a debug line)."""
    try:
        data = http.get(BIT_API.format(name=bit_name(name)), params={"app_id": app_id, "date": "upcoming"}, cache=False, retries=1, timeout=20)
    except Exception as exc:  # noqa: BLE001
        if "404" in str(exc):
            return []
        if reasons is not None:
            reasons[failure_reason(exc)] += 1
        log.debug("bandsintown %s: %s", name, exc)
        return None
    if isinstance(data, dict):
        if data.get("errorMessage"):
            return []
        if reasons is not None:
            reasons["unexpected object"] += 1
        return None
    return [e for e in (data or []) if isinstance(e, dict)]


def shape_bandsintown(ev: dict, artist: str) -> dict:
    """One Bandsintown event as the tab shows it (coordinates kept for the radius test)."""
    v = ev.get("venue") or {}
    offers = [o for o in (ev.get("offers") or []) if isinstance(o, dict)]
    tickets = next((safe_url(o.get("url")) for o in offers if str(o.get("type") or "").lower() == "tickets" and safe_url(o.get("url"))), None)
    when = str(ev.get("datetime") or ev.get("starts_at") or "")
    d = parse_date(when)
    t = re.search(r"T(\d{2}:\d{2})", when)
    lineup = [str(x) for x in (ev.get("lineup") or []) if x]
    status = "cancelled" if str(ev.get("title") or "").lower().startswith("cancel") else (str(offers[0].get("status") or "") if offers else "")
    return {
        "id": f"bit:{ev.get('id')}", "artist": artist, "lineup": lineup, "title": (ev.get("title") or "").strip() or None,
        "date": d.isoformat() if d else None, "time": t.group(1) if t else None,
        "venue": (v.get("name") or "").strip(), "city": (v.get("city") or "").strip(), "region": (v.get("region") or "").strip(), "country": (v.get("country") or "").strip(),
        "lat": _float(v.get("latitude")), "lon": _float(v.get("longitude")),
        "tickets": tickets, "ticketer": ticketer_of(tickets), "url": safe_url(ev.get("url")), "status": status.lower() or None, "sources": ["bandsintown"],
        "links": {"bandsintown": safe_url(ev.get("url"))} if safe_url(ev.get("url")) else {},
        "festival": bool(ev.get("festival_start_date") or ev.get("festival_datetime_display_start_date")),
    }


# ---------- Ticketmaster ----------

def ticketmaster_events(http: Http, key: str, center: dict, radius: float, *, start: datetime, end: datetime, size: int = 200,
                        max_requests: int = 60) -> list[dict]:
    """Every music event Ticketmaster lists within the radius between `start` and `end` (UTC), soonest first, each
    once by id. Ticketmaster refuses to page past its 1,000th result (page × size), so a window it says holds more
    than that is split in half and each half asked for on its own, down to TM_MIN_WINDOW; a busy metro's whole
    year comes back in a few dozen requests, capped at `max_requests` a run (the soonest windows first, so a cap
    trims the far end). Raises on a failed request so the caller can keep the last snapshot."""
    base = {"apikey": key, "latlong": f"{center['lat']},{center['lon']}", "radius": str(int(radius)), "unit": "miles", "classificationName": "music",
            "size": str(size), "sort": "date,asc", "locale": "*", "includeTBA": "yes", "includeTBD": "yes"}
    out: dict[str, dict] = {}
    windows: list[tuple[datetime, datetime]] = [(start, end)]
    spent = asked = 0
    while windows:
        lo, hi = windows.pop(0)
        asked += 1
        page = 0
        while True:
            if spent >= max(1, int(max_requests)):
                log.warning("concerts: ticketmaster request budget (%d) spent with %d windows unasked; the list stops at %s", spent, len(windows) + 1, lo.strftime(TM_TIME))
                return list(out.values())
            data = http.get(TM_API, params={**base, "startDateTime": lo.strftime(TM_TIME), "endDateTime": hi.strftime(TM_TIME), "page": str(page)}, cache=False, timeout=30)
            spent += 1
            evs = [e for e in (((data or {}).get("_embedded") or {}).get("events") or []) if isinstance(e, dict)]
            for e in evs:
                out[str(e.get("id") or f"{lo.strftime(TM_TIME)}/{page}/{len(out)}")] = e
            pg = (data or {}).get("page") or {}
            total, total_pages = int(pg.get("totalElements") or 0), int(pg.get("totalPages") or 0)
            if page == 0 and total > TM_DEEP_PAGING_LIMIT and hi - lo > TM_MIN_WINDOW:
                mid = lo + (hi - lo) / 2
                windows[:0] = [(lo, mid), (mid + timedelta(seconds=1), hi)]   # the halves, still soonest first
                break
            if page == 0 and total > TM_DEEP_PAGING_LIMIT:
                log.warning("concerts: ticketmaster lists %d events between %s and %s; only the first %d can be paged", total, lo.strftime(TM_TIME), hi.strftime(TM_TIME), TM_DEEP_PAGING_LIMIT)
            if not evs or page + 1 >= total_pages or (page + 1) * size >= TM_DEEP_PAGING_LIMIT:
                break
            page += 1
    log.info("concerts: ticketmaster asked %d request(s) over %d date window(s)", spent, asked)
    return list(out.values())


def shape_ticketmaster(ev: dict) -> dict:
    emb = ev.get("_embedded") or {}
    v = (emb.get("venues") or [{}])[0] or {}
    loc = v.get("location") or {}
    start = (ev.get("dates") or {}).get("start") or {}
    status = ((ev.get("dates") or {}).get("status") or {}).get("code")
    prices = [p for p in (ev.get("priceRanges") or []) if isinstance(p, dict)]
    price = {"min": prices[0].get("min"), "max": prices[0].get("max"), "currency": prices[0].get("currency")} if prices else None
    imgs = [i for i in (ev.get("images") or []) if isinstance(i, dict) and safe_url(i.get("url"))]
    wide = sorted((i for i in imgs if i.get("ratio") == "16_9" and int(i.get("width") or 0) >= 640), key=lambda i: int(i.get("width") or 0))
    image = safe_url((wide or imgs or [{}])[0].get("url"))
    lineup = [str(a.get("name")) for a in (emb.get("attractions") or []) if isinstance(a, dict) and a.get("name")]
    return {
        "id": f"tm:{ev.get('id')}", "artist": lineup[0] if lineup else (ev.get("name") or ""), "lineup": lineup, "title": (ev.get("name") or "").strip() or None,
        "date": start.get("localDate"), "time": (start.get("localTime") or "")[:5] or None,
        "venue": (v.get("name") or "").strip(), "city": ((v.get("city") or {}).get("name") or "").strip(), "region": ((v.get("state") or {}).get("stateCode") or "").strip(),
        "country": ((v.get("country") or {}).get("name") or (v.get("country") or {}).get("countryCode") or "").strip(),
        "lat": _float(loc.get("latitude")), "lon": _float(loc.get("longitude")),
        "tickets": safe_url(ev.get("url")), "ticketer": "Ticketmaster" if safe_url(ev.get("url")) else None, "url": safe_url(ev.get("url")), "status": (status or "").lower() or None,
        "sources": ["ticketmaster"], "links": {"ticketmaster": safe_url(ev.get("url"))} if safe_url(ev.get("url")) else {},
        "price": price, "image": image, "festival": False,
    }


def matched_artists(names: list[str], played: dict[str, dict]) -> list[str]:
    """Which of the profile's played artists are on a bill, the most played first (norm equality only: "Jungle"
    never matches "Jungle Brothers")."""
    hits = {norm(n) for n in names} & set(played)
    return [played[k]["name"] for k in sorted(hits, key=lambda k: (-played[k]["plays"], -played[k]["filed"]))]


# ---------- merging ----------

def merge_events(events: list[dict]) -> list[dict]:
    """One row per show: the same source id folds together (two artists on one Bandsintown bill), and the same
    headliner on the same date across sources is one show with both links."""
    by_id: dict[str, dict] = {}
    for ev in events:
        cur = by_id.get(ev["id"])
        if cur is None:
            by_id[ev["id"]] = {**ev, "artists": list(ev.get("artists") or [ev["artist"]])}
            continue
        for a in ev.get("artists") or [ev["artist"]]:
            if a not in cur["artists"]:
                cur["artists"].append(a)
    by_show: dict[tuple[str, str], dict] = {}
    for ev in by_id.values():
        key = (norm(ev["artist"]), ev.get("date") or "")
        cur = by_show.get(key)
        if cur is None:
            by_show[key] = ev
            continue
        # Bandsintown's row leads (its lineup is the bill); Ticketmaster adds the ticket link, price, status, picture
        base, other = (cur, ev) if "bandsintown" in cur["sources"] else (ev, cur)
        base["sources"] = sorted(set(base["sources"]) | set(other["sources"]))
        base["links"] = {**(base.get("links") or {}), **(other.get("links") or {})}
        if not base.get("tickets") and other.get("tickets"):
            base["tickets"], base["ticketer"] = other["tickets"], other.get("ticketer")
        for k in ("url", "price", "image", "status", "time", "venue", "city", "region"):
            if not base.get(k) and other.get(k):
                base[k] = other[k]
        for a in other.get("artists") or []:
            if a not in base["artists"]:
                base["artists"].append(a)
        for a in other.get("lineup") or []:
            if a not in base["lineup"]:
                base["lineup"].append(a)
        by_show[key] = base
    out = list(by_show.values())
    out.sort(key=lambda e: (e.get("date") or "9999", e.get("miles") or 0, e["artist"].lower()))
    return out


# ---------- the most popular song ----------

def top_track(lastfm: LastFm, http: Http, name: str) -> dict | None:
    """The act's most popular song: Last.fm's top track (listeners and plays), else Deezer's artist top (rank)."""
    if lastfm.enabled:
        for t in lastfm.artist_top_tracks(name, 3):
            title = t.get("name")
            if title:
                return {"title": str(title), "source": "lastfm", "listeners": int(t.get("listeners") or 0), "plays": int(t.get("playcount") or 0), "url": safe_url(t.get("url"))}
    try:
        found = http.get(f"{DEEZER_API}/search/artist", params={"q": name, "limit": 3})
        aid = next((a["id"] for a in (found or {}).get("data") or [] if norm(a.get("name")) == norm(name) and a.get("id")), None)
        if not aid:
            return None
        top = http.get(f"{DEEZER_API}/artist/{aid}/top", params={"limit": 1})
        rows = (top or {}).get("data") or []
        if rows and rows[0].get("title"):
            return {"title": str(rows[0]["title"]), "source": "deezer", "rank": int(rows[0].get("rank") or 0), "url": safe_url(rows[0].get("link"))}
    except Exception as exc:  # noqa: BLE001
        log.debug("deezer top track %s: %s", name, exc)
    return None


# ---------- the build ----------

def _load_state() -> dict:
    st = read_json(STATE_PATH, None)
    if not isinstance(st, dict) or st.get("v") != STATE_VERSION:
        return {"v": STATE_VERSION, "artists": {}, "ticketmaster": {"fetched_at": None, "events": []}}
    st.setdefault("artists", {})
    st.setdefault("ticketmaster", {"fetched_at": None, "events": []})
    return st


def build_concerts(cfg: dict, *, deadline_minutes: float | None = None) -> dict | None:
    c = _cfg(cfg)
    if not c.get("enabled", True):
        return None
    center, radius = c["center"], float(c["radius_miles"])
    profile = load_profile()
    http = Http("concerts", ttl_hours=20)
    http.min_interval.update({"rest.bandsintown.com": 0.15, "app.ticketmaster.com": 0.25})   # Bandsintown answers in ~10ms; a 429 widens this on its own
    lastfm = LastFm(http, os.environ.get("LASTFM_API_KEY"))
    played = played_artists(cfg, profile, lastfm)
    http.save()
    state = _load_state()
    arts: dict[str, dict] = state["artists"]
    for k in [k for k in arts if k not in played]:   # no longer played: their listings go
        del arts[k]
    today = date.today()
    horizon = (today + timedelta(days=30 * int(c["months_ahead"]))).isoformat()
    minutes = float(c["time_budget_minutes"]) if deadline_minutes is None else min(float(c["time_budget_minutes"]), deadline_minutes)
    deadline = Deadline(max(0.01, minutes))
    health: dict[str, dict] = {}

    # 1. Ticketmaster: everything within the radius up to the horizon, matched against the played artists
    tcfg = c["ticketmaster"]
    tm_key = os.environ.get("TICKETMASTER_API_KEY")
    if tcfg.get("enabled", True) and tm_key:
        try:
            now = utcnow()
            raw = ticketmaster_events(http, tm_key, center, radius, start=now, end=now + timedelta(days=30 * int(c["months_ahead"]) + 1),
                                      size=int(tcfg.get("size", 200)), max_requests=int(tcfg.get("requests_per_run", 60)))
            shaped = []
            for ev in raw:
                s = within(shape_ticketmaster(ev), center, radius)
                if not s or not s.get("date"):
                    continue
                hits = matched_artists(s["lineup"] or [s["artist"]], played)
                if hits:
                    shaped.append({**s, "artist": hits[0], "artists": hits})
            state["ticketmaster"] = {"fetched_at": utcnow().isoformat(), "events": shaped}
            health["ticketmaster"] = {"ok": True, "events": len(raw), "matched": len(shaped)}
            log.info("concerts: ticketmaster lists %d music events within %d miles, %d by played artists", len(raw), radius, len(shaped))
        except Exception as exc:  # noqa: BLE001
            health["ticketmaster"] = {"ok": False, "error": str(exc)[:200], "matched": len(state["ticketmaster"].get("events") or [])}
            log.warning("concerts: ticketmaster failed (%s); keeping the last snapshot", exc)
    elif tcfg.get("enabled", True):
        health["ticketmaster"] = {"ok": False, "error": "TICKETMASTER_API_KEY not set", "matched": 0}
        state["ticketmaster"] = {"fetched_at": None, "events": []}

    # 2. Bandsintown: artist by artist, the most played first, those not asked for `refresh_days` — a batch a run
    bcfg = c["bandsintown"]
    app_id = os.environ.get("BANDSINTOWN_APP_ID") or str(bcfg.get("app_id") or "chrisrohn.com")
    asked = failed = 0
    reasons: Counter = Counter()
    give_up_after = max(1, int(bcfg.get("give_up_after", 10) or 10))
    if bcfg.get("enabled", True):
        cutoff = (utcnow() - timedelta(days=float(c["refresh_days"]))).isoformat()
        due = [k for k in ranked(played) if (arts.get(k) or {}).get("checked_at", "") < cutoff]
        per_run = int(c["artists_per_run"] or 0)
        for k in due if per_run <= 0 else due[:per_run]:
            if deadline.expired or deadline.remaining_minutes < SONGS_RESERVE_MINUTES:
                log.info("concerts: time budget spent after %d artists; %d stay due for the next run", asked, len(due) - asked)
                break
            if asked == failed == give_up_after:
                # every request so far failed the same way: Bandsintown is refusing us (an app_id it did not issue,
                # an outage), not this artist; the rest of the batch would fail too and stays due for the next run
                log.warning("concerts: bandsintown refused the first %d requests (%s) with app_id %r; giving up on the batch this run",
                            asked, ", ".join(f"{r} ×{n}" for r, n in reasons.most_common()), app_id)
                break
            name = played[k]["name"]
            evs = bandsintown_events(http, name, app_id, reasons)
            asked += 1
            if evs is None:
                failed += 1
                continue
            rows = []
            for ev in evs:
                s = within(shape_bandsintown(ev, name), center, radius)
                if s and s.get("date"):
                    rows.append({**s, "artists": [name] + [a for a in matched_artists(s["lineup"], played) if a != name]})
            who = (evs[0].get("artist") or {}) if evs else {}
            arts[k] = {"name": name, "checked_at": utcnow().isoformat(), "events": rows, "top": (arts.get(k) or {}).get("top"),
                       "page": safe_url(who.get("url")) or (arts.get(k) or {}).get("page"), "image": safe_url(who.get("image_url")) or (arts.get(k) or {}).get("image")}
        health["bandsintown"] = {"ok": failed < max(3, asked // 2), "asked": asked, "failed": failed, "due": len(due), "checked": sum(1 for a in arts.values() if a.get("checked_at"))}
        if reasons:
            health["bandsintown"]["errors"] = dict(reasons.most_common())
        if not health["bandsintown"]["ok"]:
            top = reasons.most_common(1)[0][0] if reasons else "failed"
            health["bandsintown"]["error"] = f"{top} on {failed} of {asked} requests" + (" (app_id not issued by Bandsintown? set the BANDSINTOWN_APP_ID secret)" if top == "HTTP 403" else "")
        log.log(logging.WARNING if failed else logging.INFO, "concerts: bandsintown asked for %d of %d due artists (%d failed%s); %d of %d artists checked so far",
                asked, len(due), failed, ": " + ", ".join(f"{r} ×{n}" for r, n in reasons.most_common()) if reasons else "", health["bandsintown"]["checked"], len(played))
    write_json(STATE_PATH, state, compact=True)

    # 3. the list: every show still ahead, within the horizon, one row per show
    events = [ev for a in arts.values() for ev in a.get("events") or []] + list(state["ticketmaster"].get("events") or [])
    events = [ev for ev in events if ev.get("date") and today.isoformat() <= ev["date"] <= horizon]
    events = merge_events(events)
    names = sorted({a for ev in events for a in ev["artists"]}, key=lambda n: -played.get(norm(n), {}).get("plays", 0))

    # 4. the most popular song of every act with a show nearby (cached in the state for good), resolved on YouTube Music
    looked = 0
    for n in names:
        a = arts.setdefault(norm(n), {"name": n, "checked_at": "", "events": [], "top": None})
        row = a.get("top")
        if row and not miss_expired(row):
            continue
        if looked >= int(c["top_tracks_per_run"]) or deadline.expired:
            continue
        looked += 1
        a["top"] = top_track(lastfm, http, n) or miss_row(today)
    http.save()
    write_json(STATE_PATH, state, compact=True)
    items: list[Item] = []
    for n in names:
        row = (arts.get(norm(n)) or {}).get("top")
        if row and row.get("title"):
            it = Item(artist=n, title=row["title"], kind="track", sources=["concerts"], links={"last.fm": row["url"]} if row.get("source") == "lastfm" and row.get("url") else {})
            it.normalize_credit()
            items.append(it)
    if items:
        from .learn import load_ratings, wrong_videos
        from .resolve import resolve_all
        rcfg = {**cfg, "resolve": {**(cfg.get("resolve") or {}), "max_lookups_per_run": int(c["resolve_per_run"]), "audio_heals_per_run": 0, "max_year_lookups_per_run": 0}}
        resolve_all(items, rcfg, Deadline(max(0.5, deadline.remaining_minutes + 3)), avoid=wrong_videos(load_ratings()))
    by_artist = {it.artist_norm: it for it in items}

    artists_out: dict[str, dict] = {}
    for n in names:
        p = played.get(norm(n)) or {}
        row = (arts.get(norm(n)) or {}).get("top") or {}
        it = by_artist.get(norm(n))
        top = None
        if row.get("title"):
            yt = it.youtube if it and it.youtube else None
            top = {"id": item_key(n, row["title"]), "title": (it.display_title if it else row["title"]), "source": row.get("source"), "listeners": row.get("listeners"), "plays": row.get("plays"),
                   "url": row.get("url"), "youtube": {k: yt.get(k) for k in ("videoId", "thumbnail", "album", "playlistId", "year") if yt.get(k)} if yt else None}
        a = arts.get(norm(n)) or {}
        links = {"last.fm": f"https://www.last.fm/music/{quote(n, safe='')}", "songkick": f"https://www.songkick.com/search?query={quote(n, safe='')}&type=artists"}
        if a.get("page"):
            links["bandsintown"] = a["page"]
        artists_out[n] = {"plays": p.get("plays") or 0, "filed": p.get("filed") or 0, "via": p.get("via") or [], "top_track": top, "image": a.get("image"), "links": links}
    public = []
    for ev in events:
        public.append({k: ev.get(k) for k in ("id", "artist", "artists", "lineup", "title", "date", "time", "venue", "city", "region", "country", "lat", "lon", "miles", "tickets", "ticketer", "url", "status", "sources", "price", "image", "festival")}
                      | {"links": {k: u for k, u in (ev.get("links") or {}).items() if safe_url(u)}})
    checked = sum(1 for a in arts.values() if a.get("checked_at"))
    payload = {
        "generated_at": utcnow().isoformat(),
        "center": {"name": center.get("name"), "lat": float(center["lat"]), "lon": float(center["lon"])},
        "radius_miles": radius, "months_ahead": int(c["months_ahead"]),
        "artists_total": len(played), "artists_checked": min(checked, len(played)), "artists_with_shows": len(names),
        "sources": sorted({s for ev in public for s in ev["sources"]}), "health": health,
        "count": len(public), "events": public, "artists": artists_out,
    }
    write_json(CONCERTS_PATH, payload, compact=True)
    log.info("concerts: %d shows within %d miles of %s by %d played artists (%d of %d artists checked); %d top songs looked up this run",
             len(public), radius, center.get("name"), len(names), payload["artists_checked"], len(played), looked)
    return payload
