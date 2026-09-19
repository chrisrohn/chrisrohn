"""Offline tests: exercise parsing, merging, scoring, building and decision handling with canned data."""
from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from discovery import util  # noqa: E402
from discovery.models import Item  # noqa: E402
from discovery.score import dedupe, score_items  # noqa: E402


@pytest.fixture(autouse=True)
def sandbox(tmp_path, monkeypatch):
    """Redirect all on-disk state into a temp dir."""
    monkeypatch.setattr(util, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(util, "CACHE_DIR", tmp_path / "data" / "cache")
    monkeypatch.setattr(util, "SITE_DIR", tmp_path / "site")
    monkeypatch.setattr(util, "SITE_DATA_DIR", tmp_path / "site" / "data")
    import discovery.build as build
    import discovery.profile as profile
    import discovery.resolve as resolve
    import discovery.sources.deezer as deezer

    monkeypatch.setattr(build, "FEED_PATH", tmp_path / "site" / "data" / "feed.json")
    monkeypatch.setattr(build, "STATE_PATH", tmp_path / "data" / "state.json")
    monkeypatch.setattr(build, "SITE_DATA_DIR", tmp_path / "site" / "data")
    monkeypatch.setattr(profile, "PROFILE_PATH", tmp_path / "data" / "profile.json")
    monkeypatch.setattr(profile, "ARTIST_CACHE_PATH", tmp_path / "data" / "cache" / "artists.json")
    monkeypatch.setattr(profile, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(resolve, "YT_CACHE", tmp_path / "data" / "cache" / "youtube.json")
    import discovery.years as years
    monkeypatch.setattr(years, "YEAR_CACHE", tmp_path / "data" / "cache" / "years.json")
    monkeypatch.setattr(deezer, "ID_CACHE", tmp_path / "data" / "cache" / "deezer_artists.json")
    util.ensure_dirs()
    yield tmp_path


def test_norm_and_parse():
    assert util.norm("The Bird & The Bee") == "bird and the bee"
    assert util.norm_track("Heartbeat (feat. Someone) [Radio Edit]") == "heartbeat"
    assert util.norm_track("Lovers (10th Anniversary Edition)") == "lovers"
    assert util.norm_track("Lovers (2016 Remaster) [Deluxe]") == "lovers"
    assert util.norm_track("Lovers - Remastered 2026") == "lovers"
    assert util.norm_track("Lovers (Club Remix)") == "lovers club remix"   # a remix is a different recording
    assert util.split_artists("Jungle & Roosevelt feat. Nao") == ["Jungle", "Roosevelt", "Nao"]
    assert util.split_artists("Belle and Sebastian with Kid x Ray") == ["Belle", "Sebastian", "Kid", "Ray"]
    assert util.split_artists("Belle and Sebastian with Kid x Ray", strict=True) == ["Belle and Sebastian with Kid x Ray"]
    assert util.parse_artist_title('Jungle – "Back On 74"') == ("Jungle", "Back On 74")
    assert util.parse_artist_title("Magdalena Bay Share New Song: Death & Romance") is None
    assert util.parse_date("2026-09-01") == date(2026, 9, 1)
    assert util.parse_date("2026-09") == date(2026, 9, 1)
    assert util.parse_date("Tue, 01 Sep 2026 10:00:00 GMT") == date(2026, 9, 1)


PROFILE = {
    "built_at": "2026-09-01T00:00:00+00:00",
    "artists": {
        "jungle": {"name": "Jungle", "affinity": 1.0, "kind": "direct", "mbid": "m-jungle", "via": ["lastfm:overall"]},
        "roosevelt": {"name": "Roosevelt", "affinity": 0.7, "kind": "direct", "mbid": None, "via": []},
        "parcels": {"name": "Parcels", "affinity": 0.3, "kind": "similar", "mbid": None, "via": ["Jungle"]},
        "tops": {"name": "TOPS", "affinity": 0.2, "kind": "genre", "mbid": None, "via": ["indie pop", "dream pop"]},
    },
    "mbid_index": {"m-jungle": "jungle"},
    "tags": {"nu disco": 1.0, "indie pop": 0.8, "metal": -3},
    "saved": {util.item_key("Jungle", "Back On 74"): {"artist": "Jungle", "title": "Back On 74"}},
}


def _cfg():
    return util.load_config()


def test_dedupe_and_score():
    today = date.today()
    items = [
        Item(artist="Jungle", title="Keep Moving", kind="track", release_date=today - timedelta(days=1), date_kind="sighting", sources=["rss:Pitchfork"], editorial=True),
        Item(artist="Jungle", title="Keep Moving", kind="track", release_date=today, sources=["bandcamp"], tags=["nu disco"]),
        Item(artist="Parcels", title="Day/Night II", kind="release", release="Day/Night II", release_date=today - timedelta(days=3), sources=["listenbrainz"], artist_mbids=[]),
        Item(artist="Unknown Metal Band", title="Skull", kind="release", release_date=today, sources=["musicbrainz"], tags=["metal"]),
        Item(artist="Someone New", title="Disco Dream", kind="release", release_date=today, sources=["musicbrainz"], tags=["nu disco", "indie pop"]),
    ]
    merged = dedupe(items)
    assert len(merged) == 4
    jungle = next(i for i in merged if i.artist == "Jungle")
    assert jungle.date_kind == "release" and jungle.release_date == today   # bandcamp's real date outranks the blog post date
    assert sorted(jungle.sources) == ["bandcamp", "rss:Pitchfork"] and jungle.editorial and "nu disco" in jungle.tags
    scored = score_items(merged, PROFILE, _cfg())
    assert scored[0].artist == "Jungle" and scored[0].match_kind == "direct"
    parcels = next(i for i in scored if i.artist == "Parcels")
    assert parcels.match_kind == "similar" and "similar to Jungle" in parcels.reasons
    metal = next(i for i in scored if i.artist == "Unknown Metal Band")
    assert metal.score < 0
    tagged = next(i for i in scored if i.artist == "Someone New")
    assert tagged.score > metal.score and "tags: nu disco, indie pop" in tagged.reasons


def test_listenbrainz_source_filters(monkeypatch):
    from discovery.sources import listenbrainz as lb

    payload = {"payload": {"releases": [
        {"artist_credit_name": "Jungle", "release_name": "New EP", "artist_mbids": ["m-jungle"], "release_date": date.today().isoformat(),
         "release_group_primary_type": "EP", "release_mbid": "r1", "release_group_mbid": "rg1", "caa_id": 1, "caa_release_mbid": "r1", "listen_count": 12},
        {"artist_credit_name": "Nobody", "release_name": "Whatever", "artist_mbids": ["x"], "release_date": date.today().isoformat(), "release_tags": ["polka"]},
        {"artist_credit_name": "Tagged Act", "release_name": "Mirrorball", "artist_mbids": ["y"], "release_date": date.today().isoformat(), "release_tags": ["nu-disco"]},
        {"artist_credit_name": "Jungle", "release_name": "Live at X", "artist_mbids": ["m-jungle"], "release_date": date.today().isoformat(),
         "release_group_primary_type": "Album", "release_group_secondary_type": "Live"},
    ]}}

    class FakeHttp:
        def get(self, url, **kw):
            return payload

    out = lb.fetch(_cfg(), PROFILE, FakeHttp())
    names = {(i.artist, i.title) for i in out}
    assert ("Jungle", "New EP") in names and ("Tagged Act", "Mirrorball") in names
    assert ("Nobody", "Whatever") not in names and ("Jungle", "Live at X") not in names
    ep = next(i for i in out if i.title == "New EP")
    assert ep.artwork and "coverartarchive" in ep.artwork and ep.links["musicbrainz"].endswith("rg1")


def test_bandcamp_and_rss_sources(monkeypatch):
    from discovery.sources import bandcamp, rss

    class FakeHttp:
        def post(self, url, **kw):
            return {"results": [{"item_url": "https://x.bandcamp.com/album/y", "band_name": "Glow Unit", "title": "Night Swim", "item_type": "a",
                                 "release_date": date.today().isoformat(), "track_count": 4, "item_image_id": 123,
                                 "featured_track": {"title": "Sodium"}, "band_location": "Berlin"}]}

        def get(self, url, **kw):
            return """<?xml version="1.0"?><rss><channel><title>t</title>
            <item><title>Roosevelt – &quot;Lovers&quot;</title><link>https://blog/1</link><pubDate>%s</pubDate><description>A shimmering new single.</description></item>
            <item><title>Some Unrelated News</title><link>https://blog/2</link></item>
            <item><title>Jungle announce tour</title><link>https://blog/3</link></item>
            <item><title>Jungle Share New Single “Candle Flame”</title><link>https://blog/4</link></item>
            </channel></rss>""" % date.today().strftime("%a, %d %b %Y 10:00:00 GMT")

    cfg = _cfg()
    cfg["sources"]["bandcamp"]["tags"] = ["nu-disco"]
    bc = bandcamp.fetch(cfg, PROFILE, FakeHttp())
    assert len(bc) == 1 and bc[0].kind == "track" and bc[0].title == "Sodium" and bc[0].release_type == "EP" and "nu disco" in bc[0].tags
    cfg["sources"]["rss"]["feeds"] = [{"name": "Blog", "url": "https://blog/feed"}]
    entries = rss.fetch(cfg, PROFILE, FakeHttp())
    got = {(i.artist, i.title) for i in entries}
    # a headline is a card only when it is about one song: tour news never is, however well we know the band
    assert got == {("Roosevelt", "Lovers"), ("Jungle", "Candle Flame")} and len(entries) == 2
    assert all(i.editorial for i in entries)


def test_build_feed_hides_saved_and_skipped(monkeypatch, sandbox):
    import discovery.build as build
    from discovery import profile as prof

    profile = dict(PROFILE)
    profile["saved"] = dict(PROFILE["saved"])
    profile["saved"][util.item_key("Roosevelt", "Lovers")] = {"artist": "Roosevelt", "title": "Lovers", "decision": "down"}
    profile["saved"][util.item_key("Parcels", "Lightenup")] = {"artist": "Parcels", "title": "Lightenup", "videoId": "vidSaved", "decision": "up"}
    profile["picks"] = [{"artist": "Jungle", "title": "Back On 74", "videoId": "v1", "year": "2026", "thumbnail": None, "album": None}]
    # the raw playlist scan: the build derives the duplicate report from it (same video in 2025 and 2026)
    entries = [{"year": "2026", "playlistId": "PL2026", "position": 0, "videoId": "dupVid", "artist": "Jungle", "title": "Candle Flame"},
               {"year": "2025", "playlistId": "PL2025", "position": 3, "videoId": "dupVid", "artist": "Jungle", "title": "Candle Flame"}]
    profile["youtube"] = {"years": {"2026": "PL2026"}, "skipped": "PLSKIP", "channel": "UC1", "entries": entries, "checked_at": "2026-09-01T00:00:00+00:00"}
    util.write_json(prof.PROFILE_PATH, profile)
    today = date.today()
    fake_items = [
        Item(artist="Jungle", title="Keep Moving", kind="track", release_date=today, sources=["rss:Pitchfork"], editorial=True),
        Item(artist="Jungle", title="Back On 74", kind="track", release_date=today, sources=["bandcamp"]),   # already in a year playlist
        Item(artist="Roosevelt", title="Lovers", kind="track", release_date=today, sources=["bandcamp"]),    # thumbed down → Skipped playlist
        Item(artist="Parcels", title="Lighten Up (Radio Mix)", kind="track", sources=["radio:KEXP"], editorial=True),   # different spelling, same video → hidden
        Item(artist="Parcels", title="Free", kind="track", sources=["radio:KEXP"], editorial=True, links={"kexp": "javascript:alert(1)", "article": ["https://kexp.org/x"]}),   # undated: first_seen fills the date as a sighting
        Item(artist="Someone New", title="Disco Dream", kind="release", release_date=today, sources=["musicbrainz"], tags=["nu disco"]),
        Item(artist="Parcels", title="Video Only", kind="track", release_date=today, sources=["rss:Pitchfork"], editorial=True),   # matched to a video with no audio side: not a card today
        Item(artist="Parcels", title="Unknown Kind", kind="track", release_date=today, sources=["rss:Pitchfork"], editorial=True),   # kind not known yet: not a card today either
        Item(artist="Unknown Metal Band", title="Skull", kind="release", release_date=today, sources=["musicbrainz"], tags=["metal"]),
        # older than the current timeframe: a candidate only because the day is thin (the artist watch reaches back)
        Item(artist="Roosevelt", title="Earlier Single", kind="track", release_date=date(today.year - 2, 3, 1), sources=["ytmusic"]),
        Item(artist="Roosevelt", title="Ancient Single", kind="track", release_date=date(2009, 3, 1), sources=["ytmusic"]),
    ]
    monkeypatch.setattr(build, "run_sources", lambda cfg, profile, http, deadline=None: list(fake_items))
    # the site flagged Keep Moving's video as the wrong one: the resolver hears about it, the saved map does not
    from discovery import learn
    monkeypatch.setattr(learn, "RATINGS_PATH", sandbox / "data" / "ratings.json")
    util.write_json(learn.RATINGS_PATH, {"version": 1, "rated": {util.item_key("Jungle", "Keep Moving"): {"decision": "wrong", "videoId": "vidOld", "artist": "Jungle", "title": "Keep Moving", "at": 1}}})
    seen_avoid = {}

    def fake_resolve(items, cfg, deadline=None, avoid=None):
        seen_avoid.update(avoid or {})
        for it in items:
            atv = "MUSIC_VIDEO_TYPE_ATV"
            if it.artist == "Jungle":
                it.youtube = {"videoId": "vid123", "title": it.title, "artists": ["Jungle"], "thumbnail": "https://i/x.jpg", "videoType": atv}
            if it.title.startswith("Lighten Up"):
                it.youtube = {"videoId": "vidSaved", "title": it.title, "artists": ["Parcels"], "via": "track-search", "videoType": atv}
            if it.title == "Free":
                it.youtube = {"videoId": "vidFree", "title": it.title, "artists": ["Parcels"], "videoType": atv}
            if it.title == "Video Only":
                it.youtube = {"videoId": "vidOMV", "title": it.title, "artists": ["Parcels"], "videoType": "MUSIC_VIDEO_TYPE_OMV"}
            if it.title == "Unknown Kind":
                it.youtube = {"videoId": "vidUnk", "title": it.title, "artists": ["Parcels"]}
            if it.title.endswith("Single"):
                it.youtube = {"videoId": "vid" + it.title[:3], "title": it.title, "artists": ["Roosevelt"], "videoType": atv}
    monkeypatch.setattr(build, "resolve_all", fake_resolve)
    monkeypatch.setattr(build, "verify_years", lambda items, cfg, http, deadline=None: None)
    monkeypatch.setattr(build, "annotate_duplicate_years", lambda dups, cfg, http, deadline=None: 0)

    class NoNet:
        def __init__(self, *a, **k): pass
        def save(self): pass
    monkeypatch.setattr(build, "Http", NoNet)

    cfg = _cfg()
    cfg["google"]["client_id"] = "abc.apps.googleusercontent.com"
    payload = build.build_feed(cfg)
    ids = {(i["artist"], i["title"]) for i in payload["items"]}
    assert ("Jungle", "Keep Moving") in ids                                            # flagged, not skipped: still a card
    assert seen_avoid == {util.item_key("Jungle", "Keep Moving"): {"vidOld"}}         # …resolved without the flagged upload
    assert ("Jungle", "Back On 74") not in ids
    assert ("Roosevelt", "Lovers") not in ids
    assert not any(t.startswith("Lighten Up") for _, t in ids)          # hidden by video id, whatever the spelling
    free = next(i for i in payload["items"] if i["title"] == "Free")
    assert free["release_date"] == today.isoformat() and free["date_kind"] == "sighting"   # never a "release" date
    assert "artist_mbids" not in free and "via" not in (free["youtube"] or {})               # trimmed for the site
    assert free["links"] == {"article": "https://kexp.org/x"}                                # only http(s) reaches an href
    dups = util.read_json(sandbox / "site" / "data" / "duplicates.json", {})
    assert dups["count"] == 1 and dups["kinds"] == {"cross-year": 1} and payload["youtube"]["duplicates_count"] == 1
    assert ("Unknown Metal Band", "Skull") not in ids
    assert ("Someone New", "Disco Dream") not in ids        # tag-only, no YouTube match → dropped
    assert ("Parcels", "Video Only") not in ids and ("Parcels", "Unknown Kind") not in ids   # no audio track (yet): not a card, editorial or not
    assert all(i["youtube"] and i["youtube"]["videoId"] for i in payload["items"])            # every card plays
    # the day is thin, so the older release fills in — marked as such, and dated by its own year, never today's
    older = next(i for i in payload["items"] if i["title"] == "Earlier Single")
    assert older["backfill"] is True and older["release_date"] == date(today.year - 2, 3, 1).isoformat()
    assert "filling in from %d" % (today.year - 2) in older["reasons"]
    assert ("Roosevelt", "Ancient Single") not in ids       # older than the backfill window: never pulled in
    assert payload["backfill"] == 1 and payload["backfill_candidates"] == 1
    assert payload["recent_since"] == today.year - 3 and payload["fresh_playable"] >= 1
    assert all(i["backfill"] is False for i in payload["items"] if i["title"] != "Earlier Single")
    assert payload["years"][0] >= 2026 and payload["years"][-1] == 1979
    assert payload["google"]["client_id"] == "abc.apps.googleusercontent.com"
    assert payload["google"]["curator_hashes"] == [build._email_hash("ChrisRohn@gmail.com")] and "curators" not in payload["google"]
    assert payload["google"]["guests"] is False and "{year}" in payload["google"]["guest_playlist_title_pattern"]
    pls = payload["youtube"]["playlists"]
    assert pls["2026"] == "PLTW5JZnPjE_q3bQltmawTeCJNF2VfH_dN" and len(pls) == 48   # config ids win over the profile's title matches
    assert payload["youtube"]["skipped_playlist_id"] == "PLSKIP"
    assert payload["youtube"]["audio"] == {"audio": len(payload["items"]), "video": 0, "unknown": 0} and payload["youtube"]["video_count"] == 0
    assert payload["picks"][0]["artist"] == "Jungle"
    assert (sandbox / "site" / "feed.xml").read_text().count("<item>") == len(payload["items"])


def test_the_build_splits_its_budget_between_fetching_and_resolving(monkeypatch, sandbox):
    """The daily job's clock reaches every slow phase: fetching gets at most half, resolution the rest. Without a
    budget nothing is bounded but the configured resolve window, exactly as before."""
    import discovery.build as build
    from discovery import learn
    from discovery import profile as prof

    util.write_json(prof.PROFILE_PATH, {**PROFILE, "picks": [], "youtube": {}, "counts": {}})
    monkeypatch.setattr(learn, "RATINGS_PATH", sandbox / "data" / "nope.json")
    seen = {}
    monkeypatch.setattr(build, "run_sources", lambda cfg, profile, http, deadline=None: seen.update(sources=deadline) or [])
    monkeypatch.setattr(build, "resolve_all", lambda items, cfg, deadline=None, avoid=None: seen.update(resolve=deadline))
    monkeypatch.setattr(build, "verify_years", lambda items, cfg, http, deadline=None: None)
    monkeypatch.setattr(build, "annotate_duplicate_years", lambda d, cfg, http, deadline=None: 0)
    monkeypatch.setattr(build, "unavailable_report", lambda p, cfg, deadline=None: {"count": 0, "with_counterpart": 0, "pending": 0})

    class NoNet:
        def __init__(self, *a, **k): self.deadline = None
        def save(self): pass
    monkeypatch.setattr(build, "Http", NoNet)

    cfg = _cfg()
    cfg["sources"]["time_budget_minutes"] = 14      # more than half of the budget below: the job's share wins
    cfg["resolve"]["youtube_share"] = 1.0
    build.build_feed(cfg, budget_minutes=20)
    assert 9.5 < seen["sources"].remaining_minutes <= 10                     # half of the 20 the job had left
    assert 19 < seen["resolve"].remaining_minutes <= 20                      # …and the rest, the configured 28 being more

    cfg["sources"]["time_budget_minutes"] = 3       # a smaller configured budget is respected as it stands
    build.build_feed(cfg, budget_minutes=20)
    assert 2.5 < seen["sources"].remaining_minutes <= 3

    build.build_feed(cfg)                                                    # no job budget: only the configured windows
    assert 2.5 < seen["sources"].remaining_minutes <= 3
    assert 27 < seen["resolve"].remaining_minutes <= 28

    # YouTube lookups get their configured share of the resolve window first; the year lookups take the rest
    cfg["resolve"]["youtube_share"] = 0.7
    build.build_feed(cfg, budget_minutes=20)
    assert 13.5 < seen["resolve"].remaining_minutes <= 14
    live = _cfg()
    assert 0.5 <= live["resolve"]["youtube_share"] <= 0.9                    # config.yaml: cards first, but the years still get a run


def test_discover_playlists_via_channel():
    from discovery.profile import discover_playlists

    class FakeYT:
        def get_playlist(self, pid, limit=None):
            return {"author": {"id": "UC1"}, "tracks": []}
        def get_user(self, cid):
            return {"playlists": {"params": "p"}}
        def get_user_playlists(self, cid, params):
            return [{"title": "2027 Indie Discotheque", "playlistId": "PL2027"}, {"title": "Indie Discotheque – Skipped", "playlistId": "PLSKIP"},
                    {"title": "Random Mix", "playlistId": "PLX"}, {"title": "2026 Indie Discotheque", "playlistId": "PLDUP"}]

    cfg = _cfg()
    cfg["youtube_music"]["channel_id"] = ""          # learn the channel from a playlist's author
    years, skipped, channel = discover_playlists(cfg, FakeYT())
    assert channel == "UC1" and skipped == "PLSKIP"
    assert years["2027"] == "PL2027"                                        # a new year is found by title
    assert years["2026"] == "PLTW5JZnPjE_q3bQltmawTeCJNF2VfH_dN"             # configured id wins over the duplicate
    assert len(years) == 49 and years["1979"] == "PLTW5JZnPjE_r_8aNRMTx9NT75iYguNwae"  # all 48 pinned years survive


def test_resolve_pick():
    from discovery.resolve import _pick

    res = [
        {"resultType": "song", "title": "Keep Moving", "artists": [{"name": "Jungle"}], "videoId": "a"},
        {"resultType": "song", "title": "Keep Moving (Karaoke)", "artists": [{"name": "Karaoke Kings"}], "videoId": "b"},
    ]
    assert _pick(res, "Jungle", "Keep Moving")["videoId"] == "a"
    assert _pick(res[1:], "Jungle", "Keep Moving") is None


def test_verify_years_identifier_chain(monkeypatch):
    """LB mapper → MB recording (high); no mapping → MB search; Deezer ISRC → MB; Discogs; iTunes; stated dates; unknown."""
    from discovery import resolve

    today = date.today()
    monkeypatch.setenv("DISCOGS_TOKEN", "tok")
    calls = []

    class FakeHttp:
        def get(self, url, **kw):
            p = kw.get("params", {}); calls.append((url, p))
            if "listenbrainz.org/1/metadata/lookup" in url:
                if p["artist_name"] == "Roosevelt":
                    return {"artist_credit_name": "Roosevelt", "recording_name": "Lovers", "recording_mbid": "rec-lovers", "metadata": {"release": {"year": 2024}}}
                if p["artist_name"] == "Tiga":   # the mapper wandered off to another song: must be rejected
                    return {"artist_credit_name": "Tiga", "recording_name": "Sunglasses at Night", "recording_mbid": "rec-wrong"}
                return {}
            if url.endswith("/recording/rec-lovers"):
                return {"first-release-date": "2016-08-19", "isrcs": ["DEA211600123"], "releases": [
                    {"date": "2024-01-01", "release-group": {"first-release-date": "2024-01-01", "secondary-types": ["Compilation"]}},
                    {"date": "2016-08-19", "release-group": {"first-release-date": "2016-08-19"}}]}
            if url.endswith("/recording/"):   # text search fallback
                if "Jungle" in p["query"]:
                    return {"recordings": [{"title": "Keep Moving", "artist-credit": [{"name": "Jungle"}], "releases": [{"date": "2021-05-13", "release-group": {"first-release-date": "2021-05-13"}}]}]}
                return {"recordings": []}
            if "/isrc/" in url:
                return {"recordings": [{"first-release-date": "2009-05-11", "releases": [{"date": "2009-05-11", "release-group": {"first-release-date": "2009-05-11"}}]}]} if url.endswith("CAX240900001") else {"recordings": []}
            if "deezer.com/search" in url:
                if "Tiga" in p["q"]:
                    return {"data": [{"id": 5, "title": "Shoes", "title_short": "Shoes", "artist": {"name": "Tiga"}, "album": {"id": 77}}]}
                if "RAC" in p["q"]:
                    return {"data": [{"id": 6, "title": "I Should've Guessed (feat. Speak)", "title_short": "I Should've Guessed", "artist": {"name": "RAC"}, "album": {"id": 78}}]}
                return {"data": []}
            if url.endswith("/track/5"):
                return {"isrc": "CAX240900001", "release_date": "2019-02-02"}   # a 2019 reissue on Deezer; ISRC leads MB to 2009
            if url.endswith("/track/6"):
                return {"isrc": "", "release_date": "2014-04-14"}
            if url.endswith("/album/77"):
                return {"release_date": "2019-02-02", "record_type": "album"}
            if url.endswith("/album/78"):
                return {"release_date": "2014-04-14", "record_type": "album"}
            if "discogs.com" in url:
                if p["artist"] == "RAC":
                    return {"results": [{"title": "RAC - Strangers", "year": "2014", "type": "master"}, {"title": "Someone Else - X", "year": "1980"}]}
                return {"results": []}
            if "itunes" in url:
                if "Someone" in p["term"]:
                    return {"results": [{"trackName": "Blog Only", "artistName": "Someone", "releaseDate": "2019-03-01T00:00:00Z"}]}
                return {"results": []}
            return {}

    items = [
        Item(artist="Roosevelt", title="Lovers", kind="track", release_date=today, sources=["listenbrainz"]),                        # LB → MB recording
        Item(artist="Jungle", title="Keep Moving", kind="track", release_date=today, sources=["bandcamp"]),                          # no mapping → MB search
        Item(artist="Tiga", title="Shoes", featuring=["Soulwax"], kind="track", release="Ciao!", sources=["radio:KEXP"]),             # Deezer ISRC → MB
        Item(artist="RAC", title="I Should've Guessed", featuring=["Speak"], kind="track", sources=["radio:SomaFM poptron"]),         # Deezer + Discogs agree
        Item(artist="Someone", title="Blog Only", kind="track", release_date=today, date_kind="sighting", sources=["rss:Pitchfork"]),  # only iTunes knows
        Item(artist="Nobody", title="Nothing", kind="track", sources=["rss:Blog"]),                                                   # nothing anywhere
        Item(artist="KEXP Act", title="Dated", kind="track", release_date=date(2009, 5, 11), sources=["radio:KEXP"]),                 # only the stated date
        Item(artist="Blogger", title="Old Song", kind="track", release_date=today, date_kind="sighting", sources=["rss:Blog"]),        # post date is a hint
    ]
    resolve.verify_years(items, _cfg(), FakeHttp())
    r, j, tiga, rac, s, n, kexp, blog = items
    assert (r.year, r.year_source, r.year_confidence, r.original_year) == (2016, "musicbrainz", "high", 2016)   # compilation ignored; today's date = reissue
    assert "MusicBrainz recording: 2016" in r.year_evidence and "ISRC registration year: 2016" in r.year_evidence
    assert (j.year, j.year_source, j.year_confidence) == (2021, "musicbrainz-search", "high")
    assert (tiga.year, tiga.year_source, tiga.year_confidence) == (2009, "musicbrainz-isrc", "high")             # not the 2019 reissue
    assert (rac.year, rac.year_source, rac.year_confidence) == (2014, "discogs", "high")
    assert (s.year, s.year_source, s.year_confidence) == (2019, "itunes", "medium")
    assert (n.year, n.year_source, n.year_confidence) == (None, "unknown", "low")                                   # never guess "this year"
    assert (kexp.year, kexp.year_source, kexp.year_confidence) == (2009, "release-date", "medium")
    assert (blog.year, blog.year_source, blog.year_confidence) == (today.year, "feed-date", "low")
    # the LB query used the plain title, never "… feat. Speak"; undated tracks were looked up before dated ones
    lb = [p for u, p in calls if "metadata/lookup" in u]
    assert {"artist_name": "RAC", "recording_name": "I Should've Guessed", "metadata": "true", "inc": "release"} in lb
    names = [p["artist_name"] for p in lb]
    assert names.index("Tiga") < names.index("Roosevelt")
    # second run: everything comes from the cache, no HTTP at all
    calls.clear(); resolve.verify_years(items, _cfg(), FakeHttp())
    assert not calls and tiga.year == 2009
    assert r.to_dict()["year_evidence"][0] == "MusicBrainz recording: 2016"


def test_rohn_standard_notation():
    from discovery.util import format_credit, parse_credit

    cases = {
        ("Jungle", "Keep Moving"): "Jungle - Keep Moving",
        ("Jungle", "Keep Moving (Roosevelt Remix)"): "Jungle - Keep Moving (Roosevelt Remix)",
        ("Jungle", "Keep Moving - Roosevelt Remix"): "Jungle - Keep Moving (Roosevelt Remix)",
        ("Jungle", "Keep Moving (feat. Nao)"): "Jungle - Keep Moving feat. Nao",
        ("Jungle", "Keep Moving feat. Nao"): "Jungle - Keep Moving feat. Nao",
        ("Jungle feat. Nao", "Keep Moving"): "Jungle - Keep Moving feat. Nao",
        ("Jungle ft. Nao & Erick the Architect", "Keep Moving (Purple Disco Machine Remix)"): "Jungle - Keep Moving feat. Nao & Erick the Architect (Purple Disco Machine Remix)",
        ("Jungle", "Keep Moving (feat. Nao) [Purple Disco Machine Remix]"): "Jungle - Keep Moving feat. Nao (Purple Disco Machine Remix)",
        ("Jungle", "Keep Moving (Poolside Rework)"): "Jungle - Keep Moving (Poolside Rework)",
        ("Jungle", "Keep Moving (Extended Mix)"): "Jungle - Keep Moving (Extended Mix)",
    }
    for (artist, title), want in cases.items():
        p = parse_credit(artist, title)
        assert format_credit(p["artist"], p["title"], p["featuring"], p["remixer"], p["remix_kind"]) == want, (artist, title)

    a = Item(artist="Jungle feat. Nao", title="Keep Moving (Purple Disco Machine Remix)").normalize_credit()
    b = Item(artist="Jungle", title="Keep Moving feat. Nao (Purple Disco Machine Remix)").normalize_credit()
    c = Item(artist="Jungle", title="Keep Moving").normalize_credit()
    assert a.display == b.display == "Jungle - Keep Moving feat. Nao (Purple Disco Machine Remix)"
    assert a.key == b.key and a.key != c.key           # remix is a different track; feat. spelling is not
    assert a.to_dict()["display_title"] == "Keep Moving feat. Nao (Purple Disco Machine Remix)"


def test_youtube_channel_feed_and_radio(monkeypatch, sandbox):
    import discovery.sources.youtube_channels as yc
    from discovery.sources import HEALTH, radio, youtube_channels
    monkeypatch.setattr(yc, "CACHE", sandbox / "data" / "cache" / "yt_channels.json")

    today = date.today()
    atom = f"""<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xt/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
      <entry><yt:videoId>abc123def45</yt:videoId><title>Jungle - Keep Moving (Official Video)</title><published>{today.isoformat()}T10:00:00+00:00</published><author><name>Toy Tonics</name></author><media:group><media:thumbnail url="https://i/t.jpg"/></media:group></entry>
      <entry><yt:videoId>zzz</yt:videoId><title>Toy Tonics Podcast #12 (DJ Set)</title><published>{today.isoformat()}T10:00:00+00:00</published></entry>
    </feed>"""

    class FakeHttp:
        def get(self, url, **kw):
            if "youtube.com/@" in url:
                return '<html>"externalId":"UCabcdefghijklmnopqrstu"</html>'
            if "videos.xml" in url:
                return atom
            if "kexp" in url:
                return {"results": [{"artist": "Roosevelt", "song": "Lovers", "album": "Polydans", "release_date": today.isoformat()},
                                    {"artist": "Nobody", "song": "Old", "release_date": "1999-01-01"}]}
            return "<songs><song><artist>Jungle</artist><title>Back On 74</title><album>Volcano</album></song><song><artist>Stranger</artist><title>x</title></song></songs>"

    cfg = _cfg()
    cfg["sources"]["youtube_channels"]["channels"] = [{"name": "Toy Tonics", "channel": "@toytonics"}]
    got = youtube_channels.fetch(cfg, PROFILE, FakeHttp())
    assert len(got) == 1 and got[0].youtube["videoId"] == "abc123def45" and got[0].artist == "Jungle" and got[0].title == "Keep Moving"
    assert HEALTH["youtube:Toy Tonics"]["kept"] == 1
    cfg["sources"]["radio"]["somafm"] = ["indiepop"]
    r = radio.fetch(cfg, PROFILE, FakeHttp())
    names = {(i.artist, i.title) for i in r}
    assert ("Roosevelt", "Lovers") in names and ("Jungle", "Back On 74") in names and ("Nobody", "Old") not in names and ("Stranger", "x") not in names


def test_discover_playlists_tolerant_titles_and_channel_from_author():
    from discovery.profile import discover_playlists

    class FakeYT:
        def get_playlist(self, pid, limit=None):
            return {"author": {"name": "Chris", "id": "UCxyz"}, "tracks": []}
        def get_user(self, cid):
            return {"playlists": {"params": "p"}}
        def get_user_playlists(self, cid, params):
            return [{"title": "Indie Discotheque 2027", "playlistId": "PL2027"}, {"title": "2028 - indie discotheque", "playlistId": "PL2028"},
                    {"title": "1978 Indie Discotheque", "playlistId": "PL1978"}, {"title": "Indie Discotheque favourites", "playlistId": "PLX"}]

    cfg = _cfg()
    years, skipped, channel = discover_playlists(cfg, FakeYT())
    assert channel == cfg["youtube_music"]["channel_id"] == "UCLyRuumpAkAqDKe3nmFZljw"   # configured id wins
    cfg["youtube_music"]["channel_id"] = ""
    assert discover_playlists(cfg, FakeYT())[2] == "UCxyz"                                   # otherwise learned from the author
    assert years["2027"] == "PL2027" and years["2028"] == "PL2028" and years["1978"] == "PL1978" and "PLX" not in years.values()
    assert years["1999"] == "PLTW5JZnPjE_rgIDfV4vL5g4EZ3SCc-R_d"             # pinned ids are never overridden by title matches


def test_edition_of_tells_the_editions_of_a_song_apart():
    from discovery.editions import YEAR_FREE, edition_of, song_key

    def ed(t):
        e = edition_of(t)
        return e["core"], e["edition"], e["label"]

    assert ed("Lovers") == ("Lovers", "original", "")
    assert ed("Lovers (Official Video)") == ("Lovers", "original", "Official Video")            # the upload's form, not another edition
    assert ed("Lovers - 2017 Remaster") == ("Lovers", "original", "2017 Remaster")
    assert ed("Lovers (Radio Edit)") == ("Lovers", "radio", "Radio Edit")
    assert ed("Lovers (Extended Mix)") == ("Lovers", "extended", "Extended Mix")
    assert ed("Lovers (Fred Falke Remix)") == ("Lovers", "remix", "Fred Falke Remix")
    assert ed("Wait Up (Midnight Version)") == ("Wait Up", "remix", "Midnight Version")
    assert ed("Lovers (Live at Glastonbury 2019)") == ("Lovers", "live", "Live At Glastonbury 2019")
    assert ed("Lovers (feat. A & B) [X Remix] (Radio Edit)") == ("Lovers", "remix", "X Remix · Radio Edit")   # the most specific wins
    assert edition_of("Lovers (feat. A & B)")["featuring"] == ["A", "B"]
    assert ed("Bloodletting (The Vampire Song)") == ("Bloodletting", "original", "The Vampire Song")   # a subtitle is shown, not judged
    assert ed("Part 2 - The Return") == ("Part 2 - The Return", "original", "")                        # a dashed tail naming no edition is the title
    assert song_key("Roosevelt", "Lovers (Official Video)") == song_key("roosevelt feat. Kim", "Lovers - 2017 Remaster") == ("roosevelt", "lovers")
    assert song_key("Roosevelt", "Lovers") != song_key("Roosevelt", "Lovers Part 2")
    assert "remix" in YEAR_FREE and "radio" not in YEAR_FREE


def test_find_duplicates_lists_every_copy_of_a_song_and_names_its_problems():
    from discovery.profile import find_duplicates, kinds_of

    def e(year, artist, title, pos, vid, **kw):
        return {"year": year, "playlistId": "PL" + year, "position": pos, "artist": artist, "title": title, "videoId": vid, **kw}

    entries = [
        e("2026", "Dark Chisme", "Suffer Like Me", 3, "v1"), e("2026", "Dark Chisme", "Suffer Like Me", 6, "v1"),               # the same video twice in one year
        e("2016", "Roosevelt", "Lovers", 0, "v4", album="Roosevelt", duration=241, videoType="MUSIC_VIDEO_TYPE_ATV"),
        e("2017", "Roosevelt", "Lovers (2017 Remaster)", 1, "v4"),                                                              # the same video in two years
        e("2023", "Jungle", "Back On 74", 0, "v2"), e("2023", "Jungle", "Back On 74 (Official Video)", 9, "v3", avail=False),  # two uploads of one edition
        e("2010", "Two Door Cinema Club", "Something Good Can Work", 0, "v5"), e("2011", "Two Door Cinema Club", "Something Good Can Work (Mitzi Remix)", 0, "v6"),   # two editions
        e("2020", "Solo", "Only Once", 0, "v7"),                                                                                # one copy: not a report item
    ]
    out = {d["artist"]: d for d in find_duplicates(entries)}
    assert set(out) == {"Dark Chisme", "Roosevelt", "Jungle", "Two Door Cinema Club"}
    assert out["Dark Chisme"]["kinds"] == ["same-video"] and out["Dark Chisme"]["count"] == 2 and out["Dark Chisme"]["uploads"] == 1
    assert out["Roosevelt"]["kinds"] == ["cross-year"] and out["Roosevelt"]["years"] == ["2017", "2016"] and out["Roosevelt"]["title"] == "Lovers"
    lovers = {r["year"]: r for r in out["Roosevelt"]["entries"]}
    assert (lovers["2016"]["album"], lovers["2016"]["duration"], lovers["2016"]["videoType"]) == ("Roosevelt", 241, "MUSIC_VIDEO_TYPE_ATV")
    assert lovers["2017"]["label"] == "2017 Remaster" and lovers["2017"]["edition"] == "original" and "album" not in lovers["2017"]
    assert out["Jungle"]["kinds"] == ["same-song"] and out["Jungle"]["uploads"] == 2
    assert next(r for r in out["Jungle"]["entries"] if r["videoId"] == "v3")["avail"] is False and "avail" not in next(r for r in out["Jungle"]["entries"] if r["videoId"] == "v2")
    assert out["Two Door Cinema Club"]["kinds"] == ["versions"] and out["Two Door Cinema Club"]["editions"] == ["original", "remix"]
    assert [d["artist"] for d in find_duplicates(entries)] == ["Dark Chisme", "Jungle", "Roosevelt", "Two Door Cinema Club"]   # newest year first
    # the site recomputes the problems as copies go: one copy left of the video means the extra-copy problem is solved
    assert kinds_of([{"playlistId": "PL2026", "year": "2026", "videoId": "v1", "edition": "original"}]) == []
    # the {video id: entries} form the profile builder uses still works
    assert find_duplicates({"v1": [e("2026", "A", "S", 0, "v1"), e("2026", "A", "S", 1, "v1")]})[0]["kinds"] == ["same-video"]


def test_lb_identify_falls_back_and_records_status(monkeypatch):
    import requests

    from discovery import years

    class Resp:
        def __init__(self, code, text): self.status_code, self.text = code, text

    class FakeHttp:
        def __init__(self): self.calls = []
        def get(self, url, **kw):
            p = kw.get("params", {}); self.calls.append(p)
            if "metadata" in p:                                   # the rich form is refused
                raise requests.HTTPError("400", response=Resp(400, "inc not allowed"))
            return {"artist_credit_name": "Tiga", "recording_name": "Shoes", "recording_mbid": "rec-1"}

    h = FakeHttp()
    data, status = years.lb_identify(h, "Tiga", "Shoes")
    assert status == "matched" and data["recording_mbid"] == "rec-1" and len(h.calls) == 2 and "metadata" not in h.calls[1]

    class Down:
        def get(self, url, **kw): raise requests.HTTPError("503", response=Resp(503, "<html>maintenance</html>"))
    assert years.lb_identify(Down(), "Tiga", "Shoes") == (None, "http 503: <html>maintenance</html>")

    class Wander:
        def get(self, url, **kw): return {"artist_credit_name": "Tiga", "recording_name": "Sunglasses at Night", "recording_mbid": "x"}
    assert years.lb_identify(Wander(), "Tiga", "Shoes")[1].startswith("rejected:")


def test_duplicates_get_verified_years_and_their_own_file(monkeypatch):
    from discovery import years
    from discovery.util import item_key, write_json

    # one cross-year duplicate already verified for the feed (cache hit, free), one needing a lookup
    write_json(years.YEAR_CACHE, {item_key("Roosevelt", "Lovers"): {"v": 2, "found": {"musicbrainz": 2016, "deezer": 2016}}})
    dups = [
        {"key": item_key("Roosevelt", "Lovers"), "artist": "Roosevelt", "title": "Lovers", "kind": "cross-year", "years": ["2017", "2016"], "count": 2, "entries": []},
        {"key": item_key("Bag Raiders", "Shooting Stars"), "artist": "Bag Raiders", "title": "Shooting Stars", "kind": "cross-year", "years": ["2010", "2009"], "count": 2, "entries": []},
        {"key": item_key("Austra", "Home"), "artist": "Austra", "title": "Home", "kind": "same-video", "kinds": ["same-video"], "years": ["2013"], "count": 2, "entries": []},
        {"key": item_key("Friendly Fires", "On Board"), "artist": "Friendly Fires", "title": "On Board", "kind": "same-song", "kinds": ["same-song"], "years": ["2009", "2008"], "count": 2, "entries": []},
    ]

    class FakeHttp:
        def get(self, url, **kw):
            if "metadata/lookup" in url:
                return {"artist_credit_name": "Bag Raiders", "recording_name": "Shooting Stars", "recording_mbid": "rec-br"}
            if url.endswith("/recording/rec-br"):
                return {"first-release-date": "2008-11-01", "isrcs": [], "releases": [{"date": "2008-11-01", "release-group": {"first-release-date": "2008-11-01"}}]}
            return {}

    cfg = _cfg(); cfg["resolve"]["max_duplicate_year_lookups_per_run"] = 5
    looked = years.annotate_duplicate_years(dups, cfg, FakeHttp())
    assert looked == 2                                                     # the two unverified songs filed in two years hit the network
    assert (dups[0]["verified_year"], dups[0]["verified_source"]) == (2016, "MusicBrainz recording")
    assert (dups[1]["verified_year"], dups[1]["verified_source"]) == (2008, "MusicBrainz recording")
    assert "verified_year" not in dups[2]                                   # same-video needs no year to clean up
    assert "verified_year" not in dups[3]                                   # looked up (two uploads in two years), nothing found for it


def test_dates_caches_and_deadline(monkeypatch):
    import time

    from discovery import resolve

    assert util.parse_date("2026-09-04T10:00:00+02:00") == date(2026, 9, 4)
    assert util.parse_date("2026") == date(2026, 1, 1) and util.parse_date("20260905") is None
    assert util.struct_time_to_date(time.gmtime(1_788_000_000)) == date(2026, 8, 29)   # UTC, not the runner's local time
    assert util.safe_url(" https://a.b/c ") == "https://a.b/c" and util.safe_url(["https://x.y"]) == "https://x.y"
    assert util.safe_url("javascript:alert(1)") is None and util.safe_url(None) is None

    d = util.Deadline(None); assert not d.expired and d.remaining_minutes == float("inf")
    d = util.Deadline(0.0001); time.sleep(0.02); assert d.expired

    today = date(2026, 9, 5)
    cache = {"fresh": {"seen": "2026-09-01", "yt": {"videoId": "a"}}, "old": {"seen": "2026-01-01", "yt": None}, "legacy": {"videoId": "b"}}
    kept = resolve.prune_cache(cache, today, 120)
    assert set(kept) == {"fresh"}                        # untouched legacy rows are stamped on load, not here
    assert resolve._entry({"videoId": "b"}, "2026-09-05") == {"seen": "2026-09-05", "yt": {"videoId": "b"}}
    assert resolve._entry(None, "2026-09-05") == {"seen": "2026-09-05", "yt": None}


def test_rss_feed_name_is_not_an_artist(monkeypatch):
    from discovery.sources import rss

    profile = dict(PROFILE, artists={**PROFILE["artists"], "clash": {"name": "The Clash", "affinity": 0.5, "kind": "direct", "mbid": None, "via": []}})
    xml = """<?xml version="1.0"?><rss><channel><title>Clash</title>
      <item><title>Clash Meets Quadeca: I Like Keeping Busy</title><link>https://clashmusic.com/a</link></item>
      <item><title>Jungle – "Keep Moving"</title><link>javascript:alert(1)</link></item>
    </channel></rss>"""

    class FakeHttp:
        def get(self, url, **kw):
            assert kw["headers"]["User-Agent"].startswith("Mozilla/5.0")
            return xml
    cfg = _cfg(); cfg["sources"]["rss"]["feeds"] = [{"name": "Clash", "url": "https://clashmusic.com/feed/"}]
    out = rss.fetch(cfg, profile, FakeHttp())
    assert [(i.artist, i.title) for i in out] == [("Jungle", "Keep Moving")]
    assert out[0].links == {}                                                    # a javascript: link never makes it in


def test_collaboration_credits_match_only_on_real_separators():
    from discovery.score import _match_artist

    profile = dict(PROFILE, artists={**PROFILE["artists"], "belle": {"name": "Belle", "affinity": 0.9, "kind": "direct", "mbid": None, "via": []}})
    entry, kind = _match_artist(Item(artist="Belle and Sebastian", title="x"), profile)
    assert entry is None                                                            # "and" is not a credit separator
    entry, kind = _match_artist(Item(artist="Jungle & Someone", title="x"), profile)
    assert entry["name"] == "Jungle" and kind == "direct"                          # "&" is
    entry, kind = _match_artist(Item(artist="Belle & Sebastian", title="x"), profile)
    assert entry["name"] == "Belle"


def test_cli_parses_commands(monkeypatch):
    from discovery import cli

    calls = []
    monkeypatch.setattr(cli, "setup_logging", lambda: None)
    monkeypatch.setattr(cli, "ensure_dirs", lambda: None)
    monkeypatch.setattr(cli, "load_config", lambda: {"profile": {}, "job": {"budget_minutes": 36}})
    import discovery.build as build
    import discovery.catalog as catalog
    import discovery.profile as profile
    import discovery.videos as videos
    monkeypatch.setattr(videos, "build_videos", lambda cfg, deadline_minutes=None, profile=None: calls.append("videos" if deadline_minutes is None else f"videos<{deadline_minutes:.0f}"))
    monkeypatch.setattr(build, "build_feed", lambda cfg, budget_minutes=None: calls.append("build" if budget_minutes is None else f"build<{budget_minutes:.0f}"))
    monkeypatch.setattr(profile, "build_profile", lambda cfg, http: calls.append("profile"))
    monkeypatch.setattr(catalog, "build_catalog", lambda cfg, deadline_minutes=None: calls.append("catalog" if deadline_minutes is None else f"catalog<{deadline_minutes:.0f}"))
    monkeypatch.setattr(cli, "_profile_stale", lambda cfg: False)
    assert cli.main(["build"]) == 0 and calls == ["build"]                      # `build` alone is unbounded
    assert cli.main(["catalog"]) == 0 and calls[-1] == "catalog"
    # `daily` hands the feed what is left of the job's budget after the profile build, so the workflow's timeout
    # never kills the run with the day's data unwritten
    assert cli.main(["daily", "--rebuild-profile"]) == 0 and calls[-2:] == ["profile", "build<36"]   # the catalog is its own workflow …
    assert cli.main([]) == 0 and calls[-1] == "build<36"                              # daily is the default
    monkeypatch.setattr(cli, "load_config", lambda: {"profile": {}, "catalog": {"in_daily": True}})
    assert cli.main(["daily"]) == 0 and calls[-2:] == ["build", "catalog<40"]        # … unless asked to ride along, with what is left of the job
    assert calls[-2] == "build"                                                      # no job budget configured: unbounded, as before
    assert cli.main(["videos"]) == 0 and calls[-1] == "videos"                       # the Video tab's list: its own workflow …
    monkeypatch.setattr(cli, "load_config", lambda: {"profile": {}, "videos": {"in_daily": True, "job_budget_minutes": 41}})
    assert cli.main(["daily"]) == 0 and calls[-2:] == ["build", "videos<41"]         # … and a rewrite at the end of the daily job when asked
    with pytest.raises(SystemExit):
        cli.main(["--no-such-flag"])


def test_resolve_pick_requires_the_title_when_known():
    from discovery.resolve import _pick

    res = [{"resultType": "song", "title": "Don't Trust the Night", "artists": [{"name": "NINA"}], "videoId": "x"}]
    assert _pick(res, "Nina", "To See You") is None            # same artist, another song: never "close enough"
    assert _pick(res, "Nina", None)["videoId"] == "x"          # no title known: the artist alone decides
    res.append({"resultType": "song", "title": "To See You (feat. Radio Wolf)", "artists": [{"name": "NINA"}], "videoId": "y"})
    assert _pick(res, "Nina", "To See You")["videoId"] == "y"


def test_resolve_plausible_and_title_track():
    from discovery.resolve import _album_track, plausible, titles_agree

    assert titles_agree("Say", "Say (feat. E.VAX)") and not titles_agree("Say", "Say Goodbye") and not titles_agree("Say", "Essay")
    assert titles_agree("Nostalgia", "Ocean & the Stars - Nostalgia (Official)", "Ocean & the Stars") and not titles_agree("You", "It's You", "Armand van Helden")
    single = Item(artist="Nina", title="To See You", kind="release", release="To See You")
    wrong = {"videoId": "a", "title": "Don't Trust the Night", "artists": ["NINA", "Radio Wolf"], "album": "Jukebox Dream, Vol. 1"}
    assert not plausible(single, wrong)
    assert plausible(single, {"videoId": "b", "title": "To See You", "artists": ["NINA"], "album": "To See You"})
    album = Item(artist="Nina", title="Jukebox Dream, Vol. 1", kind="release", release="Jukebox Dream, Vol. 1")
    assert plausible(album, wrong)                                   # an album card plays a track off that album
    assert not plausible(Item(artist="Ratatat", title="Say", kind="track"), {"videoId": "c", "title": "Say", "artists": ["Someone Else"]})
    tracks = [{"videoId": "1", "title": "BEO"}, {"videoId": "2", "title": "Just Like Fire"}]
    assert _album_track(tracks, Item(artist="Ratatat", title="Just Like Fire", kind="release", release="Just Like Fire"))["videoId"] == "2"
    assert _album_track(tracks, Item(artist="Ratatat", title="Magnifique", kind="release", release="Magnifique"))["videoId"] == "1"


def test_resolve_all_opens_releases_by_id_and_heals_stale_rows(monkeypatch, sandbox):
    import sys
    import types

    from discovery import resolve

    class FakeYT:
        albums = {"MPREb_single": {"title": "To See You", "year": "2026", "artists": [{"name": "NINA"}], "audioPlaylistId": "OLAK_single",
                                   "thumbnails": [{"url": "https://i/single.jpg"}], "tracks": [{"videoId": "vidSee", "title": "To See You", "artists": [{"name": "NINA"}]}]}}
        def get_album(self, bid):
            return self.albums[bid]
        def search(self, q, filter=None, limit=None):
            if filter == "songs":
                return [{"resultType": "song", "title": "Don't Trust the Night", "artists": [{"name": "NINA"}], "videoId": "vidDont"}]
            return []
    monkeypatch.setitem(sys.modules, "ytmusicapi", types.SimpleNamespace(YTMusic=FakeYT))
    single = Item(artist="Nina", title="To See You", kind="release", release="To See You", sources=["ytmusic"], links={"youtube music": "https://music.youtube.com/browse/MPREb_single"})
    other = Item(artist="Nina", title="Jukebox Dream, Vol. 2", kind="release", release="Jukebox Dream, Vol. 2", sources=["ytmusic"])
    stale = {"videoId": "vidDont", "title": "Don't Trust the Night", "artists": ["NINA"], "album": "Jukebox Dream, Vol. 1", "via": "album"}
    util.write_json(resolve.YT_CACHE, {single.key: {"seen": "2026-09-01", "yt": stale}, other.key: {"seen": "2026-09-01", "yt": stale}})
    resolve.resolve_all([single, other], _cfg())
    assert single.youtube["videoId"] == "vidSee" and single.youtube["year"] == "2026" and single.youtube["via"] == "album-id"
    assert single.kind == "track" and single.title == "To See You" and single.release == "To See You"
    assert other.youtube is None                                    # only another song by them exists: no result beats the wrong one
    cache = util.read_json(resolve.YT_CACHE, {})
    assert cache[single.key]["yt"]["videoId"] == "vidSee" and cache[single.key]["v"] == resolve.CACHE_VERSION
    assert cache[other.key]["yt"] is None and cache[other.key]["v"] == resolve.CACHE_VERSION
    # a good cached row is used as is, and still turns the release into a playable track card
    again = Item(artist="Nina", title="To See You", kind="release", release="To See You", sources=["ytmusic"])
    resolve.resolve_all([again], _cfg())
    assert again.youtube["videoId"] == "vidSee" and again.kind == "track"


def test_collapse_shared_videos():
    from discovery.resolve import collapse_shared_videos

    yt = {"videoId": "vidBEO", "title": "BEO", "artists": ["Ratatat"]}
    album = Item(artist="Ratatat", title="BEO", kind="track", release="Just Like Fire", sources=["ytmusic"], youtube=dict(yt), score=3.0)
    single = Item(artist="Ratatat", title="BEO", kind="track", release="BEO", sources=["bandcamp"], youtube=dict(yt), score=2.0, release_date=date(2026, 9, 1))
    other = Item(artist="Ratatat", title="Say", kind="track", youtube={"videoId": "vidSay", "title": "Say"}, score=1.0)
    out = collapse_shared_videos([album, single, other])
    assert [i.title for i in out] == ["BEO", "Say"]
    assert out[0].sources == ["ytmusic", "bandcamp"] and out[0].release_date == date(2026, 9, 1)


def test_decide_uses_the_stated_year():
    from discovery.years import decide

    it = Item(artist="Nina", title="To See You", kind="track", stated_year=2026)
    year, source, conf, ev = decide({}, it)
    assert (year, source, conf) == (2026, "ytmusic-year", "medium")
    it.youtube = {"videoId": "v", "year": "2026"}
    assert decide({}, it)[2] == "high"                             # the album page agrees
    assert decide({"musicbrainz": 1998}, it)[:2] == (1998, "musicbrainz")   # a catalogue fact beats a stated year
    it.release_date, it.date_kind = date(2026, 9, 5), "sighting"
    assert decide({}, it)[:2] == (2026, "ytmusic-year")             # a sighting date never outranks the stated year


def test_learn_from_history_moves_scores_without_quota(tmp_path):
    from discovery import learn

    hist = tmp_path / "history"
    hist.mkdir()
    today = date(2026, 9, 10)
    shown = [
        {"id": "k1", "v": "vk1", "a": "Jungle", "s": ["rss:Stereogum", "deezer"], "t": ["nu disco"], "r": 1},
        {"id": "k2", "v": "vk2", "a": "Roosevelt", "s": ["rss:Stereogum"], "t": ["nu disco"], "r": 2},
        {"id": "k3", "v": "vk3", "a": "Parcels", "s": ["rss:Stereogum"], "t": ["nu disco", "indie pop"], "r": 3},
        {"id": "s1", "v": "vs1", "a": "Metalhead", "s": ["musicbrainz"], "t": ["metal"], "r": 4},
        {"id": "p1", "v": "vp1", "a": "Nobody", "s": ["musicbrainz"], "t": ["metal"], "r": 5},
        {"id": "p2", "v": "vp2", "a": "Nobody", "s": ["musicbrainz"], "t": ["metal"], "r": 6},
        {"id": "p3", "v": "vp3", "a": "Nobody", "s": ["musicbrainz"], "t": ["metal"], "r": 7},
        # never on screen (ranked past the shortlist) or from before ranks were recorded: neither is a pass
        {"id": "deep", "v": "vd", "a": "Nobody", "s": ["musicbrainz"], "t": ["metal"], "r": 500},
        {"id": "unranked", "v": "vu", "a": "Nobody", "s": ["musicbrainz"], "t": ["metal"]},
    ]
    util.write_json(hist / "2026-09-01.json", {"date": "2026-09-01", "ids": [r["id"] for r in shown], "items": shown})
    # too recent to judge: inside the grace period, so it must not count as a pass
    util.write_json(hist / "2026-09-09.json", {"date": "2026-09-09", "ids": ["fresh"], "items": [{"id": "fresh", "v": "vf", "a": "Jungle", "s": ["rss:Stereogum"], "t": ["nu disco"]}]})
    # ancient history is ignored entirely
    util.write_json(hist / "2026-01-01.json", {"date": "2026-01-01", "ids": ["old"], "items": [{"id": "old", "v": "vo", "a": "Jungle", "s": ["rss:Stereogum"], "t": ["nu disco"]}]})
    saved = {"k1": {"videoId": "vk1", "decision": "up"}, "other-key": {"videoId": "vk2", "decision": "up"}, "k3": {"decision": "up"},
             "s1": {"videoId": "vs1", "decision": "down"}}
    profile = {"saved": saved}
    cfg = {"learn": {"grace_days": 3, "prior": 2, "min_exposures": 2, "shown_rank": 80, "half_life_days": 0}}
    learned = learn.learn_from_history(profile, cfg, hist, today=today)
    assert learned["outcomes"] == 7 and learned["kept"] == 3 and learned["skipped"] == 1     # k2 matched by video id, k3 by key
    assert learned["sources"]["rss:Stereogum"]["adj"] > 0 > learned["sources"]["musicbrainz"]["adj"]
    assert learned["tags"]["nu disco"]["adj"] > 0 > learned["tags"]["metal"]["adj"]
    assert learned["artists"]["nobody"]["adj"] < 0 and learned["artists"]["jungle"]["adj"] == 0   # one sighting: no opinion yet
    up, why = learn.adjustment(learned, ["rss:Stereogum"], ["nu disco"], "Jungle")
    down, why_down = learn.adjustment(learned, ["musicbrainz"], ["metal"], "Nobody")
    assert up > 0 > down and any(w.startswith("you keep") for w in why) and any("rarely" in w or "passed" in w for w in why_down)
    assert learn.adjustment(None, ["rss:Stereogum"], [], "x") == (0.0, [])
    assert learn.adjustment(learn.learn([]), ["rss:Stereogum"], [], "x") == (0.0, [])
    pub = learn.public_summary(learned)
    assert "artists" not in pub and pub["sources"]["rss:Stereogum"]["k"] == 3 and pub["keep_rate"] == learned["keep_rate"]

    # the same learning reaches the scores: a kept-from source outranks an otherwise identical pass-from source
    prof = {**PROFILE, "learned": learned}
    a = Item(artist="Someone New", title="A", kind="track", release_date=today, sources=["rss:Stereogum"], tags=["nu disco"])
    b = Item(artist="Someone New", title="B", kind="track", release_date=today, sources=["musicbrainz"], tags=["nu disco"])
    scored = score_items([a, b], prof, _cfg())
    assert scored[0].title == "A" and any(r.startswith("you keep") for r in scored[0].reasons)


def test_freshness_is_configurable_and_a_match_earns_no_bonus():
    today = date.today()
    cfg = _cfg()
    cfg["ranking"]["freshness_days"] = 10
    cfg["ranking"]["undated_freshness"] = 0.2
    fresh = Item(artist="Someone New", title="Now", kind="track", release_date=today, sources=["bandcamp"])
    stale = Item(artist="Someone New", title="Then", kind="track", release_date=today - timedelta(days=30), sources=["bandcamp"])
    undated = Item(artist="Someone New", title="When", kind="track", sources=["bandcamp"], youtube={"videoId": "v"})
    score_items([fresh, stale, undated], PROFILE, cfg)
    assert fresh.score > undated.score > stale.score      # an undated track sits below this week's release, above last month's
    assert undated.score == pytest.approx(0.2)          # a YouTube match earns nothing by itself (every card has one): only the undated share


def test_history_files_carry_learning_facts_and_rss_has_dates(monkeypatch, sandbox):
    import discovery.build as build
    from discovery import profile as prof

    util.write_json(prof.PROFILE_PATH, PROFILE)
    today = date.today()
    fake = [Item(artist="Jungle", title="Keep Moving", kind="track", release_date=today, sources=["rss:Pitchfork", "bandcamp"], tags=["nu disco"], artwork="https://i/x.jpg")]
    monkeypatch.setattr(build, "run_sources", lambda cfg, profile, http, deadline=None: list(fake))

    def fake_resolve(items, cfg, deadline=None, avoid=None):
        for it in items:
            it.youtube = {"videoId": "vid1", "title": it.title, "artists": ["Jungle"], "videoType": "MUSIC_VIDEO_TYPE_ATV"}
    monkeypatch.setattr(build, "resolve_all", fake_resolve)
    monkeypatch.setattr(build, "verify_years", lambda items, cfg, http, deadline=None: None)
    monkeypatch.setattr(build, "annotate_duplicate_years", lambda dups, cfg, http, deadline=None: 0)

    class NoNet:
        def __init__(self, *a, **k): pass
        def save(self): pass
    monkeypatch.setattr(build, "Http", NoNet)
    payload = build.build_feed(_cfg())
    hist = util.read_json(sandbox / "site" / "data" / "history" / f"{today.isoformat()}.json", {})
    assert hist["ids"] == [payload["items"][0]["id"]]
    assert hist["items"][0] == {"id": payload["items"][0]["id"], "v": "vid1", "a": "Jungle", "s": ["rss:Pitchfork", "bandcamp"], "t": ["nu disco"], "r": 1, "sc": payload["items"][0]["score"], "y": None, "m": "direct", "af": 1.0}
    assert payload["learned"]["outcomes"] == 0 and payload["learned"]["sources"] == {}
    rss = (sandbox / "site" / "feed.xml").read_text()
    assert "<pubDate>" in rss and "<lastBuildDate>" in rss and 'media:thumbnail url="https://i/x.jpg"' in rss
    assert "score" not in rss.split("<item>")[1] and "<category>nu disco</category>" in rss and f"/?t={payload['items'][0]['id']}" in rss


def test_headlines_become_cards_only_when_they_are_about_a_song():
    from discovery.headlines import headline_track, looks_like_news

    artists = {"chat": {"name": "Chat"}, "system": {"name": "The System"}, "years": {"name": "The Years"}, "trip": {"name": "Trip"},
               "fontaines d c": {"name": "Fontaines D.C."}, "m83": {"name": "M83"}, "pet shop boys": {"name": "Pet Shop Boys"}, "beyonce": {"name": "Beyoncé"},
               "julia jacklin": {"name": "Julia Jacklin"}, "clash": {"name": "The Clash"}}
    news = [
        "Wheel of Fortune’s Jim Thornton Suspended for Allegedly Viewing Pedophile Support Chat Room",
        "System of a Down Unveil Toxicity 25th Anniversary Reissue and Merch Capsule",
        "Bruce Campbell Reveals He Has About Five Years to Live",
        "Burning Man Sees Fourth Death In Four Years, Festival Gate Closed Again Due To Weather",
        "Best New Albums this week: girlfriend., Cyst (Iglooghost), corto.alto, Last Apollo, Chat Pile",
        "Trip Tease drops dreamy, 11-track debut album ‘Durango’ via clipp.art",     # the artist is Trip Tease, not Trip
        "Maribou State: We want proper time to reset physically and mentally",
        "Beyoncé Shares B’Day Selena Mashup Amid Escalating Dispute Between Late Singer’s Siblings",
        "Fontaines D.C. add second Slane Castle gig due to demand",
        "The Nialler9 Dublin Gig Guide: A$AP Rocky, Jack White, Marie Davidson",
        "Live Review: Blood Orange and more at Rally, London, 29 August 2026",
        "Clash Meets Quadeca: I Like Keeping Busy",
        "14 Best Songs of the Week: Interpol, Aluminum, Disgusting Sisters",
        "Aziz Ansari announce fall tour dates",
        "Crosby, Stills & Nash (Rhino High Fidelity Vinyl Reissue)",
    ]
    for h in news:
        assert headline_track(h, artists, {"clash"}) is None, h
    assert headline_track('Jungle – "Keep Moving"', artists) == ("Jungle", "Keep Moving", "track")
    assert headline_track('Watch: Roosevelt - "Lovers" (Official Video)', artists) == ("Roosevelt", "Lovers", "track")
    assert headline_track("Nighttime :: Looking Glass", artists) == ("Nighttime", "Looking Glass", "track")
    assert headline_track('Roosevelt: "Lovers"', artists) == ("Roosevelt", "Lovers", "track")
    assert headline_track("M83 Shares New Song “Blister Sunrise”", artists) == ("M83", "Blister Sunrise", "track")
    assert headline_track("Fontaines D.C. announce new album ‘Dopamine Chamber,’ share ‘Marianne,’", artists) == ("Fontaines D.C.", "Marianne", "track")
    assert headline_track("Pet Shop Boys announce new album ‘A Man From The Future’", artists) == ("Pet Shop Boys", "A Man From The Future", "release")
    assert headline_track("Julia Jacklin Performs on Top of a Skyscraper in the Video for New Song “The Hardest Thing”", artists) == ("Julia Jacklin", "The Hardest Thing", "track")
    assert headline_track("M83 Shares Surprise New Album It’s Nothing Personal", artists) is None      # no quoted title: nothing to file
    assert looks_like_news("Modeselektor Dublin DJ set announced") and not looks_like_news("Blister Sunrise")


def test_catalog_reviews_the_whole_play_history(monkeypatch, sandbox):
    """The catalog is every track the station has ever played on Last.fm (the whole of user.getTopTracks), loved ones
    flagged, dated by the scrobble log, minus what the playlists hold; the most played first, the tab given at most
    `max_items`; the snapshot is refreshed weekly and the scrobble walk resumes where it stopped."""
    from discovery import catalog
    from discovery import profile as prof

    profile = dict(PROFILE)
    profile["saved"] = {util.item_key("Jungle", "Back On 74"): {"artist": "Jungle", "title": "Back On 74", "videoId": "vBack", "decision": "up", "year": "2023"},
                        util.item_key("Roosevelt", "Lovers"): {"artist": "Roosevelt", "title": "Lovers", "decision": "down"}}
    profile["youtube"] = {"years": {"2016": "PL2016"}, "entries": [{"year": "2016", "playlistId": "PL2016", "position": 0, "videoId": "v"}] * 3 + [{"year": "2023", "playlistId": "PL2023", "position": 0, "videoId": "vBack"}]}
    util.write_json(prof.PROFILE_PATH, profile)
    monkeypatch.setattr(catalog, "CATALOG_PATH", sandbox / "site" / "data" / "catalog.json")
    monkeypatch.setattr(catalog, "STATE_PATH", sandbox / "data" / "catalog_state.json")
    monkeypatch.setattr(catalog, "TAGS_CACHE", sandbox / "data" / "cache" / "artist_tags.json")
    monkeypatch.setenv("LASTFM_API_KEY", "k")
    monkeypatch.setattr(catalog.time, "time", lambda: 1_700_000_000)
    calls = []
    # the scrobble log, newest first: Fire twice, the rest once; a play of Moving On lands after the first walk
    LOG = [(1_690_000_000, "Jungle", "Fire"), (1_680_000_000, "Roosevelt", "Moving On"), (1_600_000_000, "Jungle", "Fire (feat. Nobody)"),
           (1_500_000_000, "Parcels", "Overnight"), (1_400_000_000, "Jungle", "Back On 74")]
    LATE = [(1_699_000_000, "Roosevelt", "Moving On")]

    class FakeLastFm:
        def __init__(self, http, key): self.key = key
        enabled = True
        page_size = 2
        late = False
        def top_tracks(self, user, limit=0, period="overall"):
            calls.append(("top", limit))
            return [{"name": "Back On 74", "artist": {"name": "Jungle"}, "playcount": "300", "url": "https://last.fm/1"},   # already filed → hidden
                    {"name": "Fire", "artist": {"name": "Jungle"}, "playcount": "120", "url": "https://last.fm/2"},
                    {"name": "Lovers", "artist": {"name": "Roosevelt"}, "playcount": "90"},                               # skipped → hidden
                    {"name": "Moving On", "artist": {"name": "Roosevelt"}, "playcount": "40", "url": "javascript:x"},
                    {"name": "Overnight", "artist": {"name": "Parcels"}, "playcount": "12"}]
        def loved_tracks(self, user, limit=0):
            calls.append(("loved", limit))
            return [{"name": "Fire", "artist": {"name": "Jungle"}}, {"name": "Never Played", "artist": {"name": "Parcels"}}]
        def recent_tracks(self, user, *, from_uts=None, to_uts=None, page=1, limit=200):
            calls.append(("recent", from_uts, to_uts))
            log = sorted(LOG + (LATE if self.late else []), reverse=True)
            rows = [t for t in log if (from_uts is None or t[0] > from_uts) and (to_uts is None or t[0] <= to_uts)]
            rows = rows[(page - 1) * self.page_size: page * self.page_size]
            return ([{"date": {"uts": str(u)}, "artist": {"#text": a}, "name": n} for u, a, n in rows], {"total": str(len(log)), "totalPages": "9"})
        def top_tags(self, artist):
            return [{"name": "Nu Disco", "count": 100}, {"name": "rare", "count": 3}]
    monkeypatch.setattr(catalog, "LastFm", FakeLastFm)

    def fake_resolve(items, cfg, deadline=None, avoid=None):
        assert cfg["resolve"]["max_lookups_per_run"] == 800
        for it in items:
            if it.title != "Never Played":
                it.youtube = {"videoId": "v-" + util.norm(it.title), "title": it.title, "artists": [it.artist], "thumbnail": "https://i/x.jpg", "videoType": "MUSIC_VIDEO_TYPE_ATV"}
    monkeypatch.setattr(catalog, "resolve_all", fake_resolve)

    def fake_years(items, cfg, http, deadline=None):
        assert cfg["resolve"]["year_chain"] == "fast"
        for it in items:
            it.year, it.year_source, it.year_confidence = (2016, "musicbrainz-search", "high") if it.artist == "Jungle" else (None, "unknown", "low")
            if it.title == "Overnight":
                it.year_source = "pending"       # not looked up yet: held back until a run gets to it
    monkeypatch.setattr(catalog, "verify_years", fake_years)

    class NoNet:
        def __init__(self, *a, **k): pass
        def save(self): pass
    monkeypatch.setattr(catalog, "Http", NoNet)

    cfg = _cfg(); cfg["catalog"] = {**cfg["catalog"], "scrobble_pages_per_run": 2}
    payload = catalog.build_catalog(cfg, deadline_minutes=5)
    titles = {(i["artist"], i["title"]) for i in payload["items"]}
    assert ("Jungle", "Back On 74") not in titles and ("Roosevelt", "Lovers") not in titles   # a playlist or the Skipped playlist already has them
    assert ("Parcels", "Never Played") not in titles                                          # no YouTube match: nothing to file
    assert ("Parcels", "Overnight") not in titles and payload["pending"] == 1
    assert titles == {("Jungle", "Fire"), ("Roosevelt", "Moving On")}
    assert calls[:2] == [("top", 0), ("loved", 0)]                                            # every page of the history, every loved track
    fire = next(i for i in payload["items"] if i["title"] == "Fire")
    assert fire["plays"] == 120 and fire["loved"] is True and "120 plays" in fire["reasons"] and "loved on Last.fm" in fire["reasons"]
    assert fire["sources"] == ["lastfm:history", "lastfm:loved"] and fire["tags"] == ["nu disco"] and fire["links"] == {"last.fm": "https://last.fm/2"}
    assert fire["year"] == 2016 and fire["release_date"] is None and "listen_count" not in fire and "blurb" not in fire
    # the scrobble walk: two pages a run, newest first — four plays read, the oldest waits for a later run; a play of
    # "Fire (feat. Nobody)" is a play of Fire
    assert fire["first_played"] == "2020-09-13" and fire["last_played"] == "2023-07-22" and "last played Jul 2023" in fire["reasons"]
    moving = next(i for i in payload["items"] if i["title"] == "Moving On")
    assert moving["last_played"] == "2023-03-28" and moving["plays"] == 40
    assert payload["items"][0]["title"] == "Fire"                                             # most played + loved ranks first
    assert payload["years"]["2016"] == {"playlist": 3, "candidates": 1} and payload["years"]["2023"]["playlist"] == 1
    assert payload["undated"] == 1 and payload["sources"] == ["lastfm:history", "lastfm:loved"]
    assert payload["history"] == {"fetched_at": payload["history"]["fetched_at"], "tracks": 6, "scrobbles": 5, "dated": 2, "walked_back_to": "2017-07-14", "complete": False}
    state = util.read_json(sandbox / "data" / "catalog_state.json", {})
    assert state["fetched_at"] and len(state["candidates"]) == 6 and set(state["first_seen"]) == {i["id"] for i in payload["items"]}
    sc = state["scrobbles"]
    assert sc["newest"] == 1_690_000_000 and sc["oldest"] == 1_500_000_000 and not sc["complete"] and sc["gap"] is None
    assert [c for c in calls if c[0] == "recent"] == [("recent", None, None), ("recent", None, 1_679_999_999)]

    # the next run: a fresh snapshot is reused (Last.fm is not asked for the lists again for a week); the walk first
    # closes the gap since the newest play it knows, then goes on down; a play in the gap moves "last played"
    calls.clear(); FakeLastFm.late = True
    payload = catalog.build_catalog(cfg, deadline_minutes=5)
    assert not [c for c in calls if c[0] in ("top", "loved")]
    assert [c for c in calls if c[0] == "recent"] == [("recent", 1_690_000_001, 1_700_000_000), ("recent", 1_690_000_001, 1_698_999_999)]
    moving = next(i for i in payload["items"] if i["title"] == "Moving On")
    assert moving["last_played"] == "2023-11-03" and moving["first_played"] == "2023-03-28"
    sc = util.read_json(sandbox / "data" / "catalog_state.json", {})["scrobbles"]
    assert sc["newest"] == 1_699_000_000 and sc["gap"] is None and sc["oldest"] == 1_500_000_000
    # a third run with nothing new since: the walk goes on down, reaches the beginning of the log and says so
    calls.clear(); monkeypatch.setattr(catalog.time, "time", lambda: 1_698_999_999)
    cfg["catalog"]["scrobble_pages_per_run"] = 3
    payload = catalog.build_catalog(cfg, deadline_minutes=5)
    assert [c for c in calls if c[0] == "recent"] == [("recent", None, 1_499_999_999), ("recent", None, 1_399_999_999)]
    sc = util.read_json(sandbox / "data" / "catalog_state.json", {})["scrobbles"]
    assert sc["complete"] and sc["oldest"] == 1_400_000_000 and payload["history"]["complete"] and payload["history"]["walked_back_to"] == "2014-05-13"
    # the tab is given at most max_items, the best first; the rest wait
    cfg["catalog"]["max_items"] = 1
    payload = catalog.build_catalog(cfg, deadline_minutes=5)
    assert payload["count"] == 1 and payload["playable"] == 2 and payload["items"][0]["title"] == "Fire"
    # the history's plays, keyed like the cards, for the Videos workflow
    assert catalog.history_plays(util.read_json(sandbox / "data" / "catalog_state.json", {}))[catalog.history_key("Jungle", "Fire feat. Nobody")] == 120


def test_resolver_prefers_the_audio_track_and_the_original_issue():
    from discovery.resolve import ATV, _pick, album_year, audio_counterpart, prefer_audio

    res = [
        {"resultType": "song", "title": "Night By Night", "artists": [{"name": "Chromeo"}], "videoId": "omv", "videoType": "MUSIC_VIDEO_TYPE_OMV", "album": {"name": "Business Casual", "id": "MPREb_bc"}},
        {"resultType": "song", "title": "Night By Night", "artists": [{"name": "Chromeo"}], "videoId": "atv", "videoType": ATV, "album": {"name": "Business Casual", "id": "MPREb_bc"}},
        {"resultType": "video", "title": "Night By Night", "artists": [{"name": "Chromeo"}], "videoId": "ugc", "videoType": "MUSIC_VIDEO_TYPE_UGC"},
    ]
    assert _pick(res, "Chromeo", "Night By Night")["videoId"] == "atv"
    deluxe = [
        {"resultType": "song", "title": "Girlfriend Is Better", "artists": [{"name": "Talking Heads"}], "videoId": "dlx", "videoType": ATV, "album": {"name": "Speaking in Tongues (Deluxe Version)", "id": "MPREb_d"}},
        {"resultType": "song", "title": "Girlfriend Is Better", "artists": [{"name": "Talking Heads"}], "videoId": "orig", "videoType": ATV, "album": {"name": "Speaking in Tongues", "id": "MPREb_o"}},
    ]
    assert _pick(deluxe, "Talking Heads", "Girlfriend Is Better")["videoId"] == "orig"
    remix = [{"resultType": "song", "title": "Ultraviolence (Crom & Thanh Remix)", "artists": [{"name": "Lana Del Rey"}], "videoId": "rmx", "videoType": ATV, "album": {"name": "Ultraviolence (Remixes)", "id": "x"}}]
    assert _pick(remix, "Lana Del Rey", "Ultraviolence (Crom & Thanh Remix)")["videoId"] == "rmx"   # a remix card wants the remix album

    class FakeYT:
        def get_watch_playlist(self, videoId=None, limit=1, **kw):
            if videoId == "omv":
                return {"tracks": [{"videoId": "omv", "videoType": "MUSIC_VIDEO_TYPE_OMV", "counterpart": {"videoId": "atv", "videoType": ATV}}]}
            if videoId == "alone":
                return {"tracks": [{"videoId": "alone", "videoType": "MUSIC_VIDEO_TYPE_OMV"}]}
            raise RuntimeError("boom")
        def get_album(self, bid):
            return {"year": "2010", "audioPlaylistId": "OLAK_bc", "type": "Album"}
    yt = FakeYT()
    assert audio_counterpart(yt, "omv") == "atv" and audio_counterpart(yt, "alone") is None and audio_counterpart(yt, "err") is None
    found = {"videoId": "omv", "videoType": "MUSIC_VIDEO_TYPE_OMV", "albumBrowseId": "MPREb_bc", "year": None}
    prefer_audio(yt, found)
    assert found["videoId"] == "atv" and found["videoType"] == ATV and found["videoFrom"] == "omv"
    album_year(yt, found)
    assert found["year"] == "2010" and found["playlistId"] == "OLAK_bc" and found["albumType"] == "Album"
    keep = {"videoId": "atv", "videoType": ATV}
    prefer_audio(yt, keep)
    assert keep["videoId"] == "atv" and "videoFrom" not in keep                     # already the audio track: nothing to do


def test_resolve_all_heals_older_hits_for_audio_and_marks_new_rows(monkeypatch, sandbox):
    import sys
    import types

    from discovery import resolve

    class FakeYT:
        def search(self, q, filter=None, limit=None):
            if filter == "songs":
                return [{"resultType": "song", "title": "Helix", "artists": [{"name": "Justice"}], "videoId": "hOMV", "videoType": "MUSIC_VIDEO_TYPE_OMV", "album": {"name": "Helix", "id": "MPREb_h"}}]
            return []
        def get_watch_playlist(self, videoId=None, limit=1, **kw):
            return {"tracks": [{"videoId": videoId, "videoType": "MUSIC_VIDEO_TYPE_OMV", "counterpart": {"videoId": videoId + "-atv", "videoType": resolve.ATV}}]}
        def get_album(self, bid):
            return {"year": "2011", "audioPlaylistId": "OLAK_" + bid}
    monkeypatch.setitem(sys.modules, "ytmusicapi", types.SimpleNamespace(YTMusic=FakeYT))
    new = Item(artist="Justice", title="Helix", kind="track", sources=["lastfm:top tracks"])
    old = Item(artist="Chromeo", title="Night By Night", kind="track", sources=["lastfm:top tracks"])
    old_row = {"videoId": "nOMV", "title": "Night By Night", "artists": ["Chromeo"], "album": "Business Casual", "albumBrowseId": "MPREb_bc", "via": "track-search"}
    util.write_json(resolve.YT_CACHE, {old.key: {"seen": "2026-09-01", "yt": old_row, "v": 2}})
    resolve.resolve_all([new, old], _cfg())
    assert new.youtube["videoId"] == "hOMV-atv" and new.youtube["videoType"] == resolve.ATV and new.youtube["year"] == "2011" and new.youtube["playlistId"] == "OLAK_MPREb_h"
    assert old.youtube["videoId"] == "nOMV-atv" and old.youtube["videoFrom"] == "nOMV" and old.youtube["year"] == "2011"
    cache = util.read_json(resolve.YT_CACHE, {})
    assert cache[old.key]["v"] == resolve.CACHE_VERSION and cache[old.key]["yt"]["videoId"] == "nOMV-atv"
    # a second run leaves the healed row alone (no watch-playlist call, so a failing one would not matter)
    class Quiet(FakeYT):
        def get_watch_playlist(self, **kw): raise AssertionError("healed rows are not re-checked")
    monkeypatch.setitem(sys.modules, "ytmusicapi", types.SimpleNamespace(YTMusic=Quiet))
    again = Item(artist="Chromeo", title="Night By Night", kind="track")
    resolve.resolve_all([again], _cfg())
    assert again.youtube["videoId"] == "nOMV-atv"


def test_years_pending_marker_and_fast_chain(monkeypatch, sandbox):
    from discovery import years

    calls = []

    class FakeHttp:
        def get(self, url, **kw):
            calls.append(url)
            if "listenbrainz" in url:
                return {}
            if url.endswith("/recording/"):
                return {"recordings": []}
            if "deezer.com/search" in url:
                return {"data": []}
            raise AssertionError("the fast chain must not reach " + url)
    cfg = _cfg()
    cfg["resolve"] = {**cfg["resolve"], "max_year_lookups_per_run": 1, "year_chain": "fast"}
    monkeypatch.setenv("DISCOGS_TOKEN", "tok")
    first = Item(artist="Chromeo", title="Night By Night", kind="track", score=2.0, youtube={"videoId": "a", "year": "2010"})
    second = Item(artist="Justice", title="Helix", kind="track", score=1.0)

    class MuteYT:
        def get_song(self, video_id):
            return {}                                   # YouTube Music states no date either
    years.verify_years([first, second], cfg, FakeHttp(), yt=MuteYT())
    assert not any("discogs" in u or "itunes" in u for u in calls)
    assert (first.year, first.year_source, first.year_confidence) == (2010, "youtube", "low")   # nothing in the catalogues: the album year stands in
    assert second.year is None and second.year_source == "pending"                             # over budget: not looked up yet, not "unknown"
    cache = util.read_json(years.YEAR_CACHE, {})
    assert cache[first.key]["chain"] == "fast" and second.key not in cache


def test_unavailable_playlist_tracks_get_a_streamable_counterpart(monkeypatch, sandbox):
    import sys
    import types

    from discovery import unavailable

    monkeypatch.setattr(unavailable, "CACHE", sandbox / "data" / "cache" / "counterparts.json")
    monkeypatch.setattr(unavailable, "REPORT", sandbox / "site" / "data" / "unavailable.json")
    searches = []

    class FakeYT:
        def __init__(self, **kw): pass
        def search(self, q, filter=None, limit=None):
            searches.append((q, filter))
            if "Jungle" in q and filter == "songs":
                return [{"resultType": "song", "title": "Keep Moving", "artists": [{"name": "Jungle"}], "videoId": "deadJ", "videoType": "MUSIC_VIDEO_TYPE_OMV"},
                        {"resultType": "song", "title": "Keep Moving", "artists": [{"name": "Jungle"}], "videoId": "liveJ", "videoType": "MUSIC_VIDEO_TYPE_ATV", "album": {"name": "Loving In Stereo", "id": "MPREb_x"}}]
            if "Roosevelt" in q and filter == "videos":
                return [{"resultType": "video", "title": "Roosevelt - Lovers (Official Video)", "artists": [{"name": "Roosevelt"}], "videoId": "vidR", "videoType": "MUSIC_VIDEO_TYPE_OMV"}]
            return []
        def get_watch_playlist(self, videoId=None, limit=1, **kw):
            return {"tracks": [{"videoId": videoId, "videoType": "MUSIC_VIDEO_TYPE_OMV", "counterpart": {"videoId": videoId + "-atv", "videoType": "MUSIC_VIDEO_TYPE_ATV"}}]} if videoId == "vidR" else {"tracks": []}
    monkeypatch.setitem(sys.modules, "ytmusicapi", types.SimpleNamespace(YTMusic=FakeYT))
    entries = [
        {"year": "2021", "playlistId": "PL2021", "position": 3, "videoId": "deadJ", "artist": "Jungle", "title": "Keep Moving", "avail": False},
        {"year": "2016", "playlistId": "PL2016", "position": 9, "videoId": "deadR", "artist": "Roosevelt", "title": "Lovers", "avail": False},
        {"year": "2016", "playlistId": "PL2016", "position": 1, "videoId": "deadN", "artist": "Nobody", "title": "Nothing", "avail": False},
        {"year": "2016", "playlistId": "PL2016", "position": 2, "videoId": "okay", "artist": "Fine", "title": "Fine", "avail": True},
    ]
    profile = {"youtube": {"entries": entries, "checked_at": "2026-09-06T00:00:00+00:00"}}
    cfg = _cfg(); cfg["resolve"]["counterparts_per_run"] = 2
    report = unavailable.build_report(profile, cfg)
    rows = {r["videoId"]: r for r in report["rows"]}
    assert report["count"] == 3 and set(rows) == {"deadJ", "deadR", "deadN"} and "okay" not in rows
    assert rows["deadJ"]["alt"]["videoId"] == "liveJ" and rows["deadJ"]["alt"]["videoType"] == "MUSIC_VIDEO_TYPE_ATV"   # never the dead id, audio first
    assert rows["deadR"]["alt"]["videoId"] == "vidR-atv"                                                              # a video hit, swapped for its audio side
    assert rows["deadN"]["pending"] is True and rows["deadN"]["alt"] is None                                          # over budget: waits, is not "no counterpart"
    assert report["with_counterpart"] == 2 and report["audio"] == 2 and report["pending"] == 1
    assert [r["year"] for r in report["rows"]] == ["2021", "2016", "2016"]
    # the next run reuses the cache for the two looked up and gets to the third
    cfg["resolve"]["counterparts_per_run"] = 5
    n = len(searches)
    report = unavailable.build_report(profile, cfg)
    assert report["pending"] == 0 and {r["videoId"]: r["alt"] for r in report["rows"]}["deadN"] is None
    assert all("Nobody" in q for q, _ in searches[n:])
    assert util.read_json(sandbox / "site" / "data" / "unavailable.json", {})["count"] == 3
    assert all(r["why"] == "greyed" for r in report["rows"])
    # what the site's playability audit found (pushed with the ratings) joins the report: a named row gets the same
    # search, a nameless one (a deleted video) is listed for removal without a search
    ratings = {"version": 1, "rated": {}, "unplayable": {
        "PL2016:deadR": {"year": "2016", "playlistId": "PL2016", "videoId": "deadR", "why": "blocked", "artist": "Roosevelt", "title": "Lovers", "at": 1},
        "PL2019:deadX": {"year": "2019", "playlistId": "PL2019", "videoId": "deadX", "position": 40, "why": "private", "artist": "Jungle", "title": "Keep Moving", "at": 2},
        "PL2014:gone1": {"year": "2014", "playlistId": "PL2014", "videoId": "gone1", "position": 7, "why": "deleted", "artist": "", "title": "", "at": 3}}}
    monkeypatch.setattr(unavailable, "load_unplayable", lambda path=None: ratings)
    report = unavailable.build_report(profile, cfg)
    rows = {r["videoId"]: r for r in report["rows"]}
    assert report["count"] == 5 and rows["deadR"]["why"] == "blocked" and rows["deadR"]["alt"]["videoId"] == "vidR-atv"   # one row, the audit's reason, the search kept
    assert rows["deadX"]["alt"]["videoId"] == "liveJ" and rows["deadX"]["why"] == "private" and rows["deadX"]["position"] == 40
    assert rows["gone1"]["alt"] is None and rows["gone1"]["pending"] is False and rows["gone1"]["why"] == "deleted"
    assert [r["year"] for r in report["rows"]] == ["2021", "2019", "2016", "2016", "2014"]


def test_build_merges_a_release_renamed_to_an_existing_track(monkeypatch, sandbox):
    import discovery.build as build
    from discovery import profile as prof
    from discovery.resolve import promote

    util.write_json(prof.PROFILE_PATH, PROFILE)
    today = date.today()
    fake = [Item(artist="Jungle", title="Keep Moving", kind="track", release_date=today, sources=["listenbrainz"], tags=["nu disco"]),
            Item(artist="Jungle", title="Loving In Stereo", kind="release", release="Loving In Stereo", release_date=today, sources=["bandcamp"])]
    monkeypatch.setattr(build, "run_sources", lambda cfg, profile, http, deadline=None: list(fake))

    def fake_resolve(items, cfg, deadline=None, avoid=None):
        for it in items:
            if it.kind == "release":
                it.youtube = {"videoId": "vidAlbumCut", "title": "Keep Moving", "artists": ["Jungle"], "videoType": "MUSIC_VIDEO_TYPE_ATV"}
                promote(it, it.youtube)        # the release becomes the track its video is: same key as the first item
            else:
                it.youtube = {"videoId": "vidSingle", "title": "Keep Moving", "artists": ["Jungle"], "videoType": "MUSIC_VIDEO_TYPE_ATV"}
    monkeypatch.setattr(build, "resolve_all", fake_resolve)
    monkeypatch.setattr(build, "verify_years", lambda items, cfg, http, deadline=None: None)
    monkeypatch.setattr(build, "annotate_duplicate_years", lambda dups, cfg, http, deadline=None: 0)
    monkeypatch.setattr(build, "unavailable_report", lambda profile, cfg, deadline=None: {"count": 0, "with_counterpart": 0, "pending": 0})

    class NoNet:
        def __init__(self, *a, **k): pass
        def save(self): pass
    monkeypatch.setattr(build, "Http", NoNet)
    payload = build.build_feed(_cfg())
    ids = [i["id"] for i in payload["items"]]
    assert len(ids) == len(set(ids)) == 1                                              # one card, not two with the same id
    it = payload["items"][0]
    assert sorted(it["sources"]) == ["bandcamp", "listenbrainz"] and it["youtube"]["videoId"] == "vidSingle"   # the stronger item keeps its video


def test_ratings_file_reaches_the_learner_and_hides_skips(tmp_path):
    from discovery import learn

    util.write_json(tmp_path / "ratings.json", {"version": 1, "rated": {
        "skip-me": {"decision": "down", "videoId": "vskip", "artist": "Nobody", "title": "Meh", "at": 1},
        "keep-me": {"decision": "up", "videoId": "vkeep", "artist": "Jungle", "title": "Yes", "year": 2026, "at": 2},
        "undone": {"decision": "undone", "at": 3}, "seen": {"decision": "seen", "at": 4}, "junk": "x"}})
    ratings = learn.load_ratings(tmp_path / "ratings.json")
    assert set(ratings) == {"skip-me", "keep-me"}
    saved = {"keep-me": {"decision": "up", "videoId": "vkeep"}}
    assert learn.merge_ratings(saved, ratings) == 1
    assert saved["skip-me"]["decision"] == "down" and saved["skip-me"]["via"] == "site" and saved["keep-me"]["decision"] == "up"
    # the local skip is a real skip for the learner, matched by key or by video
    rows = {"skip-me": {"id": "skip-me", "v": "vskip", "a": "Nobody", "s": ["deezer"], "t": [], "r": 1, "shown": "2026-09-01"},
            "other": {"id": "other", "v": "vskip", "a": "Nobody", "s": ["deezer"], "t": [], "r": 2, "shown": "2026-09-01"}}
    outs = learn.outcomes(rows, saved, shown_rank=80)
    assert [o["verdict"] for o in outs] == ["skipped", "skipped"]
    assert learn.load_ratings(tmp_path / "missing.json") == {}


def test_wrong_video_flags_bypass_the_saved_map_and_the_learner(tmp_path):
    from discovery import learn

    util.write_json(tmp_path / "ratings.json", {"version": 1, "rated": {
        "flag-me": {"decision": "wrong", "videoId": "vbad", "artist": "Jungle", "title": "Keep Moving", "at": 1},
        "flag-two": {"decision": "wrong", "videoId": "vbad2", "artist": "Roosevelt", "title": "Lovers", "at": 2},
        "no-video": {"decision": "wrong", "videoId": None, "at": 3},
        "skip-me": {"decision": "down", "videoId": "vskip", "artist": "Nobody", "title": "Meh", "at": 4}}})
    ratings = learn.load_ratings(tmp_path / "ratings.json")
    assert set(ratings) == {"flag-me", "flag-two", "no-video", "skip-me"}
    # the flags name the uploads the resolver must refuse, per track; a flag without a video says nothing
    assert learn.wrong_videos(ratings) == {"flag-me": {"vbad"}, "flag-two": {"vbad2"}}
    # a flag is not a verdict on the song: it never hides the track for good, never counts as a skip
    saved = {}
    assert learn.merge_ratings(saved, ratings) == 1
    assert set(saved) == {"skip-me"}
    rows = {"flag-me": {"id": "flag-me", "v": "vbad", "a": "Jungle", "s": ["rss:Stereogum"], "t": [], "r": 1, "shown": "2026-09-01"},
            "other": {"id": "other", "v": "vx", "a": "Jungle", "s": ["rss:Stereogum"], "t": [], "r": 2, "shown": "2026-09-01"}}
    outs = learn.outcomes(rows, saved, shown_rank=80, ignore=set(learn.wrong_videos(ratings)))
    assert [(o["id"], o["verdict"]) for o in outs] == [("other", "pass")]


def test_resolve_all_redoes_a_flagged_video_and_remembers_the_refusal(monkeypatch, sandbox):
    import sys
    import types

    from discovery import resolve

    class FakeYT:
        calls = 0
        def search(self, q, filter=None, limit=None):
            FakeYT.calls += 1
            if filter == "songs":
                return [{"resultType": "song", "title": "Keep Moving", "artists": [{"name": "Jungle"}], "videoId": "vbad", "videoType": resolve.ATV},
                        {"resultType": "song", "title": "Keep Moving", "artists": [{"name": "Jungle"}], "videoId": "vgood", "videoType": resolve.ATV}]
            return []
        def get_watch_playlist(self, **kw): return {"tracks": []}
        def get_album(self, bid): return {}
    monkeypatch.setitem(sys.modules, "ytmusicapi", types.SimpleNamespace(YTMusic=FakeYT))
    it = Item(artist="Jungle", title="Keep Moving", kind="track", sources=["rss:Stereogum"])
    bad = {"videoId": "vbad", "title": "Keep Moving", "artists": ["Jungle"], "via": "track-search", "videoType": resolve.ATV}
    util.write_json(resolve.YT_CACHE, {it.key: {"seen": "2026-09-01", "yt": bad, "v": resolve.CACHE_VERSION}})
    # the curator flagged vbad on the site: the cached row is redone, and the next-best upload takes its place
    resolve.resolve_all([it], _cfg(), avoid={it.key: {"vbad"}})
    assert it.youtube["videoId"] == "vgood" and FakeYT.calls == 2      # the songs search, then the video search for the card's video side
    cache = util.read_json(resolve.YT_CACHE, {})
    assert cache[it.key]["yt"]["videoId"] == "vgood" and cache[it.key]["not"] == ["vbad"]
    # the refusal lives on the row: a later run without the ratings file still never goes back to vbad
    again = Item(artist="Jungle", title="Keep Moving", kind="track")
    resolve.resolve_all([again], _cfg())
    assert again.youtube["videoId"] == "vgood" and FakeYT.calls == 2
    # with every upload flagged there is nothing left to play: the row says so and is not retried every day
    class OnlyBad(FakeYT):
        def search(self, q, filter=None, limit=None):
            FakeYT.calls += 1
            return [{"resultType": "song", "title": "Keep Moving", "artists": [{"name": "Jungle"}], "videoId": "vbad", "videoType": resolve.ATV}] if filter == "songs" else []
    monkeypatch.setitem(sys.modules, "ytmusicapi", types.SimpleNamespace(YTMusic=OnlyBad))
    resolve.resolve_all([again := Item(artist="Jungle", title="Keep Moving", kind="track")], _cfg(), avoid={again.key: {"vgood"}})
    assert again.youtube is None and FakeYT.calls == 4   # songs, then videos (the track search's second try)
    assert util.read_json(resolve.YT_CACHE, {})[again.key]["not"] == ["vbad", "vgood"]


def test_learning_decays_and_explores():
    from discovery import learn

    fresh = [{"id": f"f{i}", "a": "Jungle", "s": ["rss:A"], "t": [], "shown": "2026-09-08", "verdict": "kept"} for i in range(4)]
    stale = [{"id": f"s{i}", "a": "Jungle", "s": ["rss:A"], "t": [], "shown": "2026-03-01", "verdict": "skipped"} for i in range(4)]
    today = date(2026, 9, 10)
    with_decay = learn.learn(fresh + stale, {"learn": {"half_life_days": 21, "prior": 1, "min_exposures": 1}}, today=today)
    without = learn.learn(fresh + stale, {"learn": {"half_life_days": 0, "prior": 1, "min_exposures": 1}}, today=today)
    # four keeps this week and four skips in March: with decay the recent keeps win; without, it is a coin toss
    assert with_decay["sources"]["rss:A"]["rate"] > 0.8 > without["sources"]["rss:A"]["rate"]
    assert with_decay["sources"]["rss:A"]["n"] == 8 and with_decay["sources"]["rss:A"]["k"] == 4   # the raw counts still say what happened
    # exploration: a source never shown gets the bonus, a well-known one hardly any, and it never exceeds the cap
    learned = learn.learn(fresh * 20, {"learn": {"explore": 0.4, "explore_max": 0.6}}, today=today)
    unknown = learn.exploration(learned, ["rss:NeverSeen"], ["new tag"], "New Act")
    known = learn.exploration(learned, ["rss:A"], [], "Jungle")
    assert 0 < known < unknown <= 0.6
    assert learn.exploration(None, ["rss:A"], [], "x") == 0.0 and learn.exploration(learn.learn([]), ["rss:A"], [], "x") == 0.0
    # …and reaches the score, with a reason once it is worth one
    prof = {**PROFILE, "learned": learned}
    a = Item(artist="Someone New", title="A", kind="track", sources=["rss:NeverSeen"], tags=["new tag"])
    b = Item(artist="Someone New", title="B", kind="track", sources=["rss:NeverSeen"], tags=["new tag"])
    cfg = _cfg(); cfg["ranking"]["weights"]["explore"] = 1.0
    score_items([a], prof, cfg)
    cfg["ranking"]["weights"]["explore"] = 0.0
    score_items([b], prof, cfg)
    assert a.score > b.score and "little history yet" in a.reasons


def test_diversify_caps_artists_and_unknown_sources_and_keeps_explore_slots():
    from discovery.score import diversify

    items = [Item(artist="Tonbe", title=f"T{i}", kind="track", sources=["bandcamp"]) for i in range(6)]
    items += [Item(artist=f"Other {i}", title="X", kind="track", sources=["bandcamp"]) for i in range(6)]
    newcomer = Item(artist="Newcomer", title="N", kind="track", sources=["bandcamp"])
    for n, it in enumerate(items):
        it.score = 10.0 - n * 0.1
        it.match_kind = "direct"
    newcomer.score = 1.0
    cfg = {"ranking": {"max_per_artist": 2, "repeat_penalty": 2.0, "explore_slots": 1}, "learn": {"shown_rank": 5}}
    out = diversify(items + [newcomer], cfg)
    tonbe = [i for i in out if i.artist == "Tonbe"]
    assert [i.title for i in tonbe] == ["T0", "T1", "T2", "T3", "T4", "T5"]
    assert tonbe[0].score == 10.0 and tonbe[1].score == 9.9                       # within the cap: untouched
    assert tonbe[2].score == pytest.approx(9.8 - 2.0) and "no. 3 by them today" in tonbe[2].reasons
    assert tonbe[3].score == pytest.approx(9.7 - 4.0)                             # two past the artist cap
    assert [i.artist for i in out[:2]] == ["Tonbe", "Tonbe"] and out[2].artist == "Other 0"
    # the newcomer is lifted into the top five, just above whatever was fifth
    top = out[:5]
    assert newcomer in top and "explore slot" in newcomer.reasons and newcomer.score > 1.0
    assert diversify([], cfg) == []


def test_diversify_caps_unknown_acts_per_source_family():
    """A tag crawler must not fill the day with acts the profile has never heard of, however many it emits."""
    from discovery.score import diversify

    crawled = [Item(artist=f"Unknown {i}", title="X", kind="track", sources=["bandcamp"]) for i in range(6)]
    known = [Item(artist=f"Known {i}", title="Y", kind="track", sources=["bandcamp"]) for i in range(4)]
    for it in known:
        it.match_kind = "direct"
    for n, it in enumerate(crawled + known):
        it.score = 10.0 - n * 0.1
    cfg = {"ranking": {"max_per_artist": 3, "max_unknown_per_source": 2, "repeat_penalty": 2.0}, "learn": {"shown_rank": 5}}
    out = diversify(crawled + known, cfg)
    assert [i.artist for i in out[:2]] == ["Unknown 0", "Unknown 1"]               # within the cap: untouched
    third = next(i for i in out if i.artist == "Unknown 2")
    assert third.score == pytest.approx(9.8 - 2.0) and "many unknown acts from bandcamp today" in third.reasons
    assert next(i for i in out if i.artist == "Unknown 5").score == pytest.approx(9.5 - 8.0)
    assert all(not i.reasons for i in known)                                       # the acts you play are never capped by source
    assert [i.artist for i in out[2:6]] == [f"Known {i}" for i in range(4)]


def test_genre_artists_score_between_similar_and_unknown_and_tags_stay_clean():
    from discovery.build import _clean_tags

    cfg = _cfg()
    similar = Item(artist="Parcels", title="A", kind="track", sources=["ytmusic"])
    genre = Item(artist="TOPS", title="B", kind="track", sources=["ytmusic"])
    unknown = Item(artist="Nobody At All", title="C", kind="track", sources=["ytmusic"])
    score_items([similar, genre, unknown], PROFILE, cfg)
    assert genre.match_kind == "genre" and "a top indie pop, dream pop act on Last.fm" in genre.reasons
    assert similar.score > genre.score > unknown.score
    # "pop" stays on Popcaan; the artist's own name (or one of its words) does not become a genre
    popcaan = Item(artist="Popcaan", title="X", kind="track", tags=["pop", "news", "popcaan"])
    hot = Item(artist="Hot Chip", title="Y", kind="track", tags=["hot chip", "electropop", "chip"])
    _clean_tags([popcaan, hot], PROFILE)
    assert popcaan.tags == ["pop"] and hot.tags == ["electropop"]


def test_profile_genre_artists_come_from_the_tags_you_play():
    """The acts Last.fm ranks highest under your strongest genre tags join the profile as kind "genre"."""
    from discovery.profile import LastFm, genre_artists, genre_tags, ranked_artists

    tags = {"nu disco": 1.0, "indie pop": 0.8, "french": 0.9, "female vocalists": 0.95, "metal": -3.0}
    assert genre_tags(tags, 5) == [("nu disco", 1.0), ("indie pop", 0.8)]     # nationality, descriptor and penalised tags never seed
    assert genre_tags(tags, 1) == [("nu disco", 1.0)]

    calls = []

    class FakeLastFm(LastFm):
        def __init__(self): pass
        @property
        def enabled(self): return True
        def tag_top_artists(self, tag, limit):
            calls.append((tag, limit))
            return [{"name": "Tonbe", "mbid": "m-tonbe"}, {"name": "TOPS"}, {"name": "Jungle"}] if tag == "nu disco" else [{"name": "TOPS"}]

    pcfg = {"genre_top_tags": 2, "genre_artists_per_tag": 25, "genre_weight": 0.5}
    got = genre_artists(FakeLastFm(), tags, pcfg, exclude={"jungle"})
    assert calls == [("nu disco", 25), ("indie pop", 25)]
    assert set(got) == {"tonbe", "tops"}                                      # a profile artist stays with its own kind
    assert got["tonbe"]["kind"] == "genre" and got["tonbe"]["mbid"] == "m-tonbe" and got["tonbe"]["via"] == ["nu disco"]
    assert got["tops"]["via"] == ["nu disco", "indie pop"]                     # an act under several tags keeps them all
    assert got["tonbe"]["affinity"] > got["tops"]["affinity"]                  # ranked first under the stronger tag
    assert genre_artists(FakeLastFm(), tags, {"genre_top_tags": 0}, set()) == {}

    # the pool the artist-watch sources rotate through: the kinds they ask for, strongest first
    assert [e["name"] for e in ranked_artists(PROFILE, ("direct", "similar", "genre"))] == ["Jungle", "Roosevelt", "Parcels", "TOPS"]
    assert [e["name"] for e in ranked_artists(PROFILE)] == ["Jungle", "Roosevelt"]
    assert [e["name"] for e in ranked_artists(PROFILE, ("direct", "similar"), 1)] == ["Jungle"]
    assert [e["name"] for e in ranked_artists(PROFILE, ("direct", "similar", "genre"), with_mbid=True)] == ["Jungle"]


def test_backfill_fills_the_gap_only_when_the_current_timeframe_is_thin():
    """The feed is this year's; older releases the artist watch found fill in only when there is room, best first."""
    from discovery.build import fill_from_backfill, is_fresh, split_fresh

    today = date(2026, 9, 8)
    cfg = {"ranking": {"fresh_days": 90}, "backfill": {"years": 3, "target": 4, "max": 2}}
    recent = Item(artist="A", title="new", release_date=today - timedelta(days=10))
    january = Item(artist="B", title="january", release_date=date(2026, 1, 5))
    undated = Item(artist="C", title="undated")
    sighted = Item(artist="D", title="seen", release_date=date(2025, 11, 1), date_kind="sighting")
    old = Item(artist="E", title="2024", release_date=date(2024, 5, 1))
    older = Item(artist="F", title="2023", stated_year=2023)
    ancient = Item(artist="G", title="2011", release_date=date(2011, 1, 1))
    assert is_fresh(recent, cfg, today) and is_fresh(undated, cfg, today) and not is_fresh(old, cfg, today)
    assert is_fresh(january, cfg, today)          # this year is current whatever month it landed in
    assert not is_fresh(sighted, cfg, today)      # last year's, seen long ago: not the current timeframe
    fresh, back = split_fresh([recent, january, undated, sighted, old, older, ancient], cfg, today)
    assert [i.title for i in fresh] == ["new", "january", "undated"]
    assert [i.title for i in back] == ["seen", "2024", "2023"] and all(i.backfill for i in back)
    assert ancient not in fresh and ancient not in back           # older than the window: never pulled in

    # two current cards can be played, the target is four: the two best playable older ones fill in
    for i, it in enumerate([recent, undated]):
        it.youtube = {"videoId": f"v{i}", "videoType": "MUSIC_VIDEO_TYPE_ATV"}
    for i, it in enumerate(back):
        it.youtube = {"videoId": f"b{i}", "videoType": "MUSIC_VIDEO_TYPE_ATV"}
    out, counts = fill_from_backfill([recent, undated, *back], cfg)
    assert [i.title for i in out] == ["new", "undated", "seen", "2024"]
    assert counts == {"fresh_playable": 2, "older": 3, "used": 2}
    assert "filling in from 2025" in out[2].reasons and "filling in from 2024" in out[3].reasons
    # a full day of current tracks leaves no room at all
    full = [Item(artist=f"X{i}", title=str(i), youtube={"videoId": str(i), "videoType": "MUSIC_VIDEO_TYPE_ATV"}) for i in range(4)]
    kept, counts = fill_from_backfill(full + back, cfg)
    assert kept == full and counts["used"] == 0
    # backfill off: nothing older is even a candidate, and nothing fills in
    off = {"ranking": {"fresh_days": 90}, "backfill": {"years": 0}}
    assert split_fresh([recent, old], off, today) == ([recent, old], [])
    assert fill_from_backfill([recent, *back], off)[0] == [recent]


def test_song_length_range_parses_prefers_and_drops():
    """1:55–9:31: the resolver prefers an upload inside the range, an album card skips a one-minute intro, and the
    feed drops a song whose only upload is outside it; a track nobody times is given the benefit of the doubt."""
    from discovery.resolve import ATV, _album_track, _pick, drop_by_length, duration_seconds, length_bounds, length_ok

    assert duration_seconds("1:55") == 115 and duration_seconds("9:31") == 571 and duration_seconds("1:02:03") == 3723
    assert duration_seconds(282) == 282 and duration_seconds("282") == 282 and duration_seconds(None) is None and duration_seconds("") is None
    assert duration_seconds("4 minutes") is None and duration_seconds(True) is None
    cfg = _cfg()
    assert length_bounds(cfg) == (115, 571)                                        # config.yaml: 1:55 / 9:31
    assert length_bounds({"resolve": {"min_length": "", "max_length": 600}}) == (None, 600)
    assert length_bounds({}) == (115, 571)                                         # the defaults when the keys are missing
    assert length_ok("1:55", (115, 571)) and length_ok("9:31", (115, 571)) and length_ok(None, (115, 571)) and length_ok("0:30", None)
    assert not length_ok("1:54", (115, 571)) and not length_ok("9:32", (115, 571))

    # two uploads of the song: the extended mix is the audio track, the radio edit only a video — the edit wins
    res = [
        {"resultType": "song", "title": "Sunset Lover", "artists": [{"name": "Petit Biscuit"}], "videoId": "ext", "videoType": ATV, "duration": "10:12", "duration_seconds": 612},
        {"resultType": "song", "title": "Sunset Lover", "artists": [{"name": "Petit Biscuit"}], "videoId": "edit", "videoType": "MUSIC_VIDEO_TYPE_OMV", "duration": "3:57", "duration_seconds": 237},
    ]
    assert _pick(res, "Petit Biscuit", "Sunset Lover", None, (115, 571))["videoId"] == "edit"
    assert _pick(res, "Petit Biscuit", "Sunset Lover")["videoId"] == "ext"           # without the range the audio track wins as before
    assert _pick(res[:1], "Petit Biscuit", "Sunset Lover", None, (115, 571))["videoId"] == "ext"   # the only upload is still the song
    tracks = [{"videoId": "intro", "title": "Intro", "duration_seconds": 61}, {"videoId": "first", "title": "First Real Song", "duration_seconds": 240},
              {"videoId": "title", "title": "The Record", "duration_seconds": 700}]
    album = Item(artist="Someone", title="The Record", kind="release", release="The Record")
    assert _album_track(tracks, album)["videoId"] == "title"                          # no range: the title track
    assert _album_track(tracks, album, (115, 571))["videoId"] == "first"              # the title track is a 11:40 piece: the first song-length track
    assert _album_track(tracks, Item(artist="Someone", title="Other", kind="release", release="Other"), (115, 571))["videoId"] == "first"   # never the intro
    assert _album_track(tracks[:1], album, (115, 571))["videoId"] == "intro"          # nothing in range: the opener, dropped later

    items = [Item(artist="A", title="Skit", kind="track", youtube={"videoId": "1", "duration": "1:54"}),
             Item(artist="A", title="Song", kind="track", youtube={"videoId": "2", "duration": "1:55"}),
             Item(artist="A", title="Mix", kind="track", youtube={"videoId": "3", "duration": "9:32"}),
             Item(artist="A", title="Long Song", kind="track", youtube={"videoId": "4", "duration": "9:31"}),
             Item(artist="A", title="Untimed", kind="track", youtube={"videoId": "5"}),
             Item(artist="A", title="Unresolved", kind="track")]
    assert [i.title for i in drop_by_length(items, cfg)] == ["Song", "Long Song", "Untimed", "Unresolved"]
    assert len(drop_by_length(items, {"resolve": {"min_length": "", "max_length": ""}})) == 6   # both ends lifted: nothing dropped


def test_resolve_all_looks_up_an_out_of_range_hit_once_more(monkeypatch, sandbox):
    import sys
    import types

    from discovery import resolve

    searches = []

    class FakeYT:
        def search(self, q, filter=None, limit=None):
            searches.append(q)
            if filter == "songs" and "Sunset Lover" in q:
                return [{"resultType": "song", "title": "Sunset Lover", "artists": [{"name": "Petit Biscuit"}], "videoId": "ext", "videoType": resolve.ATV, "duration": "10:12", "duration_seconds": 612},
                        {"resultType": "song", "title": "Sunset Lover", "artists": [{"name": "Petit Biscuit"}], "videoId": "edit", "videoType": resolve.ATV, "duration": "3:57", "duration_seconds": 237}]
            if filter == "songs" and "Epic" in q:
                return [{"resultType": "song", "title": "Epic", "artists": [{"name": "Long Band"}], "videoId": "epic", "videoType": resolve.ATV, "duration": "12:00", "duration_seconds": 720}]
            return []
        def get_watch_playlist(self, **kw):
            return {"tracks": []}
        def get_album(self, bid):
            return {}
    monkeypatch.setitem(sys.modules, "ytmusicapi", types.SimpleNamespace(YTMusic=FakeYT))
    sunset = Item(artist="Petit Biscuit", title="Sunset Lover", kind="track")
    epic = Item(artist="Long Band", title="Epic", kind="track")
    # rows from before the range existed: both sit on an upload outside it
    util.write_json(resolve.YT_CACHE, {
        sunset.key: {"seen": "2026-09-01", "yt": {"videoId": "ext", "title": "Sunset Lover", "artists": ["Petit Biscuit"], "duration": "10:12", "videoType": resolve.ATV}, "v": resolve.CACHE_VERSION},
        epic.key: {"seen": "2026-09-01", "yt": {"videoId": "epic", "title": "Epic", "artists": ["Long Band"], "duration": "12:00", "videoType": resolve.ATV}, "v": resolve.CACHE_VERSION}})
    resolve.resolve_all([sunset, epic], _cfg())
    assert sunset.youtube["videoId"] == "edit" and sunset.youtube["duration"] == "3:57"      # a song-length upload existed: swapped in
    assert epic.youtube["videoId"] == "epic"                                                 # simply a long song: still the match (the feed drops it)
    cache = util.read_json(resolve.YT_CACHE, {})
    assert cache[sunset.key]["len"] == 1 and cache[epic.key]["len"] == 1
    # the second run leaves both alone: a stamped row is never redone for its length again
    searches.clear()
    again = Item(artist="Long Band", title="Epic", kind="track")
    resolve.resolve_all([again], _cfg())
    assert not searches and again.youtube["videoId"] == "epic"
    assert [i.title for i in resolve.drop_by_length([sunset, epic], _cfg())] == ["Sunset Lover"]


def test_years_fall_back_to_the_youtube_music_release_date(monkeypatch, sandbox):
    """Nothing in the catalogues or the stores: the date YouTube Music states for the upload gives the year (a weak
    hint, "?"), asked once per video, kept with the cache entry, redone when the track is paired with another
    upload, and never asked when a catalogue already answered or the match is a fan upload."""
    from discovery import years

    class FakeHttp:
        def get(self, url, **kw):
            p = kw.get("params", {})
            if "listenbrainz" in url:
                return {"artist_credit_name": "Flume", "recording_name": "Never Be Like You", "recording_mbid": "rec-flume"} if p.get("artist_name") == "Flume" else {}
            if url.endswith("/recording/rec-flume"):
                return {"first-release-date": "2016-01-15", "isrcs": [], "releases": [{"date": "2016-01-15", "release-group": {"first-release-date": "2016-01-15"}}]}
            if url.endswith("/recording/"):
                return {"recordings": []}
            if "deezer.com/search" in url:
                return {"data": []}
            return {}

    asked = []

    class FakeYT:
        def get_song(self, video_id):
            asked.append(video_id)
            if video_id == "rmx":
                return {"microformat": {"microformatDataRenderer": {"publishDate": "2016-03-04", "uploadDate": "2016-03-04"}}}
            if video_id == "rmx2":
                return {"microformat": {"microformatDataRenderer": {"publishDate": "2017-06-30"}}}
            if video_id == "epoch":
                return {"microformat": {"microformatDataRenderer": {"publishDate": "1969-12-31", "uploadDate": "1969-12-31"}}}   # YouTube's "no date"
            raise RuntimeError("boom")
    cfg = _cfg()
    cfg["resolve"] = {**cfg["resolve"], "year_chain": "fast"}
    remix = Item(artist="Bon Iver", title="Minnesota, WI (Oliver Nelson Remix)", kind="track", youtube={"videoId": "rmx", "videoType": "MUSIC_VIDEO_TYPE_OMV"})
    known = Item(artist="Flume", title="Never Be Like You", kind="track", youtube={"videoId": "known", "videoType": "MUSIC_VIDEO_TYPE_ATV"})
    fan = Item(artist="Zane Alexander", title="Polarity", kind="track", youtube={"videoId": "ugc", "videoType": "MUSIC_VIDEO_TYPE_UGC"})
    nodate = Item(artist="ColeCo", title="Rock The Boat", kind="track", youtube={"videoId": "epoch", "videoType": "MUSIC_VIDEO_TYPE_ATV"})
    failed = Item(artist="ColeCo", title="Distant Lover", kind="track", youtube={"videoId": "err"})
    unresolved = Item(artist="Nobody", title="Nothing", kind="track")
    years.verify_years([remix, known, fan, nodate, failed, unresolved], cfg, FakeHttp(), yt=FakeYT())
    assert (remix.year, remix.year_source, remix.year_confidence) == (2016, "ytmusic-date", "low")
    assert remix.year_evidence == ["YouTube Music release date: 2016"]
    assert (known.year, known.year_source) == (2016, "musicbrainz")           # a catalogue answered: YouTube Music not asked
    assert fan.year is None and fan.year_source == "unknown"                  # a fan upload's date is an upload date
    assert nodate.year is None and failed.year is None and unresolved.year is None
    assert sorted(asked) == ["epoch", "err", "rmx"]
    cache = util.read_json(years.YEAR_CACHE, {})
    assert cache[remix.key]["ytdate"] == {"video": "rmx", "date": "2016-03-04"} and cache[nodate.key]["ytdate"] == {"video": "epoch", "date": None}
    assert "ytdate" not in cache[known.key] and "ytdate" not in cache[fan.key]
    # the second run is served from the cache — except the remix, now paired with another upload, which is asked again
    asked.clear()
    remix.youtube = {"videoId": "rmx2", "videoType": "MUSIC_VIDEO_TYPE_OMV"}
    years.verify_years([remix, known, nodate], cfg, FakeHttp(), yt=FakeYT())
    assert asked == ["rmx2"] and remix.year == 2017
    # a stated year from the artist page still outranks it, and the album year sits beside it as evidence
    remix.stated_year = 2015
    remix.youtube["year"] = "2016"
    years.verify_years([remix], cfg, FakeHttp(), yt=FakeYT())
    assert (remix.year, remix.year_source) == (2015, "ytmusic-year") and "YouTube Music release date: 2017" in remix.year_evidence
    # the budget bounds the lookups a run; what it leaves is not "pending" (the catalogues did run) but plain unknown
    asked.clear()
    cfg["resolve"]["max_ytmusic_date_lookups_per_run"] = 0
    fresh = Item(artist="Princeton", title="Florida (Cosmic Kids Remix)", kind="track", youtube={"videoId": "fla"})
    years.verify_years([fresh], cfg, FakeHttp(), yt=FakeYT())
    assert not asked and fresh.year is None and fresh.year_source == "unknown"


def test_audio_track_is_taken_from_album_pages_and_video_hits_are_rechecked(monkeypatch, sandbox):
    """Audio, not video: a release opened by its browse id whose album page lists the video side gets the audio
    counterpart; a cached video hit is asked for its counterpart on first sight and again after
    `audio_recheck_days`; a hit of unknown kind learns what it is; the feed tallies what the cards play."""
    import sys
    import types

    from discovery import resolve

    watched = []
    paired = {"vOMV": "vATV"}     # what the watch playlist pairs today (YouTube Music adds pairs over time)

    class FakeYT:
        albums = {"MPREb_s": {"title": "To See You", "year": "2026", "artists": [{"name": "NINA"}], "audioPlaylistId": "OLAK_s",
                              "tracks": [{"videoId": "vOMV", "title": "To See You", "artists": [{"name": "NINA"}], "videoType": "MUSIC_VIDEO_TYPE_OMV", "duration_seconds": 240}]}}
        def get_album(self, bid):
            return self.albums[bid]
        def search(self, q, filter=None, limit=None):
            return []
        def get_watch_playlist(self, videoId=None, limit=1, **kw):
            watched.append(videoId)
            if videoId in paired:
                return {"tracks": [{"videoId": videoId, "videoType": "MUSIC_VIDEO_TYPE_OMV", "counterpart": {"videoId": paired[videoId], "videoType": resolve.ATV}}]}
            if videoId == "isAudio":
                return {"tracks": [{"videoId": "isAudio", "videoType": resolve.ATV}]}
            if videoId == "lonely":
                return {"tracks": [{"videoId": "lonely", "videoType": "MUSIC_VIDEO_TYPE_OMV"}]}
            return {"tracks": []}
    monkeypatch.setitem(sys.modules, "ytmusicapi", types.SimpleNamespace(YTMusic=FakeYT))
    cfg = _cfg()
    cfg["resolve"] = {**cfg["resolve"], "audio_recheck_days": 30, "audio_heals_per_run": 10}
    single = Item(artist="Nina", title="To See You", kind="release", release="To See You", links={"youtube music": "https://music.youtube.com/browse/MPREb_s"})
    resolve.resolve_all([single], cfg)
    assert single.youtube["videoId"] == "vATV" and single.youtube["videoType"] == resolve.ATV and single.youtube["videoFrom"] == "vOMV"   # the album listed the video side
    cache = util.read_json(resolve.YT_CACHE, {})
    assert cache[single.key]["audio"] == date.today().isoformat()

    # cached hits: a video with no pair yet, one of unknown kind that is the audio track, one of unknown kind that stays a video
    lonely = Item(artist="Solo", title="Lonely", kind="track")
    unlabelled = Item(artist="Quiet", title="Is Audio", kind="track")
    unknown = Item(artist="Quiet", title="Stays Video", kind="track")
    stale = (date.today() - timedelta(days=31)).isoformat()
    fresh = (date.today() - timedelta(days=3)).isoformat()
    cache[lonely.key] = {"seen": stale, "yt": {"videoId": "lonely", "title": "Lonely", "artists": ["Solo"], "videoType": "MUSIC_VIDEO_TYPE_OMV"}, "v": 3, "audio": stale}
    cache[unlabelled.key] = {"seen": stale, "yt": {"videoId": "isAudio", "title": "Is Audio", "artists": ["Quiet"]}, "v": 3}
    cache[unknown.key] = {"seen": stale, "yt": {"videoId": "lonely", "title": "Stays Video", "artists": ["Quiet"]}, "v": 3, "audio": fresh}
    util.write_json(resolve.YT_CACHE, cache)
    watched.clear()
    resolve.resolve_all([lonely, unlabelled, unknown], cfg)
    assert sorted(watched) == ["isAudio", "lonely"]                                           # the stale one and the never-checked one; the fresh one waits
    assert lonely.youtube["videoType"] == "MUSIC_VIDEO_TYPE_OMV" and lonely.youtube["videoId"] == "lonely"    # still no pair: stays the video, re-stamped
    assert unlabelled.youtube["videoType"] == resolve.ATV and unlabelled.youtube["videoId"] == "isAudio"     # it was the audio track all along
    assert unknown.youtube.get("videoType") is None
    cache = util.read_json(resolve.YT_CACHE, {})
    assert cache[lonely.key]["audio"] == date.today().isoformat() and cache[unlabelled.key]["audio"] == date.today().isoformat() and cache[unknown.key]["audio"] == fresh
    assert resolve.audio_summary([single, lonely, unlabelled, unknown, Item(artist="X", title="Y", kind="track")]) == {"audio": 2, "video": 1, "unknown": 1}
    # YouTube Music paired the audio side since: the next re-check (after the recheck window) swaps it in
    paired["lonely"] = "lonelyATV"
    cache[lonely.key]["audio"] = stale
    util.write_json(resolve.YT_CACHE, cache)
    again = Item(artist="Solo", title="Lonely", kind="track")
    resolve.resolve_all([again], cfg)
    assert again.youtube["videoId"] == "lonelyATV" and again.youtube["videoType"] == resolve.ATV and again.youtube["videoFrom"] == "lonely"
    assert resolve.audio_counterpart(FakeYT(), "isAudio") is None and resolve.watch_info(FakeYT(), "isAudio") == (resolve.ATV, "isAudio")


def test_playlist_rows_that_are_videos_get_their_audio_track_in_the_report(monkeypatch, sandbox):
    import sys
    import types

    from discovery import unavailable

    monkeypatch.setattr(unavailable, "CACHE", sandbox / "data" / "cache" / "counterparts.json")
    monkeypatch.setattr(unavailable, "REPORT", sandbox / "site" / "data" / "unavailable.json")
    watched = []

    class FakeYT:
        def __init__(self, **kw): pass
        def search(self, q, filter=None, limit=None):
            raise AssertionError("a video row is asked through the watch playlist, never searched")
        def get_watch_playlist(self, videoId=None, limit=1, **kw):
            watched.append(videoId)
            if videoId == "vid1":
                return {"tracks": [{"videoId": "vid1", "videoType": "MUSIC_VIDEO_TYPE_OMV", "counterpart": {"videoId": "vid1-atv", "videoType": "MUSIC_VIDEO_TYPE_ATV"}}]}
            return {"tracks": [{"videoId": videoId, "videoType": "MUSIC_VIDEO_TYPE_UGC"}]}
    monkeypatch.setitem(sys.modules, "ytmusicapi", types.SimpleNamespace(YTMusic=FakeYT))
    entries = [
        {"year": "2024", "playlistId": "PL2024", "position": 0, "videoId": "vid1", "artist": "Jungle", "title": "Candle Flame", "album": "Volcano", "videoType": "MUSIC_VIDEO_TYPE_OMV", "avail": True},
        {"year": "2019", "playlistId": "PL2019", "position": 5, "videoId": "vid2", "artist": "Someone", "title": "Upload", "videoType": "MUSIC_VIDEO_TYPE_UGC", "avail": True},
        {"year": "2019", "playlistId": "PL2019", "position": 6, "videoId": "vid3", "artist": "Fine", "title": "Fine", "videoType": "MUSIC_VIDEO_TYPE_ATV", "avail": True},
        {"year": "2018", "playlistId": "PL2018", "position": 1, "videoId": "vid4", "artist": "Gone", "title": "Greyed Video", "videoType": "MUSIC_VIDEO_TYPE_OMV", "avail": False},
    ]
    profile = {"youtube": {"entries": entries, "checked_at": "2026-09-06T00:00:00+00:00"}}
    cfg = _cfg(); cfg["resolve"]["counterparts_per_run"] = 2                                # the greyed row's search first, then one video row
    monkeypatch.setattr(unavailable, "find_counterpart", lambda yt, a, t, avoid: None)     # the greyed row's search is not what this tests
    report = unavailable.build_report(profile, cfg)
    rows = {r["videoId"]: r for r in report["rows"]}
    assert set(rows) == {"vid1", "vid2", "vid4"} and rows["vid4"]["why"] == "greyed"          # the audio track is never listed; a greyed video is a dead row
    assert report["count"] == 1 and report["video"] == 2                                       # `count` stays the not-streamable rows
    assert rows["vid1"]["why"] == "video" and rows["vid1"]["alt"] == {"videoId": "vid1-atv", "title": "Candle Flame", "album": "Volcano", "videoType": "MUSIC_VIDEO_TYPE_ATV"}
    assert rows["vid2"]["pending"] is True and report["video_pending"] == 1 and report["video_with_audio"] == 1   # over budget: waits
    assert watched == ["vid1"]
    cfg["resolve"]["counterparts_per_run"] = 5
    report = unavailable.build_report(profile, cfg)
    rows = {r["videoId"]: r for r in report["rows"]}
    assert watched == ["vid1", "vid2"] and rows["vid2"]["alt"] is None and rows["vid2"]["pending"] is False and report["video_pending"] == 0
    cache = util.read_json(unavailable.CACHE, {})
    assert cache["audio:vid1"]["alt"]["videoId"] == "vid1-atv" and "vid1" not in cache          # kept apart from the dead rows' searches


def test_only_audio_cards_and_misses_are_tried_again(monkeypatch, sandbox):
    """Every card plays its audio track; a song with no match is not a card today and is looked up again after
    `retry_misses_days`, a fresh miss is not."""
    import sys
    import types

    from discovery import resolve
    from discovery.build import only_audio

    audio = Item(artist="A", title="Audio", kind="track", youtube={"videoId": "a", "videoType": resolve.ATV})
    video = Item(artist="A", title="Video", kind="track", youtube={"videoId": "v", "videoType": "MUSIC_VIDEO_TYPE_OMV"})
    unknown = Item(artist="A", title="Unknown", kind="track", youtube={"videoId": "u"})
    none = Item(artist="A", title="None", kind="track")
    assert only_audio([audio, video, unknown, none]) == [audio]

    searches = []

    class FakeYT:
        def search(self, q, filter=None, limit=None):
            searches.append(q)
            if "Arrived" in q and filter == "songs":
                return [{"resultType": "song", "title": "Arrived", "artists": [{"name": "Late Band"}], "videoId": "arr", "videoType": resolve.ATV, "duration": "3:30"}]
            return []
        def get_watch_playlist(self, **kw):
            return {"tracks": []}
        def get_album(self, bid):
            return {}
    monkeypatch.setitem(sys.modules, "ytmusicapi", types.SimpleNamespace(YTMusic=FakeYT))
    old_miss = Item(artist="Late Band", title="Arrived", kind="track")
    new_miss = Item(artist="Late Band", title="Still Missing", kind="track")
    stale = (date.today() - timedelta(days=8)).isoformat()
    util.write_json(resolve.YT_CACHE, {old_miss.key: {"seen": stale, "at": stale, "yt": None, "v": resolve.CACHE_VERSION},
                                       new_miss.key: {"seen": stale, "at": date.today().isoformat(), "yt": None, "v": resolve.CACHE_VERSION}})
    cfg = _cfg(); cfg["resolve"] = {**cfg["resolve"], "retry_misses_days": 7}
    resolve.resolve_all([old_miss, new_miss], cfg)
    assert old_miss.youtube["videoId"] == "arr" and new_miss.youtube is None        # the audio track arrived since; the fresh miss waits
    assert all("Arrived" in q for q in searches)
    cache = util.read_json(resolve.YT_CACHE, {})
    assert cache[old_miss.key]["at"] == date.today().isoformat() and cache[new_miss.key]["at"] == date.today().isoformat()
    # a miss from before the stamp existed counts as due
    legacy = Item(artist="Late Band", title="Legacy", kind="track")
    util.write_json(resolve.YT_CACHE, {legacy.key: {"seen": stale, "yt": None, "v": resolve.CACHE_VERSION}})
    searches.clear(); resolve.resolve_all([legacy], cfg)
    assert searches and legacy.youtube is None
    cfg["resolve"]["retry_misses_days"] = 0                                          # 0 turns the retry off
    util.write_json(resolve.YT_CACHE, {legacy.key: {"seen": stale, "yt": None, "v": resolve.CACHE_VERSION}})
    searches.clear(); resolve.resolve_all([legacy], cfg)
    assert not searches



def test_cached_states_reads_the_cache_without_a_request(monkeypatch, sandbox):
    """The build's preview of the resolver's cache: the state each item would be in after resolve_all read the cache,
    and the video it would play — with the same verdicts on stale, flagged, out-of-range and expired rows."""
    import sys
    import types

    from discovery import resolve

    class NoNet:
        def __getattr__(self, name):
            raise AssertionError("cached_states must not open the client")
    monkeypatch.setitem(sys.modules, "ytmusicapi", types.SimpleNamespace(YTMusic=NoNet))
    cfg = _cfg()
    today = date.today().isoformat()
    long_ago = (date.today() - timedelta(days=30)).isoformat()
    audio = Item(artist="Jungle", title="Keep Moving", kind="track")
    video = Item(artist="Jungle", title="Candle Flame", kind="track")
    miss = Item(artist="Jungle", title="Nothing Yet", kind="track")
    old_miss = Item(artist="Jungle", title="Try Again", kind="track")
    stale = Item(artist="Jungle", title="Dominoes", kind="track")
    flagged = Item(artist="Jungle", title="Back On 74", kind="track")
    long = Item(artist="Jungle", title="Full Side", kind="track")
    relook = Item(artist="Jungle", title="Long Cut", kind="track")
    fresh = Item(artist="Jungle", title="Brand New", kind="track")
    carried = Item(artist="Jungle", title="Already Here", kind="track", youtube={"videoId": "vHere", "videoType": resolve.ATV})
    v = resolve.CACHE_VERSION
    util.write_json(resolve.YT_CACHE, {
        audio.key: {"seen": today, "at": today, "v": v, "len": 1, "yt": {"videoId": "vA", "title": "Keep Moving", "artists": ["Jungle"], "videoType": resolve.ATV, "duration": "3:20"}},
        video.key: {"seen": today, "at": today, "v": v, "len": 1, "yt": {"videoId": "vV", "title": "Candle Flame", "artists": ["Jungle"], "videoType": resolve.OMV, "duration": "3:20"}},
        miss.key: {"seen": today, "at": today, "v": v, "len": 1, "yt": None},
        old_miss.key: {"seen": long_ago, "at": long_ago, "v": v, "len": 1, "yt": None},
        stale.key: {"seen": today, "at": today, "v": v, "len": 1, "yt": {"videoId": "vS", "title": "Another Song", "artists": ["Jungle"], "videoType": resolve.ATV}},
        flagged.key: {"seen": today, "at": today, "v": v, "len": 1, "yt": {"videoId": "vBad", "title": "Back On 74", "artists": ["Jungle"], "videoType": resolve.ATV}},
        long.key: {"seen": today, "at": today, "v": v, "len": 1, "yt": {"videoId": "vL", "title": "Full Side", "artists": ["Jungle"], "videoType": resolve.ATV, "duration": "22:00"}},
        relook.key: {"seen": today, "at": today, "v": v, "yt": {"videoId": "vR", "title": "Long Cut", "artists": ["Jungle"], "videoType": resolve.ATV, "duration": "22:00"}},
    })
    items = [audio, video, miss, old_miss, stale, flagged, long, relook, fresh, carried]
    states = resolve.cached_states(items, cfg, avoid={flagged.key: {"vBad"}})
    assert states[audio.key] == (resolve.AUDIO, "vA")           # a card today, free
    assert states[video.key] == (resolve.VIDEO, "vV")           # waits on a heal
    assert states[miss.key] == (resolve.MISS, None)             # not due for a retry
    assert states[old_miss.key] == (resolve.LOOKUP, None)       # due: retry_misses_days have passed
    assert states[stale.key] == (resolve.LOOKUP, None)          # the row is another song: redone
    assert states[flagged.key] == (resolve.LOOKUP, None)        # the curator refused that upload: redone
    assert states[long.key] == (resolve.MISS, "vL")             # looked up once more already: a song that is simply long
    assert states[relook.key] == (resolve.LOOKUP, None)         # out of range from before the range was known: once more
    assert states[fresh.key] == (resolve.LOOKUP, None)          # never seen
    assert states[carried.key] == (resolve.AUDIO, "vHere")      # read from the item itself
    assert all(i.youtube is None for i in items if i is not carried)   # a preview: nothing is written on the items
    cfg["resolve"]["youtube_music"] = False
    assert resolve.cached_states(items, cfg) == {}


def test_select_candidates_counts_only_what_can_be_a_card_today():
    from discovery import build, resolve

    items = [Item(artist="A", title=f"t{n}", kind="track", score=10 - n) for n in range(8)]
    states = {items[0].key: (resolve.AUDIO, "v0"), items[1].key: (resolve.VIDEO, "v1"), items[2].key: (resolve.MISS, None),
              items[3].key: (resolve.LOOKUP, None), items[4].key: (resolve.LOOKUP, None), items[6].key: (resolve.VIDEO, "v6")}
    out, live = build.select_candidates(items, 3, states)
    # three live slots (the cached audio hit, two lookups); the video and miss rows ride along; the rest wait
    assert [i.title for i in out] == ["t0", "t1", "t2", "t3", "t4", "t6"] and live == 3
    out, live = build.select_candidates(items, 100, {})           # no preview: everything counts, exactly as before
    assert len(out) == 8 and live == 8


def test_build_picks_candidates_with_the_cache_in_hand(monkeypatch, sandbox):
    """Yesterday's answers must not eat today's slots: a cached video-only hit or a miss rides along uncounted, a
    cached match already in a playlist is hidden before it takes a slot, and the slots go to songs that can join the
    day — so the lookup budget reaches the fresh sightings a fixed cut used to leave behind."""
    import discovery.build as build
    from discovery import learn, resolve
    from discovery import profile as prof

    profile = dict(PROFILE)
    profile["saved"] = {util.item_key("Parcels", "Lightenup"): {"artist": "Parcels", "title": "Lightenup", "videoId": "vidSaved", "decision": "up"}}
    util.write_json(prof.PROFILE_PATH, {**profile, "picks": [], "youtube": {}, "counts": {}})
    monkeypatch.setattr(learn, "RATINGS_PATH", sandbox / "data" / "nope.json")
    today = date.today()
    v = resolve.CACHE_VERSION
    # scores descend: the cached rows outrank every fresh sighting, so a cut by score alone would take them first
    fake = [Item(artist="Jungle", title="Cached Video", kind="track", release_date=today, sources=["ytmusic"]),
            Item(artist="Jungle", title="Cached Miss", kind="track", release_date=today, sources=["ytmusic"]),
            Item(artist="Parcels", title="Lighten Up (Radio Mix)", kind="track", release_date=today, sources=["ytmusic"]),
            Item(artist="Jungle", title="Cached Audio", kind="track", release_date=today, sources=["ytmusic"])]
    fake += [Item(artist="Someone New", title=f"Fresh {n}", kind="track", release_date=today, sources=["bandcamp"], tags=["nu disco"]) for n in range(6)]

    def row(title, vid, vt):
        return {"seen": today.isoformat(), "at": today.isoformat(), "v": v, "len": 1, "yt": {"videoId": vid, "title": title, "artists": ["Jungle"], "videoType": vt, "duration": "3:00"}}
    util.write_json(resolve.YT_CACHE, {
        fake[0].key: row("Cached Video", "vidOMV", resolve.OMV),
        fake[1].key: {"seen": today.isoformat(), "at": today.isoformat(), "v": v, "len": 1, "yt": None},
        fake[2].key: {**row("Lighten Up (Radio Mix)", "vidSaved", resolve.ATV), "yt": {"videoId": "vidSaved", "title": "Lighten Up (Radio Mix)", "artists": ["Parcels"], "videoType": resolve.ATV}},
        fake[3].key: row("Cached Audio", "vidATV", resolve.ATV),
    })
    monkeypatch.setattr(build, "run_sources", lambda cfg, profile, http, deadline=None: list(fake))
    got: dict = {}

    def fake_resolve(items, cfg, deadline=None, avoid=None):
        got["titles"] = [i.title for i in items]
        for it in items:
            if it.title == "Cached Audio":
                it.youtube = {"videoId": "vidATV", "title": it.title, "artists": ["Jungle"], "videoType": resolve.ATV}
            elif it.title.startswith("Fresh"):
                it.youtube = {"videoId": "vid-" + it.title[-1], "title": it.title, "artists": ["Someone New"], "videoType": resolve.ATV}
    monkeypatch.setattr(build, "resolve_all", fake_resolve)
    monkeypatch.setattr(build, "verify_years", lambda items, cfg, http, deadline=None: None)
    monkeypatch.setattr(build, "annotate_duplicate_years", lambda dups, cfg, http, deadline=None: 0)
    monkeypatch.setattr(build, "unavailable_report", lambda p, cfg, deadline=None: {"count": 0, "with_counterpart": 0, "pending": 0})

    class NoNet:
        def __init__(self, *a, **k): self.deadline = None
        def save(self): pass
    monkeypatch.setattr(build, "Http", NoNet)
    cfg = _cfg()
    cfg["ranking"]["max_items"], cfg["ranking"]["candidate_slack"] = 4, 0   # four live slots, no slack
    payload = build.build_feed(cfg)
    titles = got["titles"]
    assert "Lighten Up (Radio Mix)" not in titles                                  # hidden by its cached video before it could take a slot
    assert "Cached Video" in titles and "Cached Miss" in titles                    # ride along (a heal, a retry) but take no slot
    assert titles.index("Cached Audio") < titles.index("Fresh 0")                  # the free card keeps its place in score order
    assert sum(t.startswith("Fresh") for t in titles) == 3                         # 4 live slots: the cached audio hit and three lookups
    ids = {i["title"] for i in payload["items"]}
    assert ids == {"Cached Audio", "Fresh 0", "Fresh 1", "Fresh 2"}


def test_remix_cards_resolve_to_the_remix_or_nothing(monkeypatch, sandbox):
    """"Song (X Remix)" is the remix: the resolver refuses the original (the recording the library most likely holds),
    a cached row that sits on the original is redone, and the artist's own versions ("(Radio Edit)") ask for nothing."""
    import sys
    import types

    from discovery import resolve

    assert resolve.named_remixer("Brooklyn Baby (Monsieur Adi Remix)") == "Monsieur Adi" and resolve.named_remixer("Song - Yuksek Remix") == "Yuksek"
    assert resolve.named_remixer("Song (Radio Edit)") is None and resolve.named_remixer("Song (Original Mix)") is None and resolve.named_remixer("Song") is None
    assert resolve.remix_agrees("Brooklyn Baby (Monsieur Adi Remix)", "Brooklyn Baby (Monsieur Adi Remix)")
    assert resolve.remix_agrees("Brooklyn Baby (Monsieur Adi Remix)", "Brooklyn Baby", "Brooklyn Baby (Monsieur Adi Remixes)")   # the album names the remix
    assert not resolve.remix_agrees("Brooklyn Baby (Monsieur Adi Remix)", "Brooklyn Baby", "Ultraviolence")
    assert not resolve.remix_agrees("Brooklyn Baby (Monsieur Adi Remix)", "Brooklyn Baby (Cedric Gervais Remix)")             # another remix is another track
    assert resolve.remix_agrees("Song (Radio Edit)", "Song") and resolve.remix_agrees("Song", "Song (X Remix)")                  # version_mismatch judges the second
    original = {"resultType": "song", "videoId": "orig", "title": "Brooklyn Baby", "artists": [{"name": "Lana Del Rey"}], "album": {"name": "Ultraviolence"}, "videoType": resolve.ATV, "duration": "5:52"}
    remix = {"resultType": "song", "videoId": "rmx", "title": "Brooklyn Baby (Monsieur Adi Remix)", "artists": [{"name": "Lana Del Rey"}], "album": {"name": "Brooklyn Baby (Remixes)"}, "videoType": resolve.ATV, "duration": "4:52"}
    assert resolve._pick([original, remix], "Lana Del Rey", "Brooklyn Baby (Monsieur Adi Remix)")["videoId"] == "rmx"
    assert resolve._pick([original], "Lana Del Rey", "Brooklyn Baby (Monsieur Adi Remix)") is None
    assert resolve._pick([original, remix], "Lana Del Rey", "Brooklyn Baby")["videoId"] == "orig"
    it = Item(artist="Lana Del Rey", title="Brooklyn Baby (Monsieur Adi Remix)", kind="track").normalize_credit()
    assert it.remixer == "Monsieur Adi" and it.title == "Brooklyn Baby"
    assert not resolve.plausible(it, {"videoId": "orig", "title": "Brooklyn Baby", "artists": ["Lana Del Rey"], "album": "Ultraviolence"})
    assert resolve.plausible(it, {"videoId": "rmx", "title": "Brooklyn Baby (Monsieur Adi Remix)", "artists": ["Lana Del Rey"]})

    class FakeYT:
        searches = []
        def search(self, q, filter=None, limit=None):
            FakeYT.searches.append((q, filter))
            return [original, remix] if filter == "songs" else []
        def get_watch_playlist(self, **kw): return {"tracks": []}
        def get_album(self, bid): return {}
    monkeypatch.setitem(sys.modules, "ytmusicapi", types.SimpleNamespace(YTMusic=FakeYT))
    # a row the old resolver wrote on the original is stale: redone, and the remix takes its place
    util.write_json(resolve.YT_CACHE, {it.key: {"seen": "2026-09-01", "yt": {"videoId": "orig", "title": "Brooklyn Baby", "artists": ["Lana Del Rey"], "album": "Ultraviolence", "videoType": resolve.ATV}, "v": resolve.CACHE_VERSION}})
    resolve.resolve_all([it], _cfg())
    assert it.youtube["videoId"] == "rmx" and FakeYT.searches[0] == ("Lana Del Rey Brooklyn Baby (Monsieur Adi Remix)", "songs")
    assert util.read_json(resolve.YT_CACHE, {})[it.key]["yt"]["videoId"] == "rmx"


def test_learner_rates_each_kind_of_act(tmp_path):
    """Keep rates by how the profile knows the act (direct / saved / similar / genre / none), banded by affinity, move
    the score like a source or a tag would; the kinds take no exploration bonus; the summary carries them."""
    from discovery import learn

    assert learn.kind_band("direct", 0.5) == ["direct", "direct·high"] and learn.kind_band("saved", 0.15) == ["saved", "saved·mid"]
    assert learn.kind_band("similar", 0.05) == ["similar", "similar·low"] and learn.kind_band(None, None) == ["none"] and learn.kind_band("genre", None) == ["genre"]
    today = date.today()
    shown = (today - timedelta(days=5)).isoformat()
    outs = []
    for n in range(20):
        outs.append({"id": f"d{n}", "s": ["ytmusic"], "t": [], "a": f"Act {n}", "m": "direct", "af": 0.5, "shown": shown, "verdict": "kept" if n < 8 else "skipped"})
        outs.append({"id": f"s{n}", "s": ["ytmusic"], "t": [], "a": f"Sim {n}", "m": "similar", "af": 0.2, "shown": shown, "verdict": "kept" if n < 1 else "skipped"})
    learned = learn.learn(outs, {"learn": {"prior": 2, "min_exposures": 3}}, today=today)
    assert learned["kinds"]["direct·high"]["n"] == 20 and learned["kinds"]["direct·high"]["k"] == 8
    assert learned["kinds"]["similar"]["adj"] < -0.8 < 0 < learned["kinds"]["direct"]["adj"]
    adj, why = learn.adjustment(learned, ["ytmusic"], [], "Someone Else", "similar", 0.2)
    assert adj < 0 and any(w.startswith("you keep only") and "similar acts" in w for w in why)
    up, why = learn.adjustment(learned, ["ytmusic"], [], "Someone Else", "direct", 0.5)
    assert up > adj and any("acts you play" in w for w in why)
    none, _ = learn.adjustment(learned, ["ytmusic"], [], "Someone Else")            # an act the profile does not know: no kind history yet, the source alone
    assert adj < none < up
    assert learn.exploration(learned, ["ytmusic"], [], "Someone Else") == learn.exploration(learned, ["ytmusic"], [], "Someone Else")
    assert "genre" not in learned["kinds"] and learn.public_summary(learned)["kinds"]["direct"]["n"] == 20


def test_listenbrainz_follows_only_the_acts_that_pay_off():
    """ListenBrainz's fresh releases are kept for the acts you play and the acts in your playlists above a minimum
    affinity; a similar or genre artist's release, or a one-song library act's, needs a tag hit."""
    from discovery.sources import listenbrainz as lb

    profile = {**PROFILE, "artists": {**PROFILE["artists"], "one song": {"name": "One Song", "affinity": 0.07, "kind": "saved", "mbid": None, "via": []},
                                       "many songs": {"name": "Many Songs", "affinity": 0.2, "kind": "saved", "mbid": None, "via": []}}}
    rel = lambda a, mb, tags=None: {"artist_credit_name": a, "release_name": f"{a} EP", "artist_mbids": [mb], "release_date": date.today().isoformat(),  # noqa: E731
                                    "release_group_primary_type": "EP", "release_tags": tags or []}
    payload = {"payload": {"releases": [rel("Jungle", "m-jungle"), rel("Parcels", "x"), rel("TOPS", "y"), rel("One Song", "z"), rel("Many Songs", "w"), rel("Parcels", "x2", ["nu-disco"])]}}

    class FakeHttp:
        def get(self, url, **kw): return payload

    cfg = _cfg()
    got = {i.artist for i in lb.fetch(cfg, profile, FakeHttp())}
    assert got == {"Jungle", "Many Songs", "Parcels"}                                # Parcels only by its tagged release
    assert sum(1 for i in lb.fetch(cfg, profile, FakeHttp()) if i.artist == "Parcels") == 1
    cfg["sources"]["listenbrainz_fresh"] = {**cfg["sources"]["listenbrainz_fresh"], "kinds": ["direct", "saved", "similar", "genre"], "min_affinity": 0}
    assert {i.artist for i in lb.fetch(cfg, profile, FakeHttp())} == {"Jungle", "Parcels", "TOPS", "One Song", "Many Songs"}
    assert lb.wanted(profile, "Jungle & Parcels", [], {"direct"}, 0.5) and not lb.wanted(profile, "Nobody", ["nope"], {"direct", "saved"}, 0)


def test_backfill_min_makes_the_last_years_a_daily_fixture():
    """`backfill.min` older cards join the day whenever they exist, however rich the current timeframe; above the
    target nothing more is used, and with min 0 the fill is what it was."""
    from discovery.build import fill_from_backfill

    def card(n, back=False):
        it = Item(artist=f"A{n}", title=f"T{n}", kind="track", backfill=back)
        it.youtube = {"videoId": f"v{n}", "videoType": "MUSIC_VIDEO_TYPE_ATV"}
        it.stated_year = 2024 if back else 2026
        return it
    fresh = [card(n) for n in range(6)]
    older = [card(10 + n, True) for n in range(4)]
    cfg = {"backfill": {"years": 3, "target": 2, "max": 3, "min": 2}}
    items, counts = fill_from_backfill(fresh + older, cfg)
    assert counts == {"fresh_playable": 6, "older": 4, "used": 2} and [i.artist for i in items if i.backfill] == ["A10", "A11"]
    assert "filling in from 2024" in items[-1].reasons
    cfg["backfill"]["min"] = 0
    assert fill_from_backfill(fresh + older, cfg)[1]["used"] == 0
    cfg["backfill"]["target"] = 10                                                      # a thin day: the gap, up to max
    assert fill_from_backfill(fresh + older, cfg)[1]["used"] == 3
