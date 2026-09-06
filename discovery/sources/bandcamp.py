"""Bandcamp Discover — releases per tag (the same JSON endpoint bandcamp.com's own Discover page uses).

Each tag is asked for every configured slice: "new" (newest arrivals, source "bandcamp") and "top" (what the
Discover page is selling best — a human-filtered shelf, so those items are editorial, source "bandcamp:top").
No key. Unofficial; if Bandcamp changes the endpoint the source logs a warning and the run continues.
"""
from __future__ import annotations

from ..models import Item
from ..util import Http, log, parse_date

DISCOVER_URL = "https://bandcamp.com/api/discover/1/discover_web"
IMG = "https://f4.bcbits.com/img/a{img}_7.jpg"
DEFAULT_SLICES = ["new", "top"]


def _post(http: Http, tag: str, size: int, cursor: str = "*", slice_: str = "new") -> dict:
    body = {
        "tag_norm_names": [tag],
        "geoname_id": 0,
        "slice": slice_,
        "time_facet_id": None,
        "cursor": cursor,
        "size": size,
        "include_result_types": ["a", "s"],
        "category_id": 0,
    }
    return http.post(DISCOVER_URL, json_body=body, headers={"Content-Type": "application/json", "Accept": "application/json"})


def fetch(cfg: dict, profile: dict, http: Http) -> list[Item]:
    scfg = cfg["sources"]["bandcamp"]
    per = int(scfg.get("per_tag", 60))
    slices = [str(s) for s in (scfg.get("slices") or DEFAULT_SLICES)]
    out: list[Item] = []
    seen: set[str] = set()
    for tag, slice_ in ((t, s) for t in (scfg.get("tags") or []) for s in slices):
        try:
            data = _post(http, tag, per, slice_=slice_)
        except Exception as exc:  # noqa: BLE001
            log.warning("bandcamp tag %s (%s) failed: %s", tag, slice_, exc)
            continue
        editorial = slice_ == "top"
        label = "bandcamp:top" if editorial else "bandcamp"
        results = data.get("results") or data.get("items") or []
        for r in results:
            url = r.get("item_url") or r.get("url")
            if not url or url in seen:
                continue
            seen.add(url)
            artist = r.get("band_name") or r.get("artist") or ""
            title = r.get("title") or r.get("album_title") or ""
            if not artist or not title:
                continue
            featured = r.get("featured_track") or {}
            ftitle = featured.get("title") if isinstance(featured, dict) else None
            item_type = r.get("item_type") or r.get("type") or "a"
            tags = [tag.replace("-", " ")]
            for t in r.get("tags") or r.get("genres") or []:
                name = t.get("norm_name") if isinstance(t, dict) else t
                if name:
                    tags.append(str(name).replace("-", " "))
            img = r.get("item_image_id") or r.get("art_id")
            out.append(Item(
                artist=artist,
                title=ftitle or title,
                kind="track" if (ftitle or item_type == "t") else "release",
                release=title,
                release_type="Single" if item_type == "t" else ("Album" if int(r.get("track_count") or 0) >= 7 else "EP"),
                release_date=parse_date(r.get("release_date")),
                tags=tags,
                sources=[label],
                links={"bandcamp": url},
                artwork=IMG.format(img=img) if img else None,
                blurb=(r.get("band_location") or None),
                editorial=editorial,
            ))
    return out
