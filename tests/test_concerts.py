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

    def post(self, url, json_body=None, **kw):
        self.calls.append((url, dict(json_body or {})))
        return self.answers(url, json_body or {})

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
    assert s["tickets"] == "https://www.ticketmaster.com/event/Z1" and s["price"] == {"min": 35.0, "max": 65.0, "currency": "USD", "source": "ticketmaster"}
    assert s["image"] == "https://img.example/wide.jpg" and s["status"] == "onsale"
    played = {"jungle": {"name": "Jungle", "plays": 80, "filed": 0}, "parcels": {"name": "Parcels", "plays": 200, "filed": 1}, "jungle brothers": {"name": "Jungle Brothers", "plays": 5, "filed": 0}}
    assert concerts.matched_artists(["Jungle", "Parcels", "Nobody"], played) == ["Parcels", "Jungle"]      # the most played first
    assert concerts.matched_artists(["Jungle Brothers"], played) == ["Jungle Brothers"]
    assert concerts.matched_artists(["Jungle Bros"], played) == []                                          # no fuzzy matching
    assert concerts.matched_artists(["Jungle [Live]", "Parcels (DJ set)", "Jungle Brothers - Live"], played) == ["Parcels", "Jungle", "Jungle Brothers"]   # the promoter's qualifier is not the name
    assert concerts.bill_names(["Amtrac [Live]", "Amtrac & The Juan Maclean", "", "Kevin Saunderson (b2b Derrick May)"]) == ["Amtrac [Live]", "Amtrac", "Amtrac & The Juan Maclean", "Kevin Saunderson (b2b Derrick May)", "Kevin Saunderson"]


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
    assert show["price"] == {"min": 30, "max": 50, "currency": "USD", "source": "ticketmaster"} and show["image"] == "https://img.example/wide.jpg"
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
    assert state["v"] == 2 and set(state["artists"]) >= {"cut copy", "jungle"} and "far away act" not in state["artists"]   # the failed ones are asked again
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


# ---------- the sources that see the clubs Ticketmaster never lists ----------

def sg_event(eid, performers, venue, city, state_code, lat, lon, when, *, low=None, status="normal", tbd=False):
    return {"id": eid, "title": f"{performers[0]} with friends", "short_title": performers[0], "datetime_local": f"{when}T21:00:00", "datetime_utc": f"{when}T01:00:00", "time_tbd": tbd,
            "url": f"https://seatgeek.com/e/{eid}", "type": "concert", "status": status, "taxonomies": [{"name": "concert"}],
            "performers": [{"name": p, "short_name": p, "primary": i == 0, "image": f"https://img.example/{i}.jpg"} for i, p in enumerate(performers)],
            "venue": {"name": venue, "city": city, "state": state_code, "country": "US", "location": {"lat": lat, "lon": lon}},
            "stats": {"lowest_price": low, "highest_price": low * 3 if low else None}}


def jb_event(eid, performers, venue, city, lat, lon, when, *, tickets="https://link.dice.fm/x", seller="DICE", status="scheduled", kind="Concert"):
    return {"@type": kind, "identifier": f"jambase:{eid}", "name": " / ".join(performers), "url": f"https://www.jambase.com/show/{eid}", "image": "https://img.example/jb.jpg",
            "startDate": f"{when}T20:00:00", "eventStatus": status,
            "performer": [{"@type": "MusicGroup", "name": p, "x-isHeadliner": i == 0, "x-performanceRank": i + 1} for i, p in enumerate(performers)],
            "location": {"@type": "MusicVenue", "name": venue, "address": {"streetAddress": "1331 Holden St", "addressLocality": city, "addressRegion": {"name": "Michigan", "identifier": "US-MI", "alternateName": "MI"},
                                                                          "addressCountry": {"name": "United States", "identifier": "US"}, "postalCode": "48202"}, "geo": {"latitude": lat, "longitude": lon}},
            "offers": [{"@type": "Offer", "name": "Tickets", "url": tickets, "seller": {"name": seller}, "validFrom": "2026-01-01T10:00:00", "price": 25}] if tickets else []}


def edm_event(eid, artists, venue, place, state, lat, lon, when, *, tickets="https://www.etix.com/ticket/p/1", festival=False, livestream=False):
    return {"id": eid, "link": f"https://edmtrain.com/detroit-mi?event={eid}", "ticketLink": tickets, "name": None, "ages": "18+", "festivalInd": festival, "livestreamInd": livestream,
            "electronicGenreInd": True, "otherGenreInd": False, "date": when, "startTime": "22:00:00", "createdDate": "2026-08-01T00:00:00Z",
            "venue": {"id": 5, "name": venue, "location": place, "address": "1331 Holden St", "state": state, "latitude": lat, "longitude": lon},
            "artistList": [{"id": i, "name": a, "link": f"https://edmtrain.com/artist/{i}", "b2bInd": False} for i, a in enumerate(artists)]}


def ra_event(eid, artists, title, venue, lat, lon, when, *, ticketed=True, address="1331 Holden St, Detroit, MI 48202"):
    return {"id": str(eid), "title": title, "date": f"{when}T00:00:00.000", "startTime": f"{when}T22:00:00.000", "endTime": None, "contentUrl": f"/events/{eid}", "flyerFront": "https://img.example/flyer.jpg",
            "isTicketed": ticketed, "isFestival": False,
            "venue": {"id": "232557", "name": venue, "address": address, "contentUrl": "/clubs/232557", "area": {"name": "Detroit", "country": {"name": "United States"}}, "location": {"latitude": lat, "longitude": lon}},
            "artists": [{"id": str(i), "name": a} for i, a in enumerate(artists)]}


def test_shape_seatgeek_and_paging():
    s = concerts.shape_seatgeek(sg_event(18137709, ["Amtrac", "Support Act"], "Lincoln Factory", "Detroit", "MI", 42.3647, -83.0763, LATER, low=28.0))
    assert s["id"] == "sg:18137709" and s["artist"] == "Amtrac" and s["lineup"] == ["Amtrac", "Support Act"] and s["date"] == LATER and s["time"] == "21:00"
    assert s["venue"] == "Lincoln Factory" and s["city"] == "Detroit" and s["region"] == "MI" and s["country"] == "US" and s["lat"] == 42.3647
    assert s["tickets"] == "https://seatgeek.com/e/18137709" and s["ticketer"] == "SeatGeek" and s["status"] is None and s["sources"] == ["seatgeek"]
    assert s["price"] == {"min": 28.0, "max": 84.0, "currency": "USD", "source": "seatgeek"} and s["image"] == "https://img.example/0.jpg" and s["festival"] is False
    s2 = concerts.shape_seatgeek(sg_event(2, ["X"], "V", "Detroit", "MI", 42.33, -83.05, SOON, status="cancelled", tbd=True))
    assert s2["status"] == "cancelled" and s2["time"] is None and s2["price"] is None
    pages = []
    def answers(url, params):
        assert url == concerts.SG_API and params["client_id"] == "cid" and params["range"] == "80mi" and params["lat"] == "42.3314" and params["sort"] == "datetime_utc.asc"
        assert params["datetime_utc.gte"] == "2026-09-11T17:00:00"
        pages.append((params["taxonomies.name"], int(params["page"])))
        n = int(params["page"])
        return {"events": [sg_event(f"{params['taxonomies.name']}-{n}", ["X"], "V", "Detroit", "MI", 42.33, -83.05, SOON)] if n <= 3 else [], "meta": {"total": 3 * 100 if params["taxonomies.name"] == "concert" else 1, "page": n, "per_page": 100}}
    http = FakeHttp(answers)
    evs = concerts.seatgeek_events(http, "cid", DETROIT, 80, start=T0, end=T1, per_page=100, taxonomies=["concert", "music_festival"])
    assert pages == [("concert", 1), ("concert", 2), ("concert", 3), ("music_festival", 1)] and len(evs) == 4
    # the request budget trims the far end
    http2 = FakeHttp(answers)
    assert len(concerts.seatgeek_events(http2, "cid", DETROIT, 80, start=T0, end=T1, per_page=100, max_requests=2, taxonomies=["concert"])) == 2


def test_shape_jambase_and_paging():
    s = concerts.shape_jambase(jb_event(16013248, ["Amtrac", "Opener"], "The Lincoln Factory", "Detroit", 42.3647, -83.0763, LATER))
    assert s["id"] == "jb:jambase:16013248" and s["artist"] == "Amtrac" and s["lineup"] == ["Amtrac", "Opener"] and s["date"] == LATER and s["time"] == "20:00"
    assert s["venue"] == "The Lincoln Factory" and s["city"] == "Detroit" and s["region"] == "MI" and s["country"] == "United States"
    assert s["tickets"] == "https://link.dice.fm/x" and s["ticketer"] == "DICE" and s["url"] == "https://www.jambase.com/show/16013248" and s["status"] is None
    assert s["price"] == {"min": 25.0, "max": None, "currency": "USD", "source": "jambase"} and s["links"] == {"jambase": "https://www.jambase.com/show/16013248"} and s["festival"] is False
    s2 = concerts.shape_jambase(jb_event(2, ["X"], "V", "Detroit", 42.33, -83.05, SOON, tickets="https://www.somebox.office/1", seller="Box office", status="postponed", kind="Festival"))
    assert s2["ticketer"] == "Box office" and s2["status"] == "postponed" and s2["festival"] is True and s2["price"] == {"min": 25.0, "max": None, "currency": "USD", "source": "jambase"}
    assert concerts._region_of("MI") == "MI" and concerts._region_of({"identifier": "US-OH"}) == "OH" and concerts._country_of("Canada") == "Canada"
    pages = []
    def answers(url, params):
        pages.append((url, int(params["page"])))
        assert params["geoRadiusAmount"] == "80" and params["geoRadiusUnits"] == "mi" and params["eventDateFrom"] == "2026-09-11" and params["perPage"] == "100"
        n = int(params["page"])
        return {"success": True, "pagination": {"page": n, "perPage": 100, "totalItems": 250, "totalPages": 3, "nextPage": "https://x" if n < 3 else None}, "events": [jb_event(n, ["X"], "V", "Detroit", 42.33, -83.05, SOON)]}
    http = FakeHttp(answers)
    evs = concerts.jambase_events(http, "key", DETROIT, 80, start=T0.date(), end=T1.date(), auth="bearer")
    assert [p for _, p in pages] == [1, 2, 3] and pages[0][0] == "https://api.data.jambase.com/v3/events" and len(evs) == 3 and "apikey" not in http.calls[0][1]
    http2 = FakeHttp(answers)
    concerts.jambase_events(http2, "key", DETROIT, 80, start=T0.date(), end=T1.date(), base_url=concerts.JB_V1, auth="query")
    assert http2.calls[0][0] == "https://www.jambase.com/jb-api/v1/events" and http2.calls[0][1]["apikey"] == "key"
    with pytest.raises(RuntimeError):
        concerts.jambase_events(FakeHttp(lambda u, p: {"success": False, "errors": [{"message": "invalid api key"}]}), "bad", DETROIT, 80, start=T0.date(), end=T1.date())


def test_shape_edmtrain_and_states():
    s = concerts.shape_edmtrain(edm_event(474768, ["Amtrac"], "Lincoln Factory", "Detroit, MI", "Michigan", 42.3647, -83.0763, LATER))
    assert s["id"] == "edm:474768" and s["artist"] == "Amtrac" and s["lineup"] == ["Amtrac"] and s["date"] == LATER and s["time"] == "22:00"
    assert s["venue"] == "Lincoln Factory" and s["city"] == "Detroit" and s["region"] == "MI" and s["country"] == "United States"
    assert s["tickets"] == "https://www.etix.com/ticket/p/1" and s["ticketer"] == "Etix" and s["url"] == "https://edmtrain.com/detroit-mi?event=474768" and s["links"] == {"edmtrain": "https://edmtrain.com/detroit-mi?event=474768"}
    s2 = concerts.shape_edmtrain(edm_event(2, ["X", "Y"], "Coda", "Toronto, ON", "Ontario", 43.66, -79.41, SOON, tickets=None, festival=True))
    assert s2["country"] == "Canada" and s2["festival"] is True and s2["tickets"] is None and s2["url"] == "https://edmtrain.com/detroit-mi?event=2"
    asked = []
    def answers(url, params):
        assert url == concerts.EDMTRAIN_API and params["client"] == "key" and params["livestreamInd"] == "false" and params["startDate"] == "2026-09-11"
        asked.append(params["state"])
        if params["state"] == "Ohio":
            raise RuntimeError("500 Server Error")
        return {"success": True, "data": [edm_event(f"{params['state']}-1", ["X"], "V", "Detroit, MI", params["state"], 42.33, -83.05, SOON),
                                          edm_event(f"{params['state']}-2", ["Y"], "Stream", "Online", params["state"], None, None, SOON, livestream=True)]}
    evs = concerts.edmtrain_events(FakeHttp(answers), "key", ["Michigan", "Ohio", "Ontario"], start=T0.date(), end=T1.date())
    assert asked == ["Michigan", "Ohio", "Ontario"] and [e["id"] for e in evs] == ["Michigan-1", "Ontario-1"]      # one state down is skipped; live streams never count
    with pytest.raises(RuntimeError):
        concerts.edmtrain_events(FakeHttp(lambda u, p: {"success": False, "message": "Invalid client"}), "bad", ["Michigan"], start=T0.date(), end=T1.date())


def test_resident_advisor_area_listings_and_shape():
    s = concerts.shape_ra(ra_event(2363529, ["Amtrac"], "Amtrac [Live]", "Lincoln Factory", 42.3647, -83.0763, LATER))
    assert s["id"] == "ra:2363529" and s["artist"] == "Amtrac" and s["lineup"] == ["Amtrac"] and s["title"] == "Amtrac [Live]" and s["date"] == LATER and s["time"] == "22:00"
    assert s["venue"] == "Lincoln Factory" and s["city"] == "Detroit" and s["region"] == "MI" and s["country"] == "United States" and s["lat"] == 42.3647
    assert s["tickets"] == "https://ra.co/events/2363529" and s["ticketer"] == "Resident Advisor" and s["links"] == {"resident advisor": "https://ra.co/events/2363529"} and s["image"] == "https://img.example/flyer.jpg"
    s2 = concerts.shape_ra(ra_event(3, [], "OBSERVE // SCENE", "Lincoln Factory", 42.36, -83.07, SOON, ticketed=False, address=""))
    assert s2["tickets"] is None and s2["ticketer"] is None and s2["url"] == "https://ra.co/events/3" and s2["artist"] == "OBSERVE // SCENE" and s2["city"] == "Detroit" and s2["region"] == ""
    calls = []
    def answers(url, body):
        assert url == concerts.RA_API
        calls.append(body["operationName"])
        if body["operationName"] == "GET_AREA":
            assert body["variables"] == {"areaUrlName": "detroit", "countryUrlCode": "us"}
            return {"data": {"area": {"id": "76", "name": "Detroit", "urlName": "detroit"}}}
        v = body["variables"]
        assert v["filters"]["areas"] == {"eq": 76} and v["filters"]["listingDate"]["gte"].startswith("2026-09-11T") and v["pageSize"] == 100
        n = v["page"]
        return {"data": {"eventListings": {"data": [{"id": f"l{n}", "listingDate": SOON, "event": ra_event(n, ["X"], "X", "V", 42.33, -83.05, SOON)}], "totalResults": 250}}}
    http = FakeHttp(answers)
    cfg = concerts._cfg({"concerts": {}})["resident_advisor"]
    area = concerts.ra_area(http, cfg)
    assert area == {"id": "76", "name": "Detroit", "country": "us", "city": "detroit"}
    evs = concerts.ra_events(http, cfg, area["id"], start=T0.date(), end=T1.date(), page_size=100)
    assert calls == ["GET_AREA", "GET_EVENT_LISTINGS", "GET_EVENT_LISTINGS", "GET_EVENT_LISTINGS"] and len(evs) == 3
    assert concerts.ra_area(FakeHttp(lambda u, b: {"data": {"area": None}}), cfg) is None
    with pytest.raises(RuntimeError, match="Cannot query field"):
        concerts.ra_events(FakeHttp(lambda u, b: {"errors": [{"message": "Cannot query field location"}]}), cfg, "76", start=T0.date(), end=T1.date())


def test_bandsintown_empty_for_everyone_is_a_refusal(monkeypatch):
    """A run whose first `empty_probe` answers (the most played artists first) list no show anywhere is Bandsintown
    answering empty to an app_id it did not issue, not a quiet year: the batch stops, nothing is recorded as
    checked (so the whole batch is asked again once the key is right), and the health record says so."""
    asked = []
    def answers(url, params):
        if "audioscrobbler" in url:
            if params["method"] == "user.gettopartists":
                return {"topartists": {"artist": [{"name": f"Act {i}", "playcount": str(100 - i)} for i in range(40)], "@attr": {"totalPages": "1"}}}
            return {}
        if "bandsintown" in url:
            asked.append(url)
            return []
        return {"_embedded": {"events": []}, "page": {"totalPages": 0, "totalElements": 0}}
    monkeypatch.setattr(concerts, "Http", lambda *a, **k: FakeHttp(answers))
    monkeypatch.setattr(concerts, "load_profile", lambda: {"artists": {}, "youtube": {"entries": []}})
    monkeypatch.setenv("LASTFM_API_KEY", "k"); monkeypatch.setenv("TICKETMASTER_API_KEY", "t"); monkeypatch.delenv("BANDSINTOWN_APP_ID", raising=False)
    for k in ("SEATGEEK_CLIENT_ID", "JAMBASE_API_KEY", "EDMTRAIN_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    import discovery.resolve as resolve
    monkeypatch.setattr(resolve, "resolve_all", lambda items, cfg, **k: None)
    cfg = {"station": {"lastfm_user": "u"}, "concerts": {"bandsintown": {"app_id": "nobody", "empty_probe": 8}, "resident_advisor": {"enabled": False}}, "resolve": {"youtube_music": False}}
    out = concerts.build_concerts(cfg)
    b = out["health"]["bandsintown"]
    assert len(asked) == 8 and b["asked"] == 8 and b["failed"] == 0 and b["listed"] == 0 and b["ok"] is False and b["answers"] == {"empty": 8}
    assert b["error"].startswith("every one of 8 answers was empty (empty ×8)") and "BANDSINTOWN_APP_ID secret not set" in b["error"] and b["checked"] == 0 and b["due"] == 40 and b["app_id_from"] == "fallback"
    assert out["health"]["seatgeek"] == {"ok": False, "error": "SEATGEEK_CLIENT_ID not set", "matched": 0} and "resident_advisor" not in out["health"]
    assert out["health"]["jambase"] == {"ok": False, "error": "JAMBASE_API_KEY not set", "matched": 0}
    state = util.read_json(concerts.STATE_PATH, {})
    assert state["v"] == 2 and state["artists"] == {} and state["sources"]["ticketmaster"]["events"] == []
    # a short batch (fewer answers than the probe) that stayed empty is recorded: too few to call it a refusal
    asked.clear()
    out2 = concerts.build_concerts({**cfg, "concerts": {**cfg["concerts"], "artists_per_run": 5}})
    assert len(asked) == 5 and out2["health"]["bandsintown"]["ok"] is True and out2["health"]["bandsintown"]["checked"] == 5
    # and one real listing among the first answers clears the probe for the run
    def answers2(url, params):
        if "bandsintown" in url and "/Act%203/" in url:
            return [bit_event("9", "Act 3", "Metro", "Chicago", "IL", 41.95, -87.66, SOON)]
        return answers(url, params)
    monkeypatch.setattr(concerts, "Http", lambda *a, **k: FakeHttp(answers2))
    util.write_json(concerts.STATE_PATH, {"v": 2, "artists": {}, "sources": {}})
    out3 = concerts.build_concerts(cfg)
    b3 = out3["health"]["bandsintown"]
    assert b3["asked"] == 40 and b3["listed"] == 1 and b3["ok"] is True and b3["answers"] == {"empty": 39, "listed": 1} and b3["checked"] == 40
    assert util.read_json(concerts.STATE_PATH, {})["artists"]["act 3"]["listed"] == 1


def test_not_found_for_everyone_is_the_same_refusal(monkeypatch):
    """Bandsintown answers "[NotFound] The artist was not found" for every artist to an app_id it has not approved:
    with a secret set, that is the key itself being refused, and the tally names the shape of the answers."""
    def answers(url, params):
        if "audioscrobbler" in url:
            return {"topartists": {"artist": [{"name": f"Act {i}", "playcount": str(50 - i)} for i in range(6)], "@attr": {"totalPages": "1"}}} if params["method"] == "user.gettopartists" else {}
        if "bandsintown" in url:
            return {"errorMessage": "[NotFound] The artist was not found"}
        return {"_embedded": {"events": []}, "page": {"totalPages": 0, "totalElements": 0}}
    monkeypatch.setattr(concerts, "Http", lambda *a, **k: FakeHttp(answers))
    monkeypatch.setattr(concerts, "load_profile", lambda: {"artists": {}, "youtube": {"entries": []}})
    monkeypatch.setenv("LASTFM_API_KEY", "k"); monkeypatch.setenv("BANDSINTOWN_APP_ID", "an-issued-looking-key")
    for k in ("TICKETMASTER_API_KEY", "SEATGEEK_CLIENT_ID", "JAMBASE_API_KEY", "EDMTRAIN_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    import discovery.resolve as resolve
    monkeypatch.setattr(resolve, "resolve_all", lambda items, cfg, **k: None)
    out = concerts.build_concerts({"station": {"lastfm_user": "u"}, "concerts": {"bandsintown": {"empty_probe": 3}, "resident_advisor": {"enabled": False}}, "resolve": {"youtube_music": False}})
    b = out["health"]["bandsintown"]
    assert b["ok"] is False and b["asked"] == 3 and b["answers"] == {"not found": 3} and b["app_id_from"] == "secret" and b["checked"] == 0
    assert b["error"].startswith("every one of 3 answers was empty (not found ×3)") and "biz@bandsintown.com" in b["error"]


def test_bandsintown_answers_are_tallied():
    def answers(url, params):
        if "Msg" in url:
            return {"warning": "Rate limit exceeded"}
        if "Unknown" in url:
            return {"errorMessage": "[NotFound] The artist was not found"}
        return []
    http = FakeHttp(answers)
    tally = concerts.Counter()
    assert concerts.bandsintown_events(http, "Msg Act", "app", None, tally) == []
    assert concerts.bandsintown_events(http, "Unknown Act", "app", None, tally) == []
    assert concerts.bandsintown_events(http, "Quiet Act", "app", None, tally) == []
    assert tally == {"message: Rate limit exceeded": 1, "not found": 1, "empty": 1}


def test_state_v1_migrates_its_ticketmaster_snapshot(sandbox):
    util.write_json(concerts.STATE_PATH, {"v": 1, "artists": {"x": {"name": "X", "checked_at": "2026-01-01", "events": [], "top": None}}, "ticketmaster": {"fetched_at": "2026-01-01", "events": [{"id": "tm:1"}]}})
    st = concerts._load_state()
    assert st["v"] == 2 and st["sources"]["ticketmaster"]["events"] == [{"id": "tm:1"}] and "ticketmaster" not in st and "x" in st["artists"]
    util.write_json(concerts.STATE_PATH, {"v": 0})
    assert concerts._load_state() == {"v": 2, "artists": {}, "sources": {}}


def test_merge_prefers_the_promoters_listing_and_the_most_played_headliner():
    played = {"amtrac": {"name": "Amtrac", "plays": 300, "filed": 2}, "opener": {"name": "Opener", "plays": 10, "filed": 0}}
    sg = {**concerts.shape_seatgeek(sg_event(1, ["Opener", "Amtrac"], "Lincoln Factory", "Detroit", "MI", 42.36, -83.07, LATER, low=30.0)), "artist": "Amtrac", "artists": ["Amtrac", "Opener"], "miles": 2.5}
    jb = {**concerts.shape_jambase(jb_event(2, ["Amtrac", "Opener"], "The Lincoln Factory", "Detroit", 42.36, -83.07, LATER)), "artist": "Amtrac", "artists": ["Amtrac", "Opener"], "miles": 2.5}
    ra = {**concerts.shape_ra(ra_event(3, ["Amtrac"], "Amtrac [Live]", "Lincoln Factory", 42.36, -83.07, LATER)), "artist": "Amtrac", "artists": ["Amtrac"], "miles": 2.5}
    edm = {**concerts.shape_edmtrain(edm_event(4, ["Amtrac"], "Lincoln Factory", "Detroit, MI", "Michigan", 42.36, -83.07, LATER, tickets=None)), "artist": "Amtrac", "artists": ["Amtrac"], "miles": 2.5}
    bit = {**concerts.shape_bandsintown(bit_event("5", "Opener", "Lincoln Factory", "Detroit", "MI", 42.36, -83.07, LATER, tickets=None, lineup=["Amtrac", "Opener"]), "Opener"), "artists": ["Opener", "Amtrac"], "miles": 2.5}
    out = concerts.merge_events([sg, jb, edm, ra, bit], played)
    assert len(out) == 1
    show = out[0]
    assert show["id"] == "bit:5" and show["artist"] == "Amtrac" and show["artists"] == ["Amtrac", "Opener"]          # the Bandsintown row leads, re-led by the most played act
    assert show["sources"] == ["bandsintown", "edmtrain", "jambase", "resident_advisor", "seatgeek"]
    assert show["tickets"] == "https://ra.co/events/3" and show["ticketer"] == "Resident Advisor"                     # the first ticket link in source order, not SeatGeek's resale
    assert show["price"] == {"min": 25.0, "max": None, "currency": "USD", "source": "jambase"} and show["image"] == "https://img.example/flyer.jpg"
    assert show["title"] == "Amtrac [Live]" and set(show["links"]) == {"bandsintown", "resident advisor", "jambase", "edmtrain", "seatgeek"}
    # without the Bandsintown row Resident Advisor's leads; alone, SeatGeek's own link and price stand
    assert concerts.merge_events([sg, jb, ra], played)[0]["id"] == "ra:3"
    alone = concerts.merge_events([sg], played)[0]
    assert alone["tickets"] == "https://seatgeek.com/e/1" and alone["price"]["source"] == "seatgeek" and alone["artist"] == "Amtrac"


def test_more_ticketers():
    assert concerts.ticketer_of("https://ra.co/events/2363529") == "Resident Advisor"
    assert concerts.ticketer_of("https://seatgeek.com/amtrac-tickets/x") == "SeatGeek"
    assert concerts.ticketer_of("https://posh.vip/e/amtrac") == "Posh" and concerts.ticketer_of("https://www.tickettailor.com/events/x") == "Ticket Tailor"
    assert concerts._time_of("2026-11-07T21:30:00") == "21:30" and concerts._time_of("9:00 PM") == "21:00" and concerts._time_of("12:15 AM") == "00:15" and concerts._time_of("tba") is None


def test_build_concerts_with_every_source(monkeypatch, sandbox):
    """One show at the Lincoln Factory that Ticketmaster never lists: SeatGeek, JamBase, Edmtrain and Resident
    Advisor each find it, Bandsintown is answering empty, and the tab gets one row with every link."""
    monkeypatch.setattr(concerts, "load_profile", lambda: {"artists": {}, "youtube": {"entries": []}, "saved": {}})
    for k, v in {"LASTFM_API_KEY": "key", "TICKETMASTER_API_KEY": "tm", "SEATGEEK_CLIENT_ID": "sg", "JAMBASE_API_KEY": "jb", "EDMTRAIN_API_KEY": "edm", "BANDSINTOWN_APP_ID": "issued"}.items():
        monkeypatch.setenv(k, v)
    def answers(url, params):
        if "audioscrobbler" in url:
            if params["method"] == "user.gettopartists":
                return {"topartists": {"artist": [{"name": "Amtrac", "playcount": "300"}, {"name": "Satin Jackets", "playcount": "200"}], "@attr": {"totalPages": "1"}}}
            return {"toptracks": {"track": [{"name": f"Best of {params['artist']}", "listeners": "1000", "playcount": "2000", "url": "https://www.last.fm/x"}]}}
        if "bandsintown" in url:
            return []
        if "ticketmaster" in url:
            return {"_embedded": {"events": [tm_event("T1", "Satin Jackets", ["Satin Jackets"], "El Club", "Detroit", "MI", 42.32, -83.08, SOON)]}, "page": {"totalPages": 1}}
        if url == concerts.SG_API:
            return {"events": [sg_event(1, ["Amtrac"], "Lincoln Factory", "Detroit", "MI", 42.36, -83.07, LATER, low=30.0)] if params["taxonomies.name"] == "concert" else [], "meta": {"total": 1}}
        if url.endswith("/v3/events"):
            return {"success": True, "pagination": {"totalPages": 1, "nextPage": None}, "events": [jb_event(2, ["Amtrac"], "The Lincoln Factory", "Detroit", 42.36, -83.07, LATER)]}
        if url == concerts.EDMTRAIN_API:
            return {"success": True, "data": [edm_event(4, ["Amtrac"], "Lincoln Factory", "Detroit, MI", "Michigan", 42.36, -83.07, LATER, tickets=None)] if params["state"] == "Michigan" else []}
        if url == concerts.RA_API:
            if params["operationName"] == "GET_AREA":
                return {"data": {"area": {"id": "76", "name": "Detroit"}}}
            return {"data": {"eventListings": {"data": [{"event": ra_event(3, ["Amtrac"], "Amtrac [Live]", "Lincoln Factory", 42.36, -83.07, LATER)}], "totalResults": 1}}}
        raise AssertionError(url)
    monkeypatch.setattr(concerts, "Http", lambda name, ttl_hours=20: FakeHttp(answers))
    import discovery.resolve as resolve
    monkeypatch.setattr(resolve, "resolve_all", lambda items, cfg, deadline=None, avoid=None: None)
    cfg = {"station": {"lastfm_user": "u"}, "concerts": {"bandsintown": {"empty_probe": 2}, "jambase": {"enabled": True}}, "resolve": {"youtube_music": False}}
    out = concerts.build_concerts(cfg)
    assert out["count"] == 2 and out["sources"] == ["edmtrain", "jambase", "resident_advisor", "seatgeek", "ticketmaster"]
    satin, amtrac = out["events"]
    assert satin["id"] == "tm:T1" and satin["sources"] == ["ticketmaster"]
    assert amtrac["id"] == "ra:3" and amtrac["artist"] == "Amtrac" and amtrac["sources"] == ["edmtrain", "jambase", "resident_advisor", "seatgeek"] and amtrac["date"] == LATER
    assert amtrac["tickets"] == "https://ra.co/events/3" and amtrac["ticketer"] == "Resident Advisor" and amtrac["price"]["source"] == "jambase" and amtrac["venue"] == "Lincoln Factory"
    assert set(amtrac["links"]) == {"resident advisor", "jambase", "edmtrain", "seatgeek"} and amtrac["title"] == "Amtrac [Live]"
    h = out["health"]
    assert h["seatgeek"] == {"ok": True, "events": 1, "matched": 1} and h["edmtrain"] == {"ok": True, "events": 1, "matched": 1}
    jb = h["jambase"]   # three bands (45, 120, 180 days: the Developer tier's six months, not the tab's year), one call each, the same fake event in every one, folded to one row
    assert jb["ok"] is True and jb["calls"] == 3 and jb["matched"] == 3 and jb["quota"] == {"calls": 3, "used": 3, "window_days": 31, "quota": 1000, "reserve": 100, "remaining": 897}
    assert [(b["from"], b["to"], b["refresh_days"], b["complete"], b["calls"]) for b in jb["bands"]] == [(TODAY.isoformat(), (TODAY + timedelta(days=45)).isoformat(), 2.0, True, 1),
        ((TODAY + timedelta(days=46)).isoformat(), (TODAY + timedelta(days=120)).isoformat(), 5.0, True, 1), ((TODAY + timedelta(days=121)).isoformat(), (TODAY + timedelta(days=180)).isoformat(), 10.0, True, 1)]
    assert jb["planned_calls_per_month"] == 24   # 1 page × (30/2 + 30/5 + 30/10)
    assert h["resident_advisor"] == {"ok": True, "events": 1, "matched": 1} and h["ticketmaster"] == {"ok": True, "events": 1, "matched": 1}
    assert h["bandsintown"]["ok"] is False and h["bandsintown"]["error"].startswith("every one of 2 answers was empty (empty ×2)") and h["bandsintown"]["app_id_from"] == "secret"
    assert "from the BANDSINTOWN_APP_ID secret" in h["bandsintown"]["error"] and "biz@bandsintown.com" in h["bandsintown"]["error"]   # the secret is set: the key itself is what Bandsintown refuses
    state = util.read_json(concerts.STATE_PATH, {})
    assert state["ra_area"]["id"] == "76" and set(state["sources"]) == {"ticketmaster", "seatgeek", "jambase", "edmtrain", "resident_advisor"}
    assert out["artists"]["Amtrac"]["top_track"]["title"] == "Best of Amtrac"
    # a source that fails keeps its last snapshot and says why; the area id is remembered
    def answers2(url, params):
        if url == concerts.RA_API:
            assert params["operationName"] == "GET_EVENT_LISTINGS"
            raise RuntimeError("403 Client Error: Forbidden")
        if url.endswith("/v3/events"):
            raise RuntimeError("401 Client Error: Unauthorized")
        return answers(url, params)
    monkeypatch.setattr(concerts, "Http", lambda name, ttl_hours=20: FakeHttp(answers2))
    due_now = {**cfg, "concerts": {**cfg["concerts"], "jambase": {"enabled": True, "bands": [{"days": 45, "refresh_days": 0}, {"days": 365, "refresh_days": 0}]}}}
    out2 = concerts.build_concerts(due_now)
    assert out2["count"] == 2 and out2["health"]["resident_advisor"] == {"ok": False, "error": "403 Client Error: Forbidden", "matched": 1}
    jb2 = out2["health"]["jambase"]
    assert jb2["ok"] is False and jb2["matched"] == 1 and jb2["error"].count("401") == 2 and out2["events"][1]["sources"] == ["edmtrain", "jambase", "resident_advisor", "seatgeek"]
    assert jb2["quota"]["calls"] == 2 and jb2["quota"]["used"] == 5 and [b["error"] for b in jb2["bands"]] == ["401 Client Error: Unauthorized"] * 2   # a failed request is a call too; the rows are kept
    # back on three bands: the two still fresh are not asked again, only the far band (new again) costs a call
    monkeypatch.setattr(concerts, "Http", lambda name, ttl_hours=20: FakeHttp(answers))
    out3 = concerts.build_concerts(cfg)
    jb3 = out3["health"]["jambase"]
    assert jb3["ok"] is True and jb3["calls"] == 1 and [b["calls"] for b in jb3["bands"]] == [0, 0, 1] and jb3["quota"]["used"] == 6 and all(b["complete"] for b in jb3["bands"])
    assert out3["events"][1]["sources"] == ["edmtrain", "jambase", "resident_advisor", "seatgeek"]
    assert util.read_json(concerts.STATE_PATH, {})["quota"]["jambase"]["days"] == {TODAY.isoformat(): 6}


def test_call_quota_holds_any_31_day_window():
    """The ledger caps the trailing 31 days at quota - reserve, whatever month boundary the plan counts by, and
    every attempt counts before it goes out."""
    row = {"days": {(TODAY - timedelta(days=d)).isoformat(): n for d, n in ((50, 500), (31, 100), (30, 300), (1, 200))}}
    q = concerts.CallQuota(row, quota=1000, reserve=100, today=TODAY)
    assert set(row["days"]) == {(TODAY - timedelta(days=d)).isoformat() for d in (31, 30, 1)}     # older than 45 days is dropped
    assert q.used == 500 and q.remaining == 400                                                   # today and the 30 days before it: 300 + 200
    for _ in range(400):
        assert q.spend()
    assert not q.spend() and q.spent == 400 and q.remaining == 0 and row["days"][TODAY.isoformat()] == 400
    assert q.health() == {"calls": 400, "used": 900, "window_days": 31, "quota": 1000, "reserve": 100, "remaining": 0}
    # tomorrow the day that fell out of the window frees its calls
    q2 = concerts.CallQuota(row, quota=1000, reserve=100, today=TODAY + timedelta(days=1))
    assert q2.used == 600 and q2.remaining == 300
    assert concerts.CallQuota({}, quota=5, today=TODAY).remaining == 5


def test_jambase_paging_stops_at_the_quota_and_never_retries():
    calls = []
    def answers(url, params):
        calls.append(int(params["page"]))
        return {"success": True, "pagination": {"page": int(params["page"]), "totalPages": 50, "nextPage": "https://x"}, "events": [jb_event(params["page"], ["X"], "V", "Detroit", 42.33, -83.05, SOON)]}
    http = FakeHttp(answers)
    class Recording(FakeHttp):
        def get(self, url, params=None, **kw):
            assert kw.get("retries") == 0            # a retry would be a charged call
            return super().get(url, params, **kw)
    http = Recording(answers)
    q = concerts.CallQuota({"days": {}}, quota=10, reserve=7, today=TODAY)
    evs = concerts.jambase_events(http, "key", DETROIT, 80, start=T0.date(), end=T1.date(), max_requests=40, quota=q)
    assert calls == [1, 2, 3] and len(evs) == 3 and q.spent == 3 and q.remaining == 0     # the soonest three pages, then the quota
    with pytest.raises(RuntimeError, match="monthly quota reached"):
        concerts.jambase_events(http, "key", DETROIT, 80, start=T0.date(), end=T1.date(), quota=q)
    assert calls == [1, 2, 3]                                                             # nothing more went out
    # a failed request was still a call
    q3 = concerts.CallQuota({"days": {}}, quota=10, today=TODAY)
    with pytest.raises(RuntimeError):
        concerts.jambase_events(FakeHttp(lambda u, p: (_ for _ in ()).throw(RuntimeError("500 Server Error"))), "key", DETROIT, 80, start=T0.date(), end=T1.date(), quota=q3)
    assert q3.spent == 1 and q3.used == 1


def test_jambase_bands_cover_the_horizon_back_to_back():
    cfg = {"bands": [{"days": 45, "refresh_days": 2}, {"days": 120, "refresh_days": 5}, {"days": 365, "refresh_days": 10}]}
    spans = concerts.jambase_bands(cfg, TODAY, 360)
    assert [(s["from"], s["to"], s["refresh_days"]) for s in spans] == [
        (TODAY.isoformat(), (TODAY + timedelta(days=45)).isoformat(), 2.0), ((TODAY + timedelta(days=46)).isoformat(), (TODAY + timedelta(days=120)).isoformat(), 5.0),
        ((TODAY + timedelta(days=121)).isoformat(), (TODAY + timedelta(days=360)).isoformat(), 10.0)]                 # the last band clipped to the horizon
    short = concerts.jambase_bands(cfg, TODAY, 30)
    assert len(short) == 1 and short[0]["to"] == (TODAY + timedelta(days=30)).isoformat()
    tail = concerts.jambase_bands({"bands": [{"days": 10, "refresh_days": 1}]}, TODAY, 100)                           # bands that stop short: the rest is one more band at the last cadence
    assert [(s["from"], s["to"], s["refresh_days"]) for s in tail] == [(TODAY.isoformat(), (TODAY + timedelta(days=10)).isoformat(), 1.0), ((TODAY + timedelta(days=11)).isoformat(), (TODAY + timedelta(days=100)).isoformat(), 1.0)]
    assert concerts.jambase_bands({"bands": []}, TODAY, 60) == [{"from": TODAY.isoformat(), "to": (TODAY + timedelta(days=60)).isoformat(), "refresh_days": 2.0}]


def test_jambase_source_walks_the_bands_with_a_cursor(monkeypatch):
    """A cap smaller than a band's pages: the band is fetched as far as the cap allows, keeps a date cursor and its
    older rows past it, and the next run continues from the cursor; the far bands wait their turn (deferred) and
    are fetched once the near one is complete; fresh bands cost nothing."""
    played = {"amtrac": {"name": "Amtrac", "plays": 300, "filed": 0}}
    # band 0 (45 days): 250 events, 3 pages; band 1: 1 page; band 2: 1 page — one played show a page
    def answers(url, params):
        lo, hi, page = date.fromisoformat(params["eventDateFrom"]), date.fromisoformat(params["eventDateTo"]), int(params["page"])
        days = (hi - lo).days + 1
        n = 250 if days > 40 and lo == TODAY else (50 if hi == TODAY + timedelta(days=45) else 100)   # the near band: 250 events; continued from a cursor, the 50 left
        pages = -(-n // 100)
        first = lo + timedelta(days=min(days - 1, (page - 1) * 10))
        evs = [jb_event(f"{lo}-{page}-{i}", ["Amtrac" if i == 0 else "Nobody"], "Lincoln Factory", "Detroit", 42.36, -83.07, (first + timedelta(days=min(days - 1, i // 10))).isoformat())
               for i in range(min(100, n - (page - 1) * 100))]
        return {"success": True, "pagination": {"page": page, "totalPages": pages, "totalItems": n, "nextPage": "https://x" if page < pages else None}, "events": evs}
    http = FakeHttp(answers)
    state = {"v": 2, "artists": {}, "sources": {}, "quota": {"jambase": {}}}
    jcfg = {**concerts.DEFAULTS["jambase"], "requests_per_run": 2, "max_days_ahead": 365, "bands": [{"days": 45, "refresh_days": 2}, {"days": 120, "refresh_days": 5}, {"days": 365, "refresh_days": 10}]}
    def run():
        health = {}
        quota = concerts.CallQuota(state["quota"]["jambase"], quota=1000, reserve=100, today=TODAY)
        concerts._jambase_source(state, health, jcfg, "key", http, quota, center=DETROIT, radius=80, played=played, today=TODAY, horizon_days=360)
        return health["jambase"]
    h1 = run()
    b0, b1, b2 = h1["bands"]
    assert h1["calls"] == 2 and b0["complete"] is False and b0["cursor"] and b0["calls"] == 2 and b0["pages"] == 3 and b0["matched"] == 2 and h1["planned_calls_per_month"] == 45
    assert b1["deferred"] == "request budget spent" and b2["deferred"] == "request budget spent" and h1["ok"] is True and h1["matched"] == 2
    cursor = b0["cursor"]
    h2 = run()
    b0, b1, b2 = h2["bands"]
    assert b0["complete"] is True and b0["cursor"] is None and b0["calls"] >= 1 and b0["fetched_at"] and b0["matched"] == 3      # continued from the cursor: the third page joined the first two
    assert http.calls[-2][1]["eventDateFrom"] == cursor or http.calls[-1][1]["eventDateFrom"] == cursor
    assert b1["complete"] is True and b1["calls"] == 1 and b2["deferred"] == "request budget spent"
    h3 = run()
    assert h3["calls"] == 1 and h3["bands"][2]["complete"] and all(b["complete"] for b in h3["bands"]) and h3["matched"] == 5
    h4 = run()
    assert h4["calls"] == 0 and h4["ok"] is True and h4["quota"]["used"] == 5 and h4["planned_calls_per_month"] == 45 + 6 + 3     # a full pass of band 0 costs 3 calls every 2 days, 1/5, 1/10
    assert state["sources"]["jambase"]["listed"] == 450 and len(state["sources"]["jambase"]["events"]) == 5
    # the quota ledger stops a run cold and the band says so
    state["quota"]["jambase"]["days"] = {TODAY.isoformat(): 900}
    jcfg["bands"] = [{"days": 365, "refresh_days": 0}]
    h5 = run()
    assert h5["calls"] == 0 and h5["bands"][0]["deferred"] == "monthly quota reached" and h5["quota"]["remaining"] == 0 and h5["matched"] == 3   # the one band left keeps its rows
