#!/usr/bin/env python3
"""Build a compact machine-readable status snapshot for Consensus learning."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from learning_quality_gate import quality_report

ROOT = Path(__file__).resolve().parents[1]
LEARNING = ROOT / "data" / "learning"
OUT = LEARNING / "learning-status.json"


def load(name: str, default: Any = None) -> Any:
    path = LEARNING / name
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {} if default is None else default


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def file_state(name: str) -> dict:
    path = LEARNING / name
    return {"present": path.exists(), "bytes": path.stat().st_size if path.exists() else 0}


def main() -> None:
    verification = load("model-verification.json")
    adaptive = load("adaptive-weights.json")
    historical = load("historical-model-skill.json")
    previous = load("previous-runs-backfill-state.json")
    observation = load("observation-history-autofill-state.json")
    single_run = load("model-backfill-state.json")
    oos = load("out-of-sample-validation.json")
    quality = quality_report()

    archive = historical.get("archive") or {}
    consensus = ((verification.get("models") or {}).get("consensus") or {})
    oos_test = oos.get("test") or {}
    oos_learned = oos_test.get("learned_consensus") or {}
    oos_base = oos_test.get("base_weight_consensus") or {}

    qcounts = quality.get("counts") or {}
    qmonths = quality.get("months") or {}
    warnings = []
    if int(qcounts.get("auxiliary") or 0):
        warnings.append(f"{qcounts.get('auxiliary')} Previous Runs month(s) are auxiliary and excluded from production weight learning")
    if int(qcounts.get("excluded") or 0):
        warnings.append(f"{qcounts.get('excluded')} Previous Runs month(s) have <3 models and are excluded from production weight learning")
    if int(qcounts.get("unknown") or 0):
        warnings.append(f"{qcounts.get('unknown')} Previous Runs month file(s) have no trusted state metadata and are excluded fail-safe")
    if int(previous.get("remaining_pending_months") or 0):
        warnings.append(f"Previous Runs backfill still has {previous.get('remaining_pending_months')} pending month(s)")
    if single_run and float(single_run.get("completeness_pct") or 0) < 95:
        warnings.append(f"Single-runs backfill completeness is {single_run.get('completeness_pct')}%")
    if int(observation.get("remaining_pending_days") or 0):
        warnings.append(f"Observation-driven historical enrichment still has {observation.get('remaining_pending_days')} pending run day(s)")

    payload = {
        "schema": "prognozaepir-learning-status-v1",
        "generated_at": iso_now(),
        "training_archive": {
            "forecast_rows_loaded": archive.get("forecast_rows_loaded"),
            "usable_forecast_cases": archive.get("usable_forecast_cases"),
            "valid_time_start": archive.get("valid_time_start"),
            "valid_time_end": archive.get("valid_time_end"),
            "single_run_backfill_start": archive.get("backfill_period_start"),
            "single_run_backfill_end": archive.get("backfill_period_end"),
        },
        "consensus_verification": {
            "generated_at": verification.get("generated_at"),
            "score_pct": consensus.get("score_pct"),
            "forecast_samples": consensus.get("forecast_samples"),
            "components": consensus.get("components") or {},
        },
        "adaptive_learning": {
            "generated_at": adaptive.get("generated_at"),
            "method": adaptive.get("method"),
            "min_samples": adaptive.get("min_samples"),
            "full_samples": adaptive.get("full_samples"),
            "half_life_days": adaptive.get("half_life_days"),
            "model_count": len(adaptive.get("models") or {}),
        },
        "quality_gate": {
            "policy": quality.get("policy"),
            "counts": qcounts,
            "months": qmonths,
        },
        "previous_runs_backfill": {
            "source": previous.get("source"),
            "archive_start": previous.get("archive_start"),
            "requested_start_month": previous.get("requested_start_month"),
            "requested_end_month": previous.get("requested_end_month"),
            "selected_months": previous.get("selected_months") or [],
            "remaining_pending_months": previous.get("remaining_pending_months"),
            "next_pending_months": previous.get("next_pending_months") or [],
        },
        "single_runs_backfill": {
            "period_start": single_run.get("period_start"),
            "period_end": single_run.get("period_end"),
            "complete_runs": single_run.get("complete_runs"),
            "expected_runs": single_run.get("expected_runs"),
            "completeness_pct": single_run.get("completeness_pct"),
            "remaining_failed_runs": single_run.get("remaining_failed_runs"),
        },
        "observation_history": {
            "observation_days": observation.get("observation_days"),
            "required_run_days": observation.get("required_run_days"),
            "remaining_pending_days": observation.get("remaining_pending_days"),
            "next_pending_days": observation.get("next_pending_days") or [],
            "source_policy": observation.get("source_policy"),
        },
        "out_of_sample": {
            "generated_at": oos.get("generated_at"),
            "method": oos.get("method"),
            "leakage_guard": oos.get("leakage_guard") or {},
            "test_cases": oos_test.get("eligible_cases"),
            "learned_consensus_score_pct": oos_learned.get("composite_score_pct"),
            "base_weight_consensus_score_pct": oos_base.get("composite_score_pct"),
            "learned_minus_base_pct_points": oos_test.get("learned_minus_base_pct_points"),
            "by_lead_bucket": oos_test.get("by_lead_bucket") or {},
        },
        "advanced_learning": {
            "synoptic_regime": file_state("synoptic-regime-skill.json"),
            "fog_event_skill": file_state("fog-event-skill.json"),
            "fog_event_vnext_shadow": file_state("fog-event-skill-vnext-shadow.json"),
            "historical_model_skill": file_state("historical-model-skill.json"),
        },
        "warnings": warnings,
    }

    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Learning status written: {OUT}")
    print(f"quality months: {qcounts}; OOS delta={oos_test.get('learned_minus_base_pct_points')}")


if __name__ == "__main__":
    main()
