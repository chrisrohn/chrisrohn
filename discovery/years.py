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
    6. the source's own release date (Bandcamp / ListenBrainz / KEXP album date) or the year the YouTube Music
       artist page states for the release, then the YouTube album year
    7. still no date from any catalogue or store: the release date YouTube Music states for the upload itself
       (ytmusicapi's song metadata, the date on the song page; no API quota), a weak hint, asked for only then
       and only for a song with a YouTube match, a bounded batch a run (`resolve.max_ytmusic_date_lookups_per_run`)

Every year found is kept as evidence; the earliest year from the most trusted tier wins. A blog-post or channel
upload date is never a release date.

Reissues (a "2026 Remaster", a "50th Anniversary Edition", a "Super Deluxe" box) arrive dated the day the reissue came
out, and every store and source date describes that product, not the song. A song whose title, release or YouTube
album says so is looked up first, under its base title ("Don't Argue", not "Don't Argue (7" Version, 2026
Remaster)"), through the whole chain; any year at or after the reissue is discarded, an "Nth Anniversary" edition
dates itself (reissue year − N), and when nothing older is known the year stays None ("reissue") so the site asks
instead of filing a 1987 song under this year. A deluxe / expanded edition is a weaker hint (bonus tracks are new):
an older catalogue year wins, else the edition's year stands. When nothing anywhere says when a song came out, `year` stays None and the site
asks you to pick instead of silently filing under this year.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from datetime import date

from .models import Item
from .util import CACHE_DIR, Deadline, format_title, item_key, log, norm, norm_track, read_json, split_artists, write_json

YEAR_CACHE = CACHE_DIR / "years.json"
CACHE_VERSION = 2
FLUSH_EVERY = 25   # lookups between cache writes, so a killed job keeps what it already found
MB = "https://musicbrainz.org/ws/2"
LB_LOOKUP = "https://api.listenbrainz.org/1/metadata/lookup/"
DEEZER = "https://api.deezer.com"
DISCOGS = "https://api.discogs.com/database/search"
ITUNES = "https://itunes.apple.com/search"
_EXCLUDE_RG = {"compilation", "live", "dj-mix", "remix", "mixtape/street"}
_ISRC_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{3}(\d{2})\d{5}$")

# evidence tiers: 3 = recording-level catalogue fact, 2 = store/source date, 1 = weak hint
TRUST = {"musicbrainz": 3, "musicbrainz-search": 3, "musicbrainz-isrc": 3, "discogs": 3,
         "deezer": 2, "itunes": 2, "anniversary": 2, "release-date": 2, "ytmusic-year": 2, "isrc": 1, "youtube": 1, "ytmusic-date": 1, "feed-date": 0}
LABEL = {"musicbrainz": "MusicBrainz recording", "musicbrainz-search": "MusicBrainz search", "musicbrainz-isrc": "MusicBrainz via ISRC",
         "discogs": "Discogs master", "deezer": "Deezer", "itunes": "Apple Music", "release-date": "source release date",
         "ytmusic-year": "YouTube Music release year", "isrc": "ISRC registration year", "youtube": "YouTube album",
         "ytmusic-date": "YouTube Music release date", "feed-date": "blog post date",
         "anniversary": "anniversary edition"}
_UGC = "MUSIC_VIDEO_TYPE_UGC"   # a fan upload: its date says when it was uploaded, never when the song came out


@dataclass
class Evidence:
    year: int
    source: str
    note: str = ""          # "reissue": the year of the reissue itself, shown but never filed under

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


# ---------------------------------------------------------------- 0. reissues
# strong: the product is a reissue of older music; weak: a deluxe / expanded edition (bonus tracks can be new)
_STRONG_RE = re.compile(
    r"\b(re-?master(?:ed)?|re-?issue[sd]?|re-?release[sd]?|\d{1,3}(?:st|nd|rd|th)[ -]anniversary|anniversary (?:edition|version|"
    r"deluxe|remaster|reissue|box)|super deluxe|legacy edition|collector'?s edition|definitive edition|centenary edition|"
    r"(?:19|20)\d{2} (?:stereo |mono |new )?(?:mix|master))\b", re.I)
_WEAK_RE = re.compile(r"\b(deluxe|expanded|bonus tracks?|special edition|complete edition|extended edition)\b", re.I)
_TAG_YEAR_RE = re.compile(r"\b((?:19|20)\d{2})\s+(?:digital(?:ly)?\s+)?(?:re-?master(?:ed)?|(?:stereo |mono |new )?(?:mix|master))\b"
                          r"|\bre-?master(?:ed)?\s+(?:in\s+)?((?:19|20)\d{2})\b", re.I)
_ANNIV_RE = re.compile(r"\b(\d{1,3})(?:st|nd|rd|th)[ -]anniversary\b", re.I)
# a bracketed version note ("[2026 Remaster]", "(7\" Version, 2026 Remaster)", "[Single Edit 2]") or a dashed one
# ("- Remastered 2011"): what a reissue's title adds to the song's own
_VERSION_WORDS = (r"re-?master(?:ed)?|re-?issue|re-?release|anniversary|deluxe|expanded|edition|version|edit|mono|stereo|single|"
                  r"mix|bonus|\d+\s*(?:\"|''|inch|in\.)")
_VERSION_GROUP_RE = re.compile(r"\s*[\(\[][^\(\)\[\]]*\b(?:" + _VERSION_WORDS + r")[^\(\)\[\]]*[\)\]]", re.I)
_VERSION_DASH_RE = re.compile(r"\s+[-–—]\s+[^-–—]*\b(?:" + _VERSION_WORDS + r")\b[^-–—]*$", re.I)
# dates that describe the product in hand (the reissue), not the song
_PRODUCT = {"release-date", "ytmusic-year", "youtube", "ytmusic-date", "feed-date", "isrc"}


@dataclass
class Reissue:
    strength: str = ""                  # "strong" | "weak" | ""
    tag_years: tuple[int, ...] = ()     # "2011 Remaster" → 2011: the year of the remaster named in the title
    anniversary: int | None = None      # "50th Anniversary Edition" → 50


def _texts(it: Item) -> list[str]:
    return [t for t in (it.title, it.release, (it.youtube or {}).get("album")) if t]


def reissue_info(it: Item) -> Reissue:
    """Does the title, the release or the YouTube album say this is a remaster / reissue / anniversary edition?"""
    return reissue_of(_texts(it))


def reissue_of(texts) -> Reissue:
    blob = " · ".join(t for t in texts if t)
    if _STRONG_RE.search(blob):
        tags = sorted({int(a or b) for m in _TAG_YEAR_RE.finditer(blob) for a, b in [m.groups()]})
        ann = [int(m.group(1)) for m in _ANNIV_RE.finditer(blob) if 0 < int(m.group(1)) < 150]
        return Reissue("strong", tuple(tags), max(ann) if ann else None)
    if _WEAK_RE.search(blob):
        return Reissue("weak")
    return Reissue()


def base_title(title: str) -> str:
    """The song's own title, without a reissue's version notes: what the catalogues file the original under."""
    s = str(title or "")
    for _ in range(4):
        t = _VERSION_DASH_RE.sub("", _VERSION_GROUP_RE.sub("", s)).strip()
        if t == s:
            break
        s = t
    return s or str(title or "")


def _reissue_cut(ev: list[Evidence], ri: Reissue) -> tuple[int | None, int | None]:
    """(the reissue's own year, the year from which evidence describes the reissue rather than the song)."""
    product = [e.year for e in ev if e.source in _PRODUCT]
    issued = max(product) if product else (max(ri.tag_years) if ri.tag_years else None)
    cuts = [y for y in (*ri.tag_years, issued) if y]
    return issued, (min(cuts) if cuts else None)


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
def lookup_track(http, artist: str, title: str, cfg: dict, reissue: bool = False) -> dict:
    """Run the catalogue chain for one recording. Returns a cache entry with every year found.

    reissue=True (a remaster / reissue / deluxe edition, looked up under its base title): a catalogue answer may be
    the reissue itself, so every link of the chain is asked — MusicBrainz search beside the mapped recording (a
    remaster can sit on a recording of its own), Deezer, the ISRC, Discogs masters and iTunes — whatever `year_chain`
    says, and the earliest original wins in decide()."""
    rcfg = cfg.get("resolve") or {}
    entry: dict = {"v": CACHE_VERSION, "found": {}}
    if reissue:
        entry["reissue"], entry["q"] = 1, title
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
    if not lb or reissue:
        y = mb_search_year(http, artist, title)
        if y:
            entry["found"]["musicbrainz-search"] = y

    need_more = reissue or not any(TRUST[k] >= 3 for k in entry["found"])
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
    need_more = reissue or not any(TRUST[k] >= 3 for k in entry["found"])
    # "fast": stop here — Discogs (1 req/s) and iTunes (20 req/min) are the slow end of the chain, and the catalog has
    # thousands of tracks to get through; the YouTube Music album year covers what this leaves undated
    if rcfg.get("year_chain", "full") == "fast" and not reissue:
        entry["chain"] = "fast"
        return entry
    token = os.environ.get("DISCOGS_TOKEN", "").strip()
    if need_more and token and rcfg.get("discogs", True):
        y = discogs_year(http, artist, title, token)
        if y:
            entry["found"]["discogs"] = y
    if reissue or not any(TRUST[k] >= 2 for k in entry["found"]):
        y = itunes_year(http, artist, title)
        if y:
            entry["found"]["itunes"] = y
    return entry


# ---------------------------------------------------------------- 7. YouTube Music's own release date (fallback)
def ytmusic_release_date(yt, video_id: str) -> str | None:
    """The release date YouTube Music states for an upload (the song page's date: for the audio track the release
    date of the record, for an official video its publish date), as YYYY-MM-DD, or None."""
    try:
        song = yt.get_song(video_id)
    except Exception as exc:  # noqa: BLE001
        log.debug("ytmusic song %s failed: %s", video_id, exc)
        return None
    micro = ((song or {}).get("microformat") or {}).get("microformatDataRenderer") or {}
    for key in ("publishDate", "uploadDate"):
        d = str(micro.get(key) or "")[:10]
        y = year_of(d)
        if y and y > 1970:          # "1969-12-31" / "1970-01-01" is YouTube's "no date" (the Unix epoch), never a release
            return d
    return None


def unsure(found: dict[str, int], it: Item) -> bool:
    """No catalogue or store date (trust 2 or better) anywhere: the year, if any, rests on a weak hint."""
    year, _source, _conf, ev = decide(found, it)
    return year is None or not any(e.trust >= 2 for e in ev)


def _ytdate_wanted(it: Item, entry: dict | None) -> bool:
    """Ask YouTube Music for the upload's date: the item has a match that is not a fan upload, and the cache does not
    already hold the answer for that very video (a re-resolved track gets its new upload's date)."""
    yt = it.youtube or {}
    if not yt.get("videoId") or yt.get("videoType") == _UGC:
        return False
    row = (entry or {}).get("ytdate") or {}
    return row.get("video") != yt["videoId"]


def decide(found: dict[str, int], it: Item) -> tuple[int | None, str, str, list[Evidence]]:
    """Pick the year: earliest year from the most trusted tier that has any evidence (a reissue: see _decide_reissue)."""
    ev = _evidence(found, it)
    ri = reissue_info(it)
    if ri.strength == "strong":
        return _decide_reissue(ev, ri)
    if not ev:
        return None, "unknown", "low", []
    top = max(e.trust for e in ev)
    tier = [e for e in ev if e.trust == top]
    best = min(tier, key=lambda e: e.year)
    if ri.strength == "weak":
        # a deluxe / expanded edition: a catalogue or store that knows the song from earlier is the original;
        # nothing earlier and the edition's year stands (a bonus track is new with it)
        older = [e for e in ev if e.trust >= 2 and e.year < best.year]
        if older:
            best = min(older, key=lambda e: (e.year, -e.trust))
            top = best.trust
    agree = sum(1 for e in ev if abs(e.year - best.year) <= 1)
    if top >= 3:
        conf = "high"
    elif top == 2:
        conf = "high" if agree >= 2 else "medium"
    else:
        conf = "low"
    return best.year, best.source, conf, sorted(ev, key=lambda e: (-e.trust, e.year))


def _decide_reissue(ev: list[Evidence], ri: Reissue) -> tuple[int | None, str, str, list[Evidence]]:
    """A remaster / reissue / anniversary edition: every year at or after the reissue describes the reissue, so it is
    shown (noted "reissue") but never filed under. An anniversary edition dates itself. Of what is left, the earliest
    year of the most trusted tier wins; nothing left → None ("reissue"): the site asks instead of guessing."""
    issued, cut = _reissue_cut(ev, ri)
    kept = [e for e in ev if cut is None or e.year < cut]
    dropped = [Evidence(e.year, e.source, "reissue") for e in ev if cut is not None and e.year >= cut]
    if ri.anniversary and issued and issued - ri.anniversary > 1900:
        kept.append(Evidence(issued - ri.anniversary, "anniversary"))
    shown = sorted(kept, key=lambda e: (-e.trust, e.year)) + sorted(dropped, key=lambda e: (-e.trust, e.year))
    if not kept:
        return None, "reissue", "low", shown
    top = max(e.trust for e in kept)
    best = min((e for e in kept if e.trust == top), key=lambda e: e.year)
    agree = sum(1 for e in kept if abs(e.year - best.year) <= 1)
    conf = "high" if top >= 3 or (top == 2 and agree >= 2) else "medium" if top == 2 else "low"
    return best.year, best.source, conf, shown


def _evidence(found: dict[str, int], it: Item) -> list[Evidence]:
    ev = [Evidence(y, s) for s, y in found.items() if y]
    weak_date = it.release_date is not None and it.date_kind != "release"
    if it.release_date and not weak_date:
        ev.append(Evidence(it.release_date.year, "release-date"))
    if it.stated_year and not (it.release_date and not weak_date):
        ev.append(Evidence(it.stated_year, "ytmusic-year"))   # the artist page states the year of the single/album
    yt = year_of((it.youtube or {}).get("year"))
    if yt:
        ev.append(Evidence(yt, "youtube"))
    if it.release_date and weak_date and any(s.startswith("rss") for s in it.sources):
        ev.append(Evidence(it.release_date.year, "feed-date"))
    return ev


def _load_cache() -> dict:
    today_s = date.today().isoformat()
    cache: dict = read_json(YEAR_CACHE, {})
    for v in cache.values():          # rows written before the prune existed start their clock now
        if isinstance(v, dict):
            v.setdefault("seen", today_s)
    return cache


def _save_cache(cache: dict, cfg: dict) -> None:
    from .resolve import prune_cache
    keep_days = int((cfg.get("resolve") or {}).get("cache_keep_days", 120))
    write_json(YEAR_CACHE, prune_cache(cache, date.today(), keep_days), compact=True)


def verify_years(items: list[Item], cfg: dict, http, deadline: Deadline | None = None, yt=None) -> None:
    """Give every item its year (see the module docstring). `yt` is the YouTube Music client for the release-date
    fallback; when None it is opened on first need (and skipped when ytmusicapi is not installed)."""
    rcfg = cfg.get("resolve") or {}
    budget = int(rcfg.get("max_year_lookups_per_run", 500))
    yt_budget = int(rcfg.get("max_ytmusic_date_lookups_per_run", 200) or 0) if rcfg.get("youtube_music", True) else 0
    deadline = deadline or Deadline(None)
    cache = _load_cache()
    today_s = date.today().isoformat()
    looked = 0
    skipped_deadline = 0
    yt_looked = yt_found = 0
    yt_client = [yt]

    def client():
        if yt_client[0] is None:
            from .resolve import ytmusic
            try:
                yt_client[0] = ytmusic(cfg)
            except ImportError:
                log.warning("ytmusicapi not installed; no YouTube Music release dates for the undated tracks")
                yt_client[0] = False
        return yt_client[0] or None
    # reissues first (their own dates are known to be wrong), then undated tracks (they'd otherwise have nothing),
    # then by score; the cache carries the rest to later runs
    infos = {id(i): reissue_info(i) for i in items}
    rank = lambda i: 0 if infos[id(i)].strength == "strong" else 1 if (infos[id(i)].strength or i.release_date is None or i.date_kind != "release") else 2  # noqa: E731
    order = sorted(items, key=lambda i: (rank(i), -i.score))
    reissues = 0
    for it in order:
        ri = infos[id(it)]
        title = base_title(it.title) if ri.strength else it.title
        lookup_title = format_title(title, None, it.remixer, it.remix_kind)   # base title + remix suffix, never "feat."
        entry = cache.get(it.key)
        # a reissue looked up before this knew about reissues (under the remaster's title, part of the chain) is asked again
        stale = entry is not None and bool(ri.strength) and not entry.get("reissue")
        if (entry is None or entry.get("v") != CACHE_VERSION or stale) and it.kind == "track" and looked < budget:
            if deadline.expired:
                skipped_deadline += 1
            else:
                looked += 1
                reissues += bool(ri.strength)
                entry = lookup_track(http, it.artist, lookup_title, cfg, reissue=bool(ri.strength))
                cache[it.key] = entry
                if looked % FLUSH_EVERY == 0:
                    _save_cache(cache, cfg)
        if entry is not None:
            entry["seen"] = today_s
        found = (entry or {}).get("found") or {}
        if entry and entry.get("v") != CACHE_VERSION:   # legacy entry shape: {"mb":..,"dz":..,"it":..}
            found = {k: v for k, v in (("musicbrainz-search", entry.get("mb")), ("deezer", entry.get("dz")), ("itunes", entry.get("it"))) if v}
        # still unsure after the catalogues (this run's lookup or the cached one): the date YouTube Music states for the
        # upload is the last option, asked for once per video and kept with the entry
        # (never for a reissue: YouTube Music dates the reissue)
        if (entry is not None and entry.get("v") == CACHE_VERSION and it.kind == "track" and ri.strength != "strong" and unsure(found, it)
                and _ytdate_wanted(it, entry) and yt_looked < yt_budget and not deadline.expired and client() is not None):
            yt_looked += 1
            d = ytmusic_release_date(client(), it.youtube["videoId"])
            entry["ytdate"] = {"video": it.youtube["videoId"], "date": d}
            if yt_looked % FLUSH_EVERY == 0:
                _save_cache(cache, cfg)
        ytdate = (entry or {}).get("ytdate") or {}
        if ytdate.get("video") and ytdate.get("video") == (it.youtube or {}).get("videoId") and year_of(ytdate.get("date")):
            found = {**found, "ytmusic-date": year_of(ytdate["date"])}
            yt_found += 1
        year, source, conf, ev = decide(found, it)
        if entry is None and year is None and it.kind == "track":
            source = "pending"          # not looked up yet (budget or deadline): the site says so instead of "unknown"
        it.year, it.year_source, it.year_confidence = year, source, conf
        it.year_evidence = [f"{LABEL.get(e.source, e.source)}: {e.year}" + (f" ({e.note})" if e.note else "") for e in ev]
        it.original_year = it.reissue_year = None
        stated = it.release_date.year if (it.release_date and it.date_kind == "release") else None
        product = max((e.year for e in ev if e.source in _PRODUCT), default=None)
        if ri.strength == "strong":
            it.reissue_year = _reissue_cut(ev, ri)[0] or product
            if year and it.reissue_year and year < it.reissue_year:
                it.original_year = year        # filed under the original; the badge names the reissue
        elif stated and year and year < stated - 1:
            it.original_year, it.reissue_year = year, stated   # the source announced a reissue; we found the original
        elif ri.strength == "weak" and year and product and year < product - 1:
            it.original_year, it.reissue_year = year, product  # a deluxe / expanded edition of an older record
        elif year and (yt := year_of((it.youtube or {}).get("year"))) and yt < year - 1:
            it.original_year = yt
    _save_cache(cache, cfg)
    if skipped_deadline:
        log.warning("years: time budget reached; %d recordings left for the next run", skipped_deadline)
    log.info("years: %d reissues looked up under their original title", reissues)
    log.info("years: %d recordings looked up this run (%d cached); %d asked YouTube Music for the upload's release date, %d dated by it",
             looked, len(cache), yt_looked, yt_found)


def decide_found(found: dict[str, int], ri: Reissue | None = None) -> tuple[int | None, str | None]:
    """Earliest year from the most trusted tier of catalogue evidence (no item context).

    For a song the playlists hold as a remaster / reissue / anniversary or deluxe edition, a catalogue answer can be
    the reissue itself: a year at or after a remaster named in a title ("2011 Remaster") is dropped, and the earliest
    year any catalogue or store knows wins across tiers — the Cleanup tab moves copies into this year, so it must be
    the original's."""
    ev = [Evidence(y, s) for s, y in (found or {}).items() if y and TRUST.get(s, 0) >= 2]
    if ri and ri.strength:
        cut = min(ri.tag_years) if ri.tag_years else None
        ev = [e for e in ev if cut is None or e.year < cut]
        if not ev:
            return None, None
        best = min(ev, key=lambda e: (e.year, -e.trust))
        return best.year, best.source
    if not ev:
        return None, None
    top = max(e.trust for e in ev)
    best = min((e for e in ev if e.trust == top), key=lambda e: e.year)
    return best.year, best.source


def annotate_duplicate_years(dups: list[dict], cfg: dict, http, deadline: Deadline | None = None) -> int:
    """Attach the catalogue-verified year to duplicate reports so the wrong-year copy is obvious.

    Songs already verified for the feed come free from the cache (same key). Otherwise a bounded number of
    songs filed in more than one year are looked up per run; the rest follow on later runs."""
    rcfg = cfg.get("resolve") or {}
    budget = int(rcfg.get("max_duplicate_year_lookups_per_run", 120))
    deadline = deadline or Deadline(None)
    cache = _load_cache()
    today_s = date.today().isoformat()
    looked = 0
    # a song filed in more than one year is what a verified year settles: those are looked up first, the exact
    # same video in two years before two different uploads of it
    spans = lambda d: len(d.get("years") or []) > 1   # noqa: E731
    order = sorted(dups, key=lambda d: (0 if "cross-year" in (d.get("kinds") or [d.get("kind")]) else 1 if spans(d) else 2, -int(d["years"][0]) if d.get("years") else 0))
    for d in order:
        k = item_key(d["artist"], d["title"])          # same key the feed uses, so feed verifications come free
        entry = cache.get(k)
        # a copy that is a remaster / reissue / deluxe edition (its title or album says so): the original is looked
        # up under the base title through the whole chain, and an entry from before that is asked again
        ri = reissue_of([d.get("title")] + [x for e in d.get("entries") or [] for x in (e.get("title"), e.get("album"))])
        stale = entry is not None and bool(ri.strength) and not entry.get("reissue")
        if (entry is None or entry.get("v") != CACHE_VERSION or stale) and looked < budget and spans(d) and not deadline.expired:
            looked += 1
            entry = lookup_track(http, d["artist"], base_title(d["title"]) if ri.strength else d["title"], cfg, reissue=bool(ri.strength))
            cache[k] = entry
            if looked % FLUSH_EVERY == 0:
                _save_cache(cache, cfg)
        d.pop("verified_year", None)
        d.pop("verified_source", None)
        if entry and entry.get("v") == CACHE_VERSION:
            entry["seen"] = today_s
            y, src = decide_found(entry.get("found") or {}, ri)
            if y:
                d["verified_year"], d["verified_source"] = y, LABEL.get(src, src) + (" · original of a reissue" if ri.strength else "")
    _save_cache(cache, cfg)
    log.info("duplicate report: %d songs filed in more than one year verified this run", looked)
    return looked
