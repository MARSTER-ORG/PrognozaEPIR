#!/usr/bin/env python3
"""Mirror a validated Railway archive snapshot into durable GitHub data.

Railway supplies live acquisition. GitHub is the durable archive. JSONL history
is merged append-only so a stale Railway deployment image can never remove a
message that is already durable in GitHub.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from archive_jsonl_merge import merge_jsonl_bytes

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE_ROOT = ROOT / "data" / "messages"
DEFAULT_BASE = "https://central-ingestor-production.up.railway.app"


def get(url: str, attempts: int = 3) -> bytes:
    last: Exception | None = None
    for index in range(attempts):
        try:
            request = urllib.request.Request(
                url,
                headers={"Accept": "application/json", "User-Agent": "PrognozaEPIR-GitHub-Mirror/4"},
            )
            with urllib.request.urlopen(request, timeout=20) as response:
                return response.read()
        except Exception as exc:  # network errors are retried and then fail closed
            last = exc
            if index + 1 < attempts:
                time.sleep(2 + index * 2)
    raise RuntimeError(f"GET failed: {url}: {last}")


def neighbor_file_day(rel: str) -> date | None:
    parts = rel.split("/")
    if len(parts) != 5 or parts[0] != "neighbors" or not parts[4].endswith(".jsonl"):
        return None
    try:
        return date(int(parts[2]), int(parts[3]), int(parts[4][:-6]))
    except (TypeError, ValueError):
        return None


def wanted(rel: str, neighbor_mode: str, neighbor_keep_days: int, today: date | None = None) -> bool:
    if rel in {"latest.json", "recent.json", "taf-neighbors.json", "neighbors/latest.json"}:
        return True
    if rel.startswith(("metar/", "speci/", "synop/", "taf/")):
        return rel.endswith((".json", ".jsonl"))
    if not rel.startswith("neighbors/"):
        return False
    if rel.endswith(".json"):
        return True
    if not rel.endswith(".jsonl"):
        return False
    if neighbor_mode == "normal":
        return True
    day = neighbor_file_day(rel)
    if day is None:
        return False
    reference = today or datetime.now(timezone.utc).date()
    cutoff = reference - timedelta(days=max(0, neighbor_keep_days))
    return day >= cutoff


def mirror_snapshot(base: str, root: Path, neighbor_mode: str, neighbor_keep_days: int) -> dict:
    base = base.rstrip("/")
    root.mkdir(parents=True, exist_ok=True)

    manifest = json.loads(get(base + "/archive-manifest").decode("utf-8"))
    if manifest.get("schema") != "prognozaepir-message-archive-manifest-v1":
        raise RuntimeError("unexpected archive manifest schema")

    changed = 0
    checked = 0
    source_gap_files = 0
    source_gap_rows = 0
    added_rows = 0
    conflict_rows = 0

    for item in manifest.get("files") or []:
        rel = str(item.get("path") or "")
        expected = str(item.get("sha256") or "")
        if not wanted(rel, neighbor_mode, neighbor_keep_days) or len(expected) != 64:
            continue
        checked += 1
        dest = root / rel

        # Exact snapshots need no work. Append-only JSONL unions can intentionally
        # differ from Railway when GitHub preserves rows missing at the live source.
        if dest.is_file() and hashlib.sha256(dest.read_bytes()).hexdigest() == expected:
            continue

        quoted = "/".join(urllib.parse.quote(part, safe="") for part in rel.split("/"))
        incoming = get(base + "/data/messages/" + quoted)
        actual = hashlib.sha256(incoming).hexdigest()
        if actual != expected:
            raise RuntimeError(
                f"snapshot changed during mirror: {rel}; expected {expected}, got {actual}; refusing partial commit"
            )

        output = incoming
        previous: bytes | None = None
        if dest.is_file():
            previous = dest.read_bytes()

        if rel.endswith(".jsonl") and previous is not None:
            output, stats = merge_jsonl_bytes(previous, incoming)
            added_rows += stats.added_rows
            conflict_rows += stats.conflicting_rows
            if stats.preserved_missing_rows:
                source_gap_files += 1
                source_gap_rows += stats.preserved_missing_rows
                print(
                    f"source gap preserved for {rel}: Railway missing "
                    f"{stats.preserved_missing_rows} durable row(s); added={stats.added_rows}; "
                    f"conflicts={stats.conflicting_rows}",
                    flush=True,
                )
            elif stats.conflicting_rows:
                print(
                    f"durable payload conflict preserved for {rel}: conflicts={stats.conflicting_rows}",
                    flush=True,
                )

        if previous == output:
            continue

        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name("." + dest.name + ".mirror.tmp")
        tmp.write_bytes(output)
        os.replace(tmp, dest)
        changed += 1

    result = {
        "generated_at": manifest.get("generated_at"),
        "checked": checked,
        "changed": changed,
        "neighbor_mode": neighbor_mode,
        "source_gap_files": source_gap_files,
        "source_gap_rows_preserved": source_gap_rows,
        "new_jsonl_rows_added": added_rows,
        "conflicting_rows_preserved": conflict_rows,
    }
    print("validated Railway manifest: " + json.dumps(result, sort_keys=True), flush=True)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default=os.getenv("ARCHIVE_BASE", DEFAULT_BASE))
    parser.add_argument("--root", type=Path, default=ARCHIVE_ROOT)
    parser.add_argument("--neighbor-mode", default=os.getenv("NEIGHBOR_ARCHIVE_MODE", "normal"))
    parser.add_argument(
        "--neighbor-keep-days",
        type=int,
        default=int(os.getenv("NEIGHBOR_RETENTION_DAYS", "0") or 0),
    )
    args = parser.parse_args()

    mode = args.neighbor_mode.strip().lower()
    if mode not in {"normal", "rolling", "external"}:
        raise SystemExit(f"unknown neighbor archive mode: {mode}")
    mirror_snapshot(args.base, args.root, mode, max(0, args.neighbor_keep_days))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
