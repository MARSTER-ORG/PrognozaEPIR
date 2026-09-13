#!/usr/bin/env python3
"""Build robust lead-time-aware model weights from archived forecasts vs observations.

The adaptive factor is learned from *paired* cases: for every valid time / lead
bucket / parameter the model score is compared with the median score of the
other available models for that same case. This avoids rewarding a model just
because it happened to be verified on easier weather situations.

Learned factors are recency weighted, shrunk towards the static/base weight
when the effective sample is small, and clipped to conservative bounds.
Visibility learning deliberately emphasizes observed reductions below 10 km
and downweights censored METAR 9999 good-visibility cases so rare operationally
important reductions are not drowned by hundreds of easy CAVOK/9999 samples.
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

# Visibility is operationally asymmetric at EPIR. METAR 9999 means a lower
# bound (roughly >=10 km), not an exact 10 km measurement. Rare observed
# reductions below 10 km therefore carry more learning mass, while censored
# good-visibility cases remain useful but cannot dominate the component.
VISIBILITY_LOW_THRESHOLD_M = 10000.0
VISIBILITY_LOW_CASE_WEIGHT = 3.0
VISIBILITY_CENSORED_GOOD_WEIGHT = 0.5
VISIBILITY_EXACT_GOOD_WEIGHT = 1.0

# Component-specific response speed. Wind has a deep verified EPIR sample and a
# persistent directional bias, so it may react faster to recent model skill.
# Cloud also has substantial history. Visibility stays conservative because
# genuinely reduced-visibility METAR cases are much rarer and right-censored.
COMPONENT_LEARNING = {
    "wind": {"half_life_days": 21.0, "full_samples": 60, "peer_scale_pct": 26.0},
    "cloud": {"half_life_days": 30.0, "full_samples": 75, "peer_scale_pct": 30.0},
    "visibility": {"half_life_days": 45.0, "full_samples": 100, "peer_scale_pct": 32.0},
}


def learning_cfg(comp=None):
    return COMPONENT_LEARNING.get(comp or "", {})


def clamp(v, a, b):
    return max(a, min(b, v))


def recency_weight(valid, now, comp=None):
    age_days = max(0.0, (now - valid).total_seconds() / 86400.0)
    half_life = float(learning_cfg(comp).get("half_life_days", HALF_LIFE_DAYS))
    return 0.5 ** (age_days / half_life)


def confidence(n, effective_n, comp=None):
    if n < MIN_SAMPLES or effective_n < MIN_SAMPLES * 0.55:
        return 0.0
    full_samples = float(learning_cfg(comp).get("full_samples", FULL_SAMPLES))
    raw = (effective_n - MIN_SAMPLES * 0.55) / max(1.0, full_samples - MIN_SAMPLES * 0.55)
    # Smoothstep avoids a hard jump as soon as the minimum sample count is reached.
    x = clamp(raw, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def peer_factor(delta_pct, comp=None):
    """Convert score advantage vs same-case peer median into a bounded factor."""
    if not mv.finite(delta_pct):
        return 1.0
    scale = float(learning_cfg(comp).get("peer_scale_pct", PEER_SCALE_PCT))
    return clamp(math.exp(delta_pct / scale), MIN_FACTOR, MAX_FACTOR)


def weighted_mean(pairs):
    # pairs = [(value, weight), ...]
    sw = sum(w for _v, w in pairs if mv.finite(_v) and mv.finite(w) and w > 0)
    if sw <= 0:
        return None
    return sum(v * w for v, w in pairs if mv.finite(v) and mv.finite(w) and w > 0) / sw


def visibility_learning_weight(m, s):
    """Return extra learning weight for the observed visibility regime.

    Priority mirrors component_scores(): METAR/SPECI first for visibility, then
    SYNOP. An exact observed reduction below 10 km is emphasized. METAR 9999
    (represented by visibility_lower_bound) proves good visibility but is not an
    exact value, so it receives reduced learning weight.
    """
    row = None
    if m and mv.finite(m.get("visibility_m")):
        row = m
    elif s and mv.finite(s.get("visibility_m")):
        row = s
    if not row:
        return 1.0

    vis = float(row.get("visibility_m"))
    lower_bound = bool(row.get("visibility_lower_bound"))
    if lower_bound:
        if vis >= VISIBILITY_LOW_THRESHOLD_M:
            return VISIBILITY_CENSORED_GOOD_WEIGHT
        # A censored lower bound below 10 km cannot prove a reduction, so do
        # not boost it as a low-visibility event.
        return VISIBILITY_EXACT_GOOD_WEIGHT
    if vis < VISIBILITY_LOW_THRESHOLD_M:
        return VISIBILITY_LOW_CASE_WEIGHT
    return VISIBILITY_EXACT_GOOD_WEIGHT


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
    visibility_regimes = defaultdict(lambda: {"low_lt_10km": 0, "censored_ge_10km": 0, "exact_ge_10km": 0})

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
            is_speci = str(m.get("type") or "").upper() == "SPECI" or raw.startswith("SPECI")
            source_hits[(model, bucket)]["SPECI" if is_speci else "METAR"] += 1
        if s:
            source_hits[(model, bucket)]["SYNOP"] += 1

        vis_row = m if m and mv.finite(m.get("visibility_m")) else (s if s and mv.finite(s.get("visibility_m")) else None)
        if vis_row:
            vis = float(vis_row.get("visibility_m"))
            lower = bool(vis_row.get("visibility_lower_bound"))
            if not lower and vis < VISIBILITY_LOW_THRESHOLD_M:
                visibility_regimes[(model, bucket)]["low_lt_10km"] += 1
            elif lower and vis >= VISIBILITY_LOW_THRESHOLD_M:
                visibility_regimes[(model, bucket)]["censored_ge_10km"] += 1
            elif not lower and vis >= VISIBILITY_LOW_THRESHOLD_M:
                visibility_regimes[(model, bucket)]["exact_ge_10km"] += 1

        vis_weight = visibility_learning_weight(m, s)
        for comp, score in scores.items():
            comp_rw = recency_weight(valid, now, comp)
            if comp == "visibility":
                comp_rw *= vis_weight
            abs_scores[(model, bucket, comp)].append((score, comp_rw))
            ckey = (f.get("run_time"), f.get("valid_time"), bucket, comp)
            case_scores[ckey].append((model, score, comp_rw))

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
            "component-specific recency/confidence response, sample-size shrinkage to base weights and conservative clipping; visibility learning emphasizes exact "
            "observed reductions below 10 km and downweights censored METAR 9999 good-visibility cases"
        ),
        "min_samples": MIN_SAMPLES,
        "full_samples": FULL_SAMPLES,
        "half_life_days": HALF_LIFE_DAYS,
        "minimum_peer_models": MIN_PEERS,
        "factor_bounds": [MIN_FACTOR, MAX_FACTOR],
        "component_learning": COMPONENT_LEARNING,
        "visibility_learning": {
            "threshold_m": VISIBILITY_LOW_THRESHOLD_M,
            "low_lt_10km_weight": VISIBILITY_LOW_CASE_WEIGHT,
            "censored_ge_10km_weight": VISIBILITY_CENSORED_GOOD_WEIGHT,
            "exact_ge_10km_weight": VISIBILITY_EXACT_GOOD_WEIGHT,
            "reason": "METAR 9999 is a lower bound, while sub-10-km reductions are operationally more informative at EPIR",
        },
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
                conf = confidence(n, effective_n, comp)
                raw_factor = peer_factor(mean_delta, comp) if mean_delta is not None else 1.0
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
                "visibility_regimes": visibility_regimes[(model, bucket)],
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
