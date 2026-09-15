#!/usr/bin/env python3
"""SSFC_COOL diagnostics for Fog Engine vNext shadow verification.

The report is diagnostic only. It compares the full shadow blend with the
existing no_surface_cooling ablation and stratifies the result by lead,
dominant mechanism, truth-derived event phase, SSFC data completeness, raw
surface-cooling components and forecast-time saturation/physics state.

Truth-derived phases are used only after scoring for analysis; they are never
fed back into forecast physics. Forecast-time groups use only signals available
inside the issued forecast case and are therefore safe candidates for later
stage-aware SSFC modulation.
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

import fog_vnext_verification as verify
import model_verification as mv

OUT = mv.LEARNING / "fog-vnext-ssfc-diagnostics.json"


def finite(v):
    return mv.finite(v)


def score_full(case):
    v = (case.get("vnext") or {}).get("model_final_shadow")
    return float(v) / 100.0 if finite(v) else None


def score_no_ssfc(case):
    v = ((case.get("ablation") or {}).get("no_surface_cooling") or {}).get("model_final_shadow")
    return float(v) / 100.0 if finite(v) else None


def truth_phase(case):
    """Post-hoc diagnostic phase; never an input to forecast evaluation."""
    tr = case.get("truth") or {}
    if tr.get("fog_truth"):
        if tr.get("dissipation_next_1h") is True or tr.get("fog_exit_next_1h") is True:
            return "dissipation"
        vis = tr.get("visibility_m")
        if finite(vis) and float(vis) < 500.0:
            return "mature-deep"
        return "onset-thin"
    if tr.get("onset_next_1h") is True:
        return "pre-onset"
    return "non-event-control"


def ssfc_coverage(case):
    v = case.get("vnext") or {}
    if not finite(v.get("SSFC_COOL")):
        return "missing"
    fields = (
        "surfaceCooling",
        "deltaSurfaceCooling1",
        "deltaSurfaceCooling3",
        "deltaTsurface3",
    )
    return "full" if all(finite(v.get(k)) for k in fields) else "partial"


def mechanism(case):
    return (case.get("vnext") or {}).get("mechanism1") or "unknown"


def forecast_phase(case):
    # This is the phase produced by the forecast physics itself, not truth.
    return (case.get("vnext") or {}).get("phase") or "unknown"


def metric_block(rows):
    rows = list(rows)
    full = verify.target_metrics(rows, score_full, "fog_truth")
    no_ssfc = verify.target_metrics(rows, score_no_ssfc, "fog_truth")
    fe = full["event_balanced"]
    ne = no_ssfc["event_balanced"]
    fh = full["hourly"]
    nh = no_ssfc["hourly"]
    return {
        "cases": len(rows),
        "fog_positive_hours": sum(1 for c in rows if (c.get("truth") or {}).get("fog_truth")),
        "full": full,
        "no_surface_cooling": no_ssfc,
        "delta_event_auc_full_minus_no_ssfc": (
            round(fe["auc"] - ne["auc"], 4)
            if fe.get("auc") is not None and ne.get("auc") is not None else None
        ),
        "delta_event_brier_no_ssfc_minus_full": (
            round(ne["brier"] - fe["brier"], 4)
            if fe.get("brier") is not None and ne.get("brier") is not None else None
        ),
        "delta_hourly_brier_no_ssfc_minus_full": (
            round(nh["brier"] - fh["brier"], 4)
            if fh.get("brier") is not None and nh.get("brier") is not None else None
        ),
    }


def grouped(cases, key_fn):
    buckets = defaultdict(list)
    for c in cases:
        buckets[str(key_fn(c))].append(c)
    return {k: metric_block(v) for k, v in sorted(buckets.items())}


def numeric_bin(value, cuts, labels):
    if not finite(value):
        return "missing"
    x = float(value)
    for cut, label in zip(cuts, labels):
        if x < cut:
            return label
    return labels[-1]


def saturation_bin(case):
    return numeric_bin(
        (case.get("vnext") or {}).get("SATURATION"),
        [45.0, 65.0, 80.0, float("inf")],
        ["<45", "45-65", "65-80", ">=80"],
    )


def physics_score_bin(case):
    return numeric_bin(
        (case.get("vnext") or {}).get("physics_score"),
        [45.0, 65.0, 80.0, float("inf")],
        ["<45", "45-65", "65-80", ">=80"],
    )


def component_groups(cases):
    return {
        "t2_minus_tsurface_c": grouped(
            cases,
            lambda c: numeric_bin(
                (c.get("vnext") or {}).get("surfaceCooling"),
                [0.0, 1.0, 2.0, float("inf")],
                ["<0", "0-1", "1-2", ">=2"],
            ),
        ),
        "delta_t2_minus_tsurface_3h_c": grouped(
            cases,
            lambda c: numeric_bin(
                (c.get("vnext") or {}).get("deltaSurfaceCooling3"),
                [0.0, 0.5, 1.5, float("inf")],
                ["<0", "0-0.5", "0.5-1.5", ">=1.5"],
            ),
        ),
        "delta_tsurface_3h_c": grouped(
            cases,
            lambda c: numeric_bin(
                (c.get("vnext") or {}).get("deltaTsurface3"),
                [-0.5, 0.5, float("inf")],
                ["cooling_<-0.5", "near-steady_-0.5_to_0.5", "warming_>0.5"],
            ),
        ),
    }


def compact_findings(report):
    findings = []
    overall = report["overall"]
    d = overall.get("delta_event_auc_full_minus_no_ssfc")
    if d is not None:
        findings.append({"scope": "overall", "delta_event_auc": d})
    for family in (
        "by_lead", "by_mechanism", "by_truth_phase", "by_forecast_phase",
        "by_saturation", "by_physics_score", "by_coverage",
    ):
        for key, row in report[family].items():
            delta = row.get("delta_event_auc_full_minus_no_ssfc")
            if delta is not None:
                findings.append({"scope": family, "group": key, "delta_event_auc": delta, "cases": row["cases"]})
    findings.sort(key=lambda x: (x.get("delta_event_auc", 0.0), -x.get("cases", 0)))
    return findings[:16]


def main():
    cases = mv.load_jsonl(verify.CASES_PATH)
    report = {
        "schema": "prognozaepir-fog-vnext-ssfc-diagnostics-v1",
        "generated_at": mv.iso(mv.utcnow()),
        "cases": len(cases),
        "policy": {
            "diagnostic_only": True,
            "truth_phase_is_posthoc_not_forecast_input": True,
            "forecast_signal_groups_are_truth_independent": True,
            "comparison": "full shadow blend vs existing no_surface_cooling ablation",
            "positive_brier_delta_means_full_is_better": True,
        },
        "overall": metric_block(cases),
        "by_lead": grouped(cases, lambda c: c.get("lead_bucket") or "unknown"),
        "by_mechanism": grouped(cases, mechanism),
        "by_truth_phase": grouped(cases, truth_phase),
        "by_forecast_phase": grouped(cases, forecast_phase),
        "by_saturation": grouped(cases, saturation_bin),
        "by_physics_score": grouped(cases, physics_score_bin),
        "by_coverage": grouped(cases, ssfc_coverage),
        "components": component_groups(cases),
    }
    report["worst_event_auc_groups"] = compact_findings(report)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "schema": report["schema"],
        "cases": report["cases"],
        "overall_delta_event_auc": report["overall"]["delta_event_auc_full_minus_no_ssfc"],
        "worst": report["worst_event_auc_groups"][:8],
    }, ensure_ascii=False))
    return report


if __name__ == "__main__":
    main()
