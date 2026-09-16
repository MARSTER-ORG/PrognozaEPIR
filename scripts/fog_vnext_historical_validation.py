#!/usr/bin/env python3
"""Unified 2020-2026 historical validation report for Fog Engine vNext.

This report deliberately separates:
- truth/event learning availability,
- genuine issued-forecast availability,
- forecast->later-truth verification cases.

It never upgrades truth-only years into forecast verification and never uses
reanalysis as a substitute for an issued forecast run.
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

import build_fog_event_learning_v2 as truth
import fog_vnext_event_backfill as hist
import fog_vnext_model_archive as archive
import fog_vnext_verification as verify
import model_verification as mv

OUT = mv.LEARNING / "fog-vnext-historical-validation.json"
YEARS = tuple(range(2020, 2027))
CORE_MODELS = {
    "dmi_harmonie_arome_europe",
    "knmi_harmonie_arome_europe",
    "icon_d2",
    "ecmwf_ifs",
}

ROLE = {
    2020: "train_reference",
    2021: "train_reference",
    2022: "train_reference",
    2023: "train_reference",
    2024: "train_reference",
    2025: "independent_validation",
    2026: "rolling_test",
}


def year_of(value):
    dt = mv.parse_dt(value)
    return dt.year if dt else None


def truth_inventory():
    rows, source_inventory = hist.load_observation_rows()
    by_year = {year: {
        "aviation_observations": 0,
        "truth_known": 0,
        "fog_truth": 0,
        "br": 0,
        "mifg": 0,
        "sources": defaultdict(int),
    } for year in YEARS}

    for row in rows:
        dt = hist._obs_dt(row)
        if not dt or dt.year not in by_year:
            continue
        cls = truth.classify(row)
        canonical_fog = hist._bool_or_none(row.get("fog_truth"))
        fog = cls["fog"] if canonical_fog is None else canonical_fog
        vis = row.get("visibility_m")
        known_vis = mv.finite(vis)
        br_vis = known_vis and 1000 <= float(vis) <= 5000 and not fog and not cls["mifg"]
        known = bool(known_vis or fog or cls["br"] or cls["mifg"])
        y = by_year[dt.year]
        y["aviation_observations"] += 1
        y["truth_known"] += int(known)
        y["fog_truth"] += int(bool(fog))
        y["br"] += int(bool((cls["br"] or br_vis) and not fog and not cls["mifg"]))
        y["mifg"] += int(bool(cls["mifg"] and not fog))
        y["sources"][row.get("_fog_vnext_history_source") or "repository"] += 1

    synops = mv.unique_rows(mv.all_jsonl(mv.SYNOP_DIR), ("obs_time", "raw"))
    synop_by_year = defaultdict(int)
    for row in synops:
        year = year_of(row.get("obs_time"))
        if year in YEARS:
            synop_by_year[year] += 1

    out = {}
    for year in YEARS:
        row = dict(by_year[year])
        row["sources"] = dict(sorted(row["sources"].items()))
        row["synop_teacher"] = synop_by_year[year]
        out[str(year)] = row
    return out, source_inventory


def forecast_inventory():
    rows = verify.load_full_rows()
    by_year = {year: {
        "forecast_rows": 0,
        "archive_batches": set(),
        "models": set(),
        "lead_buckets": set(),
        "field_available": defaultdict(int),
    } for year in YEARS}
    fields = {
        "soil": ("soil_moisture_0_to_1cm", "soil_moisture_0_to_7cm"),
        "pbl": ("boundary_layer_height_m",),
        "surface_temperature": ("surface_temperature_c",),
    }
    for row in rows:
        year = year_of(row.get("valid_time"))
        if year not in by_year:
            continue
        y = by_year[year]
        y["forecast_rows"] += 1
        if row.get("archive_time"):
            y["archive_batches"].add(row["archive_time"])
        if row.get("model"):
            y["models"].add(row["model"])
        if row.get("lead_bucket"):
            y["lead_buckets"].add(row["lead_bucket"])
        for family, keys in fields.items():
            if any(mv.finite(row.get(k)) for k in keys):
                y["field_available"][family] += 1

    out = {}
    for year in YEARS:
        y = by_year[year]
        n = y["forecast_rows"]
        out[str(year)] = {
            "forecast_rows": n,
            "archive_batches": len(y["archive_batches"]),
            "models": sorted(y["models"]),
            "lead_buckets": sorted(y["lead_buckets"]),
            "field_coverage": {
                key: round(value / n, 4) if n else 0.0
                for key, value in sorted(y["field_available"].items())
            },
        }
    return out


def load_cases():
    return mv.load_jsonl(verify.CASES_PATH)


def metrics_for(rows):
    if not rows:
        return None
    physics = lambda c: verify.score01(c, "physics_score")
    direct = lambda c: verify.score01(c, "direct_score")
    blend = lambda c: verify.score01(c, "model_final_shadow")
    return {
        "cases": len(rows),
        "fog_positive_hours": sum(1 for c in rows if c.get("truth", {}).get("fog_truth")),
        "blend": verify.target_metrics(rows, blend, "fog_truth"),
        "physics": verify.target_metrics(rows, physics, "fog_truth"),
        "direct": verify.target_metrics(rows, direct, "fog_truth"),
    }


def case_inventory(cases):
    grouped = defaultdict(list)
    for case in cases:
        year = year_of(case.get("valid_time"))
        if year in YEARS:
            grouped[year].append(case)
    return {str(year): metrics_for(grouped.get(year, [])) for year in YEARS}


def cohort(year, truth_row, forecast_row, case_row):
    models = set(forecast_row.get("models") or [])
    cases = (case_row or {}).get("cases", 0) if case_row else 0
    if cases and CORE_MODELS.issubset(models):
        tier = "A_full_multimodel_forecast_verification"
    elif cases:
        tier = "B_partial_forecast_verification"
    elif truth_row.get("truth_known", 0):
        tier = "C_truth_event_learning"
    else:
        tier = "D_missing_truth"
    return {
        "role": ROLE[year],
        "tier": tier,
        "forecast_evaluable": bool(cases),
        "full_multimodel": bool(cases and CORE_MODELS.issubset(models)),
        "models": sorted(models),
    }


def rolling_origin(cases):
    folds = []
    for test_year in (2023, 2024, 2025, 2026):
        test_rows = [c for c in cases if year_of(c.get("valid_time")) == test_year]
        folds.append({
            "train_years": list(range(2020, test_year)),
            "test_year": test_year,
            "forecast_evaluable": bool(test_rows),
            "reason": None if test_rows else "no genuine issued-forecast cases available for this year",
            "metrics": metrics_for(test_rows),
        })
    return folds


def main():
    truth_by_year, source_inventory = truth_inventory()
    forecast_by_year = forecast_inventory()
    cases = load_cases()
    case_by_year = case_inventory(cases)

    years = {}
    for year in YEARS:
        key = str(year)
        years[key] = {
            "truth": truth_by_year[key],
            "forecast": forecast_by_year[key],
            "verification": case_by_year[key],
            "cohort": cohort(year, truth_by_year[key], forecast_by_year[key], case_by_year[key]),
        }

    result = {
        "schema": "prognozaepir-fog-vnext-historical-validation-v1",
        "generated_at": mv.iso(mv.utcnow()),
        "period": {"start": "2020-01-01T00:00:00Z", "end": mv.iso(mv.utcnow())},
        "policy": {
            "truth_primary": "METAR/SPECI",
            "synop_role": "teacher/fallback; never overrides available METAR/SPECI truth",
            "no_reanalysis_as_forecast": True,
            "probability_status": "shadow-unverified",
            "roles": {str(k): v for k, v in ROLE.items()},
            "single_run_archive_boundaries": {
                "ecmwf_ifs_hres": "2024-03-14",
                "dmi_knmi_icon_d2_and_most_others": "2026-04-02",
                "source": "Open-Meteo Single Runs API documentation",
            },
        },
        "source_inventory": source_inventory,
        "years": years,
        "rolling_origin": rolling_origin(cases),
        "overall_forecast_verification_cases": len(cases),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "schema": result["schema"],
        "cases": len(cases),
        "tiers": {year: row["cohort"]["tier"] for year, row in years.items()},
        "rolling_evaluable": [f["test_year"] for f in result["rolling_origin"] if f["forecast_evaluable"]],
    }, ensure_ascii=False))
    return result


if __name__ == "__main__":
    main()
