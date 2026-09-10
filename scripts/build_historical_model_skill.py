#!/usr/bin/env python3
"""Build a deep retrospective skill audit for PrognozaEPIR models.

The audit uses only archived operational forecasts whose run_time precedes the
valid_time. Observations are resolved with the same production verification
logic as model_verification.py, including METAR-priority wind direction and the
3-METAR circular reference for weak/rapidly changing flow.

The report is diagnostic and auditable. Runtime adaptive weights remain built
by build_adaptive_weights.py from the same historical archive; this file adds
raw-error metrics, event skill, monthly stability and an un-decayed historical
same-case factor that can be compared with the recency-weighted runtime factor.
"""
from __future__ import annotations

import json
import math
from collections import defaultdict
from statistics import median

import model_verification as mv

OUT = mv.LEARNING / "historical-model-skill.json"
ADAPTIVE = mv.LEARNING / "adaptive-weights.json"
BACKFILL_STATE = mv.LEARNING / "model-backfill-state.json"

MIN_SAMPLES = 18
FULL_SAMPLES = 100
MIN_PEERS = 3
PEER_SCALE_PCT = 32.0
MIN_FACTOR = 0.72
MAX_FACTOR = 1.28
VISIBILITY_THRESHOLDS_M = (10000, 5000, 1500)


def clamp(v, a, b):
    return max(a, min(b, v))


def mean(values):
    vals = [float(v) for v in values if mv.finite(v)]
    return sum(vals) / len(vals) if vals else None


def percentile(values, q):
    vals = sorted(float(v) for v in values if mv.finite(v))
    if not vals:
        return None
    if len(vals) == 1:
        return vals[0]
    pos = (len(vals) - 1) * q
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return vals[lo]
    w = pos - lo
    return vals[lo] * (1.0 - w) + vals[hi] * w


def error_summary(errors):
    vals = [float(v) for v in errors if mv.finite(v)]
    if not vals:
        return {"n": 0, "bias": None, "mae": None, "rmse": None, "p90_abs": None}
    abs_vals = [abs(v) for v in vals]
    return {
        "n": len(vals),
        "bias": round(sum(vals) / len(vals), 3),
        "mae": round(sum(abs_vals) / len(abs_vals), 3),
        "rmse": round(math.sqrt(sum(v * v for v in vals) / len(vals)), 3),
        "p90_abs": round(percentile(abs_vals, 0.90), 3),
    }


def direction_summary(signed_errors):
    vals = [float(v) for v in signed_errors if mv.finite(v)]
    if not vals:
        return {"n": 0, "circular_bias_deg": None, "mae_deg": None, "p90_abs_deg": None}
    abs_vals = [abs(v) for v in vals]
    bias = mv.circular_mean_deg([(v + 360.0) % 360.0 for v in vals])
    if bias is not None and bias > 180.0:
        bias -= 360.0
    return {
        "n": len(vals),
        "circular_bias_deg": round(bias, 2) if bias is not None else None,
        "mae_deg": round(sum(abs_vals) / len(abs_vals), 2),
        "p90_abs_deg": round(percentile(abs_vals, 0.90), 2),
    }


def score_summary(values):
    vals = [float(v) for v in values if mv.finite(v)]
    return {
        "n": len(vals),
        "score_pct": round(sum(vals) / len(vals), 1) if vals else None,
    }


def confidence(n):
    if n < MIN_SAMPLES:
        return 0.0
    x = clamp((n - MIN_SAMPLES) / max(1.0, FULL_SAMPLES - MIN_SAMPLES), 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def historical_factor(delta_pct, n):
    if not mv.finite(delta_pct):
        return 1.0, 0.0
    conf = confidence(n)
    raw = clamp(math.exp(delta_pct / PEER_SCALE_PCT), MIN_FACTOR, MAX_FACTOR)
    factor = 1.0 + (raw - 1.0) * conf
    return clamp(factor, MIN_FACTOR, MAX_FACTOR), conf


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def signed_circular_error(pred, obs):
    if not mv.finite(pred) or not mv.finite(obs):
        return None
    return ((float(pred) - float(obs) + 180.0) % 360.0) - 180.0


def direction_observation(m, s):
    source = None
    if m and mv.finite(m.get("wind_direction_reference_deg")):
        direction = m.get("wind_direction_reference_deg")
        speed = m.get("wind_direction_reference_speed_ms")
        source = m.get("wind_direction_reference_source") or "METAR_REFERENCE"
    elif m and mv.finite(m.get("wind_direction_deg")):
        direction = m.get("wind_direction_deg")
        speed = m.get("wind_speed_ms")
        source = "METAR_OR_SPECI_DIRECT"
    elif s and mv.finite(s.get("wind_direction_deg")):
        direction = s.get("wind_direction_deg")
        speed = s.get("wind_speed_ms")
        source = "SYNOP_FALLBACK"
    else:
        return None, None, None, False
    reliable = source == "METAR_3_CIRCULAR_MEAN" or not mv.finite(speed) or speed >= mv.WIND_DIRECTION_MIN_MS
    return direction, speed, source, reliable


def scalar_observations(m, s):
    return {
        "temperature": s.get("temperature_c") if s and mv.finite(s.get("temperature_c")) else (m.get("temperature_c") if m else None),
        "dew_point": s.get("dew_point_c") if s and mv.finite(s.get("dew_point_c")) else (m.get("dew_point_c") if m else None),
        "pressure": s.get("pressure_hpa") if s and mv.finite(s.get("pressure_hpa")) else (m.get("pressure_hpa") if m else None),
        "wind_speed": s.get("wind_speed_ms") if s and mv.finite(s.get("wind_speed_ms")) else (m.get("wind_speed_ms") if m else None),
    }


def event_update(row, predicted, observed):
    if predicted is None or observed is None:
        return
    if predicted and observed:
        row["hits"] += 1
    elif predicted and not observed:
        row["false_alarms"] += 1
    elif not predicted and observed:
        row["misses"] += 1
    else:
        row["correct_negatives"] += 1


def event_finish(row):
    h = row["hits"]
    f = row["false_alarms"]
    m = row["misses"]
    c = row["correct_negatives"]
    total = h + f + m + c
    pod = h / (h + m) if h + m else None
    far = f / (h + f) if h + f else None
    csi = h / (h + f + m) if h + f + m else None
    bias = (h + f) / (h + m) if h + m else None
    acc = (h + c) / total if total else None
    return {
        "n": total,
        "hits": h,
        "misses": m,
        "false_alarms": f,
        "correct_negatives": c,
        "pod": round(pod, 3) if pod is not None else None,
        "far": round(far, 3) if far is not None else None,
        "csi": round(csi, 3) if csi is not None else None,
        "frequency_bias": round(bias, 3) if bias is not None else None,
        "accuracy": round(acc, 3) if acc is not None else None,
    }


def empty_event():
    return {"hits": 0, "misses": 0, "false_alarms": 0, "correct_negatives": 0}


def composite_score(scores):
    num = den = 0.0
    for comp, score in scores.items():
        w = mv.PARAM_WEIGHTS.get(comp)
        if mv.finite(score) and mv.finite(w) and w > 0:
            num += float(score) * w
            den += w
    return num / den if den else None


def runtime_factor(adaptive, model, bucket, comp):
    try:
        v = adaptive["models"][model]["lead_buckets"][bucket]["components"][comp]["weight_factor"]
        return float(v) if mv.finite(v) else None
    except Exception:
        return None


def main():
    forecasts = mv.load_forecasts()
    metar_by_hour, synop_by_hour = mv.build_observation_maps()
    now = mv.utcnow()
    adaptive = load_json(ADAPTIVE) or {}
    backfill = load_json(BACKFILL_STATE) or {}

    scores = defaultdict(list)          # (model,bucket,component)
    cases = defaultdict(list)           # (run,valid,bucket,component) -> [(model,score)]
    monthly = defaultdict(list)         # (model,YYYY-MM) -> composite score
    scalar_errors = defaultdict(list)   # (model,bucket,metric)
    direction_errors = defaultdict(list)
    direction_sources = defaultdict(int)
    events = defaultdict(empty_event)   # (model,bucket,event)
    valid_times = []
    usable_forecasts = 0
    model_case_counts = defaultdict(int)
    run_keys = defaultdict(set)

    forecast_keys = {
        "temperature": "temperature_c",
        "dew_point": "dew_point_c",
        "pressure": "pressure_hpa",
        "wind_speed": "wind_speed_ms",
    }

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

        component = mv.component_scores(f, m, s)
        component = {k: float(v) for k, v in component.items() if mv.finite(v)}
        if not component:
            continue

        usable_forecasts += 1
        valid_times.append(valid)
        model_case_counts[model] += 1
        run_keys[model].add(f.get("run_time"))
        comp = composite_score(component)
        if mv.finite(comp):
            monthly[(model, valid.strftime("%Y-%m"))].append(comp)

        for cname, score in component.items():
            scores[(model, bucket, cname)].append(score)
            cases[(f.get("run_time"), f.get("valid_time"), bucket, cname)].append((model, score))

        obs = scalar_observations(m, s)
        for metric, obs_value in obs.items():
            pred = f.get(forecast_keys[metric])
            if mv.finite(pred) and mv.finite(obs_value):
                scalar_errors[(model, bucket, metric)].append(float(pred) - float(obs_value))

        wd_obs, _wd_speed, wd_source, reliable = direction_observation(m, s)
        if wd_source:
            direction_sources[(model, wd_source)] += 1
        if reliable and mv.finite(f.get("wind_direction_deg")) and mv.finite(wd_obs):
            err = signed_circular_error(f.get("wind_direction_deg"), wd_obs)
            if mv.finite(err):
                direction_errors[(model, bucket)].append(err)

        # Visibility: 9999/lower-bound observations are useful for threshold
        # classification, but must not be treated as exact 10 km in MAE/RMSE.
        vis_obs = None
        vis_lower = False
        if m and mv.finite(m.get("visibility_m")):
            vis_obs = float(m.get("visibility_m"))
            vis_lower = bool(m.get("visibility_lower_bound"))
        elif s and mv.finite(s.get("visibility_m")):
            vis_obs = float(s.get("visibility_m"))
            vis_lower = bool(s.get("visibility_lower_bound"))
        pred_vis = f.get("visibility_m")
        if mv.finite(pred_vis) and mv.finite(vis_obs):
            if not vis_lower:
                scalar_errors[(model, bucket, "visibility")].append(float(pred_vis) - vis_obs)
            for threshold in VISIBILITY_THRESHOLDS_M:
                # A lower-bound observation proves non-event only when the
                # lower bound is at/above the threshold; otherwise it is censored.
                if vis_lower and vis_obs < threshold:
                    observed = None
                else:
                    observed = vis_obs < threshold
                event_update(events[(model, bucket, f"visibility_lt_{threshold}m")], float(pred_vis) < threshold, observed)

        wet_obs = mv.precip_observed(m, s)
        pred_precip = f.get("precipitation_mm")
        if wet_obs is not None and mv.finite(pred_precip):
            event_update(events[(model, bucket, "precipitation")], float(pred_precip) >= 0.1, bool(wet_obs))

    # Same-case historical skill against peers. This protects the ranking from
    # missing model runs and from easier/harder subsets in an incomplete archive.
    relative = defaultdict(list)
    for (_run, _valid, bucket, cname), rows in cases.items():
        by_model = {}
        for model, score in rows:
            by_model[model] = score
        if len(by_model) < MIN_PEERS:
            continue
        for model, score in by_model.items():
            peers = [v for m2, v in by_model.items() if m2 != model]
            if len(peers) >= 2:
                relative[(model, bucket, cname)].append(float(score) - float(median(peers)))

    buckets = [b for _a, _z, b, _target in mv.LEAD_BUCKETS]
    output = {
        "schema": "prognozaepir-historical-model-skill-v1",
        "generated_at": mv.iso(now),
        "method": (
            "Retrospective archived operational forecasts vs EPIR METAR/SPECI and WMO 12342 SYNOP; "
            "METAR-priority 3-METAR circular wind-direction reference; same-case peer comparison; "
            "raw MAE/RMSE/bias, threshold event skill and monthly stability; METAR visibility 9999 treated as censored >=10 km"
        ),
        "archive": {
            "forecast_rows_loaded": len(forecasts),
            "usable_forecast_cases": usable_forecasts,
            "valid_time_start": mv.iso(min(valid_times)) if valid_times else None,
            "valid_time_end": mv.iso(max(valid_times)) if valid_times else None,
            "backfill_period_start": backfill.get("period_start"),
            "backfill_period_end": backfill.get("period_end"),
            "backfill_completeness_pct": backfill.get("completeness_pct"),
            "backfill_complete_runs": backfill.get("complete_runs"),
            "backfill_expected_runs": backfill.get("expected_runs"),
            "visibility_policy": "9999/lower-bound is censored; exact-error metrics use only uncensored observations",
            "wind_direction_policy": mv.WIND_DIRECTION_REFERENCE_VERSION,
        },
        "factor_method": {
            "meaning": "un-decayed historical prior; >1 model beat same-case peers, <1 underperformed",
            "minimum_peer_models": MIN_PEERS,
            "minimum_samples": MIN_SAMPLES,
            "full_confidence_samples": FULL_SAMPLES,
            "bounds": [MIN_FACTOR, MAX_FACTOR],
            "runtime_note": "production adaptive weights remain recency-weighted and are built from the same full historical archive",
        },
        "models": {},
    }

    for model, name, base_weight in mv.MODELS:
        mout = {
            "name": name,
            "base_weight": base_weight,
            "usable_forecast_cases": model_case_counts[model],
            "unique_run_times": len(run_keys[model]),
            "direction_sources": {src: n for (m, src), n in sorted(direction_sources.items()) if m == model},
            "monthly_composite_score": {},
            "lead_buckets": {},
        }
        for (m, month), vals in sorted(monthly.items()):
            if m == model:
                mout["monthly_composite_score"][month] = score_summary(vals)

        bucket_factor_num = 0.0
        bucket_factor_den = 0.0
        for bucket in buckets:
            bout = {"components": {}, "raw_errors": {}, "events": {}}
            factor_num = 0.0
            factor_den = 0.0
            for cname, pweight in mv.PARAM_WEIGHTS.items():
                svals = scores[(model, bucket, cname)]
                rvals = relative[(model, bucket, cname)]
                delta = mean(rvals)
                factor, conf = historical_factor(delta, len(rvals))
                bout["components"][cname] = {
                    **score_summary(svals),
                    "paired_n": len(rvals),
                    "peer_delta_pct": round(delta, 2) if delta is not None else None,
                    "historical_weight_factor": round(factor, 4),
                    "historical_confidence": round(conf, 3),
                    "runtime_adaptive_factor": runtime_factor(adaptive, model, bucket, cname),
                }
                if delta is not None and conf > 0:
                    factor_num += factor * pweight
                    factor_den += pweight

            for metric in ("temperature", "dew_point", "pressure", "wind_speed", "visibility"):
                bout["raw_errors"][metric] = error_summary(scalar_errors[(model, bucket, metric)])
            bout["raw_errors"]["wind_direction"] = direction_summary(direction_errors[(model, bucket)])

            event_names = [f"visibility_lt_{x}m" for x in VISIBILITY_THRESHOLDS_M] + ["precipitation"]
            for event_name in event_names:
                bout["events"][event_name] = event_finish(events[(model, bucket, event_name)])

            overall_factor = factor_num / factor_den if factor_den else 1.0
            bout["historical_weight_factor"] = round(clamp(overall_factor, MIN_FACTOR, MAX_FACTOR), 4)
            bout["runtime_adaptive_weight_factor"] = (
                adaptive.get("models", {}).get(model, {}).get("lead_buckets", {}).get(bucket, {}).get("weight_factor")
            )
            mout["lead_buckets"][bucket] = bout

            cases_n = sum(len(scores[(model, bucket, c)]) for c in mv.PARAM_WEIGHTS)
            if factor_den and cases_n:
                bucket_factor_num += overall_factor * cases_n
                bucket_factor_den += cases_n

        mout["historical_weight_factor_overall"] = round(
            clamp(bucket_factor_num / bucket_factor_den, MIN_FACTOR, MAX_FACTOR), 4
        ) if bucket_factor_den else 1.0
        output["models"][model] = mout

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    brief = {
        m: {
            "cases": row["usable_forecast_cases"],
            "historical_factor": row["historical_weight_factor_overall"],
        }
        for m, row in output["models"].items()
    }
    print("historical model skill:", json.dumps(brief, ensure_ascii=False))


if __name__ == "__main__":
    main()
