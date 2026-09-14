"""Offline tests for the video side: the resolver recording each card's official video, and the Video tab's list
(discovery/videos.py) built from the playlist scan, the cache, the music-video playlist and the tab's decisions."""
from __future__ import annotations

import sys
import types
from datetime import date, timedelta
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from discovery import resolve, util, videos  # noqa: E402
from discovery.models import Item  # noqa: E402

ATV, OMV = resolve.ATV, resolve.OMV


@pytest.fixture(autouse=True)
def sandbox(tmp_path, monkeypatch):
    monkeypatch.setattr(util, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(util, "CACHE_DIR", tmp_path / "data" / "cache")
    monkeypatch.setattr(util, "SITE_DATA_DIR", tmp_path / "site" / "data")
    monkeypatch.setattr(resolve, "YT_CACHE", tmp_path / "data" / "cache" / "youtube.json")
    monkeypatch.setattr(videos, "CACHE", tmp_path / "data" / "cache" / "videos.json")
    monkeypatch.setattr(videos, "REPORT", tmp_path / "site" / "data" / "videos.json")
    monkeypatch.setattr(videos, "RATINGS_PATH", tmp_path / "data" / "ratings.json")
    util.ensure_dirs()
    yield tmp_path


def _cfg():
    return util.load_config()


class FakeYT:
    """The watch playlist as YouTube Music pairs uploads: audio ↔ video, a lone audio track, a lone video."""
    pairs = {"aud1": "vid1", "aud2": "vid2"}                     # audio track → its official video
    playlist = {"PLVIDS": ["vid2", "other"]}                      # what the music-video playlist holds

    def __init__(self, **kw):
        self.watched = []
        self.fail = set()

    def get_watch_playlist(self, videoId=None, limit=1, **kw):
        self.watched.append(videoId)
        if videoId in self.fail:
            raise RuntimeError("network")
        if videoId in self.pairs:
            return {"tracks": [{"videoId": videoId, "videoType": ATV, "counterpart": {"videoId": self.pairs[videoId], "videoType": OMV, "title": "Song (Official Video)"}}]}
        back = {v: a for a, v in self.pairs.items()}
        if videoId in back:
            return {"tracks": [{"videoId": videoId, "videoType": OMV, "counterpart": {"videoId": back[videoId], "videoType": ATV}}]}
        if videoId == "lonevid":
            return {"tracks": [{"videoId": "lonevid", "videoType": "MUSIC_VIDEO_TYPE_UGC"}]}
        return {"tracks": [{"videoId": videoId, "videoType": ATV}]}

    def get_playlist(self, pid, limit=None):
        if pid not in self.playlist:
            raise RuntimeError("no such playlist")
        return {"tracks": [{"videoId": v} for v in self.playlist[pid]]}

    def search(self, q, filter=None, limit=None):
        return [{"resultType": "song", "title": q.split(" ", 1)[1], "artists": [{"name": q.split(" ", 1)[0]}], "videoId": "aud1" if "One" in q else "aud3", "videoType": ATV, "album": {"name": "LP", "id": "MPREb_1"}}]

    def get_album(self, bid):
        return {"title": "LP", "year": "2026", "audioPlaylistId": "OLAK_1", "tracks": []}


def test_video_side_reads_both_sides_of_the_pair():
    yt = FakeYT()
    assert resolve.video_side(yt, "aud1") == {"videoId": "vid1", "videoType": OMV, "title": "Song (Official Video)"}   # an audio track's video
    assert resolve.video_side(yt, "vid1") == {"videoId": "vid1", "videoType": OMV, "title": None}                      # a video is its own video side
    assert resolve.video_side(yt, "lonevid") == {"videoId": "lonevid", "videoType": "MUSIC_VIDEO_TYPE_UGC", "title": None}
    assert resolve.video_side(yt, "aud3") is None                                                                       # nothing paired (yet)
    yt.fail.add("aud1")
    with pytest.raises(RuntimeError):
        resolve.video_side(yt, "aud1")                                                                                  # a failed request is not "no video"
    # the audio side is read from the same answer, as before
    assert resolve.watch_info(yt, "vid1") == (OMV, "aud1") and resolve.audio_counterpart(yt, "vid1") == "aud1"
    assert resolve.watch_info(yt, "aud2") == (ATV, "aud2")


def test_the_resolver_records_each_cards_video_side(monkeypatch):
    """A fresh audio hit is asked for its video once; a video hit swapped for its audio track already knows it; a
    card with no video is asked again after `videos.recheck_days`; the budget bounds the lookups; the feed's
    public row carries `video` only when there is one."""
    from discovery.build import _public_item, video_summary

    yt = FakeYT()
    monkeypatch.setitem(sys.modules, "ytmusicapi", types.SimpleNamespace(YTMusic=lambda **kw: yt))
    cfg = _cfg()
    cfg["videos"] = {**cfg["videos"], "feed_lookups_per_run": 2, "recheck_days": 30}
    one = Item(artist="Band", title="One", kind="track")          # searched: aud1, paired with vid1
    three = Item(artist="Band", title="Three", kind="track")      # searched: aud3, no video
    resolve.resolve_all([one, three], cfg)
    assert one.youtube["videoId"] == "aud1" and one.youtube["video"] == "vid1" and one.youtube["videoKind"] == OMV
    assert three.youtube["videoId"] == "aud3" and three.youtube["video"] is None
    cache = util.read_json(resolve.YT_CACHE, {})
    today = date.today().isoformat()
    assert cache[one.key]["vid"] == today and cache[three.key]["vid"] == today
    assert yt.watched == ["aud1", "aud3"]
    # what feed.json carries: `video` for a card that has one, no key at all for one asked and found without
    pub = _public_item(one, today)["youtube"]; assert pub["video"] == "vid1" and pub["videoKind"] == OMV and "videoFrom" not in pub
    assert "video" not in _public_item(three, today)["youtube"] and "videoKind" not in _public_item(three, today)["youtube"]
    assert video_summary([one, three, Item(artist="x", title="y")]) == {"with_video": 1, "no_video": 1, "pending": 0}

    # cached rows: an audio hit from before the video side existed is asked once; one asked recently with no video
    # waits; one asked long ago with no video is asked again; the budget (2) leaves the fourth for the next run
    stale, fresh = (date.today() - timedelta(days=40)).isoformat(), (date.today() - timedelta(days=2)).isoformat()
    old = Item(artist="Old", title="Row", kind="track"); waiting = Item(artist="Wait", title="Row", kind="track")
    again = Item(artist="Again", title="Row", kind="track"); fourth = Item(artist="Fourth", title="Row", kind="track")
    cache[old.key] = {"seen": fresh, "yt": {"videoId": "aud2", "title": "Row", "artists": ["Old"], "videoType": ATV}, "v": resolve.CACHE_VERSION}
    cache[waiting.key] = {"seen": fresh, "yt": {"videoId": "aud3", "title": "Row", "artists": ["Wait"], "videoType": ATV, "video": None}, "v": resolve.CACHE_VERSION, "vid": fresh}
    cache[again.key] = {"seen": fresh, "yt": {"videoId": "aud1", "title": "Row", "artists": ["Again"], "videoType": ATV, "video": None}, "v": resolve.CACHE_VERSION, "vid": stale}
    cache[fourth.key] = {"seen": fresh, "yt": {"videoId": "aud2", "title": "Row", "artists": ["Fourth"], "videoType": ATV}, "v": resolve.CACHE_VERSION}
    util.write_json(resolve.YT_CACHE, cache)
    yt.watched.clear()
    resolve.resolve_all([old, waiting, again, fourth], cfg)
    assert yt.watched == ["aud2", "aud1"]
    assert old.youtube["video"] == "vid2" and again.youtube["video"] == "vid1" and waiting.youtube["video"] is None and "video" not in fourth.youtube
    assert video_summary([old, waiting, again, fourth]) == {"with_video": 2, "no_video": 1, "pending": 1}

    # a video hit swapped for its audio track keeps the video it came from: no second request
    yt.watched.clear()
    found = {"videoId": "vid1", "title": "Song", "artists": ["Band"], "videoType": OMV}
    assert resolve.prefer_audio(yt, found) and found["videoId"] == "aud1" and found["video"] == "vid1" and found["videoKind"] == OMV and found["videoFrom"] == "vid1"
    assert resolve.attach_video(yt, found) and yt.watched == ["vid1"]
    # …and an unlabelled hit that turns out to be the audio track learns its video side from the same answer
    found = {"videoId": "aud2", "title": "Song", "artists": ["Band"]}
    assert resolve.prefer_audio(yt, found) and found["videoType"] == ATV and found["video"] == "vid2"
    # a failed request records nothing, so the card is asked again next time
    yt.fail.add("aud3"); found = {"videoId": "aud3", "videoType": ATV}
    assert resolve.attach_video(yt, found) is False and "video" not in found
    # the switch: videos.enabled false asks nothing
    yt.watched.clear(); cfg["videos"]["enabled"] = False
    fresh_item = Item(artist="Band", title="One", kind="track"); util.write_json(resolve.YT_CACHE, {})
    resolve.resolve_all([fresh_item], cfg)
    assert yt.watched == [] and "video" not in fresh_item.youtube


def test_the_video_list_is_built_from_the_playlist_scan(monkeypatch):
    """Every playlist row's video, one row per video: rows that are videos count as they stand, audio rows are asked
    a batch a run and cached, what the music-video playlist holds and what the tab decided are left out, and the
    counts say what is still waiting."""
    yt = FakeYT()
    monkeypatch.setitem(sys.modules, "ytmusicapi", types.SimpleNamespace(YTMusic=lambda **kw: yt))
    cfg = _cfg()
    cfg["youtube_music"]["videos_playlist_id"] = "PLVIDS"
    cfg["videos"] = {**cfg["videos"], "lookups_per_run": 2, "recheck_days": 30}
    entries = [
        {"year": "2026", "playlistId": "PL2026", "position": 0, "videoId": "aud1", "artist": "Band", "title": "One", "album": "LP", "videoType": ATV, "avail": True},
        {"year": "2026", "playlistId": "PL2026", "position": 1, "videoId": "lonevid", "artist": "Solo", "title": "Own Video", "videoType": "MUSIC_VIDEO_TYPE_UGC", "avail": True},
        {"year": "2025", "playlistId": "PL2025", "position": 3, "videoId": "aud2", "artist": "Band", "title": "Two", "videoType": ATV, "avail": True},   # its video is in the playlist already
        {"year": "2024", "playlistId": "PL2024", "position": 7, "videoId": "aud1", "artist": "Band", "title": "One", "videoType": ATV, "avail": True},   # the same song filed twice: one row
        {"year": "2023", "playlistId": "PL2023", "position": 2, "videoId": "aud3", "artist": "Band", "title": "Three", "videoType": ATV, "avail": True},  # no video
        {"year": "2022", "playlistId": "PL2022", "position": 5, "videoId": "aud4", "artist": "Band", "title": "Four", "videoType": ATV, "avail": True},   # over budget this run
    ]
    profile = {"youtube": {"entries": entries, "checked_at": "2026-09-13T00:00:00+00:00"}}
    report = videos.build_videos(cfg, profile=profile)
    rows = {r["video"]: r for r in report["rows"]}
    assert yt.watched == ["aud1", "aud2"]                                                     # newest year first, two a run; the 2024 copy of aud1 is the cache
    assert set(rows) == {"vid1", "lonevid"} and report["count"] == 2
    assert rows["vid1"]["years"] == ["2026", "2024"] and rows["vid1"]["year"] == "2026" and rows["vid1"]["videoId"] == "aud1" and rows["vid1"]["kind"] == OMV and rows["vid1"]["own"] is False
    assert rows["vid1"]["artist"] == "Band" and rows["vid1"]["title"] == "One" and rows["vid1"]["album"] == "LP" and rows["vid1"]["position"] == 0 and rows["vid1"]["playlistId"] == "PL2026"
    assert rows["lonevid"]["own"] is True and rows["lonevid"]["kind"] == "MUSIC_VIDEO_TYPE_UGC" and rows["lonevid"]["videoId"] == "lonevid"
    assert report["in_playlist"] == 1 and report["pending"] == 2 and report["no_video"] == 0 and report["looked_up"] == 2 and report["playlist_id"] == "PLVIDS"
    assert [r["year"] for r in report["rows"]] == ["2026", "2026"]
    assert util.read_json(videos.REPORT, {})["count"] == 2
    cache = util.read_json(videos.CACHE, {})
    assert cache["aud1"]["video"] == {"videoId": "vid1", "videoType": OMV} and cache["aud2"]["video"]["videoId"] == "vid2" and "aud3" not in cache

    # the next run reuses the cache and gets to the rest; a song with no video is remembered as such
    yt.watched.clear(); cfg["videos"]["lookups_per_run"] = 10
    report = videos.build_videos(cfg, profile=profile)
    assert yt.watched == ["aud3", "aud4"] and report["pending"] == 0 and report["no_video"] == 2
    assert {r["video"] for r in report["rows"]} == {"vid1", "lonevid"}
    assert util.read_json(videos.CACHE, {})["aud3"]["video"] is None

    # what the tab decided leaves the list; a no-video row older than recheck_days is asked again
    util.write_json(videos.RATINGS_PATH, {"version": 1, "rated": {}, "videos": {"vid1": {"decision": "up", "at": 1}, "lonevid": {"decision": "down", "at": 2}, "junk": "no"}})
    cache = util.read_json(videos.CACHE, {}); cache["aud3"]["at"] = (date.today() - timedelta(days=45)).isoformat(); util.write_json(videos.CACHE, cache)
    yt.watched.clear()
    report = videos.build_videos(cfg, profile=profile)
    assert yt.watched == ["aud3"] and report["count"] == 0 and report["decided"] == 2
    assert videos.video_decisions() == {"vid1": {"decision": "up", "at": 1}, "lonevid": {"decision": "down", "at": 2}}

    # a playlist that cannot be read hides nothing (better a duplicate probe on the site than a video lost from the list)
    util.write_json(videos.RATINGS_PATH, {"version": 1, "rated": {}})
    cfg["youtube_music"]["videos_playlist_id"] = "PLGONE"
    report = videos.build_videos(cfg, profile=profile)
    assert {r["video"] for r in report["rows"]} == {"vid1", "vid2", "lonevid"} and report["in_playlist"] == 0
    # a failed lookup is not recorded as "no video"
    yt.fail.add("aud4"); cache = util.read_json(videos.CACHE, {}); del cache["aud4"]; util.write_json(videos.CACHE, cache)
    report = videos.build_videos(cfg, profile=profile)
    assert report["pending"] == 1 and "aud4" not in util.read_json(videos.CACHE, {})
    # the switch
    cfg["videos"]["enabled"] = False
    assert videos.build_videos(cfg, profile=profile) is None


def test_the_feed_names_the_video_playlist_and_counts_the_cards_that_know_their_video(monkeypatch, tmp_path):
    import discovery.build as build
    from discovery import learn
    from discovery import profile as prof

    monkeypatch.setattr(build, "FEED_PATH", tmp_path / "site" / "data" / "feed.json")
    monkeypatch.setattr(build, "STATE_PATH", tmp_path / "data" / "state.json")
    monkeypatch.setattr(build, "SITE_DATA_DIR", tmp_path / "site" / "data")
    monkeypatch.setattr(prof, "PROFILE_PATH", tmp_path / "data" / "profile.json")
    monkeypatch.setattr(learn, "RATINGS_PATH", tmp_path / "data" / "nope.json")
    util.write_json(prof.PROFILE_PATH, {"built_at": "2026-09-01T00:00:00+00:00", "artists": {"band": {"name": "Band", "affinity": 1.0, "kind": "direct", "mbid": None, "via": []}},
                                        "mbid_index": {}, "tags": {}, "saved": {}, "picks": [], "youtube": {}, "counts": {}})
    items = [Item(artist="Band", title="One", kind="track", sources=["rss:Blog"], release_date=date.today()), Item(artist="Band", title="Three", kind="track", sources=["rss:Blog"], release_date=date.today())]
    monkeypatch.setattr(build, "run_sources", lambda cfg, profile, http, deadline=None: items)

    def fake_resolve(its, cfg, deadline=None, avoid=None):
        its[0].youtube = {"videoId": "aud1", "videoType": ATV, "video": "vid1", "videoKind": OMV}
        its[1].youtube = {"videoId": "aud3", "videoType": ATV, "video": None}
    monkeypatch.setattr(build, "resolve_all", fake_resolve)
    monkeypatch.setattr(build, "verify_years", lambda items, cfg, http, deadline=None: None)
    monkeypatch.setattr(build, "annotate_duplicate_years", lambda d, cfg, http, deadline=None: 0)
    monkeypatch.setattr(build, "unavailable_report", lambda p, cfg, deadline=None: {"count": 0, "with_counterpart": 0, "pending": 0})

    class NoNet:
        def __init__(self, *a, **k): self.deadline = None
        def save(self): pass
    monkeypatch.setattr(build, "Http", NoNet)
    cfg = _cfg(); cfg["ranking"]["min_score"] = 0
    payload = build.build_feed(cfg)
    assert payload["youtube"]["videos_playlist_id"] == "PLTW5JZnPjE_r0Y2WwYFLFAbEVZTlt6xuX"
    assert payload["youtube"]["videos"] == {"with_video": 1, "no_video": 1, "pending": 0}
    by = {i["title"]: i for i in payload["items"]}
    assert by["One"]["youtube"]["video"] == "vid1" and "video" not in by["Three"]["youtube"]
    assert cfg["ranking"]["max_items"] == 500                                       # the day's list: 500 songs to review
