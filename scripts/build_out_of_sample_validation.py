#!/usr/bin/env python3
"""Strict temporal out-of-sample validation for PrognozaEPIR CONSENSUS.

Frozen model/component factors are learned only from forecasts valid in
2024-2025 and then evaluated on forecasts valid in 2026. No 2026 verification
score is allowed to influence a learned factor used for the 2026 test.

The script is intended to run inside learning_quality_gate.training_only_previous_runs()
so incomplete Previous Runs months are already absent from model_verification.load_forecasts().
"""
from __future__ import annotations

import copy
import json
import math
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import model_verification as mv

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "learning" / "out-of-sample-validation.json"
TRAIN_START = datetime(2024, 1, 1, tzinfo=timezone.utc)
SPLIT = datetime(2026, 1, 1, tzinfo=timezone.utc)
FACTOR_MIN = 0.72
FACTOR_MAX = 1.28
MIN_SAMPLES = 18
FULL_SAMPLES = 100
MIN_PEERS = 3
PEER_SCALE_PCT = 32.0


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def mean_or_none(values):
    vals = [float(v) for v in values if isinstance(v, (int, float)) and math.isfinite(v)]
    return sum(vals) / len(vals) if vals else None


def weighted_composite(component_means: dict) -> float | None:
    total = 0.0
    wsum = 0.0
    for comp, weight in mv.PARAM_WEIGHTS.items():
        value = component_means.get(comp)
        if value is None:
            continue
        total += value * weight
        wsum += weight
    return total / wsum if wsum else None


def obs_for(valid_time: str, metar_map: dict, synop_map: dict):
    return metar_map.get(valid_time), synop_map.get(valid_time)


def learn_factors(train_rows: list[dict], metar_map: dict, synop_map: dict):
    grouped = defaultdict(list)
    for row in train_rows:
        grouped[(row.get("run_time"), row.get("valid_time"), row.get("lead_bucket"))].append(row)

    deltas = defaultdict(list)
    raw_scores = defaultdict(list)
    peer_case_count = 0

    for (_run, valid, bucket), rows in grouped.items():
        if not valid or not bucket:
            continue
        m, s = obs_for(valid, metar_map, synop_map)
        per_model = {}
        for row in rows:
            model = row.get("model")
            if model not in mv.MODEL_META:
                continue
            scores = mv.component_scores(row, m, s)
            if scores:
                per_model[model] = scores
        models = list(per_model)
        if len(models) < MIN_PEERS:
            continue
        peer_case_count += 1
        for model, scores in per_model.items():
            for comp, score in scores.items():
                peers = [per_model[p].get(comp) for p in models if p != model and comp in per_model[p]]
                peers = [float(x) for x in peers if isinstance(x, (int, float)) and math.isfinite(x)]
                if len(peers) < 2:
                    continue
                peer_median = statistics.median(peers)
                deltas[(model, bucket, comp)].append(float(score) - peer_median)
                raw_scores[(model, bucket, comp)].append(float(score))

    factors = {}
    for model, _name, _base in mv.MODELS:
        factors[model] = {}
        for _lo, _hi, bucket, _representative in mv.LEAD_BUCKETS:
            factors[model][bucket] = {}
            for comp in mv.PARAM_WEIGHTS:
                vals = deltas.get((model, bucket, comp), [])
                n = len(vals)
                delta = mean_or_none(vals)
                if delta is None or n < MIN_SAMPLES:
                    factor = 1.0
                    confidence = 0.0 if n == 0 else min(1.0, n / MIN_SAMPLES) * 0.25
                else:
                    confidence = min(1.0, n / FULL_SAMPLES)
                    raw_factor = clamp(1.0 + delta / PEER_SCALE_PCT, FACTOR_MIN, FACTOR_MAX)
                    factor = 1.0 + (raw_factor - 1.0) * confidence
                factors[model][bucket][comp] = {
                    "n": n,
                    "mean_peer_delta_pct": round(delta, 3) if delta is not None else None,
                    "training_score_pct": round(mean_or_none(raw_scores.get((model, bucket, comp), [])), 2)
                    if raw_scores.get((model, bucket, comp)) else None,
                    "confidence": round(confidence, 4),
                    "factor": round(clamp(factor, FACTOR_MIN, FACTOR_MAX), 6),
                }

    return factors, peer_case_count


def learned_consensus_for_component(rows: list[dict], component: str, factors: dict) -> dict | None:
    adjusted = []
    for row in rows:
        model = row.get("model")
        bucket = row.get("lead_bucket")
        factor = (((factors.get(model) or {}).get(bucket) or {}).get(component) or {}).get("factor", 1.0)
        clone = copy.copy(row)
        base = clone.get("base_weight")
        if not mv.finite(base) and model in mv.MODEL_META:
            base = mv.MODEL_META[model][1]
        if not mv.finite(base):
            continue
        clone["base_weight"] = float(base) * float(factor)
        adjusted.append(clone)
    return mv.consensus_row(adjusted) if adjusted else None


def add_scores(target: dict, scores: dict):
    for comp, score in scores.items():
        if isinstance(score, (int, float)) and math.isfinite(score):
            target[comp].append(float(score))


def summarise(store: dict) -> dict:
    components = {}
    means = {}
    for comp in mv.PARAM_WEIGHTS:
        values = store.get(comp, [])
        mean = mean_or_none(values)
        means[comp] = mean
        components[comp] = {
            "n": len(values),
            "score_pct": round(mean, 2) if mean is not None else None,
        }
    composite = weighted_composite(means)
    return {
        "composite_score_pct": round(composite, 2) if composite is not None else None,
        "components": components,
    }


def main() -> None:
    rows = mv.load_forecasts()
    metar_map, synop_map = mv.build_observation_maps()

    train_rows = []
    test_rows = []
    for row in rows:
        valid = mv.parse_dt(row.get("valid_time"))
        if not valid:
            continue
        if TRAIN_START <= valid < SPLIT:
            train_rows.append(row)
        elif valid >= SPLIT:
            test_rows.append(row)

    factors, training_peer_cases = learn_factors(train_rows, metar_map, synop_map)

    grouped_test = defaultdict(list)
    for row in test_rows:
        key = (row.get("run_time"), row.get("valid_time"), row.get("lead_bucket"))
        if all(key):
            grouped_test[key].append(row)

    learned_store = defaultdict(list)
    baseline_store = defaultdict(list)
    learned_by_lead = defaultdict(lambda: defaultdict(list))
    baseline_by_lead = defaultdict(lambda: defaultdict(list))
    model_store = defaultdict(lambda: defaultdict(list))
    test_cases = 0

    for (_run, valid, bucket), case_rows in grouped_test.items():
        usable = [r for r in case_rows if r.get("model") in mv.MODEL_META]
        if len({r.get("model") for r in usable}) < MIN_PEERS:
            continue
        m, s = obs_for(valid, metar_map, synop_map)
        if not (m or s):
            continue
        test_cases += 1

        baseline = mv.consensus_row(usable)
        if baseline:
            bs = mv.component_scores(baseline, m, s)
            add_scores(baseline_store, bs)
            add_scores(baseline_by_lead[bucket], bs)

        for comp in mv.PARAM_WEIGHTS:
            learned = learned_consensus_for_component(usable, comp, factors)
            if not learned:
                continue
            score = mv.component_scores(learned, m, s).get(comp)
            if isinstance(score, (int, float)) and math.isfinite(score):
                learned_store[comp].append(float(score))
                learned_by_lead[bucket][comp].append(float(score))

        for row in usable:
            model = row.get("model")
            add_scores(model_store[model], mv.component_scores(row, m, s))

    learned_summary = summarise(learned_store)
    baseline_summary = summarise(baseline_store)
    learned_comp = learned_summary.get("composite_score_pct")
    baseline_comp = baseline_summary.get("composite_score_pct")
    delta = None if learned_comp is None or baseline_comp is None else round(learned_comp - baseline_comp, 2)

    by_lead = {}
    for _lo, _hi, bucket, _rep in mv.LEAD_BUCKETS:
        lsum = summarise(learned_by_lead[bucket])
        bsum = summarise(baseline_by_lead[bucket])
        lv = lsum.get("composite_score_pct")
        bv = bsum.get("composite_score_pct")
        by_lead[bucket] = {
            "learned_consensus": lsum,
            "base_weight_consensus": bsum,
            "delta_pct_points": round(lv - bv, 2) if lv is not None and bv is not None else None,
        }

    models = {model: summarise(store) for model, store in sorted(model_store.items())}

    train_times = [mv.parse_dt(r.get("valid_time")) for r in train_rows]
    test_times = [mv.parse_dt(r.get("valid_time")) for r in test_rows]
    train_times = [x for x in train_times if x]
    test_times = [x for x in test_times if x]

    payload = {
        "schema": "prognozaepir-consensus-oos-validation-v1",
        "generated_at": mv.iso(mv.utcnow()),
        "method": "Frozen component/model factors learned on 2024-2025 only; evaluated on 2026 only; same-case peer median; incomplete Previous Runs months excluded by learning quality gate.",
        "leakage_guard": {
            "training_valid_time_start": mv.iso(min(train_times)) if train_times else None,
            "training_valid_time_end": mv.iso(max(train_times)) if train_times else None,
            "training_cutoff_exclusive": "2026-01-01T00:00:00Z",
            "test_valid_time_start": mv.iso(min(test_times)) if test_times else None,
            "test_valid_time_end": mv.iso(max(test_times)) if test_times else None,
            "test_data_used_for_factor_learning": False,
        },
        "factor_policy": {
            "minimum_peer_models": MIN_PEERS,
            "minimum_samples": MIN_SAMPLES,
            "full_confidence_samples": FULL_SAMPLES,
            "peer_scale_pct": PEER_SCALE_PCT,
            "factor_bounds": [FACTOR_MIN, FACTOR_MAX],
        },
        "training": {
            "forecast_rows": len(train_rows),
            "peer_cases": training_peer_cases,
            "frozen_factors": factors,
        },
        "test": {
            "forecast_rows": len(test_rows),
            "eligible_cases": test_cases,
            "learned_consensus": learned_summary,
            "base_weight_consensus": baseline_summary,
            "learned_minus_base_pct_points": delta,
            "by_lead_bucket": by_lead,
            "individual_models": models,
        },
    }

    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"OOS validation written: {OUT}")
    print(f"train rows={len(train_rows)} test cases={test_cases} learned-base={delta}")


if __name__ == "__main__":
    main()
