#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import fog_vnext_ssfc_diagnostics as d


def case(event_id, fog, full_score, no_score, *, phase_truth=None, vis=10000, mechanism="RAD", ssfc=70, complete=True, saturation=72, physics=68, forecast_phase="pre-onset"):
    tr = {
        "event_id": event_id,
        "fog_truth": fog,
        "visibility_m": vis,
        "onset_next_1h": phase_truth == "pre-onset",
        "dissipation_next_1h": phase_truth == "dissipation",
        "fog_exit_next_1h": False,
    }
    v = {
        "model_final_shadow": full_score * 100,
        "mechanism1": mechanism,
        "SSFC_COOL": ssfc,
        "SATURATION": saturation,
        "physics_score": physics,
        "phase": forecast_phase,
        "surfaceCooling": 1.2,
        "deltaSurfaceCooling1": 0.2 if complete else None,
        "deltaSurfaceCooling3": 0.7 if complete else None,
        "deltaTsurface3": -1.0 if complete else None,
    }
    return {
        "lead_bucket": "3-12h",
        "vnext": v,
        "ablation": {"no_surface_cooling": {"model_final_shadow": no_score * 100}},
        "truth": tr,
    }


def main():
    rows = [
        case("F1", True, 0.85, 0.65, vis=300, saturation=84, physics=83),
        case("F2", True, 0.75, 0.55, vis=800, saturation=71, physics=74),
        case("C1", False, 0.15, 0.25, saturation=41, physics=39),
        case("C2", False, 0.25, 0.35, complete=False, saturation=58, physics=52),
    ]
    m = d.metric_block(rows)
    assert m["cases"] == 4
    assert m["fog_positive_hours"] == 2
    assert m["delta_event_auc_full_minus_no_ssfc"] is not None
    assert d.ssfc_coverage(rows[0]) == "full"
    assert d.ssfc_coverage(rows[-1]) == "partial"
    assert d.truth_phase(rows[0]) == "mature-deep"

    assert d.saturation_bin(rows[0]) == ">=80"
    assert d.saturation_bin(rows[1]) == "65-80"
    assert d.saturation_bin(rows[2]) == "<45"
    assert d.saturation_bin(rows[3]) == "45-65"
    assert d.physics_score_bin(rows[0]) == ">=80"
    assert d.forecast_phase(rows[0]) == "pre-onset"

    onset = case("C3", False, 0.5, 0.4, phase_truth="pre-onset")
    assert d.truth_phase(onset) == "pre-onset"
    diss = case("F3", True, 0.5, 0.4, phase_truth="dissipation", vis=700)
    assert d.truth_phase(diss) == "dissipation"
    print("SSFC_COOL diagnostics tests: OK")


if __name__ == "__main__":
    main()
