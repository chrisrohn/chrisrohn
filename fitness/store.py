"""SQLite store. Raw API responses are kept beside the normalized rows, so a parser fix never needs a re-download."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS wellness (
  date TEXT PRIMARY KEY,          -- the calendar day; its sleep is the night that ended that morning
  data TEXT NOT NULL,             -- normalized fields (see garmin.parse_day)
  raw TEXT                        -- {"summary": ..., "sleep": ...} as Garmin returned them
);
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,            -- "garmin:<id>" / "strava:<id>"
  source TEXT NOT NULL,
  start TEXT NOT NULL,            -- local wall-clock time, YYYY-MM-DDTHH:MM:SS
  data TEXT NOT NULL,
  raw TEXT
);
CREATE INDEX IF NOT EXISTS activities_start ON activities(start);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
"""


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.executescript(SCHEMA)

    def close(self) -> None:
        self.db.commit()
        self.db.close()

    def __enter__(self) -> Store:
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def put_day(self, day: str, data: dict, raw: dict | None = None) -> None:
        self.db.execute("INSERT OR REPLACE INTO wellness VALUES (?, ?, ?)", (day, json.dumps(data), json.dumps(raw) if raw is not None else None))

    def days(self) -> dict[str, dict]:
        return {d: json.loads(v) for d, v in self.db.execute("SELECT date, data FROM wellness ORDER BY date")}

    def day_dates(self) -> set[str]:
        return {d for (d,) in self.db.execute("SELECT date FROM wellness")}

    def put_activity(self, act: dict, raw: dict | None = None) -> None:
        self.db.execute("INSERT OR REPLACE INTO activities VALUES (?, ?, ?, ?, ?)",
                        (act["id"], act["source"], act["start"], json.dumps(act), json.dumps(raw) if raw is not None else None))

    def activities(self) -> list[dict]:
        return [json.loads(v) for (v,) in self.db.execute("SELECT data FROM activities ORDER BY start")]

    def reparse(self, source: str, parse) -> int:
        """Re-normalize every stored activity from `source` from its raw record (a parser that learned a field)."""
        rows = self.db.execute("SELECT raw FROM activities WHERE source = ? AND raw IS NOT NULL", (source,)).fetchall()
        for (raw,) in rows:
            self.put_activity(parse(json.loads(raw)), json.loads(raw))
        return len(rows)

    def latest_start(self, source: str) -> str | None:
        return self.db.execute("SELECT MAX(start) FROM activities WHERE source = ?", (source,)).fetchone()[0]

    def get(self, key: str, default: str | None = None) -> str | None:
        row = self.db.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
        return row[0] if row else default

    def set(self, key: str, value: str) -> None:
        self.db.execute("INSERT OR REPLACE INTO kv VALUES (?, ?)", (key, value))

    def commit(self) -> None:
        self.db.commit()
