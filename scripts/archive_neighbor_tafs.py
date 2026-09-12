#!/usr/bin/env python3
"""Archive EPBY/EPPW/EPKS TAFs already present in the shared neighbor snapshot.

This adapter performs no network requests. It runs after collect/sanitize and
persists each distinct neighboring TAF into the GitHub MessageArchive namespace
used only as contextual/history data; EPIR TAF history and counts stay separate.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from collect_neighbor_tafs import iso_dt, normalize_taf, taf_issue_ts, taf_validity

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = ROOT / "data" / "taf" / "neighbors.json"
OUT = ROOT / "data" / "messages" / "neighbors" / "taf"
STATIONS = ("EPBY", "EPPW", "EPKS")


def utc_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(
        "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows),
        encoding="utf-8",
    )
    tmp.replace(path)


def build_record(station: str, row: dict) -> dict | None:
    raw = normalize_taf(row.get("raw") or "")
    issue_ts = taf_issue_ts(raw)
    if not raw or not issue_ts:
        return None
    issue = datetime.fromtimestamp(issue_ts, tz=timezone.utc)
    age_h = (datetime.now(timezone.utc) - issue).total_seconds() / 3600.0
    if age_h < -1.5 or age_h > 36:
        return None
    valid_start, valid_end = taf_validity(raw, issue)
    message_id = hashlib.sha256(f"TAF|{station}|{raw}".encode("utf-8")).hexdigest()
    return {
        "schema": "prognozaepir-neighbor-taf-record-v1",
        "message_id": message_id,
        "id": message_id,
        "type": "TAF",
        "station": station,
        "kind": "contextual",
        "raw": raw,
        "canonical_raw": raw,
        "message_time": iso_dt(issue),
        "issue_time": iso_dt(issue),
        "valid_start": iso_dt(valid_start) if valid_start else None,
        "valid_end": iso_dt(valid_end) if valid_end else None,
        "source": row.get("source") or "NEIGHBOR_TAF_COLLECTOR",
        "source_url": row.get("source_url"),
        "source_updated_at": row.get("updated_at"),
        "collected_at": utc_iso(),
    }


def main() -> int:
    if not SNAPSHOT.exists():
        print("neighbor TAF archive: snapshot missing; nothing to do")
        return 0
    try:
        payload = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"neighbor TAF archive: invalid snapshot: {type(exc).__name__}: {exc}")
        return 0

    stations = payload.get("stations") or {}
    added = 0
    for station in STATIONS:
        record = build_record(station, stations.get(station) or {})
        if not record:
            continue
        issue = datetime.fromisoformat(record["issue_time"].replace("Z", "+00:00"))
        path = OUT / station.lower() / f"{issue:%Y}" / f"{issue:%m}" / f"{issue:%d}.jsonl"
        rows = read_jsonl(path)
        if any(
            old.get("message_id") == record["message_id"]
            or normalize_taf(old.get("raw") or "") == record["canonical_raw"]
            for old in rows
        ):
            continue
        rows.append(record)
        rows.sort(key=lambda x: (x.get("issue_time") or "", x.get("message_id") or ""))
        write_jsonl(path, rows)
        added += 1
        print(f"neighbor TAF archive: +1 {station} {record['issue_time']} {record['canonical_raw']}")

    print(f"neighbor TAF archive: added={added}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
