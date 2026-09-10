#!/usr/bin/env python3
"""Learn conservative model modifiers conditioned on EPIR weather regimes."""
from __future__ import annotations

import json
import math
from collections import defaultdict
from statistics import median

import model_verification as mv
import synoptic_regime as sr

OUT = mv.LEARNING / "synoptic-regime-skill.json"
MIN_SAMPLES = 24
FULL_SAMPLES = 120
HALF_LIFE_DAYS = 180.0
MIN_FACTOR = 0.85
MAX_FACTOR = 1.15
PEER_SCALE_PCT = 50.0
MIN_PEERS = 3


def clamp(v, a, b):
    return max(a, min(b, v))


def recency_weight(valid, now):
    age_days = max(0.0, (now - valid).total_seconds() / 86400.0)
    return 0.5 ** (age_days / HALF_LIFE_DAYS)


def confidence(n, effective_n):
    if n < MIN_SAMPLES or effective_n < MIN_SAMPLES * 0.6:
        return 0.0
    x = clamp((effective_n - MIN_SAMPLES * 0.6) / max(1.0, FULL_SAMPLES - MIN_SAMPLES * 0.6), 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def weighted_mean(pairs):
    good = [(v, w) for v, w in pairs if mv.finite(v) and mv.finite(w) and w > 0]
    sw = sum(w for _v, w in good)
    return sum(v * w for v, w in good) / sw if sw else None


def factor_from_delta(delta, conf):
    if delta is None or not mv.finite(delta) or conf <= 0:
        return 1.0
    raw = clamp(math.exp(float(delta) / PEER_SCALE_PCT), MIN_FACTOR, MAX_FACTOR)
    return clamp(1.0 + (raw - 1.0) * conf, MIN_FACTOR, MAX_FACTOR)


def main():
    forecasts = mv.load_forecasts()
    metar_by_hour, synop_by_hour = mv.build_observation_maps()
    now = mv.utcnow()

    grouped = defaultdict(list)
    for f in forecasts:
        model = f.get("model")
        valid = mv.parse_dt(f.get("valid_time"))
        run = mv.parse_dt(f.get("run_time"))
        if model not in mv.MODEL_META or not valid or not run or valid > now or run >= valid:
            continue
        bucket = f.get("lead_bucket") or mv.lead_bucket((valid - run).total_seconds() / 3600.0)
        if not bucket:
            continue
        grouped[(f.get("run_time"), f.get("valid_time"), bucket)].append(f)

    stats = defaultdict(list)
    coverage = defaultdict(int)
    cases = 0

    for (_run_s, valid_s, bucket), rows in grouped.items():
        valid = mv.parse_dt(valid_s)
        if not valid:
            continue
        obs_key = mv.iso(valid.replace(minute=0, second=0, microsecond=0))
        m = metar_by_hour.get(obs_key)
        s = synop_by_hour.get(obs_key)
        if not m and not s:
            continue

        context = sr.classify(valid, sr.consensus_fields(rows))
        labels = {d: context.get(d) for d in sr.DIMENSION_WEIGHTS}
        for d, label in labels.items():
            if label:
                coverage[(d, label)] += 1

        scored = defaultdict(dict)
        rw = recency_weight(valid, now)
        for f in rows:
            model = f.get("model")
            scores = mv.component_scores(f, m, s)
            for comp, value in scores.items():
                if value is not None and mv.finite(value):
                    scored[comp][model] = float(value)
        if not scored:
            continue
        cases += 1

        for comp, by_model in scored.items():
            if len(by_model) < MIN_PEERS:
                continue
            for model, score in by_model.items():
                peers = [v for m2, v in by_model.items() if m2 != model]
                if len(peers) < 2:
                    continue
                delta = score - median(peers)
                for dim, label in labels.items():
                    if label:
                        stats[(model, bucket, comp, dim, label)].append((delta, rw))

    buckets = [b for _a, _z, b, _t in mv.LEAD_BUCKETS]
    output = {
        "schema": "prognozaepir-synoptic-regime-learning-v1",
        "generated_at": mv.iso(now),
        "regime_version": sr.VERSION,
        "method": (
            "Same-run/same-valid-time peer-relative model skill conditioned independently on season, local daypart, "
            "850-hPa inflow sector, 925-hPa stability/inversion, lower-tropospheric moisture and local pressure environment. "
            "Only archived operational forecast fields are used to classify historical regimes; missing profile fields stay neutral."
        ),
        "factor_bounds": [MIN_FACTOR, MAX_FACTOR],
        "min_samples": MIN_SAMPLES,
        "full_samples": FULL_SAMPLES,
        "half_life_days": HALF_LIFE_DAYS,
        "minimum_peer_models": MIN_PEERS,
        "dimension_weights": sr.DIMENSION_WEIGHTS,
        "usable_cases": cases,
        "coverage": {},
        "models": {},
    }
    for (dim, label), n in sorted(coverage.items()):
        output["coverage"].setdefault(dim, {})[label] = n

    for model, name, base_weight in mv.MODELS:
        mout = {"name": name, "base_weight": base_weight, "lead_buckets": {}}
        for bucket in buckets:
            bout = {"components": {}}
            for comp in mv.PARAM_WEIGHTS:
                dims = {}
                for dim in sr.DIMENSION_WEIGHTS:
                    labels = {}
                    candidates = sorted({k[4] for k in stats if k[:4] == (model, bucket, comp, dim)})
                    for label in candidates:
                        pairs = stats[(model, bucket, comp, dim, label)]
                        n = len(pairs)
                        eff = sum(w for _v, w in pairs)
                        delta = weighted_mean(pairs)
                        conf = confidence(n, eff)
                        labels[label] = {
                            "n": n,
                            "effective_n": round(eff, 2),
                            "peer_delta_pct": round(delta, 2) if delta is not None else None,
                            "confidence": round(conf, 3),
                            "factor": round(factor_from_delta(delta, conf), 4),
                        }
                    dims[dim] = labels
                bout["components"][comp] = {"dimensions": dims}
            mout["lead_buckets"][bucket] = bout
        output["models"][model] = mout

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("synoptic regime learning:", json.dumps({"usable_cases": cases, "coverage": output["coverage"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
