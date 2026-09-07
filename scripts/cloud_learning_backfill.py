#!/usr/bin/env python3
"""Rebuild cloud skill from the full archived model forecast history.

Uses 0-2 / 2-6 / 6-13 km AGL bands and METAR cloud layers. This closes the
previous gap where historical forecasts in data/learning/model-forecasts were
not included in cloud-learning weights.
"""
from __future__ import annotations

import json
from collections import defaultdict

import cloud_learning as cl
import model_verification as mv

LOW_TOP = 2000
MID_TOP = 6000
MIN_SAMPLES = cl.MIN_SAMPLES
FULL_SAMPLES = cl.FULL_SAMPLES


def observed_bands(m):
    out = {"low": None, "mid": None, "high": None}
    layers = []
    for c in m.get("clouds") or []:
        rng = cl.metar_cover_range(c.get("cover"))
        h = c.get("base_m_agl")
        if not rng or h is None:
            continue
        band = "low" if h < LOW_TOP else ("mid" if h < MID_TOP else "high")
        layers.append((band, rng[0], rng[1], h))
    for band in out:
        rows = [x for x in layers if x[0] == band]
        if rows:
            row = max(rows, key=lambda x: x[2])
            out[band] = (row[1], row[2])
    if layers:
        lowest = min(x[3] for x in layers)
        if lowest >= LOW_TOP and out["low"] is None:
            out["low"] = (0, 0)
        if lowest >= MID_TOP and out["mid"] is None:
            out["mid"] = (0, 0)
    return out


def main():
    forecasts = mv.load_forecasts()
    metar_by_hour, _ = mv.build_observation_maps()
    now = mv.utcnow()
    base = {m: w for m, _, w in cl.MODELS}
    stats = defaultdict(lambda: {"n": 0, "sum": 0.0, "bands": defaultdict(lambda: [0, 0.0])})

    for f in forecasts:
        model = f.get("model")
        if model not in base:
            continue
        valid = mv.parse_dt(f.get("valid_time"))
        run = mv.parse_dt(f.get("run_time"))
        if not valid or not run or valid > now or run >= valid:
            continue
        bucket = f.get("lead_bucket") or cl.lead_bucket((valid - run).total_seconds() / 3600.0)
        if not bucket:
            continue
        key = mv.iso(valid.replace(minute=0, second=0, microsecond=0))
        m = metar_by_hour.get(key)
        if not m:
            continue
        obs = observed_bands(m)
        errors = {}
        for band in ("low", "mid", "high"):
            pred = cl.okta_from_pct(f.get(f"{band}_pct"))
            rng = obs[band]
            errors[band] = None if pred is None or rng is None else cl.distance_to_range(pred, rng[0], rng[1])
        vals = [v for v in errors.values() if v is not None]
        if not vals:
            continue
        mae = sum(vals) / len(vals)
        s = stats[(model, bucket)]
        s["n"] += 1
        s["sum"] += mae
        for band, err in errors.items():
            if err is not None:
                s["bands"][band][0] += 1
                s["bands"][band][1] += err

    output = {
        "schema": "prognozaepir-cloud-learning-v1",
        "generated_at": mv.iso(now),
        "method": "Full archived model forecast history vs EPIR METAR cloud layers; 0-2/2-6/6-13 km AGL; interval-aware okta MAE; lead-time-aware conservative weighting",
        "min_samples": MIN_SAMPLES,
        "full_samples": FULL_SAMPLES,
        "models": {},
    }

    for model, name, base_weight in cl.MODELS:
        mout = {"name": name, "base_weight": base_weight, "lead_buckets": {}}
        for _, _, bucket, _ in cl.LEAD_BUCKETS:
            s = stats[(model, bucket)]
            n = s["n"]
            mae = s["sum"] / n if n else None
            raw_factor = 1.0 if mae is None else 1.5 / max(0.5, mae)
            raw_factor = max(cl.MIN_WEIGHT_FACTOR, min(cl.MAX_WEIGHT_FACTOR, raw_factor))
            conf = max(0.0, min(1.0, (n - MIN_SAMPLES) / max(1, FULL_SAMPLES - MIN_SAMPLES))) if n >= MIN_SAMPLES else 0.0
            factor = 1.0 + (raw_factor - 1.0) * conf
            bands = {}
            for band in ("low", "mid", "high"):
                bn, bsum = s["bands"][band]
                bands[band] = {"n": bn, "mae_okta": round(bsum / bn, 3) if bn else None}
            mout["lead_buckets"][bucket] = {
                "n": n,
                "mae_okta": round(mae, 3) if mae is not None else None,
                "confidence": round(conf, 3),
                "weight_factor": round(factor, 4),
                "effective_weight": round(base_weight * factor, 6),
                "bands": bands,
            }
        output["models"][model] = mout

    cl.OUT.mkdir(parents=True, exist_ok=True)
    (cl.OUT / "cloud-skill.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("cloud archive learning rebuilt:", {m: {b: r["n"] for b, r in row["lead_buckets"].items()} for m, row in output["models"].items()})


if __name__ == "__main__":
    main()
