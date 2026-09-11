"""Offline tests for the concert list (discovery/concerts.py): the radius, the artist set, both listing sources'
shapes, the merge across sources, the most popular song, and a whole build against canned answers."""
from __future__ import annotations

import sys
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from discovery import concerts, util  # noqa: E402
from discovery.profile import LastFm  # noqa: E402

DETROIT = {"name": "Detroit, MI", "lat": 42.3314, "lon": -83.0458}
TODAY = date.today()
SOON = (TODAY + timedelta(days=20)).isoformat()
LATER = (TODAY + timedelta(days=45)).isoformat()


@pytest.fixture(autouse=True)
def sandbox(tmp_path, monkeypatch):
    monkeypatch.setattr(util, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(util, "CACHE_DIR", tmp_path / "data" / "cache")
    monkeypatch.setattr(util, "SITE_DATA_DIR", tmp_path / "site" / "data")
    monkeypatch.setattr(concerts, "STATE_PATH", tmp_path / "data" / "concerts_state.json")
    monkeypatch.setattr(concerts, "CONCERTS_PATH", tmp_path / "site" / "data" / "concerts.json")
    import discovery.resolve as resolve
    monkeypatch.setattr(resolve, "YT_CACHE", tmp_path / "data" / "cache" / "youtube.json")
    util.ensure_dirs()
    yield tmp_path


class FakeHttp:
    """Answers by URL and method; records what was asked."""

    def __init__(self, answers):
        self.answers = answers      # callable(url, params) -> data | raises
        self.calls = []
        self.min_interval = {}
        self.deadline = None

    def get(self, url, params=None, **kw):
        self.calls.append((url, dict(params or {})))
        return self.answers(url, params or {})

    def save(self):
        pass


def bit_event(eid, artist, venue, city, region, lat, lon, when, *, tickets="https://tix.example/1", lineup=None, title=""):
    return {"id": eid, "url": f"https://www.bandsintown.com/e/{eid}", "datetime": f"{when}T20:00:00", "title": title,
            "artist": {"name": artist, "url": f"https://www.bandsintown.com/a/{artist.replace(' ', '-')}", "image_url": "https://img.example/a.jpg"},
            "venue": {"name": venue, "city": city, "region": region, "country": "United States", "latitude": str(lat), "longitude": str(lon)},
            "offers": [{"type": "Tickets", "url": tickets, "status": "available"}] if tickets else [], "lineup": lineup or [artist]}


def tm_event(eid, name, attractions, venue, city, state_code, lat, lon, when, *, price=None, status="onsale"):
    return {"id": eid, "name": name, "url": f"https://www.ticketmaster.com/event/{eid}", "dates": {"start": {"localDate": when, "localTime": "19:30:00"}, "status": {"code": status}},
            "priceRanges": [{"min": price[0], "max": price[1], "currency": "USD"}] if price else [],
            "images": [{"url": "https://img.example/small.jpg", "ratio": "4_3", "width": 300}, {"url": "https://img.example/wide.jpg", "ratio": "16_9", "width": 1024}],
            "_embedded": {"venues": [{"name": venue, "city": {"name": city}, "state": {"stateCode": state_code}, "country": {"name": "United States", "countryCode": "US"}, "location": {"latitude": str(lat), "longitude": str(lon)}}],
                          "attractions": [{"name": a} for a in attractions]}}


def test_distance_and_radius():
    assert 85 < concerts.miles_between(42.3314, -83.0458, 41.4993, -81.6944) < 95      # Cleveland
    assert 230 < concerts.miles_between(42.3314, -83.0458, 41.8781, -87.6298) < 245    # Chicago: outside 150
    assert 30 < concerts.miles_between(42.3314, -83.0458, 42.2808, -83.7430) < 40      # Ann Arbor
    assert concerts.within({"lat": 41.4993, "lon": -81.6944}, DETROIT, 150)["miles"] == pytest.approx(90.5, abs=2)
    assert concerts.within({"lat": 41.8781, "lon": -87.6298}, DETROIT, 150) is None
    assert concerts.within({"lat": None, "lon": -83.0}, DETROIT, 150) is None           # a venue nobody placed on the map
    assert concerts.within({"lat": "nope", "lon": "x"}, DETROIT, 150) is None


def test_played_artists_blend_lastfm_and_this_years_playlist():
    def answers(url, params):
        assert params["method"] == "user.gettopartists" and params["period"] == "12month"
        return {"topartists": {"artist": [{"name": "Cut Copy", "playcount": "143"}, {"name": "Jungle", "playcount": "80"}, {"name": "", "playcount": "9"}], "@attr": {"totalPages": "1"}}}
    lastfm = LastFm(FakeHttp(answers), "key")
    profile = {"artists": {}, "youtube": {"entries": [{"year": str(TODAY.year), "artist": "Jungle"}, {"year": str(TODAY.year), "artist": "Parcels"}, {"year": str(TODAY.year), "artist": "Parcels"},
                                                       {"year": str(TODAY.year - 1), "artist": "Old Act"}]}}
    played = concerts.played_artists({"station": {"lastfm_user": "u"}, "concerts": {"playlist_years": 1}}, profile, lastfm)
    assert set(played) == {"cut copy", "jungle", "parcels"}                    # last year's playlist is outside the window
    assert played["jungle"] == {"name": "Jungle", "plays": 80, "filed": 1, "via": ["lastfm:12month", "playlists"]}
    assert played["parcels"]["filed"] == 2 and played["parcels"]["plays"] == 0
    assert concerts.ranked(played) == ["cut copy", "jungle", "parcels"]
    # two playlist years widen the window; no key falls back to the profile's 12-month artists
    played2 = concerts.played_artists({"station": {"lastfm_user": "u"}, "concerts": {"playlist_years": 2}}, profile, lastfm)
    assert "old act" in played2
    prof = {"artists": {"tops": {"name": "TOPS", "via": ["lastfm:overall", "lastfm:12month"]}, "x": {"name": "X", "via": ["lastfm:overall"]}}, "youtube": {"entries": []}}
    played3 = concerts.played_artists({"station": {"lastfm_user": "u"}, "concerts": {}}, prof, LastFm(FakeHttp(lambda u, p: {}), None))
    assert list(played3) == ["tops"] and played3["tops"]["plays"] == 0


def test_bandsintown_name_encoding_and_answers():
    assert concerts.bit_name("Cut Copy") == "Cut%20Copy"
    assert concerts.bit_name("AC/DC") == "AC%252FDC"
    assert concerts.bit_name('Panic? "Star"*') == "Panic%253F%20%27CStar%27C%252A"
    def answers(url, params):
        assert params["app_id"] == "test-app" and params["date"] == "upcoming"
        if "Unknown" in url:
            return {"errorMessage": "[NotFound] The artist was not found"}
        if "Gone" in url:
            raise RuntimeError("404 Client Error: Not Found")
        if "Down" in url:
            raise RuntimeError("503 Server Error")
        return [bit_event("1", "Cut Copy", "Saint Andrew's Hall", "Detroit", "MI", 42.3339, -83.0470, SOON), "junk"]
    http = FakeHttp(answers)
    assert len(concerts.bandsintown_events(http, "Cut Copy", "test-app")) == 1
    assert concerts.bandsintown_events(http, "Unknown Act", "test-app") == []
    assert concerts.bandsintown_events(http, "Gone Act", "test-app") == []
    assert concerts.bandsintown_events(http, "Down Act", "test-app") is None      # a failed request keeps the old listing
    reasons = concerts.Counter()
    assert concerts.bandsintown_events(http, "Down Act", "test-app", reasons) is None and reasons == {"HTTP 503": 1}
    assert concerts.failure_reason(RuntimeError("403 Client Error: Forbidden for url: x")) == "HTTP 403"
    assert concerts.failure_reason(TimeoutError("read timed out")) == "TimeoutError"


def test_bandsintown_refusals_end_the_batch_and_are_named(monkeypatch):
    """An app_id Bandsintown did not issue gets 403 on every request: the run stops after give_up_after of them,
    the rest stay due, and the health record and the log say so instead of a silent 1,500-request failure."""
    asked = []
    def answers(url, params):
        if "audioscrobbler" in url:
            if params["method"] == "user.gettopartists":
                return {"topartists": {"artist": [{"name": f"Act {i}", "playcount": str(100 - i)} for i in range(30)], "@attr": {"totalPages": "1"}}}
            return {}
        if "bandsintown" in url:
            asked.append(url)
            raise RuntimeError("403 Client Error: Forbidden for url: " + url)
        return {"_embedded": {"events": []}, "page": {"totalPages": 0, "totalElements": 0}}
    monkeypatch.setattr(concerts, "Http", lambda *a, **k: FakeHttp(answers))
    monkeypatch.setattr(concerts, "load_profile", lambda: {"artists": {}, "youtube": {"entries": []}})
    monkeypatch.setenv("LASTFM_API_KEY", "k"); monkeypatch.setenv("TICKETMASTER_API_KEY", "t"); monkeypatch.delenv("BANDSINTOWN_APP_ID", raising=False)
    import discovery.resolve as resolve
    monkeypatch.setattr(resolve, "resolve_all", lambda items, cfg, **k: None)
    cfg = {"station": {"lastfm_user": "u"}, "concerts": {"artists_per_run": 25, "bandsintown": {"app_id": "nobody", "give_up_after": 5}}, "resolve": {"youtube_music": False}}
    out = concerts.build_concerts(cfg)
    b = out["health"]["bandsintown"]
    assert len(asked) == 5 and b["asked"] == 5 and b["failed"] == 5 and b["ok"] is False
    assert b["errors"] == {"HTTP 403": 5} and b["error"].startswith("HTTP 403 on 5 of 5 requests") and "BANDSINTOWN_APP_ID" in b["error"]
    assert b["due"] == 30 and b["checked"] == 0 and out["count"] == 0


def test_shape_bandsintown():
    ev = bit_event("77", "Cut Copy", "Saint Andrew's Hall", "Detroit", "MI", 42.3339, -83.0470, SOON, lineup=["Cut Copy", "Jungle"], title="")
    s = concerts.shape_bandsintown(ev, "Cut Copy")
    assert s["id"] == "bit:77" and s["date"] == SOON and s["time"] == "20:00" and s["venue"] == "Saint Andrew's Hall"
    assert s["city"] == "Detroit" and s["region"] == "MI" and s["tickets"] == "https://tix.example/1" and s["url"] == "https://www.bandsintown.com/e/77"
    assert s["lineup"] == ["Cut Copy", "Jungle"] and s["status"] == "available" and s["title"] is None and s["festival"] is False
    near = concerts.within(s, DETROIT, 150)
    assert near["miles"] < 1
    # no ticket offer, a javascript: link, a cancelled title
    ev2 = bit_event("78", "Cut Copy", "The Fillmore", "Detroit", "MI", 42.336, -83.052, SOON, tickets="javascript:alert(1)", title="Cancelled: Cut Copy")
    s2 = concerts.shape_bandsintown(ev2, "Cut Copy")
    assert s2["tickets"] is None and s2["status"] == "cancelled" and s2["title"] == "Cancelled: Cut Copy"


def test_shape_ticketmaster_and_matching():
    ev = tm_event("Z1", "Jungle", ["Jungle", "Parcels"], "Royal Oak Music Theatre", "Royal Oak", "MI", 42.4895, -83.1446, LATER, price=(35.0, 65.0))
    s = concerts.shape_ticketmaster(ev)
    assert s["id"] == "tm:Z1" and s["artist"] == "Jungle" and s["lineup"] == ["Jungle", "Parcels"] and s["date"] == LATER and s["time"] == "19:30"
    assert s["venue"] == "Royal Oak Music Theatre" and s["city"] == "Royal Oak" and s["region"] == "MI" and s["country"] == "United States"
    assert s["tickets"] == "https://www.ticketmaster.com/event/Z1" and s["price"] == {"min": 35.0, "max": 65.0, "currency": "USD"}
    assert s["image"] == "https://img.example/wide.jpg" and s["status"] == "onsale"
    played = {"jungle": {"name": "Jungle", "plays": 80, "filed": 0}, "parcels": {"name": "Parcels", "plays": 200, "filed": 1}, "jungle brothers": {"name": "Jungle Brothers", "plays": 5, "filed": 0}}
    assert concerts.matched_artists(["Jungle", "Parcels", "Nobody"], played) == ["Parcels", "Jungle"]      # the most played first
    assert concerts.matched_artists(["Jungle Brothers"], played) == ["Jungle Brothers"]
    assert concerts.matched_artists(["Jungle Bros"], played) == []                                          # no fuzzy matching


T0 = datetime(2026, 9, 11, 17, 0, 0, tzinfo=UTC)
T1 = T0 + timedelta(days=360)


def test_ticketmaster_paging_stops_at_the_deep_paging_limit():
    pages = []
    def answers(url, params):
        pages.append(int(params["page"]))
        assert params["latlong"] == "42.3314,-83.0458" and params["radius"] == "150" and params["unit"] == "miles" and params["classificationName"] == "music"
        assert params["startDateTime"] == "2026-09-11T17:00:00Z" and params["endDateTime"] == "2027-09-06T17:00:00Z" and params["includeTBA"] == "yes"
        return {"_embedded": {"events": [tm_event(f"E{params['page']}", "X", ["X"], "V", "Detroit", "MI", 42.33, -83.05, SOON)]}, "page": {"totalPages": 40, "totalElements": 1000}}
    http = FakeHttp(answers)
    evs = concerts.ticketmaster_events(http, "k", DETROIT, 150, start=T0, end=T1, size=200)
    assert pages == [0, 1, 2, 3, 4] and len(evs) == 5      # 5 × 200 = the 1,000-result limit; exactly 1,000 needs no split
    http2 = FakeHttp(lambda u, p: {"_embedded": {"events": []}, "page": {"totalPages": 0, "totalElements": 0}})
    assert concerts.ticketmaster_events(http2, "k", DETROIT, 150, start=T0, end=T1, size=200) == []


def test_ticketmaster_splits_a_window_past_the_deep_paging_limit():
    """A year with 2,400 events: the whole horizon (and its first half) report more than 1,000, so they are split
    until each window fits; every event comes back once, soonest windows first, within a handful of requests."""
    def parse(s):
        return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    shows = [(T0 + timedelta(hours=3 * i), f"S{i}") for i in range(2400)]      # 2,400 shows, one every three hours (~300 days)
    windows = []
    def answers(url, params):
        lo, hi, page, size = parse(params["startDateTime"]), parse(params["endDateTime"]), int(params["page"]), int(params["size"])
        inside = [(t, i) for t, i in shows if lo <= t <= hi]
        windows.append((lo, hi, page, len(inside)))
        assert (page + 1) * size <= 1000                                     # never asked past what Ticketmaster allows
        chunk = inside[page * size:(page + 1) * size]
        return {"_embedded": {"events": [tm_event(i, "X", ["X"], "V", "Detroit", "MI", 42.33, -83.05, t.date().isoformat()) for t, i in chunk]},
                "page": {"totalElements": len(inside), "totalPages": -(-len(inside) // size)}}
    http = FakeHttp(answers)
    evs = concerts.ticketmaster_events(http, "k", DETROIT, 150, start=T0, end=T1, size=200)
    assert sorted(e["id"] for e in evs) == sorted(i for _, i in shows)        # all 2,400, each once
    firsts = [w[3] for w in windows if w[2] == 0]
    assert firsts[0] == 2400 and firsts[1] > 1000 and firsts[1] < 2400        # the year, then its first half: both too big
    assert all(n <= 1000 for lo, hi, page, n in windows if page > 0)          # only windows that fit are paged
    assert len(windows) < 40                                                   # a few dozen requests, not thousands
    assert windows[-1][0] > windows[0][0]                                      # soonest windows first
    # a request budget trims the far end, never the start
    http2 = FakeHttp(answers)
    few = concerts.ticketmaster_events(http2, "k", DETROIT, 150, start=T0, end=T1, size=200, max_requests=4)
    assert 0 < len(few) < 2400 and "S0" in {e["id"] for e in few}


def test_merge_events_folds_bills_and_sources():
    a = {**concerts.shape_bandsintown(bit_event("1", "Cut Copy", "Hall", "Detroit", "MI", 42.33, -83.05, SOON, lineup=["Cut Copy", "Jungle"]), "Cut Copy"), "artists": ["Cut Copy", "Jungle"], "miles": 0.4}
    b = {**concerts.shape_bandsintown(bit_event("1", "Jungle", "Hall", "Detroit", "MI", 42.33, -83.05, SOON, lineup=["Cut Copy", "Jungle"]), "Jungle"), "artists": ["Jungle", "Cut Copy"], "miles": 0.4}
    t = {**concerts.shape_ticketmaster(tm_event("T", "Cut Copy", ["Cut Copy"], "Hall", "Detroit", "MI", 42.33, -83.05, SOON, price=(30, 50))), "artist": "Cut Copy", "artists": ["Cut Copy"], "miles": 0.4}
    far = {**concerts.shape_bandsintown(bit_event("2", "Jungle", "Agora", "Cleveland", "OH", 41.5, -81.7, LATER), "Jungle"), "artists": ["Jungle"], "miles": 90.5}
    out = concerts.merge_events([far, a, b, t])
    assert [e["id"] for e in out] == ["bit:1", "bit:2"]                 # one row per show, soonest first
    show = out[0]
    assert show["artists"] == ["Cut Copy", "Jungle"] and show["sources"] == ["bandsintown", "ticketmaster"]
    assert show["price"] == {"min": 30, "max": 50, "currency": "USD"} and show["image"] == "https://img.example/wide.jpg"
    assert show["tickets"] == "https://tix.example/1"                   # Bandsintown's own offer stays the ticket link
    assert show["links"] == {"bandsintown": "https://www.bandsintown.com/e/1", "ticketmaster": "https://www.ticketmaster.com/event/T"}
    assert show["ticketer"] is None                                      # tix.example is nobody we know
    # a Ticketmaster-only show with no Bandsintown twin keeps its own ticket link
    alone = concerts.merge_events([t])[0]
    assert alone["tickets"] == "https://www.ticketmaster.com/event/T" and alone["sources"] == ["ticketmaster"] and alone["ticketer"] == "Ticketmaster"
    # a Bandsintown row without an offer takes Ticketmaster's link, and says whose it is
    bare = {**concerts.shape_bandsintown(bit_event("1", "Cut Copy", "Hall", "Detroit", "MI", 42.33, -83.05, SOON, tickets=None), "Cut Copy"), "artists": ["Cut Copy"], "miles": 0.4}
    got = concerts.merge_events([bare, t])[0]
    assert got["tickets"] == "https://www.ticketmaster.com/event/T" and got["ticketer"] == "Ticketmaster" and got["sources"] == ["bandsintown", "ticketmaster"]


def test_ticketer_names_the_seller():
    assert concerts.ticketer_of("https://www.axs.com/events/1234/cut-copy-tickets") == "AXS"
    assert concerts.ticketer_of("https://www.ticketweb.com/event/cut-copy-tickets/1234") == "TicketWeb"
    assert concerts.ticketer_of("https://concerts.livenation.com/x") == "Live Nation"
    assert concerts.ticketer_of("https://link.dice.fm/abc") == "DICE"
    assert concerts.ticketer_of("https://www.bandsintown.com/t/1234?app_id=x") == "Bandsintown"   # a redirect: the seller is behind it
    assert concerts.ticketer_of("https://tix.example/1") is None and concerts.ticketer_of(None) is None and concerts.ticketer_of("not a url") is None


def test_top_track_lastfm_then_deezer():
    def answers(url, params):
        if "audioscrobbler" in url:
            return {"toptracks": {"track": [{"name": "Hearts on Fire", "listeners": "1200", "playcount": "5000", "url": "https://www.last.fm/music/Cut+Copy/_/Hearts+on+Fire"}]}}
        if url.endswith("/search/artist"):
            return {"data": [{"id": 7, "name": "Jungle Brothers"}, {"id": 9, "name": "Jungle"}]}
        if url.endswith("/artist/9/top"):
            return {"data": [{"title": "Back on 74", "rank": 900000, "link": "https://www.deezer.com/track/1"}]}
        raise AssertionError(url)
    http = FakeHttp(answers)
    assert concerts.top_track(LastFm(http, "key"), http, "Cut Copy") == {"title": "Hearts on Fire", "source": "lastfm", "listeners": 1200, "plays": 5000, "url": "https://www.last.fm/music/Cut+Copy/_/Hearts+on+Fire"}
    assert concerts.top_track(LastFm(http, None), http, "Jungle") == {"title": "Back on 74", "source": "deezer", "rank": 900000, "url": "https://www.deezer.com/track/1"}
    assert concerts.top_track(LastFm(http, None), http, "Nobody Here") is None


def test_build_concerts_end_to_end(monkeypatch, sandbox):
    profile = {"artists": {}, "youtube": {"entries": [{"year": str(TODAY.year), "artist": "Parcels"}]}, "saved": {}}
    monkeypatch.setattr(concerts, "load_profile", lambda: profile)
    monkeypatch.setenv("LASTFM_API_KEY", "key")
    monkeypatch.setenv("TICKETMASTER_API_KEY", "tm-key")
    asked = []

    def answers(url, params):
        if "audioscrobbler" in url:
            if params["method"] == "user.gettopartists":
                return {"topartists": {"artist": [{"name": "Cut Copy", "playcount": "143"}, {"name": "Jungle", "playcount": "80"}, {"name": "Far Away Act", "playcount": "50"}], "@attr": {"totalPages": "1"}}}
            if params["method"] == "artist.gettoptracks":
                return {"toptracks": {"track": [{"name": f"Best of {params['artist']}", "listeners": "1000", "playcount": "2000", "url": "https://www.last.fm/x"}]}}
        if "bandsintown" in url:
            asked.append(url)
            if "Cut%20Copy" in url:
                return [bit_event("1", "Cut Copy", "Saint Andrew's Hall", "Detroit", "MI", 42.3339, -83.0470, SOON, lineup=["Cut Copy", "Jungle"]),
                        bit_event("2", "Cut Copy", "Metro", "Chicago", "IL", 41.95, -87.66, LATER),                 # outside the radius
                        bit_event("3", "Cut Copy", "Bluebird", "Bloomington", "IN", 39.16, -86.53, "2020-01-01")]      # past
            if "Jungle" in url:
                return {"errorMessage": "[NotFound] The artist was not found"}
            raise RuntimeError("503 Server Error")                                                                   # Far Away Act / Parcels: try again next run
        if "ticketmaster" in url:
            return {"_embedded": {"events": [tm_event("T1", "Jungle", ["Jungle"], "Royal Oak Music Theatre", "Royal Oak", "MI", 42.4895, -83.1446, LATER, price=(35, 65)),
                                             tm_event("T2", "Cut Copy", ["Cut Copy"], "Saint Andrew's Hall", "Detroit", "MI", 42.3339, -83.0470, SOON),
                                             tm_event("T3", "Somebody Else", ["Somebody Else"], "Fox", "Detroit", "MI", 42.33, -83.05, SOON)]}, "page": {"totalPages": 1}}
        raise AssertionError(url)
    monkeypatch.setattr(concerts, "Http", lambda name, ttl_hours=20: FakeHttp(answers))
    resolved = []

    def fake_resolve(items, cfg, deadline=None, avoid=None):
        assert cfg["resolve"]["max_lookups_per_run"] == 300 and cfg["resolve"]["audio_heals_per_run"] == 0
        for it in items:
            resolved.append(it.display)
            it.youtube = {"videoId": "vid-" + it.artist_norm.replace(" ", ""), "thumbnail": "https://i.ytimg.com/x.jpg", "title": it.title, "artists": [it.artist], "album": "LP", "playlistId": "OLAK", "year": "2013", "via": "search"}
    import discovery.resolve as resolve
    monkeypatch.setattr(resolve, "resolve_all", fake_resolve)
    cfg = {"station": {"lastfm_user": "u"}, "concerts": {"refresh_days": 2, "artists_per_run": 10}, "resolve": {"youtube_music": True}, "youtube_music": {"region": "US"}}

    out = concerts.build_concerts(cfg)
    assert out["count"] == 2 and out["radius_miles"] == 80 and out["center"]["name"] == "Detroit, MI"
    assert out["artists_total"] == 4 and out["artists_with_shows"] == 2 and out["sources"] == ["bandsintown", "ticketmaster"]
    first, second = out["events"]
    assert first["id"] == "bit:1" and first["date"] == SOON and first["artist"] == "Cut Copy" and first["artists"] == ["Cut Copy", "Jungle"]
    assert first["sources"] == ["bandsintown", "ticketmaster"] and first["links"] == {"bandsintown": "https://www.bandsintown.com/e/1", "ticketmaster": "https://www.ticketmaster.com/event/T2"} and first["miles"] < 1
    assert first["tickets"] == "https://tix.example/1" and first["ticketer"] is None
    assert second["id"] == "tm:T1" and second["artist"] == "Jungle" and second["price"]["min"] == 35 and second["venue"] == "Royal Oak Music Theatre" and second["ticketer"] == "Ticketmaster"
    assert "lat" in first and "festival" in first
    cc = out["artists"]["Cut Copy"]
    assert cc["plays"] == 143 and cc["top_track"]["title"] == "Best of Cut Copy" and cc["top_track"]["youtube"]["videoId"] == "vid-cutcopy"
    assert cc["top_track"]["id"] == util.item_key("Cut Copy", "Best of Cut Copy") and cc["image"] == "https://img.example/a.jpg" and cc["links"]["bandsintown"] == "https://www.bandsintown.com/a/Cut-Copy"
    assert out["artists"]["Jungle"]["top_track"]["youtube"]["videoId"] == "vid-jungle" and "bandsintown" not in out["artists"]["Jungle"]["links"]
    assert sorted(resolved) == ["Cut Copy - Best of Cut Copy", "Jungle - Best of Jungle"]
    assert out["health"]["ticketmaster"] == {"ok": True, "events": 3, "matched": 2}
    assert out["health"]["bandsintown"]["asked"] == 4 and out["health"]["bandsintown"]["failed"] == 2
    assert (sandbox / "site" / "data" / "concerts.json").exists()
    state = util.read_json(sandbox / "data" / "concerts_state.json", {})
    assert state["v"] == 1 and set(state["artists"]) >= {"cut copy", "jungle"} and "far away act" not in state["artists"]   # the failed ones are asked again
    assert state["artists"]["cut copy"]["top"]["title"] == "Best of Cut Copy" and len(state["artists"]["cut copy"]["events"]) == 1

    # the next run within refresh_days asks only for the artists that failed, and looks up no top song twice
    asked.clear(); resolved.clear()
    out2 = concerts.build_concerts(cfg)
    assert sorted(a.split("/artists/")[1].split("/")[0] for a in asked) == ["Far%20Away%20Act", "Parcels"]
    assert out2["count"] == 2 and sorted(resolved) == ["Cut Copy - Best of Cut Copy", "Jungle - Best of Jungle"]   # the resolver's own cache answers these
    assert out2["artists"]["Cut Copy"]["top_track"]["title"] == "Best of Cut Copy"

    # without the Ticketmaster key the list is Bandsintown's alone and says so
    monkeypatch.delenv("TICKETMASTER_API_KEY")
    out3 = concerts.build_concerts(cfg)
    assert out3["count"] == 1 and out3["sources"] == ["bandsintown"] and out3["health"]["ticketmaster"]["error"].startswith("TICKETMASTER_API_KEY")
    # switched off: nothing is built
    assert concerts.build_concerts({**cfg, "concerts": {"enabled": False}}) is None


def test_cli_runs_concerts(monkeypatch):
    from discovery import cli
    calls = []
    import discovery.concerts as c
    monkeypatch.setattr(c, "build_concerts", lambda cfg, deadline_minutes=None: calls.append("concerts" if deadline_minutes is None else f"concerts<{deadline_minutes:.0f}"))
    monkeypatch.setattr(cli, "load_config", lambda: {"profile": {}, "concerts": {}})
    monkeypatch.setattr(cli, "ensure_dirs", lambda: None)
    assert cli.main(["concerts"]) == 0 and calls == ["concerts"]
    import discovery.build as build
    import discovery.catalog as catalog
    import discovery.profile as profile
    monkeypatch.setattr(build, "build_feed", lambda cfg, budget_minutes=None: calls.append("build"))
    monkeypatch.setattr(catalog, "build_catalog", lambda cfg, deadline_minutes=None: calls.append("catalog"))
    monkeypatch.setattr(profile, "build_profile", lambda cfg, http: calls.append("profile"))
    monkeypatch.setattr(cli, "_profile_stale", lambda cfg: False)
    monkeypatch.setattr(cli, "read_json", lambda p, d: {"built_at": "x"})
    assert cli.main(["daily"]) == 0 and calls[-1] == "build"                       # its own workflow by default …
    monkeypatch.setattr(cli, "load_config", lambda: {"profile": {}, "concerts": {"in_daily": True}, "catalog": {"job_budget_minutes": 40}})
    assert cli.main(["daily"]) == 0 and calls[-1].startswith("concerts<")        # … or at the end of the daily job
