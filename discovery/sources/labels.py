"""Label watch: recent releases on labels you trust, via MusicBrainz release search (free, 1 req/s)."""
from __future__ import annotations

from datetime import date, timedelta

from ..models import Item
from ..util import Http, log, norm, parse_date, source_days

MB = "https://musicbrainz.org/ws/2/release/"
SKIP = {"compilation", "live", "dj-mix", "remix", "soundtrack"}


def fetch(cfg: dict, profile: dict, http: Http) -> list[Item]:
    scfg = cfg["sources"]["musicbrainz_labels"]
    days = source_days(cfg, "musicbrainz_labels")   # own `days`, else listenbrainz_fresh.days, else 10
    start, end = (date.today() - timedelta(days=days)).isoformat(), date.today().isoformat()
    out: list[Item] = []
    seen: set[str] = set()
    for label in scfg.get("labels") or []:
        q = f'label:"{label}" AND date:[{start} TO {end}]'
        try:
            data = http.get(MB, params={"query": q, "fmt": "json", "limit": 50})
        except Exception as exc:  # noqa: BLE001
            log.warning("label %s: %s", label, exc)
            continue
        for rel in data.get("releases") or []:
            rg = rel.get("release-group") or {}
            if rg.get("id") in seen:
                continue
            seen.add(rg.get("id") or rel.get("id"))
            sec = {str(s).lower() for s in (rg.get("secondary-types") or [])}
            if sec & SKIP:
                continue
            credits = rel.get("artist-credit") or []
            credit = "".join((c.get("name") or (c.get("artist") or {}).get("name") or "") + (c.get("joinphrase") or "") for c in credits if isinstance(c, dict)).strip()
            if not credit or norm(credit) in ("various artists", "various"):
                continue
            out.append(Item(
                artist=credit, title=rel.get("title") or "", kind="release", release=rel.get("title"),
                release_type=rg.get("primary-type"), release_date=parse_date(rel.get("date")),
                tags=[f"label:{label}"], sources=["musicbrainz-label"], editorial=True,
                artist_mbids=[(c.get("artist") or {}).get("id") for c in credits if isinstance(c, dict) and (c.get("artist") or {}).get("id")],
                links={"musicbrainz": f"https://musicbrainz.org/release-group/{rg.get('id')}" if rg.get("id") else f"https://musicbrainz.org/release/{rel.get('id')}"},
            ))
    return out
