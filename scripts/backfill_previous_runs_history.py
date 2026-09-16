#!/usr/bin/env python3
"""Acquire fixed-lead archived operational forecasts for CONSENSUS learning.

Source: Open-Meteo Previous Runs API. This archive exposes the value predicted
24, 48, ... 168 hours before each valid time. Those samples are kept separate
from exact Single Runs and are marked with explicit fixed-lead provenance.

The script deliberately writes only 00 UTC valid times. For a fixed 24/48/etc.
lead that also yields a 00 UTC reference run time, matching the project's main
historical verification policy while keeping the archive compact.

No reanalysis or analysis field is substituted for a missing operational
forecast. Missing model/variable history is recorded and skipped.
"""
from __future__ import annotations

import argparse
import calendar
import json
import random
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "data" / "learning" / "model-forecasts"
STATE = ROOT / "data" / "learning" / "previous-runs-backfill-state.json"
API = "https://previous-runs-api.open-meteo.com/v1/forecast"
USER_AGENT = "PrognozaEPIR-ConsensusPreviousRuns/1.0"
LAT = 52.7989
LON = 18.2639

# These IDs are already used by model_verification.py in this repository.
MODELS = {
    "ncep_gfs_global": ("GFS", 0.10),
    "ecmwf_ifs": ("ECMWF", 0.17),
    "icon_eu": ("ICON-EU", 0.12),
    "icon_global": ("ICON", 0.05),
    "icon_d2": ("ICON-D2", 0.12),
    "meteofrance_arpege_europe": ("ARPEGE EU", 0.08),
    "ukmo_global_deterministic_10km": ("UKMO", 0.06),
    "cmc_gem_gdps": ("GEM", 0.04),
}

BASE_VARS = {
    "temperature_c": "temperature_2m",
    "dew_point_c": "dew_point_2m",
    "relative_humidity_pct": "relative_humidity_2m",
    "precipitation_mm": "precipitation",
    "pressure_hpa": "pressure_msl",
    "cloud_total_pct": "cloud_cover",
    "wind_speed_ms": "wind_speed_10m",
    "wind_direction_deg": "wind_direction_10m",
}
LEAD_DAYS = (1, 2, 3, 4, 5)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_ts(s: str) -> datetime | None:
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return None


def parse_day(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def month_chunks(start: date, end: date):
    cur = date(start.year, start.month, 1)
    while cur <= end:
        last = date(cur.year, cur.month, calendar.monthrange(cur.year, cur.month)[1])
        yield max(start, cur), min(end, last)
        cur = (last + timedelta(days=1)).replace(day=1)


def transient_http(code: int) -> bool:
    return code in {408, 425, 429} or 500 <= code <= 599


def get_json(url: str, retries: int = 6, timeout: int = 90):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/json",
                "Connection": "close",
            })
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                if not raw:
                    raise ValueError("empty API response")
                return json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as exc:
            last = exc
            if not transient_http(exc.code):
                raise
        except (urllib.error.URLError, socket.timeout, TimeoutError,
                json.JSONDecodeError, ValueError) as exc:
            last = exc
        if attempt + 1 < retries:
            time.sleep(min(20.0, 1.5 * (2 ** attempt)) + random.random())
    raise last


def hourly_request_names():
    names = []
    for base in BASE_VARS.values():
        for day in LEAD_DAYS:
            names.append(f"{base}_previous_day{day}")
    return names


def request_chunk(model: str, start: date, end: date):
    params = {
        "latitude": LAT,
        "longitude": LON,
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "hourly": ",".join(hourly_request_names()),
        "models": model,
        "timezone": "UTC",
        "wind_speed_unit": "ms",
    }
    url = API + "?" + urllib.parse.urlencode(params)
    return get_json(url)


def value_at(hourly: dict, key: str, idx: int):
    arr = hourly.get(key) or []
    if idx >= len(arr):
        return None
    v = arr[idx]
    return v if isinstance(v, (int, float)) else None


def rows_from_payload(model: str, payload: dict):
    name, base_weight = MODELS[model]
    hourly = payload.get("hourly") or {}
    times = hourly.get("time") or []
    rows = []
    for idx, ts in enumerate(times):
        valid = parse_ts(ts)
        if not valid or valid.hour != 0:
            continue
        for day in LEAD_DAYS:
            lead_h = day * 24
            fields = {}
            non_null = 0
            for out_key, api_key in BASE_VARS.items():
                v = value_at(hourly, f"{api_key}_previous_day{day}", idx)
                fields[out_key] = v
                non_null += int(v is not None)
            if non_null == 0:
                continue
            run_ref = valid - timedelta(hours=lead_h)
            rows.append({
                "schema": "prognozaepir-model-forecast-v1",
                "run_time": iso(run_ref),
                "valid_time": iso(valid),
                "model": model,
                "name": name,
                "base_weight": base_weight,
                "lead_hours": float(lead_h),
                "lead_bucket": "24-48h" if lead_h < 48 else "48-120h",
                "archive_source": "open-meteo-previous-runs",
                "archive_backfill": True,
                "archive_fixed_lead": True,
                "run_time_semantics": "valid_time_minus_fixed_lead; not native init metadata",
                "archive_variable_count": non_null,
                **fields,
                "visibility_m": None,
                "wind_gust_ms": None,
                "weather_code": None,
                "low_pct": None,
                "mid_pct": None,
                "high_pct": None,
            })
    return rows


def load_jsonl(path: Path):
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def merge_write(month: str, rows):
    path = OUT_DIR / f"previous-runs-{month}.jsonl"
    merged = {}
    for row in load_jsonl(path) + rows:
        key = (row.get("run_time"), row.get("model"), row.get("valid_time"), row.get("lead_hours"))
        if all(x is not None for x in key):
            merged[key] = row
    ordered = sorted(merged.values(), key=lambda r: (
        r.get("valid_time", ""), r.get("model", ""), float(r.get("lead_hours") or 0)
    ))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in ordered), encoding="utf-8")
    return path, len(ordered)


def fetch_task(model: str, start: date, end: date):
    payload = request_chunk(model, start, end)
    rows = rows_from_payload(model, payload)
    return rows, {
        "model": model,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "rows": len(rows),
        "generation_ms": payload.get("generationtime_ms"),
        "elevation": payload.get("elevation"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2024-01-01")
    ap.add_argument("--end", default="2026-05-31")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--models", default=",".join(MODELS), help="comma-separated Open-Meteo model IDs")
    args = ap.parse_args()

    start, end = parse_day(args.start), parse_day(args.end)
    if end < start:
        raise SystemExit("end before start")
    selected = [m.strip() for m in args.models.split(",") if m.strip()]
    unknown = [m for m in selected if m not in MODELS]
    if unknown:
        raise SystemExit(f"unknown models: {unknown}")

    tasks = [(m, a, b) for a, b in month_chunks(start, end) for m in selected]
    by_month = {}
    successes = []
    failures = []

    print(f"Previous Runs acquisition {start}..{end}; models={len(selected)}; chunks={len(tasks)}")
    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 4))) as pool:
        futs = {pool.submit(fetch_task, *task): task for task in tasks}
        for i, fut in enumerate(as_completed(futs), 1):
            model, a, b = futs[fut]
            try:
                rows, meta = fut.result()
                successes.append(meta)
                for row in rows:
                    month = row["valid_time"][:7]
                    by_month.setdefault(month, []).append(row)
            except Exception as exc:
                failures.append({
                    "model": model, "start": a.isoformat(), "end": b.isoformat(),
                    "error": f"{type(exc).__name__}: {exc}",
                })
            if i % 12 == 0 or i == len(futs):
                print(f"progress {i}/{len(futs)}; ok={len(successes)} fail={len(failures)}")

    written = {}
    total_rows = 0
    for month, rows in sorted(by_month.items()):
        path, count = merge_write(month, rows)
        written[str(path.relative_to(ROOT))] = count
        total_rows += count

    model_rows = {}
    lead_rows = {}
    for rows in by_month.values():
        for row in rows:
            model_rows[row["model"]] = model_rows.get(row["model"], 0) + 1
            lead = str(int(row["lead_hours"]))
            lead_rows[lead] = lead_rows.get(lead, 0) + 1

    state = {
        "schema": "prognozaepir-previous-runs-backfill-v1",
        "generated_at_utc": iso(datetime.now(timezone.utc)),
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "valid_hour_utc": 0,
        "lead_hours": [d * 24 for d in LEAD_DAYS],
        "models_requested": selected,
        "source": "Open-Meteo Previous Runs API",
        "source_semantics": "fixed lead offsets; not native run initialisation metadata",
        "requests_total": len(tasks),
        "requests_successful": len(successes),
        "requests_failed": len(failures),
        "rows_acquired_this_run": sum(x.get("rows", 0) for x in successes),
        "rows_by_model_this_run": dict(sorted(model_rows.items())),
        "rows_by_lead_this_run": dict(sorted(lead_rows.items(), key=lambda kv: int(kv[0]))),
        "files": written,
        "failures": failures[:300],
    }
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(json.dumps({k: v for k, v in state.items() if k != "failures"}, ensure_ascii=False, indent=2))
    if total_rows == 0:
        raise SystemExit("no historical rows acquired")


if __name__ == "__main__":
    main()
