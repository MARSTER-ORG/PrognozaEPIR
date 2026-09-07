#!/usr/bin/env python3
"""Build lead-time-aware model weights from archived forecasts vs METAR/SYNOP."""
from __future__ import annotations

import json
from collections import defaultdict

import model_verification as mv

OUT = mv.LEARNING / "adaptive-weights.json"
MIN_SAMPLES = 12
FULL_SAMPLES = 120
MIN_FACTOR = 0.70
MAX_FACTOR = 1.30


def clamp(v, a, b):
    return max(a, min(b, v))


def confidence(n):
    if n < MIN_SAMPLES:
        return 0.0
    return clamp((n - MIN_SAMPLES) / max(1, FULL_SAMPLES - MIN_SAMPLES), 0.0, 1.0)


def main():
    forecasts = mv.load_forecasts()
    metar_by_hour, synop_by_hour = mv.build_observation_maps()
    now = mv.utcnow()

    stats = defaultdict(lambda: [0, 0.0])
    samples = defaultdict(int)
    source_hits = defaultdict(lambda: {"METAR": 0, "SPECI": 0, "SYNOP": 0})

    for f in forecasts:
        model = f.get("model")
        if model not in mv.MODEL_META:
            continue
        valid = mv.parse_dt(f.get("valid_time"))
        run = mv.parse_dt(f.get("run_time"))
        if not valid or not run or valid > now or run >= valid:
            continue
        lead_h = (valid - run).total_seconds() / 3600.0
        bucket = f.get("lead_bucket") or mv.lead_bucket(lead_h)
        if not bucket:
            continue
        key = mv.iso(valid.replace(minute=0, second=0, microsecond=0))
        m = metar_by_hour.get(key)
        s = synop_by_hour.get(key)
        if not m and not s:
            continue
        scores = mv.component_scores(f, m, s)
        scores = {k: float(v) for k, v in scores.items() if v is not None and mv.finite(v)}
        if not scores:
            continue
        samples[(model, bucket)] += 1
        if m:
            raw = str(m.get("raw") or "").lstrip().upper()
            source_hits[(model, bucket)]["SPECI" if raw.startswith("SPECI") else "METAR"] += 1
        if s:
            source_hits[(model, bucket)]["SYNOP"] += 1
        for comp, score in scores.items():
            stats[(model, bucket, comp)][0] += 1
            stats[(model, bucket, comp)][1] += score

    buckets = [b for _, _, b, _ in mv.LEAD_BUCKETS]
    components = list(mv.PARAM_WEIGHTS)

    benchmark = {}
    for bucket in buckets:
        for comp in components:
            means = []
            for model, _, _ in mv.MODELS:
                n, total = stats[(model, bucket, comp)]
                if n >= 3:
                    means.append(total / n)
            benchmark[(bucket, comp)] = sum(means) / len(means) if means else None

    output = {
        "schema": "prognozaepir-adaptive-weights-v1",
        "generated_at": mv.iso(now),
        "method": "Archived operational forecasts verified against corresponding-hour EPIR METAR/SPECI and WMO 12342 SYNOP; factor is model score relative to cohort, shrunk by sample confidence and clipped",
        "min_samples": MIN_SAMPLES,
        "full_samples": FULL_SAMPLES,
        "factor_bounds": [MIN_FACTOR, MAX_FACTOR],
        "models": {},
    }

    for model, name, base_weight in mv.MODELS:
        mout = {"name": name, "base_weight": base_weight, "lead_buckets": {}}
        for bucket in buckets:
            comps = {}
            factor_num = 0.0
            factor_den = 0.0
            for comp, pweight in mv.PARAM_WEIGHTS.items():
                n, total = stats[(model, bucket, comp)]
                mean = total / n if n else None
                ref = benchmark[(bucket, comp)]
                conf = confidence(n)
                if mean is None or ref is None or ref <= 0:
                    raw_factor = 1.0
                else:
                    raw_factor = clamp(mean / ref, MIN_FACTOR, MAX_FACTOR)
                factor = 1.0 + (raw_factor - 1.0) * conf
                comps[comp] = {
                    "n": n,
                    "score_pct": round(mean, 1) if mean is not None else None,
                    "cohort_score_pct": round(ref, 1) if ref is not None else None,
                    "confidence": round(conf, 3),
                    "weight_factor": round(factor, 4),
                }
                if mean is not None:
                    factor_num += factor * pweight
                    factor_den += pweight
            overall = factor_num / factor_den if factor_den else 1.0
            mout["lead_buckets"][bucket] = {
                "forecast_samples": samples[(model, bucket)],
                "sources": source_hits[(model, bucket)],
                "weight_factor": round(overall, 4),
                "effective_weight": round(base_weight * overall, 6),
                "components": comps,
            }
        output["models"][model] = mout

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    brief = {
        m: {b: r["weight_factor"] for b, r in row["lead_buckets"].items()}
        for m, row in output["models"].items()
    }
    print("adaptive weights:", json.dumps(brief, ensure_ascii=False))


if __name__ == "__main__":
    main()
