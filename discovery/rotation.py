"""Rotation: the same acts must not fill the feed day after day.

The curator rates nearly the whole day's list, so what decides variety is which songs make the day, not their
order. The artist watches (YouTube Music, Deezer, MusicBrainz) bring an act's whole recent catalogue on every run:
without a rotation an act you play with ten singles in three years puts three to five of them in one day's list, the
next few the day after, and so on until you have rated through them all. On 2026-10-12 a third of the day's acts had
three songs or more in it, and over the week before, 108 acts were in the list on three days or more.

So each act takes turns:
  * at most `per_artist` songs a day — its best by score; the rest wait for its next turn;
  * once you have rated one of its songs (data/ratings.json, timestamped by the site), its other songs wait
    `cooldown_days`, scaled by how its songs have fared with you: an act you keep twice as often as average comes
    back in half the time (never sooner than `min_scale`), one you mostly skip waits up to `max_scale` times as long.
    The keep rate is smoothed toward your overall rate (`prior` pseudo-ratings), so two skips are not a verdict.
  * a genuinely new release (dated within `new_release_days`) never waits: a favourite's new single is news today.

The freed places go to acts that have not had a turn lately — the older releases the artist watch found fill them
(build.fill_from_backfill), so the day keeps its size with more names in it. What waits is not lost: the sources and
caches bring it back on a later day, and if a day still runs short of `min_cards` the best waiting songs come back
early. An act is every name a credit splits into ("A & B" waits when A or B does), the way score.py matches acts.
Before resolution the waiting songs are only moved behind the rest (`defer`), so the day's lookups go to songs that
can join it, and the waiting ones are resolved with whatever budget is left.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime

from .models import Item
from .util import log, norm, split_artists

DEFAULTS = {"enabled": True, "per_artist": 2, "cooldown_days": 5.0, "min_scale": 0.5, "max_scale": 3.0, "prior": 4.0,
            "new_release_days": 14, "min_cards": 150}
DAY_MS = 86_400_000


def acts(artist: str | None) -> set[str]:
    """The acts a credit names: the whole credit, and each part of a strictly split collaboration ("A & B", "A feat.
    B"; never on "and" / "with" / "x"), one-letter fragments left out."""
    whole = norm(artist)
    out = {whole} if whole else set()
    for c in split_artists(artist, strict=True):
        cn = norm(c)
        if len(cn) > 1:
            out.add(cn)
    return out


@dataclass
class ActRecord:
    last_ms: int = 0       # the newest rating of any of its songs (epoch ms)
    up: int = 0
    down: int = 0


@dataclass
class Rotation:
    cfg: dict
    now_ms: int
    today: date
    base: float                                   # the overall keep rate the per-act rates are smoothed toward
    record: dict[str, ActRecord] = field(default_factory=dict)

    @classmethod
    def from_ratings(cls, cfg: dict, ratings: dict[str, dict], *, now: datetime | None = None) -> Rotation:
        c = {**DEFAULTS, **((cfg.get("rotation") or {}) if isinstance(cfg.get("rotation"), dict) else {})}
        now = now or datetime.now().astimezone()
        record: dict[str, ActRecord] = {}
        up = down = 0
        for r in ratings.values():
            d = r.get("decision")
            if d not in ("up", "down"):
                continue
            up += d == "up"
            down += d == "down"
            try:
                at = int(r.get("at") or 0)
            except (TypeError, ValueError):
                at = 0
            for a in acts(r.get("artist")):
                rec = record.setdefault(a, ActRecord())
                rec.last_ms = max(rec.last_ms, at)
                rec.up += d == "up"
                rec.down += d == "down"
        base = (up + 1.0) / (up + down + 2.0)
        return cls(cfg=c, now_ms=int(now.timestamp() * 1000), today=now.date(), base=base, record=record)

    @property
    def enabled(self) -> bool:
        return bool(self.cfg.get("enabled", True))

    def scale(self, rec: ActRecord) -> float:
        """How much longer (or shorter) than `cooldown_days` this act waits: the overall keep rate over its own."""
        prior = float(self.cfg["prior"])
        rate = (rec.up + prior * self.base) / (rec.up + rec.down + prior)
        return max(float(self.cfg["min_scale"]), min(float(self.cfg["max_scale"]), self.base / rate if rate > 0 else float(self.cfg["max_scale"])))

    def is_new(self, it: Item) -> bool:
        days = int(self.cfg.get("new_release_days") or 0)
        return bool(days and it.release_date and it.date_kind != "sighting" and 0 <= (self.today - it.release_date).days <= days)

    def wait_days(self, it: Item) -> float:
        """Days until this song's act is due again (0 = due now). A new release never waits."""
        if not self.enabled or self.is_new(it):
            return 0.0
        base = float(self.cfg["cooldown_days"])
        left = 0.0
        for a in acts(it.artist):
            rec = self.record.get(a)
            if not rec or not rec.last_ms:
                continue
            since = (self.now_ms - rec.last_ms) / DAY_MS
            left = max(left, base * self.scale(rec) - since)
        return round(max(0.0, left), 2)

    def defer(self, items: list[Item]) -> list[Item]:
        """Before resolution: the same items, those whose act is due first (each half in its own order), so the
        candidate slots and the lookup budget go to songs that can join the day."""
        if not self.enabled:
            return items
        due = [i for i in items if not self.wait_days(i)]
        return due + [i for i in items if self.wait_days(i)]

    def apply(self, items: list[Item]) -> tuple[list[Item], list[Item]]:
        """After resolution, on the day's playable items in score order: (what joins the day, what waits). Songs
        whose act is cooling down wait; of the rest each act keeps its best `per_artist` (a new release always
        counts against the quota but is never the one held back while an older song of the act takes its place)."""
        if not self.enabled:
            return items, []
        per = int(self.cfg.get("per_artist") or 0)
        ordered = sorted(items, key=lambda i: (not self.is_new(i), -i.score, i.artist_norm))
        taken: dict[str, int] = {}
        keep: list[Item] = []
        held: list[Item] = []
        for it in ordered:
            names = acts(it.artist) or {it.artist_norm}
            if self.wait_days(it) or (per and any(taken.get(a, 0) >= per for a in names)):
                held.append(it)
                continue
            for a in names:
                taken[a] = taken.get(a, 0) + 1
            keep.append(it)
        keep.sort(key=lambda i: (-i.score, i.artist_norm))
        held.sort(key=lambda i: (-i.score, i.artist_norm))
        return keep, held

    def top_up(self, items: list[Item], held: list[Item]) -> tuple[list[Item], list[Item]]:
        """A day short of `min_cards` takes the best waiting songs back (one per act first, then the rest), each
        with a reason saying so. Returns (the day, what still waits)."""
        need = int(self.cfg.get("min_cards") or 0) - len(items)
        if need <= 0 or not held:
            return items, held
        firsts: list[Item] = []
        rest: list[Item] = []
        seen: set[str] = {a for i in items for a in acts(i.artist)}
        for it in held:
            names = acts(it.artist) or {it.artist_norm}
            (rest if names & seen else firsts).append(it)
            seen |= names
        back = (firsts + rest)[:need]
        ids = {id(i) for i in back}
        for it in back:
            it.reasons.append("back early: a thin day")
        log.info("rotation: a thin day (%d cards, %d wanted): %d waiting songs come back early", len(items), len(items) + need, len(back))
        return items + back, [i for i in held if id(i) not in ids]

    def summary(self, held: list[Item]) -> dict:
        """What feed.json carries: how many songs and acts wait their turn, and the base cooldown."""
        names = {next(iter(sorted(acts(i.artist) or {i.artist_norm}))) for i in held}
        cooling = sum(1 for i in held if self.wait_days(i))
        return {"enabled": self.enabled, "waiting": len(held), "acts": len(names), "cooling": cooling, "over_quota": len(held) - cooling,
                "per_artist": int(self.cfg.get("per_artist") or 0), "cooldown_days": float(self.cfg["cooldown_days"])}
