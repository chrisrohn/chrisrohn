"""Resolve items to YouTube Music (no key needed for search) so the feed can play them inline.

A release that already carries its YouTube Music browse id (artist watch) is opened directly; other releases are
searched by title and the matching track is taken (title track first, else the first track); tracks are searched
directly. A result is only accepted when both the artist and the title agree with the item — landing on *another*
song by the same artist is worse than no result, because the card would play the wrong thing. Cached rows are
re-checked against the same rule, so rows written by an older, looser resolver heal themselves.
Audio first: YouTube Music lists most songs twice, as the audio-only track (videoType MUSIC_VIDEO_TYPE_ATV, the one
the playlists want) and as the official video (OMV). Search hits prefer the audio track, and a video hit is swapped
for its audio counterpart through the watch playlist, which pairs the two. The album a song search names is opened
once for its year and its playlist, so an undated track still has a year to fall back on.
Song length: the playlists hold songs, not interludes or DJ mixes. Between several uploads of a song the resolver
prefers one inside `resolve.min_length`–`resolve.max_length` (1:55–9:31 by default: a radio edit over the extended
mix), a cached hit outside the range is looked up once more in case a shorter or longer upload exists, and a song
whose only upload is outside the range is dropped by the feed and the catalog after resolution (`drop_by_length`).
A video the curator flagged on the site as the wrong one (≠, data/ratings.json) is refused for that track from then
on: the cached row is redone without it, and the row remembers the refusal ("not") so the flag outlives the rating.
Results are cached in data/cache/youtube.json.
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any

from .models import Item
from .util import CACHE_DIR, Deadline, log, norm, norm_track, read_json, write_json

YT_CACHE = CACHE_DIR / "youtube.json"
CACHE_VERSION = 3   # 2: rows from the resolver that could land on another song; 3: audio-only preference, album year
ATV = "MUSIC_VIDEO_TYPE_ATV"      # audio-only track
_EDITION_RE = re.compile(r"\b(deluxe|special|expanded|anniversary|remaster(ed)?|edition|collector|bonus|live|remixes)\b", re.I)
FLUSH_EVERY = 25    # lookups between cache writes, so a killed job keeps what it already found
DEFAULT_MIN_LENGTH = "1:55"   # anything shorter is an interlude, a skit, an intro
DEFAULT_MAX_LENGTH = "9:31"   # anything longer is a DJ mix, a full side, an ambient piece
LENGTH_BONUS = 0.7            # a hit inside the length range over one outside it (more than the audio-over-video preference)
MB_RECORDING = "https://musicbrainz.org/ws/2/recording/"
_BROWSE_RE = re.compile(r"/browse/(MPREb_[\w-]+)")


def ytmusic(cfg: dict | None = None):
    """The unauthenticated YouTube Music client, pinned to the region the playlists are listened to in (config
    `youtube_music.region`, default US): availability and search results are judged there, not wherever the job runs."""
    from ytmusicapi import YTMusic
    region = str(((cfg or {}).get("youtube_music") or {}).get("region") or "US")
    try:
        return YTMusic(location=region)
    except TypeError:          # an older ytmusicapi without the location parameter
        return YTMusic()


_QUALIFIER_RE = re.compile(r"\s*[\(\[][^\)\]]*[\)\]]\s*$|\s+[-–—]\s+[^-–—]+$")   # "(Acoustic)", "[Remix]", "- Live at X"
# Another recording of the same song is not the song: a candidate whose title (qualifier) or album carries one of these
# and the item does not is refused outright, whatever titles_agree thinks of the core title.
_STUDIO_MARKERS = re.compile(r"\b(live|acoustic|unplugged|sped[ -]?up|slowed|nightcore|karaoke|instrumental|demos?)\b", re.I)
# on an album name "live" only counts the way live records are named ("Live at …", "(Live)", "… Live"): "Long Live the Kings" is a studio LP
_ALBUM_MARKERS = re.compile(
    r"(?:^|[\(\[]\s*)(live)\b|\b(live)\s*(?:$|[\)\]]|(?:at|in|from|on|@|sessions?|recordings?|version|concert|tour|\d{4})\b)|"
    r"\b(acoustic|unplugged|sped[ -]?up|slowed|nightcore|karaoke|instrumental|demos)\b", re.I)
_REMIX_MARKERS = re.compile(r"\b(remix(?:es)?|mix|edit|re-?work|dub|version|bootleg|flip|vip)\b", re.I)
_MARKER_NOISE = re.compile(r"\b(radio edit|original mix|single version|album version|(?:\d{4} )?remaster(?:ed)?(?: \d{4})?)\b", re.I)   # the studio take under another name
_QUALIFIER_PART = re.compile(r"[\(\[]([^\)\]]*)[\)\]]|\s[-–—]\s+(.+)$")


def _canon(marker: str) -> str:
    return re.sub(r"[ -]", "", marker.lower()).replace("demos", "demo")


def _markers(text: str | None, *, qualifiers_only: bool = False) -> set[str]:
    """Version markers in a title: anywhere ("Live at KEXP", the item's own title), or with qualifiers_only=True in the
    bracketed / dashed tail alone ("Song (Live)", "Song - Acoustic"), so "Live Forever" stays a song."""
    t = _MARKER_NOISE.sub(" ", str(text or ""))
    if qualifiers_only:
        t = " ".join(a or b for a, b in _QUALIFIER_PART.findall(t))
    found = {_canon(m.group(1)) for m in _STUDIO_MARKERS.finditer(t)}
    if _REMIX_MARKERS.search(t):
        found.add("remix")
    return found


def _album_markers(album: str | None) -> set[str]:
    t = _MARKER_NOISE.sub(" ", str(album or ""))
    return {_canon(next(g for g in m.groups() if g)) for m in _ALBUM_MARKERS.finditer(t)}


def version_mismatch(item_title: str | None, cand_title: str | None, cand_album: str | None = None) -> bool:
    """True when the candidate is a live / acoustic / sped-up / slowed / nightcore / karaoke / instrumental / demo take,
    or a remix / edit / dub / version, of a song the item wants as recorded (a radio edit or original mix is the
    record). A remix marker on the candidate counts only against an item that carries no remixer of its own."""
    have = _markers(item_title)
    got = _markers(cand_title, qualifiers_only=True) | _album_markers(cand_album)
    return bool(got - have)


def _core(s: str | None) -> str:
    t = str(s or "")
    for _ in range(3):
        u = _QUALIFIER_RE.sub("", t)
        if u == t:
            break
        t = u
    return norm_track(t)


def _uncredit(s: str | None, artist: str | None) -> str:
    """Drop a leading "Artist - " from a video title ("Ocean & the Stars - Nostalgia (Official)")."""
    t = str(s or "")
    if artist:
        t = re.sub(r"^\s*" + re.escape(artist) + r"\s*[-–—:]\s*", "", t, count=1, flags=re.I)
    return t


def titles_agree(a: str | None, b: str | None, artist: str | None = None) -> bool:
    """Same song title: equal after suffix/feat. noise, or equal once a bracketed or dashed qualifier (and a leading
    artist credit) is dropped ("Say" ~ "Say (feat. X)" ~ "Say - Live" ~ "Ratatat - Say"; never "Say Goodbye")."""
    a, b = _uncredit(a, artist), _uncredit(b, artist)
    x, y = norm_track(a), norm_track(b)
    if not x or not y:
        return False
    return x == y or _core(a) == _core(b)


def artist_agrees(artist: str, names: list[str] | None) -> bool:
    a = norm(artist)
    ns = [norm(n) for n in (names or []) if n]
    return bool(a) and any(a == n or a in n or n in a for n in ns)


def duration_seconds(value: Any) -> int | None:
    """Seconds from what YouTube Music says a track lasts: "4:42", "1:02:03", 282, "282", or nothing."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value) if value >= 0 else None
    s = str(value).strip()
    if not s:
        return None
    if s.isdigit():
        return int(s)
    parts = s.split(":")
    if not 2 <= len(parts) <= 3 or not all(p.strip().isdigit() for p in parts):
        return None
    total = 0
    for p in parts:
        total = total * 60 + int(p)
    return total


def length_bounds(cfg: dict | None) -> tuple[int | None, int | None]:
    """(shortest, longest) a song may be, in seconds, from `resolve.min_length` / `resolve.max_length` ("m:ss" or
    seconds; an empty value lifts that end). The defaults are 1:55 and 9:31."""
    rcfg = (cfg or {}).get("resolve") or {}
    lo = duration_seconds(rcfg.get("min_length", DEFAULT_MIN_LENGTH))
    hi = duration_seconds(rcfg.get("max_length", DEFAULT_MAX_LENGTH))
    return (lo or None), (hi or None)


def length_ok(duration: Any, bounds: tuple[int | None, int | None] | None) -> bool:
    """Inside the song-length range; a track whose length nobody states is given the benefit of the doubt."""
    secs = duration_seconds(duration)
    if secs is None or not bounds:
        return True
    lo, hi = bounds
    return (lo is None or secs >= lo) and (hi is None or secs <= hi)


def _result_seconds(r: dict) -> int | None:
    secs = r.get("duration_seconds")
    return int(secs) if isinstance(secs, (int, float)) and not isinstance(secs, bool) else duration_seconds(r.get("duration"))


def _pick(results: list[dict], artist: str, title: str | None, avoid: set[str] | None = None,
          length: tuple[int | None, int | None] | None = None) -> dict | None:
    """Best search hit for the item: the artist must match, and so must the title whenever we know one; an upload
    the curator flagged as the wrong video (`avoid`) is never it. Given the song-length range (`length`), an upload
    inside it beats one outside it (the radio edit over the extended mix); a hit outside the range is still a hit
    when it is the only one, and the feed drops the song afterwards."""
    t = norm_track(title) if title else ""
    best, best_score = None, 0.0
    for r in results:
        if r.get("resultType") not in ("song", "video"):
            continue
        if avoid and r.get("videoId") in avoid:
            continue
        artist_ok = artist_agrees(artist, [x.get("name") for x in (r.get("artists") or [])])
        title_ok = bool(t) and titles_agree(title, r.get("title"), artist)
        album = r.get("album") or {}
        album_name = album.get("name") if isinstance(album, dict) else None
        if version_mismatch(title, r.get("title"), album_name):
            continue                                                                       # a live / acoustic / karaoke / remix take is another recording
        score = (2.0 if artist_ok else 0.0) + (1.5 if title_ok else 0.0) + (0.3 if r.get("resultType") == "song" else 0.0)
        vt = r.get("videoType")
        score += 0.6 if vt == ATV else (-0.3 if vt == "MUSIC_VIDEO_TYPE_UGC" else 0.0)     # the audio track over the video, both over an upload
        if album_name and _EDITION_RE.search(album_name) and not _EDITION_RE.search(title or ""):
            score -= 0.2                                                                   # the original issue over a deluxe / remaster / live edition
        secs = _result_seconds(r)
        if length and secs is not None and length_ok(secs, length):
            score += LENGTH_BONUS                                                          # a song-length upload over an interlude or a mix
        if score > best_score:
            best, best_score = r, score
    if best and best_score >= (3.5 if t else 2.0):
        return best
    return None


def _shape(r: dict, via: str) -> dict[str, Any]:
    thumbs = r.get("thumbnails") or []
    album = r.get("album") or {}
    return {
        "videoId": r.get("videoId"),
        "title": r.get("title"),
        "artists": [x.get("name") for x in (r.get("artists") or []) if x.get("name")],
        "album": album.get("name") if isinstance(album, dict) else None,
        "albumBrowseId": album.get("id") if isinstance(album, dict) else None,
        "duration": r.get("duration") or (str(r["duration_seconds"]) if isinstance(r.get("duration_seconds"), int) else None),
        "thumbnail": thumbs[-1]["url"] if thumbs else None,
        "year": r.get("year"),
        "videoType": r.get("videoType"),
        "via": via,
    }


def audio_counterpart(yt, video_id: str) -> str | None:
    """The audio-only track paired with a video, from the watch playlist (which lists both sides of the pair)."""
    try:
        wp = yt.get_watch_playlist(videoId=video_id, limit=1)
    except Exception as exc:  # noqa: BLE001
        log.debug("watch playlist for %s failed: %s", video_id, exc)
        return None
    for t in (wp or {}).get("tracks") or []:
        if t.get("videoId") == video_id:
            cp = t.get("counterpart") or {}
            return cp.get("videoId") if cp.get("videoType") == ATV and cp.get("videoId") else None
        if t.get("videoType") == ATV and t.get("videoId"):   # the playlist opened straight on the audio side
            return t["videoId"]
    return None


def prefer_audio(yt, found: dict[str, Any]) -> None:
    """Swap a video hit for its audio-only counterpart when YouTube Music has one."""
    if not found or found.get("videoType") == ATV or not found.get("videoId"):
        return
    cp = audio_counterpart(yt, found["videoId"])
    if cp:
        found["videoFrom"] = found["videoId"]
        found["videoId"] = cp
        found["videoType"] = ATV


def album_year(yt, found: dict[str, Any]) -> None:
    """Open the album a song hit names, once, for the year YouTube Music states and the album playlist."""
    bid = found.get("albumBrowseId") if found else None
    if not bid or (found.get("year") and found.get("playlistId")):
        return
    try:
        detail = yt.get_album(bid)
    except Exception as exc:  # noqa: BLE001
        log.debug("album %s failed: %s", bid, exc)
        return
    found["year"] = found.get("year") or detail.get("year")
    found["playlistId"] = found.get("playlistId") or detail.get("audioPlaylistId")
    found["albumType"] = detail.get("type")


def browse_id(it: Item) -> str | None:
    """The YouTube Music album/single id an artist-watch item was built from."""
    m = _BROWSE_RE.search(it.links.get("youtube music") or "")
    return m.group(1) if m else None


def _album_track(tracks: list[dict], it: Item, length: tuple[int | None, int | None] | None = None) -> dict:
    """The track a release card should play: the title track when there is one, else the opener — the first of
    song length when the range is given (an album that opens on a one-minute intro plays its first real song)."""
    want = it.release or it.title
    title_track = next((t for t in tracks if titles_agree(want, t.get("title"))), None)
    if title_track is not None and (not length or length_ok(_result_seconds(title_track), length)):
        return title_track
    return next((t for t in tracks if length_ok(_result_seconds(t), length)), title_track or tracks[0])


def _from_album(detail: dict, it: Item, via: str, avoid: set[str] | None = None, length: tuple[int | None, int | None] | None = None) -> dict[str, Any] | None:
    tracks = [t for t in (detail.get("tracks") or []) if t.get("videoId") and not (avoid and t["videoId"] in avoid)]
    if not tracks:
        return None
    found = _shape(_album_track(tracks, it, length), via)
    found["thumbnail"] = (detail.get("thumbnails") or [{}])[-1].get("url") or found["thumbnail"]
    found["album"] = detail.get("title")
    found["year"] = found.get("year") or detail.get("year")
    found["trackCount"] = len(tracks)
    found["albumBrowseId"] = detail.get("browseId") or detail.get("audioPlaylistId")
    found["playlistId"] = detail.get("audioPlaylistId")
    found["videoType"] = found.get("videoType") or ATV      # album tracks are the audio side
    if not found.get("artists"):
        found["artists"] = [x.get("name") for x in (detail.get("artists") or []) if x.get("name")]
    return found


def plausible(it: Item, yt: dict | None) -> bool:
    """Does this YouTube result actually belong to the item (same artist, and the song or the album it names)?"""
    if not yt or not yt.get("videoId"):
        return False
    if yt.get("artists") and not artist_agrees(it.artist, yt.get("artists")):
        return False
    if titles_agree(it.title, yt.get("title"), it.artist):
        return True
    if it.kind == "release" or it.release:
        want = it.release or it.title
        return titles_agree(want, yt.get("album"), it.artist) or titles_agree(want, yt.get("title"), it.artist)
    return False


def promote(it: Item, yt: dict) -> None:
    """A resolved release becomes a playable track card: the song the video is, on the release it came from."""
    if it.kind != "release" or not yt.get("title"):
        return
    it.release = it.release or it.title
    it.title = yt["title"]
    it.kind = "track"
    it.normalize_credit()


def _entry(v: Any, today: str) -> dict:
    """Cache rows are {"seen": date, "yt": result|None, "v": version}; rows written before the prune existed are the bare result."""
    if isinstance(v, dict) and "yt" in v and "seen" in v:
        return v
    return {"seen": today, "yt": v or None}


def prune_cache(cache: dict[str, Any], today: date, keep_days: int, seen_key: str = "seen") -> dict[str, Any]:
    """Drop rows no feed item has touched for `keep_days` (the caches are committed daily, so they must not grow forever)."""
    if not keep_days:
        return cache
    cutoff = (today - timedelta(days=keep_days)).isoformat()
    return {k: v for k, v in cache.items() if (v.get(seen_key) if isinstance(v, dict) else None) and v[seen_key] >= cutoff}


def _lookup(yt, it: Item, avoid: set[str] | None = None, length: tuple[int | None, int | None] | None = None) -> dict[str, Any] | None:
    """One item's YouTube Music lookup (network). Returns the shaped result or None; never mutates the item.
    `avoid` holds the uploads the curator flagged as the wrong video for this track: none of them is a result;
    `length` is the song-length range an upload should fall inside (see `_pick`)."""
    if it.kind == "track":
        res = yt.search(f"{it.artist} {it.display_title}", filter="songs", limit=6)
        hit = _pick(res, it.artist, it.display_title, avoid, length)
        if not hit:
            res = yt.search(f"{it.artist} {it.display_title}", filter="videos", limit=4)
            hit = _pick(res, it.artist, it.display_title, avoid, length)
        if not hit:
            return None
        found = _shape(hit, "track-search")
        prefer_audio(yt, found)
        album_year(yt, found)
        return found if not (avoid and found.get("videoId") in avoid) else None
    want = it.release or it.title
    # release with a known browse id (artist watch): open exactly that release
    bid = browse_id(it)
    if bid:
        detail = yt.get_album(bid)
        names = [x.get("name") for x in (detail.get("artists") or [])]
        if not names or artist_agrees(it.artist, names):
            found = _from_album(detail, it, "album-id", avoid, length)
            if found:
                return found
    # otherwise find the release by title (an exact title first, then a title that contains ours), never "any album by them"
    res = yt.search(f"{it.artist} {want}", filter="albums", limit=5)
    same_artist = [r for r in res if artist_agrees(it.artist, [x.get("name") for x in (r.get("artists") or [])])]
    album = next((r for r in same_artist if norm_track(r.get("title")) == norm_track(want)), None) \
        or next((r for r in same_artist if titles_agree(want, r.get("title"))), None)
    if album and album.get("browseId"):
        detail = yt.get_album(album["browseId"])
        found = _from_album(detail, it, "album", avoid, length)
        if found:
            found["year"] = found.get("year") or album.get("year")
            return found
    # a single that is only listed as a song: the song must carry the release's name
    res = yt.search(f"{it.artist} {want}", filter="songs", limit=6)
    hit = _pick(res, it.artist, want, avoid, length)
    if not hit:
        return None
    found = _shape(hit, "release-fallback")
    prefer_audio(yt, found)
    album_year(yt, found)
    return found if not (avoid and found.get("videoId") in avoid) else None


def resolve_all(items: list[Item], cfg: dict, deadline: Deadline | None = None, avoid: dict[str, set[str]] | None = None) -> None:
    """Give every item without a video its YouTube Music match, from the cache or a bounded number of lookups.
    `avoid` maps item keys to the uploads the curator flagged as the wrong video (learn.wrong_videos): a cached row
    that sits on one is redone without it, and the refusal is kept on the row ("not") for as long as the row lives."""
    rcfg = cfg.get("resolve") or {}
    if not rcfg.get("youtube_music", True):
        return
    try:
        yt = ytmusic(cfg)
    except ImportError:
        log.warning("ytmusicapi not installed; skipping YouTube resolution")
        return
    today = date.today()
    today_s = today.isoformat()
    keep_days = int(rcfg.get("cache_keep_days", 120))
    cache: dict[str, Any] = {k: _entry(v, today_s) for k, v in read_json(YT_CACHE, {}).items()}
    deadline = deadline or Deadline(None)
    budget = int(rcfg.get("max_lookups_per_run", 400))
    heal_budget = int(rcfg.get("audio_heals_per_run", 150))   # rows from before the audio preference: re-checked a batch a run
    length = length_bounds(cfg)
    looked = stale = rejected = healed = flagged = relooked = 0
    skipped_deadline = 0

    def flush() -> None:
        write_json(YT_CACHE, prune_cache(cache, today, keep_days), compact=True)

    for it in items:
        if it.youtube:
            continue
        key = it.key
        row = cache.get(key)
        # what this track must not resolve to: today's flags from the ratings file, and any the row already remembers
        not_these = set((avoid or {}).get(key) or ()) | set((row or {}).get("not") or ())
        if row is not None:
            old = row.get("v") != CACHE_VERSION
            if row["yt"] and not plausible(it, row["yt"]):
                stale += 1                       # the old resolver landed on another song by the same artist
                del cache[key]
            elif row["yt"] and row["yt"].get("videoId") in not_these:
                flagged += 1                     # the curator said this video is not the song: look again without it
                del cache[key]
            elif row["yt"] and not row.get("len") and not length_ok(row["yt"].get("duration"), length) and looked < budget and not deadline.expired:
                relooked += 1                    # a hit outside the song-length range from before the range was known: once more, in case a
                del cache[key]                   # shorter or longer upload exists (the new row is stamped, so a song that is simply long stays put)
            elif row["yt"] is None and old and browse_id(it):
                del cache[key]                   # a miss from before releases were opened by id
            else:
                row["seen"] = today_s
                it.youtube = row["yt"] or None
                if it.youtube:
                    promote(it, it.youtube)
                    # a hit from before the audio preference: swap in the audio track and fetch the album year, a batch a run
                    if old and not it.youtube.get("videoType") and healed < heal_budget and not deadline.expired:
                        healed += 1
                        prefer_audio(yt, it.youtube)
                        album_year(yt, it.youtube)
                        row["v"] = CACHE_VERSION
                        if healed % FLUSH_EVERY == 0:
                            flush()
                continue
        if looked >= budget:
            continue
        if deadline.expired:
            skipped_deadline += 1
            continue
        looked += 1
        found: dict | None = None
        try:
            found = _lookup(yt, it, not_these or None, length)
        except Exception as exc:  # noqa: BLE001
            log.debug("yt resolve failed for %s – %s: %s", it.artist, it.title, exc)
            found = None
        if found and not plausible(it, found):
            log.debug("yt resolve rejected for %s – %s: got %s – %s", it.artist, it.title, found.get("artists"), found.get("title"))
            rejected += 1
            found = None
        # "len": this row was looked up with the song-length preference, so a hit outside the range is not redone again
        cache[key] = {"seen": today_s, "yt": found, "v": CACHE_VERSION, "len": 1, **({"not": sorted(not_these)} if not_these else {})}
        it.youtube = found
        if found:
            promote(it, found)
            if not it.artwork:
                it.artwork = found.get("thumbnail")
        if looked % FLUSH_EVERY == 0:
            flush()
    flush()
    if skipped_deadline:
        log.warning("youtube: time budget reached; %d lookups left for the next run", skipped_deadline)
    log.info("youtube: %d lookups this run (%d stale rows redone, %d flagged as the wrong video redone, %d outside the song-length range looked up once more, "
             "%d wrong-song hits rejected, %d older hits re-checked for audio), %d cached", looked, stale, flagged, relooked, rejected, healed, len(cache))


def drop_by_length(items: list[Item], cfg: dict) -> list[Item]:
    """Every item whose YouTube match lasts less than `resolve.min_length` or more than `resolve.max_length` is
    dropped: a card that cannot be filed is not a card. An unresolved item, or one whose length nobody states,
    stays. Returns the survivors in the same order."""
    bounds = length_bounds(cfg)
    if not any(bounds):
        return list(items)
    kept: list[Item] = []
    short = long = 0
    for it in items:
        secs = duration_seconds((it.youtube or {}).get("duration"))
        if secs is None or length_ok(secs, bounds):
            kept.append(it)
        elif bounds[0] is not None and secs < bounds[0]:
            short += 1
        else:
            long += 1
    if short or long:
        log.info("length: dropped %d songs under %s and %d over %s", short, _mmss(bounds[0]), long, _mmss(bounds[1]))
    return kept


def _mmss(secs: int | None) -> str:
    if secs is None:
        return "–"
    h, rest = divmod(int(secs), 3600)
    m, s = divmod(rest, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _card_rank(it: Item) -> tuple[bool, bool, float]:
    yt = it.youtube or {}
    return (titles_agree(it.title, yt.get("title")), it.kind == "track", it.score)


def collapse_shared_videos(items: list[Item]) -> list[Item]:
    """One card per video: when several items resolved to the same YouTube video they are the same song, so keep the
    card whose title is the video's title and fold the others (sources, links, dates) into it."""
    keep: dict[str, Item] = {}
    out: list[Item] = []
    for it in items:
        vid = (it.youtube or {}).get("videoId")
        if not vid:
            out.append(it)
            continue
        other = keep.get(vid)
        if other is None:
            keep[vid] = it
            out.append(it)
        elif _card_rank(it) > _card_rank(other):
            it.merge(other)
            out[out.index(other)] = it
            keep[vid] = it
        else:
            other.merge(it)
    folded = len(items) - len(out)
    if folded:
        log.info("youtube: folded %d cards that played the same video as another", folded)
    return out


# Year verification moved to discovery/years.py (identifier-based); kept importable from here.
from .years import verify_years  # noqa: E402,F401
