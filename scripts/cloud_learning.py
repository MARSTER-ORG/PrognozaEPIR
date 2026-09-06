#!/usr/bin/env python3
"""Cloud Learning v1 for PrognozaEPIR.

Archives compact, lead-time-aware cloud forecasts for EPIR and verifies them
against later METAR cloud layers. Produces data/learning/cloud-skill.json with
conservative model weight factors used only by the cloud consensus.
"""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "learning"
FORECAST_DIR = OUT / "forecasts"
VERIFY_DIR = OUT / "verification"
METAR_DIR = ROOT / "data" / "observations" / "metar"
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

LEAD_BUCKETS = [
    (0, 3, "0-3h", 1.5),
    (3, 6, "3-6h", 4.5),
    (6, 12, "6-12h", 9.0),
    (12, 24, "12-24h", 18.0),
    (24, 48, "24-48h", 36.0),
    (48, 121, "48-120h", 72.0),
]
MIN_SAMPLES = 12
FULL_SAMPLES = 60
MAX_WEIGHT_FACTOR = 1.80
MIN_WEIGHT_FACTOR = 0.55


def utcnow():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def get_json(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": "PrognozaEPIR-CloudLearning/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def append_jsonl(path: Path, row):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


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


def all_jsonl(directory: Path):
    out = []
    if directory.exists():
        for p in sorted(directory.glob("*.jsonl")):
            out.extend(load_jsonl(p))
    return out


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


def okta_from_pct(v):
    if v is None:
        return None
    return max(0, min(8, int(round(float(v) / 12.5))))


def metar_cover_range(code):
    return {"FEW": (1, 2), "SCT": (3, 4), "BKN": (5, 7), "OVC": (8, 8)}.get(code)


def distance_to_range(value, lo, hi):
    if value < lo:
        return lo - value
    if value > hi:
        return value - hi
    return 0.0


def fetch_model_clouds(model_id):
    params = {
        "latitude": LAT,
        "longitude": LON,
        "hourly": "cloud_cover_low,cloud_cover_mid,cloud_cover_high",
        "models": model_id,
        "timezone": "UTC",
        "forecast_days": 6,
    }
    url = "https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(params)
    j = get_json(url)
    h = j.get("hourly") or {}
    times = h.get("time") or []
    rows = []
    for i, ts in enumerate(times):
        try:
            valid = datetime.fromisoformat(ts).replace(tzinfo=timezone.utc)
        except Exception:
            continue
        def at(key):
            arr = h.get(key) or []
            return arr[i] if i < len(arr) else None
        rows.append({
            "valid_time": iso(valid),
            "low_pct": at("cloud_cover_low"),
            "mid_pct": at("cloud_cover_mid"),
            "high_pct": at("cloud_cover_high"),
        })
    return rows


def representative_rows(rows, run):
    """Keep one forecast per lead bucket, closest to the bucket target.

    This cuts repository growth by roughly an order of magnitude while keeping
    independent verification for short, medium and long forecast horizons.
    """
    grouped = defaultdict(list)
    for r in rows:
        try:
            valid = datetime.fromisoformat(r["valid_time"].replace("Z", "+00:00"))
        except Exception:
            continue
        lead_h = (valid - run).total_seconds() / 3600.0
        bucket = lead_bucket(lead_h)
        if bucket:
            grouped[bucket].append((lead_h, r))
    selected = []
    for bucket, candidates in grouped.items():
        target = bucket_target(bucket)
        lead_h, r = min(candidates, key=lambda x: abs(x[0] - target))
        selected.append((bucket, lead_h, r))
    return selected


def archive_forecasts():
    run = utcnow()
    day = run.strftime("%Y-%m-%d")
    path = FORECAST_DIR / f"{day}.jsonl"
    existing = load_jsonl(path)
    seen = {(r.get("run_time"), r.get("model"), r.get("valid_time")) for r in existing}
    added = 0
    for model_id, name, base_weight in MODELS:
        try:
            rows = fetch_model_clouds(model_id)
        except Exception as exc:
            print(f"forecast {model_id}: {exc}")
            continue
        for bucket, lead_h, r in representative_rows(rows, run):
            key = (iso(run), model_id, r["valid_time"])
            if key in seen:
                continue
            append_jsonl(path, {
                "run_time": iso(run),
                "model": model_id,
                "name": name,
                "base_weight": base_weight,
                "valid_time": r["valid_time"],
                "lead_hours": round(lead_h, 2),
                "lead_bucket": bucket,
                **r,
            })
            added += 1
    print(f"cloud forecasts archived: {added}")


def metar_layers(m):
    out = []
    for c in m.get("clouds") or []:
        code = c.get("cover")
        rng = metar_cover_range(code)
        h = c.get("base_m_agl")
        if not rng or h is None:
            continue
        band = "low" if h < 2000 else ("mid" if h < 5000 else "high")
        out.append({"band": band, "cover": code, "okta_lo": rng[0], "okta_hi": rng[1], "base_m_agl": h})
    return out


def observed_bands_from_metar(m):
    """Return only cloud bands that METAR actually constrains.

    An omitted upper cloud layer in AUTO METAR is not assumed to mean a clear
    sky at all higher levels. We score explicit layers, plus a lower band that
    is demonstrably clear because the lowest reported cloud base is above it.
    """
    layers = metar_layers(m)
    observed = {"low": None, "mid": None, "high": None}
    for band in observed:
        band_layers = [x for x in layers if x["band"] == band]
        if band_layers:
            observed[band] = max(band_layers, key=lambda x: x["okta_hi"])

    if layers:
        lowest = min(x["base_m_agl"] for x in layers)
        if lowest >= 2000 and observed["low"] is None:
            observed["low"] = {"band": "low", "cover": "CLEAR_BELOW", "okta_lo": 0, "okta_hi": 0, "base_m_agl": None}
        if lowest >= 5000 and observed["mid"] is None:
            observed["mid"] = {"band": "mid", "cover": "CLEAR_BELOW", "okta_lo": 0, "okta_hi": 0, "base_m_agl": None}
    return observed


def verify_new():
    forecasts = all_jsonl(FORECAST_DIR)
    metars = all_jsonl(METAR_DIR)
    if not forecasts or not metars:
        return
    existing = all_jsonl(VERIFY_DIR)
    seen = {(r.get("model"), r.get("run_time"), r.get("metar_time")) for r in existing}
    by_valid = defaultdict(list)
    for f in forecasts:
        by_valid[f.get("valid_time")].append(f)

    added = 0
    for m in metars:
        mt = m.get("obs_time")
        if not mt:
            continue
        try:
            mdt = datetime.fromisoformat(mt.replace("Z", "+00:00"))
        except Exception:
            continue
        nearest_hour = mdt.replace(minute=0, second=0, microsecond=0)
        if mdt.minute >= 30:
            nearest_hour += timedelta(hours=1)
        valid = iso(nearest_hour)
        observed = observed_bands_from_metar(m)
        if not any(observed.values()):
            continue

        candidates = []
        for f in by_valid.get(valid, []):
            try:
                fd = datetime.fromisoformat(f["valid_time"].replace("Z", "+00:00"))
            except Exception:
                continue
            if abs((fd - mdt).total_seconds()) <= 31 * 60:
                candidates.append(f)
        if not candidates:
            continue

        day = mdt.strftime("%Y-%m-%d")
        vpath = VERIFY_DIR / f"{day}.jsonl"
        for f in candidates:
            key = (f.get("model"), f.get("run_time"), mt)
            if key in seen:
                continue
            errors = {}
            for band in ("low", "mid", "high"):
                pred_okta = okta_from_pct(f.get(f"{band}_pct"))
                o = observed[band]
                errors[band] = None if pred_okta is None or o is None else distance_to_range(pred_okta, o["okta_lo"], o["okta_hi"])
            vals = [v for v in errors.values() if v is not None]
            if not vals:
                continue
            mae_okta = sum(vals) / len(vals)
            append_jsonl(vpath, {
                "model": f.get("model"), "name": f.get("name"),
                "run_time": f.get("run_time"), "valid_time": f.get("valid_time"),
                "lead_hours": f.get("lead_hours"), "lead_bucket": f.get("lead_bucket"),
                "metar_time": mt, "metar_source": m.get("source"), "metar_raw": m.get("raw"),
                "observed": observed,
                "predicted": {"low_pct": f.get("low_pct"), "mid_pct": f.get("mid_pct"), "high_pct": f.get("high_pct")},
                "error_okta": errors, "mae_okta": round(mae_okta, 4),
            })
            seen.add(key)
            added += 1
    print(f"cloud verifications added: {added}")


def build_skill():
    rows = all_jsonl(VERIFY_DIR)
    base = {m: w for m, _, w in MODELS}
    stats = defaultdict(lambda: {"n": 0, "sum": 0.0, "bands": defaultdict(lambda: [0, 0.0])})
    for r in rows:
        model = r.get("model")
        bucket = r.get("lead_bucket")
        mae = r.get("mae_okta")
        if model not in base or not bucket or mae is None:
            continue
        s = stats[(model, bucket)]
        s["n"] += 1
        s["sum"] += float(mae)
        for band, err in (r.get("error_okta") or {}).items():
            if err is not None:
                s["bands"][band][0] += 1
                s["bands"][band][1] += float(err)

    output = {
        "schema": "prognozaepir-cloud-learning-v1",
        "generated_at": iso(utcnow()),
        "method": "METAR interval-aware cloud amount MAE in oktas; lead-time-aware conservative weight adaptation",
        "min_samples": MIN_SAMPLES,
        "full_samples": FULL_SAMPLES,
        "models": {},
    }

    for model, name, base_weight in MODELS:
        output["models"][model] = {"name": name, "base_weight": base_weight, "lead_buckets": {}}
        for _, _, bucket, _ in LEAD_BUCKETS:
            s = stats.get((model, bucket), {"n": 0, "sum": 0.0, "bands": {}})
            n = s["n"]
            mae = s["sum"] / n if n else None
            raw_factor = 1.0 if mae is None else 1.5 / max(0.5, mae)
            raw_factor = max(MIN_WEIGHT_FACTOR, min(MAX_WEIGHT_FACTOR, raw_factor))
            confidence = max(0.0, min(1.0, (n - MIN_SAMPLES) / max(1, FULL_SAMPLES - MIN_SAMPLES))) if n >= MIN_SAMPLES else 0.0
            factor = 1.0 + (raw_factor - 1.0) * confidence
            bands = {}
            for band in ("low", "mid", "high"):
                bn, bsum = s.get("bands", {}).get(band, [0, 0.0])
                bands[band] = {"n": bn, "mae_okta": round(bsum / bn, 3) if bn else None}
            output["models"][model]["lead_buckets"][bucket] = {
                "n": n,
                "mae_okta": round(mae, 3) if mae is not None else None,
                "confidence": round(confidence, 3),
                "weight_factor": round(factor, 4),
                "effective_weight": round(base_weight * factor, 6),
                "bands": bands,
            }

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "cloud-skill.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"cloud skill rows: {len(rows)}")


def main():
    archive_forecasts()
    verify_new()
    build_skill()


if __name__ == "__main__":
    main()
