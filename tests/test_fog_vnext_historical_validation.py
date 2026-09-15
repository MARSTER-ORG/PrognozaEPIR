#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import fog_vnext_historical_validation as hv


def fake_case(year, score, fog):
    return {
        "valid_time": f"{year}-10-01T03:00:00Z",
        "lead_bucket": "3-6h",
        "vnext": {
            "physics_score": score,
            "direct_score": score,
            "model_final_shadow": score,
        },
        "truth": {
            "fog_truth": fog,
            "event_id": f"E-{year}-{'F' if fog else 'C'}",
        },
    }


def main():
    t = {"truth_known": 10}
    none_fc = {"models": []}
    assert hv.cohort(2022, t, none_fc, None)["tier"] == "C_truth_event_learning"

    partial_fc = {"models": ["ecmwf_ifs"]}
    partial_case = {"cases": 5}
    assert hv.cohort(2025, t, partial_fc, partial_case)["tier"] == "B_partial_forecast_verification"

    full_fc = {"models": sorted(hv.CORE_MODELS)}
    assert hv.cohort(2026, t, full_fc, partial_case)["tier"] == "A_full_multimodel_forecast_verification"

    cases = [
        fake_case(2025, 0.8, True),
        fake_case(2025, 0.2, False),
        fake_case(2026, 0.9, True),
        fake_case(2026, 0.1, False),
    ]
    folds = {row["test_year"]: row for row in hv.rolling_origin(cases)}
    assert folds[2023]["forecast_evaluable"] is False
    assert folds[2024]["forecast_evaluable"] is False
    assert folds[2025]["forecast_evaluable"] is True
    assert folds[2025]["train_years"] == [2020, 2021, 2022, 2023, 2024]
    assert folds[2026]["forecast_evaluable"] is True
    assert folds[2026]["train_years"] == [2020, 2021, 2022, 2023, 2024, 2025]
    print("historical validation cohorts + rolling origin: OK")


if __name__ == "__main__":
    main()
