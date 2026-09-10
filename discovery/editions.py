"""Which edition of a song a playlist row is: the original, a radio edit, an extended mix, a remix, a live take.

YouTube Music names the same recording many ways ("Song", "Song (Official Video)", "Song - Remastered 2011") and
files genuinely different recordings under near-identical titles ("Song (Radio Edit)", "Song (X Remix)"). The
Cleanup tab needs both told apart: two uploads of the *same* edition are a duplicate to resolve, two editions are
a judgement call. `edition_of` peels the bracketed and dashed suffixes off a title, keeps what they said as a
label, and names the edition the musical content belongs to. The site carries the same rules in
site/src/editions.js for its live playlist scan — keep the two in step.
"""
from __future__ import annotations

import re

from .util import norm

# editions whose release year is their own, not the original song's: a verified year says nothing about them
YEAR_FREE = frozenset({"remix", "live", "acoustic", "instrumental", "demo"})
# the most specific edition wins when a title stacks suffixes ("Song (X Remix) (Radio Edit)" is the remix)
_RANK = {"remix": 7, "live": 6, "acoustic": 5, "instrumental": 4, "demo": 3, "extended": 2, "radio": 1, "original": 0}

# a trailing "(…)", "[…]" or " - …" chunk; the same chunk can sit several deep, so the peel repeats
_TAIL_RE = re.compile(r"\s*(?:[\(\[](?P<br>[^\(\)\[\]]*)[\)\]]|\s[-–—]\s*(?P<dash>[^\(\)\[\]\-–—]{2,60}?))\s*$")
_FEAT_TAIL_RE = re.compile(r"^(?:feat\.?|ft\.?|featuring|with)\s+(?P<who>.+)$", re.I)
# the markers that add nothing musical: the upload's form, the mastering, the edition of the album it sits on
_PLAIN_RE = re.compile(
    r"^(?:official(?:\s+(?:music\s+)?(?:video|audio|visuali[sz]er|lyric\s+video|hd\s+video|version))?|(?:music|lyric|hd|hq|4k|full)\s+video|video|audio|visuali[sz]er|lyrics?|"
    r"hq|hd|4k|explicit|clean|mono|stereo|(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?(?:\s+version)?|remastered\s+version|"
    r"\d+(?:st|nd|rd|th)[\s-]anniversary(?:\s+(?:edition|version|remaster))?|anniversary\s+edition|deluxe(?:\s+(?:edition|version))?|"
    r"expanded(?:\s+edition)?|bonus\s+track(?:\s+version)?|reissue|re-issue|original(?:\s+(?:mix|version))?|album\s+version|single|"
    r"from\s+.{1,60}|taken\s+from\s+.{1,60}|out\s+now.*|new\s+single|premiere|official|prod\.?\s+by\s+.{1,40}|sped\s+up|slowed(?:\s+\+\s+reverb)?)$",
    re.I,
)
_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("live", re.compile(r"^(?:live(?:\s+(?:at|from|in|on|version|session|acoustic|\d{4}).*)?|.*\blive\s+(?:at|from|in|on|session|version)\b.*|.*\bsession\b.*|.*\blive$)$", re.I)),
    ("acoustic", re.compile(r"^(?:acoustic(?:\s+version)?|unplugged|stripped(?:\s+(?:back|down))?|piano\s+version|.*\bacoustic\b.*)$", re.I)),
    ("instrumental", re.compile(r"^(?:instrumental(?:\s+(?:mix|version))?|karaoke(?:\s+version)?|.*\binstrumental$)$", re.I)),
    ("demo", re.compile(r"^(?:demo(?:\s+version)?|.*\bdemo$|rough\s+mix|early\s+version|alternate(?:\s+(?:take|version|mix))?|alt\.?\s+(?:take|version|mix))$", re.I)),
    ("radio", re.compile(r"^(?:radio\s+(?:edit|mix|version)|single\s+(?:edit|version|mix)|(?:short|7\"?|7\s*inch)\s+(?:edit|version|mix)|edit(?:ed)?(?:\s+version)?|album\s+edit|clean\s+edit)$", re.I)),
    ("extended", re.compile(r"^(?:extended(?:\s+(?:mix|version|edit|club(?:\s+mix)?|play))?|(?:12\"?|12\s*inch)\s+(?:mix|version|edit)|club\s+(?:mix|version|edit)|full\s+length(?:\s+version)?|long\s+version|original\s+extended(?:\s+mix)?|dub(?:\s+(?:mix|version))?)$", re.I)),
    # "<who> Remix", "<who>'s Dub", "<who> Version", "Remix by <who>" — a named other hand on the recording
    ("remix", re.compile(r"^(?:(?P<who>.+?)\s+(?:remix|rmx|rework|re-work|re-edit|reedit|edit|dub|bootleg|flip|refix|rerub|version|mix|remake|vip|cover|revisions?|re-?write|rub|re-?recording|reprise|interpretation|reinterpretation|remodel|reconstruction|dubplate|treatment|take|extended(?:\s+(?:mix|remix|edit|play))?)|remix(?:\s+by\s+(?P<by>.+))?|remixed\s+by\s+.+|(?P<who2>.+?)\s+remix\b.*|mix\s+by\s+(?P<by2>.+))$", re.I)),
]
_YEAR_ONLY_RE = re.compile(r"^(?:19|20)\d\d$")


def _label(text: str) -> str:
    """The suffix as the tab shows it: case tidied, the noise trimmed."""
    t = re.sub(r"\s+", " ", text).strip(" -–—")
    return t if t.isupper() and len(t) <= 4 else " ".join(w if (w.isupper() and len(w) > 1) or w[:1].isdigit() else w[:1].upper() + w[1:] for w in t.split(" "))


def edition_of(title: str | None) -> dict:
    """{"core": the song title without any suffix, "edition": original|radio|extended|remix|live|acoustic|instrumental|demo|other,
    "label": what the suffixes said ("Official Video", "Fred Falke Remix · Radio Edit"), "featuring": [names]}

    A bracketed note that names no edition ("(The Vampire Song)", "(WWW)") is a subtitle: it stays in the label so the
    tab shows it, and the row still counts as the original."""
    t = re.sub(r"\s+", " ", str(title or "")).strip()
    labels: list[str] = []
    featuring: list[str] = []
    edition = "original"
    for _ in range(5):
        m = _TAIL_RE.search(t)
        if not m or m.start() == 0:
            break
        chunk = (m.group("br") if m.group("br") is not None else m.group("dash") or "").strip()
        if not chunk:
            t = t[: m.start()].rstrip()
            continue
        f = _FEAT_TAIL_RE.match(chunk)
        if f:
            featuring[0:0] = [x.strip() for x in re.split(r"\s*(?:,|&|\band\b)\s*", f.group("who")) if x.strip()]
            t = t[: m.start()].rstrip()
            continue
        if _YEAR_ONLY_RE.match(chunk) or _PLAIN_RE.match(chunk):
            labels.insert(0, _label(chunk))
            t = t[: m.start()].rstrip()
            continue
        kind = next((name for name, rx in _RULES if rx.match(chunk)), None)
        if kind is None and m.group("br") is None:
            break   # a dashed tail that names no edition is part of the title ("Song - Part 2")
        # a bracketed note that names no edition is a subtitle ("Bloodletting (The Vampire Song)"): shown, not judged
        if kind is not None and _RANK[kind] > _RANK[edition]:
            edition = kind
        labels.insert(0, _label(chunk))
        t = t[: m.start()].rstrip()
    # a featured credit that sits inside the title with no bracket
    m = re.search(r"\s+(?:feat\.?|ft\.?|featuring)\s+(?P<who>.+)$", t, re.I)
    if m:
        featuring[0:0] = [x.strip() for x in re.split(r"\s*(?:,|&|\band\b)\s*", m.group("who")) if x.strip()]
        t = t[: m.start()].rstrip()
    return {"core": t.strip(" -–—") or str(title or "").strip(), "edition": edition, "label": " · ".join(labels), "featuring": featuring}


EDITIONS = ("original", "radio", "extended", "remix", "live", "acoustic", "instrumental", "demo")


def song_key(artist: str | None, title: str | None) -> tuple[str, str]:
    """The (artist, core title) pair that makes two playlist rows the same song, whatever their edition."""
    a = re.sub(r"\s+(?:feat\.?|ft\.?|featuring)\s+.+$", "", str(artist or ""), flags=re.I)
    return norm(a), norm(edition_of(title)["core"])
