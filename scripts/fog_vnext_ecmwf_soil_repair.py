#!/usr/bin/env python3
"""Repair actual ECMWF 0-7 cm soil moisture in already archived issued runs.

This is not a reanalysis/backcast. The script only revisits ECMWF Single Runs
that are already present in the no-lookahead archive and requests one physical
field from the exact same model initialisation time. It patches matching valid
hours in both full and representative forecast archives.
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

import fog_vnext_model_archive as archive
import model_verification as mv

FIELD = "soil_moisture_0_to_7cm"


def finite(v):
    return mv.finite(v)


def load(path: Path):
    return mv.load_jsonl(path)


def write(path: Path, rows):
    path.write_text(
        "".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in rows),
        encoding="utf-8",
    )


def target_groups():
    groups = defaultdict(list)
    for path in sorted(archive.FULL_DIR.glob("*.jsonl")):
        for row in load(path):
            if row.get("model") != "ecmwf_ifs":
                continue
            if finite(row.get(FIELD)):
                continue
            run = row.get("model_run_time")
            batch = row.get("archive_time") or row.get("run_time")
            if not run or not batch:
                continue
            groups[(batch, run)].append((path, row.get("valid_time")))
    return groups


def fetch_values(run_s):
    run = mv.parse_dt(run_s)
    if not run:
        raise RuntimeError(f"invalid model_run_time: {run_s}")
    data = archive.request_run("ecmwf_ifs", run, (FIELD,), forecast_hours=72)
    hourly = data.get("hourly") or {}
    times = hourly.get("time") or []
    values = hourly.get(FIELD) or []
    out = {}
    for i, ts in enumerate(times):
        valid = mv.parse_dt(ts)
        if valid and i < len(values) and finite(values[i]):
            out[mv.iso(valid)] = float(values[i])
    if not out:
        raise RuntimeError(f"ECMWF run {run_s} returned no {FIELD}")
    return out


def patch_file(path: Path, value_maps):
    rows = load(path)
    changed = 0
    for row in rows:
        if row.get("model") != "ecmwf_ifs" or finite(row.get(FIELD)):
            continue
        key = (row.get("archive_time") or row.get("run_time"), row.get("model_run_time"))
        values = value_maps.get(key)
        value = values.get(row.get("valid_time")) if values else None
        if finite(value):
            row[FIELD] = float(value)
            row["ecmwf_soil_repair"] = True
            changed += 1
    if changed:
        write(path, rows)
    return changed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-batches", type=int, default=8)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    groups = target_groups()
    selected = sorted(groups)[: max(0, args.max_batches)]
    print(json.dumps({
        "schema": "prognozaepir-fog-vnext-ecmwf-soil-repair-v1",
        "missing_soil_batches": len(groups),
        "selected": [{"archive_time": b, "model_run_time": r, "rows": len(groups[(b, r)])} for b, r in selected],
        "field": FIELD,
        "source": "same-issued-ecmwf-single-run",
        "no_reanalysis": True,
    }, ensure_ascii=False))
    if args.dry_run or not selected:
        return

    value_maps = {}
    errors = []
    for key in selected:
        try:
            value_maps[key] = fetch_values(key[1])
        except Exception as exc:
            errors.append({"archive_time": key[0], "model_run_time": key[1], "error": f"{type(exc).__name__}: {exc}"})

    selected_set = set(selected)
    full_changed = 0
    for path in sorted(archive.FULL_DIR.glob("*.jsonl")):
        # Skip files unrelated to selected batches to keep writes minimal.
        rows = load(path)
        if not any(
            r.get("model") == "ecmwf_ifs" and
            (r.get("archive_time") or r.get("run_time"), r.get("model_run_time")) in selected_set
            for r in rows
        ):
            continue
        full_changed += patch_file(path, value_maps)

    pair_changed = 0
    if mv.FORECAST_DIR.exists():
        for path in sorted(mv.FORECAST_DIR.glob("fog-vnext-*.jsonl")):
            rows = load(path)
            if not any(
                r.get("model") == "ecmwf_ifs" and
                (r.get("archive_time") or r.get("run_time"), r.get("model_run_time")) in selected_set
                for r in rows
            ):
                continue
            pair_changed += patch_file(path, value_maps)

    repaired_batches = sum(1 for key in selected if key in value_maps)
    report = {
        "selected_batches": len(selected),
        "repaired_batches": repaired_batches,
        "full_rows_repaired": full_changed,
        "paired_rows_repaired": pair_changed,
        "errors": errors,
    }
    print(json.dumps(report, ensure_ascii=False))
    if selected and repaired_batches == 0:
        raise RuntimeError(f"no historical ECMWF batch could be repaired with {FIELD}: {errors}")
    if full_changed == 0:
        raise RuntimeError("ECMWF soil query succeeded but no full archive rows were patched")


if __name__ == "__main__":
    main()
