"""Original release year verification, built on identifiers rather than title matching.

Why: text-searching MusicBrainz for "artist + title" is brittle (credit variants, punctuation, feat. noise) and was
the weak link in filing songs into the right year playlist. This module identifies the *recording* first and then
asks the catalogues for the earliest date that recording (or its ISRC) was ever released:

    1. ListenBrainz metadata lookup  – MetaBrainz's own fuzzy matcher → recording MBID          (free, no key)
    2. MusicBrainz recording by MBID – first-release-date + every release's release-group date  (free, 1 req/s)
       fallback 1b: MusicBrainz text search when ListenBrainz has no mapping
    3. Deezer                        – matching track → ISRC + album date; MusicBrainz ISRC lookup → earliest date
       the ISRC itself also encodes a registration year (weak hint)                              (free, no key)
    4. Discogs master release year   – masters represent the original issue; needs DISCOGS_TOKEN  (free account)
    5. iTunes Search API             – earliest release date of a matching song                   (free, ~20/min)
    6. the source's own release date (Bandcamp / ListenBrainz / KEXP album date), then the YouTube album year

Every year found is kept as evidence; the earliest year from the most trusted tier wins. A blog-post or channel
upload date is never a release date. When nothing anywhere says when a song came out, `year` stays None and the site
asks you to pick instead of silently filing under this year.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from datetime import date

from .models import Item
from .util import CACHE_DIR, format_title, item_key, log, norm, norm_track, read_json, split_artists, write_json

YEAR_CACHE = CACHE_DIR / "years.json"
CACHE_VERSION = 2
MB = "https://musicbrainz.org/ws/2"
LB_LOOKUP = "https://api.listenbrainz.org/1/metadata/lookup/"
DEEZER = "https://api.deezer.com"
DISCOGS = "https://api.discogs.com/database/search"
ITUNES = "https://itunes.apple.com/search"
_EXCLUDE_RG = {"compilation", "live", "dj-mix", "remix", "mixtape/street"}
_ISRC_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{3}(\d{2})\d{5}$")

# evidence tiers: 3 = recording-level catalogue fact, 2 = store/source date, 1 = weak hint
TRUST = {"musicbrainz": 3, "musicbrainz-search": 3, "musicbrainz-isrc": 3, "discogs": 3,
         "deezer": 2, "itunes": 2, "release-date": 2, "isrc": 1, "youtube": 1, "feed-date": 0}
LABEL = {"musicbrainz": "MusicBrainz recording", "musicbrainz-search": "MusicBrainz search", "musicbrainz-isrc": "MusicBrainz via ISRC",
         "discogs": "Discogs master", "deezer": "Deezer", "itunes": "Apple Music", "release-date": "source release date",
         "isrc": "ISRC registration year", "youtube": "YouTube album", "feed-date": "blog post date"}


@dataclass
class Evidence:
    year: int
    source: str

    @property
    def trust(self) -> int:
        return TRUST.get(self.source, 0)


def year_of(d) -> int | None:
    s = str(d or "")[:4]
    return int(s) if s.isdigit() and 1900 < int(s) < 2100 else None


def _names(artist: str) -> set[str]:
    return {norm(artist)} | {norm(x) for x in split_artists(artist)}


def _artist_ok(candidate: str | None, ours: set[str]) -> bool:
    c = norm(candidate)
    if not c:
        return False
    cand = {c} | {norm(x) for x in split_artists(candidate or "")}
    return bool(cand & ours) or any(o and (o in c or c in o) for o in ours)


def _title_ok(candidate: str | None, ours: str) -> bool:
    c = norm_track(candidate)
    return bool(c) and (c == ours or c.startswith(ours + " ") or ours.startswith(c + " "))


# ---------------------------------------------------------------- 1. identify the recording
_LB_WARNINGS = [0]


def lb_identify(http, artist: str, title: str) -> tuple[dict | None, str]:
    """ListenBrainz's mbid-mapping: fuzzy artist + recording → MusicBrainz ids.

    Returns (mapping or None, status) where status is one of "matched", "nomatch", "rejected:<what LB returned>",
    or "http <code>: <body>" — the status is kept in the year cache so a silent failure is visible in data/cache/years.json.
    """
    import requests

    attempts = [{"artist_name": artist, "recording_name": title, "metadata": "true", "inc": "release"},
                {"artist_name": artist, "recording_name": title}]            # plain form if the metadata options are refused
    data, status = None, "nomatch"
    for params in attempts:
        try:
            data = http.get(LB_LOOKUP, params=params)
            break
        except requests.HTTPError as exc:
            resp = exc.response
            status = f"http {resp.status_code if resp is not None else '?'}: {(resp.text if resp is not None else str(exc))[:160]}"
            if resp is not None and resp.status_code == 400 and params is attempts[0]:
                continue
            data = None
            break
        except Exception as exc:  # noqa: BLE001
            status = f"error: {str(exc)[:160]}"
            data = None
            break
    if data is None or not isinstance(data, dict) or not data.get("recording_mbid"):
        if status.startswith(("http", "error")) and _LB_WARNINGS[0] < 5:
            _LB_WARNINGS[0] += 1
            log.warning("ListenBrainz lookup failed for %s – %s: %s", artist, title, status)
        return None, status if data is None else "nomatch"
    # the mapper is fuzzy on purpose; make sure it didn't wander to a different artist or a different song
    if not _artist_ok(data.get("artist_credit_name"), _names(artist)) or not _title_ok(data.get("recording_name"), norm_track(title)):
        return None, f"rejected: {data.get('artist_credit_name')} – {data.get('recording_name')}"
    return data, "matched"


# ---------------------------------------------------------------- 2. MusicBrainz dates for a recording
def _earliest_from_releases(rec: dict) -> int | None:
    years = []
    for rel in rec.get("releases") or []:
        rg = rel.get("release-group") or {}
        if {str(x).lower() for x in (rg.get("secondary-types") or [])} & _EXCLUDE_RG:
            continue
        for d in (rel.get("date"), rg.get("first-release-date")):
            y = year_of(d)
            if y:
                years.append(y)
    if years:
        return min(years)
    return year_of(rec.get("first-release-date"))   # only compilations / undated releases: still a real floor


def mb_recording(http, mbid: str) -> tuple[int | None, list[str]]:
    """Earliest release year of a MusicBrainz recording plus its ISRCs."""
    try:
        rec = http.get(f"{MB}/recording/{mbid}", params={"fmt": "json", "inc": "isrcs+releases+release-groups"})
    except Exception as exc:  # noqa: BLE001
        log.debug("MB recording %s failed: %s", mbid, exc)
        return None, []
    return _earliest_from_releases(rec), [i for i in (rec.get("isrcs") or []) if isinstance(i, str)]


def mb_search_year(http, artist: str, title: str) -> int | None:
    """Fallback when ListenBrainz has no mapping: MusicBrainz text search, strict artist + title match."""
    q = f'recording:"{_lucene(title)}" AND artist:"{_lucene(artist)}"'
    try:
        data = http.get(f"{MB}/recording/", params={"query": q, "fmt": "json", "limit": 15})
    except Exception as exc:  # noqa: BLE001
        log.debug("MB search failed for %s – %s: %s", artist, title, exc)
        return None
    ours, t_norm = _names(artist), norm_track(title)
    years = []
    for rec in data.get("recordings") or []:
        if norm_track(rec.get("title")) != t_norm:
            continue
        credits = rec.get("artist-credit") or []
        names = {norm(c.get("name") or (c.get("artist") or {}).get("name")) for c in credits if isinstance(c, dict)}
        if not (names & ours):
            continue
        y = _earliest_from_releases(rec)
        if y:
            years.append(y)
    return min(years) if years else None


def mb_isrc_year(http, isrc: str) -> int | None:
    try:
        data = http.get(f"{MB}/isrc/{isrc}", params={"fmt": "json", "inc": "releases+release-groups"})
    except Exception as exc:  # noqa: BLE001
        log.debug("MB isrc %s failed: %s", isrc, exc)
        return None
    years = [y for y in (_earliest_from_releases(r) for r in data.get("recordings") or []) if y]
    return min(years) if years else None


def _lucene(s: str) -> str:
    return str(s).replace("\\", " ").replace('"', " ").strip()


# ---------------------------------------------------------------- 3. Deezer: ISRC + album date
def deezer_lookup(http, artist: str, title: str) -> tuple[int | None, str | None]:
    """(earliest non-compilation album year on Deezer, ISRC of the matched track)."""
    try:
        data = http.get(f"{DEEZER}/search", params={"q": f'artist:"{artist}" track:"{title}"', "limit": 10})
    except Exception as exc:  # noqa: BLE001
        log.debug("deezer search failed for %s – %s: %s", artist, title, exc)
        return None, None
    ours, t_norm = _names(artist), norm_track(title)
    years: list[int] = []
    isrc: str | None = None
    for tr in (data.get("data") or [])[:10]:
        if not (_title_ok(tr.get("title"), t_norm) or _title_ok(tr.get("title_short"), t_norm)):
            continue
        if not _artist_ok((tr.get("artist") or {}).get("name"), ours):
            continue
        if not isrc and tr.get("id"):
            try:
                full = http.get(f"{DEEZER}/track/{tr['id']}")
                isrc = full.get("isrc") or None
                y = year_of(full.get("release_date"))
                if y:
                    years.append(y)
            except Exception:  # noqa: BLE001
                pass
        aid = (tr.get("album") or {}).get("id")
        if aid:
            try:
                album = http.get(f"{DEEZER}/album/{aid}")
                if (album.get("record_type") or "").lower() != "compile":
                    y = year_of(album.get("release_date"))
                    if y:
                        years.append(y)
            except Exception:  # noqa: BLE001
                pass
        if len(years) >= 4:
            break
    return (min(years) if years else None), isrc


def isrc_year(isrc: str | None) -> int | None:
    """ISRCs carry the two-digit year the recording was registered (positions 6–7)."""
    m = _ISRC_RE.match((isrc or "").replace("-", "").upper())
    if not m:
        return None
    yy = int(m.group(1))
    y = 2000 + yy if yy <= date.today().year % 100 else 1900 + yy
    return y if 1940 < y <= date.today().year else None


# ---------------------------------------------------------------- 4. Discogs master year
def discogs_year(http, artist: str, title: str, token: str) -> int | None:
    try:
        data = http.get(DISCOGS, params={"artist": artist, "track": title, "type": "master", "per_page": 8, "token": token})
    except Exception as exc:  # noqa: BLE001
        log.debug("discogs failed for %s – %s: %s", artist, title, exc)
        return None
    ours = _names(artist)
    years = []
    for r in data.get("results") or []:
        head = (r.get("title") or "").split(" - ", 1)[0]
        if not _artist_ok(head, ours):
            continue
        y = year_of(r.get("year"))
        if y:
            years.append(y)
    return min(years) if years else None


# ---------------------------------------------------------------- 5. iTunes
def itunes_year(http, artist: str, title: str) -> int | None:
    try:
        data = http.get(ITUNES, params={"term": f"{artist} {title}", "entity": "song", "media": "music", "limit": 10})
    except Exception as exc:  # noqa: BLE001
        log.debug("itunes failed for %s – %s: %s", artist, title, exc)
        return None
    ours, t_norm = _names(artist), norm_track(title)
    years = [year_of(tr.get("releaseDate")) for tr in data.get("results") or []
             if _title_ok(tr.get("trackName"), t_norm) and _artist_ok(tr.get("artistName"), ours)]
    years = [y for y in years if y]
    return min(years) if years else None


# ---------------------------------------------------------------- orchestration
def lookup_track(http, artist: str, title: str, cfg: dict) -> dict:
    """Run the catalogue chain for one recording. Returns a cache entry with every year found."""
    rcfg = cfg.get("resolve") or {}
    entry: dict = {"v": CACHE_VERSION, "found": {}}
    lb, entry["lb"] = lb_identify(http, artist, title)
    isrcs: list[str] = []
    if lb:
        entry["mbid"] = lb["recording_mbid"]
        y, isrcs = mb_recording(http, lb["recording_mbid"])
        if y:
            entry["found"]["musicbrainz"] = y
        lb_year = year_of(((lb.get("metadata") or {}).get("release") or {}).get("year"))
        if lb_year and not y:
            entry["found"]["musicbrainz"] = lb_year
    else:
        y = mb_search_year(http, artist, title)
        if y:
            entry["found"]["musicbrainz-search"] = y

    need_more = not any(TRUST[k] >= 3 for k in entry["found"])
    if need_more or rcfg.get("always_cross_check", False):
        dz_year, isrc = deezer_lookup(http, artist, title)
        if dz_year:
            entry["found"]["deezer"] = dz_year
        if isrc and isrc not in isrcs:
            isrcs.append(isrc)
    for isrc in isrcs[:2]:
        if need_more and "musicbrainz-isrc" not in entry["found"]:
            y = mb_isrc_year(http, isrc)
            if y:
                entry["found"]["musicbrainz-isrc"] = y
        iy = isrc_year(isrc)
        if iy:
            entry["found"]["isrc"] = min(iy, entry["found"].get("isrc", iy))
    if isrcs:
        entry["isrc"] = isrcs[0]
    need_more = not any(TRUST[k] >= 3 for k in entry["found"])
    token = os.environ.get("DISCOGS_TOKEN", "").strip()
    if need_more and token and rcfg.get("discogs", True):
        y = discogs_year(http, artist, title, token)
        if y:
            entry["found"]["discogs"] = y
    if not any(TRUST[k] >= 2 for k in entry["found"]):
        y = itunes_year(http, artist, title)
        if y:
            entry["found"]["itunes"] = y
    return entry


def decide(found: dict[str, int], it: Item) -> tuple[int | None, str, str, list[Evidence]]:
    """Pick the year: earliest year from the most trusted tier that has any evidence."""
    ev = [Evidence(y, s) for s, y in found.items() if y]
    weak_date = it.release_date is not None and it.date_kind != "release"
    if it.release_date and not weak_date:
        ev.append(Evidence(it.release_date.year, "release-date"))
    yt = year_of((it.youtube or {}).get("year"))
    if yt:
        ev.append(Evidence(yt, "youtube"))
    if it.release_date and weak_date and any(s.startswith("rss") for s in it.sources):
        ev.append(Evidence(it.release_date.year, "feed-date"))
    if not ev:
        return None, "unknown", "low", []
    top = max(e.trust for e in ev)
    tier = [e for e in ev if e.trust == top]
    best = min(tier, key=lambda e: e.year)
    agree = sum(1 for e in ev if abs(e.year - best.year) <= 1)
    if top >= 3:
        conf = "high"
    elif top == 2:
        conf = "high" if agree >= 2 else "medium"
    else:
        conf = "low"
    return best.year, best.source, conf, sorted(ev, key=lambda e: (-e.trust, e.year))


def verify_years(items: list[Item], cfg: dict, http) -> None:
    rcfg = cfg.get("resolve") or {}
    budget = int(rcfg.get("max_year_lookups_per_run", 500))
    cache: dict = read_json(YEAR_CACHE, {})
    looked = 0
    # undated tracks first (they'd otherwise have nothing), then by score; the cache carries the rest to later runs
    order = sorted(items, key=lambda i: (0 if (i.release_date is None or i.date_kind != "release") else 1, -i.score))
    for it in order:
        lookup_title = format_title(it.title, None, it.remixer, it.remix_kind)   # base title + remix suffix, never "feat."
        entry = cache.get(it.key)
        if (entry is None or entry.get("v") != CACHE_VERSION) and it.kind == "track" and looked < budget:
            looked += 1
            entry = lookup_track(http, it.artist, lookup_title, cfg)
            cache[it.key] = entry
        found = (entry or {}).get("found") or {}
        if entry and entry.get("v") != CACHE_VERSION:   # legacy entry shape: {"mb":..,"dz":..,"it":..}
            found = {k: v for k, v in (("musicbrainz-search", entry.get("mb")), ("deezer", entry.get("dz")), ("itunes", entry.get("it"))) if v}
        year, source, conf, ev = decide(found, it)
        it.year, it.year_source, it.year_confidence = year, source, conf
        it.year_evidence = [f"{LABEL.get(e.source, e.source)}: {e.year}" for e in ev]
        it.original_year = None
        stated = it.release_date.year if (it.release_date and it.date_kind == "release") else None
        if stated and year and year < stated - 1:
            it.original_year = year            # the source announced a reissue; we found the original
        elif year and (yt := year_of((it.youtube or {}).get("year"))) and yt < year - 1:
            it.original_year = yt
    write_json(YEAR_CACHE, cache, compact=True)
    log.info("years: %d recordings looked up this run (%d cached)", looked, len(cache))


def decide_found(found: dict[str, int]) -> tuple[int | None, str | None]:
    """Earliest year from the most trusted tier of catalogue evidence (no item context)."""
    ev = [Evidence(y, s) for s, y in (found or {}).items() if y and TRUST.get(s, 0) >= 2]
    if not ev:
        return None, None
    top = max(e.trust for e in ev)
    best = min((e for e in ev if e.trust == top), key=lambda e: e.year)
    return best.year, best.source


def annotate_duplicate_years(dups: list[dict], cfg: dict, http) -> int:
    """Attach the catalogue-verified year to duplicate reports so the wrong-year copy is obvious.

    Songs already verified for the feed come free from the cache (same key). Otherwise a bounded number of
    cross-year duplicates are looked up per run; the rest follow on later runs."""
    rcfg = cfg.get("resolve") or {}
    budget = int(rcfg.get("max_duplicate_year_lookups_per_run", 120))
    cache: dict = read_json(YEAR_CACHE, {})
    looked = 0
    order = sorted(dups, key=lambda d: (0 if d.get("kind") == "cross-year" else 1, -int(d["years"][0]) if d.get("years") else 0))
    for d in order:
        k = item_key(d["artist"], d["title"])          # same key the feed uses, so feed verifications come free
        entry = cache.get(k)
        if (entry is None or entry.get("v") != CACHE_VERSION) and looked < budget and d.get("kind") == "cross-year":
            looked += 1
            entry = lookup_track(http, d["artist"], d["title"], cfg)
            cache[k] = entry
        if entry and entry.get("v") == CACHE_VERSION:
            y, src = decide_found(entry.get("found") or {})
            if y:
                d["verified_year"], d["verified_source"] = y, LABEL.get(src, src)
    if looked:
        write_json(YEAR_CACHE, cache, compact=True)
    log.info("duplicate report: %d cross-year songs verified this run", looked)
    return looked
