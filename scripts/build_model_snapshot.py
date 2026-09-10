#!/usr/bin/env python3
"""Build a server-side Open-Meteo snapshot used by the PrognozaEPIR frontend.

The browser should not depend on ten parallel cross-origin Open-Meteo calls.
GitHub Actions fetches the models, stores one compact JSON snapshot in the repo,
and the frontend serves those rows first, falling back to live Open-Meteo only
when a model is absent from the snapshot.
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "runtime" / "models-latest.json"
API = "https://api.open-meteo.com/v1/forecast"
LAT = 52.8275
LON = 18.3175
USER_AGENT = "PrognozaEPIR-ModelSnapshot/1.1"

MODELS = [
    ("ecmwf_ifs", "ECMWF", 0.17),
    ("ecmwf_aifs025_single", "ECMWF AIFS (AI)", 0.08),
    ("ncep_gfs_global", "GFS", 0.10),
    ("icon_d2", "ICON-D2", 0.12),
    ("icon_eu", "ICON-EU", 0.12),
    ("icon_global", "ICON", 0.05),
    ("chmi_aladin_central_europe_2km", "ALADIN", 0.12),
    ("meteofrance_arpege_europe", "ARPEGE EU", 0.08),
    ("ukmo_global_deterministic_10km", "UKMO", 0.06),
    ("cmc_gem_gdps", "GEM", 0.04),
]

CORE = [
    "temperature_2m", "dew_point_2m", "relative_humidity_2m",
    "precipitation", "pressure_msl", "visibility",
    "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m",
    "weather_code", "cloud_cover", "cloud_cover_low",
    "cloud_cover_mid", "cloud_cover_high",
    "cape", "lifted_index", "convective_inhibition", "freezing_level_height",
]
COMMON_LEVELS = [1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 275, 250, 200]
ALADIN_LEVELS = [1000, 950, 925, 850, 800, 700, 600, 500, 450, 400, 350, 300, 275, 250, 200]


def iso_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def request_json(model_id: str, variables: list[str], retries: int = 3, timeout: int = 35):
    params = {
        "latitude": LAT,
        "longitude": LON,
        "hourly": ",".join(variables),
        "models": model_id,
        "timezone": "UTC",
        "forecast_days": 6,
        "wind_speed_unit": "ms",
    }
    url = API + "?" + urllib.parse.urlencode(params)
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except Exception as exc:
            last = exc
            if attempt + 1 < retries:
                time.sleep(1.2 * (attempt + 1))
    raise last


def merge_payload(base: dict | None, extra: dict | None):
    if not extra:
        return base
    if base is None:
        base = {
            "latitude": extra.get("latitude"),
            "longitude": extra.get("longitude"),
            "elevation": extra.get("elevation"),
            "timezone": extra.get("timezone"),
            "hourly_units": {},
            "hourly": {},
        }
    bh, eh = base.setdefault("hourly", {}), extra.get("hourly") or {}
    if not bh.get("time") and eh.get("time"):
        bh["time"] = eh["time"]
    for k, v in eh.items():
        if k != "time" and isinstance(v, list):
            bh[k] = v
    base.setdefault("hourly_units", {}).update(extra.get("hourly_units") or {})
    if base.get("elevation") is None and extra.get("elevation") is not None:
        base["elevation"] = extra.get("elevation")
    return base


def fetch_resilient(model_id: str, variables: list[str], min_chunk: int = 3):
    """Salvage supported variables instead of failing an entire model on one 400."""
    failures = []

    def rec(chunk: list[str]):
        if not chunk:
            return None
        try:
            return request_json(model_id, chunk)
        except Exception:
            if len(chunk) <= min_chunk:
                merged = None
                for v in chunk:
                    try:
                        merged = merge_payload(merged, request_json(model_id, [v], retries=2))
                    except Exception as one:
                        failures.append((v, str(one)))
                return merged
            mid = len(chunk) // 2
            left = rec(chunk[:mid])
            right = rec(chunk[mid:])
            return merge_payload(left, right)

    return rec(variables), failures


def profile_variables(model_id: str):
    levels = ALADIN_LEVELS if model_id == "chmi_aladin_central_europe_2km" else COMMON_LEVELS
    out = []
    for p in levels:
        out += [
            f"temperature_{p}hPa",
            f"relative_humidity_{p}hPa",
            f"cloud_cover_{p}hPa",
            f"wind_speed_{p}hPa",
            f"wind_direction_{p}hPa",
            f"vertical_velocity_{p}hPa",
            f"geopotential_height_{p}hPa",
        ]
    return out


def fetch_model(model_id: str, name: str, base_weight: float):
    core, core_fail = fetch_resilient(model_id, CORE)
    if not core or not (core.get("hourly") or {}).get("time"):
        raise RuntimeError("no core hourly.time")

    prof, prof_fail = fetch_resilient(model_id, profile_variables(model_id))
    merged = merge_payload(core, prof)
    hourly = merged.get("hourly") or {}
    times = hourly.get("time") or []
    if not times:
        raise RuntimeError("merged snapshot has no hourly.time")

    n = len(times)
    for k, arr in list(hourly.items()):
        if k == "time" or not isinstance(arr, list):
            continue
        if len(arr) < n:
            hourly[k] = arr + [None] * (n - len(arr))
        elif len(arr) > n:
            hourly[k] = arr[:n]

    return {
        "name": name,
        "base_weight": base_weight,
        "status": "ok",
        "elevation": merged.get("elevation"),
        "hourly_units": merged.get("hourly_units") or {},
        "hourly": hourly,
        "available_variables": sorted(k for k in hourly if k != "time"),
        "variable_failures": {
            "core": core_fail[:30],
            "profile": prof_fail[:60],
        },
    }


def main():
    result = {
        "schema": "prognozaepir-model-snapshot-v1",
        "generated_at": iso_now(),
        "source": "Open-Meteo fetched server-side by GitHub Actions",
        "location": {"lat": LAT, "lon": LON},
        "forecast_days": 6,
        "models": {},
        "failures": {},
    }

    for model_id, name, weight in MODELS:
        try:
            row = fetch_model(model_id, name, weight)
            result["models"][model_id] = row
            print(model_id, "ok", len((row.get("hourly") or {}).get("time") or []), "hours", len(row.get("available_variables") or []), "vars")
        except Exception as exc:
            result["failures"][model_id] = str(exc)
            print(model_id, "FAILED", exc)

    ok = len(result["models"])
    if ok < 3:
        raise SystemExit(f"snapshot rejected: only {ok}/{len(MODELS)} models available")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"snapshot written: {OUT.relative_to(ROOT)}; models={ok}/{len(MODELS)}")


if __name__ == "__main__":
    main()