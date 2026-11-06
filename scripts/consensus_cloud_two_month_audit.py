#!/usr/bin/env python3
"""Reproducible EPIR cloud audit for 2026-09-06 .. 2026-11-06 09 UTC.

Only forecasts issued before their valid time are eligible. Every lead bucket
uses at most one pre-issue consensus forecast per valid hour: the forecast
closest to that bucket's midpoint. It does not count successive updates of
the same weather hour as independent successes.

The reconstructed consensus uses archived source fields and their recorded
base weights; production runtime/adaptive/synoptic corrections are NOT saved
as historical snapshots and cannot be inferred from later observations.
"""
from __future__ import annotations

import json
import math
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import model_verification as mv

START = datetime(2026, 9, 6, tzinfo=timezone.utc)
END = datetime(2026, 11, 6, 9, tzinfo=timezone.utc)
OUTPUT = mv.LEARNING / "consensus-cloud-audit-2026-09-06_2026-11-06.json"
RANGES = {"FEW": (1, 2), "SCT": (3, 4), "BKN": (5, 7), "OVC": (8, 8)}
TARGETS = {name: target for _, _, name, target in mv.LEAD_BUCKETS}
KEYS = ("cloud_total_pct", "low_pct", "mid_pct", "high_pct")


def finite_okta(value):
    return mv.okta(value) if mv.finite(value) else None


def signed_interval_distance(predicted, allowed):
    if predicted is None or allowed is None:
        return None
    lo, hi = allowed
    return predicted - lo if predicted < lo else (predicted - hi if predicted > hi else 0)


def observed_cloud_layers(metar):
    """METAR cloud layers constrain only REPORTED bases, not the whole sky.

    VV is vertical visibility in obscuration, never treated as BKN/OVC base.
    Missing cloud layers in AUTO/CAVOK/NSC are not treated as total-clear sky.
    """
    observed = {"low": None, "mid": None, "high": None}
    very_low_ceiling = False
    vv_obscured = False
    if not metar:
        return observed, very_low_ceiling, vv_obscured
    for item in metar.get("clouds") or []:
        cover = str(item.get("cover") or "").upper()
        height = item.get("base_m_agl")
        if cover == "VV":
            vv_obscured = True
            continue
        if cover not in RANGES or not mv.finite(height):
            continue
        if height < 0 or height >= 13000:
            continue
        if cover in ("BKN", "OVC") and height <= 450:
            very_low_ceiling = True
        band = "low" if height < 2000 else ("mid" if height < 6000 else "high")
        rng = RANGES[cover]
        if observed[band] is None or rng[1] > observed[band][1]:
            observed[band] = rng
    return observed, very_low_ceiling, vv_obscured


def scan_archived_forecasts():
    """Read dated issued runs only, avoiding reanalysis and unrelated years."""
    best_model_rows = {}
    checked_files = 0
    seen_rows = 0
    day = START - timedelta(days=5)
    while day.date() <= END.date():
        source = mv.FORECAST_DIR / (day.strftime("%Y-%m-%d") + ".jsonl")
        day += timedelta(days=1)
        if not source.is_file():
            continue
        checked_files += 1
        with source.open(encoding="utf-8") as stream:
            for line in stream:
                try:
                    row = json.loads(line)
                except (ValueError, TypeError):
                    continue
                if row.get("model") not in mv.MODEL_META:
                    continue
                run = mv.parse_dt(row.get("run_time"))
                valid = mv.parse_dt(row.get("valid_time"))
                if not run or not valid or not (START <= valid <= END):
                    continue
                lead = (valid - run).total_seconds() / 3600
                if not 0 < lead < 121 or not mv.lead_bucket(lead):
                    continue
                if not any(mv.finite(row.get(k)) for k in KEYS):
                    continue
                seen_rows += 1
                key = (mv.iso(run), mv.iso(valid), row["model"])
                if not mv.finite(row.get("base_weight")):
                    row["base_weight"] = mv.MODEL_META[row["model"]][1]
                rank = sum(mv.finite(row.get(k)) for k in KEYS)
                prev = best_model_rows.get(key)
                if prev is None or rank > prev[0]:
                    best_model_rows[key] = (rank, row)

    by_issue = defaultdict(list)
    for _, row in best_model_rows.values():
        by_issue[(row["run_time"], row["valid_time"])].append(row)

    # Select one representative issue per (lead horizon, forecast valid hour).
    selected = {}
    for (run_id, valid_id), models in by_issue.items():
        if len(models) < 2:  # a one-model "consensus" is misleading
            continue
        c = mv.consensus_row(models)
        if not c:
            continue
        run, valid = mv.parse_dt(run_id), mv.parse_dt(valid_id)
        if not run or not valid:
            continue
        lead = (valid - run).total_seconds() / 3600
        bucket = mv.lead_bucket(lead)
        if not bucket:
            continue
        key = (bucket, mv.iso(valid))
        priority = (abs(lead - TARGETS[bucket]), -run.timestamp())
        previous = selected.get(key)
        if previous is None or priority < previous[0]:
            selected[key] = (priority, c, len(models))

    return checked_files, seen_rows, selected


def metrics(values):
    if not values:
        return {"n": 0, "bias_okta": None, "mae_okta": None, "rmse_okta": None,
                "within_1_okta_pct": None}
    n = len(values)
    return {
        "n": n,
        "bias_okta": round(sum(values) / n, 3),
        "mae_okta": round(sum(abs(x) for x in values) / n, 3),
        "rmse_okta": round(math.sqrt(sum(x * x for x in values) / n), 3),
        "within_1_okta_pct": round(100 * sum(abs(x) <= 1 for x in values) / n, 1),
    }


def event_scores(events):
    hit = sum(p and o for p, o in events)
    miss = sum((not p) and o for p, o in events)
    false = sum(p and (not o) for p, o in events)
    correct = sum((not p) and (not o) for p, o in events)
    return {
        "n": len(events), "hits": hit, "misses": miss,
        "false_alarms": false, "correct_negatives": correct,
        "pod_pct": round(100 * hit / (hit + miss), 1) if hit + miss else None,
        "far_pct": round(100 * false / (hit + false), 1) if hit + false else None,
        "csi_pct": round(100 * hit / (hit + miss + false), 1)
        if hit + miss + false else None,
    }


def main():
    checked_files, candidate_rows, selected = scan_archived_forecasts()
    metars, synops = mv.build_observation_maps()
    by_bucket = {key: defaultdict(list) for key in TARGETS}
    by_month = defaultdict(list)
    by_daypart = defaultdict(list)
    all_total = []
    all_low = []
    all_mid = []
    low_ceiling_obs_hours = set()
    sky_obscured_hours = set()
    examples = []
    source_hours = {"synop_total": set(), "metar_layers": set()}
    unique_forecast_times = set()
    total_events = defaultdict(list)

    for (bucket, valid_id), (_, consensus, model_n) in sorted(selected.items()):
        s = synops.get(valid_id)
        m = metars.get(valid_id)
        if not s and not m:
            continue
        unique_forecast_times.add(valid_id)
        forecast_total = finite_okta(consensus.get("cloud_total_pct"))
        forecast_low = finite_okta(consensus.get("low_pct"))
        forecast_mid = finite_okta(consensus.get("mid_pct"))
        actual_total = s.get("total_cloud_oktas") if s else None
        observed, low_ceiling, obscured = observed_cloud_layers(m)
        if m:
            source_hours["metar_layers"].add(valid_id)
            if low_ceiling:
                low_ceiling_obs_hours.add(valid_id)
            if obscured:
                sky_obscured_hours.add(valid_id)

        if mv.finite(actual_total) and 0 <= actual_total <= 8 and forecast_total is not None:
            err = forecast_total - float(actual_total)
            by_bucket[bucket]["total"].append(err)
            all_total.append(err)
            source_hours["synop_total"].add(valid_id)
            total_events[bucket].append((forecast_total >= 5, actual_total >= 5))
            if bucket == "0-3h":
                valid = mv.parse_dt(valid_id)
                month = valid.strftime("%Y-%m")
                by_month[month].append(err)
                h = valid.hour
                label = "night_18_06" if h >= 18 or h < 6 else ("morning_06_12" if h < 12 else "day_12_18")
                by_daypart[label].append(err)
                examples.append({
                    "valid_time": valid_id, "run_time": consensus.get("run_time"),
                    "forecast_okta": forecast_total, "synop_okta": actual_total,
                    "signed_error": err, "source_models": model_n
                })

        if forecast_low is not None and observed["low"] is not None:
            err = signed_interval_distance(forecast_low, observed["low"])
            by_bucket[bucket]["low_0_2000"].append(err)
            all_low.append(err)

        if forecast_mid is not None and observed["mid"] is not None:
            err = signed_interval_distance(forecast_mid, observed["mid"])
            by_bucket[bucket]["mid_2000_6000"].append(err)
            all_mid.append(err)

    by_bucket_report = {}
    for bucket in TARGETS:
        data = by_bucket[bucket]
        by_bucket_report[bucket] = {
            "selected_forecast_hours": sum(1 for key in selected if key[0] == bucket),
            "total_vs_synop": metrics(data["total"]),
            "low_0_2000_vs_metar": metrics(data["low_0_2000"]),
            "mid_2000_6000_vs_metar": metrics(data["mid_2000_6000"]),
            "bkn_ovc_total_threshold": event_scores(total_events[bucket]),
        }
    worst = sorted(examples, key=lambda e: abs(e["signed_error"]), reverse=True)[:8]

    output = {
        "schema": "prognozaepir-consensus-cloud-two-month-audit-v1",
        "generated_at": mv.iso(mv.utcnow()),
        "period_start": mv.iso(START),
        "period_end_inclusive": mv.iso(END),
        "source": "Actual archived source-model runs and EPIR METAR/SPECI plus WMO 12342 SYNOP",
        "forecast_policy": "Base-weight reconstructed consensus; issued before valid; min 2 models; one nearest lead-bucket-target forecast per valid hour",
        "coverage": {
            "dated_forecast_files": checked_files,
            "individual_forecast_rows_eligible": candidate_rows,
            "selected_consensus_forecast_hours_across_buckets": len(selected),
            "unique_valid_hours_with_any_observation": len(unique_forecast_times),
            "unique_synop_hours_usable_for_total": len(source_hours["synop_total"]),
            "unique_metar_hours_available": len(source_hours["metar_layers"]),
        },
        "all_horizons": {
            "total_vs_synop": metrics(all_total),
            "low_0_2000_vs_metar": metrics(all_low),
            "mid_2000_6000_vs_metar": metrics(all_mid),
        },
        "by_lead_bucket": by_bucket_report,
        "by_month_0_3h_total": {name: metrics(v) for name, v in sorted(by_month.items())},
        "by_daypart_0_3h_total": {name: metrics(v) for name, v in sorted(by_daypart.items())},
        "observed_low_ceiling_not_verified_as_forecast": {
            "hours_with_explicit_bkn_ovc_base_at_or_below_450m": len(low_ceiling_obs_hours),
            "hours_with_vv_vertical_visibility": len(sky_obscured_hours),
        },
        "largest_total_errors_0_3h": worst,
        "limitations": [
            "Archived operational CONSENSUS output snapshots (after adaptive, cloud skill and synoptic processing) are not stored for these valid times: this report reconstructs a base-weight consensus, not an exact historic UI replay.",
            "METAR FEW/SCT/BKN/OVC are interval observations; signed error is distance to the closest allowed okta, zero inside the interval.",
            "METAR AUTO omitted cloud groups and CAVOK/NSC cannot certify total sky 0/8. Missing high-level clouds are not scored as clear sky.",
            "No archived consensus forecast contains a 0–450 m cloud-coverage value or predicted cloud base, so precise very-low-cloud and ceiling skill cannot be calculated.",
            "Several forecasts may share the same valid hour across different lead buckets; all-horizon aggregates are not statistically independent.",
        ],
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("EPIR 2-month cloud audit:", json.dumps({
        "coverage": output["coverage"], "all_horizons": output["all_horizons"],
        "0-3h": by_bucket_report["0-3h"], "months": output["by_month_0_3h_total"]
    }, ensure_ascii=False))
    if not checked_files or not len(selected):
        raise RuntimeError("No eligible archived forecast runs; aborting cloud audit")


if __name__ == "__main__":
    main()
