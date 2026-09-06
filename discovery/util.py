"""Shared helpers: HTTP with caching/rate limiting, name normalisation, paths, logging."""
from __future__ import annotations

import calendar
import hashlib
import json
import logging
import os
import re
import threading
import time
import unicodedata
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import requests
import yaml

log = logging.getLogger("discovery")

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CACHE_DIR = DATA_DIR / "cache"
SITE_DIR = ROOT / "site"
SITE_DATA_DIR = SITE_DIR / "data"
CONFIG_PATH = Path(__file__).resolve().parent / "config.yaml"

USER_AGENT = os.environ.get(
    "DISCOVERY_USER_AGENT",
    "ChrisRohnNewMusic/1.0 (+https://chrisrohn.com; new-music discovery feed)",
)
# Blog CMSs and their CDNs (WordPress hosts, Cloudflare bot rules) answer 403/415 to unknown agents but serve RSS to
# browsers. Catalogue APIs (MusicBrainz, ListenBrainz, Discogs) get the honest USER_AGENT above, as they require.
BROWSER_USER_AGENT = os.environ.get(
    "DISCOVERY_BROWSER_USER_AGENT",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
)
PROFILE_VERSION = 2   # bump when profile.json's shape or meaning changes; `daily` then rebuilds it regardless of age
ETAG_VERSION = 1          # data/cache/feed_etags.json: url -> {etag, last_modified, body, at}
ETAG_BODY_MAX = 400_000   # bytes of feed text kept per URL for the 304 path
ETAG_KEEP_DAYS = 45       # validators for a feed nobody has fetched this long are dropped


def setup_logging() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def load_config() -> dict[str, Any]:
    with CONFIG_PATH.open("r", encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def ensure_dirs() -> None:
    for d in (DATA_DIR, CACHE_DIR, SITE_DATA_DIR, SITE_DATA_DIR / "history"):
        d.mkdir(parents=True, exist_ok=True)


def read_json(path: Path, default: Any) -> Any:
    try:
        with path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path: Path, data: Any, *, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        if compact:
            json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(data, fh, ensure_ascii=False, indent=1, sort_keys=False)
    tmp.replace(path)


def read_versioned(path: Path, version: int, default: Any, migrate: Callable[[dict, int], Any] | None = None) -> Any:
    """A JSON map stamped with a schema version ("v"), like resolve.CACHE_VERSION does per row.

    The stamp is stripped from what is returned. A file written before stamps existed counts as version 1, so an
    existing cache survives the first run of the code that started stamping it. When the version differs, `migrate`
    (old map, old version) → new map may rescue the content; otherwise the file is discarded and `default` returned."""
    data = read_json(path, None)
    if not isinstance(data, dict):
        return default
    found = data.pop("v", 1)
    if found == version:
        return data
    if migrate is not None:
        try:
            migrated = migrate(data, found)
        except Exception as exc:  # noqa: BLE001
            log.warning("cache %s: migration from v%s failed (%s); starting over", path.name, found, exc)
            migrated = None
        if migrated is not None:
            log.info("cache %s: migrated v%s → v%s", path.name, found, version)
            return migrated
    log.info("cache %s: version %s, want %s; starting over", path.name, found, version)
    return default


def write_versioned(path: Path, version: int, data: dict) -> None:
    write_json(path, {"v": version, **data}, compact=True)


NEGATIVE_CACHE_DAYS = 30   # a lookup that found nothing is asked again after this long (new artists appear on catalogues)


def miss_row(when: date | None = None) -> dict:
    """The cached shape of a lookup that found nothing: {"miss": "<date>"}; `miss_expired` says when to retry."""
    return {"miss": (when or date.today()).isoformat()}


def miss_expired(row: Any, days: int = NEGATIVE_CACHE_DAYS, now: date | None = None) -> bool:
    """True for a miss row older than `days` (or one whose date cannot be read): look the name up again."""
    if not isinstance(row, dict) or "miss" not in row:
        return False
    when = parse_date(row.get("miss"))
    return when is None or (now or date.today()) - when > timedelta(days=days)


def source_days(cfg: dict, key: str, default: int = 10) -> int:
    """Look-back window for a source: its own `days`, else `sources.listenbrainz_fresh.days`, else `default`."""
    sources = cfg.get("sources") or {}
    own = (sources.get(key) or {}).get("days")
    if own:
        return int(own)
    shared = (sources.get("listenbrainz_fresh") or {}).get("days")
    return int(shared) if shared else int(default)


def parse_retry_after(value: Any, fallback: float) -> float:
    """Seconds to wait from a Retry-After header: an integer count or an HTTP-date (RFC 9110 §10.2.3); `fallback`
    when the header is missing or unreadable. Never raises."""
    if value is None:
        return fallback
    s = str(value).strip()
    if not s:
        return fallback
    try:
        return max(0.0, float(s))
    except ValueError:
        pass
    try:
        from email.utils import parsedate_to_datetime

        when = parsedate_to_datetime(s)
        if when.tzinfo is None:
            when = when.replace(tzinfo=UTC)
        return max(0.0, (when - utcnow()).total_seconds())
    except Exception:  # noqa: BLE001
        return fallback


def utcnow() -> datetime:
    return datetime.now(UTC)


class Deadline:
    """Wall-clock budget for the slow, rate-limited lookup loops (MusicBrainz is 1 request/s). GitHub Actions kills the
    job at `timeout-minutes`, so the loops stop themselves first and leave the rest for the next run."""

    def __init__(self, minutes: float | None):
        self.until = time.monotonic() + minutes * 60 if minutes else None

    @property
    def expired(self) -> bool:
        return self.until is not None and time.monotonic() > self.until

    @property
    def remaining_minutes(self) -> float:
        return max(0.0, (self.until - time.monotonic()) / 60) if self.until else float("inf")


def struct_time_to_date(st) -> date | None:
    """feedparser's *_parsed fields are UTC struct_times; time.mktime would read them as local time."""
    try:
        return datetime.fromtimestamp(calendar.timegm(st), tz=UTC).date()
    except (TypeError, ValueError, OverflowError):
        return None


def safe_url(url: Any) -> str | None:
    """Only http(s) links may reach the site (they end up in href attributes). Feeds are the one untrusted input."""
    if isinstance(url, (list, tuple)):
        url = url[0] if url else None
    if not isinstance(url, str):
        return None
    u = url.strip()
    return u if re.match(r"^https?://[^\s<>\"']+$", u, re.I) else None


def today() -> date:
    return utcnow().date()


def parse_date(value: Any) -> date | None:
    """Parse many date shapes ("2026-09-04", "2026-09", "2026", "04 Sep 2026", epoch) into a date."""
    if value in (None, "", 0):
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value), tz=UTC).date()
        except (OverflowError, ValueError, OSError):
            return None
    s = str(value).strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)          # 2026-09-04, 2026-09-04T10:00:00Z, ...
    if m:
        try:
            return date(int(m[1]), int(m[2]), int(m[3]))
        except ValueError:
            return None
    m = re.fullmatch(r"(\d{4})-(\d{2})", s)                # 2026-09  (MusicBrainz partial dates)
    if m:
        try:
            return date(int(m[1]), int(m[2]), 1)
        except ValueError:
            return None
    if re.fullmatch(r"\d{4}", s):                           # 2026
        return date(int(s), 1, 1)
    for fmt in ("%d %b %Y", "%d %B %Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    try:
        from email.utils import parsedate_to_datetime

        return parsedate_to_datetime(s).date()
    except (TypeError, ValueError, IndexError):
        return None


_PUNCT_RE = re.compile(r"[^\w\s]")
_SPACE_RE = re.compile(r"\s+")
_FEAT_RE = re.compile(r"\s*[\(\[]?\s*(feat\.?|ft\.?|featuring|with)\s+[^\)\]]*[\)\]]?\s*$", re.I)
_SUFFIX_RE = re.compile(
    r"\s*[\(\[\-–—]\s*(official|radio edit|single version|album version|(\d{4} )?remaster(ed)?( \d{4})?|remastered version|"
    r"explicit|clean|mono|stereo|lyric video|official (music )?video|audio|visualizer|hq|hd|"
    r"\d+(st|nd|rd|th)[ -]anniversary( edition| version| remaster)?|anniversary edition|deluxe( edition| version)?|"
    r"expanded( edition)?|bonus track( version)?|reissue|re-issue|original mix|extended( mix| version)?|edit)\s*[\)\]]?\s*$",
    re.I,
)


def strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def norm(s: str | None) -> str:
    """Aggressive normaliser for matching artist/track names."""
    if not s:
        return ""
    s = strip_accents(str(s)).lower().replace("&", "and")
    s = _PUNCT_RE.sub(" ", s)
    s = _SPACE_RE.sub(" ", s).strip()
    if s.startswith("the "):
        s = s[4:]
    return s


def norm_track(s: str | None) -> str:
    if not s:
        return ""
    s = str(s)
    for _ in range(4):  # peel stacked suffixes: "Song (Remastered) [Deluxe Edition]"
        stripped = _SUFFIX_RE.sub("", s)
        stripped = _FEAT_RE.sub("", stripped)
        if stripped == s:
            break
        s = stripped
    return norm(s)


_SPLIT_LOOSE = re.compile(r"\s*(?:,|&|\+|/|\bfeat\.?(?=\s)|\bft\.?(?=\s)|\bfeaturing\b|\bwith\b|\bx\b|\bvs\.?(?=\s)|\band\b)\s*", re.I)
_SPLIT_STRICT = re.compile(r"\s*(?:,|&|\+|/|\bfeat\.?(?=\s)|\bft\.?(?=\s)|\bfeaturing\b|\bvs\.?(?=\s))\s*", re.I)


def split_artists(credit: str | None, *, strict: bool = False) -> list[str]:
    """'A & B feat. C' -> ['A', 'B', 'C'].

    strict=True only splits on the separators a credit really uses (comma, &, +, /, feat., vs.) and leaves "and",
    "with" and "x" alone, so "Belle and Sebastian" or "Florence + the Machine x Kid" cannot turn into a match on
    "Belle" or "Kid" against some unrelated profile artist."""
    if not credit:
        return []
    parts = (_SPLIT_STRICT if strict else _SPLIT_LOOSE).split(credit)
    return [p.strip() for p in parts if p and p.strip()]


_FEAT_ANY_RE = re.compile(r"\s*[\(\[]?\s*\b(?:feat\.?|ft\.?|featuring|with)\s+(?P<who>[^\)\]\(\[]+?)\s*[\)\]]?\s*(?=[\(\[]|$)", re.I)
_REMIX_RE = re.compile(
    r"\s*[\(\[\-–—]\s*(?P<who>[^\(\)\[\]]+?)\s+(?P<kind>remix|rework|re-work|edit|re-edit|dub|bootleg|flip|refix|rerub|version|mix|remake|vip)\s*[\)\]]?\s*$",
    re.I,
)
_REMIX_KIND = {"re-work": "Rework", "re-edit": "Re-edit", "vip": "VIP"}


def parse_credit(artist: str, title: str) -> dict:
    """Split a raw (artist, title) into Rohn Standard Notation parts.

    Standard:            Artist - Song Title
    Remix:               Artist - Song Title (Remixartist Remix)
    Featuring:           Artist - Song Title feat. Subartist
    Featuring + Remix:   Artist - Song Title feat. Subartist (Remixartist Remix)
    """
    artist = re.sub(r"\s+", " ", artist or "").strip()
    title = re.sub(r"\s+", " ", title or "").strip()
    featuring: list[str] = []
    remixer: str | None = None
    kind: str | None = None

    # featured artists hiding in the artist credit: "A feat. B", "A ft. B & C"
    m = re.search(r"\s+(?:feat\.?|ft\.?|featuring)\s+(.+)$", artist, re.I)
    if m:
        featuring += [x.strip() for x in re.split(r"\s*(?:,|&|\band\b)\s*", m.group(1)) if x.strip()]
        artist = artist[: m.start()].strip()

    # remix suffix first (it sits at the very end), then featured artists anywhere in the title
    m = _REMIX_RE.search(title)
    if m:
        remixer = m.group("who").strip(" -–—")
        k = m.group("kind").lower()
        kind = _REMIX_KIND.get(k, k.capitalize())
        title = title[: m.start()].strip()
    for m in list(_FEAT_ANY_RE.finditer(title))[::-1]:
        featuring[0:0] = [x.strip() for x in re.split(r"\s*(?:,|&|\band\b)\s*", m.group("who")) if x.strip()]
        title = (title[: m.start()] + title[m.end():]).strip()
    # tidy leftovers like "Song ()" / trailing dashes
    title = re.sub(r"\s*[\(\[]\s*[\)\]]", "", title).strip(" -–—")
    seen: list[str] = []
    for f in featuring:
        if f.lower() not in {x.lower() for x in seen} and f.lower() != artist.lower():
            seen.append(f)
    return {"artist": artist, "title": title, "featuring": seen, "remixer": remixer, "remix_kind": kind}


def format_title(title: str, featuring: list[str] | None, remixer: str | None, remix_kind: str | None) -> str:
    """Title part of the notation: 'Song Title feat. A & B (X Remix)'."""
    out = title or ""
    if featuring:
        out += " feat. " + " & ".join(featuring)
    if remixer:
        out += f" ({remixer} {remix_kind or 'Remix'})"
    return out


def format_credit(artist: str, title: str, featuring: list[str] | None = None, remixer: str | None = None, remix_kind: str | None = None) -> str:
    return f"{artist} - {format_title(title, featuring, remixer, remix_kind)}"


def item_key(artist: str, title: str) -> str:
    return hashlib.sha1(f"{norm(artist)}|{norm_track(title)}".encode()).hexdigest()[:16]


def parse_artist_title(text: str) -> tuple[str, str] | None:
    """Best-effort split of a blog headline like 'Artist – "Song"' or 'Artist - Song'."""
    if not text:
        return None
    t = re.sub(r"\s+", " ", text).strip()
    t = re.sub(r"^(new music|listen|premiere|watch|stream|hear|video|track review|song of the day)\s*[:\-–—]\s*", "", t, flags=re.I)
    # "Artist – Song", "Artist :: Song" (Aquarium Drunkard), or 'Artist: "Song"' — a bare colon is a headline, not a credit
    m = re.match(r"^(?P<a>.+?)(?:\s+[-–—]\s+|\s*::\s*|:\s+(?=[\"“]))[\"“']?(?P<t>.+?)[\"”']?\s*(\([^)]*\))?$", t)
    if not m:
        m = re.match(r"^(?P<a>.+?)\s+[\"“](?P<t>[^\"”]+)[\"”]", t)
    if not m:
        return None
    a, tt = m.group("a").strip(), m.group("t").strip()
    a = re.sub(r"\s*(share|premiere|release|drop|announce|unveil)s?\b.*$", "", a, flags=re.I).strip()
    if not a or not tt or len(a) > 60 or len(tt) > 120:
        return None
    return a, tt


class Http:
    """Small requests wrapper with per-host rate limiting and an on-disk JSON cache."""

    def __init__(self, cache_name: str = "http", ttl_hours: float = 20.0):
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json, */*;q=0.5"})
        self.ttl = timedelta(hours=ttl_hours)
        self.cache_path = CACHE_DIR / f"{cache_name}.json"
        self.cache: dict[str, Any] = read_json(self.cache_path, {})
        self._last_call: dict[str, float] = {}
        self._lock = threading.Lock()
        self.min_interval: dict[str, float] = {
            "musicbrainz.org": 1.05,
            "api.listenbrainz.org": 0.35,
            "labs.api.listenbrainz.org": 0.35,
            "ws.audioscrobbler.com": 0.25,
            "api.deezer.com": 0.25,
            "bandcamp.com": 1.0,
            "itunes.apple.com": 3.2,   # ~20 requests/minute
            "api.discogs.com": 1.1,    # 60 requests/minute with a token
        }
        self._dirty = False
        # conditional GETs (feeds): url -> {"etag", "last_modified", "body", "at"}, loaded on first use
        self.etag_path = CACHE_DIR / "feed_etags.json"
        self._etags: dict[str, dict] | None = None
        self._etags_dirty = False

    def _throttle(self, host: str) -> None:
        """Reserve the next slot for `host` under the lock, then sleep *outside* it, so concurrent fetchers of other
        hosts are never held up by one host's rate limit."""
        interval = self.min_interval.get(host, 0.1)
        with self._lock:
            now = time.monotonic()
            slot = max(now, self._last_call.get(host, 0.0) + interval)
            self._last_call[host] = slot
        wait = slot - now
        if wait > 0:
            time.sleep(wait)

    def _etag_store(self) -> dict[str, dict]:
        with self._lock:
            if self._etags is None:
                data = read_versioned(self.etag_path, ETAG_VERSION, {})
                self._etags = data if isinstance(data, dict) else {}
            return self._etags

    def _cache_key(self, method: str, url: str, params: Any, body: Any) -> str:
        raw = json.dumps([method, url, params, body], sort_keys=True, default=str)
        return hashlib.sha1(raw.encode()).hexdigest()

    def request(self, method: str, url: str, *, params: dict | None = None, json_body: Any = None,
                headers: dict | None = None, cache: bool = True, retries: int = 3, timeout: int = 30,
                as_json: bool = True, conditional: bool = False) -> Any:
        """`conditional=True` (text GETs of feeds): send If-None-Match / If-Modified-Since from the stored validators
        for this URL and, on 304 Not Modified, return the body stored with them (data/cache/feed_etags.json, bodies
        capped at ETAG_BODY_MAX so the file stays small)."""
        key = self._cache_key(method, url, params, json_body)
        if cache and key in self.cache:
            entry = self.cache[key]
            if utcnow() - datetime.fromisoformat(entry["at"]) < self.ttl:
                return entry["data"]
        prior: dict | None = None
        if conditional and not as_json and method.upper() == "GET":
            prior = self._etag_store().get(url)
            if prior and prior.get("body") is not None:
                headers = dict(headers or {})
                if prior.get("etag"):
                    headers.setdefault("If-None-Match", prior["etag"])
                if prior.get("last_modified"):
                    headers.setdefault("If-Modified-Since", prior["last_modified"])
            else:
                prior = None
        host = requests.utils.urlparse(url).hostname or ""
        backoff = 2.0
        for attempt in range(retries + 1):
            self._throttle(host)
            try:
                resp = self.session.request(method, url, params=params, json=json_body, headers=headers, timeout=timeout)
            except requests.RequestException as exc:
                if attempt == retries:
                    raise
                log.warning("%s %s failed (%s); retrying", method, url, exc)
                time.sleep(backoff)
                backoff *= 2
                continue
            if resp.status_code in (429, 500, 502, 503, 504) and attempt < retries:
                retry_after = parse_retry_after(resp.headers.get("Retry-After"), backoff)
                log.warning("%s %s -> %s; retrying in %.1fs", method, url, resp.status_code, retry_after)
                time.sleep(min(retry_after, 30))
                backoff *= 2
                continue
            if resp.status_code == 304 and prior is not None:
                log.debug("GET %s: not modified", url)
                return prior["body"]
            resp.raise_for_status()
            data = resp.json() if as_json else resp.text
            if conditional and not as_json and method.upper() == "GET":
                self._remember_validators(url, resp, data)
            if cache:
                with self._lock:
                    self.cache[key] = {"at": utcnow().isoformat(), "data": data}
                    self._dirty = True
            return data
        raise RuntimeError("unreachable")

    def _remember_validators(self, url: str, resp: Any, body: str) -> None:
        etag, last_modified = resp.headers.get("ETag"), resp.headers.get("Last-Modified")
        store = self._etag_store()
        with self._lock:
            if (etag or last_modified) and isinstance(body, str) and len(body.encode("utf-8", "ignore")) <= ETAG_BODY_MAX:
                store[url] = {"etag": etag, "last_modified": last_modified, "body": body, "at": utcnow().isoformat()}
                self._etags_dirty = True
            elif url in store:            # the feed dropped its validators or outgrew the cap: stop asking
                del store[url]
                self._etags_dirty = True

    def get(self, url: str, **kw: Any) -> Any:
        return self.request("GET", url, **kw)

    def post(self, url: str, **kw: Any) -> Any:
        return self.request("POST", url, **kw)

    def save(self) -> None:
        with self._lock:
            if self._etags_dirty and self._etags is not None:
                cutoff = (utcnow() - timedelta(days=ETAG_KEEP_DAYS)).isoformat()
                self._etags = {u: e for u, e in self._etags.items() if (e.get("at") or "") >= cutoff}
                write_versioned(self.etag_path, ETAG_VERSION, self._etags)
                self._etags_dirty = False
            if not self._dirty:
                return
            cutoff_dt = utcnow() - self.ttl
            self.cache = {k: v for k, v in self.cache.items() if datetime.fromisoformat(v["at"]) > cutoff_dt}
            write_json(self.cache_path, self.cache, compact=True)
            self._dirty = False
