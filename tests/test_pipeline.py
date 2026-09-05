"""Offline tests: exercise parsing, merging, scoring, building and decision handling with canned data."""
from __future__ import annotations

import json
import os
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
            </channel></rss>""" % date.today().strftime("%a, %d %b %Y 10:00:00 GMT")

    cfg = _cfg()
    cfg["sources"]["bandcamp"]["tags"] = ["nu-disco"]
    bc = bandcamp.fetch(cfg, PROFILE, FakeHttp())
    assert len(bc) == 1 and bc[0].kind == "track" and bc[0].title == "Sodium" and bc[0].release_type == "EP" and "nu disco" in bc[0].tags
    cfg["sources"]["rss"]["feeds"] = [{"name": "Blog", "url": "https://blog/feed"}]
    entries = rss.fetch(cfg, PROFILE, FakeHttp())
    got = {(i.artist, i.title) for i in entries}
    assert ("Roosevelt", "Lovers") in got and ("Jungle", "Jungle announce tour") in got and len(entries) == 2
    assert all(i.editorial for i in entries)


def test_build_feed_hides_saved_and_skipped(monkeypatch, sandbox):
    import discovery.build as build
    from discovery import profile as prof

    profile = dict(PROFILE)
    profile["saved"] = dict(PROFILE["saved"])
    profile["saved"][util.item_key("Roosevelt", "Lovers")] = {"artist": "Roosevelt", "title": "Lovers", "decision": "down"}
    profile["picks"] = [{"artist": "Jungle", "title": "Back On 74", "videoId": "v1", "year": "2026", "thumbnail": None, "album": None}]
    profile["youtube"] = {"years": {"2026": "PL2026"}, "skipped": "PLSKIP", "channel": "UC1"}
    util.write_json(prof.PROFILE_PATH, profile)
    today = date.today()
    fake_items = [
        Item(artist="Jungle", title="Keep Moving", kind="track", release_date=today, sources=["rss:Pitchfork"], editorial=True),
        Item(artist="Jungle", title="Back On 74", kind="track", release_date=today, sources=["bandcamp"]),   # already in a year playlist
        Item(artist="Roosevelt", title="Lovers", kind="track", release_date=today, sources=["bandcamp"]),    # thumbed down → Skipped playlist
        Item(artist="Someone New", title="Disco Dream", kind="release", release_date=today, sources=["musicbrainz"], tags=["nu disco"]),
        Item(artist="Unknown Metal Band", title="Skull", kind="release", release_date=today, sources=["musicbrainz"], tags=["metal"]),
    ]
    monkeypatch.setattr(build, "run_sources", lambda cfg, profile, http: list(fake_items))

    def fake_resolve(items, cfg):
        for it in items:
            if it.artist == "Jungle":
                it.youtube = {"videoId": "vid123", "title": it.title, "artists": ["Jungle"], "thumbnail": "https://i/x.jpg"}
    monkeypatch.setattr(build, "resolve_all", fake_resolve)

    class NoNet:
        def __init__(self, *a, **k): pass
        def save(self): pass
    monkeypatch.setattr(build, "Http", NoNet)

    cfg = _cfg()
    cfg["google"]["client_id"] = "abc.apps.googleusercontent.com"
    payload = build.build_feed(cfg)
    ids = {(i["artist"], i["title"]) for i in payload["items"]}
    assert ("Jungle", "Keep Moving") in ids
    assert ("Jungle", "Back On 74") not in ids
    assert ("Roosevelt", "Lovers") not in ids
    assert ("Unknown Metal Band", "Skull") not in ids
    assert ("Someone New", "Disco Dream") not in ids        # tag-only, no YouTube match → dropped
    assert payload["years"][0] >= 2026 and payload["years"][-1] == 1979
    assert payload["google"]["client_id"] == "abc.apps.googleusercontent.com" and payload["google"]["curators"] == ["chrisrohn@gmail.com"]
    assert payload["google"]["guests"] is False and "{year}" in payload["google"]["guest_playlist_title_pattern"]
    pls = payload["youtube"]["playlists"]
    assert pls["2026"] == "PLTW5JZnPjE_q3bQltmawTeCJNF2VfH_dN" and len(pls) == 48   # config ids win over the profile's title matches
    assert payload["youtube"]["skipped_playlist_id"] == "PLSKIP"
    assert payload["picks"][0]["artist"] == "Jungle"
    assert (sandbox / "site" / "feed.xml").read_text().count("<item>") == len(payload["items"])


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
    from discovery.sources import youtube_channels, radio, HEALTH
    import discovery.sources.youtube_channels as yc
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
    assert HEALTH["yt:Toy Tonics"]["kept"] == 1
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


def test_find_duplicates_groups_same_video_other_upload_and_cross_year():
    from discovery.profile import find_duplicates
    from discovery.util import item_key

    def e(year, vid, artist, title, pos):
        return {"year": year, "playlistId": "PL" + year, "position": pos, "videoId": vid, "artist": artist, "title": title}

    where = {
        item_key("Dark Chisme", "Suffer Like Me"): [e("2026", "v1", "Dark Chisme", "Suffer Like Me", 3), e("2026", "v1", "Dark Chisme", "Suffer Like Me", 6)],
        item_key("Jungle", "Back On 74"): [e("2023", "v2", "Jungle", "Back On 74", 0), e("2023", "v3", "Jungle", "Back On 74 (Official Video)", 9)],
        item_key("Roosevelt", "Lovers"): [e("2016", "v4", "Roosevelt", "Lovers", 0), e("2017", "v4", "Roosevelt", "Lovers (2017 Remaster)", 1)],
        item_key("Solo", "Fine"): [e("2026", "v5", "Solo", "Fine", 0)],
    }
    out = find_duplicates(where)
    kinds = {d["artist"]: d["kind"] for d in out}
    assert kinds == {"Dark Chisme": "same-video", "Jungle": "other-upload", "Roosevelt": "cross-year"}
    roosevelt = next(d for d in out if d["artist"] == "Roosevelt")
    assert roosevelt["years"] == ["2017", "2016"] and roosevelt["count"] == 2 and out[0]["artist"] == "Dark Chisme"  # newest year first


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
    from discovery import build, years
    from discovery.util import item_key, write_json

    # one cross-year duplicate already verified for the feed (cache hit, free), one needing a lookup
    write_json(years.YEAR_CACHE, {item_key("Roosevelt", "Lovers"): {"v": 2, "found": {"musicbrainz": 2016, "deezer": 2016}}})
    dups = [
        {"key": item_key("Roosevelt", "Lovers"), "artist": "Roosevelt", "title": "Lovers", "kind": "cross-year", "years": ["2017", "2016"], "count": 2, "entries": []},
        {"key": item_key("Bag Raiders", "Shooting Stars"), "artist": "Bag Raiders", "title": "Shooting Stars", "kind": "cross-year", "years": ["2010", "2009"], "count": 2, "entries": []},
        {"key": item_key("Austra", "Home"), "artist": "Austra", "title": "Home", "kind": "same-video", "years": ["2013"], "count": 2, "entries": []},
    ]

    class FakeHttp:
        def get(self, url, **kw):
            p = kw.get("params", {})
            if "metadata/lookup" in url:
                return {"artist_credit_name": "Bag Raiders", "recording_name": "Shooting Stars", "recording_mbid": "rec-br"}
            if url.endswith("/recording/rec-br"):
                return {"first-release-date": "2008-11-01", "isrcs": [], "releases": [{"date": "2008-11-01", "release-group": {"first-release-date": "2008-11-01"}}]}
            return {}

    cfg = _cfg(); cfg["resolve"]["max_duplicate_year_lookups_per_run"] = 5
    looked = years.annotate_duplicate_years(dups, cfg, FakeHttp())
    assert looked == 1                                                     # only the unverified cross-year song hit the network
    assert (dups[0]["verified_year"], dups[0]["verified_source"]) == (2016, "MusicBrainz recording")
    assert (dups[1]["verified_year"], dups[1]["verified_source"]) == (2008, "MusicBrainz recording")
    assert "verified_year" not in dups[2]                                   # same-video needs no year to clean up
