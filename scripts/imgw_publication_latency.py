#!/usr/bin/env python3
"""Persistent IMGW publication-latency telemetry for EPIR METAR/SPECI.

The lightweight IMGW probe calls ``observe()`` after every successful API read.
For each bulletin first seen after the monitor baseline, we store the interval
between the previous successful probe (bulletin absent) and the current probe
(bulletin present). This gives bounded publication latency instead of pretending
the exact IMGW publication second is known.

Only METAR/SPECI from the official IMGW Aviation API are measured. The journal
lives under data/messages so the existing validated archive mirror makes it
durable on GitHub without a second persistence service.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import statistics
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "messages" / "telemetry" / "imgw-publication"
STATE = OUT / "state.json"
SUMMARY = OUT / "latest.json"
SEEN_LIMIT = 256
MAX_MEASURED_AGE_SECONDS = 6 * 3600
PROBE_INTERVAL_SECONDS = max(30, int(os.environ.get("IMGW_AVIATION_PROBE_INTERVAL_SECONDS", "60")))


def now() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def dt(value) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        return None


def _read_json(path: Path, default):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value
    except Exception:
        return default


def _atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _normalise_raw(value: str) -> str:
    return " ".join(str(value or "").strip().rstrip("=").upper().split())


def bulletin_key(row: dict) -> str:
    kind = str(row.get("report_type") or row.get("type") or "METAR").upper()
    station = str(row.get("station") or "EPIR").upper()
    obs_time = str(row.get("obs_time") or row.get("message_time") or "")
    raw = _normalise_raw(row.get("raw") or row.get("canonical_raw"))
    material = f"{kind}\n{station}\n{obs_time}\n{raw}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def _journal_path(obs_time: datetime) -> Path:
    return OUT / f"{obs_time:%Y}" / f"{obs_time:%m}" / f"{obs_time:%d}.jsonl"


def _append_record(record: dict) -> None:
    path = _journal_path(dt(record.get("obs_time")) or now())
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n")


def _read_records(days: int = 7) -> list[dict]:
    cutoff = now() - timedelta(days=days)
    out: list[dict] = []
    if not OUT.exists():
        return out
    for path in OUT.rglob("*.jsonl"):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(row, dict):
                continue
            seen = dt(row.get("first_seen_imgw"))
            if seen and seen >= cutoff:
                out.append(row)
    out.sort(key=lambda row: str(row.get("first_seen_imgw") or ""))
    return out


def _percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil((pct / 100.0) * len(ordered)))
    return ordered[min(len(ordered), rank) - 1]


def _stats(records: list[dict], kind: str, hours: int) -> dict:
    cutoff = now() - timedelta(hours=hours)
    selected = [
        row for row in records
        if str(row.get("type") or "").upper() == kind
        and (dt(row.get("first_seen_imgw")) or datetime(1970, 1, 1, tzinfo=timezone.utc)) >= cutoff
        and isinstance(row.get("latency_estimate_seconds"), (int, float))
    ]
    values = [float(row["latency_estimate_seconds"]) for row in selected]
    widths = [float(row.get("measurement_window_seconds") or 0) for row in selected]
    if not values:
        return {"count": 0}
    return {
        "count": len(values),
        "min_seconds": round(min(values), 1),
        "median_seconds": round(statistics.median(values), 1),
        "mean_seconds": round(statistics.fmean(values), 1),
        "p90_seconds": round(_percentile(values, 90) or 0, 1),
        "max_seconds": round(max(values), 1),
        "max_measurement_window_seconds": round(max(widths) if widths else 0, 1),
    }


def _write_summary(records: list[dict], probe_at: datetime) -> None:
    latest_by_type = {}
    for kind in ("METAR", "SPECI"):
        candidates = [row for row in records if str(row.get("type") or "").upper() == kind]
        latest_by_type[kind.lower()] = candidates[-1] if candidates else None
    payload = {
        "schema": "prognozaepir-imgw-publication-latency-summary-v1",
        "station": "EPIR",
        "source": "IMGW_AVIATION_METAR",
        "updated_at": iso(probe_at),
        "probe_interval_seconds": PROBE_INTERVAL_SECONDS,
        "measurement": "publication time is bounded by last successful probe without the bulletin and first successful probe containing it",
        "latest_by_type": latest_by_type,
        "stats_24h": {kind.lower(): _stats(records, kind, 24) for kind in ("METAR", "SPECI")},
        "stats_7d": {kind.lower(): _stats(records, kind, 24 * 7) for kind in ("METAR", "SPECI")},
    }
    _atomic_json(SUMMARY, payload)


def observe(rows: list[dict], *, query_name: str | None = None, probe_at: datetime | None = None) -> dict:
    """Record first-seen bounded latency for newly observed IMGW METAR/SPECI rows."""
    probe_at = (probe_at or now()).astimezone(timezone.utc)
    valid_rows = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        kind = str(row.get("report_type") or row.get("type") or "METAR").upper()
        obs_time = dt(row.get("obs_time") or row.get("message_time"))
        if kind not in {"METAR", "SPECI"} or obs_time is None:
            continue
        if (probe_at - obs_time).total_seconds() > MAX_MEASURED_AGE_SECONDS:
            continue
        valid_rows.append(row)

    state = _read_json(STATE, {})
    seen_list = [str(x) for x in (state.get("seen") or []) if x]
    seen = set(seen_list)
    current_keys = [bulletin_key(row) for row in valid_rows]

    if not state.get("initialized_at"):
        # The first successful API response is a baseline. Existing bulletins
        # cannot be assigned an honest first-seen time retroactively.
        state = {
            "schema": "prognozaepir-imgw-publication-latency-state-v1",
            "initialized_at": iso(probe_at),
            "last_successful_probe_at": iso(probe_at),
            "seen": current_keys[-SEEN_LIMIT:],
        }
        _atomic_json(STATE, state)
        _write_summary(_read_records(), probe_at)
        result = {"baseline": len(current_keys), "recorded": 0, "probe_at": iso(probe_at)}
        print("IMGW publication latency baseline:", json.dumps(result, separators=(",", ":")), flush=True)
        return result

    previous_probe = dt(state.get("last_successful_probe_at"))
    recorded: list[dict] = []
    for row in sorted(valid_rows, key=lambda item: str(item.get("obs_time") or "")):
        key = bulletin_key(row)
        if key in seen:
            continue
        obs_time = dt(row.get("obs_time") or row.get("message_time"))
        if obs_time is None:
            continue
        upper = max(0.0, (probe_at - obs_time).total_seconds())
        lower = max(0.0, ((previous_probe or obs_time) - obs_time).total_seconds())
        if lower > upper:
            lower = upper
        estimate = (lower + upper) / 2.0
        kind = str(row.get("report_type") or row.get("type") or "METAR").upper()
        record = {
            "schema": "prognozaepir-imgw-publication-latency-v1",
            "station": str(row.get("station") or "EPIR").upper(),
            "type": kind,
            "source": "IMGW_AVIATION_METAR",
            "obs_time": iso(obs_time),
            "last_not_seen_imgw": iso(previous_probe),
            "first_seen_imgw": iso(probe_at),
            "latency_lower_bound_seconds": round(lower, 1),
            "latency_upper_bound_seconds": round(upper, 1),
            "latency_estimate_seconds": round(estimate, 1),
            "measurement_window_seconds": round(upper - lower, 1),
            "probe_interval_seconds": PROBE_INTERVAL_SECONDS,
            "imgw_api_query": query_name or row.get("imgw_api_query"),
            "imgw_api_date": row.get("imgw_api_date"),
            "imgw_api_file": row.get("imgw_api_file"),
            "raw": row.get("raw"),
            "bulletin_key": key,
        }
        _append_record(record)
        recorded.append(record)
        seen.add(key)
        seen_list.append(key)
        print(
            "IMGW publication latency:",
            json.dumps({
                "type": kind,
                "obs_time": record["obs_time"],
                "last_not_seen": record["last_not_seen_imgw"],
                "first_seen": record["first_seen_imgw"],
                "lower_s": record["latency_lower_bound_seconds"],
                "upper_s": record["latency_upper_bound_seconds"],
            }, separators=(",", ":")),
            flush=True,
        )

    state["last_successful_probe_at"] = iso(probe_at)
    state["seen"] = seen_list[-SEEN_LIMIT:]
    _atomic_json(STATE, state)
    records = _read_records()
    if recorded or not SUMMARY.exists():
        _write_summary(records, probe_at)
    return {"baseline": 0, "recorded": len(recorded), "probe_at": iso(probe_at)}
