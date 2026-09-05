"""Blog and radio headlines → (artist, track) — or nothing.

A music blog's RSS is mostly news: tour dates, interviews, listicles, obituaries, festival photos. Only two shapes
become cards here:

  1. `Artist – "Song"` (or `Artist - Song`, `Artist :: Song`): the post *is* the track.
  2. `Artist shares new single "Song"`: the artist opens the headline and a quoted title follows a release cue.

Everything else is dropped, however many known artist names the headline happens to mention. A headline that reads
like news (see NEWS) is dropped before either shape is tried, and a "title" with the shape of a sentence or a
paragraph never becomes a song.
"""
from __future__ import annotations

import re

from .util import norm, parse_artist_title

PREFIX = re.compile(r"^(?:new music|listen|premiere|watch|stream|hear|video|track review|song of the day|first listen|exclusive)\s*[:\-–—|]\s*", re.I)
NEWS = re.compile(
    r"\b(?:best (?:new )?(?:songs?|albums?|tracks?|music)|(?:songs?|albums?|tracks?|music) of the (?:week|month|year)|(?:weekly )?round-?up|gig guide|"
    r"tour(?: dates?)?|dates announced|announces? (?:a |an )?(?:tour|shows?|gigs?|dates|.* show)|line-?up|festival|lollapalooza|glastonbury|coachella|"
    r"pics|photos|in pictures|interview|in conversation|talks|q&a|reviews?|live review|ranked|podcast|playlist|mixtape|the cover mix|mixed by|dj set|"
    r"dies|dead|death|died|passed away|r\.?i\.?p\.?|obituary|arrested|lawsuit|sues?|sued|suspended|cancel(?:s|led|ed)?|hospital|cancer|statement|"
    r"competency|reissue|vinyl|anniversary|listening (?:event|party)|tickets?|reopen|rebrand|ownership|shooting|injured|police|drugs|weather|"
    r"celebrates?|defends?|reveals?|brings? out|performs? (?:at|with)|live (?:at|from|in)|joins|teams? up|reunites?|to play|playing (?:the|at)|"
    r"show at|second (?:show|night|date)|due to demand|support acts?|diss track|apparent|allegedly|amid|dispute|ordered to|turns \d+|years? (?:old|ago|behind)|"
    r"revisits?|reshapes?|honou?rs|in motion|comeback|evolution|the moment before|confronts|exits|flirts|makes? (?:himself|herself|themselves)|"
    r"heals|essay|roundtable|trail|weekend|this (?:october|november|december|january|february|march|april|may|june|july|august|september)|"
    r"one-off|add(?:s|ed)? (?:second|another|extra)|for next summer)\b", re.I)
# a post that is about a song: the quoted title after one of these is the track
SONG_CUE = re.compile(r"\b(?:shares?|sharing|releases?|drops?|unveils?|premieres?|debuts?|delivers?|offers?|returns? with|new (?:song|single|track|video|music|cut|remix)|(?:song|single|track|video|remix)|listen(?: to)?|stream|watch|hear|out now)\b", re.I)
# what an artist does in a headline that is about their music: "M83 Shares …", "Fontaines D.C. announce …"
VERB = re.compile(r"^(?:shares?|sharing|shared|announces?|announced|drops?|dropped|releases?|released|unveils?|premieres?|debuts?|returns?|delivers?|offers?|previews?|performs?|covers|remixes|teases|is|are|has|have|goes|go)\b")
RELEASE_CUE = re.compile(r"\b(?:new (?:album|ep|lp|record|mixtape)|(?:album|ep|lp))\b", re.I)
# real quotation marks, or a straight-quoted run that stands on its own (never the apostrophe in "It's")
QUOTED = re.compile(r"[\"“„]([^\"“”„]{1,80})[\"”]|(?<![\w’'])[‘']([^‘’']{1,80})[’'](?![\w’'])")
TITLE_MAX_WORDS = 10
ARTIST_MAX_WORDS = 5


def looks_like_news(text: str) -> bool:
    return bool(NEWS.search(text or ""))


def _clean_title(t: str) -> str:
    t = t.strip(" \"“”‘’',.;:-–—")
    return re.sub(r"\s+", " ", t)


def _plausible_pair(artist: str, track: str) -> bool:
    if len(artist.split()) > ARTIST_MAX_WORDS or len(track.split()) > TITLE_MAX_WORDS:
        return False
    if re.search(r"\w[’']s\s+\w", artist):          # "Wheel of Fortune's Jim Thornton …" is a sentence, not an act
        return False
    if looks_like_news(artist) or looks_like_news(track):
        return False
    # a sentence with a subject and a verb ("We want proper time to reset") is a pull quote, not a song
    return not (re.match(r"^(?:i|we|you|they|he|she|it)\b\s+\w+", track, re.I) and len(track.split()) > 5)


def headline_track(title: str, artists: dict[str, dict], feed_words: set[str] | None = None) -> tuple[str, str, str] | None:
    """(artist, track, kind) for a headline that is about one song or release; None for news."""
    t = PREFIX.sub("", re.sub(r"\s+", " ", title or "").strip())
    if not t or looks_like_news(t):
        return None
    pair = parse_artist_title(t)
    if pair and _plausible_pair(*pair):
        return pair[0], _clean_title(pair[1]), "track"
    # `Artist shares "Song"`: the artist has to open the headline, so a passing mention never becomes a card
    lower = norm(t)
    feed_words = feed_words or set()
    found = None
    for key, e in artists.items():
        # the name, then straight into what they did: "Trip Tease drops…" is not the artist "Trip"
        if len(key) > 2 and key not in feed_words and lower.startswith(key + " ") and VERB.match(lower[len(key) + 1:]) and (found is None or len(key) > len(found[0])):
            found = (key, e["name"])
    if not found:
        return None
    quotes = [(m.start(), _clean_title(m.group(1) or m.group(2) or "")) for m in QUOTED.finditer(t)]
    quotes = [(p, q) for p, q in quotes if q and len(q.split()) <= TITLE_MAX_WORDS and norm(q) != found[0]]
    if not quotes:
        return None
    # the quote that follows a song cue is the track; failing that, the one after an album cue is the release
    for cue, kind in ((SONG_CUE, "track"), (RELEASE_CUE, "release")):
        best = None
        for m in cue.finditer(t):
            after = [(p, q) for p, q in quotes if p > m.start()]
            if after and (best is None or after[0][0] < best[0]):
                best = after[0]
        if best:
            return found[1], best[1], kind
    return None
