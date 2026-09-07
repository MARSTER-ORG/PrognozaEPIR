#!/usr/bin/env python3
"""Backfill archived operational model runs for PrognozaEPIR learning.

Uses Open-Meteo Single Runs API so every sample comes from a forecast run that
existed before its valid time. One 00 UTC run per model/day is enough to build
stable lead-time skill for the existing 0-3, 3-6, 6-12, 12-24, 24-48 and
48-120 h buckets without exploding repository size.

The generated rows use the same schema and directory as live model archiving,
therefore cloud_learning.py and model_verification.py consume them unchanged.
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

import model_verification as mv

API = "https://single-runs-api.open-meteo.com/v1/forecast"
USER_AGENT = "PrognozaEPIR-HistoricalModelBackfill/1.0"
DEFAULT_START = "2026-06-01"
DEFAULT_END = "2026-09-07"
FORECAST_HOURS = 121


def parse_day(value: str):
    return datetime.strptime(value, "%Y-%m-%d").date()


def days_between(start, end):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


def get_json(url: str, retries: int = 3, timeout: int = 70):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except Exception as exc:
            last = exc
            if attempt + 1 < retries:
                time.sleep(1.5 * (attempt + 1))
    raise last


def fetch_run(model_id: str, name: str, base_weight: float, day, run_hour: int):
    run = datetime(day.year, day.month, day.day, run_hour, tzinfo=timezone.utc)
    params = {
        "latitude": mv.LAT,
        "longitude": mv.LON,
        "hourly": ",".join(mv.HOURLY),
        "models": model_id,
        "timezone": "UTC",
        "forecast_hours": FORECAST_HOURS,
        "wind_speed_unit": "ms",
        "run": run.strftime("%Y-%m-%dT%H:%M"),
    }
    data = get_json(API + "?" + urllib.parse.urlencode(params))
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
            **row,
        })
    if not selected:
        raise RuntimeError("run returned no usable lead buckets")
    return selected


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
    ap.add_argument("--workers", type=int, default=4)
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
    tasks = []
    for day in days_between(start, end):
        for model_id, name, weight in models:
            run_time = datetime(day.year, day.month, day.day, args.run_hour, tzinfo=timezone.utc)
            if (mv.iso(run_time), model_id) in existing_runs:
                continue
            tasks.append((model_id, name, weight, day, args.run_hour))

    print(f"single-run backfill: {start}..{end}; models={len(models)}; pending_runs={len(tasks)}")
    by_month = {}
    success = 0
    failures = []

    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 6))) as pool:
        futs = {pool.submit(fetch_run, *task): task for task in tasks}
        total = len(futs)
        for idx, fut in enumerate(as_completed(futs), 1):
            task = futs[fut]
            model_id, _name, _weight, day, _hour = task
            try:
                rows = fut.result()
                month = day.strftime("%Y-%m")
                by_month.setdefault(month, []).extend(rows)
                success += 1
            except Exception as exc:
                failures.append((day.isoformat(), model_id, str(exc)))
            if idx % 25 == 0 or idx == total:
                print(f"progress {idx}/{total}; successful_runs={success}; failed_runs={len(failures)}")

    written = {}
    for month, rows in sorted(by_month.items()):
        path, count = write_month(month, rows)
        written[str(path.relative_to(mv.ROOT))] = count

    report = {
        "schema": "prognozaepir-model-backfill-state-v1",
        "generated_at": mv.iso(mv.utcnow()),
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "run_hour_utc": args.run_hour,
        "models": [m[0] for m in models],
        "requested_runs": len(tasks),
        "successful_runs": success,
        "failed_runs": len(failures),
        "rows_written": written,
        "failures": failures[:100],
    }
    state = mv.LEARNING / "model-backfill-state.json"
    state.parent.mkdir(parents=True, exist_ok=True)
    state.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if tasks and success < max(1, int(len(tasks) * 0.50)):
        raise SystemExit(f"backfill incomplete: only {success}/{len(tasks)} runs succeeded")

    print("backfill complete:", json.dumps({k: v for k, v in report.items() if k != "failures"}, ensure_ascii=False))
    if failures:
        print("sample failures:", json.dumps(failures[:10], ensure_ascii=False))


if __name__ == "__main__":
    main()
