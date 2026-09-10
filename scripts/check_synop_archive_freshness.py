#!/usr/bin/env python3
"""Freshness and continuity gate for SYNOP station 12342.

A current latest SYNOP is not sufficient. The gate also requires every hourly
routine slot in the recent continuity window, so historical gaps cannot be
hidden by a newer observation.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

LATEST = Path("data/messages/latest.json")
SYNOP_ROOT = Path("data/messages/synop")
STATION = "12342"
DEFAULT_GRACE_MIN = 20
DEFAULT_CONTINUITY_HOURS = 24


def parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(timezone.utc)


def iso(value: datetime | None) -> str | None:
    return value.isoformat().replace("+00:00", "Z") if value else None


def expected_slot(now: datetime, grace_min: int) -> datetime:
    eligible = now - timedelta(minutes=max(0, grace_min))
    return eligible.replace(minute=0, second=0, microsecond=0)


def load_times(start: datetime, end: datetime) -> set[datetime]:
    found: set[datetime] = set()
    day = start.date()
    while day <= end.date():
        path = SYNOP_ROOT / f"{day:%Y}" / f"{day:%m}" / f"{day:%d}.jsonl"
        if path.exists():
            for raw_line in path.read_text(encoding="utf-8").splitlines():
                if not raw_line.strip():
                    continue
                try:
                    row = json.loads(raw_line)
                except json.JSONDecodeError:
                    continue
                if str(row.get("station") or "") != STATION:
                    continue
                if str(row.get("type") or "").upper() != "SYNOP":
                    continue
                stamp = parse_dt(row.get("obs_time") or row.get("message_time"))
                if stamp and start <= stamp <= end:
                    found.add(stamp.replace(minute=0, second=0, microsecond=0))
        day += timedelta(days=1)
    return found


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--grace-min", type=int, default=DEFAULT_GRACE_MIN)
    ap.add_argument("--continuity-hours", type=int, default=DEFAULT_CONTINUITY_HOURS)
    args = ap.parse_args()

    if not LATEST.exists():
        raise SystemExit(f"missing {LATEST}")

    payload = json.loads(LATEST.read_text(encoding="utf-8"))
    row = payload.get("synop") or {}
    latest = parse_dt(row.get("obs_time") or row.get("message_time"))
    now = datetime.now(timezone.utc)
    end = expected_slot(now, args.grace_min)
    start = end - timedelta(hours=max(1, args.continuity_hours))
    found = load_times(start, end)

    expected: list[datetime] = []
    cursor = start
    while cursor <= end:
        expected.append(cursor)
        cursor += timedelta(hours=1)
    missing = [slot for slot in expected if slot not in found]

    fresh = bool(latest and latest >= end)
    continuous = not missing
    ok = fresh and continuous
    result = {
        "checked_at": iso(now),
        "synop": {
            "station": STATION,
            "latest": iso(latest),
            "expected_at_least": iso(end),
            "grace_min": args.grace_min,
            "continuity_hours": max(1, args.continuity_hours),
            "continuous": continuous,
            "missing_routine_slots": [iso(slot) for slot in missing],
            "ok": ok,
            "raw": row.get("raw"),
            "source": row.get("source"),
        },
    }
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    if not ok:
        raise SystemExit("central SYNOP archive freshness/continuity gate FAILED")
    print("central SYNOP archive freshness/continuity gate OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
