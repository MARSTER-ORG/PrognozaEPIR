#!/usr/bin/env python3
"""Forecast-safe calibration diagnostics for Fog vNext +1h onset risk.

2025 is used only to select the prior/evidence strengths. 2026 is reported as
an untouched test period. The candidate formula keeps P_physics as the ranking
anchor and lets the observed-state historical prior act only as a shrunk odds
modifier around the global historical onset rate.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import fog_vnext_verification as verify
import model_verification as mv

OUT = mv.LEARNING / "fog-vnext-onset-calibration.json"
PRIORS = mv.LEARNING / "fog-transition-priors-vnext.json"


def finite(v):
    return mv.finite(v)


def clamp(v, a=1e-6, b=1 - 1e-6):
    return max(a, min(b, float(v)))


def logit(p):
    p = clamp(p)
    return math.log(p / (1.0 - p))


def logistic(x):
    if x >= 0:
        z = math.exp(-x)
        return 1.0 / (1.0 + z)
    z = math.exp(x)
    return z / (1.0 + z)


def score01(case, key):
    """Read verifier probability fields under the explicit 0..1 contract."""
    v = (case.get("vnext") or {}).get(key)
    if not finite(v):
        return None
    return clamp(float(v), 0.0, 1.0)


def candidate_score(case, global_prior, prior_lambda, evidence_beta):
    p = score01(case, "physics_score")
    prior = score01(case, "onset_historical_prior")
    if not finite(p):
        return None
    gp = clamp(global_prior)
    base_logit = logit(gp)
    if finite(prior):
        # Shrink the state/hour/month prior toward the global prior before it
        # can alter ranking. lambda=0 is global-prior-only.
        base_logit += prior_lambda * (logit(prior) - logit(gp))
    return logistic(base_logit + evidence_beta * (2.0 * clamp(p) - 1.0))


def current_score(case):
    return score01(case, "onset_risk_shadow")


def physics_score(case):
    return score01(case, "physics_score")


def year_of(case):
    dt = mv.parse_dt(case.get("valid_time"))
    return dt.year if dt else None


def onset_rows(cases, year):
    return [
        c for c in cases
        if year_of(c) == year and not (c.get("truth") or {}).get("fog_truth")
    ]


def metrics(rows, scorer):
    return verify.target_metrics(rows, scorer, "onset_next_1h")


def objective(block):
    event = block["event_balanced"]
    hourly = block["hourly"]
    auc = event.get("auc")
    br = hourly.get("brier")
    if auc is None or br is None:
        return None
    # Ranking is primary; hourly probability quality breaks near-ties.
    return float(auc) - 0.15 * float(br)


def main():
    cases = mv.load_jsonl(verify.CASES_PATH)
    priors = json.loads(PRIORS.read_text(encoding="utf-8"))
    global_prior = float(priors["rates"]["onset_next_1h_global"])
    train = onset_rows(cases, 2025)
    test = onset_rows(cases, 2026)

    lambdas = [0.0, 0.05, 0.10, 0.15, 0.20, 0.30]
    betas = [1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0]
    candidates = []
    for lam in lambdas:
        for beta in betas:
            train_m = metrics(train, lambda c, l=lam, b=beta: candidate_score(c, global_prior, l, b))
            obj = objective(train_m)
            if obj is None:
                continue
            candidates.append({
                "prior_lambda": lam,
                "evidence_beta": beta,
                "selection_objective_2025": round(obj, 6),
                "metrics_2025": train_m,
                "metrics_2026": metrics(test, lambda c, l=lam, b=beta: candidate_score(c, global_prior, l, b)),
            })
    candidates.sort(key=lambda r: r["selection_objective_2025"], reverse=True)
    best = candidates[0] if candidates else None

    baselines = {
        "current_transition": {"2025": metrics(train, current_score), "2026": metrics(test, current_score)},
        "physics_only": {"2025": metrics(train, physics_score), "2026": metrics(test, physics_score)},
    }
    accept = False
    reasons = []
    if best:
        b26 = best["metrics_2026"]["event_balanced"]
        p26 = baselines["physics_only"]["2026"]["event_balanced"]
        c26 = baselines["current_transition"]["2026"]["event_balanced"]
        if b26.get("positive", 0) < 3 or b26.get("negative", 0) < 5:
            reasons.append("2026 test support too small")
        else:
            best_auc = b26.get("auc")
            physics_auc = p26.get("auc")
            current_auc = c26.get("auc")
            if best_auc is None:
                reasons.append("2026 candidate AUC unavailable")
            elif physics_auc is not None and best_auc + 0.02 < physics_auc:
                reasons.append("candidate trails 2026 physics-only AUC by >0.02")
            elif current_auc is not None and best_auc <= current_auc:
                reasons.append("candidate does not improve 2026 current transition AUC")
            else:
                accept = True
    else:
        reasons.append("no evaluable candidate")

    report = {
        "schema": "prognozaepir-fog-vnext-onset-calibration-v1",
        "generated_at": mv.iso(mv.utcnow()),
        "policy": {
            "selection_year": 2025,
            "untouched_test_year": 2026,
            "forecast_safe": True,
            "truth_not_used_as_predictor": True,
            "probability_unit_contract": "0..1",
            "ranking_anchor": "P_physics",
        },
        "global_onset_prior": global_prior,
        "rows": {"2025": len(train), "2026": len(test)},
        "baselines": baselines,
        "best_2025_candidate": best,
        "accepted_on_2026": accept,
        "acceptance_reasons": reasons,
        "top_candidates": candidates[:10],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "schema": report["schema"],
        "rows": report["rows"],
        "best": ({k: best[k] for k in ("prior_lambda", "evidence_beta", "selection_objective_2025")} if best else None),
        "accepted_on_2026": accept,
        "reasons": reasons,
        "baseline_2026": {k: v["2026"]["event_balanced"] for k, v in baselines.items()},
        "candidate_2026": best["metrics_2026"]["event_balanced"] if best else None,
    }, ensure_ascii=False))
    return report


if __name__ == "__main__":
    main()
