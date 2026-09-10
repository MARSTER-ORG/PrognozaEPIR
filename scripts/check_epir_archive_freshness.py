#!/usr/bin/env python3
"""Freshness and continuity gates for the authoritative PrognozaEPIR archive.

Rules:
- routine EPIR METAR is expected every :00/:30;
- a fresh newest METAR is not sufficient: the recent routine sequence must be continuous;
- TAF stations are checked against their own issue schedules;
- SPECI is event-driven and is never treated as a scheduled bulletin.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

LATEST = Path("data/messages/latest.json")
METAR_ROOT = Path("data/messages/metar")
METAR_GRACE_MIN = 10
METAR_CONTINUITY_HOURS = 24
TAF_GRACE_MIN = 15

TAF_SCHEDULES = {
    "EPIR": ((5, 0), (11, 0), (17, 0), (23, 0)),
    "EPBY": ((5, 30), (11, 30), (17, 30), (23, 30)),
    "EPPW": ((5, 0), (11, 0), (17, 0), (23, 0)),
    "EPKS": ((5, 0), (11, 0), (17, 0), (23, 0)),
}


def parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        value_dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if value_dt.tzinfo is None:
        value_dt = value_dt.replace(tzinfo=timezone.utc)
    return value_dt.astimezone(timezone.utc)


def expected_metar_slot(now: datetime, grace_min: int) -> datetime:
    eligible = now - timedelta(minutes=grace_min)
    minute = 30 if eligible.minute >= 30 else 0
    return eligible.replace(minute=minute, second=0, microsecond=0)


def expected_taf_cycle(now: datetime, grace_min: int, station: str) -> datetime:
    eligible = now - timedelta(minutes=grace_min)
    schedule = TAF_SCHEDULES[station]
    candidates: list[datetime] = []
    for day_delta in (-1, 0):
        day = (eligible + timedelta(days=day_delta)).date()
        for hour, minute in schedule:
            stamp = datetime(day.year, day.month, day.day, hour, minute, tzinfo=timezone.utc)
            if stamp <= eligible:
                candidates.append(stamp)
    if not candidates:
        raise RuntimeError(f"cannot determine expected TAF cycle for {station}")
    return max(candidates)


def record_time(row: dict | None, *keys: str) -> datetime | None:
    row = row or {}
    for key in keys:
        value = parse_dt(row.get(key))
        if value:
            return value
    return None


def iso(value: datetime | None) -> str | None:
    return value.isoformat().replace("+00:00", "Z") if value else None


def load_recent_metar_times(start: datetime, end: datetime) -> set[datetime]:
    found: set[datetime] = set()
    day = start.date()
    while day <= end.date():
        path = METAR_ROOT / f"{day:%Y}" / f"{day:%m}" / f"{day:%d}.jsonl"
        if path.exists():
            for raw_line in path.read_text(encoding="utf-8").splitlines():
                if not raw_line.strip():
                    continue
                try:
                    row = json.loads(raw_line)
                except json.JSONDecodeError:
                    continue
                if str(row.get("station") or "").upper() != "EPIR":
                    continue
                if str(row.get("type") or row.get("report_type") or "").upper() != "METAR":
                    continue
                stamp = record_time(row, "obs_time", "message_time")
                if stamp and start <= stamp <= end:
                    found.add(stamp.replace(second=0, microsecond=0))
        day += timedelta(days=1)
    return found


def missing_metar_slots(now: datetime, grace_min: int, continuity_hours: int) -> list[datetime]:
    end = expected_metar_slot(now, grace_min)
    start = end - timedelta(hours=max(1, continuity_hours))
    # Align to a routine half-hour slot.
    start = start.replace(minute=30 if start.minute >= 30 else 0, second=0, microsecond=0)
    found = load_recent_metar_times(start, end)
    expected: list[datetime] = []
    cursor = start
    while cursor <= end:
        expected.append(cursor)
        cursor += timedelta(minutes=30)
    return [slot for slot in expected if slot not in found]


def taf_result(payload: dict, station: str, now: datetime, grace_min: int) -> tuple[dict, bool]:
    by_station = payload.get("taf_by_station") or {}
    row = (by_station.get(station) or payload.get("taf")) if station == "EPIR" else by_station.get(station)
    latest = record_time(row, "issue_time", "message_time")
    expected = expected_taf_cycle(now, grace_min, station)
    ok = bool(latest and latest >= expected)
    return {
        "latest": iso(latest),
        "expected_at_least": iso(expected),
        "grace_min": grace_min,
        "ok": ok,
        "raw": (row or {}).get("raw"),
        "source": (row or {}).get("source"),
        "snapshot_only": (row or {}).get("snapshot_only") if station != "EPIR" else False,
    }, ok


def main() -> int:
    ap = argparse.ArgumentParser()
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--metar-only", action="store_true", help="check routine EPIR METAR only")
    mode.add_argument("--taf-only", action="store_true", help="check TAF only")
    ap.add_argument("--all-tafs", action="store_true", help="with TAF check, require EPIR+EPBY+EPPW+EPKS")
    ap.add_argument("--metar-grace-min", type=int, default=METAR_GRACE_MIN)
    ap.add_argument("--metar-continuity-hours", type=int, default=METAR_CONTINUITY_HOURS)
    ap.add_argument("--taf-grace-min", type=int, default=TAF_GRACE_MIN)
    args = ap.parse_args()

    if args.metar_only and args.all_tafs:
        ap.error("--all-tafs cannot be used with --metar-only")
    if not LATEST.exists():
        raise SystemExit(f"missing {LATEST}")

    payload = json.loads(LATEST.read_text(encoding="utf-8"))
    now = datetime.now(timezone.utc)
    result: dict = {"checked_at": iso(now)}
    checks: list[bool] = []

    if not args.taf_only:
        metar = payload.get("metar_only") or payload.get("metar")
        latest = record_time(metar, "obs_time", "message_time")
        grace = max(0, args.metar_grace_min)
        expected = expected_metar_slot(now, grace)
        missing = missing_metar_slots(now, grace, max(1, args.metar_continuity_hours))
        fresh = bool(latest and latest >= expected)
        continuous = not missing
        ok = fresh and continuous
        result["metar"] = {
            "latest": iso(latest),
            "expected_at_least": iso(expected),
            "grace_min": args.metar_grace_min,
            "continuity_hours": max(1, args.metar_continuity_hours),
            "continuous": continuous,
            "missing_routine_slots": [iso(slot) for slot in missing],
            "ok": ok,
            "raw": (metar or {}).get("raw"),
            "source": (metar or {}).get("source"),
        }
        result["speci"] = {
            "latest": iso(record_time(payload.get("speci"), "obs_time", "message_time")),
            "scheduled": False,
        }
        checks.append(ok)

    if not args.metar_only:
        stations = tuple(TAF_SCHEDULES) if args.all_tafs else ("EPIR",)
        result["taf"] = {}
        for station in stations:
            station_result, station_ok = taf_result(payload, station, now, max(0, args.taf_grace_min))
            result["taf"][station] = station_result
            checks.append(station_ok)

    ok = bool(checks) and all(checks)
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    if not ok:
        raise SystemExit("central aviation archive freshness/continuity gate FAILED")
    print("central aviation archive freshness/continuity gate OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
