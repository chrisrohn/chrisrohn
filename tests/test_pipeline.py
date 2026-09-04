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
    import discovery.sync as sync
    import discovery.sources.deezer as deezer

    monkeypatch.setattr(build, "DECISIONS_PATH", tmp_path / "data" / "decisions.json")
    monkeypatch.setattr(build, "FEED_PATH", tmp_path / "site" / "data" / "feed.json")
    monkeypatch.setattr(build, "STATE_PATH", tmp_path / "data" / "state.json")
    monkeypatch.setattr(build, "SITE_DATA_DIR", tmp_path / "site" / "data")
    monkeypatch.setattr(profile, "PROFILE_PATH", tmp_path / "data" / "profile.json")
    monkeypatch.setattr(profile, "ARTIST_CACHE_PATH", tmp_path / "data" / "cache" / "artists.json")
    monkeypatch.setattr(profile, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(resolve, "YT_CACHE", tmp_path / "data" / "cache" / "youtube.json")
    monkeypatch.setattr(sync, "DECISIONS_PATH", tmp_path / "data" / "decisions.json")
    monkeypatch.setattr(sync, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(deezer, "ID_CACHE", tmp_path / "data" / "cache" / "deezer_artists.json")
    util.ensure_dirs()
    yield tmp_path


def test_norm_and_parse():
    assert util.norm("The Bird & The Bee") == "bird and the bee"
    assert util.norm_track("Heartbeat (feat. Someone) [Radio Edit]") == "heartbeat"
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


def test_build_feed_and_decisions(monkeypatch, sandbox):
    import discovery.build as build
    import discovery.sync as sync
    from discovery import profile as prof

    util.write_json(prof.PROFILE_PATH, PROFILE)
    today = date.today()
    fake_items = [
        Item(artist="Jungle", title="Keep Moving", kind="track", release_date=today, sources=["rss:Pitchfork"], editorial=True),
        Item(artist="Jungle", title="Back On 74", kind="track", release_date=today, sources=["bandcamp"]),  # already saved → hidden
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
    payload = build.build_feed(cfg)
    ids = {(i["artist"], i["title"]): i for i in payload["items"]}
    assert ("Jungle", "Keep Moving") in ids
    assert ("Jungle", "Back On 74") not in ids            # already in a year playlist
    assert ("Unknown Metal Band", "Skull") not in ids       # negative score
    assert ("Someone New", "Disco Dream") not in ids        # tag-only, no YouTube match → dropped
    assert payload["years"][0] >= 2026 and payload["years"][-1] == 1979
    assert (sandbox / "site" / "feed.xml").read_text().count("<item>") == len(payload["items"])
    jungle_id = ids[("Jungle", "Keep Moving")]["id"]

    # --- user thumbs up Jungle on the site → dispatch payload → filed into the 2026 playlist
    class FakeYT:
        added: list = []
        def get_library_playlists(self, limit=None):
            return [{"title": f"{today.year} Indie Discotheque", "playlistId": "PL_THIS_YEAR"}, {"title": "Other", "playlistId": "PLX"}]
        def add_playlist_items(self, pid, vids, duplicates=False):
            FakeYT.added.append((pid, tuple(vids)))
            return {"status": "STATUS_SUCCEEDED"}
    monkeypatch.setattr(sync, "_ytmusic_authed", lambda: FakeYT())
    result = sync.apply_decisions(cfg, {"decisions": [
        {"id": jungle_id, "decision": "up", "year": today.year, "videoId": "vid123", "artist": "Jungle", "title": "Keep Moving"},
        {"id": "deadbeef", "decision": "down", "year": today.year, "artist": "X", "title": "Y"},
    ]})
    assert result == {"recorded": 2, "filed": 1, "pending": 0}
    assert FakeYT.added == [("PL_THIS_YEAR", ("vid123",))]
    store = json.loads((sandbox / "data" / "decisions.json").read_text())
    assert store["items"][jungle_id]["filed_at"] and store["items"]["deadbeef"]["decision"] == "down"

    # the rebuilt feed archives the rated item
    payload2 = build.build_feed(cfg)
    assert all(i["id"] != jungle_id for i in payload2["items"])
    public = json.loads((sandbox / "site" / "data" / "decisions.json").read_text())
    assert jungle_id in public["items"]

    # without the secret, approvals stay pending and are retried later
    monkeypatch.setattr(sync, "_ytmusic_authed", lambda: None)
    r2 = sync.apply_decisions(cfg, {"decisions": [{"id": "cafe", "decision": "up", "year": 1999, "videoId": "v99", "artist": "A", "title": "B"}]})
    assert r2["pending"] == 1
    monkeypatch.setattr(sync, "_ytmusic_authed", lambda: FakeYT())
    r3 = sync.apply_decisions(cfg, {"decisions": []})
    assert r3["pending"] == 1  # no 1999 playlist in the fake library → still pending, not lost


def test_resolve_pick():
    from discovery.resolve import _pick

    res = [
        {"resultType": "song", "title": "Keep Moving", "artists": [{"name": "Jungle"}], "videoId": "a"},
        {"resultType": "song", "title": "Keep Moving (Karaoke)", "artists": [{"name": "Karaoke Kings"}], "videoId": "b"},
    ]
    assert _pick(res, "Jungle", "Keep Moving")["videoId"] == "a"
    assert _pick(res[1:], "Jungle", "Keep Moving") is None


def test_device_flow_polls_until_approved(monkeypatch):
    from discovery import oauth

    calls = {"n": 0}

    class FakeCreds:
        def __init__(self, *a, **k): pass
        def get_code(self):
            return {"device_code": "dev", "user_code": "ABCD-EFGH", "verification_url": "https://www.google.com/device", "interval": 0, "expires_in": 60}
        def token_from_code(self, device_code):
            calls["n"] += 1
            if calls["n"] < 3:
                return {"error": "authorization_pending"}
            return {"access_token": "at", "refresh_token": "rt", "scope": "s", "token_type": "Bearer", "expires_in": 3600}

    import ytmusicapi.auth.oauth.credentials as c
    monkeypatch.setattr(c, "OAuthCredentials", FakeCreds)
    monkeypatch.setattr(oauth.time, "sleep", lambda s: None)
    tok = oauth.device_flow("id", "secret")
    assert calls["n"] == 3 and tok["access_token"] == "at" and tok["refresh_token"] == "rt" and tok["expires_at"] > 0
