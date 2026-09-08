#!/usr/bin/env python3
"""Build robust lead-time-aware model weights from archived forecasts vs observations.

The adaptive factor is learned from *paired* cases: for every valid time / lead
bucket / parameter the model score is compared with the median score of the
other available models for that same case. This avoids rewarding a model just
because it happened to be verified on easier weather situations.

Learned factors are recency weighted, shrunk towards the static/base weight
when the effective sample is small, and clipped to conservative bounds.
"""
from __future__ import annotations

import json
import math
from collections import defaultdict
from statistics import median

import model_verification as mv

OUT = mv.LEARNING / "adaptive-weights.json"
MIN_SAMPLES = 18
FULL_SAMPLES = 100
HALF_LIFE_DAYS = 45.0
MIN_FACTOR = 0.72
MAX_FACTOR = 1.28
PEER_SCALE_PCT = 32.0
MIN_PEERS = 3


def clamp(v, a, b):
    return max(a, min(b, v))


def recency_weight(valid, now):
    age_days = max(0.0, (now - valid).total_seconds() / 86400.0)
    return 0.5 ** (age_days / HALF_LIFE_DAYS)


def confidence(n, effective_n):
    if n < MIN_SAMPLES or effective_n < MIN_SAMPLES * 0.55:
        return 0.0
    raw = (effective_n - MIN_SAMPLES * 0.55) / max(1.0, FULL_SAMPLES - MIN_SAMPLES * 0.55)
    # Smoothstep avoids a hard jump as soon as the minimum sample count is reached.
    x = clamp(raw, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def peer_factor(delta_pct):
    """Convert score advantage vs same-case peer median into a bounded factor."""
    if not mv.finite(delta_pct):
        return 1.0
    return clamp(math.exp(delta_pct / PEER_SCALE_PCT), MIN_FACTOR, MAX_FACTOR)


def weighted_mean(pairs):
    # pairs = [(value, weight), ...]
    sw = sum(w for _v, w in pairs if mv.finite(_v) and mv.finite(w) and w > 0)
    if sw <= 0:
        return None
    return sum(v * w for v, w in pairs if mv.finite(v) and mv.finite(w) and w > 0) / sw


def main():
    forecasts = mv.load_forecasts()
    metar_by_hour, synop_by_hour = mv.build_observation_maps()
    now = mv.utcnow()

    # Absolute skill is kept for diagnostics. Relative skill is learned only on
    # same-case comparisons below.
    abs_scores = defaultdict(list)          # (model,bucket,comp) -> [(score,rw)]
    case_scores = defaultdict(list)         # (run,valid,bucket,comp) -> [(model,score,rw)]
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

        rw = recency_weight(valid, now)
        samples[(model, bucket)] += 1
        if m:
            raw = str(m.get("raw") or "").lstrip().upper()
            is_speci = str(m.get("type") or "").upper() == "SPECI" or raw.startswith("SPECI")
            source_hits[(model, bucket)]["SPECI" if is_speci else "METAR"] += 1
        if s:
            source_hits[(model, bucket)]["SYNOP"] += 1

        for comp, score in scores.items():
            abs_scores[(model, bucket, comp)].append((score, rw))
            ckey = (f.get("run_time"), f.get("valid_time"), bucket, comp)
            case_scores[ckey].append((model, score, rw))

    # Relative deltas against the same-case cohort median.
    relative = defaultdict(list)            # (model,bucket,comp) -> [(delta,rw)]
    for (_run, _valid, bucket, comp), rows in case_scores.items():
        by_model = {}
        for model, score, rw in rows:
            old = by_model.get(model)
            if old is None or rw > old[1]:
                by_model[model] = (score, rw)
        if len(by_model) < MIN_PEERS:
            continue
        values = [score for score, _rw in by_model.values()]
        cohort = median(values)
        for model, (score, rw) in by_model.items():
            # Compare with peers excluding the model itself where possible.
            peers = [v for m2, (v, _w) in by_model.items() if m2 != model]
            ref = median(peers) if len(peers) >= 2 else cohort
            relative[(model, bucket, comp)].append((score - ref, rw))

    buckets = [b for _, _, b, _ in mv.LEAD_BUCKETS]

    output = {
        "schema": "prognozaepir-adaptive-weights-v1",
        "generated_at": mv.iso(now),
        "method": (
            "Archived operational forecasts verified against corresponding-hour EPIR METAR/SPECI and WMO 12342 SYNOP; "
            "parameter/lead factors use same-case model score minus peer median, exponential recency weighting, "
            "sample-size shrinkage to base weights and conservative clipping"
        ),
        "min_samples": MIN_SAMPLES,
        "full_samples": FULL_SAMPLES,
        "half_life_days": HALF_LIFE_DAYS,
        "minimum_peer_models": MIN_PEERS,
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
                absolute = abs_scores[(model, bucket, comp)]
                rel = relative[(model, bucket, comp)]
                mean_score = weighted_mean(absolute)
                mean_delta = weighted_mean(rel)
                n = len(rel)
                effective_n = sum(w for _v, w in rel)
                conf = confidence(n, effective_n)
                raw_factor = peer_factor(mean_delta) if mean_delta is not None else 1.0
                factor = 1.0 + (raw_factor - 1.0) * conf
                factor = clamp(factor, MIN_FACTOR, MAX_FACTOR)

                comps[comp] = {
                    "n": len(absolute),
                    "paired_n": n,
                    "effective_n": round(effective_n, 2),
                    "score_pct": round(mean_score, 1) if mean_score is not None else None,
                    "peer_delta_pct": round(mean_delta, 2) if mean_delta is not None else None,
                    "confidence": round(conf, 3),
                    "weight_factor": round(factor, 4),
                }
                if mean_delta is not None and conf > 0:
                    factor_num += factor * pweight
                    factor_den += pweight

            overall = factor_num / factor_den if factor_den else 1.0
            overall = clamp(overall, MIN_FACTOR, MAX_FACTOR)
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
