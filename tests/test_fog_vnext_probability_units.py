#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVAL = ROOT / "scripts" / "fog_vnext_eval.js"


def main():
    sample = [{
        "time": "2026-09-15T03:00:00Z",
        "leadHours": 3,
        "t": 10.0,
        "td": 9.2,
        "rh": 95.0,
        "ws": 1.2,
        "pbl": 90.0,
        "tsurface": 8.8,
        "isDay": 0,
        "state": "CLEAR",
        "obsUsed": True,
        "obsVisM": 10000,
    }]
    p = subprocess.run(
        ["node", str(EVAL)], input=json.dumps(sample), text=True,
        capture_output=True, check=True,
    )
    row = json.loads(p.stdout)[0]
    keys = (
        "physics_score", "direct_score", "model_final_shadow",
        "onset_risk_shadow", "onset_historical_prior",
        "dissipation_risk_shadow", "dissipation_historical_prior", "dissipation",
    )
    for key in keys:
        value = row.get(key)
        if value is not None:
            assert 0.0 <= float(value) <= 1.0, (key, value)
    assert row.get("P_physics") == row.get("physics_score")
    assert row.get("P_direct") == row.get("direct_score")
    assert row.get("P_model_final_shadow") == row.get("model_final_shadow")
    print("Fog vNext verifier probability units 0..1: OK")


if __name__ == "__main__":
    main()
