"""Garmin Connect sync through python-garminconnect (Garmin's mobile sign-in; there is no public consumer API).

What a Venu Sq records, and therefore what this pulls: sleep stages and duration, awake time, overnight stress
(Garmin's HRV-derived stress score, the closest thing the Sq gives to HRV), resting HR, respiration, Pulse Ox when it
is switched on, Body Battery, steps, intensity minutes and activities. It has no overnight HRV, HRV Status, Training
Readiness or Sleep Score; those fields stay empty and the site computes its own from the rest.
"""
from __future__ import annotations

import getpass
import json
import os
import time
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from fitness.activities import activity
from fitness.store import Store


def _client(cfg: dict, interactive: bool = False, prompt_mfa=None):
    """A signed-in client. Saved tokens are used when they still work; with GARMIN_EMAIL / GARMIN_PASSWORD in the
    environment (the GitHub Actions sync) a stale or missing session signs in again on its own, asking prompt_mfa
    for the emailed code if the account has two-step verification."""
    from garminconnect import Garmin

    tokens = str(Path(cfg["sync"]["garmin_tokens"]).expanduser())
    email, password = os.environ.get("GARMIN_EMAIL"), os.environ.get("GARMIN_PASSWORD")
    if interactive:
        email = input("Garmin email: ").strip()
        password = getpass.getpass("Garmin password: ")
        client = Garmin(email, password, prompt_mfa=lambda: input("Garmin MFA code: ").strip())
    elif email and password:
        Path(tokens).mkdir(parents=True, exist_ok=True)
        client = Garmin(email, password, prompt_mfa=prompt_mfa)
    else:
        if not (Path(tokens) / "garmin_tokens.json").exists():
            raise SystemExit("No Garmin session yet: run `python -m fitness login garmin` once.")
        client = Garmin()
    client.login(tokens)
    return client


def login(cfg: dict) -> None:
    client = _client(cfg, interactive=True)
    print(f"Signed in as {client.get_full_name() or 'you'}; tokens saved to {cfg['sync']['garmin_tokens']} (treat them like a password).")


def _ms_local(ms: int | None) -> str | None:
    # Garmin's *TimestampLocal fields are local wall-clock time encoded as if it were UTC epoch milliseconds
    return datetime.fromtimestamp(ms / 1000, UTC).strftime("%Y-%m-%dT%H:%M") if ms else None


def parse_day(summary: dict | None, sleep: dict | None) -> dict:
    s = summary or {}
    sl = sleep or {}
    dto = sl.get("dailySleepDTO") or {}
    night = None
    if dto.get("sleepTimeSeconds"):
        night = {
            "start": _ms_local(dto.get("sleepStartTimestampLocal")), "end": _ms_local(dto.get("sleepEndTimestampLocal")),
            "total": dto.get("sleepTimeSeconds"), "deep": dto.get("deepSleepSeconds"), "light": dto.get("lightSleepSeconds"),
            "rem": dto.get("remSleepSeconds"), "awake": dto.get("awakeSleepSeconds"), "awake_count": dto.get("awakeCount"),
            "avg_stress": dto.get("avgSleepStress"), "resp": dto.get("averageRespirationValue"), "resp_low": dto.get("lowestRespirationValue"),
            "spo2": dto.get("averageSpO2Value"), "spo2_low": dto.get("lowestSpO2Value"), "restless": sl.get("restlessMomentsCount"),
            "bb_change": sl.get("bodyBatteryChange"), "hrv": sl.get("avgOvernightHrv"),
            "garmin_score": ((dto.get("sleepScores") or {}).get("overall") or {}).get("value"),
        }
    day = {
        "rhr": s.get("restingHeartRate") or sl.get("restingHeartRate"), "stress": s.get("averageStressLevel"), "stress_max": s.get("maxStressLevel"),
        "bb_high": s.get("bodyBatteryHighestValue"), "bb_low": s.get("bodyBatteryLowestValue"), "bb_charged": s.get("bodyBatteryChargedValue"),
        "bb_drained": s.get("bodyBatteryDrainedValue"), "bb_wake": s.get("bodyBatteryAtWakeTime"), "steps": s.get("totalSteps"),
        "resp_awake": s.get("avgWakingRespirationValue"), "spo2": s.get("averageSpo2"),
        "intensity_min": (s.get("moderateIntensityMinutes") or 0) + 2 * (s.get("vigorousIntensityMinutes") or 0) if "moderateIntensityMinutes" in s else None,
        "active_kcal": s.get("activeKilocalories"), "sleep": night,
        # today, as of the last watch sync: the afternoon's ride-home check reads these
        "bb_now": s.get("bodyBatteryMostRecentValue"), "stress_high_s": s.get("highStressDuration"),
    }
    day = {k: v for k, v in day.items() if v is not None}
    return day or {"empty": True}


def parse_activity(a: dict) -> dict:
    zones = [a.get(f"hrTimeInZone_{i}") for i in range(1, 6)]
    return activity(
        id=f"garmin:{a['activityId']}", source="garmin", start=datetime.fromisoformat(a["startTimeLocal"]),
        kind=(a.get("activityType") or {}).get("typeKey", "other"), name=a.get("activityName") or "",
        duration_s=a.get("duration") or 0, moving_s=a.get("movingDuration"), distance_m=a.get("distance"), elev_m=a.get("elevationGain"),
        avg_hr=a.get("averageHR"), max_hr=a.get("maxHR"), avg_power=a.get("avgPower"), np=a.get("normPower"), calories=a.get("calories"),
        hr_zones=zones if any(zones) else None, te_aerobic=a.get("aerobicTrainingEffect"), te_anaerobic=a.get("anaerobicTrainingEffect"),
        garmin_load=a.get("activityTrainingLoad"),
        start_utc=datetime.fromisoformat(a["startTimeGMT"]).isoformat() if a.get("startTimeGMT") else None,
        start_ll=_ll(a, "start"), end_ll=_ll(a, "end"),
    )


def _ll(a: dict, end: str) -> list[float] | None:
    """Where a ride started or ended, to ~100 m: it finds the commute's two ends for the weather. Stays in the
    encrypted store; never in the phone's data."""
    lat, lon = a.get(f"{end}Latitude"), a.get(f"{end}Longitude")
    return [round(lat, 3), round(lon, 3)] if lat is not None and lon is not None and (lat or lon) else None


PARSER_VERSION = 2   # bump when parse_activity learns a field: stored rides are re-read from their raw records


STREAM_DAYS, STREAM_MAX = 120, 30   # how far back ride traces are fetched, and at most how many per sync (Garmin rate-limits)


def _streams(client, store: Store, today: date) -> None:
    """Each ride's minute-by-minute heart rate, speed and power (streams.py), newest first; a ride without a usable
    trace is remembered too, so it isn't asked for again."""
    from fitness import streams

    have = store.prefixed("stream:")
    since = (today - timedelta(days=STREAM_DAYS)).isoformat()
    todo = sorted((a for a in store.activities() if a["source"] == "garmin" and a.get("group") == "ride" and a["start"][:10] >= since
                   and a["id"] not in have), key=lambda a: a["start"], reverse=True)
    done = 0
    for a in todo[:STREAM_MAX]:
        try:
            details = client.get_activity_details(a["id"].split(":", 1)[1], maxchart=2000, maxpoly=0)
        except Exception as e:      # rate limit or a missing record: the rest wait for the next sync
            print(f"Garmin: ride traces paused ({str(e)[:80]})")
            break
        store.set(f"stream:{a['id']}", json.dumps(streams.compact(details or {}) or {"none": True}, separators=(",", ":")))
        done += 1
        time.sleep(0.35)
    if done:
        print(f"Garmin: {done} ride trace(s), {max(0, len(todo) - done)} still to fetch")


def _weigh_ins(client, store: Store, today: date) -> None:
    """Your Garmin Connect weigh-ins (a scale, or typed into the app): [date, kg], a year back on the first run."""
    have = dict(json.loads(store.get("weigh_ins") or "[]"))
    start = today - timedelta(days=30 if have else 365)
    try:
        got = (client.get_body_composition(start.isoformat(), today.isoformat()) or {}).get("dateWeightList") or []
    except Exception:            # optional: the sync carries on without it
        return
    for w in got:
        if w.get("weight") and w.get("calendarDate"):
            have[w["calendarDate"]] = round(w["weight"] / 1000, 2)
    store.set("weigh_ins", json.dumps(sorted(have.items())))


def _profile(client, store: Store) -> None:
    """Body weight, height and birth year from the Garmin profile (the fuel plan's g/kg targets need the weight)."""
    try:
        u = (client.get_user_profile() or {}).get("userData") or {}
    except Exception:   # optional: the sync carries on without it
        return
    if u.get("weight"):
        store.set("profile", json.dumps({"weight_kg": round(u["weight"] / 1000, 1), "height_cm": u.get("height"),
                                         "birth_year": int(str(u["birthDate"])[:4]) if u.get("birthDate") else None}))
        print(f"Garmin: profile weight {u['weight'] / 1000:.1f} kg")


def sync(cfg: dict, store: Store, days: int | None = None, prompt_mfa=None) -> None:
    from garminconnect import GarminConnectTooManyRequestsError

    if int(store.get("garmin_parser") or 1) < PARSER_VERSION:
        n = store.reparse("garmin", parse_activity)
        store.set("garmin_parser", str(PARSER_VERSION))
        print(f"Garmin: re-read {n} stored activities")
    client = _client(cfg, prompt_mfa=prompt_mfa)
    today = date.today()
    first = today - timedelta(days=days or cfg["sync"]["history_days"])
    have = store.day_dates()
    recent = {(today - timedelta(days=i)).isoformat() for i in range(cfg["sync"]["resync_days"])}
    wanted = [d.isoformat() for d in (first + timedelta(days=i) for i in range((today - first).days + 1))]
    todo = [d for d in wanted if d not in have or d in recent]
    print(f"Garmin: {len(todo)} day(s) to fetch")
    try:
        for n, d in enumerate(todo, 1):
            summary = client.get_user_summary(d)
            sleep = client.get_sleep_data(d)
            store.put_day(d, parse_day(summary, sleep), {"summary": summary, "sleep": sleep})
            if n % 20 == 0:
                store.commit()
                print(f"  {n}/{len(todo)} days")
            time.sleep(0.35)
        since = store.latest_start("garmin")
        start = (date.fromisoformat(since[:10]) - timedelta(days=2)) if since else first
        acts = client.get_activities_by_date(start.isoformat(), today.isoformat())
        for a in acts:
            store.put_activity(parse_activity(a), a)
        print(f"Garmin: {len(acts)} activit{'y' if len(acts) == 1 else 'ies'} since {start}")
        _profile(client, store)
        _weigh_ins(client, store, today)
        _streams(client, store, today)
    except GarminConnectTooManyRequestsError:
        print("Garmin is rate-limiting this account; progress is saved, run sync again in an hour.")
    finally:
        store.commit()
