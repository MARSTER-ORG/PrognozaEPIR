#!/usr/bin/env python3
"""Archive-only continuity audit for SYNOP station 12342.

There is currently no dependable live source for SYNOP 12342, so SYNOP must not
be treated as a freshness requirement for the operational ingestor. This audit
checks only for internal hourly gaps inside the SYNOP range that is already in
the archive. It never expects observations newer than the newest archived
record and never fails the ingest cycle because live SYNOP is unavailable.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

LATEST = Path("data/messages/latest.json")
SYNOP_ROOT = Path("data/messages/synop")
STATION = "12342"
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
    ap.add_argument("--continuity-hours", type=int, default=DEFAULT_CONTINUITY_HOURS)
    args = ap.parse_args()

    now = datetime.now(timezone.utc)
    result: dict = {
        "checked_at": iso(now),
        "synop": {
            "station": STATION,
            "mode": "archive_only",
            "live_source_required": False,
            "freshness_enforced": False,
            "informational": True,
        },
    }

    if not LATEST.exists():
        result["synop"].update({
            "latest": None,
            "continuous": None,
            "missing_routine_slots": [],
            "status": "archive_metadata_missing",
            "operational_ok": True,
        })
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
        print("central SYNOP archive audit: live freshness not enforced")
        return 0

    payload = json.loads(LATEST.read_text(encoding="utf-8"))
    row = payload.get("synop") or {}
    latest = parse_dt(row.get("obs_time") or row.get("message_time"))
    if latest is None:
        result["synop"].update({
            "latest": None,
            "continuous": None,
            "missing_routine_slots": [],
            "status": "no_synop_in_archive",
            "operational_ok": True,
            "raw": row.get("raw"),
            "source": row.get("source"),
        })
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
        print("central SYNOP archive audit: no live freshness requirement")
        return 0

    end = latest.replace(minute=0, second=0, microsecond=0)
    start = end - timedelta(hours=max(1, args.continuity_hours))
    found = load_times(start, end)

    expected: list[datetime] = []
    cursor = start
    while cursor <= end:
        expected.append(cursor)
        cursor += timedelta(hours=1)
    missing = [slot for slot in expected if slot not in found]
    continuous = not missing
    age_minutes = max(0, int((now - latest).total_seconds() // 60))

    result["synop"].update({
        "latest": iso(latest),
        "audit_start": iso(start),
        "audit_end": iso(end),
        "age_minutes": age_minutes,
        "continuity_hours": max(1, args.continuity_hours),
        "continuous": continuous,
        "missing_routine_slots": [iso(slot) for slot in missing],
        "archive_ok": continuous,
        "operational_ok": True,
        "status": "archive_continuous" if continuous else "archive_has_internal_gaps",
        "raw": row.get("raw"),
        "source": row.get("source"),
    })
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    print("central SYNOP archive audit: live freshness not enforced")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
