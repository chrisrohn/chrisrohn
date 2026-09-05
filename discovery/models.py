"""Data model for a discovered item (a track or release)."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import date
from typing import Any

from .util import format_credit, format_title, item_key, norm, norm_track, parse_credit


@dataclass
class Item:
    artist: str
    title: str                       # track title, or release title if `kind == "release"`
    kind: str = "track"              # "track" | "release"
    featuring: list[str] = field(default_factory=list)   # Rohn Standard Notation parts (see util.parse_credit)
    remixer: str | None = None
    remix_kind: str | None = None
    release: str | None = None       # album/EP name when known
    release_type: str | None = None  # Album / EP / Single
    release_date: date | None = None
    date_kind: str = "release"       # "release" = the source states the release date; "sighting" = post/upload/airplay date
    tags: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    links: dict[str, str] = field(default_factory=dict)   # {"bandcamp": url, "musicbrainz": url, ...}
    artwork: str | None = None
    artist_mbids: list[str] = field(default_factory=list)
    listen_count: int = 0
    editorial: bool = False          # surfaced by a curated human feed
    blurb: str | None = None
    # filled in by resolve/score
    year: int | None = None                 # best year for filing into "<year> | Indie Discotheque"
    year_source: str | None = None          # "musicbrainz-recording" | "release-date" | "youtube" | "feed-date" | "unknown"
    year_confidence: str | None = None      # "high" | "medium" | "low"
    year_evidence: list[str] = field(default_factory=list)   # every year the catalogues reported, e.g. "MusicBrainz recording: 2009"
    original_year: int | None = None        # set when MusicBrainz knows an earlier release than the feed date (reissue)
    youtube: dict[str, Any] | None = None
    score: float = 0.0
    reasons: list[str] = field(default_factory=list)
    matched_artist: str | None = None
    match_kind: str | None = None    # "direct" | "similar" | None

    def normalize_credit(self) -> "Item":
        """Apply Rohn Standard Notation: pull feat./remix info out of raw artist + title into fields."""
        p = parse_credit(self.artist, self.title)
        if p["artist"]:
            self.artist = p["artist"]
        self.title = p["title"] or self.title
        for f in p["featuring"]:
            if f.lower() not in {x.lower() for x in self.featuring}:
                self.featuring.append(f)
        self.remixer = self.remixer or p["remixer"]
        self.remix_kind = self.remix_kind or p["remix_kind"]
        return self

    @property
    def display_title(self) -> str:
        return format_title(self.title, self.featuring, self.remixer, self.remix_kind)

    @property
    def display(self) -> str:
        return format_credit(self.artist, self.title, self.featuring, self.remixer, self.remix_kind)

    @property
    def key(self) -> str:
        # featured-artist spelling must not split duplicates, but a remix is a different track
        return item_key(self.artist, format_title(self.title, None, self.remixer, self.remix_kind))

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
        # a real release date always beats a blog-post / upload sighting date; among equals keep the newest
        if other.release_date and (not self.release_date or (other.date_kind == "release" and self.date_kind != "release")
                                   or (other.date_kind == self.date_kind and other.release_date > self.release_date)):
            self.release_date, self.date_kind = other.release_date, other.date_kind
        for f in other.featuring:
            if f.lower() not in {x.lower() for x in self.featuring}:
                self.featuring.append(f)
        self.remixer = self.remixer or other.remixer
        self.remix_kind = self.remix_kind or other.remix_kind
        if self.kind == "release" and other.kind == "track":
            self.kind = "track"
            self.title = other.title

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["id"] = self.key
        d["display_title"] = self.display_title
        d["display"] = self.display
        d["release_date"] = self.release_date.isoformat() if self.release_date else None
        d["score"] = round(self.score, 3)
        return d
