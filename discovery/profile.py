"""Build the Indie Discotheque taste profile.

Inputs (all free):
  * Last.fm  – user.getTopArtists for `tt_discotheque` over several periods, artist.getSimilar, artist.getTopTags
  * ListenBrainz labs – similar-artists graph (by MusicBrainz artist id)
  * MusicBrainz – artist MBID lookup (cached forever in data/cache/artists.json)
  * Your public YouTube Music year playlists – artists you already saved (strong positive signal + de-dupe list)
  * Optional frozen Everynoise genre pages (`python -m discovery seed-everynoise`)

Output: data/profile.json
  {"artists": {norm_name: {"name", "affinity", "kind": "direct"|"similar", "mbid", "via"}},
   "tags": {tag: weight}, "saved": {item_key: {...}}, "built_at": iso}
"""
from __future__ import annotations

import math
import os
import re
from collections import defaultdict
from datetime import date
from typing import Any

from .util import CACHE_DIR, DATA_DIR, Http, log, norm, norm_track, item_key, read_json, utcnow, write_json

LASTFM_API = "https://ws.audioscrobbler.com/2.0/"
LB_LABS_SIMILAR = "https://labs.api.listenbrainz.org/similar-artists/json"
LB_SIMILAR_ALGORITHM = os.environ.get(
    "LB_SIMILAR_ALGORITHM",
    "session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30",
)
MB_API = "https://musicbrainz.org/ws/2"

ARTIST_CACHE_PATH = CACHE_DIR / "artists.json"
PROFILE_PATH = DATA_DIR / "profile.json"


class LastFm:
    def __init__(self, http: Http, api_key: str | None):
        self.http = http
        self.key = api_key

    @property
    def enabled(self) -> bool:
        return bool(self.key)

    def call(self, method: str, **params: Any) -> dict:
        if not self.key:
            return {}
        params.update({"method": method, "api_key": self.key, "format": "json"})
        try:
            data = self.http.get(LASTFM_API, params=params)
        except Exception as exc:  # noqa: BLE001
            log.warning("last.fm %s failed: %s", method, exc)
            return {}
        if isinstance(data, dict) and data.get("error"):
            log.warning("last.fm %s error: %s", method, data.get("message"))
            return {}
        return data or {}

    def top_artists(self, user: str, period: str, limit: int) -> list[dict]:
        out: list[dict] = []
        page = 1
        while len(out) < limit:
            data = self.call("user.gettopartists", user=user, period=period, limit=min(200, limit - len(out)), page=page)
            arts = (data.get("topartists") or {}).get("artist") or []
            if not arts:
                break
            out.extend(arts)
            attrs = (data.get("topartists") or {}).get("@attr") or {}
            if page >= int(attrs.get("totalPages", 1) or 1):
                break
            page += 1
        return out[:limit]

    def similar(self, artist: str, limit: int) -> list[dict]:
        data = self.call("artist.getsimilar", artist=artist, limit=limit, autocorrect=1)
        return (data.get("similarartists") or {}).get("artist") or []

    def top_tags(self, artist: str) -> list[dict]:
        data = self.call("artist.gettoptags", artist=artist, autocorrect=1)
        return (data.get("toptags") or {}).get("tag") or []


class ArtistIds:
    """Persistent name -> MusicBrainz id map (MB search is 1 req/s, so cache for good)."""

    def __init__(self, http: Http):
        self.http = http
        self.cache: dict[str, Any] = read_json(ARTIST_CACHE_PATH, {})
        self.dirty = False

    def mbid(self, name: str, hint: str | None = None) -> str | None:
        n = norm(name)
        if not n:
            return None
        if hint and re.fullmatch(r"[0-9a-f-]{36}", hint):
            if self.cache.get(n) != hint:
                self.cache[n] = hint
                self.dirty = True
            return hint
        if n in self.cache:
            return self.cache[n] or None
        try:
            data = self.http.get(f"{MB_API}/artist/", params={"query": f'artist:"{name}"', "fmt": "json", "limit": 3})
        except Exception as exc:  # noqa: BLE001
            log.debug("MB artist lookup failed for %s: %s", name, exc)
            return None
        best = None
        for a in data.get("artists") or []:
            if norm(a.get("name")) == n or int(a.get("score", 0)) >= 95:
                best = a
                break
        self.cache[n] = best.get("id") if best else None
        self.dirty = True
        return self.cache[n]

    def save(self) -> None:
        if self.dirty:
            write_json(ARTIST_CACHE_PATH, self.cache, compact=True)
            self.dirty = False


def listenbrainz_similar(http: Http, mbid: str, limit: int) -> list[dict]:
    try:
        data = http.get(LB_LABS_SIMILAR, params={"artist_mbids": mbid, "algorithm": LB_SIMILAR_ALGORITHM})
    except Exception as exc:  # noqa: BLE001
        log.debug("LB similar failed for %s: %s", mbid, exc)
        return []
    rows = data if isinstance(data, list) else []
    rows = [r for r in rows if r.get("artist_mbid") and r.get("artist_mbid") != mbid]
    rows.sort(key=lambda r: -float(r.get("score", 0)))
    return rows[:limit]


def discover_playlists(cfg: dict, yt) -> tuple[dict[str, str], str | None, str | None]:
    """Find every '<year> Indie Discotheque' playlist (+ the Skipped playlist) on your channel.

    Uses one configured playlist to learn the channel id, then lists the channel's public playlists.
    Returns ({year: playlistId}, skipped_playlist_id, channel_id).
    """
    ycfg = cfg.get("youtube_music") or {}
    pattern = ycfg.get("playlist_title_pattern", "{year} Indie Discotheque")
    rx = re.compile("^" + re.escape(pattern).replace(re.escape("{year}"), r"(\d{4})") + "$", re.I)
    found: dict[str, str] = {str(y): pid for y, pid in (ycfg.get("playlists") or {}).items()}
    skipped = ycfg.get("skipped_playlist_id") or None
    skipped_title = (ycfg.get("skipped_playlist_title") or "").strip().lower()
    channel = None
    for pid in list(found.values()):
        try:
            pl = yt.get_playlist(pid, limit=0)
            channel = (pl.get("author") or {}).get("id")
            if channel:
                break
        except Exception as exc:  # noqa: BLE001
            log.debug("playlist %s lookup failed: %s", pid, exc)
    if channel:
        try:
            for pl in yt.get_user_playlists(channel, yt.get_user(channel)["playlists"]["params"]):
                title = (pl.get("title") or "").strip()
                m = rx.match(title)
                if m and pl.get("playlistId"):
                    found.setdefault(m.group(1), pl["playlistId"])
                elif skipped_title and title.lower() == skipped_title and pl.get("playlistId"):
                    skipped = skipped or pl["playlistId"]
        except Exception as exc:  # noqa: BLE001
            log.warning("could not list channel playlists (%s); using configured IDs only", exc)
    return found, skipped, channel


def youtube_playlist_seeds(cfg: dict) -> tuple[dict[str, float], dict[str, dict], list[dict], dict]:
    """Read your public year playlists (no auth) → artist counts, saved/skipped keys, recent picks, playlist map."""
    artists: dict[str, float] = defaultdict(float)
    saved: dict[str, dict] = {}
    picks: list[dict] = []
    meta: dict = {"years": {}, "skipped": None, "channel": None}
    try:
        from ytmusicapi import YTMusic
    except ImportError:
        return artists, saved, picks, meta
    yt = YTMusic()
    years, skipped, channel = discover_playlists(cfg, yt)
    meta.update({"years": years, "skipped": skipped, "channel": channel})
    picks_n = int((cfg.get("youtube_music") or {}).get("picks_count", 40))
    current = str(date.today().year)
    for year, pid in sorted(years.items(), reverse=True):
        try:
            pl = yt.get_playlist(pid, limit=None)
        except Exception as exc:  # noqa: BLE001
            log.warning("could not read playlist %s (%s): %s", year, pid, exc)
            continue
        tracks = pl.get("tracks") or []
        weight = 1.0 + 0.25 * max(0, int(year) - 2023) if str(year).isdigit() else 1.0
        for t in tracks:
            title = t.get("title") or ""
            names = [a.get("name") for a in (t.get("artists") or []) if a.get("name")]
            for nme in names:
                artists[nme] += weight
            if names:
                saved[item_key(names[0], title)] = {"artist": names[0], "title": title, "year": year, "videoId": t.get("videoId"), "decision": "up"}
        if year == current:
            for t in tracks[-picks_n:][::-1]:
                names = [a.get("name") for a in (t.get("artists") or []) if a.get("name")]
                thumbs = t.get("thumbnails") or []
                picks.append({"artist": names[0] if names else "", "title": t.get("title") or "", "videoId": t.get("videoId"),
                              "year": year, "thumbnail": thumbs[-1]["url"] if thumbs else None, "album": (t.get("album") or {}).get("name")})
        log.info("playlist %s: %d tracks", year, len(tracks))
    if skipped:
        try:
            pl = yt.get_playlist(skipped, limit=None)
            for t in pl.get("tracks") or []:
                names = [a.get("name") for a in (t.get("artists") or []) if a.get("name")]
                if names:
                    saved[item_key(names[0], t.get("title") or "")] = {"artist": names[0], "title": t.get("title"), "videoId": t.get("videoId"), "decision": "down"}
            log.info("skipped playlist: %d tracks", len(pl.get("tracks") or []))
        except Exception as exc:  # noqa: BLE001
            log.warning("could not read skipped playlist %s: %s", skipped, exc)
    return artists, saved, picks, meta


def build_profile(cfg: dict, http: Http) -> dict:
    pcfg = cfg["profile"]
    lastfm = LastFm(http, os.environ.get("LASTFM_API_KEY"))
    ids = ArtistIds(http)
    user = cfg["station"]["lastfm_user"]

    direct: dict[str, dict] = {}

    def add_direct(name: str, weight: float, via: str, mbid: str | None = None) -> None:
        n = norm(name)
        if not n:
            return
        entry = direct.setdefault(n, {"name": name, "affinity": 0.0, "kind": "direct", "mbid": mbid, "via": []})
        entry["affinity"] += weight
        entry["mbid"] = entry["mbid"] or mbid
        if via not in entry["via"]:
            entry["via"].append(via)

    # 1. Last.fm top artists across periods (rank-decayed weight)
    if lastfm.enabled:
        for period, pw in (pcfg.get("lastfm_periods") or {}).items():
            arts = lastfm.top_artists(user, period, int(pcfg.get("lastfm_top_artists_limit", 300)))
            log.info("last.fm %s: %d artists", period, len(arts))
            for i, a in enumerate(arts):
                w = pw * (1.0 / math.log2(i + 2))
                add_direct(a["name"], w, f"lastfm:{period}", a.get("mbid") or None)
    else:
        log.warning("LASTFM_API_KEY not set — profile will rely on playlists + seeds only")

    # 2. Your YouTube Music year playlists
    yt_artists, saved, picks, yt_meta = youtube_playlist_seeds(cfg)
    for name, cnt in yt_artists.items():
        add_direct(name, 0.6 * math.log2(cnt + 1), "ytmusic-playlists")

    # 3. Manual + Everynoise seeds
    for name in pcfg.get("seed_artists") or []:
        add_direct(name, 1.0, "seed")
    for slug, names in (read_json(DATA_DIR / "seeds_everynoise.json", {}) or {}).items():
        for i, name in enumerate(names[:150]):
            add_direct(name, 0.5 / math.log2(i + 2), f"everynoise:{slug}")

    if not direct:
        raise SystemExit("Empty profile: set LASTFM_API_KEY or add seed artists in config.yaml")

    # normalise direct affinities to [0, 1]
    top = max(e["affinity"] for e in direct.values())
    for e in direct.values():
        e["affinity"] = round(e["affinity"] / top, 4)

    # 4. Tags from Last.fm top tags of the top artists
    tags: dict[str, float] = defaultdict(float)
    ranked = sorted(direct.values(), key=lambda e: -e["affinity"])
    expand_n = int(pcfg.get("expand_top_n", 100))
    if lastfm.enabled:
        for e in ranked[:expand_n]:
            for t in lastfm.top_tags(e["name"])[:8]:
                try:
                    cnt = int(t.get("count", 0))
                except (TypeError, ValueError):
                    cnt = 0
                if cnt < 10:
                    continue
                tags[norm(t["name"])] += e["affinity"] * cnt / 100.0
    for t, b in (pcfg.get("tag_boosts") or {}).items():
        tags[norm(t)] = tags.get(norm(t), 0.3) * float(b) + 0.2 * float(b)
    if tags:
        mx = max(tags.values())
        tags = {t: round(v / mx, 4) for t, v in tags.items() if v / mx >= 0.02}
    for t, p in (pcfg.get("tag_penalties") or {}).items():
        tags[norm(t)] = float(p)

    # 5. Similar artists (Last.fm + ListenBrainz) inherit a fraction of affinity
    similar: dict[str, dict] = {}
    sim_w = float(pcfg.get("similar_weight", 0.35))
    per = int(pcfg.get("similar_per_artist", 10))
    for e in ranked[:expand_n]:
        found: list[tuple[str, float, str | None]] = []
        if lastfm.enabled:
            for s in lastfm.similar(e["name"], per):
                found.append((s["name"], float(s.get("match", 0.5)), s.get("mbid") or None))
        mbid = ids.mbid(e["name"], e.get("mbid"))
        e["mbid"] = mbid
        if mbid:
            for s in listenbrainz_similar(http, mbid, per):
                found.append((s.get("name") or "", min(1.0, float(s.get("score", 0)) / 100.0 + 0.3), s.get("artist_mbid")))
        for name, match, smbid in found:
            n = norm(name)
            if not n or n in direct:
                continue
            entry = similar.setdefault(n, {"name": name, "affinity": 0.0, "kind": "similar", "mbid": smbid, "via": []})
            entry["affinity"] = max(entry["affinity"], round(sim_w * e["affinity"] * match, 4))
            entry["mbid"] = entry["mbid"] or smbid
            if e["name"] not in entry["via"]:
                entry["via"].append(e["name"])
    ids.save()

    artists = {**similar, **direct}
    mb_index = {e["mbid"]: n for n, e in artists.items() if e.get("mbid")}
    profile = {
        "built_at": utcnow().isoformat(),
        "lastfm_user": user,
        "counts": {"direct": len(direct), "similar": len(similar), "tags": len(tags), "saved": len(saved)},
        "artists": artists,
        "mbid_index": mb_index,
        "tags": tags,
        "saved": saved,
        "picks": picks,
        "youtube": yt_meta,
    }
    write_json(PROFILE_PATH, profile, compact=True)
    log.info("profile: %s", profile["counts"])
    return profile


def load_profile() -> dict:
    p = read_json(PROFILE_PATH, None)
    if not p:
        raise SystemExit("No profile yet — run `python -m discovery profile` first")
    return p


def scrape_everynoise(cfg: dict, http: Http) -> dict[str, list[str]]:
    """Everynoise is frozen but its genre pages are static HTML; harvest artist names as seeds."""
    out: dict[str, list[str]] = {}
    for slug in cfg["profile"].get("everynoise_genres") or []:
        url = f"https://everynoise.com/engenremap-{slug}.html"
        try:
            html = http.get(url, as_json=False, cache=False)
        except Exception as exc:  # noqa: BLE001
            log.warning("everynoise %s: %s", slug, exc)
            continue
        names = re.findall(r'class="genre scanme"[^>]*>([^<]+?)<', html)
        names = [re.sub(r"[»›]\s*$", "", n).strip() for n in names]
        names = [n for n in names if n and len(n) < 60]
        if names:
            out[slug] = names
            log.info("everynoise %s: %d artists", slug, len(names))
    write_json(DATA_DIR / "seeds_everynoise.json", out)
    return out
