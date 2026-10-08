"""Garmin Connect sync through python-garminconnect (Garmin's mobile sign-in; there is no public consumer API).

What a Venu Sq records, and therefore what this pulls: sleep stages and duration, awake time, overnight stress
(Garmin's HRV-derived stress score, the closest thing the Sq gives to HRV), resting HR, respiration, Pulse Ox when it
is switched on, Body Battery, steps, intensity minutes and activities. It has no overnight HRV, HRV Status, Training
Readiness or Sleep Score; those fields stay empty and the site computes its own from the rest.
"""
from __future__ import annotations

import getpass
import time
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from fitness.activities import activity
from fitness.store import Store


def _client(cfg: dict, interactive: bool = False):
    from garminconnect import Garmin

    tokens = str(Path(cfg["sync"]["garmin_tokens"]).expanduser())
    if interactive:
        email = input("Garmin email: ").strip()
        password = getpass.getpass("Garmin password: ")
        client = Garmin(email, password, prompt_mfa=lambda: input("Garmin MFA code: ").strip())
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
    )


def sync(cfg: dict, store: Store, days: int | None = None) -> None:
    from garminconnect import GarminConnectTooManyRequestsError

    client = _client(cfg)
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
    except GarminConnectTooManyRequestsError:
        print("Garmin is rate-limiting this account; progress is saved, run sync again in an hour.")
    finally:
        store.commit()
