#!/usr/bin/env python3
"""Materialize canonical EPIR 2020-2024 aviation truth into data/messages.

The corrected v2 historical archive remains the authority.  This script only
creates an ephemeral repository-shaped view so the normal forecast verifier can
consume 2020-2024 observations together with rolling 2025-2026 messages.
It never reparses the raw annual DOCX/ZIP sources and it never changes labels.
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

import fog_vnext_event_backfill as hist
import model_verification as mv

YEARS = set(range(2020, 2025))


def report_type(row):
    value = str(row.get("type") or row.get("report_type") or row.get("message_type") or "").upper()
    if "SPECI" in value:
        return "speci"
    return "metar"


def materialize():
    rows = hist.load_historical_training_rows()
    if not rows:
        raise RuntimeError(f"canonical history missing: {hist.HISTORY_ARCHIVE}")

    grouped = defaultdict(dict)
    skipped = 0
    for row in rows:
        dt = hist._obs_dt(row)
        if not dt or dt.year not in YEARS:
            skipped += 1
            continue
        raw = str(row.get("canonical_raw") or row.get("raw") or "")
        key = (mv.iso(dt), raw)
        grouped[(report_type(row), dt.year, dt.month, dt.day)][key] = dict(row)

    written = 0
    by_type = defaultdict(int)
    by_year = defaultdict(int)
    for (kind, year, month, day), keyed in sorted(grouped.items()):
        path = mv.ROOT / "data" / "messages" / kind / f"{year:04d}" / f"{month:02d}" / f"{day:02d}.jsonl"
        existing = {}
        if path.exists():
            for row in mv.load_jsonl(path):
                dt = hist._obs_dt(row)
                if not dt:
                    continue
                raw = str(row.get("canonical_raw") or row.get("raw") or "")
                existing[(mv.iso(dt), raw)] = row
        existing.update(keyed)
        ordered = sorted(existing.values(), key=lambda r: mv.iso(hist._obs_dt(r)) if hist._obs_dt(r) else "")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in ordered), encoding="utf-8")
        written += len(keyed)
        by_type[kind] += len(keyed)
        by_year[year] += len(keyed)

    result = {
        "schema": "prognozaepir-fog-vnext-materialized-truth-v1",
        "source": str(hist.HISTORY_ARCHIVE.relative_to(mv.ROOT)),
        "source_rows": len(rows),
        "materialized_rows": written,
        "skipped_rows": skipped,
        "by_type": dict(sorted(by_type.items())),
        "by_year": {str(k): v for k, v in sorted(by_year.items())},
    }
    print(json.dumps(result, ensure_ascii=False))
    if set(by_year) != YEARS:
        raise RuntimeError(f"canonical history did not cover every year 2020-2024: {sorted(by_year)}")
    return result


if __name__ == "__main__":
    materialize()
