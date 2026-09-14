"""Upcoming concerts near Detroit by the artists played on Indie Discotheque in the last year.

Songkick used to do this: one page listing every show near you by the acts you listen to. Songkick's API is closed
to new applications, so this draws the same list from what is still open:

  * who was played – Last.fm `user.getTopArtists` for `station.lastfm_user` over the last 12 months (the scrobbles of
    the Indie Discotheque playlists), plus every artist filed into this year's playlist (`concerts.playlist_years`).
    Without a Last.fm key the profile's 12-month artists stand in.
  * where they play – six listings, each switched on by its own key (free, except JamBase) and each reported on its
    own in the health record so a dead one is never mistaken for a quiet one:
      - Bandsintown's artist-events API (an app_id Bandsintown issued, in BANDSINTOWN_APP_ID; `bandsintown.app_id`
        is the fallback), asked artist by artist, a rotating batch a run, kept per artist for `refresh_days`. An
        app_id Bandsintown did not issue is answered 403 — or, just as often, with an empty list for every artist,
        which looks like nobody is touring: a run whose first `empty_probe` answers (the most played artists first)
        list no show anywhere is treated as refused, not as quiet;
      - Ticketmaster's Discovery API (TICKETMASTER_API_KEY): every music event within the radius up to
        `months_ahead`, matched against the same artists — prices, sale status and the venue's picture (Ticketmaster
        stops paging at its 1,000th result, so the horizon is split into date windows small enough to fit);
      - SeatGeek's Platform API (SEATGEEK_CLIENT_ID): every concert within the radius — it lists the clubs that sell
        through DICE, Eventbrite or their own box office, which Ticketmaster never sees;
      - JamBase (JAMBASE_API_KEY, a metered free tier — 1,000 calls a month, then charged — so spent for coverage:
        the horizon in date bands, the near future refreshed often and the far end rarely, a cursor where a run's
        cap interrupts a band, and a ledger of calls a day kept in the state that never lets a trailing 31 days
        pass the quota): the widest venue-calendar aggregator, with the ticket link and its seller;
      - Edmtrain (EDMTRAIN_API_KEY): every electronic show in the configured states, the lineups the dance venues
        post themselves;
      - Resident Advisor (no key; its public GraphQL, the same one ra.co's own pages call): every listing in the
        configured area, with the venue's coordinates and RA's own ticket link.
  * how close – a great-circle distance from `concerts.center` (Detroit); anything past `radius_miles` is dropped.
  * their most popular song – Last.fm `artist.getTopTracks` (Deezer's artist top when there is no key), resolved
    on YouTube Music through the feed's resolver and cache so the card plays it in place.

State lives in data/concerts_state.json (per artist: when it was last asked, its shows within the radius, its top
song; per area source: its last snapshot); the public list is site/data/concerts.json for the Concerts tab. Nothing
here spends YouTube API quota.
"""
from __future__ import annotations

import logging
import math
import os
import re
from collections import Counter
from collections.abc import Callable
from datetime import date, datetime, timedelta
from typing import Any
from urllib.parse import quote, urlparse

from .models import Item
from .profile import LastFm, load_profile
from .util import DATA_DIR, SITE_DATA_DIR, Deadline, Http, item_key, log, miss_expired, miss_row, norm, parse_date, read_json, safe_url, utcnow, write_json

CONCERTS_PATH = SITE_DATA_DIR / "concerts.json"
STATE_PATH = DATA_DIR / "concerts_state.json"
STATE_VERSION = 2               # 1 kept only the Ticketmaster snapshot; 2 keeps one per area source (migrated on load)

BIT_API = "https://rest.bandsintown.com/artists/{name}/events/"
TM_API = "https://app.ticketmaster.com/discovery/v2/events.json"
SG_API = "https://api.seatgeek.com/2/events"
JB_V3 = "https://api.data.jambase.com/v3"
JB_V1 = "https://www.jambase.com/jb-api/v1"
EDMTRAIN_API = "https://edmtrain.com/api/events"
RA_API = "https://ra.co/graphql"
DEEZER_API = "https://api.deezer.com"
TM_DEEP_PAGING_LIMIT = 1000     # Ticketmaster refuses page × size beyond this: a date window holding more is split
TM_MIN_WINDOW = timedelta(hours=1)   # a window this short is not split further, whatever it holds
TM_TIME = "%Y-%m-%dT%H:%M:%SZ"  # the only datetime format Ticketmaster's Discovery API accepts (UTC, no fraction)
BIT_EMPTY_PROBE = 25            # this many straight empty answers for the most played artists = a refusal, not quiet artists
EARTH_RADIUS_MILES = 3958.7613
SONGS_RESERVE_MINUTES = 5       # the artist loop leaves this much of the time budget for the top songs and their videos
CANADA = {"ontario", "quebec", "british columbia", "alberta", "manitoba", "saskatchewan", "nova scotia", "new brunswick", "newfoundland and labrador", "prince edward island", "on", "qc", "bc", "ab", "mb", "sk", "ns", "nb", "nl", "pe"}

# The area sources (everything within the radius, matched against the played artists), in the order a show found
# by several of them takes its bill, its ticket link and its details from: the listing the venue or promoter posted
# leads, the resellers and aggregators fill in what it lacks.
SOURCE_ORDER = ("bandsintown", "resident_advisor", "jambase", "edmtrain", "ticketmaster", "seatgeek")
SOURCE_NAMES = {"bandsintown": "Bandsintown", "ticketmaster": "Ticketmaster", "seatgeek": "SeatGeek", "jambase": "JamBase", "edmtrain": "Edmtrain", "resident_advisor": "Resident Advisor"}

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
    "bandsintown": {"enabled": True, "app_id": "chrisrohn.com", "give_up_after": 10, "empty_probe": BIT_EMPTY_PROBE},   # BANDSINTOWN_APP_ID overrides app_id
    "ticketmaster": {"enabled": True, "size": 200, "requests_per_run": 60},   # needs TICKETMASTER_API_KEY (free)
    "seatgeek": {"enabled": True, "per_page": 100, "requests_per_run": 40, "taxonomies": ["concert", "music_festival"]},   # needs SEATGEEK_CLIENT_ID (free)
    # JAMBASE_API_KEY: the free tier is metered (1,000 calls a month, 3,600 an hour, then 5¢ a call), so held to
    # `monthly_quota - quota_reserve` calls in any trailing 31 days by a ledger in the state, the snapshot reused for `refresh_days`
    "jambase": {"enabled": True, "base_url": JB_V3, "auth": "bearer", "per_page": 100, "requests_per_run": 40, "monthly_quota": 1000, "quota_reserve": 100,   # v1: base_url JB_V1, auth "query"
                "bands": [{"days": 45, "refresh_days": 2}, {"days": 120, "refresh_days": 5}, {"days": 365, "refresh_days": 10}]},   # the horizon in date bands, the near future refreshed most
    "edmtrain": {"enabled": True, "states": ["Michigan", "Ohio", "Ontario"], "other_genres": True},   # needs EDMTRAIN_API_KEY (free)
    "resident_advisor": {"enabled": True, "area": {"country": "us", "city": "detroit"}, "area_id": None, "page_size": 100, "requests_per_run": 30,
                         "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0"},   # no key: ra.co's public GraphQL answers a browser
}


def _cfg(cfg: dict) -> dict:
    raw = cfg.get("concerts") or {}
    c = {**DEFAULTS, **raw}
    for k in ("center", "bandsintown", "ticketmaster", "seatgeek", "jambase", "edmtrain", "resident_advisor"):
        c[k] = {**DEFAULTS[k], **(raw.get(k) or {})}
    c["resident_advisor"]["area"] = {**DEFAULTS["resident_advisor"]["area"], **((raw.get("resident_advisor") or {}).get("area") or {})}
    return c


# Who sells the tickets, by the link's host. TicketWeb (Ticketmaster's club-sized arm) and AXS have no public API of
# their own, but Bandsintown's, JamBase's and Edmtrain's offer links go to whichever of these the venue uses, so the
# button can say which.
TICKETERS = (("ticketmaster.", "Ticketmaster"), ("ticketweb.", "TicketWeb"), ("axs.com", "AXS"), ("etix.com", "Etix"), ("dice.fm", "DICE"), ("eventbrite.", "Eventbrite"),
             ("seetickets.", "See Tickets"), ("universe.com", "Universe"), ("frontgatetickets.", "Front Gate"), ("showclix.", "ShowClix"), ("tixr.com", "Tixr"), ("ticketon.", "Ticketon"),
             ("prekindle.", "Prekindle"), ("livenation.", "Live Nation"), ("stubhub.", "StubHub"), ("seatgeek.", "SeatGeek"), ("songkick.com", "Songkick"), ("bandsintown.com", "Bandsintown"),
             ("ticketalternative.", "Ticket Alternative"), ("freshtix.", "Freshtix"), ("eventim.", "Eventim"), ("ticketspice.", "TicketSpice"), ("ticketleap.", "TicketLeap"),
             ("ra.co", "Resident Advisor"), ("residentadvisor.", "Resident Advisor"), ("posh.vip", "Posh"), ("shotgun.live", "Shotgun"), ("tickettailor.", "Ticket Tailor"),
             ("humanitix.", "Humanitix"), ("bigtickets.", "Big Tickets"), ("ticketfly.", "Ticketfly"), ("edmtrain.com", "Edmtrain"), ("jambase.com", "JamBase"), ("vivenu.", "vivenu"),
             ("restless.", "Restless"), ("fixr.", "FIXR"), ("skiddle.", "Skiddle"), ("wegottickets.", "WeGotTickets"), ("brownpapertickets.", "Brown Paper Tickets"))


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


def _time_of(s: Any) -> str | None:
    """"21:00" out of "2026-11-07T21:00:00", "21:00:00" or "9:00 PM"; None when there is no clock in it."""
    text = str(s or "")
    m = re.search(r"(?:T|^|\s)(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*([AaPp])[Mm]?)?", text)
    if not m:
        return None
    h, mi = int(m.group(1)), m.group(2)
    if m.group(3):
        h = h % 12 + (12 if m.group(3).lower() == "p" else 0)
    return f"{h:02d}:{mi}" if 0 <= h < 24 else None


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


# A billing qualifier after the act's name — "Amtrac [Live]", "Kevin Saunderson (DJ set)", "Jungle - Live" — is
# the promoter's, not the artist's: the name is matched with and without it. "Amtrac & The Juan Maclean" stays a
# bill of its own (a played entry can be exactly that), so only the bracketed or dashed tail is peeled.
_QUALIFIER_RE = re.compile(r"\s*(?:[\(\[](?:live|live set|dj set|dj|hybrid set|hybrid|solo|band|full band|acoustic|a\/v|av set|extended set|all night long|open to close|b2b[^\)\]]*)[\)\]]|[-–—]\s*(?:live|dj set|hybrid set))\s*$", re.I)


def bill_names(names: list[str]) -> list[str]:
    """Each billed name as written and, when it carries a qualifier, without it."""
    out: list[str] = []
    for n in names:
        s = str(n or "").strip()
        if not s:
            continue
        out.append(s)
        bare = _QUALIFIER_RE.sub("", s).strip()
        if bare and bare != s:
            out.append(bare)
    return out


def matched_artists(names: list[str], played: dict[str, dict]) -> list[str]:
    """Which of the profile's played artists are on a bill, the most played first (norm equality only: "Jungle"
    never matches "Jungle Brothers"; "Amtrac [Live]" does match "Amtrac")."""
    hits = {norm(n) for n in bill_names(names)} & set(played)
    return [played[k]["name"] for k in sorted(hits, key=lambda k: (-played[k]["plays"], -played[k]["filed"]))]


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


def bandsintown_events(http: Http, name: str, app_id: str, reasons: Counter | None = None, answers: Counter | None = None) -> list[dict] | None:
    """The artist's upcoming shows, as Bandsintown lists them; [] when it does not know the act, None when the
    request failed (the old listing is then kept and the artist asked again next run; `reasons`, when given,
    counts why — Bandsintown answers 403 to an app_id it did not issue, and that must not stay a debug line).
    `answers`, when given, tallies what a successful request said ("listed", "empty", "not found", or the message
    Bandsintown sent instead of a list) so a run of empty answers can be told from a run of unknown artists."""
    def tally(what: str) -> None:
        if answers is not None:
            answers[what] += 1
    try:
        data = http.get(BIT_API.format(name=bit_name(name)), params={"app_id": app_id, "date": "upcoming"}, cache=False, retries=1, timeout=20)
    except Exception as exc:  # noqa: BLE001
        if "404" in str(exc):
            tally("not found")
            return []
        if reasons is not None:
            reasons[failure_reason(exc)] += 1
        log.debug("bandsintown %s: %s", name, exc)
        return None
    if isinstance(data, dict):
        msg = data.get("errorMessage") or data.get("Message") or data.get("message") or data.get("warning")
        if msg:
            text = str(msg)
            tally("not found" if "notfound" in text.replace(" ", "").lower() else f"message: {text[:80]}")
            return []
        if reasons is not None:
            reasons["unexpected object"] += 1
        return None
    evs = [e for e in (data or []) if isinstance(e, dict)]
    tally("listed" if evs else "empty")
    return evs


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
    price = {"min": prices[0].get("min"), "max": prices[0].get("max"), "currency": prices[0].get("currency"), "source": "ticketmaster"} if prices else None
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


# ---------- SeatGeek ----------

def seatgeek_events(http: Http, client_id: str, center: dict, radius: float, *, start: datetime, end: datetime, per_page: int = 100,
                    max_requests: int = 40, taxonomies: list[str] | None = None) -> list[dict]:
    """Every concert (and music festival) SeatGeek lists within the radius between `start` and `end`, soonest
    first, each once by id: `taxonomies.name` one at a time, paged until `meta.total` is exhausted or the request
    budget is spent. Raises on a failed request so the caller can keep the last snapshot."""
    out: dict[str, dict] = {}
    spent = 0
    for tax in taxonomies or ["concert"]:
        page = 1
        while True:
            if spent >= max(1, int(max_requests)):
                log.warning("concerts: seatgeek request budget (%d) spent; the list stops at page %d of %s", spent, page, tax)
                return list(out.values())
            params = {"client_id": client_id, "lat": str(center["lat"]), "lon": str(center["lon"]), "range": f"{int(radius)}mi", "taxonomies.name": tax,
                      "datetime_utc.gte": start.strftime("%Y-%m-%dT%H:%M:%S"), "datetime_utc.lte": end.strftime("%Y-%m-%dT%H:%M:%S"),
                      "per_page": str(per_page), "page": str(page), "sort": "datetime_utc.asc"}
            data = http.get(SG_API, params=params, cache=False, timeout=30)
            spent += 1
            evs = [e for e in ((data or {}).get("events") or []) if isinstance(e, dict)]
            for e in evs:
                out[str(e.get("id") or f"{tax}/{page}/{len(out)}")] = e
            total = int(((data or {}).get("meta") or {}).get("total") or 0)
            if not evs or page * per_page >= total:
                break
            page += 1
    log.info("concerts: seatgeek asked %d request(s)", spent)
    return list(out.values())


def shape_seatgeek(ev: dict) -> dict:
    v = ev.get("venue") or {}
    loc = v.get("location") or {}
    performers = [p for p in (ev.get("performers") or []) if isinstance(p, dict) and p.get("name")]
    lineup = [str(p["name"]) for p in sorted(performers, key=lambda p: (not p.get("primary"), performers.index(p)))]
    when = str(ev.get("datetime_local") or "")
    d = parse_date(when)
    stats = ev.get("stats") or {}
    low = _float(stats.get("lowest_price"))
    price = {"min": low, "max": _float(stats.get("highest_price")), "currency": "USD", "source": "seatgeek"} if low else None
    status = str(ev.get("status") or "").lower()
    image = next((safe_url(p.get("image")) for p in performers if safe_url(p.get("image"))), None)
    url = safe_url(ev.get("url"))
    return {
        "id": f"sg:{ev.get('id')}", "artist": lineup[0] if lineup else (ev.get("short_title") or ev.get("title") or ""), "lineup": lineup, "title": (ev.get("short_title") or ev.get("title") or "").strip() or None,
        "date": d.isoformat() if d else None, "time": None if ev.get("time_tbd") else _time_of(when),
        "venue": (v.get("name") or "").strip(), "city": (v.get("city") or "").strip(), "region": (v.get("state") or "").strip(), "country": (v.get("country") or "").strip(),
        "lat": _float(loc.get("lat")), "lon": _float(loc.get("lon")),
        "tickets": url, "ticketer": "SeatGeek" if url else None, "url": url, "status": status if status and status != "normal" else None,
        "sources": ["seatgeek"], "links": {"seatgeek": url} if url else {},
        "price": price, "image": image, "festival": any(str(t.get("name") or "").lower() == "music_festival" for t in (ev.get("taxonomies") or []) if isinstance(t, dict)),
    }


# ---------- JamBase ----------

QUOTA_WINDOW_DAYS = 31   # a cap over any trailing 31 days bounds every calendar month and every anniversary month
QUOTA_KEEP_DAYS = 45


class CallQuota:
    """A ledger of calls a day, kept in the state file (so it survives every run, scheduled or by hand), for an
    API that meters a monthly quota and charges past it: never more than `quota - reserve` calls in any trailing
    QUOTA_WINDOW_DAYS days. Every attempt counts, retries included, and it is counted before the request goes out,
    so a crash mid-run never loses one."""

    def __init__(self, row: dict, *, quota: int, reserve: int = 0, today: date | None = None):
        self.row = row
        self.quota, self.reserve = max(0, int(quota)), max(0, int(reserve))
        self.today = today or date.today()
        days = row.get("days") if isinstance(row.get("days"), dict) else {}
        floor = (self.today - timedelta(days=QUOTA_KEEP_DAYS)).isoformat()
        row["days"] = {d: int(n) for d, n in days.items() if d >= floor and int(n or 0) > 0}
        self.spent = 0   # this run

    @property
    def used(self) -> int:
        """Calls in the trailing window, today included."""
        floor = (self.today - timedelta(days=QUOTA_WINDOW_DAYS - 1)).isoformat()
        return sum(n for d, n in self.row["days"].items() if d >= floor)

    @property
    def remaining(self) -> int:
        return max(0, self.quota - self.reserve - self.used)

    def spend(self) -> bool:
        """Record one call about to be made; False (and nothing recorded) when the window is full."""
        if self.remaining <= 0:
            return False
        k = self.today.isoformat()
        self.row["days"][k] = self.row["days"].get(k, 0) + 1
        self.spent += 1
        return True

    def health(self) -> dict:
        return {"calls": self.spent, "used": self.used, "window_days": QUOTA_WINDOW_DAYS, "quota": self.quota, "reserve": self.reserve, "remaining": self.remaining}


def jambase_events(http: Http, key: str, center: dict, radius: float, *, start: date, end: date, base_url: str = JB_V3, auth: str = "bearer",
                   per_page: int = 100, max_requests: int = 40, quota: CallQuota | None = None, info: dict | None = None) -> list[dict]:
    """Every concert and festival JamBase lists within the radius between `start` and `end` (both inclusive), each
    once by identifier, the soonest first. `auth` is "bearer" for the v3 API (the key in the Authorization header)
    or "query" for the v1 API (`apikey` in the query string); the parameters are the same on both. Every request is
    one call against `quota` (the free tier is metered and charged past it): no retries, and the paging stops
    where the run's cap or the quota's window says. `info`, when given, is filled with how it went: "calls",
    "pages" (JamBase's count for the window), "total" (its events), "complete" (every page fetched). Raises on a
    failed request."""
    out: dict[str, dict] = {}
    page, spent = 1, 0
    if info is not None:
        info.update({"calls": 0, "pages": None, "total": None, "complete": False})
    headers = {"Authorization": f"Bearer {key}"} if auth == "bearer" else None
    while True:
        if spent >= max(1, int(max_requests)):
            log.warning("concerts: jambase request budget (%d) spent; the list stops at page %d", spent, page)
            break
        if quota is not None and not quota.spend():
            log.warning("concerts: jambase monthly quota reached (%d of %d calls in the last %d days, %d held back); the list stops at page %d",
                        quota.used, quota.quota, QUOTA_WINDOW_DAYS, quota.reserve, page)
            if spent == 0:
                raise RuntimeError(f"monthly quota reached: {quota.used} of {quota.quota} calls in the last {QUOTA_WINDOW_DAYS} days ({quota.reserve} held back)")
            break
        params = {"geoLatitude": str(center["lat"]), "geoLongitude": str(center["lon"]), "geoRadiusAmount": str(int(radius)), "geoRadiusUnits": "mi",
                  "eventDateFrom": start.isoformat(), "eventDateTo": end.isoformat(), "perPage": str(per_page), "page": str(page)}
        if auth != "bearer":
            params["apikey"] = key
        spent += 1
        if info is not None:
            info["calls"] = spent
        data = http.get(f"{base_url.rstrip('/')}/events", params=params, headers=headers, cache=False, retries=0, timeout=30)
        if isinstance(data, dict) and data.get("success") is False:
            raise RuntimeError(str(data.get("errors") or data.get("error") or data.get("message") or "request refused")[:200])
        evs = [e for e in ((data or {}).get("events") or []) if isinstance(e, dict)]
        for e in evs:
            out[str(e.get("identifier") or e.get("url") or f"{page}/{len(out)}")] = e
        pg = (data or {}).get("pagination") or {}
        if info is not None:
            info["pages"], info["total"] = int(pg.get("totalPages") or 0), int(pg.get("totalItems") or 0)
        if not evs or page >= int(pg.get("totalPages") or 0) or not pg.get("nextPage"):
            if info is not None:
                info["complete"] = True
            break
        page += 1
    log.info("concerts: jambase asked %d request(s) for %s..%s", spent, start.isoformat(), end.isoformat())
    return list(out.values())


def jambase_bands(cfg: dict, today: date, horizon_days: int) -> list[dict]:
    """The horizon as date bands, [{"from", "to", "refresh_days"}], both dates inclusive and back to back, from
    `jambase.bands` ({"days": how far from today the band reaches, "refresh_days": how old its snapshot may get);
    the last band is clipped to `horizon_days`. The near future changes most (announcements, cancellations, sold
    out), so it is refreshed often and cheaply; the far end, most of the events, rarely."""
    out: list[dict] = []
    start, last = today, today + timedelta(days=int(horizon_days))
    for b in cfg.get("bands") or []:
        if not isinstance(b, dict):
            continue
        end = min(today + timedelta(days=max(0, int(b.get("days") or 0))), last)
        if end < start:
            continue
        out.append({"from": start.isoformat(), "to": end.isoformat(), "refresh_days": max(0.0, float(b.get("refresh_days") or 0))})
        start = end + timedelta(days=1)
        if start > last:
            break
    if start <= last:
        out.append({"from": start.isoformat(), "to": last.isoformat(), "refresh_days": float((cfg.get("bands") or [{}])[-1].get("refresh_days") or 2) if isinstance((cfg.get("bands") or [{}])[-1], dict) else 2.0})
    return out


def _region_of(v: Any) -> str:
    """A schema.org addressRegion as JamBase writes it: a string ("MI"), or an object with a short name."""
    if isinstance(v, dict):
        return str(v.get("alternateName") or (str(v.get("identifier") or "").split("-")[-1]) or v.get("name") or "").strip()
    return str(v or "").strip()


def _country_of(v: Any) -> str:
    if isinstance(v, dict):
        return str(v.get("name") or v.get("identifier") or "").strip()
    return str(v or "").strip()


def shape_jambase(ev: dict) -> dict:
    loc = ev.get("location") or {}
    addr = loc.get("address") or {}
    geo = loc.get("geo") or {}
    performers = [p for p in (ev.get("performer") or []) if isinstance(p, dict) and p.get("name")]
    performers.sort(key=lambda p: (not p.get("x-isHeadliner"), int(p.get("x-performanceRank") or 99)))
    lineup = [str(p["name"]) for p in performers]
    offers = [o for o in (ev.get("offers") or []) if isinstance(o, dict) and safe_url(o.get("url"))]
    tickets = safe_url(offers[0]["url"]) if offers else None
    seller = str(((offers[0].get("seller") or {}) if offers else {}).get("name") or "").strip() or None
    prices = [_float(o.get("price")) for o in offers if _float(o.get("price"))]
    price = {"min": min(prices), "max": max(prices) if len(prices) > 1 else None, "currency": str(offers[0].get("priceCurrency") or "USD"), "source": "jambase"} if prices else None
    when = str(ev.get("startDate") or "")
    d = parse_date(when)
    status = str(ev.get("eventStatus") or "").lower()
    url = safe_url(ev.get("url"))
    return {
        "id": f"jb:{ev.get('identifier') or url}", "artist": lineup[0] if lineup else (ev.get("name") or ""), "lineup": lineup, "title": (ev.get("name") or "").strip() or None,
        "date": d.isoformat() if d else None, "time": _time_of(when),
        "venue": (loc.get("name") or "").strip(), "city": (addr.get("addressLocality") or "").strip(), "region": _region_of(addr.get("addressRegion")), "country": _country_of(addr.get("addressCountry")),
        "lat": _float(geo.get("latitude")), "lon": _float(geo.get("longitude")),
        "tickets": tickets, "ticketer": ticketer_of(tickets) or seller, "url": url, "status": status if status and status != "scheduled" else None,
        "sources": ["jambase"], "links": {"jambase": url} if url else {},
        "price": price, "image": safe_url(ev.get("image")), "festival": str(ev.get("@type") or "").lower() == "festival",
    }


# ---------- Edmtrain ----------

def edmtrain_events(http: Http, key: str, states: list[str], *, start: date, end: date, other_genres: bool = True) -> list[dict]:
    """Every show Edmtrain lists in each state between `start` and `end` (live streams left out), each once by id.
    Edmtrain answers a whole state at a time, so the radius is applied afterwards. Raises when every state failed;
    a state that failed while another answered is logged and skipped."""
    out: dict[str, dict] = {}
    failed: list[str] = []
    for st in states:
        params = {"client": key, "state": st, "startDate": start.isoformat(), "endDate": end.isoformat(), "livestreamInd": "false"}
        if not other_genres:
            params["includeOtherGenreInd"] = "false"
        try:
            data = http.get(EDMTRAIN_API, params=params, cache=False, timeout=30)
        except Exception as exc:  # noqa: BLE001
            failed.append(f"{st}: {failure_reason(exc)}")
            continue
        if not isinstance(data, dict) or data.get("success") is False:
            failed.append(f"{st}: {str((data or {}).get('message') if isinstance(data, dict) else data)[:80]}")
            continue
        for e in data.get("data") or []:
            if isinstance(e, dict) and not e.get("livestreamInd"):
                out[str(e.get("id") or f"{st}/{len(out)}")] = e
    if failed and len(failed) == len(states):
        raise RuntimeError("; ".join(failed)[:200])
    if failed:
        log.warning("concerts: edmtrain answered for %d of %d states (%s)", len(states) - len(failed), len(states), "; ".join(failed))
    return list(out.values())


def shape_edmtrain(ev: dict) -> dict:
    v = ev.get("venue") or {}
    lineup = [str(a.get("name")) for a in (ev.get("artistList") or []) if isinstance(a, dict) and a.get("name")]
    place = str(v.get("location") or "")
    city, _, region = place.partition(",")
    region = region.strip() or str(v.get("state") or "")
    d = parse_date(str(ev.get("date") or ""))
    tickets = safe_url(ev.get("ticketLink"))
    url = safe_url(ev.get("link"))
    return {
        "id": f"edm:{ev.get('id')}", "artist": lineup[0] if lineup else (ev.get("name") or ""), "lineup": lineup, "title": (ev.get("name") or "").strip() or None,
        "date": d.isoformat() if d else None, "time": _time_of(ev.get("startTime")),
        "venue": (v.get("name") or "").strip(), "city": city.strip(), "region": region, "country": "Canada" if str(v.get("state") or region).strip().lower() in CANADA else "United States",
        "lat": _float(v.get("latitude")), "lon": _float(v.get("longitude")),
        "tickets": tickets, "ticketer": ticketer_of(tickets), "url": url or tickets, "status": None,
        "sources": ["edmtrain"], "links": {"edmtrain": url} if url else {},
        "price": None, "image": None, "festival": bool(ev.get("festivalInd")),
    }


# ---------- Resident Advisor ----------

RA_AREA_QUERY = """query GET_AREA($areaUrlName: String, $countryUrlCode: String) {
  area(areaUrlName: $areaUrlName, countryUrlCode: $countryUrlCode) { id name urlName ianaTimeZone country { name urlCode } }
}"""
RA_LISTINGS_QUERY = """query GET_EVENT_LISTINGS($filters: FilterInputDtoInput, $page: Int, $pageSize: Int) {
  eventListings(filters: $filters, pageSize: $pageSize, page: $page) {
    data { id listingDate event {
      id title date startTime endTime contentUrl flyerFront isTicketed isFestival
      venue { id name address contentUrl area { name country { name } } location { latitude longitude } }
      artists { id name }
    } }
    totalResults
  }
}"""


def _ra_headers(cfg: dict, referer: str) -> dict:
    return {"Content-Type": "application/json", "Accept": "application/json", "Origin": "https://ra.co", "Referer": referer, "User-Agent": str(cfg.get("user_agent") or DEFAULTS["resident_advisor"]["user_agent"])}


def _ra_post(http: Http, cfg: dict, referer: str, body: dict) -> dict:
    data = http.post(RA_API, json_body=body, headers=_ra_headers(cfg, referer), cache=False, retries=1, timeout=30)
    if not isinstance(data, dict):
        raise RuntimeError("resident advisor answered something other than JSON")
    if data.get("errors"):
        raise RuntimeError("; ".join(str((e or {}).get("message") or e) for e in data["errors"][:3])[:200])
    return data.get("data") or {}


def ra_area(http: Http, cfg: dict) -> dict | None:
    """RA's area for the configured country and city URL names ({"id", "name"}), or None when RA has no such area."""
    area = cfg.get("area") or {}
    country, city = str(area.get("country") or "us").lower(), str(area.get("city") or "").lower()
    if not city:
        return None
    data = _ra_post(http, cfg, f"https://ra.co/events/{country}/{city}", {"operationName": "GET_AREA", "variables": {"areaUrlName": city, "countryUrlCode": country}, "query": RA_AREA_QUERY})
    a = data.get("area") or {}
    return {"id": str(a["id"]), "name": str(a.get("name") or city), "country": country, "city": city} if a.get("id") else None


def ra_events(http: Http, cfg: dict, area_id: str, *, start: date, end: date, page_size: int = 100, max_requests: int = 30) -> list[dict]:
    """Every listing RA has for the area between `start` and `end`, each once by event id, from the same GraphQL
    ra.co's own event pages call (no key). Raises on a failed request or a GraphQL error."""
    out: dict[str, dict] = {}
    referer = f"https://ra.co/events/{str((cfg.get('area') or {}).get('country') or 'us').lower()}/{str((cfg.get('area') or {}).get('city') or '').lower()}"
    page, spent = 1, 0
    while True:
        if spent >= max(1, int(max_requests)):
            log.warning("concerts: resident advisor request budget (%d) spent; the list stops at page %d", spent, page)
            break
        body = {"operationName": "GET_EVENT_LISTINGS", "query": RA_LISTINGS_QUERY,
                "variables": {"filters": {"areas": {"eq": int(area_id) if str(area_id).isdigit() else area_id}, "listingDate": {"gte": f"{start.isoformat()}T00:00:00.000Z", "lte": f"{end.isoformat()}T23:59:59.000Z"}},
                              "pageSize": int(page_size), "page": page}}
        data = _ra_post(http, cfg, referer, body)
        spent += 1
        listings = (data.get("eventListings") or {}).get("data") or []
        evs = [(row.get("event") or {}) for row in listings if isinstance(row, dict) and isinstance(row.get("event"), dict)]
        for e in evs:
            out[str(e.get("id") or f"{page}/{len(out)}")] = e
        total = int((data.get("eventListings") or {}).get("totalResults") or 0)
        if not evs or page * int(page_size) >= total:
            break
        page += 1
    log.info("concerts: resident advisor asked %d request(s)", spent)
    return list(out.values())


def shape_ra(ev: dict) -> dict:
    v = ev.get("venue") or {}
    loc = v.get("location") or {}
    area = v.get("area") or {}
    lineup = [str(a.get("name")) for a in (ev.get("artists") or []) if isinstance(a, dict) and a.get("name")]
    d = parse_date(str(ev.get("date") or ""))
    path = str(ev.get("contentUrl") or "")
    url = safe_url(f"https://ra.co{path}") if path.startswith("/") else safe_url(path)
    address = str(v.get("address") or "")
    city = str(area.get("name") or "")
    m = re.search(r",\s*([^,]+?)\s*,?\s*([A-Z]{2})\b", address)   # "1331 Holden St, Detroit, MI 48202"
    region = m.group(2) if m else ""
    if m and m.group(1):
        city = m.group(1).strip() or city
    return {
        "id": f"ra:{ev.get('id')}", "artist": lineup[0] if lineup else (ev.get("title") or ""), "lineup": lineup, "title": (ev.get("title") or "").strip() or None,
        "date": d.isoformat() if d else None, "time": _time_of(ev.get("startTime")),
        "venue": (v.get("name") or "").strip(), "city": city, "region": region, "country": str((area.get("country") or {}).get("name") or ""),
        "lat": _float(loc.get("latitude")), "lon": _float(loc.get("longitude")),
        "tickets": url if ev.get("isTicketed") else None, "ticketer": "Resident Advisor" if ev.get("isTicketed") and url else None, "url": url, "status": None,
        "sources": ["resident_advisor"], "links": {"resident advisor": url} if url else {},
        "price": None, "image": safe_url(ev.get("flyerFront")), "festival": bool(ev.get("isFestival")),
    }


# ---------- merging ----------

def _rank(ev: dict) -> int:
    return min((SOURCE_ORDER.index(s) for s in ev.get("sources") or [] if s in SOURCE_ORDER), default=len(SOURCE_ORDER))


def merge_events(events: list[dict], played: dict[str, dict] | None = None) -> list[dict]:
    """One row per show: the same source id folds together (two artists on one Bandsintown bill), and the same
    headliner on the same date across sources is one show with every link. The listing highest in SOURCE_ORDER
    leads (its bill is the promoter's own); the others add the ticket link, price, status, picture and venue
    details it lacks. With `played`, each row's headliner is the most played artist on it, whichever source
    found it first."""
    by_id: dict[str, dict] = {}
    for ev in events:
        cur = by_id.get(ev["id"])
        if cur is None:
            by_id[ev["id"]] = {**ev, "artists": list(ev.get("artists") or [ev["artist"]])}
            continue
        for a in ev.get("artists") or [ev["artist"]]:
            if a not in cur["artists"]:
                cur["artists"].append(a)
    if played:
        for ev in by_id.values():
            ev["artists"].sort(key=lambda a: (-(played.get(norm(a)) or {}).get("plays", 0), -(played.get(norm(a)) or {}).get("filed", 0)))
            ev["artist"] = ev["artists"][0]
    groups: dict[tuple[str, str], list[dict]] = {}
    for ev in by_id.values():
        groups.setdefault((norm(ev["artist"]), ev.get("date") or ""), []).append(ev)
    out = []
    for rows in groups.values():
        rows.sort(key=_rank)
        base = rows[0]
        for other in rows[1:]:
            base["sources"] = sorted(set(base["sources"]) | set(other["sources"]))
            base["links"] = {**(base.get("links") or {}), **(other.get("links") or {})}
            if not base.get("tickets") and other.get("tickets"):
                base["tickets"], base["ticketer"] = other["tickets"], other.get("ticketer")
            for k in ("url", "price", "image", "status", "time", "venue", "city", "region", "country", "title"):
                if not base.get(k) and other.get(k):
                    base[k] = other[k]
            base["festival"] = bool(base.get("festival") or other.get("festival"))
            for a in other.get("artists") or []:
                if a not in base["artists"]:
                    base["artists"].append(a)
            for a in other.get("lineup") or []:
                if a not in base["lineup"]:
                    base["lineup"].append(a)
        out.append(base)
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
    if not isinstance(st, dict) or st.get("v") not in (1, STATE_VERSION):
        return {"v": STATE_VERSION, "artists": {}, "sources": {}}
    st.setdefault("artists", {})
    st.setdefault("sources", {})
    if st.get("v") == 1:   # the Ticketmaster snapshot moves in with the other area sources
        tm = st.pop("ticketmaster", None)
        if isinstance(tm, dict):
            st["sources"]["ticketmaster"] = tm
        st["v"] = STATE_VERSION
    return st


def _matched_rows(raw: list[dict], shape: Callable[[dict], dict], center: dict, radius: float, played: dict[str, dict]) -> list[dict]:
    """The events within the radius that a played artist is on, shaped for the tab, the most played act leading."""
    shaped = []
    for ev in raw:
        s = within(shape(ev), center, radius)
        if not s or not s.get("date"):
            continue
        hits = matched_artists(s["lineup"] or [s["artist"]], played)
        if hits:
            shaped.append({**s, "artist": hits[0], "artists": hits})
    return shaped


def _area_source(state: dict, health: dict, name: str, *, center: dict, radius: float, played: dict[str, dict], fetch: Callable[[], list[dict]],
                 shape: Callable[[dict], dict], missing: str | None = None) -> None:
    """Run one area source (everything within the radius, matched against the played artists) into the state's
    snapshot and the health record. `missing` names the key it lacks: the snapshot is emptied and the health says
    so. A failed request keeps the last snapshot and says why; a successful one replaces it."""
    snap = state["sources"].get(name) or {"fetched_at": None, "events": []}
    if missing:
        health[name] = {"ok": False, "error": missing, "matched": 0}
        state["sources"][name] = {"fetched_at": None, "events": []}
        return
    try:
        raw = fetch()
    except Exception as exc:  # noqa: BLE001
        health[name] = {"ok": False, "error": str(exc)[:200], "matched": len(snap.get("events") or [])}
        state["sources"][name] = snap
        log.warning("concerts: %s failed (%s); keeping the last snapshot", name, exc)
        return
    shaped = _matched_rows(raw, shape, center, radius, played)
    state["sources"][name] = {"fetched_at": utcnow().isoformat(), "events": shaped, "listed": len(raw)}
    health[name] = {"ok": True, "events": len(raw), "matched": len(shaped)}
    log.info("concerts: %s lists %d events within %d miles, %d by played artists", name, len(raw), radius, len(shaped))


def _jambase_source(state: dict, health: dict, jcfg: dict, key: str | None, http: Http, quota: CallQuota, *, center: dict, radius: float, played: dict[str, dict],
                    today: date, horizon_days: int) -> None:
    """JamBase, spent smartly: the horizon in date bands (`jambase_bands`), each with its own snapshot and cadence,
    the nearest first; a run touches only the bands that are due, within `requests_per_run` and the quota ledger.
    A band the cap interrupts keeps a date cursor and continues from it next run, its older rows kept meanwhile, so
    a small cap still walks the whole year; a fetched band's rows replace only the dates it covered. The source's
    snapshot is the union of the bands, and the health row lists them (from, to, fetched, listed, calls, whether
    complete) with the ledger's numbers and the calls a month the cadences add up to."""
    src = state["sources"].get("jambase") or {}
    if not key:
        health["jambase"] = {"ok": False, "error": "JAMBASE_API_KEY not set", "matched": 0}
        state["sources"]["jambase"] = {"fetched_at": None, "events": []}
        return
    now = utcnow()
    spans = jambase_bands(jcfg, today, horizon_days)
    bands: dict[str, dict] = {k: v for k, v in (src.get("bands") or {}).items() if isinstance(v, dict)}
    budget = max(1, int(jcfg.get("requests_per_run", 40)))
    errors: list[str] = []
    for i, span in enumerate(spans):
        k = str(i)
        b = bands.setdefault(k, {})
        lo, hi = date.fromisoformat(span["from"]), date.fromisoformat(span["to"])
        b["events"] = [e for e in (b.get("events") or []) if span["from"] <= (e.get("date") or "") <= span["to"]]   # the band's edges move a day at a time: rows outside it go
        fresh = bool(b.get("complete")) and (b.get("fetched_at") or "") > (now - timedelta(days=span["refresh_days"])).isoformat()
        b.update({"from": span["from"], "to": span["to"], "refresh_days": span["refresh_days"]})
        if fresh:
            b["calls"] = 0
            continue
        if budget <= 0 or quota.remaining <= 0:
            b["calls"] = 0
            b["deferred"] = "request budget spent" if budget <= 0 else "monthly quota reached"
            continue
        b.pop("deferred", None)
        cursor = b.get("cursor")
        start = max(lo, date.fromisoformat(cursor)) if cursor and span["from"] <= cursor <= span["to"] and not b.get("complete") else lo
        info: dict = {}
        try:
            raw = jambase_events(http, key, center, radius, start=start, end=hi, base_url=str(jcfg.get("base_url") or JB_V3), auth=str(jcfg.get("auth") or "bearer"),
                                 per_page=int(jcfg.get("per_page", 100)), max_requests=budget, quota=quota, info=info)
        except Exception as exc:  # noqa: BLE001
            budget -= int(info.get("calls") or 0)
            b.update({"calls": int(info.get("calls") or 0), "error": str(exc)[:200]})
            errors.append(f"{span['from']}..{span['to']}: {str(exc)[:120]}")
            log.warning("concerts: jambase %s..%s failed (%s); keeping its rows", span["from"], span["to"], exc)
            continue
        b.pop("error", None)
        budget -= int(info.get("calls") or 0)
        shaped = _matched_rows(raw, shape_jambase, center, radius, played)
        dates = sorted(str(parse_date(str(e.get("startDate") or "")) or "") for e in raw)
        reached = dates[-1] if dates and dates[-1] else None
        kept_before = [e for e in b["events"] if (e.get("date") or "") < start.isoformat()]
        calls = int(info.get("calls") or 0)
        cycle_calls = calls + (int(b.get("cycle_calls") or 0) if start != lo else 0)     # what this pass over the band has cost so far
        listed = len(raw) + (int(b.get("listed_before") or 0) if start != lo else 0)
        if info.get("complete"):
            b.update({"events": kept_before + shaped, "fetched_at": now.isoformat(), "complete": True, "cursor": None, "listed": listed, "calls": calls,
                      "pages": cycle_calls, "total": info.get("total"), "cycle_calls": 0})   # pages = what a full pass costs, the measure the cadence is priced by
            b.pop("listed_before", None)
        else:
            # interrupted: the rows fetched so far replace the dates they cover; the band's older rows past the
            # cursor stay until the next run picks up from it
            edge = reached or start.isoformat()
            fetched = [e for e in shaped if (e.get("date") or "") <= edge]
            stale_after = [e for e in b["events"] if (e.get("date") or "") > edge]
            b.update({"events": kept_before + fetched + stale_after, "complete": False, "cursor": edge, "listed_before": listed, "calls": calls, "cycle_calls": cycle_calls,
                      "pages": max(int(b.get("pages") or 0), cycle_calls + max(0, int(info.get("pages") or 0) - calls)), "total": info.get("total")})
        log.info("concerts: jambase %s..%s: %d events in %d call(s)%s, %d by played artists", span["from"], span["to"], len(raw), int(info.get("calls") or 0),
                 "" if info.get("complete") else f" (interrupted, continues from {b['cursor']} next run)", len(shaped))
    bands = {str(i): bands[str(i)] for i in range(len(spans)) if str(i) in bands}
    events = [e for b in bands.values() for e in b.get("events") or []]
    fetched = [b["fetched_at"] for b in bands.values() if b.get("fetched_at")]
    state["sources"]["jambase"] = {"fetched_at": max(fetched) if fetched else None, "events": events, "listed": sum(int(b.get("listed") or 0) for b in bands.values()), "bands": bands}
    calls = sum(int(b.get("calls") or 0) for b in bands.values())
    pages_known = [(b, span) for b, span in zip(bands.values(), spans, strict=True) if b.get("pages") and span["refresh_days"] > 0]
    planned = round(sum(int(b["pages"]) * 30 / span["refresh_days"] for b, span in pages_known)) if pages_known else None
    summary = [{"from": b.get("from"), "to": b.get("to"), "refresh_days": b.get("refresh_days"), "fetched_at": b.get("fetched_at"), "complete": bool(b.get("complete")), "cursor": b.get("cursor"),
                "listed": b.get("listed") or b.get("listed_before") or 0, "pages": b.get("pages"), "calls": b.get("calls") or 0, "matched": len(b.get("events") or []),
                **({"deferred": b["deferred"]} if b.get("deferred") else {}), **({"error": b["error"]} if b.get("error") else {})} for b in bands.values()]
    ok = not errors and any(b.get("fetched_at") or b.get("cursor") for b in bands.values())
    health["jambase"] = {"ok": ok, "events": state["sources"]["jambase"]["listed"], "matched": len(events), "calls": calls, "bands": summary, "quota": quota.health(),
                         **({"planned_calls_per_month": planned} if planned is not None else {})}
    if errors:
        health["jambase"]["error"] = "; ".join(errors)[:200]
    elif not ok:
        health["jambase"]["error"] = "no band fetched yet"
    log.info("concerts: jambase lists %d events within %d miles across %d bands, %d by played artists; %d call(s) this run, %d of %d in the last %d days%s",
             health["jambase"]["events"], radius, len(bands), len(events), calls, quota.used, quota.quota, QUOTA_WINDOW_DAYS, f", ~{planned} a month at these cadences" if planned else "")


def build_concerts(cfg: dict, *, deadline_minutes: float | None = None) -> dict | None:
    c = _cfg(cfg)
    if not c.get("enabled", True):
        return None
    center, radius = c["center"], float(c["radius_miles"])
    profile = load_profile()
    http = Http("concerts", ttl_hours=20)
    http.min_interval.update({"rest.bandsintown.com": 0.15, "app.ticketmaster.com": 0.25, "api.seatgeek.com": 0.3, "api.data.jambase.com": 1.1, "www.jambase.com": 1.1,
                              "edmtrain.com": 1.0, "ra.co": 1.5})   # Bandsintown answers in ~10ms; a 429 widens any of these on its own
    lastfm = LastFm(http, os.environ.get("LASTFM_API_KEY"))
    played = played_artists(cfg, profile, lastfm)
    http.save()
    state = _load_state()
    arts: dict[str, dict] = state["artists"]
    for k in [k for k in arts if k not in played]:   # no longer played: their listings go
        del arts[k]
    today = date.today()
    horizon_days = 30 * int(c["months_ahead"])
    horizon = (today + timedelta(days=horizon_days)).isoformat()
    minutes = float(c["time_budget_minutes"]) if deadline_minutes is None else min(float(c["time_budget_minutes"]), deadline_minutes)
    deadline = Deadline(max(0.01, minutes))
    health: dict[str, dict] = {}
    now = utcnow()
    area = dict(center=center, radius=radius, played=played)

    # 1. the area sources: everything within the radius up to the horizon, matched against the played artists
    tcfg = c["ticketmaster"]
    if tcfg.get("enabled", True):
        tm_key = os.environ.get("TICKETMASTER_API_KEY")
        _area_source(state, health, "ticketmaster", **area, shape=shape_ticketmaster, missing=None if tm_key else "TICKETMASTER_API_KEY not set",
                     fetch=lambda: ticketmaster_events(http, tm_key, center, radius, start=now, end=now + timedelta(days=horizon_days + 1),
                                                       size=int(tcfg.get("size", 200)), max_requests=int(tcfg.get("requests_per_run", 60))))
    scfg = c["seatgeek"]
    if scfg.get("enabled", True):
        sg_id = os.environ.get("SEATGEEK_CLIENT_ID")
        _area_source(state, health, "seatgeek", **area, shape=shape_seatgeek, missing=None if sg_id else "SEATGEEK_CLIENT_ID not set",
                     fetch=lambda: seatgeek_events(http, sg_id, center, radius, start=now, end=now + timedelta(days=horizon_days + 1), per_page=int(scfg.get("per_page", 100)),
                                                   max_requests=int(scfg.get("requests_per_run", 40)), taxonomies=list(scfg.get("taxonomies") or ["concert"])))
    jcfg = c["jambase"]
    if jcfg.get("enabled", True):
        quota = CallQuota(state.setdefault("quota", {}).setdefault("jambase", {}), quota=int(jcfg.get("monthly_quota", 1000)), reserve=int(jcfg.get("quota_reserve", 100)), today=today)
        _jambase_source(state, health, jcfg, os.environ.get("JAMBASE_API_KEY"), http, quota, **area, today=today, horizon_days=horizon_days)
    ecfg = c["edmtrain"]
    if ecfg.get("enabled", True):
        edm_key = os.environ.get("EDMTRAIN_API_KEY")
        _area_source(state, health, "edmtrain", **area, shape=shape_edmtrain, missing=None if edm_key else "EDMTRAIN_API_KEY not set",
                     fetch=lambda: edmtrain_events(http, edm_key, [str(s) for s in (ecfg.get("states") or []) if s], start=today, end=today + timedelta(days=horizon_days),
                                                   other_genres=bool(ecfg.get("other_genres", True))))
    rcfg = c["resident_advisor"]
    if rcfg.get("enabled", True):
        def ra_fetch() -> list[dict]:
            cached = state.get("ra_area") or {}
            want = {"country": str(rcfg["area"].get("country") or "us").lower(), "city": str(rcfg["area"].get("city") or "").lower()}
            if rcfg.get("area_id"):
                area_id = str(rcfg["area_id"])
            elif cached.get("id") and (cached.get("country"), cached.get("city")) == (want["country"], want["city"]) and (cached.get("at") or "") > (now - timedelta(days=30)).isoformat():
                area_id = str(cached["id"])
            else:
                found = ra_area(http, rcfg)
                if not found:
                    raise RuntimeError(f"resident advisor has no area {want['country']}/{want['city']}")
                state["ra_area"] = {**found, "at": now.isoformat()}
                area_id = found["id"]
            return ra_events(http, rcfg, area_id, start=today, end=today + timedelta(days=horizon_days), page_size=int(rcfg.get("page_size", 100)), max_requests=int(rcfg.get("requests_per_run", 30)))
        _area_source(state, health, "resident_advisor", **area, shape=shape_ra, fetch=ra_fetch)

    # 2. Bandsintown: artist by artist, the most played first, those not asked for `refresh_days` — a batch a run
    bcfg = c["bandsintown"]
    secret = (os.environ.get("BANDSINTOWN_APP_ID") or "").strip()
    app_id = secret or str(bcfg.get("app_id") or "chrisrohn.com")
    app_id_from = "the BANDSINTOWN_APP_ID secret" if secret else "the config fallback (BANDSINTOWN_APP_ID secret not set)"
    asked = failed = listed = 0
    reasons: Counter = Counter()
    answers: Counter = Counter()
    give_up_after = max(1, int(bcfg.get("give_up_after", 10) or 10))
    probe = max(1, int(bcfg.get("empty_probe", BIT_EMPTY_PROBE) or BIT_EMPTY_PROBE))
    refused = False
    if bcfg.get("enabled", True):
        cutoff = (now - timedelta(days=float(c["refresh_days"]))).isoformat()
        due = [k for k in ranked(played) if (arts.get(k) or {}).get("checked_at", "") < cutoff]
        log.info("concerts: bandsintown app_id from %s (%d characters)", app_id_from, len(app_id))   # never the value itself
        per_run = int(c["artists_per_run"] or 0)
        pending: dict[str, dict] = {}   # rows held back until Bandsintown has listed a show for somebody this run
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
            evs = bandsintown_events(http, name, app_id, reasons, answers)
            asked += 1
            if evs is None:
                failed += 1
                continue
            listed += len(evs)
            rows = []
            for ev in evs:
                s = within(shape_bandsintown(ev, name), center, radius)
                if s and s.get("date"):
                    rows.append({**s, "artists": [name] + [a for a in matched_artists(s["lineup"], played) if a != name]})
            who = (evs[0].get("artist") or {}) if evs else {}
            row = {"name": name, "checked_at": now.isoformat(), "events": rows, "listed": len(evs), "top": (arts.get(k) or {}).get("top"),
                   "page": safe_url(who.get("url")) or (arts.get(k) or {}).get("page"), "image": safe_url(who.get("image_url")) or (arts.get(k) or {}).get("image")}
            if listed:
                arts.update(pending)
                pending.clear()
                arts[k] = row
                continue
            pending[k] = row
            if asked - failed >= probe:
                # the most played artists of the year, and not one of them has a show anywhere: that is not a quiet
                # year, it is Bandsintown answering empty to an app_id it did not issue. Nothing is recorded as
                # checked, so the whole batch is asked again once the key is right
                refused = True
                pending.clear()
                log.warning("concerts: bandsintown answered %d requests with app_id %r and listed no show anywhere for any of them (%s); treating that as a refusal, nothing recorded",
                            asked, app_id, ", ".join(f"{r} ×{n}" for r, n in answers.most_common()))
                break
        arts.update(pending)   # a short batch that stayed empty: too few answers to call it a refusal
        checked = sum(1 for a in arts.values() if a.get("checked_at"))
        health["bandsintown"] = {"ok": failed < max(3, asked // 2) and not refused, "asked": asked, "failed": failed, "listed": listed, "due": len(due), "checked": checked,
                                 "app_id_from": "secret" if secret else "fallback"}
        if reasons:
            health["bandsintown"]["errors"] = dict(reasons.most_common())
        if answers:
            health["bandsintown"]["answers"] = dict(answers.most_common())
        if refused:
            said = ", ".join(f"{r} ×{n}" for r, n in answers.most_common())
            health["bandsintown"]["error"] = (f"every one of {asked} answers was empty ({said}): not one show anywhere for the most played artists, so its API is refusing "
                                              f"the app_id from {app_id_from}" + (" (a key Bandsintown has not approved for its public API? ask biz@bandsintown.com to enable it)" if secret
                                                                                  else " (an app_id Bandsintown did not issue: set the BANDSINTOWN_APP_ID secret)"))
        elif not health["bandsintown"]["ok"]:
            top = reasons.most_common(1)[0][0] if reasons else "failed"
            health["bandsintown"]["error"] = f"{top} on {failed} of {asked} requests" + (" (app_id not issued by Bandsintown? set the BANDSINTOWN_APP_ID secret)" if top == "HTTP 403" else "")
        log.log(logging.WARNING if failed or refused else logging.INFO, "concerts: bandsintown asked for %d of %d due artists (%d failed%s; %d shows listed anywhere); %d of %d artists checked so far",
                asked, len(due), failed, ": " + ", ".join(f"{r} ×{n}" for r, n in reasons.most_common()) if reasons else "", listed, checked, len(played))
    write_json(STATE_PATH, state, compact=True)

    # 3. the list: every show still ahead, within the horizon, one row per show
    events = [ev for a in arts.values() for ev in a.get("events") or []] + [ev for s in state["sources"].values() for ev in (s.get("events") or [])]
    events = [ev for ev in events if ev.get("date") and today.isoformat() <= ev["date"] <= horizon]
    events = merge_events(events, played)
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
