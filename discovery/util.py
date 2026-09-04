"""Shared helpers: HTTP with caching/rate limiting, name normalisation, paths, logging."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import time
import unicodedata
from datetime import date, datetime, timedelta, timezone
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
    "IndieDiscothequeDiscovery/1.0 (+https://chrisrohn.com; music discovery feed)",
)


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


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def today() -> date:
    return utcnow().date()


def parse_date(value: Any) -> date | None:
    """Parse many date shapes ("2026-09-04", "2026-09", "2026", "04 Sep 2026", epoch) into a date."""
    if value in (None, "", 0):
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc).date()
        except (OverflowError, ValueError, OSError):
            return None
    s = str(value).strip()
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ", "%d %b %Y", "%d %B %Y", "%Y-%m", "%Y"):
        try:
            return datetime.strptime(s[:len(datetime.now().strftime(fmt))] if fmt in ("%Y-%m", "%Y") else s, fmt).date()
        except ValueError:
            continue
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        try:
            return date(int(m[1]), int(m[2]), int(m[3]))
        except ValueError:
            return None
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


def split_artists(credit: str | None) -> list[str]:
    """'A & B feat. C' -> ['A', 'B', 'C']"""
    if not credit:
        return []
    parts = re.split(r"\s*(?:,|&|\+|/|\bfeat\.?(?=\s)|\bft\.?(?=\s)|\bfeaturing\b|\bwith\b|\bx\b|\bvs\.?(?=\s)|\band\b)\s*", credit, flags=re.I)
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
    return hashlib.sha1(f"{norm(artist)}|{norm_track(title)}".encode("utf-8")).hexdigest()[:16]


def parse_artist_title(text: str) -> tuple[str, str] | None:
    """Best-effort split of a blog headline like 'Artist – "Song"' or 'Artist - Song'."""
    if not text:
        return None
    t = re.sub(r"\s+", " ", text).strip()
    t = re.sub(r"^(new music|listen|premiere|watch|stream|hear|video|track review|song of the day)\s*[:\-–—]\s*", "", t, flags=re.I)
    m = re.match(r"^(?P<a>.+?)\s+[-–—:]\s+[\"“']?(?P<t>.+?)[\"”']?\s*(\([^)]*\))?$", t)
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
        }
        self._dirty = False

    def _throttle(self, host: str) -> None:
        interval = self.min_interval.get(host, 0.1)
        with self._lock:
            last = self._last_call.get(host, 0.0)
            wait = interval - (time.monotonic() - last)
            if wait > 0:
                time.sleep(wait)
            self._last_call[host] = time.monotonic()

    def _cache_key(self, method: str, url: str, params: Any, body: Any) -> str:
        raw = json.dumps([method, url, params, body], sort_keys=True, default=str)
        return hashlib.sha1(raw.encode()).hexdigest()

    def request(self, method: str, url: str, *, params: dict | None = None, json_body: Any = None,
                headers: dict | None = None, cache: bool = True, retries: int = 3, timeout: int = 30,
                as_json: bool = True) -> Any:
        key = self._cache_key(method, url, params, json_body)
        if cache and key in self.cache:
            entry = self.cache[key]
            if utcnow() - datetime.fromisoformat(entry["at"]) < self.ttl:
                return entry["data"]
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
                retry_after = float(resp.headers.get("Retry-After", backoff))
                log.warning("%s %s -> %s; retrying in %.1fs", method, url, resp.status_code, retry_after)
                time.sleep(min(retry_after, 30))
                backoff *= 2
                continue
            resp.raise_for_status()
            data = resp.json() if as_json else resp.text
            if cache:
                self.cache[key] = {"at": utcnow().isoformat(), "data": data}
                self._dirty = True
            return data
        raise RuntimeError("unreachable")

    def get(self, url: str, **kw: Any) -> Any:
        return self.request("GET", url, **kw)

    def post(self, url: str, **kw: Any) -> Any:
        return self.request("POST", url, **kw)

    def save(self) -> None:
        if not self._dirty:
            return
        cutoff = utcnow() - self.ttl
        self.cache = {k: v for k, v in self.cache.items() if datetime.fromisoformat(v["at"]) > cutoff}
        write_json(self.cache_path, self.cache, compact=True)
        self._dirty = False
