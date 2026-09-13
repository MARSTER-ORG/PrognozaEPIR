#!/usr/bin/env python3
"""Finalize the central TAF archive policy for PrognozaEPIR TAF Engine v2.

TAF Engine v2 is split between taf.html and taf-app-v2.js. The finalizer must
therefore maintain archive views and validate the MessageArchive boundary, but
must never patch frontend JavaScript into taf.html during an ingest cycle.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "data" / "messages"
TAF_HISTORY = ARCHIVE / "taf"
NEIGHBOR_STAGING = ROOT / "data" / "taf" / "neighbors.json"
NEIGHBOR_SNAPSHOT = ARCHIVE / "taf-neighbors.json"
NEIGHBORS = ("EPBY", "EPPW", "EPKS")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: datetime | None) -> str | None:
    if not value:
        return None
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_dt(value) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value or "").replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return None


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path: Path, value, pretty: bool = True) -> bool:
    text = json.dumps(
        value,
        ensure_ascii=False,
        indent=2 if pretty else None,
        separators=None if pretty else (",", ":"),
        sort_keys=True,
    ) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return True


def read_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def write_jsonl(path: Path, rows: list[dict]) -> None:
    text = "".join(
        json.dumps(row, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"
        for row in rows
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def normalize_raw(raw: str) -> str:
    text = re.sub(r"\s+", " ", str(raw or "")).strip()
    if text and not text.endswith("="):
        text += "="
    return text


def resolve_issue(raw: str, ref: datetime) -> datetime | None:
    match = re.search(r"\b(\d{2})(\d{2})(\d{2})Z\b", raw)
    if not match:
        return None
    day, hour, minute = map(int, match.groups())
    candidates: list[datetime] = []
    for month_delta in (-1, 0, 1):
        year, month = ref.year, ref.month + month_delta
        if month < 1:
            year -= 1
            month += 12
        elif month > 12:
            year += 1
            month -= 12
        try:
            candidates.append(datetime(year, month, day, hour, minute, tzinfo=timezone.utc))
        except ValueError:
            pass
    return min(candidates, key=lambda item: abs((item - ref).total_seconds())) if candidates else None


def snapshot_record(station: str, row: dict) -> dict | None:
    raw = normalize_raw(row.get("raw"))
    if not raw or not re.search(rf"\bTAF(?:\s+(?:AMD|COR))?\s+{re.escape(station)}\b", raw, re.I):
        return None
    ref = parse_dt(row.get("updated_at")) or utcnow()
    issue = resolve_issue(raw, ref) or ref
    message_id = hashlib.sha256(f"TAF\n{station}\n{raw}".encode()).hexdigest()
    return {
        "schema": "prognozaepir-message-v1",
        "message_id": message_id,
        "type": "TAF",
        "station": station,
        "message_time": iso(issue),
        "issue_time": iso(issue),
        "canonical_raw": raw,
        "raw": raw,
        "source": row.get("source") or "NEIGHBOR_TAF_CURRENT",
        "source_url": row.get("source_url"),
        "available": bool(row.get("available", True)),
        "stale": bool(row.get("stale", False)),
        "snapshot_only": True,
        "sources": [{
            "name": row.get("source") or "NEIGHBOR_TAF_CURRENT",
            **({"url": str(row.get("source_url"))} if row.get("source_url") else {}),
        }],
    }


def prune_neighbor_taf_history() -> tuple[int, int]:
    removed = 0
    kept = 0
    if not TAF_HISTORY.exists():
        return removed, kept
    for path in sorted(TAF_HISTORY.rglob("*.jsonl")):
        rows = read_jsonl(path)
        keep = [row for row in rows if str(row.get("station") or "").upper() == "EPIR"]
        removed += len(rows) - len(keep)
        kept += len(keep)
        if keep:
            keep.sort(key=lambda row: (row.get("message_time", ""), row.get("message_id", "")))
            if keep != rows:
                write_jsonl(path, keep)
        elif path.exists():
            path.unlink()
    return removed, kept


def all_epir_tafs() -> list[dict]:
    rows: list[dict] = []
    if TAF_HISTORY.exists():
        for path in sorted(TAF_HISTORY.rglob("*.jsonl")):
            rows.extend(
                row for row in read_jsonl(path)
                if str(row.get("station") or "").upper() == "EPIR"
            )
    return sorted(rows, key=lambda row: (row.get("message_time", ""), row.get("message_id", "")))


def build_neighbor_snapshot() -> dict:
    old = read_json(NEIGHBOR_SNAPSHOT, {})
    staged = read_json(NEIGHBOR_STAGING, {})
    old_stations = old.get("stations") or {}
    staged_stations = staged.get("stations") or {}
    stations: dict[str, dict] = {}
    for station in NEIGHBORS:
        fresh = snapshot_record(station, staged_stations.get(station) or {})
        if fresh:
            stations[station] = fresh
        elif isinstance(old_stations.get(station), dict) and old_stations[station].get("raw"):
            stations[station] = old_stations[station]
    payload = {
        "schema": "prognozaepir-taf-neighbors-current-v1",
        "archive": "data/messages",
        "history": False,
        "purpose": "current directional context for EPIR generator; not learning data",
        "updated_at": staged.get("updated_at") or old.get("updated_at") or iso(utcnow()),
        "stations": stations,
    }
    write_json(NEIGHBOR_SNAPSHOT, payload)
    return payload


def refresh_views(snapshot: dict) -> None:
    latest_path = ARCHIVE / "latest.json"
    recent_path = ARCHIVE / "recent.json"
    status_path = ARCHIVE / "status.json"
    latest = read_json(latest_path, {})
    recent = read_json(recent_path, {})
    status = read_json(status_path, {})

    epir = all_epir_tafs()
    epir_latest = epir[-1] if epir else None
    cutoff = utcnow() - timedelta(hours=72)
    epir_recent = [
        row for row in epir
        if (parse_dt(row.get("message_time")) or datetime.min.replace(tzinfo=timezone.utc)) >= cutoff
    ]

    taf_by_station: dict[str, dict] = {}
    if epir_latest:
        taf_by_station["EPIR"] = epir_latest
    for station, row in (snapshot.get("stations") or {}).items():
        if row.get("raw"):
            taf_by_station[station] = row

    latest["taf"] = epir_latest
    latest["taf_by_station"] = taf_by_station
    latest["taf_neighbors_current"] = snapshot.get("stations") or {}

    candidates = [
        latest.get("aviation"),
        latest.get("synop"),
        epir_latest,
        *((snapshot.get("stations") or {}).values()),
    ]
    times = [row.get("message_time") for row in candidates if isinstance(row, dict) and row.get("message_time")]
    if times:
        latest["updated_at"] = max(times)

    recent["taf"] = epir_recent
    recent["taf_neighbors_current"] = snapshot.get("stations") or {}

    counts = dict(status.get("counts") or {})
    counts["taf"] = len(epir)
    latest_times = dict(status.get("latest") or {})
    latest_times["taf"] = epir_latest.get("message_time") if epir_latest else None
    status["counts"] = counts
    status["latest"] = latest_times
    status["taf_history_scope"] = "EPIR only"
    status["taf_neighbors"] = "current snapshot only; not archived; not learning data"
    if latest.get("updated_at"):
        status["archive_updated_at"] = latest["updated_at"]

    write_json(latest_path, latest)
    write_json(recent_path, recent, pretty=False)
    write_json(status_path, status)


def validate_taf_frontend() -> str:
    html_path = ROOT / "taf.html"
    app_path = ROOT / "taf-app-v2.js"
    if not html_path.exists() or not app_path.exists():
        raise RuntimeError("TAF Engine v2 frontend files are missing")

    html = html_path.read_text(encoding="utf-8")
    app = app_path.read_text(encoding="utf-8")
    if "prognozaepir-taf-engine-v2" not in html or "taf-app-v2.js" not in html:
        raise RuntimeError("taf.html is not the expected TAF Engine v2 shell")
    if "message-archive-client.js" not in html:
        raise RuntimeError("TAF Engine v2 is missing message-archive-client.js")

    required = (
        "PrognozaEPIRMessageArchive",
        "A.latest(true)",
        "A.recent(true)",
        "A.getLatest?.('TAF'",
    )
    missing = [token for token in required if token not in app]
    if missing:
        raise RuntimeError("TAF Engine v2 MessageArchive boundary incomplete: " + ", ".join(missing))

    forbidden = (
        "aviation-api.imgw.pl",
        "awiacja.imgw.pl",
        "aviationweather.gov/api/data/taf",
        "/api/taf-proxy",
        "loadImgwLive(",
    )
    bad = [token for token in forbidden if token in app]
    if bad:
        raise RuntimeError("TAF Engine v2 contains direct bulletin acquisition: " + ", ".join(bad))
    return "external-v2"


def validate_verifier_file() -> None:
    path = ROOT / "taf-verification.js"
    if not path.exists():
        return
    text = path.read_text(encoding="utf-8")
    required = (
        "CENTRAL_RAW_BASE",
        "centralDayUrls(kind,day)",
        "fetchMetarDay(day)",
        "fetchTafIssueDay(day)",
    )
    missing = [token for token in required if token not in text]
    if missing:
        raise RuntimeError("TAF verifier central archive boundary incomplete: " + ", ".join(missing))


def main() -> int:
    removed, kept = prune_neighbor_taf_history()
    snapshot = build_neighbor_snapshot()
    refresh_views(snapshot)
    frontend_mode = validate_taf_frontend()
    validate_verifier_file()
    print(json.dumps({
        "taf_history_epir": kept,
        "neighbor_taf_history_removed": removed,
        "neighbor_snapshot_stations": sorted((snapshot.get("stations") or {}).keys()),
        "taf_html_native_message_archive": True,
        "taf_frontend_mode": frontend_mode,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
