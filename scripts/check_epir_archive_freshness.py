#!/usr/bin/env python3
"""Freshness gates for the authoritative PrognozaEPIR aviation archive.

The gates are deliberately independent:
- routine EPIR METAR is expected every :00/:30;
- TAF stations are checked against their own issue schedules;
- SPECI is event-driven and is never treated as a scheduled bulletin.

A failed gate is an alarm only. Collector workflows publish every bulletin they
managed to acquire before running the final gate, so one missing stream/station
cannot suppress fresh data from another one.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

LATEST = Path("data/messages/latest.json")
METAR_GRACE_MIN = 10
TAF_GRACE_MIN = 15

# Nominal issue times observed for the stations used by PrognozaEPIR.
# EPBY issues on the half-hour; EPIR/EPPW/EPKS on the hour.
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
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


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


def taf_result(payload: dict, station: str, now: datetime, grace_min: int) -> tuple[dict, bool]:
    by_station = payload.get("taf_by_station") or {}
    if station == "EPIR":
        row = by_station.get(station) or payload.get("taf")
    else:
        row = by_station.get(station)
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
        expected = expected_metar_slot(now, max(0, args.metar_grace_min))
        ok = bool(latest and latest >= expected)
        result["metar"] = {
            "latest": iso(latest),
            "expected_at_least": iso(expected),
            "grace_min": args.metar_grace_min,
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
            station_result, ok = taf_result(payload, station, now, max(0, args.taf_grace_min))
            result["taf"][station] = station_result
            checks.append(ok)

    ok = bool(checks) and all(checks)
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    if not ok:
        raise SystemExit("central aviation archive freshness gate FAILED")
    print("central aviation archive freshness gate OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
