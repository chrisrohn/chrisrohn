"""Offline tests for the source plugins, the per-source look-back, the caches and the Http conditional / retry paths."""
from __future__ import annotations

import sys
import threading
import time
from datetime import date, timedelta
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from discovery import util  # noqa: E402
from discovery.models import Item  # noqa: E402


@pytest.fixture(autouse=True)
def sandbox(tmp_path, monkeypatch):
    """Redirect all on-disk state into a temp dir (the same set test_pipeline.py redirects, plus the source caches)."""
    monkeypatch.setattr(util, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(util, "CACHE_DIR", tmp_path / "data" / "cache")
    monkeypatch.setattr(util, "SITE_DIR", tmp_path / "site")
    monkeypatch.setattr(util, "SITE_DATA_DIR", tmp_path / "site" / "data")
    import discovery.resolve as resolve
    import discovery.sources.deezer as deezer
    import discovery.sources.youtube_channels as yc
    import discovery.sources.ytmusic_artists as yta

    monkeypatch.setattr(resolve, "YT_CACHE", tmp_path / "data" / "cache" / "youtube.json")
    monkeypatch.setattr(deezer, "ID_CACHE", tmp_path / "data" / "cache" / "deezer_artists.json")
    monkeypatch.setattr(yta, "CACHE", tmp_path / "data" / "cache" / "ytmusic_artists.json")
    monkeypatch.setattr(yc, "CACHE", tmp_path / "data" / "cache" / "yt_channels.json")
    util.ensure_dirs()
    yield tmp_path


PROFILE = {
    "artists": {
        "jungle": {"name": "Jungle", "affinity": 1.0, "kind": "direct", "mbid": "m-jungle", "via": []},
        "roosevelt": {"name": "Roosevelt", "affinity": 0.7, "kind": "direct", "mbid": "m-roosevelt", "via": []},
        "parcels": {"name": "Parcels", "affinity": 0.3, "kind": "similar", "mbid": None, "via": ["Jungle"]},
    },
    "mbid_index": {"m-jungle": "jungle", "m-roosevelt": "roosevelt"},
    "tags": {"nu disco": 1.0, "indie pop": 0.8},
    "saved": {},
}
TODAY = date.today()


def _cfg():
    return util.load_config()


class Recorder:
    """A fake Http that answers from a routing function and remembers every call."""

    def __init__(self, route):
        self.route, self.calls = route, []

    def get(self, url, **kw):
        self.calls.append((url, kw))
        return self.route(url, kw)

    def post(self, url, **kw):
        self.calls.append((url, kw))
        return self.route(url, kw)


# ---------------------------------------------------------------- look-back + versioned caches + negative cache


def test_source_days_falls_back_to_listenbrainz_then_ten():
    cfg = {"sources": {"rss": {"days": 21}, "listenbrainz_fresh": {"days": 90}, "deezer": {}}}
    assert util.source_days(cfg, "rss") == 21
    assert util.source_days(cfg, "deezer") == 90
    assert util.source_days({"sources": {"deezer": {}}}, "deezer") == 10
    assert util.source_days({}, "nothing", 7) == 7
    live = _cfg()
    for key, want in (("rss", 21), ("deezer", 45), ("radio", 14), ("musicbrainz_labels", 60), ("youtube_channels", 30),
                      ("spotify", 30), ("reddit", 7), ("nts", 14), ("apple_music", 30), ("musicbrainz_artists", 60)):
        assert util.source_days(live, key) == want, key


def test_versioned_cache_helpers(sandbox):
    p = sandbox / "data" / "cache" / "x.json"
    util.write_json(p, {"a": 1}, compact=True)                          # written before stamps existed: version 1
    assert util.read_versioned(p, 1, {}) == {"a": 1}
    assert util.read_versioned(p, 2, {"fresh": True}) == {"fresh": True}   # mismatch, no migration: discarded
    assert util.read_versioned(p, 2, {}, migrate=lambda d, old: {**d, "migrated_from": old}) == {"a": 1, "migrated_from": 1}
    assert util.read_versioned(p, 2, {"x": 0}, migrate=lambda d, old: None) == {"x": 0}    # a migration that gives up
    util.write_versioned(p, 2, {"b": 2})
    assert util.read_json(p, {}) == {"v": 2, "b": 2}
    assert util.read_versioned(p, 2, {}) == {"b": 2}                    # the stamp never leaks into the map
    assert util.read_versioned(sandbox / "missing.json", 3, {"d": 1}) == {"d": 1}
    assert util.miss_expired({"miss": (TODAY - timedelta(days=31)).isoformat()}) and not util.miss_expired({"miss": TODAY.isoformat()})
    assert util.miss_expired({"miss": "garbage"}) and not util.miss_expired(123) and not util.miss_expired(None)


def test_deezer_negative_cache_migrates_and_expires(sandbox):
    from discovery.sources import deezer

    util.write_json(deezer.ID_CACHE, {"jungle": 11, "roosevelt": None}, compact=True)   # the old plain map: a miss cached for good
    searched = []

    def route(url, kw):
        if url.endswith("/search/artist"):
            searched.append(kw["params"]["q"])
            return {"data": []}
        return {"data": [{"title": "New EP", "record_type": "ep", "release_date": TODAY.isoformat(), "id": 5, "link": "https://deezer/5"}]}

    cfg = _cfg(); cfg["sources"]["deezer"]["editorial_genres"] = []
    out = deezer.fetch(cfg, PROFILE, Recorder(route))
    assert [i.title for i in out] == ["New EP"] and searched == []       # the hit survived the migration; the fresh miss is not retried
    stored = util.read_json(deezer.ID_CACHE, {})
    assert stored["v"] == deezer.ID_CACHE_VERSION and stored["jungle"] == 11 and stored["roosevelt"] == {"miss": TODAY.isoformat()}

    stored["roosevelt"] = {"miss": (TODAY - timedelta(days=40)).isoformat()}
    util.write_json(deezer.ID_CACHE, stored, compact=True)
    deezer.fetch(cfg, PROFILE, Recorder(route))
    assert searched == ["Roosevelt"]                                       # a month-old miss is asked again
    assert util.read_json(deezer.ID_CACHE, {})["roosevelt"] == {"miss": TODAY.isoformat()}


def test_deezer_own_days_window_and_editorial_skips(sandbox):
    from discovery.sources import deezer

    old = (TODAY - timedelta(days=40)).isoformat()

    def route(url, kw):
        if url.endswith("/search/artist"):
            return {"data": [{"name": "Jungle", "id": 1}]}
        if "/editorial/" in url:
            return {"data": [
                {"title": "Now That's What I Call Disco", "record_type": "compile", "release_date": TODAY.isoformat(), "artist": {"name": "Various"}, "id": 1},
                {"title": "Keep Moving (Sped Up)", "record_type": "single", "release_date": TODAY.isoformat(), "artist": {"name": "Speedy"}, "id": 2},
                {"title": "Hits (8-Bit Tribute)", "record_type": "album", "release_date": TODAY.isoformat(), "artist": {"name": "Bits"}, "id": 3},
                {"title": "Nightcore Mix", "record_type": "album", "release_date": TODAY.isoformat(), "artist": {"name": "NC"}, "id": 4},
                {"title": "Glow", "record_type": "album", "release_date": TODAY.isoformat(), "artist": {"name": "Someone"}, "id": 5},
            ]}
        return {"data": [{"title": "Older EP", "record_type": "ep", "release_date": old, "id": 9}]}

    cfg = _cfg(); cfg["sources"]["deezer"]["editorial_genres"] = [85]; cfg["sources"]["deezer"]["days"] = 45
    out = deezer.fetch(cfg, PROFILE, Recorder(route))
    assert {(i.artist, i.title) for i in out} == {("Jungle", "Older EP"), ("Someone", "Glow")}
    cfg["sources"]["deezer"]["days"] = 10
    assert {i.title for i in deezer.fetch(cfg, PROFILE, Recorder(route))} == {"Glow"}   # the 40-day-old EP falls outside deezer's own window


def test_ytmusic_artists_uses_region_client_and_dated_misses(sandbox, monkeypatch):
    from discovery.sources import ytmusic_artists as yta

    util.write_json(yta.CACHE, {"ids": {"jungle": "UCjungle", "roosevelt": ""}, "cursor": 0}, compact=True)   # old shape: "" = miss for good
    made, searched = [], []

    class FakeYT:
        def search(self, q, filter=None, limit=None):
            searched.append(q); return []
        def get_artist(self, bid):
            return {"singles": {"results": [{"title": "Candle Flame", "year": str(TODAY.year), "browseId": "MPREb_x", "thumbnails": []}]}, "albums": {"results": []}}

    def fake_client(cfg):
        made.append(cfg["youtube_music"]["region"]); return FakeYT()
    monkeypatch.setattr(yta, "ytmusic", fake_client)

    out = yta.fetch(_cfg(), PROFILE, None)
    assert made == ["US"]                                                   # the same region-pinned constructor resolve uses
    assert [(i.artist, i.title) for i in out] == [("Jungle", "Candle Flame")] and searched == []
    stored = util.read_json(yta.CACHE, {})
    assert stored["v"] == yta.CACHE_VERSION and stored["ids"]["jungle"] == "UCjungle" and stored["ids"]["roosevelt"] == {"miss": TODAY.isoformat()}
    stored["ids"]["roosevelt"] = {"miss": (TODAY - timedelta(days=45)).isoformat()}
    util.write_json(yta.CACHE, stored, compact=True)
    yta.fetch(_cfg(), PROFILE, None)
    assert searched == ["Roosevelt"]


# ---------------------------------------------------------------- resolve: version markers


def test_resolve_rejects_other_versions_of_the_song():
    from discovery.resolve import _pick, version_mismatch

    assert version_mismatch("Keep Moving", "Keep Moving (Live)") and version_mismatch("Keep Moving", "Keep Moving - Acoustic")
    assert version_mismatch("Keep Moving", "Keep Moving (Sped Up)") and version_mismatch("Keep Moving", "Keep Moving [Karaoke Version]")
    assert version_mismatch("Keep Moving", "Keep Moving (Instrumental)") and version_mismatch("Keep Moving", "Keep Moving (Demo)")
    assert version_mismatch("Keep Moving", "Keep Moving", "Live at Wembley") and version_mismatch("Keep Moving", "Keep Moving", "MTV Unplugged")
    assert version_mismatch("Keep Moving", "Keep Moving (Roosevelt Remix)") and version_mismatch("Keep Moving", "Keep Moving (Extended Mix)")
    assert not version_mismatch("Keep Moving (Roosevelt Remix)", "Keep Moving (Roosevelt Remix)", "Keep Moving (Remixes)")   # the item is the remix
    assert not version_mismatch("Keep Moving", "Keep Moving (Radio Edit)") and not version_mismatch("Keep Moving", "Keep Moving (Original Mix)")
    assert not version_mismatch("Keep Moving", "Keep Moving (2016 Remaster)") and not version_mismatch("Keep Moving", "Keep Moving", "Deluxe Version")
    assert not version_mismatch("Live Forever", "Live Forever", "Live Forever") and not version_mismatch("Keep Moving", "Keep Moving", "Long Live the Kings")
    assert not version_mismatch("Keep Moving (Live at KEXP)", "Keep Moving (Live)")

    res = [
        {"resultType": "song", "title": "Keep Moving (Live)", "artists": [{"name": "Jungle"}], "videoId": "live", "videoType": "MUSIC_VIDEO_TYPE_ATV"},
        {"resultType": "song", "title": "Keep Moving", "artists": [{"name": "Jungle"}], "videoId": "acoustic", "album": {"name": "Acoustic Sessions"}},
        {"resultType": "song", "title": "Keep Moving (Sped Up)", "artists": [{"name": "Jungle"}], "videoId": "sped"},
        {"resultType": "song", "title": "Keep Moving", "artists": [{"name": "Jungle"}], "videoId": "studio", "videoType": "MUSIC_VIDEO_TYPE_UGC"},
    ]
    assert _pick(res, "Jungle", "Keep Moving")["videoId"] == "studio"        # the live / acoustic / sped-up takes never win, whatever their score
    assert _pick(res[:3], "Jungle", "Keep Moving") is None
    assert _pick(res, "Jungle", "Keep Moving (Live)")["videoId"] == "live"    # a live item may take the live recording


# ---------------------------------------------------------------- Http: Retry-After, throttle, conditional GET


class Resp:
    def __init__(self, status, text="", headers=None):
        self.status_code, self.text, self.headers = status, text, headers or {}

    def json(self):
        import json
        return json.loads(self.text)

    def raise_for_status(self):
        if self.status_code >= 400:
            import requests
            raise requests.HTTPError(str(self.status_code), response=self)


def test_retry_after_is_parsed_robustly(monkeypatch):
    assert util.parse_retry_after("7", 2.0) == 7.0 and util.parse_retry_after(" 3 ", 2.0) == 3.0
    soon = (util.utcnow() + timedelta(seconds=60)).strftime("%a, %d %b %Y %H:%M:%S GMT")
    assert 55 <= util.parse_retry_after(soon, 2.0) <= 60
    assert util.parse_retry_after("Thu, 01 Jan 2000 00:00:00 GMT", 2.0) == 0.0     # a date in the past: no wait
    assert util.parse_retry_after("soon-ish", 2.0) == 2.0 and util.parse_retry_after(None, 2.0) == 2.0 and util.parse_retry_after("", 2.0) == 2.0
    assert util.parse_retry_after(object(), 2.0) == 2.0

    h = util.Http("t")
    slept, answers = [], [Resp(429, headers={"Retry-After": "not a number, not a date"}), Resp(503, headers={"Retry-After": soon}), Resp(200, '{"ok": 1}')]
    monkeypatch.setattr(h.session, "request", lambda *a, **k: answers.pop(0))
    monkeypatch.setattr(util.time, "sleep", lambda s: slept.append(s))
    assert h.get("https://x.test/a", cache=False) == {"ok": 1}
    waits = [s for s in slept if s >= 1]                                   # the throttle's sub-second sleeps aside
    assert waits[0] == 2.0 and 30 >= waits[1] >= 29 and len(waits) == 2   # the backoff for the unreadable header; the date, capped at 30s


def test_throttle_sleeps_outside_the_lock(monkeypatch):
    h = util.Http("t")
    h.min_interval["x.test"] = 0.05
    seen = []

    def fake_sleep(s):
        seen.append((s, h._lock.locked()))
    monkeypatch.setattr(util.time, "sleep", fake_sleep)
    h._throttle("x.test"); h._throttle("x.test")
    assert seen and all(not locked for _, locked in seen) and seen[0][0] > 0
    # slots are handed out in order even across threads: the second caller waits roughly one interval longer
    h2 = util.Http("t2"); h2.min_interval["y.test"] = 0.02
    waits = []
    monkeypatch.setattr(util.time, "sleep", lambda s: waits.append(s))
    ts = [threading.Thread(target=h2._throttle, args=("y.test",)) for _ in range(3)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert len(waits) == 2 and max(waits) > min(waits)


def test_conditional_get_serves_the_stored_body_on_304(sandbox, monkeypatch):
    h = util.Http("t")
    sent, answers = [], [Resp(200, "<rss>v1</rss>", {"ETag": '"e1"', "Last-Modified": "Mon, 01 Sep 2026 00:00:00 GMT"}), Resp(304), Resp(200, "<rss>v2</rss>", {"ETag": '"e2"'})]

    def request(method, url, params=None, json=None, headers=None, timeout=None):
        sent.append(dict(headers or {})); return answers.pop(0)
    monkeypatch.setattr(h.session, "request", request)
    url = "https://blog.test/feed"
    assert h.get(url, as_json=False, cache=False, conditional=True) == "<rss>v1</rss>" and "If-None-Match" not in sent[0]
    assert h.get(url, as_json=False, cache=False, conditional=True) == "<rss>v1</rss>"      # 304: the stored text comes back
    assert sent[1]["If-None-Match"] == '"e1"' and sent[1]["If-Modified-Since"] == "Mon, 01 Sep 2026 00:00:00 GMT"
    assert h.get(url, as_json=False, cache=False, conditional=True) == "<rss>v2</rss>"      # a real change replaces it
    h.save()
    stored = util.read_json(h.etag_path, {})
    assert stored["v"] == util.ETAG_VERSION and stored[url]["etag"] == '"e2"' and stored[url]["body"] == "<rss>v2</rss>"
    # a fresh Http (next run) picks the validators up from disk; a body over the cap is not kept
    h2 = util.Http("t"); sent.clear()
    answers[:] = [Resp(304), Resp(200, "x" * (util.ETAG_BODY_MAX + 1), {"ETag": '"big"'})]
    monkeypatch.setattr(h2.session, "request", request)
    assert h2.get(url, as_json=False, cache=False, conditional=True) == "<rss>v2</rss>" and sent[0]["If-None-Match"] == '"e2"'
    h2.get(url, as_json=False, cache=False, conditional=True); h2.save()
    assert url not in util.read_json(h2.etag_path, {})
    # without `conditional` nothing changes: no validators are sent, and a 304 is whatever the server sent (an empty body)
    h3 = util.Http("t"); answers[:] = [Resp(304)]; sent.clear()
    monkeypatch.setattr(h3.session, "request", request)
    assert h3.get(url, as_json=False, cache=False) == "" and "If-None-Match" not in sent[0]


# ---------------------------------------------------------------- rss / youtube channels: parallel, ordered, conditional


def test_rss_and_channel_feeds_fetch_in_parallel_but_keep_order(monkeypatch):
    from discovery.sources import HEALTH, rss, youtube_channels

    def feed(artist, song, n):
        return f"""<?xml version="1.0"?><rss><channel><title>t</title><item><title>{artist} – "{song}"</title><link>https://blog/{n}</link>
                   <pubDate>{TODAY.strftime("%a, %d %b %Y 10:00:00 GMT")}</pubDate></item></channel></rss>"""

    class SlowHttp:
        def __init__(self): self.calls, self.lock = [], threading.Lock()
        def get(self, url, **kw):
            assert kw.get("conditional") is True and kw.get("cache") is False
            n = int(url.rstrip("/").split("/")[-1][-1])
            time.sleep(0.05 * (3 - n))                                    # the first feed answers last
            with self.lock:
                self.calls.append(url)
            if "videos.xml" in url:
                return f"""<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xt/schemas/2015">
                  <entry><yt:videoId>vid0000000{n}</yt:videoId><title>Jungle - Song {n}</title><published>{TODAY.isoformat()}T10:00:00+00:00</published></entry></feed>"""
            return feed("Jungle", f"Song {n}", n)

    cfg = _cfg()
    cfg["sources"]["rss"]["feeds"] = [{"name": f"Blog {n}", "url": f"https://blog{n}.test/feed{n}"} for n in (1, 2, 3)]
    http = SlowHttp()
    out = rss.fetch(cfg, PROFILE, http)
    assert [i.title for i in out] == ["Song 1", "Song 2", "Song 3"] and http.calls[0].endswith("feed3")   # answered out of order, emitted in order
    assert all(HEALTH[f"Blog {n}"]["kept"] == 1 for n in (1, 2, 3))

    cfg["sources"]["youtube_channels"]["channels"] = [{"name": f"Ch {n}", "channel": f"UC{'x' * 20}{n}"} for n in (1, 2, 3)]
    out = youtube_channels.fetch(cfg, PROFILE, SlowHttp())
    assert [i.title for i in out] == ["Song 1", "Song 2", "Song 3"] and [i.sources for i in out] == [["youtube:Ch 1"], ["youtube:Ch 2"], ["youtube:Ch 3"]]
    assert HEALTH["youtube:Ch 2"] == {"ok": True, "entries": 1, "kept": 1, "error": None} and "yt:Ch 2" not in HEALTH
    assert util.read_json(youtube_channels.CACHE, {}) == {"v": youtube_channels.CACHE_VERSION}


# ---------------------------------------------------------------- KEXP paging


def test_kexp_pages_back_to_the_last_cursor(sandbox):
    from discovery.sources import HEALTH, radio

    def play(n, hours_ago, artist="Nobody", rd=None):
        when = (util.utcnow() - timedelta(hours=hours_ago)).isoformat()
        return {"id": n, "artist": artist, "song": f"Song {n}", "album": "LP", "airdate": when, "release_date": rd}

    pages = {
        radio.KEXP_PLAYS: {"next": radio.KEXP_PLAYS + "?offset=200", "results": [play(1, 1, "Jungle"), play(2, 2, rd=TODAY.isoformat()), play(3, 3)]},
        radio.KEXP_PLAYS + "?offset=200": {"next": radio.KEXP_PLAYS + "?offset=400", "results": [play(4, 4, "Roosevelt"), play(5, 5, rd="1999-01-01")]},
        radio.KEXP_PLAYS + "?offset=400": {"next": None, "results": [play(6, 6, "Jungle")]},
    }
    http = Recorder(lambda url, kw: pages[url])
    cfg = _cfg(); cfg["sources"]["radio"]["somafm"] = []; cfg["sources"]["radio"]["pages"] = 2
    out = radio.fetch(cfg, PROFILE, http)
    assert [i.title for i in out] == ["Song 1", "Song 2", "Song 4"]              # profile artists or recent releases; page 3 is beyond the cap
    first = http.calls[0][1]["params"]
    assert first["limit"] == 200 and first["exclude_airbreaks"] == "true" and "airdate_after" in first and http.calls[0][1]["cache"] is False
    assert http.calls[1][0].endswith("offset=200") and http.calls[1][1].get("params") is None and len(http.calls) == 2
    assert HEALTH["radio:KEXP"] == {"ok": True, "entries": 5, "kept": 3, "error": None}
    song1, song2 = out[0], out[1]
    assert song1.date_kind == "sighting" and song1.release_date == TODAY and song2.date_kind == "release"
    cursor = util.read_json(radio.kexp_cache_path(), {})
    assert cursor["v"] == radio.KEXP_CACHE_VERSION and cursor["cursor"] == pages[radio.KEXP_PLAYS]["results"][0]["airdate"]

    # next run: asks for plays after the stored cursor, and keeps the cursor when nothing new aired
    http2 = Recorder(lambda url, kw: {"next": None, "results": []})
    assert radio.fetch(cfg, PROFILE, http2) == []
    assert http2.calls[0][1]["params"]["airdate_after"] == cursor["cursor"] and len(http2.calls) == 1
    assert util.read_json(radio.kexp_cache_path(), {})["cursor"] == cursor["cursor"]


# ---------------------------------------------------------------- new sources


def test_apple_music_charts(sandbox):
    from discovery.sources import HEALTH, apple_music

    def route(url, kw):
        assert "/us/music/" in url and ("most-recent-albums/100/albums.json" in url or "most-played/100/albums.json" in url)
        return {"feed": {"results": [
            {"artistName": "Jungle", "name": "Volcano II", "releaseDate": TODAY.isoformat(), "artworkUrl100": "https://a/100x100bb.jpg", "url": "https://music.apple.com/us/album/1", "genres": [{"name": "Music"}, {"name": "Dance"}], "id": "1"},
            {"artistName": "Some Popstar", "name": "Pop LP", "releaseDate": TODAY.isoformat(), "artworkUrl100": "https://a/100x100bb.jpg", "url": "https://music.apple.com/us/album/2", "genres": [{"name": "Pop"}], "id": "2"},
            {"artistName": "Metal Band", "name": "Skull", "releaseDate": TODAY.isoformat(), "url": "https://music.apple.com/us/album/3", "genres": [{"name": "Metal"}], "id": "3"},
            {"artistName": "Old Popstar", "name": "Old LP", "releaseDate": (TODAY - timedelta(days=60)).isoformat(), "url": "https://music.apple.com/us/album/4", "genres": [{"name": "Pop"}], "id": "4"},
        ]}}

    out = apple_music.fetch(_cfg(), PROFILE, Recorder(route))
    got = {(i.artist, i.title, tuple(i.sources)) for i in out}
    assert got == {("Jungle", "Volcano II", ("apple:most-recent",)), ("Some Popstar", "Pop LP", ("apple:most-recent",)),
                   ("Jungle", "Volcano II", ("apple:most-played",)), ("Some Popstar", "Pop LP", ("apple:most-played",))}
    j = next(i for i in out if i.artist == "Jungle")
    assert j.kind == "release" and j.artwork == "https://a/600x600bb.jpg" and j.links == {"apple music": "https://music.apple.com/us/album/1"}
    assert j.tags == ["dance"] and j.release_date == TODAY and not j.editorial
    assert HEALTH["apple:most-played"] == {"ok": True, "entries": 4, "kept": 2, "error": None}
    cfg = _cfg(); cfg["sources"]["apple_music"]["feeds"] = ["most-played"]; cfg["sources"]["apple_music"]["genres"] = ["Metal"]
    assert {i.artist for i in apple_music.fetch(cfg, PROFILE, Recorder(route))} == {"Jungle", "Metal Band"}


def test_musicbrainz_artists_rotates_and_shapes_release_groups(sandbox):
    from discovery.sources import musicbrainz_artists as mba

    def route(url, kw):
        q = kw["params"]["query"]
        assert url == mba.MB_SEARCH and kw["params"]["fmt"] == "json" and kw["params"]["limit"] == 25
        assert q.startswith("arid:m-") and f"TO {TODAY.isoformat()}]" in q
        if "m-jungle" in q:
            return {"release-groups": [
                {"id": "rg1", "title": "Candle Flame", "primary-type": "Single", "first-release-date": TODAY.isoformat(),
                 "artist-credit": [{"name": "Jungle", "artist": {"id": "m-jungle", "name": "Jungle"}}], "tags": [{"name": "Nu-Disco"}]},
                {"id": "rg2", "title": "Live in Paris", "primary-type": "Album", "secondary-types": ["Live"], "first-release-date": TODAY.isoformat(), "artist-credit": []},
            ]}
        return {"release-groups": []}

    cfg = _cfg(); cfg["sources"]["musicbrainz_artists"]["top_artists"] = 1
    http = Recorder(route)
    out = mba.fetch(cfg, PROFILE, http)                                   # only direct artists with an MBID: Jungle, Roosevelt
    assert len(out) == 1 and out[0].artist == "Jungle" and out[0].kind == "release" and out[0].release_type == "Single"
    assert out[0].release_date == TODAY and out[0].artist_mbids == ["m-jungle"] and out[0].sources == ["musicbrainz:artists"]
    assert out[0].links == {"musicbrainz": "https://musicbrainz.org/release-group/rg1"} and out[0].tags == ["nu disco"]
    assert util.read_json(mba.cache_path(), {}) == {"v": mba.CACHE_VERSION, "cursor": 1}
    assert mba.fetch(cfg, PROFILE, http) == [] and "m-roosevelt" in http.calls[-1][1]["params"]["query"]   # the pool rotates
    assert util.read_json(mba.cache_path(), {})["cursor"] == 0
    since = (TODAY - timedelta(days=60)).isoformat()
    assert f"firstreleasedate:[{since} TO" in http.calls[0][1]["params"]["query"]                          # its own 60-day window


def test_nts_tracklists(sandbox):
    from discovery.sources import HEALTH, nts

    aired = (TODAY - timedelta(days=2)).isoformat()

    def route(url, kw):
        if url.endswith("/shows/moxie/episodes"):
            assert kw["params"] == {"offset": 0, "limit": 2}
            return {"results": [
                {"episode_alias": "moxie-1st-september-2026", "name": "Moxie w/ Jungle", "broadcast": f"{aired}T13:00:00Z",
                 "links": [{"rel": "self", "href": "https://www.nts.live/api/v2/shows/moxie/episodes/moxie-1st-september-2026"}]},
                {"episode_alias": "moxie-old", "broadcast": "2020-01-01T13:00:00Z", "tracklist": [{"artist": "Jungle", "title": "Old Play"}]},
            ]}
        if url.endswith("/episodes/moxie-1st-september-2026"):
            return {"tracklist": [{"artist": "Jungle", "title": "Keep Moving"}, {"artist": "Nobody", "title": "x"}, {"artist": "Roosevelt & Jungle", "title": "Duet"}, {"artist": "Jungle", "title": "Keep Moving"}]}
        if url.endswith("/shows/bullion/episodes"):
            return {"results": [{"episode_alias": "b1", "broadcast": f"{aired}T10:00:00Z", "tracklist": [{"artist": "Roosevelt", "title": "Lovers"}]}]}
        raise RuntimeError("down")

    cfg = _cfg(); cfg["sources"]["nts"]["shows"] = ["moxie", "bullion", "gone"]
    out = nts.fetch(cfg, PROFILE, Recorder(route))
    assert [(i.artist, i.title, i.sources[0]) for i in out] == [("Jungle", "Keep Moving", "radio:NTS moxie"), ("Roosevelt & Jungle", "Duet", "radio:NTS moxie"), ("Roosevelt", "Lovers", "radio:NTS bullion")]
    k = out[0]
    assert k.editorial and k.date_kind == "sighting" and k.release_date == TODAY - timedelta(days=2) and k.blurb == "Moxie w/ Jungle"
    assert k.links == {"nts": "https://www.nts.live/shows/moxie/episodes/moxie-1st-september-2026"}
    assert HEALTH["radio:NTS moxie"] == {"ok": True, "entries": 4, "kept": 2, "error": None}
    assert HEALTH["radio:NTS gone"]["ok"] is False and "down" in HEALTH["radio:NTS gone"]["error"]


def test_reddit_link_posts(sandbox):
    from discovery.sources import HEALTH, reddit

    now = util.utcnow().timestamp()
    posts = [
        {"title": "Jungle - Keep Moving [Nu-Disco / Funk] (2026)", "url": "https://youtu.be/abc123def45", "score": 40, "created_utc": now - 3600, "permalink": "/r/indieheads/comments/1/x/"},
        {"title": "Roosevelt -- Lovers [Synthpop]", "url": "https://www.youtube.com/watch?v=zzz123def45&list=PL1", "score": 5, "created_utc": now - 7200, "permalink": "/r/indieheads/comments/2/x/"},
        {"title": "Parcels - Free [Indie Pop] (2025)", "url": "https://parcels.bandcamp.com/track/free", "score": 9, "created_utc": now, "permalink": "/r/indieheads/comments/3/x/"},
        {"title": "Someone - Low Score [Pop]", "url": "https://youtu.be/lowsc0re123", "score": 2, "created_utc": now},
        {"title": "Someone - Article [Pop]", "url": "https://pitchfork.com/reviews/x", "score": 50, "created_utc": now},
        {"title": "What are you listening to this week?", "url": "https://www.reddit.com/r/indieheads/comments/9/x/", "is_self": True, "score": 300, "created_utc": now},
        {"title": "Old Act - Old Song [Pop]", "url": "https://open.spotify.com/track/1", "score": 99, "created_utc": now - 30 * 86400},
        {"title": "No dash in this title at all", "url": "https://soundcloud.com/x/y", "score": 99, "created_utc": now},
    ]

    def route(url, kw):
        assert url == "https://www.reddit.com/r/indieheads/new.json" and kw["params"] == {"limit": 100} and kw["cache"] is False
        assert kw["headers"]["User-Agent"] == "chrisrohn-new-music/1.0 (+https://chrisrohn.com)"
        return {"data": {"children": [{"kind": "t3", "data": p} for p in posts]}}

    cfg = _cfg(); cfg["sources"]["reddit"]["subreddits"] = ["indieheads"]
    out = reddit.fetch(cfg, PROFILE, Recorder(route))
    assert [(i.artist, i.title) for i in out] == [("Jungle", "Keep Moving"), ("Roosevelt", "Lovers"), ("Parcels", "Free")]
    j, r, p = out
    assert j.stated_year == 2026 and j.tags == ["nu-disco", "funk"] and j.youtube is None and j.date_kind == "sighting" and j.release_date == TODAY
    assert j.links == {"youtube": "https://www.youtube.com/watch?v=abc123def45", "reddit": "https://www.reddit.com/r/indieheads/comments/1/x/"}
    assert j.sources == ["reddit:indieheads"] and not j.editorial and "40 points" in j.blurb
    assert r.links["youtube"] == "https://www.youtube.com/watch?v=zzz123def45" and r.stated_year is None and r.tags == ["synthpop"]
    assert p.links["bandcamp"] == "https://parcels.bandcamp.com/track/free" and p.stated_year == 2025
    assert HEALTH["reddit:indieheads"] == {"ok": True, "entries": 8, "kept": 3, "error": None}
    assert reddit.split_title("Artist - Song (2019) [Dream Pop]") == ("Artist - Song", 2019, ["dream pop"])
    assert reddit.link_family("https://www.youtube.com/watch?v=not-an-id") is None and reddit.link_family("javascript:x") is None


def test_bandcamp_slices(sandbox):
    from discovery.sources import bandcamp

    def item(url, title):
        return {"item_url": url, "band_name": "Glow Unit", "title": title, "item_type": "a", "release_date": TODAY.isoformat(), "track_count": 4}

    def route(url, kw):
        body = kw["json_body"]
        assert url == bandcamp.DISCOVER_URL and body["tag_norm_names"] == ["nu-disco"]
        if body["slice"] == "new":
            return {"results": [item("https://x.bandcamp.com/album/a", "A"), item("https://x.bandcamp.com/album/b", "B")]}
        assert body["slice"] == "top"
        return {"results": [item("https://x.bandcamp.com/album/b", "B"), item("https://x.bandcamp.com/album/c", "C")]}

    cfg = _cfg(); cfg["sources"]["bandcamp"]["tags"] = ["nu-disco"]
    http = Recorder(route)
    out = bandcamp.fetch(cfg, PROFILE, http)
    assert [(i.title, i.sources, i.editorial) for i in out] == [("A", ["bandcamp"], False), ("B", ["bandcamp"], False), ("C", ["bandcamp:top"], True)]
    assert [c[1]["json_body"]["slice"] for c in http.calls] == ["new", "top"]
    cfg["sources"]["bandcamp"]["slices"] = ["top"]
    assert [i.title for i in bandcamp.fetch(cfg, PROFILE, Recorder(route))] == ["B", "C"]


def test_new_sources_are_registered_and_enabled():
    from discovery.sources import PER_FEED_HEALTH, SOURCE_MODULES

    cfg = _cfg()
    for key in ("apple_music", "musicbrainz_artists", "nts", "reddit"):
        assert key in SOURCE_MODULES and cfg["sources"][key]["enabled"] is True
        assert callable(__import__(f"discovery.sources.{SOURCE_MODULES[key]}", fromlist=["fetch"]).fetch)
    assert {"nts", "reddit", "apple_music"} <= PER_FEED_HEALTH
    assert Item(artist="a", title="b").youtube is None
