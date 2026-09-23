#!/usr/bin/env python3
"""Finalize the central archive and validate the active TAF v25/v243 runtime.

The finalizer maintains archive views and checks the frontend contract, but it
must never patch frontend JavaScript into taf.html during an ingest cycle.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
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


class TafRuntimeParser(HTMLParser):
    """Extract executable script wiring while deliberately ignoring comments."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta_version: str | None = None
        self.script_sources: list[str] = []
        self.inline_scripts: list[str] = []
        self._inline: list[str] | None = None

    def handle_starttag(self, tag: str, attrs) -> None:
        values = dict(attrs)
        if tag.lower() == "meta" and values.get("name") == "prognozaepir-taf-engine-v2":
            self.meta_version = values.get("content")
        if tag.lower() != "script":
            return
        src = values.get("src")
        if src:
            self.script_sources.append(src)
            self._inline = None
        else:
            self._inline = []

    def handle_data(self, data: str) -> None:
        if self._inline is not None:
            self._inline.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "script" and self._inline is not None:
            self.inline_scripts.append("".join(self._inline))
            self._inline = None


def asset_name(src: str) -> str:
    return src.split("?", 1)[0].rsplit("/", 1)[-1]


def strip_js_comments(source: str) -> str:
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    source = re.sub(r"<!--.*?-->", "", source, flags=re.S)
    return re.sub(r"(^|[;{}\s])//[^\r\n]*", r"\1", source, flags=re.M)


def require_file(root: Path, name: str) -> str:
    path = root / name
    if not path.is_file():
        raise RuntimeError(f"active TAF runtime file is missing: {name}")
    return path.read_text(encoding="utf-8")


def validate_taf_frontend(root: Path = ROOT) -> str:
    html = require_file(root, "taf.html")
    app = require_file(root, "taf-app-v25.js")
    engine = require_file(root, "taf-engine-v243.js")
    policy = require_file(root, "taf-fog-policy.js")

    parser = TafRuntimeParser()
    parser.feed(html)
    if parser.meta_version != "2.4.3":
        raise RuntimeError(f"TAF UI version mismatch: expected 2.4.3, got {parser.meta_version or 'missing'}")

    active_assets = [asset_name(src) for src in parser.script_sources]
    required_static = (
        "message-archive-client.js",
        "taf-fog-policy.js",
        "taf-engine-v2.js",
        "taf-engine-v24.js",
        "taf-engine-v241.js",
        "taf-engine-v242.js",
    )
    missing_static = [name for name in required_static if name not in active_assets]
    if missing_static:
        raise RuntimeError("TAF static runtime incomplete: " + ", ".join(missing_static))
    positions = [active_assets.index(name) for name in required_static]
    if positions != sorted(positions):
        raise RuntimeError("TAF static runtime scripts are loaded in the wrong order")
    if "taf-app-v2.js" in active_assets:
        raise RuntimeError("legacy taf-app-v2.js is active in taf.html")

    dynamic_calls: list[tuple[str, str, str]] = []
    pattern = re.compile(
        r"await\s+loadScript\(\s*['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]\s*\)"
    )
    for script in parser.inline_scripts:
        executable = strip_js_comments(script)
        for src, element_id in pattern.findall(executable):
            dynamic_calls.append((asset_name(src), element_id, executable))
    dynamic_assets = [name for name, _element_id, _script in dynamic_calls]
    for name in ("taf-engine-v243.js", "taf-app-v25.js"):
        if name not in dynamic_assets:
            raise RuntimeError(f"active TAF bootstrap does not load {name}")
    if dynamic_assets.index("taf-engine-v243.js") > dynamic_assets.index("taf-app-v25.js"):
        raise RuntimeError("TAF v25 application loads before TAF Engine v243")

    bootstrap = next(script for name, _element_id, script in dynamic_calls if name == "taf-engine-v243.js")
    bootstrap_required = (
        "__PROGNOZA_EPIR_TAF_ENGINE_V243__",
        "PrognozaEPIRTAFEngine?.QUALITY_VERSION!=='2.4.3'",
        "__PROGNOZA_EPIR_TAF_APP_V25__",
    )
    missing_bootstrap = [token for token in bootstrap_required if token not in re.sub(r"\s+", "", bootstrap)]
    if missing_bootstrap:
        raise RuntimeError("TAF active bootstrap guards incomplete: " + ", ".join(missing_bootstrap))

    engine_required = (
        "const VERSION='2.4.3'",
        "QUALITY_VERSION:VERSION",
        "root.__PROGNOZA_EPIR_TAF_ENGINE_V243__=true",
        "requires taf-engine-v242.js",
    )
    missing_engine = [token for token in engine_required if token not in engine]
    if missing_engine:
        raise RuntimeError("TAF Engine v243 contract incomplete: " + ", ".join(missing_engine))

    app_required = (
        "window.__PROGNOZA_EPIR_TAF_APP_V25__ = true",
        "const APP_ENGINE_VERSION='2.4.3'",
        "api.QUALITY_VERSION!==APP_ENGINE_VERSION",
        "PrognozaEPIRMessageArchive",
        "A.latest(true)",
        "A.recent(true)",
        "A.getLatest?.('TAF'",
    )
    missing_app = [token for token in app_required if token not in app]
    if missing_app:
        raise RuntimeError("TAF v25 application contract incomplete: " + ", ".join(missing_app))
    if "TAF ENGINE 2.4.2" in app or "[TAF Engine 2.4.2]" in app:
        raise RuntimeError("TAF v25 UI labels do not match active Engine 2.4.3")

    build_match = re.search(r"\bconst\s+BUILD\s*=\s*['\"]([^'\"]+)['\"]", policy)
    html_build_match = re.search(r"\bREQUIRED_FOG_POLICY_BUILD\s*=\s*['\"]([^'\"]+)['\"]", bootstrap)
    if not build_match or not html_build_match or build_match.group(1) != html_build_match.group(1):
        raise RuntimeError("TAF Fog Policy build differs between policy and active bootstrap")

    forbidden = (
        "aviation-api.imgw.pl",
        "awiacja.imgw.pl",
        "aviationweather.gov/api/data/taf",
        "/api/taf-proxy",
        "loadImgwLive(",
    )
    bad = [token for token in forbidden if token in app]
    if bad:
        raise RuntimeError("TAF v25 contains direct bulletin acquisition: " + ", ".join(bad))
    return "v25-v243"


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
