#!/usr/bin/env python3
"""Rebuild data/messages/status.json from physical durable JSONL records."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ARCHIVE = ROOT / "data" / "messages"


def rebuild(root: Path, neighbor_mode: str, neighbor_keep_days: int) -> dict:
    folders = {
        "metar": "METAR",
        "speci": "SPECI",
        "synop": "SYNOP",
        "taf": "TAF",
    }
    counts: dict[str, int] = {}
    latest: dict[str, str | None] = {}

    for folder, kind in folders.items():
        count = 0
        newest: str | None = None
        base = root / folder
        if base.exists():
            for path in sorted(base.rglob("*.jsonl")):
                for raw_line in path.read_text(encoding="utf-8").splitlines():
                    if not raw_line.strip():
                        continue
                    row = json.loads(raw_line)
                    if row.get("type") != kind:
                        raise RuntimeError(f"unexpected type in {path}: {row.get('type')} != {kind}")
                    if kind == "TAF" and str(row.get("station") or "").upper() != "EPIR":
                        raise RuntimeError(f"neighbor TAF leaked into history: {path}")
                    count += 1
                    message_time = str(row.get("message_time") or "")
                    if message_time and (newest is None or message_time > newest):
                        newest = message_time
        counts[folder] = count
        latest[folder] = newest

    latest_view: dict = {}
    latest_path = root / "latest.json"
    if latest_path.exists():
        latest_view = json.loads(latest_path.read_text(encoding="utf-8"))
    archive_updated_at = latest_view.get("updated_at") or max((x for x in latest.values() if x), default=None)

    if neighbor_mode == "normal":
        neighbor_policy = "full Git history; durable Supabase copy"
    else:
        neighbor_policy = f"{neighbor_keep_days}-day Git hot window; durable Supabase copy; mode={neighbor_mode}"

    payload = {
        "schema": "prognozaepir-message-archive-status-v1",
        "archive": "data/messages",
        "types": ["METAR", "SPECI", "TAF", "SYNOP"],
        "counts": counts,
        "latest": latest,
        "archive_updated_at": archive_updated_at,
        "deduplication": "sha256(type + station + canonical_raw)",
        "legacy_archives_authoritative": False,
        "taf_history_scope": "EPIR only",
        "taf_neighbors": "current snapshot only; not archived; not learning data",
        "neighbor_observations": (
            f"EPBY/EPPW/EPKS METAR/SPECI context; {neighbor_policy}; excluded from EPIR counts"
        ),
    }

    dest = root / "status.json"
    text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if not dest.exists() or dest.read_text(encoding="utf-8") != text:
        tmp = dest.with_name(".status.json.rebuild.tmp")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, dest)
        print("status.json rebuilt from physical JSONL records:", counts)
    else:
        print("status.json already correct:", counts)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=DEFAULT_ARCHIVE)
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
    rebuild(args.root, mode, max(0, args.neighbor_keep_days))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
