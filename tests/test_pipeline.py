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
        Item(artist="Jungle", title="Keep Moving", kind="track", release_date=today, sources=["rss:Pitchfork"], editorial=True),
        Item(artist="Jungle", title="Keep Moving", kind="track", release_date=today, sources=["bandcamp"], tags=["nu disco"]),
        Item(artist="Parcels", title="Day/Night II", kind="release", release="Day/Night II", release_date=today - timedelta(days=3), sources=["listenbrainz"], artist_mbids=[]),
        Item(artist="Unknown Metal Band", title="Skull", kind="release", release_date=today, sources=["musicbrainz"], tags=["metal"]),
        Item(artist="Someone New", title="Disco Dream", kind="release", release_date=today, sources=["musicbrainz"], tags=["nu disco", "indie pop"]),
    ]
    merged = dedupe(items)
    assert len(merged) == 4
    jungle = next(i for i in merged if i.artist == "Jungle")
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
    assert payload["youtube"]["playlists"] == {"2026": "PL2026"} and payload["youtube"]["skipped_playlist_id"] == "PLSKIP"
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
            return [{"title": "1999 Indie Discotheque", "playlistId": "PL1999"}, {"title": "Indie Discotheque – Skipped", "playlistId": "PLSKIP"},
                    {"title": "Random Mix", "playlistId": "PLX"}, {"title": "2026 Indie Discotheque", "playlistId": "PLDUP"}]

    cfg = _cfg()
    cfg["youtube_music"]["channel_id"] = ""          # learn the channel from a playlist's author
    years, skipped, channel = discover_playlists(cfg, FakeYT())
    assert channel == "UC1" and skipped == "PLSKIP"
    assert years["1999"] == "PL1999" and years["2026"] == "PLTW5JZnPjE_q3bQltmawTeCJNF2VfH_dN"  # configured id wins


def test_resolve_pick():
    from discovery.resolve import _pick

    res = [
        {"resultType": "song", "title": "Keep Moving", "artists": [{"name": "Jungle"}], "videoId": "a"},
        {"resultType": "song", "title": "Keep Moving (Karaoke)", "artists": [{"name": "Karaoke Kings"}], "videoId": "b"},
    ]
    assert _pick(res, "Jungle", "Keep Moving")["videoId"] == "a"
    assert _pick(res[1:], "Jungle", "Keep Moving") is None


def test_verify_years_uses_musicbrainz_then_deezer_then_itunes(monkeypatch):
    from discovery import resolve

    today = date.today()
    mb = {"recordings": [
        {"title": "Lovers", "artist-credit": [{"name": "Roosevelt"}], "releases": [
            {"date": "2016-08-19", "release-group": {"first-release-date": "2016-08-19"}},
            {"date": today.isoformat(), "release-group": {"first-release-date": today.isoformat(), "secondary-types": ["Compilation"]}},
        ]},
        {"title": "Lovers (Karaoke)", "artist-credit": [{"name": "Roosevelt"}], "releases": [{"date": "1990-01-01"}]},
    ]}
    calls = []

    class FakeHttp:
        def get(self, url, **kw):
            calls.append((url, kw.get("params", {})))
            p = kw.get("params", {})
            if "musicbrainz" in url:
                return mb if "Roosevelt" in p["query"] else {"recordings": []}
            if "itunes" in url:
                if "Someone" in p["term"]:
                    return {"results": [{"trackName": "Blog Only", "artistName": "Someone", "releaseDate": "2019-03-01T00:00:00Z"}]}
                return {"results": []}
            if "deezer" in url and url.endswith("/search"):
                if "RAC" in p["q"]:
                    return {"data": [{"title": "I Should've Guessed (feat. Speak)", "title_short": "I Should've Guessed", "artist": {"name": "RAC"}, "album": {"id": 77}}]}
                return {"data": []}
            if "/album/77" in url:
                return {"release_date": "2014-04-14", "record_type": "album"}
            return {}

    items = [
        Item(artist="Roosevelt", title="Lovers", kind="track", release_date=today, sources=["listenbrainz"]),
        Item(artist="RAC", title="I Should've Guessed", featuring=["Speak"], kind="track", sources=["radio:SomaFM poptron"]),
        Item(artist="Jungle", title="Keep Moving", kind="track", release_date=today, sources=["bandcamp"]),
        Item(artist="Someone", title="Blog Only", kind="track", release_date=today, sources=["rss:Pitchfork"], youtube={"videoId": "x", "year": "2019"}),
        Item(artist="Nobody", title="Nothing", kind="track", sources=["rss:Blog"]),
    ]
    resolve.verify_years(items, _cfg(), FakeHttp())
    r, rac, j, s, n = items
    assert (r.year, r.year_source, r.year_confidence, r.original_year) == (2016, "musicbrainz-recording", "high", 2016)
    assert (rac.year, rac.year_source, rac.year_confidence) == (2014, "deezer", "medium")           # radio play, no date → Deezer knew
    # the MusicBrainz query used the plain title, not "… feat. Speak"
    mbq = next(p["query"] for u, p in calls if "musicbrainz" in u and "RAC" in p["query"])
    assert 'recording:"I Should\'ve Guessed" AND artist:"RAC"' == mbq
    assert (j.year, j.year_source, j.year_confidence) == (today.year, "release-date", "medium")
    assert (s.year, s.year_source) == (2019, "itunes")                                              # iTunes beats the blog date
    assert (n.year, n.year_source, n.year_confidence) == (today.year, "unknown", "low")
    assert r.to_dict()["original_year"] == 2016


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
            return [{"title": "Indie Discotheque 1999", "playlistId": "PL1999"}, {"title": "2001 - indie discotheque", "playlistId": "PL2001"},
                    {"title": "1987 Indie Discotheque", "playlistId": "PL1987"}, {"title": "Indie Discotheque favourites", "playlistId": "PLX"}]

    cfg = _cfg()
    years, skipped, channel = discover_playlists(cfg, FakeYT())
    assert channel == cfg["youtube_music"]["channel_id"] == "UCLyRuumpAkAqDKe3nmFZljw"   # configured id wins
    cfg["youtube_music"]["channel_id"] = ""
    assert discover_playlists(cfg, FakeYT())[2] == "UCxyz"                                   # otherwise learned from the author
    assert years["1999"] == "PL1999" and years["2001"] == "PL2001" and years["1987"] == "PL1987" and "PLX" not in years.values()
