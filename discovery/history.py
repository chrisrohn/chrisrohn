"""The station's whole Last.fm history as a taste signal: how often Indie Discotheque has played each act, ever.

data/catalog_history.json (the Catalog workflow's snapshot of user.getTopTracks over `overall`: one row a track,
[artist, title, plays, loved], back to the first scrobble in 2012) is folded into plays per act. Scoring reads it
(score.py: a bonus that grows with the act's all-time plays, a penalty for an act the station has never played),
and the profile adds every act played often enough as one you play (profile.py), so the artist watches cover the
whole history and not only the recent top of it.

Why: of 10,107 rated cards (2026-09-04 → 2026-11-02), acts the station had never played were kept 7% of the time
— 2% when only a tag or a source vouched for them, 3% as a similar artist — against 26–37% for acts it had played,
rising with their plays. A quarter of every day went to them.

Collaboration credits count for each named act the station also plays on its own ("A & B" plays count for A and for
B, split only on the separators a credit really uses), so a featured guest's own songs are not "never played"; a
name that only ever appears whole ("Kraak & Smaak", "TR/ST") stays one act."""
from __future__ import annotations

import math
from collections import defaultdict

from . import util
from .util import log, norm, norm_track, read_json, split_artists

HISTORY_FILE = "catalog_history.json"


class StationHistory:
    """All-time plays per act (and per song) from the play-history snapshot. Empty when there is no snapshot, and an
    empty history has no opinion: nothing is penalised for lack of evidence."""

    def __init__(self, rows: list | None = None, *, reference: int = 500):
        self.plays: dict[str, int] = defaultdict(int)
        self.tracks: dict[str, int] = defaultdict(int)
        self.loved: dict[str, int] = defaultdict(int)
        self.names: dict[str, str] = {}
        self.songs: dict[tuple[str, str], int] = {}
        self.reference = max(2, int(reference or 500))
        parsed: list[tuple[str, str, int, bool, str, list[tuple[str, str]]]] = []
        solo: set[str] = set()          # acts credited on their own somewhere in the history
        for r in rows or []:
            if not isinstance(r, (list, tuple)) or len(r) < 3:
                continue
            artist, title = str(r[0] or ""), str(r[1] or "")
            try:
                p = int(r[2] or 0)
            except (TypeError, ValueError):
                continue
            whole = norm(artist)
            if not whole:
                continue
            parts = [(n, c) for c in split_artists(artist, strict=True) if len(n := norm(c)) > 1 and n != whole]
            if len(parts) < 2:
                parts = []
                solo.add(whole)
            parsed.append((artist, title, p, bool(r[3]) if len(r) > 3 else False, whole, parts))
        for artist, title, p, loved, whole, parts in parsed:
            # a collaboration ("A & B", "A feat. B") also counts for each act it names that the station plays on its
            # own; a name that only ever appears inside the credit ("Kraak & Smaak", "TR/ST") is one act, not two
            acts = [n for n, _ in parts if n in solo]
            for n in {whole, *acts}:
                self.plays[n] += p
                self.tracks[n] += 1
                self.loved[n] += loved
            if not acts:
                self.names.setdefault(whole, artist)
            key = (whole, norm_track(title))
            self.songs[key] = self.songs.get(key, 0) + p
        self.plays, self.tracks, self.loved = dict(self.plays), dict(self.tracks), dict(self.loved)

    @classmethod
    def load(cls, path=None, *, reference: int = 500) -> StationHistory:
        data = read_json(path or (util.DATA_DIR / HISTORY_FILE), {}) or {}
        rows = data.get("rows") if isinstance(data, dict) else None
        h = cls(rows if isinstance(rows, list) else [], reference=reference)
        if h:
            log.info("station history: %d acts, %d plays in all, from %d tracks", len(h.plays), sum(h.plays[n] for n in h.names), len(h.songs))
        return h

    def __bool__(self) -> bool:
        return bool(self.plays)

    def artist_plays(self, artist: str | None) -> int:
        """All-time plays of an act, or of the best-played act named in a collaboration credit."""
        whole = norm(artist)
        best = self.plays.get(whole, 0)
        for c in split_artists(artist, strict=True):
            n = norm(c)
            if len(n) > 1 and n != whole:
                best = max(best, self.plays.get(n, 0))
        return best

    def song_plays(self, artist: str | None, title: str | None) -> int:
        return self.songs.get((norm(artist), norm_track(title)), 0)

    def relevance(self, plays: int) -> float:
        """0 for never played, about 0.25 for a few plays, 1.0 at `reference` plays and a little more beyond (capped
        at 1.25): log-scaled, because the jump that matters is from never to sometimes."""
        if plays <= 0:
            return 0.0
        return round(min(1.25, math.log10(plays + 1) / math.log10(self.reference + 1)), 4)

    def top_artists(self, min_plays: int) -> list[tuple[str, int]]:
        """(display name, plays) for every act with at least `min_plays` plays (its collaborations included), most
        played first. A collaboration of acts the station plays on their own is not an act itself."""
        out = [(self.names[n], self.plays[n]) for n in self.names if self.plays.get(n, 0) >= min_plays]
        out.sort(key=lambda x: (-x[1], norm(x[0])))
        return out
