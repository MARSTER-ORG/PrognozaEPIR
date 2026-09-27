#!/usr/bin/env python3
"""Learn EPIR phenomenon physics from historical observations + ERA5 reanalysis.

This is deliberately a truth/environment learning track, not model verification.
ERA5 is used only to describe the atmospheric/surface environment around observed
FG, MIFG, BR, low-cloud and convective cases. It must never be treated as a
forecast that existed before the observation, and it must never change model
skill scores or adaptive forecast-model weights.

The job is resumable and repository-friendly: one compact monthly sufficient-
statistics file is stored per processed month. Raw hourly ERA5 arrays are never
committed. The aggregate artifact contains base rates, feature moments and
fixed-bin event rates suitable for conservative physical priors.
"""
from __future__ import annotations

import argparse
import calendar
import json
import math
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import fog_vnext_event_backfill as fog_hist
import model_verification as mv

ROOT = Path(__file__).resolve().parents[1]
LEARNING = ROOT / "data" / "learning"
MONTH_DIR = LEARNING / "reanalysis-physics" / "monthly"
STATE_PATH = LEARNING / "reanalysis-physics-state.json"
OUT_PATH = LEARNING / "historical-physics-priors.json"

API = "https://archive-api.open-meteo.com/v1/archive"
MODEL = "era5"
START_DATE = date(2020, 1, 1)
END_DATE = date(2024, 12, 31)
MAX_ATTEMPTS = 4
USER_AGENT = "PrognozaEPIR-HistoricalPhysics/1.0"

GUARDRAILS = {
    "reanalysis_is_not_an_issued_forecast": True,
    "may_calibrate_model_skill": False,
    "may_change_adaptive_model_weights": False,
    "may_rank_operational_models": False,
    "purpose": "physical/climatological event priors only",
}

CORE_VARS = (
    "temperature_2m",
    "dew_point_2m",
    "relative_humidity_2m",
    "precipitation",
    "pressure_msl",
    "cloud_cover",
    "cloud_cover_low",
    "cloud_cover_mid",
    "cloud_cover_high",
    "wind_speed_10m",
    "wind_direction_10m",
    "soil_temperature_0_to_7cm",
    "soil_moisture_0_to_7cm",
    "boundary_layer_height",
    "shortwave_radiation",
)

VARIABLE_TIERS = (
    CORE_VARS,
    tuple(v for v in CORE_VARS if v != "boundary_layer_height"),
    tuple(v for v in CORE_VARS if v not in {"boundary_layer_height", "soil_temperature_0_to_7cm", "soil_moisture_0_to_7cm"}),
)

FEATURE_BINS = {
    "temperature_c": [-20, -10, -5, 0, 5, 10, 15, 20, 25, 30],
    "dewpoint_depression_c": [0, 0.5, 1, 2, 3, 5, 8, 12],
    "relative_humidity_pct": [50, 70, 80, 85, 90, 93, 95, 97, 99],
    "wind_speed_ms": [0.5, 1, 2, 3, 4, 5, 7, 10],
    "pbl_height_m": [25, 50, 100, 150, 250, 400, 700, 1200],
    "cloud_low_pct": [10, 25, 50, 75, 90, 100],
    "cloud_total_pct": [10, 25, 50, 75, 90, 100],
    "soil_moisture_0_7cm": [0.1, 0.2, 0.3, 0.4, 0.5],
    "air_minus_soil_temp_c": [-5, -2, -1, 0, 1, 2, 5],
    "precip_6h_mm": [0, 0.1, 0.5, 1, 2, 5, 10],
    "precip_12h_mm": [0, 0.1, 0.5, 1, 2, 5, 10, 20],
    "rh_change_1h_pct": [-10, -5, -2, 0, 2, 5, 10],
    "rh_change_3h_pct": [-15, -8, -4, 0, 4, 8, 15],
    "pbl_change_1h_m": [-300, -150, -50, 0, 50, 150, 300],
    "pbl_change_3h_m": [-600, -300, -100, 0, 100, 300, 600],
    "temperature_change_1h_c": [-3, -1.5, -0.5, 0, 0.5, 1.5, 3],
    "temperature_change_3h_c": [-6, -3, -1, 0, 1, 3, 6],
    "low_cloud_change_1h_pct": [-50, -25, -10, 0, 10, 25, 50],
    "low_cloud_change_3h_pct": [-75, -40, -15, 0, 15, 40, 75],
    "shortwave_radiation_wm2": [0, 10, 50, 100, 200, 400, 600, 800],
}

FEATURE_NAMES = tuple(FEATURE_BINS)
TARGETS = ("FG", "MIFG", "BR", "LOW_CLOUD", "CONVECTION")
WIND_SECTORS = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")


def utcnow():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def parse_day(s):
    return datetime.strptime(s, "%Y-%m-%d").date()


def month_key(d):
    return f"{d.year:04d}-{d.month:02d}"


def month_bounds(key):
    y, m = map(int, key.split("-"))
    last = calendar.monthrange(y, m)[1]
    return date(y, m, 1), date(y, m, last)


def iter_months(start, end):
    cur = date(start.year, start.month, 1)
    stop = date(end.year, end.month, 1)
    while cur <= stop:
        yield month_key(cur)
        cur = date(cur.year + (cur.month == 12), 1 if cur.month == 12 else cur.month + 1, 1)


def get_json(url, retries=5, timeout=90):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, socket.timeout, TimeoutError, json.JSONDecodeError) as exc:
            last = exc
            if isinstance(exc, urllib.error.HTTPError) and exc.code not in {408, 425, 429, 500, 502, 503, 504}:
                raise
            if attempt + 1 < retries:
                import time
                time.sleep(min(16, 1.5 * (2 ** attempt)))
    raise last or RuntimeError("archive request failed")


def fetch_month(key):
    start, end = month_bounds(key)
    request_start = start - timedelta(days=1)
    last_error = None
    for variables in VARIABLE_TIERS:
        params = {
            "latitude": mv.LAT,
            "longitude": mv.LON,
            "start_date": request_start.isoformat(),
            "end_date": end.isoformat(),
            "hourly": ",".join(variables),
            "models": MODEL,
            "timezone": "UTC",
            "wind_speed_unit": "ms",
        }
        url = API + "?" + urllib.parse.urlencode(params)
        try:
            data = get_json(url)
            hourly = data.get("hourly") or {}
            if not hourly.get("time"):
                raise RuntimeError("ERA5 returned no hourly data")
            return hourly, list(variables)
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code != 400:
                raise
        except Exception as exc:
            last_error = exc
            raise
    raise last_error or RuntimeError("no ERA5 variable tier succeeded")


def hourly_index(hourly):
    out = {}
    for i, ts in enumerate(hourly.get("time") or []):
        try:
            dt = datetime.fromisoformat(str(ts)).replace(tzinfo=timezone.utc)
        except Exception:
            continue
        out[dt] = i
    return out


def at(hourly, key, i):
    arr = hourly.get(key) or []
    v = arr[i] if 0 <= i < len(arr) else None
    return float(v) if finite(v) else None


def delta(hourly, key, i, back):
    now = at(hourly, key, i)
    old = at(hourly, key, i - back)
    return now - old if finite(now) and finite(old) else None


def rolling_sum(hourly, key, i, hours):
    vals = [at(hourly, key, j) for j in range(max(0, i - hours + 1), i + 1)]
    if len(vals) < hours or any(not finite(v) for v in vals):
        return None
    return sum(vals)


def feature_row(hourly, i):
    t = at(hourly, "temperature_2m", i)
    td = at(hourly, "dew_point_2m", i)
    soil_t = at(hourly, "soil_temperature_0_to_7cm", i)
    return {
        "temperature_c": t,
        "dewpoint_depression_c": (t - td) if finite(t) and finite(td) else None,
        "relative_humidity_pct": at(hourly, "relative_humidity_2m", i),
        "wind_speed_ms": at(hourly, "wind_speed_10m", i),
        "pbl_height_m": at(hourly, "boundary_layer_height", i),
        "cloud_low_pct": at(hourly, "cloud_cover_low", i),
        "cloud_total_pct": at(hourly, "cloud_cover", i),
        "soil_moisture_0_7cm": at(hourly, "soil_moisture_0_to_7cm", i),
        "air_minus_soil_temp_c": (t - soil_t) if finite(t) and finite(soil_t) else None,
        "precip_6h_mm": rolling_sum(hourly, "precipitation", i, 6),
        "precip_12h_mm": rolling_sum(hourly, "precipitation", i, 12),
        "rh_change_1h_pct": delta(hourly, "relative_humidity_2m", i, 1),
        "rh_change_3h_pct": delta(hourly, "relative_humidity_2m", i, 3),
        "pbl_change_1h_m": delta(hourly, "boundary_layer_height", i, 1),
        "pbl_change_3h_m": delta(hourly, "boundary_layer_height", i, 3),
        "temperature_change_1h_c": delta(hourly, "temperature_2m", i, 1),
        "temperature_change_3h_c": delta(hourly, "temperature_2m", i, 3),
        "low_cloud_change_1h_pct": delta(hourly, "cloud_cover_low", i, 1),
        "low_cloud_change_3h_pct": delta(hourly, "cloud_cover_low", i, 3),
        "shortwave_radiation_wm2": at(hourly, "shortwave_radiation", i),
    }


def raw_text(row):
    return str(row.get("canonical_raw") or row.get("raw") or "").upper()


def cloud_label(row):
    raw = raw_text(row)
    if not raw:
        return None
    if re.search(r"\bVV(?:///|\d{3})\b", raw):
        m = re.search(r"\bVV(\d{3})\b", raw)
        if m and int(m.group(1)) * 100 <= 1500:
            return True
        if "VV///" in raw:
            return None
    cloud_groups = list(re.finditer(r"\b(FEW|SCT|BKN|OVC)(\d{3}|///)(?:CB|TCU)?\b", raw))
    known = False
    for m in cloud_groups:
        cover, base = m.group(1), m.group(2)
        if base == "///":
            continue
        known = True
        if cover in {"BKN", "OVC"} and int(base) * 100 <= 1500:
            return True
    if known or any(tok in raw.split() for tok in ("CAVOK", "NSC", "NCD", "SKC", "CLR")):
        return False
    return None


def convection_label(row):
    raw = raw_text(row)
    if not raw:
        return None
    return bool(re.search(r"(?:^|\s)(?:VCTS|[-+]?TS[A-Z]*)(?:\s|$)|\b(?:FEW|SCT|BKN|OVC)\d{3}(?:CB|TCU)\b", raw))


def collapse_observations(rows, start, end):
    by_hour = defaultdict(list)
    for dt, row, state in fog_hist.points_from_rows(rows):
        if dt.date() < start or dt.date() > end:
            continue
        hour = dt.replace(minute=0, second=0, microsecond=0)
        by_hour[hour].append((dt, row, state))

    out = {}
    priority = {"FG": 0, "MIFG": 1, "BR": 2, "CLEAR": 3, "UNKNOWN": 4}
    for hour, items in by_hour.items():
        items.sort(key=lambda x: (priority.get(x[2], 9), abs(x[0].minute - 30)))
        states = [x[2] for x in items]
        state = min(states, key=lambda s: priority.get(s, 9))
        cloud_values = [cloud_label(row) for _dt, row, _state in items]
        conv_values = [convection_label(row) for _dt, row, _state in items]
        out[hour] = {
            "fog_state": state,
            "LOW_CLOUD": True if True in cloud_values else (False if False in cloud_values else None),
            "CONVECTION": True if True in conv_values else (False if False in conv_values else None),
            "reports": len(items),
        }
    return out


def labels_for(obs):
    state = obs.get("fog_state")
    fog_known = state in {"FG", "MIFG", "BR", "CLEAR"}
    return {
        "FG": (state == "FG") if fog_known else None,
        "MIFG": (state == "MIFG") if fog_known else None,
        "BR": (state == "BR") if fog_known else None,
        "LOW_CLOUD": obs.get("LOW_CLOUD"),
        "CONVECTION": obs.get("CONVECTION"),
    }


def bin_index(value, edges):
    for idx, edge in enumerate(edges):
        if value < edge:
            return idx
    return len(edges)


def new_moment(feature):
    return {"n": 0, "sum": 0.0, "sumsq": 0.0, "min": None, "max": None, "hist": [0] * (len(FEATURE_BINS[feature]) + 1)}


def add_moment(moment, feature, value):
    if not finite(value):
        return
    v = float(value)
    moment["n"] += 1
    moment["sum"] += v
    moment["sumsq"] += v * v
    moment["min"] = v if moment["min"] is None else min(moment["min"], v)
    moment["max"] = v if moment["max"] is None else max(moment["max"], v)
    moment["hist"][bin_index(v, FEATURE_BINS[feature])] += 1


def wind_sector(deg):
    if not finite(deg):
        return None
    return WIND_SECTORS[int(((float(deg) % 360.0) + 22.5) // 45.0) % 8]


def empty_target():
    return {
        "positive_cases": 0,
        "negative_cases": 0,
        "unknown_cases": 0,
        "features": {f: {"positive": new_moment(f), "negative": new_moment(f)} for f in FEATURE_NAMES},
        "wind_direction": {
            "positive": {s: 0 for s in WIND_SECTORS},
            "negative": {s: 0 for s in WIND_SECTORS},
        },
    }


def build_month_summary(key, rows):
    start, end = month_bounds(key)
    hourly, used_vars = fetch_month(key)
    index = hourly_index(hourly)
    observations = collapse_observations(rows, start, end)
    targets = {t: empty_target() for t in TARGETS}
    matched = 0
    reports = 0

    for hour, obs in sorted(observations.items()):
        i = index.get(hour)
        if i is None:
            continue
        features = feature_row(hourly, i)
        sector = wind_sector(at(hourly, "wind_direction_10m", i))
        labels = labels_for(obs)
        matched += 1
        reports += int(obs.get("reports") or 0)

        for target, label in labels.items():
            bucket = targets[target]
            if label is None:
                bucket["unknown_cases"] += 1
                continue
            cls = "positive" if label else "negative"
            bucket[f"{cls}_cases"] += 1
            for feature, value in features.items():
                add_moment(bucket["features"][feature][cls], feature, value)
            if sector:
                bucket["wind_direction"][cls][sector] += 1

    return {
        "schema": "prognozaepir-reanalysis-physics-month-v1",
        "month": key,
        "generated_at_utc": iso(utcnow()),
        "location": {"latitude": mv.LAT, "longitude": mv.LON, "station": "EPIR"},
        "reanalysis": {"provider": "Open-Meteo Historical Weather API", "model": MODEL, "variables": used_vars},
        "guardrails": GUARDRAILS,
        "observation_hours": len(observations),
        "matched_hours": matched,
        "source_reports": reports,
        "targets": targets,
    }


def merge_moment(dst, src):
    dst["n"] += int(src.get("n") or 0)
    dst["sum"] += float(src.get("sum") or 0.0)
    dst["sumsq"] += float(src.get("sumsq") or 0.0)
    if src.get("min") is not None:
        dst["min"] = src["min"] if dst["min"] is None else min(dst["min"], src["min"])
    if src.get("max") is not None:
        dst["max"] = src["max"] if dst["max"] is None else max(dst["max"], src["max"])
    for i, n in enumerate(src.get("hist") or []):
        if i < len(dst["hist"]):
            dst["hist"][i] += int(n or 0)


def summarize_moment(m):
    n = int(m.get("n") or 0)
    if n <= 0:
        return {"n": 0, "mean": None, "std": None, "min": None, "max": None, "hist": list(m.get("hist") or [])}
    mean = m["sum"] / n
    variance = max(0.0, m["sumsq"] / n - mean * mean)
    return {
        "n": n,
        "mean": round(mean, 4),
        "std": round(math.sqrt(variance), 4),
        "min": round(float(m["min"]), 4) if m.get("min") is not None else None,
        "max": round(float(m["max"]), 4) if m.get("max") is not None else None,
        "hist": list(m.get("hist") or []),
    }


def aggregate_months(month_docs):
    agg = {t: empty_target() for t in TARGETS}
    total_hours = 0
    total_reports = 0
    for doc in month_docs:
        total_hours += int(doc.get("matched_hours") or 0)
        total_reports += int(doc.get("source_reports") or 0)
        for target in TARGETS:
            src = (doc.get("targets") or {}).get(target) or {}
            dst = agg[target]
            for k in ("positive_cases", "negative_cases", "unknown_cases"):
                dst[k] += int(src.get(k) or 0)
            for feature in FEATURE_NAMES:
                sf = ((src.get("features") or {}).get(feature) or {})
                for cls in ("positive", "negative"):
                    merge_moment(dst["features"][feature][cls], sf.get(cls) or {})
            for cls in ("positive", "negative"):
                sw = ((src.get("wind_direction") or {}).get(cls) or {})
                for sector in WIND_SECTORS:
                    dst["wind_direction"][cls][sector] += int(sw.get(sector) or 0)

    out_targets = {}
    for target, raw in agg.items():
        pos = raw["positive_cases"]
        neg = raw["negative_cases"]
        known = pos + neg
        base = pos / known if known else None
        feature_out = {}
        for feature in FEATURE_NAMES:
            pm = summarize_moment(raw["features"][feature]["positive"])
            nm = summarize_moment(raw["features"][feature]["negative"])
            bins = FEATURE_BINS[feature]
            hist_rates = []
            ph = pm["hist"]
            nh = nm["hist"]
            for idx in range(len(bins) + 1):
                p = int(ph[idx]) if idx < len(ph) else 0
                n = int(nh[idx]) if idx < len(nh) else 0
                count = p + n
                rate = p / count if count else None
                strength = 20.0
                shrunk = ((p + strength * base) / (count + strength)) if count and base is not None else None
                hist_rates.append({
                    "bin": idx,
                    "lower": None if idx == 0 else bins[idx - 1],
                    "upper": None if idx == len(bins) else bins[idx],
                    "cases": count,
                    "positive": p,
                    "event_rate": round(rate, 6) if rate is not None else None,
                    "shrunk_rate": round(shrunk, 6) if shrunk is not None else None,
                })
            separation = None
            if pm["n"] >= 2 and nm["n"] >= 2 and pm["mean"] is not None and nm["mean"] is not None:
                pooled = math.sqrt((pm["std"] ** 2 + nm["std"] ** 2) / 2.0)
                if pooled > 1e-9:
                    separation = (pm["mean"] - nm["mean"]) / pooled
            feature_out[feature] = {
                "bins": bins,
                "positive": {k: v for k, v in pm.items() if k != "hist"},
                "negative": {k: v for k, v in nm.items() if k != "hist"},
                "standardized_mean_separation": round(separation, 4) if separation is not None else None,
                "bin_event_rates": hist_rates,
            }

        wind = []
        for sector in WIND_SECTORS:
            p = raw["wind_direction"]["positive"][sector]
            n = raw["wind_direction"]["negative"][sector]
            c = p + n
            rate = p / c if c else None
            wind.append({"sector": sector, "cases": c, "positive": p, "event_rate": round(rate, 6) if rate is not None else None})

        out_targets[target] = {
            "positive_cases": pos,
            "negative_cases": neg,
            "unknown_cases": raw["unknown_cases"],
            "known_cases": known,
            "base_rate": round(base, 6) if base is not None else None,
            "features": feature_out,
            "wind_direction_sectors": wind,
        }

    return {
        "schema": "prognozaepir-historical-physics-priors-v1",
        "generated_at_utc": iso(utcnow()),
        "period": {
            "start": month_docs[0]["month"] if month_docs else None,
            "end": month_docs[-1]["month"] if month_docs else None,
            "processed_months": len(month_docs),
        },
        "source": {
            "truth": "canonical EPIR METAR/SPECI history; corrected 2020-2024 fog truth when available",
            "environment": "ERA5 reanalysis via Open-Meteo Historical Weather API",
            "location": {"latitude": mv.LAT, "longitude": mv.LON, "station": "EPIR"},
        },
        "guardrails": GUARDRAILS,
        "method": {
            "resolution": "hourly observation truth joined to ERA5 UTC hour",
            "storage": "monthly sufficient statistics; raw ERA5 arrays are not committed",
            "fog_targets": "FG, MIFG and BR are separate targets; UNKNOWN observations never become CLEAR",
            "low_cloud_target": "BKN/OVC/VV at or below 1500 ft AGL from aviation observations",
            "convection_target": "TS/VCTS or explicitly reported CB/TCU in aviation observation",
            "bin_shrinkage": "20 pseudo-cases toward target base rate; diagnostic physical prior only",
        },
        "matched_hours": total_hours,
        "source_reports": total_reports,
        "targets": out_targets,
    }


def load_state():
    if not STATE_PATH.exists():
        return {"schema": "prognozaepir-reanalysis-physics-state-v1", "months": {}}
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        if data.get("schema") == "prognozaepir-reanalysis-physics-state-v1":
            data.setdefault("months", {})
            return data
    except Exception:
        pass
    return {"schema": "prognozaepir-reanalysis-physics-state-v1", "months": {}}


def write_state(state):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_month_docs():
    docs = []
    if MONTH_DIR.exists():
        for path in sorted(MONTH_DIR.glob("*.json")):
            try:
                doc = json.loads(path.read_text(encoding="utf-8"))
                if doc.get("schema") == "prognozaepir-reanalysis-physics-month-v1":
                    docs.append(doc)
            except Exception:
                continue
    return sorted(docs, key=lambda d: d.get("month") or "")


def write_month(doc):
    MONTH_DIR.mkdir(parents=True, exist_ok=True)
    path = MONTH_DIR / f"{doc['month']}.json"
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def rebuild_output():
    docs = load_month_docs()
    if not docs:
        return None
    payload = aggregate_months(docs)
    OUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return payload


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default=START_DATE.isoformat())
    ap.add_argument("--end", default=END_DATE.isoformat())
    ap.add_argument("--max-months", type=int, default=2)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--rebuild-only", action="store_true")
    args = ap.parse_args()

    start = parse_day(args.start)
    end = parse_day(args.end)
    if end < start:
        raise SystemExit("end before start")

    if args.rebuild_only:
        payload = rebuild_output()
        print(json.dumps({"status": "rebuilt", "processed_months": (payload or {}).get("period", {}).get("processed_months", 0)}, ensure_ascii=False))
        return

    rows, inventory = fog_hist.load_observation_rows()
    obs_months = set()
    for dt, _row, _state in fog_hist.points_from_rows(rows):
        if start <= dt.date() <= end:
            obs_months.add(month_key(dt.date()))

    eligible = [m for m in iter_months(start, end) if m in obs_months]
    state = load_state()
    done_files = {p.stem for p in MONTH_DIR.glob("*.json")} if MONTH_DIR.exists() else set()
    candidates = []
    for m in eligible:
        info = (state.get("months") or {}).get(m) or {}
        attempts = int(info.get("attempts") or 0)
        if m in done_files or attempts >= MAX_ATTEMPTS:
            continue
        candidates.append((attempts, m))
    candidates.sort(key=lambda x: (x[0], x[1]))
    selected = [m for _attempt, m in candidates[: max(0, args.max_months)]]

    report = {
        "historical_rows": inventory.get("historical_rows"),
        "rolling_rows": inventory.get("rolling_rows"),
        "eligible_months": len(eligible),
        "already_complete": len(done_files & set(eligible)),
        "pending_months": len(candidates),
        "selected": selected,
        "guardrails": GUARDRAILS,
    }
    print(json.dumps({"inventory": report}, ensure_ascii=False))
    if args.dry_run:
        return
    if not selected:
        print(json.dumps({"status": "no-work", "pending_months": len(candidates)}, ensure_ascii=False))
        return

    changed = False
    for key in selected:
        previous = dict((state.get("months") or {}).get(key) or {})
        attempts = int(previous.get("attempts") or 0) + 1
        try:
            doc = build_month_summary(key, rows)
            write_month(doc)
            state.setdefault("months", {})[key] = {
                "attempts": attempts,
                "status": "complete",
                "last_attempt_utc": iso(utcnow()),
                "matched_hours": doc.get("matched_hours"),
                "positive_cases": {t: doc["targets"][t]["positive_cases"] for t in TARGETS},
            }
            changed = True
            print(json.dumps({"month": key, "status": "complete", "matched_hours": doc.get("matched_hours")}, ensure_ascii=False))
        except Exception as exc:
            state.setdefault("months", {})[key] = {
                "attempts": attempts,
                "status": "exhausted" if attempts >= MAX_ATTEMPTS else "pending",
                "last_attempt_utc": iso(utcnow()),
                "error": f"{type(exc).__name__}: {exc}",
            }
            changed = True
            print(json.dumps({"month": key, "status": "failed", "attempt": attempts, "error": str(exc)}, ensure_ascii=False))

    if changed:
        state["schema"] = "prognozaepir-reanalysis-physics-state-v1"
        state["period"] = {"start": start.isoformat(), "end": end.isoformat()}
        state["guardrails"] = GUARDRAILS
        state["updated_at_utc"] = iso(utcnow())
        write_state(state)
        payload = rebuild_output()
        print(json.dumps({
            "status": "updated",
            "processed_months": (payload or {}).get("period", {}).get("processed_months", 0),
            "target_positive_cases": {t: ((payload or {}).get("targets") or {}).get(t, {}).get("positive_cases", 0) for t in TARGETS},
        }, ensure_ascii=False))


if __name__ == "__main__":
    main()
