#!/usr/bin/env python3
"""Backfill archived operational model runs for PrognozaEPIR learning.

Uses Open-Meteo Single Runs API so every sample comes from a forecast run that
existed before its valid time. Successful runs already present in the archive
are skipped, so re-running this script acts as a targeted recovery pass.

Recovery is deliberately conservative: transient network/server failures use
exponential backoff with jitter; HTTP 400 responses are retried with smaller
variable bundles because some archived regional runs expose fewer fields than
current runs. Reanalysis is never substituted for a missing operational run.
"""
from __future__ import annotations

import argparse
import json
import random
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

import model_verification as mv

API = "https://single-runs-api.open-meteo.com/v1/forecast"
USER_AGENT = "PrognozaEPIR-HistoricalModelBackfill/1.2"
DEFAULT_START = "2026-06-01"
DEFAULT_END = "2026-09-07"
FORECAST_HOURS = 121

# Regional models can have shorter native horizons. Requesting only what can
# exist avoids provider-side 400s while still reaching the 48-120 h bucket
# whenever the model itself supports it.
MODEL_FORECAST_HOURS = {
    "chmi_aladin_central_europe_2km": 73,
    "icon_d2": 49,
}

FULL_VARS = tuple(mv.HOURLY)
CORE_VARS = tuple(v for v in FULL_VARS if v not in {"weather_code", "wind_gusts_10m"})
ESSENTIAL_VARS = (
    "temperature_2m", "dew_point_2m", "relative_humidity_2m",
    "precipitation", "pressure_msl", "visibility",
    "wind_speed_10m", "wind_direction_10m",
    "cloud_cover", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high",
)
VARIABLE_TIERS = (FULL_VARS, CORE_VARS, ESSENTIAL_VARS)


def parse_day(value: str):
    return datetime.strptime(value, "%Y-%m-%d").date()


def days_between(start, end):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


def transient_http(code: int) -> bool:
    return code in {408, 425, 429} or 500 <= code <= 599


def get_json(url: str, retries: int = 6, timeout: int = 90):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json",
                    "Connection": "close",
                },
            )
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                if not raw:
                    raise ValueError("empty API response")
                return json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as exc:
            last = exc
            if not transient_http(exc.code):
                raise
        except (urllib.error.URLError, socket.timeout, TimeoutError, json.JSONDecodeError, ValueError) as exc:
            last = exc
        except Exception as exc:
            last = exc

        if attempt + 1 < retries:
            base = min(24.0, 1.6 * (2 ** attempt))
            time.sleep(base + random.uniform(0.0, 1.2))
    raise last


def request_run(model_id: str, run, variables):
    params = {
        "latitude": mv.LAT,
        "longitude": mv.LON,
        "hourly": ",".join(variables),
        "models": model_id,
        "timezone": "UTC",
        "forecast_hours": MODEL_FORECAST_HOURS.get(model_id, FORECAST_HOURS),
        "wind_speed_unit": "ms",
        "run": run.strftime("%Y-%m-%dT%H:%M"),
    }
    return get_json(API + "?" + urllib.parse.urlencode(params))


def fetch_run(model_id: str, name: str, base_weight: float, day, run_hour: int):
    run = datetime(day.year, day.month, day.day, run_hour, tzinfo=timezone.utc)
    data = None
    used_vars = None
    errors = []

    for variables in VARIABLE_TIERS:
        try:
            data = request_run(model_id, run, variables)
            used_vars = variables
            break
        except urllib.error.HTTPError as exc:
            errors.append(f"HTTP {exc.code} vars={len(variables)}")
            if exc.code != 400:
                raise
        except Exception as exc:
            # Transient failures have already exhausted their retry budget.
            errors.append(f"{type(exc).__name__}: {exc}")
            raise

    if data is None:
        raise RuntimeError("; ".join(errors) or "no archived run")

    hourly = data.get("hourly") or {}
    times = hourly.get("time") or []
    rows = []

    def at(key, i):
        arr = hourly.get(key) or []
        return arr[i] if i < len(arr) else None

    for i, ts in enumerate(times):
        valid = mv.parse_dt(ts)
        if not valid:
            continue
        rows.append({
            "valid_time": mv.iso(valid),
            "temperature_c": at("temperature_2m", i),
            "dew_point_c": at("dew_point_2m", i),
            "relative_humidity_pct": at("relative_humidity_2m", i),
            "precipitation_mm": at("precipitation", i),
            "pressure_hpa": at("pressure_msl", i),
            "visibility_m": at("visibility", i),
            "wind_speed_ms": at("wind_speed_10m", i),
            "wind_direction_deg": at("wind_direction_10m", i),
            "wind_gust_ms": at("wind_gusts_10m", i),
            "weather_code": at("weather_code", i),
            "cloud_total_pct": at("cloud_cover", i),
            "low_pct": at("cloud_cover_low", i),
            "mid_pct": at("cloud_cover_mid", i),
            "high_pct": at("cloud_cover_high", i),
        })

    selected = []
    degraded = set(used_vars or ()) != set(FULL_VARS)
    for bucket, lead_h, row in mv.representative_rows(rows, run):
        selected.append({
            "schema": "prognozaepir-model-forecast-v1",
            "run_time": mv.iso(run),
            "model": model_id,
            "name": name,
            "base_weight": base_weight,
            "lead_hours": round(lead_h, 2),
            "lead_bucket": bucket,
            "archive_source": "open-meteo-single-runs",
            "archive_backfill": True,
            "archive_degraded_fields": degraded,
            "archive_variable_count": len(used_vars or ()),
            **row,
        })
    if not selected:
        raise RuntimeError("run returned no usable lead buckets")
    return selected, degraded


def load_existing_keys():
    keys = set()
    if mv.FORECAST_DIR.exists():
        for path in mv.FORECAST_DIR.glob("*.jsonl"):
            for row in mv.load_jsonl(path):
                key = (row.get("run_time"), row.get("model"), row.get("valid_time"))
                if all(key):
                    keys.add(key)
    return keys


def write_month(month: str, rows):
    path = mv.FORECAST_DIR / f"backfill-single-runs-{month}.jsonl"
    existing = mv.load_jsonl(path)
    merged = {}
    for row in existing + rows:
        key = (row.get("run_time"), row.get("model"), row.get("valid_time"))
        if all(key):
            merged[key] = row
    ordered = sorted(merged.values(), key=lambda r: (r.get("run_time", ""), r.get("model", ""), r.get("valid_time", "")))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in ordered), encoding="utf-8")
    return path, len(ordered)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default=DEFAULT_START)
    ap.add_argument("--end", default=DEFAULT_END)
    ap.add_argument("--run-hour", type=int, default=0, choices=(0, 6, 12, 18))
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--models", default="", help="comma-separated model ids; empty = all configured models")
    args = ap.parse_args()

    start, end = parse_day(args.start), parse_day(args.end)
    if end < start:
        raise SystemExit("end before start")

    selected_ids = {x.strip() for x in args.models.split(",") if x.strip()}
    models = [m for m in mv.MODELS if not selected_ids or m[0] in selected_ids]
    if not models:
        raise SystemExit("no matching models")

    existing = load_existing_keys()
    existing_runs = {(k[0], k[1]) for k in existing}
    expected_runs = sum(1 for _day in days_between(start, end)) * len(models)
    tasks = []
    for day in days_between(start, end):
        for model_id, name, weight in models:
            run_time = datetime(day.year, day.month, day.day, args.run_hour, tzinfo=timezone.utc)
            if (mv.iso(run_time), model_id) in existing_runs:
                continue
            tasks.append((model_id, name, weight, day, args.run_hour))

    existing_in_period = expected_runs - len(tasks)
    print(
        f"single-run recovery: {start}..{end}; models={len(models)}; "
        f"expected_runs={expected_runs}; existing_runs={existing_in_period}; pending_runs={len(tasks)}"
    )
    by_month = {}
    success = 0
    degraded_success = 0
    failures = []

    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 4))) as pool:
        futs = {pool.submit(fetch_run, *task): task for task in tasks}
        total = len(futs)
        for idx, fut in enumerate(as_completed(futs), 1):
            task = futs[fut]
            model_id, _name, _weight, day, _hour = task
            try:
                rows, degraded = fut.result()
                month = day.strftime("%Y-%m")
                by_month.setdefault(month, []).extend(rows)
                success += 1
                degraded_success += int(degraded)
            except Exception as exc:
                failures.append((day.isoformat(), model_id, str(exc)))
            if idx % 20 == 0 or idx == total:
                print(f"progress {idx}/{total}; recovered={success}; failed={len(failures)}")

    written = {}
    for month, rows in sorted(by_month.items()):
        path, count = write_month(month, rows)
        written[str(path.relative_to(mv.ROOT))] = count

    remaining = max(0, len(tasks) - success)
    complete_runs = existing_in_period + success
    completeness = (complete_runs / expected_runs) if expected_runs else 1.0
    report = {
        "schema": "prognozaepir-model-backfill-state-v2",
        "generated_at": mv.iso(mv.utcnow()),
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "run_hour_utc": args.run_hour,
        "models": [m[0] for m in models],
        "expected_runs": expected_runs,
        "existing_runs_before": existing_in_period,
        "pending_runs": len(tasks),
        "recovered_runs": success,
        "degraded_recovered_runs": degraded_success,
        "remaining_failed_runs": remaining,
        "complete_runs": complete_runs,
        "completeness_pct": round(completeness * 100.0, 2),
        # Backward-compatible fields used by older diagnostics.
        "requested_runs": len(tasks),
        "successful_runs": success,
        "failed_runs": len(failures),
        "rows_written": written,
        "failures": failures[:200],
    }
    state = mv.LEARNING / "model-backfill-state.json"
    state.parent.mkdir(parents=True, exist_ok=True)
    state.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # A recovery pass is useful even if a provider has genuine archival gaps.
    # Fail only when virtually nothing could be recovered, which usually means
    # an API-wide problem rather than model-specific missing history.
    if tasks and success == 0 and len(tasks) >= 5:
        raise SystemExit(f"recovery failed: 0/{len(tasks)} pending runs recovered")

    print("backfill recovery complete:", json.dumps({k: v for k, v in report.items() if k != "failures"}, ensure_ascii=False))
    if failures:
        print("sample remaining failures:", json.dumps(failures[:15], ensure_ascii=False))


if __name__ == "__main__":
    main()
