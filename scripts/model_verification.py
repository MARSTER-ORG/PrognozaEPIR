#!/usr/bin/env python3
"""Archive EPIR model forecasts and verify them against real observations.

The score is based on forecasts that were archived before their valid time.
Observation matching uses EPIR METAR/SPECI and WMO 12342 SYNOP from the
corresponding hour. Older cloud-only forecast archives remain usable; newer
records add temperature, dew point, pressure, wind, visibility and precipitation.
"""
from __future__ import annotations

import json
import math
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEARNING = ROOT / "data" / "learning"
LEGACY_FORECAST_DIR = LEARNING / "forecasts"
FORECAST_DIR = LEARNING / "model-forecasts"
SUMMARY_PATH = LEARNING / "model-verification.json"
METAR_DIR = ROOT / "data" / "observations" / "metar"
SYNOP_DIR = ROOT / "data" / "observations" / "synop"
LAT = 52.7989
LON = 18.2639

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
MODEL_META = {m: (name, weight) for m, name, weight in MODELS}

LEAD_BUCKETS = [
    (0, 3, "0-3h", 1.5),
    (3, 6, "3-6h", 4.5),
    (6, 12, "6-12h", 9.0),
    (12, 24, "12-24h", 18.0),
    (24, 48, "24-48h", 36.0),
    (48, 121, "48-120h", 72.0),
]

HOURLY = [
    "temperature_2m", "dew_point_2m", "relative_humidity_2m",
    "precipitation", "pressure_msl", "visibility",
    "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m",
    "weather_code", "cloud_cover", "cloud_cover_low",
    "cloud_cover_mid", "cloud_cover_high",
]

PARAM_WEIGHTS = {
    "temperature": 1.0,
    "dew_point": 1.0,
    "pressure": 0.8,
    "wind": 1.0,
    "visibility": 1.3,
    "cloud": 1.3,
    "precipitation": 0.6,
}


def utcnow():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_dt(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return None


def finite(v):
    return isinstance(v, (int, float)) and math.isfinite(v)


def get_json(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": "PrognozaEPIR-ModelVerification/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def load_jsonl(path: Path):
    out = []
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def all_jsonl(directory: Path):
    out = []
    if directory.exists():
        for p in sorted(directory.rglob("*.jsonl")):
            out.extend(load_jsonl(p))
    return out


def append_jsonl(path: Path, row):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def lead_bucket(hours):
    for a, b, name, _ in LEAD_BUCKETS:
        if a <= hours < b:
            return name
    return None


def bucket_target(name):
    for _, _, bucket, target in LEAD_BUCKETS:
        if bucket == name:
            return target
    return None


def representative_rows(rows, run):
    grouped = defaultdict(list)
    for r in rows:
        valid = parse_dt(r.get("valid_time"))
        if not valid:
            continue
        lead_h = (valid - run).total_seconds() / 3600.0
        bucket = lead_bucket(lead_h)
        if bucket:
            grouped[bucket].append((lead_h, r))
    selected = []
    for bucket, candidates in grouped.items():
        target = bucket_target(bucket)
        lead_h, row = min(candidates, key=lambda x: abs(x[0] - target))
        selected.append((bucket, lead_h, row))
    return selected


def fetch_model(model_id):
    params = {
        "latitude": LAT,
        "longitude": LON,
        "hourly": ",".join(HOURLY),
        "models": model_id,
        "timezone": "UTC",
        "forecast_days": 6,
        "wind_speed_unit": "ms",
    }
    url = "https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(params)
    j = get_json(url)
    h = j.get("hourly") or {}
    times = h.get("time") or []
    rows = []
    for i, ts in enumerate(times):
        valid = parse_dt(ts)
        if not valid:
            continue
        def at(key):
            arr = h.get(key) or []
            return arr[i] if i < len(arr) else None
        rows.append({
            "valid_time": iso(valid),
            "temperature_c": at("temperature_2m"),
            "dew_point_c": at("dew_point_2m"),
            "relative_humidity_pct": at("relative_humidity_2m"),
            "precipitation_mm": at("precipitation"),
            "pressure_hpa": at("pressure_msl"),
            "visibility_m": at("visibility"),
            "wind_speed_ms": at("wind_speed_10m"),
            "wind_direction_deg": at("wind_direction_10m"),
            "wind_gust_ms": at("wind_gusts_10m"),
            "weather_code": at("weather_code"),
            "cloud_total_pct": at("cloud_cover"),
            "low_pct": at("cloud_cover_low"),
            "mid_pct": at("cloud_cover_mid"),
            "high_pct": at("cloud_cover_high"),
        })
    return rows


def archive_forecasts():
    run = utcnow()
    path = FORECAST_DIR / f"{run:%Y-%m-%d}.jsonl"
    existing = load_jsonl(path)
    seen = {(r.get("run_time"), r.get("model"), r.get("valid_time")) for r in existing}
    added = 0
    for model_id, name, weight in MODELS:
        try:
            rows = fetch_model(model_id)
        except Exception as exc:
            print(f"model verification forecast {model_id}: {exc}")
            continue
        for bucket, lead_h, row in representative_rows(rows, run):
            key = (iso(run), model_id, row["valid_time"])
            if key in seen:
                continue
            append_jsonl(path, {
                "schema": "prognozaepir-model-forecast-v1",
                "run_time": iso(run),
                "model": model_id,
                "name": name,
                "base_weight": weight,
                "lead_hours": round(lead_h, 2),
                "lead_bucket": bucket,
                **row,
            })
            seen.add(key)
            added += 1
    print(f"model forecasts archived: {added}")


def unique_rows(rows, key_fields):
    out = {}
    for r in rows:
        key = tuple(r.get(k) for k in key_fields)
        if any(v is None for v in key):
            continue
        old = out.get(key)
        if old is None or sum(v is not None for v in r.values()) > sum(v is not None for v in old.values()):
            out[key] = r
    return list(out.values())


def round_hour(dt):
    hour = dt.replace(minute=0, second=0, microsecond=0)
    if dt.minute >= 30:
        from datetime import timedelta
        hour += timedelta(hours=1)
    return hour


def build_observation_maps():
    metars = unique_rows(all_jsonl(METAR_DIR), ("obs_time", "raw"))
    synops = unique_rows(all_jsonl(SYNOP_DIR), ("obs_time", "raw"))
    metar_by_hour = {}
    for m in metars:
        dt = parse_dt(m.get("obs_time"))
        if not dt:
            continue
        h = round_hour(dt)
        diff = abs((dt - h).total_seconds())
        if diff > 31 * 60:
            continue
        k = iso(h)
        prev = metar_by_hour.get(k)
        if prev is None or diff < prev[0]:
            metar_by_hour[k] = (diff, m)
    synop_by_hour = {}
    for s in synops:
        dt = parse_dt(s.get("obs_time"))
        if not dt:
            continue
        h = dt.replace(minute=0, second=0, microsecond=0)
        if abs((dt - h).total_seconds()) <= 10 * 60:
            synop_by_hour[iso(h)] = s
    return {k: v[1] for k, v in metar_by_hour.items()}, synop_by_hour


def cover_range(code):
    return {"FEW": (1, 2), "SCT": (3, 4), "BKN": (5, 7), "OVC": (8, 8)}.get(code)


def observed_cloud_bands(m):
    out = {"low": None, "mid": None, "high": None}
    if not m:
        return out
    for c in m.get("clouds") or []:
        rng = cover_range(c.get("cover"))
        h = c.get("base_m_agl")
        if not rng or not finite(h):
            continue
        band = "low" if h < 2000 else ("mid" if h < 5000 else "high")
        cur = out[band]
        if cur is None or rng[1] > cur[1]:
            out[band] = rng
    raw = (m.get("raw") or "").upper()
    if (" NSC " in f" {raw} " or " CAVOK " in f" {raw} " or " NCD " in f" {raw} ") and out["low"] is None:
        out["low"] = (0, 2)
    return out


def okta(v):
    if not finite(v):
        return None
    return max(0, min(8, int(round(v / 12.5))))


def dist_range(v, rng):
    if v < rng[0]:
        return rng[0] - v
    if v > rng[1]:
        return v - rng[1]
    return 0.0


def tol_score(error, good, bad):
    if not finite(error):
        return None
    if error <= good:
        return 100.0
    if error >= bad:
        return 0.0
    return 100.0 * (bad - error) / (bad - good)


def circular_error(a, b):
    if not finite(a) or not finite(b):
        return None
    d = abs((a - b) % 360.0)
    return min(d, 360.0 - d)


def visibility_score(pred, obs, lower_bound=False):
    if not finite(pred) or not finite(obs):
        return None
    pred = max(0.0, pred)
    obs = max(0.0, obs)
    if lower_bound:
        if pred >= obs:
            return 100.0
        return tol_score(obs - pred, 500.0, max(5000.0, obs * 0.8))
    err = abs(pred - obs)
    good = max(1000.0, obs * 0.20)
    bad = max(5000.0, obs * 0.80)
    return tol_score(err, good, bad)


def precip_observed(m, s):
    wet_codes = ("RA", "DZ", "SN", "SG", "PL", "GR", "GS", "UP")
    if m:
        wx = str(m.get("weather") or "").upper()
        raw = str(m.get("raw") or "").upper()
        if any(code in wx for code in wet_codes) or any(f" {code}" in raw for code in wet_codes):
            return True
    if s and isinstance(s.get("present_weather_code"), int):
        ww = s["present_weather_code"]
        if 50 <= ww <= 99:
            return True
    if m or s:
        return False
    return None


def component_scores(f, m, s):
    scores = {}

    temp_obs = s.get("temperature_c") if s and finite(s.get("temperature_c")) else (m.get("temperature_c") if m else None)
    if finite(f.get("temperature_c")) and finite(temp_obs):
        scores["temperature"] = tol_score(abs(f["temperature_c"] - temp_obs), 1.0, 6.0)

    dew_obs = s.get("dew_point_c") if s and finite(s.get("dew_point_c")) else (m.get("dew_point_c") if m else None)
    if finite(f.get("dew_point_c")) and finite(dew_obs):
        scores["dew_point"] = tol_score(abs(f["dew_point_c"] - dew_obs), 1.5, 6.0)

    p_obs = s.get("pressure_hpa") if s and finite(s.get("pressure_hpa")) else (m.get("pressure_hpa") if m else None)
    if finite(f.get("pressure_hpa")) and finite(p_obs):
        scores["pressure"] = tol_score(abs(f["pressure_hpa"] - p_obs), 1.5, 8.0)

    ws_obs = s.get("wind_speed_ms") if s and finite(s.get("wind_speed_ms")) else (m.get("wind_speed_ms") if m else None)
    wd_obs = s.get("wind_direction_deg") if s and finite(s.get("wind_direction_deg")) else (m.get("wind_direction_deg") if m else None)
    wind_parts = []
    if finite(f.get("wind_speed_ms")) and finite(ws_obs):
        wind_parts.append(tol_score(abs(f["wind_speed_ms"] - ws_obs), 1.5, 6.0))
    if finite(f.get("wind_direction_deg")) and finite(wd_obs) and (not finite(ws_obs) or ws_obs >= 1.5):
        wind_parts.append(tol_score(circular_error(f["wind_direction_deg"], wd_obs), 20.0, 90.0))
    wind_parts = [x for x in wind_parts if x is not None]
    if wind_parts:
        scores["wind"] = sum(wind_parts) / len(wind_parts)

    if m and finite(m.get("visibility_m")):
        vs = visibility_score(f.get("visibility_m"), m.get("visibility_m"), bool(m.get("visibility_lower_bound")))
    elif s and finite(s.get("visibility_m")):
        vs = visibility_score(f.get("visibility_m"), s.get("visibility_m"), bool(s.get("visibility_lower_bound")))
    else:
        vs = None
    if vs is not None:
        scores["visibility"] = vs

    cloud_parts = []
    bands = observed_cloud_bands(m)
    for band in ("low", "mid", "high"):
        pred = okta(f.get(f"{band}_pct"))
        if pred is not None and bands[band] is not None:
            cloud_parts.append(tol_score(dist_range(pred, bands[band]), 0.0, 5.0))
    if s and finite(s.get("total_cloud_oktas")):
        total_pct = f.get("cloud_total_pct")
        if not finite(total_pct):
            vals = [f.get("low_pct"), f.get("mid_pct"), f.get("high_pct")]
            vals = [x for x in vals if finite(x)]
            total_pct = max(vals) if vals else None
        pred_total = okta(total_pct)
        if pred_total is not None:
            cloud_parts.append(tol_score(abs(pred_total - s["total_cloud_oktas"]), 1.0, 5.0))
    cloud_parts = [x for x in cloud_parts if x is not None]
    if cloud_parts:
        scores["cloud"] = sum(cloud_parts) / len(cloud_parts)

    wet_obs = precip_observed(m, s)
    if wet_obs is not None and finite(f.get("precipitation_mm")):
        wet_pred = f["precipitation_mm"] >= 0.1
        if wet_pred == wet_obs:
            scores["precipitation"] = 100.0
        elif wet_obs and not wet_pred:
            scores["precipitation"] = 0.0
        else:
            scores["precipitation"] = 35.0

    return scores


def weighted_value(rows, key):
    total = 0.0
    weight = 0.0
    for r in rows:
        v = r.get(key)
        w = r.get("base_weight")
        if finite(v) and finite(w) and w > 0:
            total += v * w
            weight += w
    return total / weight if weight else None


def weighted_direction(rows):
    u = v = wsum = 0.0
    for r in rows:
        d = r.get("wind_direction_deg")
        w = r.get("base_weight")
        if not finite(d) or not finite(w) or w <= 0:
            continue
        rad = math.radians(d)
        u += math.sin(rad) * w
        v += math.cos(rad) * w
        wsum += w
    if not wsum:
        return None
    return (math.degrees(math.atan2(u / wsum, v / wsum)) + 360.0) % 360.0


def consensus_row(rows):
    if not rows:
        return None
    first = rows[0]
    out = {
        "model": "consensus",
        "name": "PrognozaEPIR CONSENSUS",
        "run_time": first.get("run_time"),
        "valid_time": first.get("valid_time"),
        "lead_hours": weighted_value(rows, "lead_hours"),
        "lead_bucket": first.get("lead_bucket"),
        "base_weight": 1.0,
    }
    for key in (
        "temperature_c", "dew_point_c", "relative_humidity_pct", "precipitation_mm",
        "pressure_hpa", "visibility_m", "wind_speed_ms", "wind_gust_ms",
        "weather_code", "cloud_total_pct", "low_pct", "mid_pct", "high_pct",
    ):
        out[key] = weighted_value(rows, key)
    out["wind_direction_deg"] = weighted_direction(rows)
    return out


def load_forecasts():
    rows = all_jsonl(LEGACY_FORECAST_DIR) + all_jsonl(FORECAST_DIR)
    best = {}
    surface_keys = ("temperature_c", "dew_point_c", "pressure_hpa", "visibility_m", "wind_speed_ms")
    for r in rows:
        key = (r.get("run_time"), r.get("model"), r.get("valid_time"))
        if not all(key):
            continue
        if r.get("model") not in MODEL_META:
            continue
        if not finite(r.get("base_weight")):
            r = dict(r)
            r["base_weight"] = MODEL_META[r["model"]][1]
        quality = sum(finite(r.get(k)) for k in surface_keys)
        old = best.get(key)
        old_quality = sum(finite(old.get(k)) for k in surface_keys) if old else -1
        if old is None or quality > old_quality:
            best[key] = r
    return list(best.values())


def build_summary():
    forecasts = load_forecasts()
    metar_by_hour, synop_by_hour = build_observation_maps()
    now = utcnow()

    stats = defaultdict(lambda: defaultdict(lambda: [0, 0.0]))
    forecast_samples = defaultdict(int)
    source_hits = defaultdict(lambda: {"METAR": 0, "SPECI": 0, "SYNOP": 0})

    def consume(model, f):
        valid = parse_dt(f.get("valid_time"))
        run = parse_dt(f.get("run_time"))
        if not valid or not run or valid > now or run >= valid:
            return
        key = iso(valid.replace(minute=0, second=0, microsecond=0))
        m = metar_by_hour.get(key)
        s = synop_by_hour.get(key)
        if not m and not s:
            return
        scores = component_scores(f, m, s)
        scores = {k: v for k, v in scores.items() if v is not None and finite(v)}
        if not scores:
            return
        forecast_samples[model] += 1
        if m:
            raw = str(m.get("raw") or "").lstrip().upper()
            source_hits[model]["SPECI" if raw.startswith("SPECI") else "METAR"] += 1
        if s:
            source_hits[model]["SYNOP"] += 1
        for comp, score in scores.items():
            stats[model][comp][0] += 1
            stats[model][comp][1] += score

    for f in forecasts:
        consume(f["model"], f)

    grouped = defaultdict(list)
    for f in forecasts:
        grouped[(f.get("run_time"), f.get("valid_time"))].append(f)
    for rows in grouped.values():
        c = consensus_row(rows)
        if c:
            consume("consensus", c)

    output = {
        "schema": "prognozaepir-model-verification-v1",
        "generated_at": iso(now),
        "method": "Archived forecast vs corresponding-hour EPIR METAR/SPECI and WMO 12342 SYNOP; weighted aviation-parameter tolerance score",
        "models": {},
    }

    ordered = [("consensus", "PrognozaEPIR CONSENSUS", 1.0)] + MODELS
    for model, name, _ in ordered:
        comps = {}
        weighted_sum = 0.0
        weighted_n = 0.0
        for comp, weight in PARAM_WEIGHTS.items():
            n, total = stats[model].get(comp, [0, 0.0])
            mean = total / n if n else None
            comps[comp] = {"n": n, "score_pct": round(mean) if mean is not None else None}
            if mean is not None:
                weighted_sum += mean * weight
                weighted_n += weight
        score = weighted_sum / weighted_n if weighted_n else None
        output["models"][model] = {
            "name": name,
            "score_pct": round(score) if score is not None and forecast_samples[model] >= 3 else None,
            "forecast_samples": forecast_samples[model],
            "sources": source_hits[model],
            "components": comps,
        }

    SUMMARY_PATH.parent.mkdir(parents=True, exist_ok=True)
    SUMMARY_PATH.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("model verification summary:", {k: v["score_pct"] for k, v in output["models"].items()})


def main():
    archive_forecasts()
    build_summary()


if __name__ == "__main__":
    main()
