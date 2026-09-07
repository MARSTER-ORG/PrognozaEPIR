#!/usr/bin/env python3
"""Fail a collector run when the central EPIR archive missed an expected bulletin.

METAR EPIR is routine at :00/:30. We allow a publication grace period and then
require the latest routine METAR to be at least the corresponding slot. SPECI is
intentionally not scheduled: it is event-driven but travels through the same
METAR/SPECI collector and central importer.

TAF EPIR is expected on the 05/11/17/23 UTC cycles. A longer grace period is
used because operational publication can occur after the nominal issue time.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

LATEST = Path("data/messages/latest.json")
METAR_GRACE_MIN = 15
TAF_GRACE_MIN = 45
TAF_HOURS = (5, 11, 17, 23)


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


def expected_taf_cycle(now: datetime, grace_min: int) -> datetime:
    eligible = now - timedelta(minutes=grace_min)
    candidates = []
    for day_delta in (-1, 0):
        day = (eligible + timedelta(days=day_delta)).date()
        for hour in TAF_HOURS:
            dt = datetime(day.year, day.month, day.day, hour, tzinfo=timezone.utc)
            if dt <= eligible:
                candidates.append(dt)
    if not candidates:
        raise RuntimeError("cannot determine expected TAF cycle")
    return max(candidates)


def record_time(row: dict | None, *keys: str) -> datetime | None:
    row = row or {}
    for key in keys:
        dt = parse_dt(row.get(key))
        if dt:
            return dt
    return None


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat().replace("+00:00", "Z") if dt else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--metar-only", action="store_true", help="check routine METAR only")
    ap.add_argument("--metar-grace-min", type=int, default=METAR_GRACE_MIN)
    ap.add_argument("--taf-grace-min", type=int, default=TAF_GRACE_MIN)
    args = ap.parse_args()

    if not LATEST.exists():
        raise SystemExit(f"missing {LATEST}")
    payload = json.loads(LATEST.read_text(encoding="utf-8"))
    now = datetime.now(timezone.utc)

    metar = payload.get("metar_only") or payload.get("metar")
    metar_time = record_time(metar, "obs_time", "message_time")
    metar_expected = expected_metar_slot(now, max(0, args.metar_grace_min))
    metar_ok = bool(metar_time and metar_time >= metar_expected)

    result = {
        "checked_at": iso(now),
        "metar": {
            "latest": iso(metar_time),
            "expected_at_least": iso(metar_expected),
            "grace_min": args.metar_grace_min,
            "ok": metar_ok,
            "raw": (metar or {}).get("raw"),
            "source": (metar or {}).get("source"),
        },
        "speci": {
            "latest": iso(record_time(payload.get("speci"), "obs_time", "message_time")),
            "scheduled": False,
        },
    }

    ok = metar_ok
    if not args.metar_only:
        taf = payload.get("taf") or (payload.get("taf_by_station") or {}).get("EPIR")
        taf_time = record_time(taf, "issue_time", "message_time")
        taf_expected = expected_taf_cycle(now, max(0, args.taf_grace_min))
        taf_ok = bool(taf_time and taf_time >= taf_expected)
        result["taf"] = {
            "latest": iso(taf_time),
            "expected_at_least": iso(taf_expected),
            "grace_min": args.taf_grace_min,
            "ok": taf_ok,
            "raw": (taf or {}).get("raw"),
            "source": (taf or {}).get("source"),
        }
        ok = ok and taf_ok

    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    if not ok:
        raise SystemExit("EPIR central archive freshness gate FAILED")
    print("EPIR central archive freshness gate OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
