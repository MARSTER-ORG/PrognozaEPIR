#!/usr/bin/env python3
"""Persist signed wind bias diagnostics for PrognozaEPIR CONSENSUS.

The existing model-verification score intentionally remains unchanged. This
module enriches data/learning/model-verification.json with diagnostics computed
from the same archived forecast population and the same EPIR observation policy:
SYNOP-first for wind speed and regular-METAR priority for wind direction.

Bias sign convention is always forecast minus observed. Wind direction uses the
shortest signed angular difference and a circular mean, so wrap-around at
0/360 degrees is handled correctly.
"""
from __future__ import annotations

import json
import math
from collections import defaultdict

import model_verification as mv

BIAS_SCHEMA = "prognozaepir-consensus-wind-bias-v1"
BIAS_DEFINITION = "forecast_minus_observed"


def signed_circular_error_deg(pred, obs):
    """Shortest signed angular error pred-obs in [-180, 180)."""
    if not mv.finite(pred) or not mv.finite(obs):
        return None
    return ((float(pred) - float(obs) + 180.0) % 360.0) - 180.0


def circular_bias_deg(errors):
    """Circular mean of signed angular errors, returned in [-180, 180]."""
    values = [float(v) for v in errors if mv.finite(v)]
    if not values:
        return None
    sx = sum(math.sin(math.radians(v)) for v in values)
    cy = sum(math.cos(math.radians(v)) for v in values)
    if math.hypot(sx, cy) < 1e-9:
        return None
    return math.degrees(math.atan2(sx, cy))


def wind_reference(m, s):
    """Resolve wind observations exactly as model_verification.component_scores."""
    if s and mv.finite(s.get("wind_speed_ms")):
        speed_obs = s.get("wind_speed_ms")
        speed_source = "SYNOP"
    elif m and mv.finite(m.get("wind_speed_ms")):
        speed_obs = m.get("wind_speed_ms")
        speed_source = "METAR_OR_SPECI"
    else:
        speed_obs = None
        speed_source = None

    direction_source = m.get("wind_direction_reference_source") if m else None
    if m and mv.finite(m.get("wind_direction_reference_deg")):
        direction_obs = m.get("wind_direction_reference_deg")
    elif m and mv.finite(m.get("wind_direction_deg")):
        direction_obs = m.get("wind_direction_deg")
        direction_source = "METAR_OR_SPECI_DIRECT"
    elif s and mv.finite(s.get("wind_direction_deg")):
        direction_obs = s.get("wind_direction_deg")
        direction_source = "SYNOP_FALLBACK"
    else:
        direction_obs = None
        direction_source = None

    if m and mv.finite(m.get("wind_direction_reference_speed_ms")):
        direction_speed_obs = m.get("wind_direction_reference_speed_ms")
    elif m and mv.finite(m.get("wind_speed_ms")):
        direction_speed_obs = m.get("wind_speed_ms")
    elif s and mv.finite(s.get("wind_speed_ms")):
        direction_speed_obs = s.get("wind_speed_ms")
    else:
        direction_speed_obs = None

    direction_reliable = (
        direction_source == "METAR_3_CIRCULAR_MEAN"
        or not mv.finite(direction_speed_obs)
        or direction_speed_obs >= mv.WIND_DIRECTION_MIN_MS
    )

    return {
        "speed_obs_ms": speed_obs,
        "speed_source": speed_source,
        "direction_obs_deg": direction_obs,
        "direction_source": direction_source,
        "direction_reliable": direction_reliable,
    }


def _new_accumulator():
    return {
        "speed_errors": [],
        "direction_errors": [],
        "speed_sources": defaultdict(int),
        "direction_sources": defaultdict(int),
    }


def _consume(acc, forecast, m, s):
    ref = wind_reference(m, s)

    pred_speed = forecast.get("wind_speed_ms")
    if mv.finite(pred_speed) and mv.finite(ref["speed_obs_ms"]):
        acc["speed_errors"].append(float(pred_speed) - float(ref["speed_obs_ms"]))
        if ref["speed_source"]:
            acc["speed_sources"][ref["speed_source"]] += 1

    pred_dir = forecast.get("wind_direction_deg")
    if (
        mv.finite(pred_dir)
        and mv.finite(ref["direction_obs_deg"])
        and ref["direction_reliable"]
    ):
        err = signed_circular_error_deg(pred_dir, ref["direction_obs_deg"])
        if mv.finite(err):
            acc["direction_errors"].append(err)
            if ref["direction_source"]:
                acc["direction_sources"][ref["direction_source"]] += 1


def _round_or_none(value, digits=3):
    return round(value, digits) if mv.finite(value) else None


def _summary(acc):
    speed = acc["speed_errors"]
    direction = acc["direction_errors"]
    speed_bias = sum(speed) / len(speed) if speed else None
    speed_mae = sum(abs(v) for v in speed) / len(speed) if speed else None
    direction_bias = circular_bias_deg(direction)
    direction_mae = sum(abs(v) for v in direction) / len(direction) if direction else None
    return {
        "wind_speed": {
            "n": len(speed),
            "bias_ms": _round_or_none(speed_bias),
            "mae_ms": _round_or_none(speed_mae),
        },
        "wind_direction": {
            "n": len(direction),
            "circular_bias_deg": _round_or_none(direction_bias, 2),
            "circular_mae_deg": _round_or_none(direction_mae, 2),
        },
        "speed_sources": dict(sorted(acc["speed_sources"].items())),
        "direction_sources": dict(sorted(acc["direction_sources"].items())),
    }


def build_consensus_wind_bias(now=None):
    """Build overall and lead-bucket signed wind diagnostics for CONSENSUS."""
    now = now or mv.utcnow()
    forecasts = mv.load_forecasts()
    metar_by_hour, synop_by_hour = mv.build_observation_maps()

    overall = _new_accumulator()
    by_bucket = {name: _new_accumulator() for _, _, name, _ in mv.LEAD_BUCKETS}

    grouped = defaultdict(list)
    for f in forecasts:
        grouped[(f.get("run_time"), f.get("valid_time"))].append(f)

    eligible_consensus_samples = 0
    for rows in grouped.values():
        c = mv.consensus_row(rows)
        if not c:
            continue
        valid = mv.parse_dt(c.get("valid_time"))
        run = mv.parse_dt(c.get("run_time"))
        if not valid or not run or valid > now or run >= valid:
            continue

        key = mv.iso(valid.replace(minute=0, second=0, microsecond=0))
        m = metar_by_hour.get(key)
        s = synop_by_hour.get(key)
        if not m and not s:
            continue

        eligible_consensus_samples += 1
        _consume(overall, c, m, s)
        bucket = c.get("lead_bucket") or mv.lead_bucket((valid - run).total_seconds() / 3600.0)
        if bucket in by_bucket:
            _consume(by_bucket[bucket], c, m, s)

    return {
        "schema": BIAS_SCHEMA,
        "definition": BIAS_DEFINITION,
        "units": {"speed": "m/s", "direction": "deg"},
        "reference_policy": {
            "wind_speed": "SYNOP_FIRST_METAR_SPECI_FALLBACK",
            "wind_direction": mv.WIND_DIRECTION_REFERENCE_VERSION,
            "direction_min_reliable_speed_ms": mv.WIND_DIRECTION_MIN_MS,
        },
        "eligible_consensus_samples": eligible_consensus_samples,
        "overall": _summary(overall),
        "by_lead_bucket": {
            name: _summary(by_bucket[name])
            for _, _, name, _ in mv.LEAD_BUCKETS
        },
    }


def enrich_summary():
    """Add or replace the CONSENSUS wind_bias block in model-verification.json."""
    if not mv.SUMMARY_PATH.exists():
        raise FileNotFoundError(f"verification summary missing: {mv.SUMMARY_PATH}")

    summary = json.loads(mv.SUMMARY_PATH.read_text(encoding="utf-8"))
    models = summary.setdefault("models", {})
    consensus = models.get("consensus")
    if not isinstance(consensus, dict):
        raise RuntimeError("model-verification.json has no consensus model block")

    bias = build_consensus_wind_bias()
    consensus["wind_bias"] = bias
    mv.SUMMARY_PATH.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return bias


def main():
    bias = enrich_summary()
    overall = bias["overall"]
    print(
        "consensus wind bias:",
        json.dumps(
            {
                "speed": overall["wind_speed"],
                "direction": overall["wind_direction"],
                "eligible_samples": bias["eligible_consensus_samples"],
            },
            ensure_ascii=False,
        ),
    )


if __name__ == "__main__":
    main()
