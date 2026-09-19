#!/usr/bin/env python3
"""Run PrognozaEPIR learning rebuilds behind the historical quality gate."""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from learning_quality_gate import training_only_previous_runs

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"

PROFILES = {
    "previous-runs": [
        "model_verification.py",
        "consensus_diagnostics.py",
        "build_adaptive_weights.py",
        "build_historical_model_skill.py",
        "build_out_of_sample_validation.py",
        "build_learning_status.py",
        "embed_model_verification.py",
    ],
    "historical": [
        "model_verification.py",
        "cloud_learning_backfill.py",
        "build_adaptive_weights.py",
        "build_historical_model_skill.py",
        "build_synoptic_regime_learning.py",
        "build_fog_event_learning.py",
        "build_out_of_sample_validation.py",
        "build_learning_status.py",
        "embed_model_verification.py",
    ],
    "full": [
        "model_verification.py",
        "consensus_diagnostics.py",
        "cloud_learning_backfill.py",
        "build_adaptive_weights.py",
        "build_historical_model_skill.py",
        "build_synoptic_regime_learning.py",
        "build_fog_event_learning.py",
        "build_out_of_sample_validation.py",
        "build_learning_status.py",
        "embed_model_verification.py",
    ],
}


def run_script(name: str) -> None:
    path = SCRIPTS / name
    if not path.exists():
        raise FileNotFoundError(path)
    print(f"[learning] {name}", flush=True)
    subprocess.run([sys.executable, str(path)], cwd=ROOT, check=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", choices=sorted(PROFILES), default="full")
    args = parser.parse_args()

    with training_only_previous_runs() as gate:
        counts = gate.get("counts") or {}
        quarantined = gate.get("temporarily_quarantined_count") or 0
        print(
            "[quality-gate] "
            f"training={counts.get('training', 0)} "
            f"auxiliary={counts.get('auxiliary', 0)} "
            f"excluded={counts.get('excluded', 0)} "
            f"unknown={counts.get('unknown', 0)} "
            f"quarantined={quarantined}",
            flush=True,
        )
        for script in PROFILES[args.profile]:
            run_script(script)

    print("[quality-gate] raw Previous Runs files restored", flush=True)


if __name__ == "__main__":
    main()
