#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import fog_vnext_onset_calibration as c


def row(physics, prior=0.02):
    return {
        "vnext": {
            "physics_score": physics,
            "onset_historical_prior": prior,
            "onset_risk_shadow": 0.05,
        },
        "truth": {"fog_truth": False, "onset_next_1h": False},
    }


def main():
    low = row(0.35)
    high = row(0.80)
    # With global-prior-only calibration, ranking must remain monotonic in physics.
    a = c.candidate_score(low, 0.003, 0.0, 2.5)
    b = c.candidate_score(high, 0.003, 0.0, 2.5)
    assert 0 < a < b < 1

    # State prior may modulate odds, but only when lambda is non-zero.
    p_low = c.candidate_score(row(0.6, 0.001), 0.003, 0.2, 2.5)
    p_high = c.candidate_score(row(0.6, 0.05), 0.003, 0.2, 2.5)
    assert p_low < p_high
    print("onset calibration diagnostics tests: OK")


if __name__ == "__main__":
    main()
