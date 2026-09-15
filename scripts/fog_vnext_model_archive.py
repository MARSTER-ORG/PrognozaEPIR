#!/usr/bin/env python3
"""Archive no-lookahead forecast runs needed by Fog Engine vNext.

Uses Open-Meteo Single Runs API with an explicit model initialisation time.
The shared `run_time` field remains the archive batch time so existing paired
learners can compare models from one archive batch; `model_run_time` stores the
actual requested model cycle and `lead_hours` is calculated from that cycle.
Final analyses/reanalysis are never substituted for a missing run.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import model_verification as mv

API = "https://single-runs-api.open-meteo.com/v1/forecast"
USER_AGENT = "PrognozaEPIR-FogVNextArchive/1.0"
FULL_DIR = mv.LEARNING / "fog-vnext-forecasts"

EXTRA_MODELS = {
    "dmi_harmonie_arome_europe": ("DMI HARMONIE-AROME Europe 2 km", 0.10),
    "knmi_harmonie_arome_europe": ("KNMI HARMONIE-AROME Europe 5.5 km", 0.07),
}

CORE = (
    "temperature_2m", "dew_point_2m", "relative_humidity_2m", "precipitation",
    "pressure_msl", "visibility", "wind_speed_10m", "wind_direction_10m",
    "wind_gusts_10m", "weather_code", "cloud_cover", "cloud_cover_low",
    "cloud_cover_mid", "cloud_cover_high", "surface_temperature", "is_day",
)

MODEL_TIERS = {
    "dmi_harmonie_arome_europe": [
        CORE + ("cloud_base", "cloud_cover_2m", "temperature_50m", "temperature_100m", "temperature_150m", "temperature_250m"),
        CORE + ("cloud_base", "cloud_cover_2m"),
        CORE,
    ],
    "knmi_harmonie_arome_europe": [
        CORE + ("temperature_100m", "temperature_200m", "temperature_300m"),
        CORE,
    ],
    "icon_d2": [
        CORE + ("soil_moisture_0_to_1cm", "soil_moisture_1_to_3cm", "soil_temperature_0cm", "soil_temperature_6cm"),
        CORE + ("soil_moisture_0_to_1cm", "soil_moisture_1_to_3cm"),
        CORE,
    ],
    "ecmwf_ifs": [
        CORE + ("boundary_layer_height", "soil_moisture_0_to_7cm", "soil_temperature_0_7cm"),
        CORE + ("boundary_layer_height",),
        CORE,
    ],
}


def now_hour():
    return datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)


def get_json(url, timeout=45):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def request_run(model, run, variables):
    params = {
        "latitude": mv.LAT,
        "longitude": mv.LON,
        "hourly": ",".join(variables),
        "models": model,
        "timezone": "UTC",
        "forecast_hours": 72,
        "wind_speed_unit": "ms",
        "run": run.strftime("%Y-%m-%dT%H:%M"),
    }
    return get_json(API + "?" + urllib.parse.urlencode(params))


def latest_available_run(model, batch):
    errors = []
    # Trying actual UTC hours avoids hard-coding provider cycle schedules. The
    # first accepted Single Runs request is an explicit archived model cycle.
    for hours_back in range(0, 13):
        run = batch - timedelta(hours=hours_back)
        for variables in MODEL_TIERS[model]:
            try:
                data = request_run(model, run, variables)
                times = (data.get("hourly") or {}).get("time") or []
                if times:
                    return run, variables, data
            except urllib.error.HTTPError as exc:
                errors.append(f"{run:%H}Z/{len(variables)}v HTTP{exc.code}")
                if exc.code not in (400, 404, 422):
                    time.sleep(0.5)
            except Exception as exc:
                errors.append(f"{run:%H}Z/{len(variables)}v {type(exc).__name__}")
        time.sleep(0.1)
    raise RuntimeError(f"no archived run for {model}: {'; '.join(errors[-8:])}")


def at(hourly, key, i):
    arr = hourly.get(key) or []
    return arr[i] if i < len(arr) else None


def rows_from(model, model_run, batch, data):
    h = data.get("hourly") or {}
    out = []
    for i, ts in enumerate(h.get("time") or []):
        valid = mv.parse_dt(ts)
        if not valid or valid <= batch or valid > batch + timedelta(hours=60):
            continue
        row = {
            "schema": "prognozaepir-fog-vnext-forecast-v1",
            "archive_time": mv.iso(batch),
            "run_time": mv.iso(batch),
            "model_run_time": mv.iso(model_run),
            "model": model,
            "valid_time": mv.iso(valid),
            "lead_hours": round((valid - model_run).total_seconds() / 3600.0, 2),
            "temperature_c": at(h, "temperature_2m", i),
            "dew_point_c": at(h, "dew_point_2m", i),
            "relative_humidity_pct": at(h, "relative_humidity_2m", i),
            "precipitation_mm": at(h, "precipitation", i),
            "pressure_hpa": at(h, "pressure_msl", i),
            "visibility_m": at(h, "visibility", i),
            "wind_speed_ms": at(h, "wind_speed_10m", i),
            "wind_direction_deg": at(h, "wind_direction_10m", i),
            "wind_gust_ms": at(h, "wind_gusts_10m", i),
            "weather_code": at(h, "weather_code", i),
            "cloud_total_pct": at(h, "cloud_cover", i),
            "low_pct": at(h, "cloud_cover_low", i),
            "mid_pct": at(h, "cloud_cover_mid", i),
            "high_pct": at(h, "cloud_cover_high", i),
            "cloud_base_m": at(h, "cloud_base", i),
            "cloud_cover_2m_pct": at(h, "cloud_cover_2m", i),
            "surface_temperature_c": at(h, "surface_temperature", i),
            "is_day": at(h, "is_day", i),
            "boundary_layer_height_m": at(h, "boundary_layer_height", i),
            "soil_moisture_0_to_1cm": at(h, "soil_moisture_0_to_1cm", i),
            "soil_moisture_1_to_3cm": at(h, "soil_moisture_1_to_3cm", i),
            "soil_moisture_0_to_7cm": at(h, "soil_moisture_0_to_7cm", i),
            "soil_temperature_0cm_c": at(h, "soil_temperature_0cm", i),
            "soil_temperature_6cm_c": at(h, "soil_temperature_6cm", i),
            "soil_temperature_0_7cm_c": at(h, "soil_temperature_0_7cm", i),
            "temperature_50m_c": at(h, "temperature_50m", i),
            "temperature_100m_c": at(h, "temperature_100m", i),
            "temperature_150m_c": at(h, "temperature_150m", i),
            "temperature_200m_c": at(h, "temperature_200m", i),
            "temperature_250m_c": at(h, "temperature_250m", i),
            "temperature_300m_c": at(h, "temperature_300m", i),
        }
        row["lead_bucket"] = mv.lead_bucket(row["lead_hours"])
        out.append(row)
    return out


def read_jsonl(path):
    return mv.load_jsonl(path)


def merge_write(path: Path, rows, key_fields):
    merged = {}
    for row in read_jsonl(path) + list(rows):
        key = tuple(row.get(k) for k in key_fields)
        if all(key):
            merged[key] = row
    ordered = sorted(merged.values(), key=lambda r: tuple(str(r.get(k) or "") for k in key_fields))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in ordered), encoding="utf-8")
    return len(ordered)


def base_meta(model):
    if model in EXTRA_MODELS:
        return EXTRA_MODELS[model]
    return mv.MODEL_META[model]


def representative_rows(rows):
    grouped = {}
    targets = {name: target for _a, _b, name, target in mv.LEAD_BUCKETS}
    for row in rows:
        bucket = row.get("lead_bucket")
        if not bucket:
            continue
        old = grouped.get(bucket)
        if old is None or abs(row["lead_hours"] - targets[bucket]) < abs(old["lead_hours"] - targets[bucket]):
            grouped[bucket] = row
    return list(grouped.values())


def archive(batch=None):
    batch = batch or now_hour()
    all_rows = []
    paired_rows = []
    status = {}
    for model in ("dmi_harmonie_arome_europe", "knmi_harmonie_arome_europe", "icon_d2", "ecmwf_ifs"):
        name, base_weight = base_meta(model)
        try:
            model_run, variables, data = latest_available_run(model, batch)
            rows = rows_from(model, model_run, batch, data)
            for r in rows:
                r["name"] = name
                r["base_weight"] = base_weight
                r["archive_variable_count"] = len(variables)
                r["archive_source"] = "open-meteo-single-runs"
            all_rows.extend(rows)
            paired_rows.extend(representative_rows(rows))
            status[model] = {"ok": True, "model_run_time": mv.iso(model_run), "hours": len(rows), "variables": len(variables)}
        except Exception as exc:
            status[model] = {"ok": False, "error": str(exc)}

    full_path = FULL_DIR / f"{batch:%Y-%m-%d}.jsonl"
    pair_path = mv.FORECAST_DIR / f"fog-vnext-{batch:%Y-%m-%d}.jsonl"
    full_n = merge_write(full_path, all_rows, ("archive_time", "model", "model_run_time", "valid_time"))
    pair_n = merge_write(pair_path, paired_rows, ("run_time", "model", "valid_time"))
    print(json.dumps({"archive_time": mv.iso(batch), "full_rows": full_n, "paired_rows": pair_n, "models": status}, ensure_ascii=False))
    return status


if __name__ == "__main__":
    archive()
