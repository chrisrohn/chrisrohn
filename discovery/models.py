"""Data model for a discovered item (a track or release)."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import date
from typing import Any

from .util import item_key, norm, norm_track


@dataclass
class Item:
    artist: str
    title: str                       # track title, or release title if `kind == "release"`
    kind: str = "track"              # "track" | "release"
    release: str | None = None       # album/EP name when known
    release_type: str | None = None  # Album / EP / Single
    release_date: date | None = None
    tags: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    links: dict[str, str] = field(default_factory=dict)   # {"bandcamp": url, "musicbrainz": url, ...}
    artwork: str | None = None
    artist_mbids: list[str] = field(default_factory=list)
    listen_count: int = 0
    editorial: bool = False          # surfaced by a curated human feed
    blurb: str | None = None
    # filled in by resolve/score
    youtube: dict[str, Any] | None = None
    score: float = 0.0
    reasons: list[str] = field(default_factory=list)
    matched_artist: str | None = None
    match_kind: str | None = None    # "direct" | "similar" | None

    @property
    def key(self) -> str:
        return item_key(self.artist, self.title)

    @property
    def artist_norm(self) -> str:
        return norm(self.artist)

    @property
    def title_norm(self) -> str:
        return norm_track(self.title)

    def merge(self, other: "Item") -> None:
        """Fold another sighting of the same item into this one."""
        for s in other.sources:
            if s not in self.sources:
                self.sources.append(s)
        for t in other.tags:
            if t not in self.tags:
                self.tags.append(t)
        for k, v in other.links.items():
            self.links.setdefault(k, v)
        for m in other.artist_mbids:
            if m not in self.artist_mbids:
                self.artist_mbids.append(m)
        self.artwork = self.artwork or other.artwork
        self.release = self.release or other.release
        self.release_type = self.release_type or other.release_type
        self.blurb = self.blurb or other.blurb
        self.editorial = self.editorial or other.editorial
        self.listen_count = max(self.listen_count, other.listen_count)
        if other.release_date and (not self.release_date or other.release_date > self.release_date):
            self.release_date = other.release_date
        if self.kind == "release" and other.kind == "track":
            self.kind = "track"
            self.title = other.title

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["id"] = self.key
        d["release_date"] = self.release_date.isoformat() if self.release_date else None
        d["score"] = round(self.score, 3)
        return d
