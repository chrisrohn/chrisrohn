"""Resolve items to YouTube Music (no key needed for search) so the feed can play them inline.

A release that already carries its YouTube Music browse id (artist watch) is opened directly; other releases are
searched by title and the matching track is taken (title track first, else the first track); tracks are searched
directly. A result is only accepted when both the artist and the title agree with the item — landing on *another*
song by the same artist is worse than no result, because the card would play the wrong thing — and a track that
names a remix ("Song (Monsieur Adi Remix)") is accepted only on an upload that credits that remix, never on the
original (`remix_agrees`: the original is the recording the library most likely already holds, and a card that
plays it is a card the curator skips). Cached rows are re-checked against the same rules, so rows written by an
older, looser resolver heal themselves.
Audio first: YouTube Music lists most songs twice, as the audio-only track (videoType MUSIC_VIDEO_TYPE_ATV, the one
the playlists want) and as the official video (OMV). Search hits prefer the audio track, and a video hit — from a
search or an album page alike — is swapped for its audio counterpart through the watch playlist, which pairs the
two. A hit that is still a video (no counterpart yet) is asked again every `resolve.audio_recheck_days`, a batch a
run, because YouTube Music pairs the audio side later for many videos. The album a song search names is opened
once for its year and its playlist, so an undated track still has a year to fall back on.
Song length: the playlists hold songs, not interludes or DJ mixes. Between several uploads of a song the resolver
prefers one inside `resolve.min_length`–`resolve.max_length` (1:55–9:31 by default: a radio edit over the extended
mix), a cached hit outside the range is looked up once more in case a shorter or longer upload exists, and a song
whose only upload is outside the range is dropped by the feed and the catalog after resolution (`drop_by_length`).
A video the curator flagged on the site as the wrong one (≠, data/ratings.json) is refused for that track from then
on: the cached row is redone without it, and the row remembers the refusal ("not") so the flag outlives the rating.
The video side too: once a card plays its audio track, its official video is looked for (`find_video`: the pair the
watch playlist names — YouTube Music answers with it for a few uploads only, 8 of 4,564 asked by 2026-09-18 — then
a video search that refuses anything titled as the audio side), once, then again every `videos.recheck_days` while
there is none, `videos.feed_lookups_per_run` a run; the id travels with the card as `youtube.video`, so a song kept
on the site brings its video to the Video tab, where it is reviewed for the music-video playlist
(discovery/videos.py does the same for the library and the play history).
Results are cached in data/cache/youtube.json. `cached_states` reads that cache without a request, so the feed can
tell before it picks its candidates which items are already cards, which are waiting on a heal or a retry, and which
still need a lookup — the day's candidate slots and its lookup budget then go to items that can become cards today.
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any

from .models import Item
from .util import _REMIX_RE as _NAMED_REMIX_RE
from .util import CACHE_DIR, Deadline, log, norm, norm_track, read_json, write_json

YT_CACHE = CACHE_DIR / "youtube.json"
CACHE_VERSION = 3   # 2: rows from the resolver that could land on another song; 3: audio-only preference, album year
ATV = "MUSIC_VIDEO_TYPE_ATV"      # audio-only track
OMV = "MUSIC_VIDEO_TYPE_OMV"      # the official music video
_EDITION_RE = re.compile(r"\b(deluxe|special|expanded|anniversary|remaster(ed)?|edition|collector|bonus|live|remixes)\b", re.I)
FLUSH_EVERY = 25    # lookups between cache writes, so a killed job keeps what it already found
VIDEO_FINDER = 2    # how a card's video side was looked for: 1 the watch-playlist pair alone, 2 the pair and then a video search (find_video)
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


# a "(<who> Remix)" tail names another hand on the recording; these words in the <who> slot name a version of the
# artist's own take (a radio edit, an extended mix), which is the record itself and needs no remix on the candidate
_GENERIC_VERSION = frozenset({"radio", "extended", "original", "club", "album", "single", "acoustic", "live", "instrumental", "dub", "vocal", "short", "long",
                              "full", "vinyl", "main", "12", "7", "edit", "alternate", "alternative", "stereo", "mono", "bonus", "demo", "remastered",
                              "piano", "clean", "explicit", "tv", "video", "special", "us", "uk", "french", "english", "spanish", "german", "italian",
                              "japanese", "unplugged", "new", "old", "the", "a", "version", "mix", "remix", "re", "recorded", "reprise", "slow", "fast"})


def named_remixer(title: str | None) -> str | None:
    """The act a title's remix tail credits ("Song (Monsieur Adi Remix)" → "Monsieur Adi"; "Song - Yuksek Remix" too), or
    None for the artist's own versions ("(Radio Edit)", "(Extended Mix)", "(Original Mix)") and for a plain title."""
    m = _NAMED_REMIX_RE.search(str(title or ""))
    if not m:
        return None
    who = m.group("who").strip(" -–—")
    words = [w for w in norm(who).split() if w]
    return who if words and not all(w in _GENERIC_VERSION for w in words) else None


def remix_agrees(item_title: str | None, cand_title: str | None, cand_album: str | None = None) -> bool:
    """An item that names a remix is that remix: the candidate's title (or the album it sits on) must credit the same
    remixer, or the card would play the original — the song the library most likely already holds. An item with no
    named remixer agrees with anything (version_mismatch keeps the live and remix takes away from it)."""
    who = named_remixer(item_title)
    if not who:
        return True
    hay = set(norm(f"{cand_title or ''} {cand_album or ''}").split())
    words = [w for w in norm(who).split() if w not in _GENERIC_VERSION]
    return bool(words) and all(w in hay for w in words)


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
        if not remix_agrees(title, r.get("title"), album_name):
            continue                                                                       # the item is a named remix: the original is not it
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


def _sides(tracks: list[dict], video_id: str) -> tuple[str | None, str | None, dict[str, Any] | None]:
    """What the watch playlist says about an upload: (its own videoType, the audio-only track paired with it, the
    video paired with it). The playlist lists both sides of the audio/video pair, so a video's counterpart is the
    audio track and an audio track's counterpart the video; opened straight on the audio side it is the audio
    track itself, and on the video side the upload itself is the video."""
    for t in tracks or []:
        own = t.get("videoType")
        cp = t.get("counterpart") or {}
        cp_video = {"videoId": cp["videoId"], "videoType": cp["videoType"], "title": cp.get("title")} if cp.get("videoId") and cp.get("videoType") and cp["videoType"] != ATV else None
        if t.get("videoId") == video_id:
            if own == ATV:
                return ATV, video_id, cp_video
            video = {"videoId": video_id, "videoType": own, "title": t.get("title")} if own else None
            return own, (cp.get("videoId") if cp.get("videoType") == ATV and cp.get("videoId") else None), video
        if t.get("videoType") == ATV and t.get("videoId"):   # the playlist opened straight on the audio side
            return None, t["videoId"], cp_video
        if own and own != ATV and t.get("videoId") and cp.get("videoId") == video_id:   # …or on the video side
            return None, video_id, {"videoId": t["videoId"], "videoType": own, "title": t.get("title")}
    return None, None, None


def _watch(yt, video_id: str) -> list[dict]:
    """The watch playlist's tracks for an upload (one request, no API quota); raises when the request fails."""
    wp = yt.get_watch_playlist(videoId=video_id, limit=1)
    return (wp or {}).get("tracks") or []


def watch_info(yt, video_id: str) -> tuple[str | None, str | None]:
    """(own videoType, the audio-only track paired with it); (None, None) when the request failed or said nothing."""
    try:
        own, audio, _ = _sides(_watch(yt, video_id), video_id)
    except Exception as exc:  # noqa: BLE001
        log.debug("watch playlist for %s failed: %s", video_id, exc)
        return None, None
    return own, audio


def audio_counterpart(yt, video_id: str) -> str | None:
    """The audio-only track paired with a video, from the watch playlist (which lists both sides of the pair)."""
    own, cp = watch_info(yt, video_id)
    return cp if cp and cp != video_id else None


def prefer_audio(yt, found: dict[str, Any]) -> bool:
    """Swap a video hit for its audio-only counterpart when YouTube Music has one; a hit whose kind was unknown
    learns it (audio track, official video, upload) even when there is no counterpart. Returns whether the hit is
    the audio track afterwards. The same answer names the video side of the pair, which is recorded on the hit
    (`video`, None when there is none) so the Video tab needs no second lookup for it."""
    if not found or not found.get("videoId"):
        return False
    if found.get("videoType") == ATV:
        return True
    try:
        own, cp, video = _sides(_watch(yt, found["videoId"]), found["videoId"])
    except Exception as exc:  # noqa: BLE001
        log.debug("watch playlist for %s failed: %s", found.get("videoId"), exc)
        return False
    if cp and cp != found["videoId"]:
        found["videoFrom"] = found["videoId"]
        found["videoId"] = cp
        found["videoType"] = ATV
        found["video"] = (video or {}).get("videoId") or found["videoFrom"]
        found["videoKind"] = (video or {}).get("videoType") or own or OMV
        return True
    if cp == found["videoId"]:
        found["videoType"] = ATV                   # it was the audio track all along, only unlabelled
        found["video"] = (video or {}).get("videoId")
        if video:
            found["videoKind"] = video.get("videoType")
        return True
    if own and not found.get("videoType"):
        found["videoType"] = own
    return False


def is_audio(yt_row: dict | None) -> bool:
    return bool(yt_row) and yt_row.get("videoType") == ATV


def video_side(yt, video_id: str) -> dict[str, Any] | None:
    """The video paired with an upload, from the watch playlist (which lists both sides of the audio/video pair):
    for an audio track the official video YouTube Music pairs with it, for a video the upload itself. None when no
    video is paired (yet). A request that fails raises, so the caller does not mistake it for "no video"."""
    return _sides(_watch(yt, video_id), video_id)[2]


# An upload that is a picture of the song, not a video of it: "(Official Audio)", a visualiser, a lyric video, an
# art track, a full album stream. The bare word "audio" counts only in a title's tail ("Song (Audio)", "Song | Audio").
_AUDIO_ONLY_STRONG = re.compile(r"\b(official\s+audio|audio\s+only|visuali[sz]er|lyric\s+video|lyrics\s+video|art\s*track|static\s+(?:image|video)|pseudo\s*video|full\s+album|album\s+stream|audio\s+stream|\d{4}\s+remaster(?:ed)?\s+audio)\b", re.I)
_AUDIO_ONLY_TAIL = re.compile(r"^\s*(?:hq\s+|hd\s+|official\s+)?(?:audio|lyrics?|visuali[sz]er|instrumental)\s*$", re.I)
_TAIL_PARTS = re.compile(r"[\(\[]([^\)\]]*)[\)\]]|\s[-–—|]\s+([^\(\)\[\]|]+?)\s*(?=[\(\[|]|$)")
VIDEO_KINDS = (OMV, "MUSIC_VIDEO_TYPE_UGC")   # what a video upload is typed as; OFFICIAL_SOURCE_MUSIC is the audio side under another name


def audio_only_title(title: str | None) -> bool:
    """True for an upload whose title says it is the audio, not a video: "Song (Official Audio)", "Song | Visualizer",
    "Song (Lyric Video)". A song simply called "Audio" is not caught: the bare word counts only in a title's tail."""
    t = str(title or "")
    if _AUDIO_ONLY_STRONG.search(t):
        return True
    return any(_AUDIO_ONLY_TAIL.match(a if a is not None else b or "") for a, b in _TAIL_PARTS.findall(t))


def is_music_video(row: dict | None) -> bool:
    """An upload the Video tab may list: typed as a video (the official video, or an upload) and not titled as the
    audio side. An unlabelled upload passes on its title alone."""
    if not row or not row.get("videoId"):
        return False
    vt = row.get("videoType")
    if vt and vt not in VIDEO_KINDS:
        return False
    return not audio_only_title(row.get("title"))


def search_video(yt, artist: str, title: str, avoid: set[str] | None = None) -> dict[str, Any] | None:
    """The official video of a song by a search (filter "videos"): the artist and the title must agree, an upload
    titled as the audio side is never it, the official video beats an upload. None when nothing fits; raises when
    the request fails, so a caller never mistakes an outage for "no video"."""
    res = yt.search(f"{artist} {title}", filter="videos", limit=6)
    best, best_score = None, 0.0
    for r in res or []:
        if r.get("resultType") not in ("video", "song") or not r.get("videoId") or (avoid and r["videoId"] in avoid):
            continue
        vt = r.get("videoType")
        if vt and vt not in VIDEO_KINDS:
            continue
        if not artist_agrees(artist, [x.get("name") for x in (r.get("artists") or [])]) or not titles_agree(title, r.get("title"), artist):
            continue
        if audio_only_title(r.get("title")) or version_mismatch(title, r.get("title")) or not remix_agrees(title, r.get("title")):
            continue
        score = 2.0 + (1.0 if vt == OMV else 0.0) + (0.3 if r.get("resultType") == "video" else 0.0)
        if score > best_score:
            best, best_score = r, score
    return {"videoId": best["videoId"], "videoType": best.get("videoType") or "MUSIC_VIDEO_TYPE_UGC", "title": best.get("title"), "via": "search"} if best else None


def find_video(yt, video_id: str, artist: str | None = None, title: str | None = None, *, search: bool = True) -> dict[str, Any] | None:
    """The video paired with an upload: what the watch playlist says first (one cheap request; YouTube Music
    answers with the pair for a few uploads only), then, given the artist and the title, a video search
    (`search_video`). None when neither finds one; raises when a request fails."""
    side = video_side(yt, video_id)
    if side and is_music_video(side):
        return side
    if not search or not artist or not title:
        return None
    return search_video(yt, artist, title)


def attach_video(yt, found: dict[str, Any], artist: str | None = None, title: str | None = None) -> bool:
    """Record the video side of a resolved hit on it (`video`, `videoKind`; `video` None when there is none): the pair
    the watch playlist names, else a video search by the artist and the title when they are given. Returns False
    when a request failed (nothing recorded)."""
    if found.get("video"):
        return True
    try:
        side = find_video(yt, found["videoId"], artist, title)
    except Exception as exc:  # noqa: BLE001
        log.debug("video side of %s failed: %s", found.get("videoId"), exc)
        return False
    found["video"] = side["videoId"] if side else None
    if side:
        found["videoKind"] = side.get("videoType")
    return True


def video_summary(items: list[Item]) -> dict[str, int]:
    """How many resolved items know their video side: with a video, without one, not asked yet."""
    out = {"with_video": 0, "no_video": 0, "pending": 0}
    for it in items:
        yt = it.youtube or {}
        if not yt.get("videoId"):
            continue
        out["with_video" if yt.get("video") else "no_video" if "video" in yt else "pending"] += 1
    return out


def audio_summary(items: list[Item]) -> dict[str, int]:
    """How many resolved items play the audio track, the video, or an upload of unknown kind."""
    out = {"audio": 0, "video": 0, "unknown": 0}
    for it in items:
        if not it.youtube or not it.youtube.get("videoId"):
            continue
        vt = it.youtube.get("videoType")
        out["audio" if vt == ATV else "video" if vt else "unknown"] += 1
    return out


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
    # the album lists each track's kind (usually the audio side, sometimes the video): keep what it says, and a track
    # it does not label stays unknown for the watch-playlist check rather than being assumed audio
    if not found.get("artists"):
        found["artists"] = [x.get("name") for x in (detail.get("artists") or []) if x.get("name")]
    return found


def plausible(it: Item, yt: dict | None) -> bool:
    """Does this YouTube result actually belong to the item (same artist, and the song or the album it names)?"""
    if not yt or not yt.get("videoId"):
        return False
    if yt.get("artists") and not artist_agrees(it.artist, yt.get("artists")):
        return False
    if it.remixer and not remix_agrees(it.display_title, yt.get("title"), yt.get("album")):
        return False                       # a remix card that would play the original: the row is redone (see _row_action → STALE)
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
                prefer_audio(yt, found)          # an album page can list the video side of a track: take the audio side
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
            prefer_audio(yt, found)
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


USE, STALE, FLAGGED, RELOOK, OLD_MISS, RETRY = "use", "stale", "flagged", "relook", "old-miss", "retry"   # what to do with a cached row
AUDIO, VIDEO, MISS, LOOKUP = "audio", "video", "miss", "lookup"                                              # what the cache says an item is


def _row_action(row: dict, it: Item, not_these: set[str], length: tuple[int | None, int | None] | None, retry_before: str | None) -> str:
    """The resolver's verdict on a cached row: USE it as it stands, or drop it and look the item up again because it is
    STALE (the old resolver landed on another song by the same artist), FLAGGED (the curator said this video is not the
    song), RELOOK (a hit outside the song-length range from before the range was known: once more, in case a shorter or
    longer upload exists), an OLD_MISS (a miss from before releases were opened by id) or a RETRY (a miss older than
    retry_misses_days: the audio track may have arrived since). The two that only pay off with a lookup, RELOOK and
    RETRY, are taken only while the lookup budget lasts; the others always are."""
    yt = row.get("yt")
    if yt and not plausible(it, yt):
        return STALE
    if yt and yt.get("videoId") in not_these:
        return FLAGGED
    if yt and not row.get("len") and not length_ok(yt.get("duration"), length):
        return RELOOK
    if yt is None and row.get("v") != CACHE_VERSION and browse_id(it):
        return OLD_MISS
    if yt is None and retry_before is not None and (row.get("at") or "") < retry_before:
        return RETRY
    return USE


def _load_cache(today_s: str) -> dict[str, Any]:
    return {k: _entry(v, today_s) for k, v in read_json(YT_CACHE, {}).items()}


def cached_states(items: list[Item], cfg: dict, avoid: dict[str, set[str]] | None = None) -> dict[str, tuple[str, str | None]]:
    """What the resolver's cache already says about each item, without a single request: {item key: (state, video id)}.
    AUDIO — a plausible cached audio hit: a card today at no cost (the id is there so the feed can hide one already in
    a playlist before it takes a candidate slot). VIDEO — a cached hit that is not the audio track: not a card today
    unless a heal finds the audio side (a batch a run). MISS — a cached miss that is not due for a retry, or an upload
    outside the song-length range that was already looked up once more: not a card today. LOOKUP — no usable row:
    the item needs a lookup to become a card. An item that already carries a match is read from that."""
    rcfg = cfg.get("resolve") or {}
    if not rcfg.get("youtube_music", True):
        return {}
    today = date.today()
    cache = _load_cache(today.isoformat())
    retry_days = int(rcfg.get("retry_misses_days", 7) or 0)
    retry_before = (today - timedelta(days=retry_days)).isoformat() if retry_days else None
    length = length_bounds(cfg)
    out: dict[str, tuple[str, str | None]] = {}
    for it in items:
        if it.youtube:
            out[it.key] = (AUDIO if is_audio(it.youtube) else VIDEO, it.youtube.get("videoId"))
            continue
        row = cache.get(it.key)
        if row is None:
            out[it.key] = (LOOKUP, None)
            continue
        not_these = set((avoid or {}).get(it.key) or ()) | set(row.get("not") or ())
        if _row_action(row, it, not_these, length, retry_before) != USE:
            out[it.key] = (LOOKUP, None)
            continue
        yt = row["yt"]
        if not yt:
            out[it.key] = (MISS, None)
        elif not length_ok(yt.get("duration"), length):
            out[it.key] = (MISS, yt.get("videoId"))          # stamped as looked up once more: a song that is simply long
        elif is_audio(yt):
            out[it.key] = (AUDIO, yt.get("videoId"))
        else:
            out[it.key] = (VIDEO, yt.get("videoId"))
    return out


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
    cache: dict[str, Any] = _load_cache(today_s)
    deadline = deadline or Deadline(None)
    budget = int(rcfg.get("max_lookups_per_run", 400))
    heal_budget = int(rcfg.get("audio_heals_per_run", 150))   # hits that are not the audio track: re-checked for a counterpart, a batch a run
    recheck_days = int(rcfg.get("audio_recheck_days", 30) or 0)
    recheck_before = (today - timedelta(days=recheck_days)).isoformat() if recheck_days else None
    retry_days = int(rcfg.get("retry_misses_days", 7) or 0)
    retry_before = (today - timedelta(days=retry_days)).isoformat() if retry_days else None
    length = length_bounds(cfg)
    # the video side of every audio hit, for the Video tab: a batch a run, and asked again while there is none
    vcfg = cfg.get("videos") or {}
    video_budget = int(vcfg.get("feed_lookups_per_run", 400) or 0) if vcfg.get("enabled", True) else 0
    video_recheck = int(vcfg.get("recheck_days", 90) or 0)
    video_before = (today - timedelta(days=video_recheck)).isoformat() if video_recheck else None
    looked = stale = rejected = healed = flagged = relooked = retried = videos = 0
    skipped_deadline = 0

    def flush() -> None:
        write_json(YT_CACHE, prune_cache(cache, today, keep_days), compact=True)

    def video_due(row: dict, yt_row: dict) -> bool:
        """An audio hit whose video side was never asked, asked through the pair alone (a row without the finder's
        version stamp, from before the search existed), or asked long enough ago while there was none."""
        if not is_audio(yt_row) or yt_row.get("video"):
            return False
        asked = row.get("vid")
        return not asked or "video" not in yt_row or row.get("vhow") != VIDEO_FINDER or (video_before is not None and asked < video_before)

    for it in items:
        if it.youtube:
            continue
        key = it.key
        row = cache.get(key)
        # what this track must not resolve to: today's flags from the ratings file, and any the row already remembers
        not_these = set((avoid or {}).get(key) or ()) | set((row or {}).get("not") or ())
        if row is not None:
            action = _row_action(row, it, not_these, length, retry_before)
            can_look = looked < budget and not deadline.expired
            if action == STALE:
                stale += 1                       # the old resolver landed on another song by the same artist
                del cache[key]
            elif action == FLAGGED:
                flagged += 1                     # the curator said this video is not the song: look again without it
                del cache[key]
            elif action == RELOOK and can_look:
                relooked += 1                    # a hit outside the song-length range from before the range was known: once more, in case a
                del cache[key]                   # shorter or longer upload exists (the new row is stamped, so a song that is simply long stays put)
            elif action == OLD_MISS:
                del cache[key]                   # a miss from before releases were opened by id
            elif action == RETRY and can_look:
                retried += 1                     # a miss older than retry_misses_days: the audio track may have arrived since
                del cache[key]
            else:
                row["seen"] = today_s
                it.youtube = row["yt"] or None
                if it.youtube:
                    promote(it, it.youtube)
                    # a hit that is not the audio track (a video, or one of unknown kind): ask the watch playlist for its
                    # audio counterpart, on the first sight and again every `audio_recheck_days` (YouTube Music pairs the
                    # audio side later for many videos), a batch a run; the album year comes along when it is missing
                    checked = row.get("audio")
                    due = not is_audio(it.youtube) and (not checked or (recheck_before is not None and checked < recheck_before))
                    if due and healed < heal_budget and not deadline.expired:
                        healed += 1
                        prefer_audio(yt, it.youtube)
                        album_year(yt, it.youtube)
                        row["audio"] = today_s
                        row["v"] = CACHE_VERSION
                        if "video" in it.youtube:          # the same answer named the video side: no second request
                            row["vid"], row["vhow"] = today_s, VIDEO_FINDER
                        if healed % FLUSH_EVERY == 0:
                            flush()
                    if video_due(row, it.youtube) and videos < video_budget and not deadline.expired:
                        videos += 1
                        if attach_video(yt, it.youtube, it.artist, it.display_title):
                            row["vid"], row["vhow"] = today_s, VIDEO_FINDER
                        if videos % FLUSH_EVERY == 0:
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
        # "len": this row was looked up with the song-length preference, so a hit outside the range is not redone again;
        # "audio": when the watch playlist was last asked for the audio track (the lookup itself asks, so today)
        # "at": when this lookup ran (a miss is tried again retry_misses_days later)
        cache[key] = {"seen": today_s, "at": today_s, "yt": found, "v": CACHE_VERSION, "len": 1, "audio": today_s, **({"not": sorted(not_these)} if not_these else {})}
        it.youtube = found
        if found:
            promote(it, found)
            if not it.artwork:
                it.artwork = found.get("thumbnail")
            # a fresh audio hit is asked for its video side straight away; a hit whose lookup already went through the
            # watch playlist (a swapped video, an unlabelled audio track) knows it, with or without a video
            if "video" in found:
                cache[key]["vid"], cache[key]["vhow"] = today_s, VIDEO_FINDER
            elif video_due(cache[key], found) and videos < video_budget and not deadline.expired:
                videos += 1
                if attach_video(yt, found, it.artist, it.display_title):
                    cache[key]["vid"], cache[key]["vhow"] = today_s, VIDEO_FINDER
        if looked % FLUSH_EVERY == 0:
            flush()
    flush()
    if skipped_deadline:
        log.warning("youtube: time budget reached; %d lookups left for the next run", skipped_deadline)
    kinds = audio_summary(items)
    vids = video_summary(items)
    log.info("youtube: %d lookups this run (%d stale rows redone, %d flagged as the wrong video redone, %d outside the song-length range looked up once more, "
             "%d older misses tried again, %d wrong-song hits rejected, %d video hits re-checked for the audio track), %d cached; %d items play the audio track, %d the video, %d an upload of unknown kind",
             looked, stale, flagged, relooked, retried, rejected, healed, len(cache), kinds["audio"], kinds["video"], kinds["unknown"])
    log.info("videos: %d cards asked for their video side this run; %d cards have a video, %d none, %d not asked yet", videos, vids["with_video"], vids["no_video"], vids["pending"])


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
