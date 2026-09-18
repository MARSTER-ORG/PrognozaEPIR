#!/usr/bin/env python3
"""Incrementally backfill multi-model forecast skill from Open-Meteo Previous Runs.

The Previous Runs API stores fixed lead-time forecasts (1-7 days before valid
time) for most models from January 2024. This complements the Single Runs
archive, which is much shorter for most models. Rows are written into the same
forecast archive consumed by model_verification.py and adaptive consensus
learning, but are explicitly tagged with their source.

To keep the repository compact, only 00/06/12/18 UTC verification hours that
have a real EPIR observation are retained. No reanalysis is used as truth.
"""
from __future__ import annotations

import argparse
import json
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from calendar import monthrange
from datetime import date, datetime, timedelta, timezone

import model_verification as mv

API = "https://previous-runs-api.open-meteo.com/v1/forecast"
STATE = mv.LEARNING / "previous-runs-backfill-state.json"
ARCHIVE_START = date(2024, 1, 1)
LEAD_DAYS = (1, 2, 3, 4, 5)
VERIFY_HOURS = {0, 6, 12, 18}
MAX_ATTEMPTS_PER_MONTH = 4
USER_AGENT = "PrognozaEPIR-PreviousRunsBackfill/1.0"

BASE_VARS = (
    "temperature_2m",
    "dew_point_2m",
    "relative_humidity_2m",
    "precipitation",
    "pressure_msl",
    "weather_code",
    "cloud_cover",
    "wind_speed_10m",
    "wind_direction_10m",
)


def month_key(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def parse_month(value: str) -> date:
    dt = datetime.strptime(value, "%Y-%m")
    return date(dt.year, dt.month, 1)


def add_month(d: date, n: int = 1) -> date:
    y = d.year + (d.month - 1 + n) // 12
    m = (d.month - 1 + n) % 12 + 1
    return date(y, m, 1)


def month_end(d: date) -> date:
    return date(d.year, d.month, monthrange(d.year, d.month)[1])


def utcnow():
    return datetime.now(timezone.utc)


def load_state():
    try:
        raw = json.loads(STATE.read_text(encoding="utf-8"))
        if raw.get("schema") == "prognozaepir-previous-runs-backfill-v1":
            return raw
    except Exception:
        pass
    return {}


def save_state(state):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def get_json(url: str, retries: int = 4, timeout: int = 90):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": USER_AGENT, "Accept": "application/json", "Connection": "close"},
            )
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                if not raw:
                    raise ValueError("empty API response")
                return json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code not in {408, 425, 429} and not (500 <= exc.code <= 599):
                raise
        except (urllib.error.URLError, socket.timeout, TimeoutError, ValueError, json.JSONDecodeError) as exc:
            last = exc
        if attempt + 1 < retries:
            time.sleep(min(12, 2 ** attempt))
    raise last


def observation_hours(start: date, end: date):
    metar, synop = mv.build_observation_maps()
    out = set()
    for key in set(metar) | set(synop):
        dt = mv.parse_dt(key)
        if not dt:
            continue
        if start <= dt.date() <= end and dt.hour in VERIFY_HOURS:
            out.add(mv.iso(dt.replace(minute=0, second=0, microsecond=0)))
    return out


def request_model_month(model_id: str, start: date, end: date):
    hourly = []
    for base in BASE_VARS:
        hourly.extend(f"{base}_previous_day{lead}" for lead in LEAD_DAYS)
    params = {
        "latitude": mv.LAT,
        "longitude": mv.LON,
        "hourly": ",".join(hourly),
        "models": model_id,
        "timezone": "UTC",
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "wind_speed_unit": "ms",
    }
    return get_json(API + "?" + urllib.parse.urlencode(params))


def at(hourly, key, idx):
    values = hourly.get(key) or []
    return values[idx] if idx < len(values) else None


def convert_model_month(model_id, name, weight, payload, allowed_hours):
    hourly = payload.get("hourly") or {}
    times = hourly.get("time") or []
    rows = []
    for idx, ts in enumerate(times):
        valid = mv.parse_dt(ts)
        if not valid:
            continue
        valid = valid.replace(minute=0, second=0, microsecond=0)
        valid_iso = mv.iso(valid)
        if valid_iso not in allowed_hours:
            continue
        for lead_day in LEAD_DAYS:
            lead_h = float(lead_day * 24)
            bucket = mv.lead_bucket(lead_h)
            if not bucket:
                continue
            suffix = f"_previous_day{lead_day}"
            temp = at(hourly, "temperature_2m" + suffix, idx)
            dew = at(hourly, "dew_point_2m" + suffix, idx)
            pressure = at(hourly, "pressure_msl" + suffix, idx)
            wind = at(hourly, "wind_speed_10m" + suffix, idx)
            cloud = at(hourly, "cloud_cover" + suffix, idx)
            precip = at(hourly, "precipitation" + suffix, idx)
            if not any(mv.finite(v) for v in (temp, dew, pressure, wind, cloud, precip)):
                continue
            run = valid - timedelta(days=lead_day)
            rows.append({
                "schema": "prognozaepir-model-forecast-v1",
                "run_time": mv.iso(run),
                "model": model_id,
                "name": name,
                "base_weight": weight,
                "lead_hours": lead_h,
                "lead_bucket": bucket,
                "archive_source": "open-meteo-previous-runs",
                "archive_backfill": True,
                "archive_fixed_lead_day": lead_day,
                "archive_partial_fields": True,
                "valid_time": valid_iso,
                "temperature_c": temp,
                "dew_point_c": dew,
                "relative_humidity_pct": at(hourly, "relative_humidity_2m" + suffix, idx),
                "precipitation_mm": precip,
                "pressure_hpa": pressure,
                "visibility_m": None,
                "wind_speed_ms": wind,
                "wind_direction_deg": at(hourly, "wind_direction_10m" + suffix, idx),
                "wind_gust_ms": None,
                "weather_code": at(hourly, "weather_code" + suffix, idx),
                "cloud_total_pct": cloud,
                "low_pct": None,
                "mid_pct": None,
                "high_pct": None,
            })
    return rows


def write_month(month: str, new_rows):
    path = mv.FORECAST_DIR / f"backfill-previous-runs-{month}.jsonl"
    existing = mv.load_jsonl(path)
    merged = {}
    for row in existing + new_rows:
        key = (row.get("run_time"), row.get("model"), row.get("valid_time"))
        if all(key):
            old = merged.get(key)
            if old is None or sum(v is not None for v in row.values()) > sum(v is not None for v in old.values()):
                merged[key] = row
    ordered = sorted(merged.values(), key=lambda r: (r.get("valid_time", ""), r.get("model", ""), r.get("run_time", "")))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in ordered),
        encoding="utf-8",
    )
    return path, len(ordered)


def choose_months(state, first: date, last: date, limit: int):
    history = state.get("months") or {}
    candidates = []
    cur = first
    while cur <= last:
        key = month_key(cur)
        info = history.get(key) or {}
        attempts = int(info.get("attempts") or 0)
        status = info.get("status")
        if status != "complete" and attempts < MAX_ATTEMPTS_PER_MONTH:
            candidates.append((attempts, cur))
        cur = add_month(cur)
    candidates.sort(key=lambda item: (item[0], item[1]))
    return [d for _attempts, d in candidates[:max(0, limit)]]


def process_month(d: date):
    start = d
    end = min(month_end(d), (utcnow() - timedelta(days=1)).date())
    allowed = observation_hours(start, end)
    all_rows = []
    model_rows = {}
    failures = []
    for model_id, name, weight in mv.MODELS:
        try:
            payload = request_model_month(model_id, start, end)
            rows = convert_model_month(model_id, name, weight, payload, allowed)
            all_rows.extend(rows)
            model_rows[model_id] = len(rows)
        except Exception as exc:
            failures.append([model_id, f"{type(exc).__name__}: {exc}"])
            model_rows[model_id] = 0
    path, total = write_month(month_key(d), all_rows)
    usable_models = sum(1 for n in model_rows.values() if n > 0)
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "observation_hours": len(allowed),
        "rows": total,
        "new_rows_received": len(all_rows),
        "models_with_rows": usable_models,
        "model_rows": model_rows,
        "failures": failures[:20],
        "file": str(path.relative_to(mv.ROOT)),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-months", type=int, default=1)
    ap.add_argument("--start-month", default="2024-01")
    ap.add_argument("--end-month", default="", help="YYYY-MM; default=current UTC month")
    args = ap.parse_args()

    requested_start = max(parse_month(args.start_month), ARCHIVE_START)
    today = utcnow().date()
    requested_end = parse_month(args.end_month) if args.end_month else date(today.year, today.month, 1)
    if requested_end < requested_start:
        raise SystemExit("end month before start month")

    previous = load_state()
    months = dict(previous.get("months") or {})
    selected = choose_months(previous, requested_start, requested_end, args.max_months)
    if not selected:
        print(json.dumps({"status": "no-work", "start": month_key(requested_start), "end": month_key(requested_end)}, ensure_ascii=False))
        return

    processed = []
    now_s = mv.iso(utcnow())
    for d in selected:
        key = month_key(d)
        result = process_month(d)
        old = dict(months.get(key) or {})
        attempts = int(old.get("attempts") or 0) + 1
        complete = int(result["models_with_rows"]) >= 5
        months[key] = {
            "attempts": attempts,
            "last_attempt_utc": now_s,
            "status": "complete" if complete else ("exhausted" if attempts >= MAX_ATTEMPTS_PER_MONTH else "pending"),
            **result,
        }
        processed.append(key)

    pending = []
    cur = requested_start
    while cur <= requested_end:
        key = month_key(cur)
        info = months.get(key) or {}
        if info.get("status") not in {"complete", "exhausted"}:
            pending.append(key)
        cur = add_month(cur)

    report = {
        "schema": "prognozaepir-previous-runs-backfill-v1",
        "generated_at_utc": now_s,
        "source": "Open-Meteo Previous Runs API",
        "archive_start": ARCHIVE_START.isoformat(),
        "requested_start_month": month_key(requested_start),
        "requested_end_month": month_key(requested_end),
        "lead_days": list(LEAD_DAYS),
        "verification_hours_utc": sorted(VERIFY_HOURS),
        "field_policy": "Only variables natively provided by Previous Runs are stored; no reanalysis substitution or synthetic visibility/cloud layers.",
        "selected_months": processed,
        "remaining_pending_months": len(pending),
        "next_pending_months": pending[:12],
        "months": months,
    }
    save_state(report)
    print(json.dumps({
        "status": "processed",
        "selected_months": processed,
        "remaining_pending_months": len(pending),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
