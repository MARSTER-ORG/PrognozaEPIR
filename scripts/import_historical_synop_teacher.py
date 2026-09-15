#!/usr/bin/env python3
"""Import the corrected 2020-2024 SYNOP teacher into data/messages/synop.

The Fog Engine historical handoff contains a normalized SYNOP teacher stream
alongside the canonical METAR/SPECI truth.  SYNOP is intentionally imported as
an auxiliary observation/teacher source: it can enrich missing T/Td/RH/VIS/
cloud context and act as verification fallback, but it does not redefine the
canonical aviation fog_truth labels.
"""
from __future__ import annotations

import argparse
import io
import json
import sys
import zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import collect_epir_observations as obs  # noqa: E402
import message_archive as archive  # noqa: E402

HISTORY_ARCHIVE = ROOT / "data" / "import" / "epir-history" / "fog_training_2020_2024_corrected_v2.zip"
MEMBER_BASENAME = "synop_teacher_2020_2024.jsonl"
SOURCE_NAME = "EPIR_HISTORY_SYNOP_TEACHER_2020_2024"
EXPECTED_YEARS = set(range(2020, 2025))


def parse_time(value: object) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def row_time(row: dict) -> datetime | None:
    for key in ("obs_time", "message_time", "time", "timestamp", "datetime", "valid_time"):
        dt = parse_time(row.get(key))
        if dt:
            return dt
    return None


def row_raw(row: dict) -> str:
    for key in ("canonical_raw", "raw", "message", "text"):
        value = str(row.get(key) or "").strip()
        if value:
            return value
    return ""


def load_teacher(path: Path = HISTORY_ARCHIVE) -> tuple[list[dict], str]:
    if not path.exists():
        raise FileNotFoundError(path)
    try:
        with zipfile.ZipFile(path) as zf:
            member = next((name for name in zf.namelist() if Path(name).name == MEMBER_BASENAME), None)
            if not member:
                raise RuntimeError(f"{path} does not contain {MEMBER_BASENAME}")
            rows: list[dict] = []
            with zf.open(member, "r") as raw:
                with io.TextIOWrapper(raw, encoding="utf-8-sig") as text:
                    for lineno, line in enumerate(text, 1):
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            obj = json.loads(line)
                        except json.JSONDecodeError as exc:
                            raise RuntimeError(f"invalid JSON {member}:{lineno}: {exc}") from exc
                        if not isinstance(obj, dict):
                            raise RuntimeError(f"non-object JSON {member}:{lineno}")
                        rows.append(obj)
            return rows, member
    except zipfile.BadZipFile as exc:
        raise RuntimeError(f"invalid historical training archive: {path}") from exc


def canonicalize(row: dict, source_ref: str) -> dict | None:
    when = row_time(row)
    raw = row_raw(row)
    if not when or not raw:
        return None
    if when.year not in EXPECTED_YEARS:
        raise RuntimeError(f"historical SYNOP teacher row outside 2020-2024: {when.isoformat()} {raw[:80]}")

    decoded = obs.decode_synop(raw, when)
    if decoded:
        candidate = decoded
        # Preserve useful fields already present in the corrected teacher when
        # the decoder does not expose them.
        for key, value in row.items():
            if value not in (None, "") and candidate.get(key) in (None, ""):
                candidate[key] = value
    else:
        candidate = dict(row)
        candidate["raw"] = raw
        candidate["obs_time"] = when.isoformat().replace("+00:00", "Z")
        candidate["station"] = str(row.get("station") or "12342")

    candidate["source"] = SOURCE_NAME
    candidate["archive_source_file"] = source_ref
    candidate["source_file"] = source_ref
    return archive.norm(candidate, "SYNOP", source_ref)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive", type=Path, default=HISTORY_ARCHIVE)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    rows, member = load_teacher(args.archive)
    source_ref = f"{args.archive.relative_to(ROOT)}::{member}" if args.archive.is_relative_to(ROOT) else f"{args.archive}::{member}"

    canonical: list[dict] = []
    rejected: list[dict] = []
    years: Counter[int] = Counter()
    for i, row in enumerate(rows, 1):
        msg = canonicalize(row, source_ref)
        if not msg:
            rejected.append({"row": i, "time": row.get("obs_time") or row.get("message_time"), "raw": row_raw(row)[:120]})
            continue
        years[parse_time(msg["message_time"]).year] += 1
        canonical.append(msg)

    if rejected:
        print(json.dumps({"rejected_count": len(rejected), "examples": rejected[:20]}, ensure_ascii=False), file=sys.stderr)
        raise RuntimeError(f"refusing partial historical SYNOP import: {len(rejected)} rows could not be normalized")
    if set(years) != EXPECTED_YEARS:
        raise RuntimeError(f"historical SYNOP teacher coverage mismatch: years={sorted(years)} expected={sorted(EXPECTED_YEARS)}")

    report = {
        "schema": "prognozaepir-historical-synop-import-v1",
        "source_archive": str(args.archive.relative_to(ROOT)) if args.archive.is_relative_to(ROOT) else str(args.archive),
        "source_member": member,
        "source_rows": len(rows),
        "normalized": len(canonical),
        "rows_by_year": {str(k): years[k] for k in sorted(years)},
        "dry_run": bool(args.dry_run),
    }
    if args.dry_run:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
        return 0

    stat = archive.ingest(canonical)
    counts = archive.views(stat, full=True)
    checked = archive.validate()
    report.update(ingest=stat, archive_counts=counts, checked_records=checked)
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
