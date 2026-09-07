#!/usr/bin/env python3
from __future__ import annotations

import calendar
import json
import re
from datetime import datetime, timezone
from pathlib import Path

CACHE = Path("data/taf/neighbors.json")
LATEST = Path("data/taf/latest.json")
ARCHIVE_ROOT = Path("data/taf/epir")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def shifted_month(ref: datetime, delta: int) -> tuple[int, int]:
    n = ref.year * 12 + (ref.month - 1) + delta
    return n // 12, n % 12 + 1


def resolve_group(code: str, ref: datetime, with_minutes: bool = False) -> datetime:
    day = int(code[:2])
    hour = int(code[2:4])
    minute = int(code[4:6]) if with_minutes else 0
    candidates: list[datetime] = []
    for delta in (-1, 0, 1):
        year, month = shifted_month(ref, delta)
        if day > calendar.monthrange(year, month)[1]:
            continue
        candidates.append(datetime(year, month, day, hour, minute, tzinfo=timezone.utc))
    if not candidates:
        raise ValueError(f"cannot resolve TAF time group {code}")
    return min(candidates, key=lambda x: abs((x - ref).total_seconds()))


def parse_times(raw: str, ref: datetime) -> tuple[datetime, datetime | None, datetime | None]:
    issue_match = re.search(r"\b(\d{6})Z\b", raw)
    valid_match = re.search(r"\b(\d{4})/(\d{4})\b", raw)
    if not issue_match:
        raise ValueError("TAF EPIR has no issue time")

    issue = resolve_group(issue_match.group(1), ref, with_minutes=True)
    if not valid_match:
        return issue, None, None

    valid_start = resolve_group(valid_match.group(1), issue)
    valid_end = resolve_group(valid_match.group(2), valid_start)
    if valid_end <= valid_start:
        # Re-resolve the end group against a reference safely inside the next day/month.
        valid_end = resolve_group(valid_match.group(2), valid_start.replace(hour=12) + __import__('datetime').timedelta(hours=18))
    return issue, valid_start, valid_end


def read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def make_record(row: dict) -> dict:
    raw = re.sub(r"\s+", " ", str(row.get("raw") or "")).strip()
    if not re.match(r"^TAF(?:\s+(?:AMD|COR))?\s+EPIR\b", raw, flags=re.I):
        raise ValueError("cache does not contain a valid EPIR TAF")
    if not raw.endswith("="):
        raw += "="

    source_updated = row.get("updated_at")
    try:
        ref = datetime.fromisoformat(str(source_updated).replace("Z", "+00:00")) if source_updated else utcnow()
    except Exception:
        ref = utcnow()
    issue, valid_start, valid_end = parse_times(raw, ref)

    return {
        "schema": "prognozaepir-epir-taf-record-v1",
        "station": "EPIR",
        "kind": "official",
        "raw": raw,
        "source": row.get("source"),
        "source_url": row.get("source_url"),
        "source_updated_at": source_updated,
        "issue_time": iso(issue),
        "valid_start": iso(valid_start) if valid_start else None,
        "valid_end": iso(valid_end) if valid_end else None,
    }


def write_latest(record: dict) -> bool:
    payload = {
        "schema": "prognozaepir-epir-taf-latest-v1",
        "station": "EPIR",
        "taf": record,
    }
    old = read_json(LATEST)
    if old == payload:
        return False
    LATEST.parent.mkdir(parents=True, exist_ok=True)
    LATEST.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return True


def append_archive(record: dict) -> tuple[bool, Path]:
    issue = datetime.fromisoformat(record["issue_time"].replace("Z", "+00:00"))
    path = ARCHIVE_ROOT / f"{issue:%Y}" / f"{issue:%m}" / f"{issue:%d}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)

    existing: list[dict] = []
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                existing.append(json.loads(line))
            except Exception:
                continue
    if any(x.get("raw") == record.get("raw") for x in existing):
        return False, path

    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    return True, path


def main() -> int:
    cache = read_json(CACHE)
    row = (cache.get("stations") or {}).get("EPIR") or {}
    if not row.get("raw"):
        print("No EPIR TAF in data/taf/neighbors.json; archive unchanged")
        return 0

    record = make_record(row)
    latest_changed = write_latest(record)
    archive_changed, archive_path = append_archive(record)

    print("EPIR TAF:", record["raw"])
    print("latest:", "updated" if latest_changed else "unchanged", LATEST)
    print("archive:", "appended" if archive_changed else "already present", archive_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
