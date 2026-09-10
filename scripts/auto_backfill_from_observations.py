#!/usr/bin/env python3
"""Automatically acquire historical model runs and pressure-level context for observed EPIR days.

The user only needs to provide METAR/SYNOP history. This script discovers those
observation dates, adds the preceding model-run days needed for long-lead
verification, downloads missing archived operational runs from Open-Meteo
Single Runs, enriches those runs with 925/850/700/500 hPa context, and records
bounded retry state. Reanalysis is never substituted for an operational run.
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import backfill_model_history as bh
import enrich_synoptic_context as esc
import model_verification as mv

STATE = mv.LEARNING / "observation-history-autofill-state.json"
RUN_HOUR_UTC = 0
LOOKBACK_DAYS = 3
TARGET_MODELS = 8
MIN_USABLE_MODELS = 5
MAX_ATTEMPTS_PER_DAY = 4


def parse_archive_day(root: Path, path: Path):
    try:
        rel = path.relative_to(root)
        if len(rel.parts) < 3:
            return None
        y, m, d = rel.parts[-3], rel.parts[-2], Path(rel.parts[-1]).stem
        return date(int(y), int(m), int(d))
    except Exception:
        return None


def observation_days():
    days = set()
    for root in (mv.METAR_DIR, mv.SYNOP_DIR):
        if not root.exists():
            continue
        for path in root.rglob("*.jsonl"):
            d = parse_archive_day(root, path)
            if d:
                days.add(d)
    today = mv.utcnow().date()
    return {d for d in days if d < today}


def required_run_days(obs_days):
    out = set()
    for d in obs_days:
        for n in range(LOOKBACK_DAYS + 1):
            rd = d - timedelta(days=n)
            if rd < mv.utcnow().date():
                out.add(rd)
    return out


def load_state():
    try:
        raw = json.loads(STATE.read_text(encoding="utf-8"))
        return raw if raw.get("schema") == "prognozaepir-observation-history-autofill-v1" else {}
    except Exception:
        return {}


def archive_groups():
    groups = defaultdict(list)
    if not mv.FORECAST_DIR.exists():
        return groups
    for path in sorted(mv.FORECAST_DIR.rglob("*.jsonl")):
        for row in mv.load_jsonl(path):
            run = mv.parse_dt(row.get("run_time"))
            model = row.get("model")
            if not run or model not in mv.MODEL_META or run.hour != RUN_HOUR_UTC:
                continue
            groups[(run.date(), model)].append(row)
    return groups


def coverage_for_days(days):
    groups = archive_groups()
    out = {}
    for d in days:
        surface_models = set()
        context_models = set()
        for model, _name, _weight in mv.MODELS:
            rows = groups.get((d, model)) or []
            if not rows:
                continue
            surface_models.add(model)
            if all(esc.has_context(r) for r in rows):
                context_models.add(model)
        out[d] = {
            "surface_models": len(surface_models),
            "context_models": len(context_models),
            "surface_model_ids": sorted(surface_models),
            "context_model_ids": sorted(context_models),
        }
    return out


def day_complete(cov):
    surface = int(cov.get("surface_models") or 0)
    context = int(cov.get("context_models") or 0)
    return surface >= TARGET_MODELS and context >= min(surface, TARGET_MODELS)


def day_usable_after_retries(cov, attempts):
    return (
        attempts >= MAX_ATTEMPTS_PER_DAY
        and int(cov.get("surface_models") or 0) >= MIN_USABLE_MODELS
        and int(cov.get("context_models") or 0) >= MIN_USABLE_MODELS
    )


def select_days(required, state, max_days):
    coverage = coverage_for_days(required)
    history = state.get("days") or {}
    candidates = []
    for d in required:
        key = d.isoformat()
        attempts = int((history.get(key) or {}).get("attempts") or 0)
        cov = coverage.get(d) or {}
        if day_complete(cov) or day_usable_after_retries(cov, attempts):
            continue
        if attempts >= MAX_ATTEMPTS_PER_DAY:
            continue
        candidates.append((attempts, d))
    # Newly discovered/recent observation periods are handled first; retries
    # are spread behind first-attempt days so a stubborn provider gap cannot
    # block a newly imported month.
    candidates.sort(key=lambda x: (x[0], -x[1].toordinal()))
    return [d for _attempts, d in candidates[:max(0, max_days)]], coverage


def existing_run_pairs():
    pairs = set()
    if not mv.FORECAST_DIR.exists():
        return pairs
    for path in mv.FORECAST_DIR.rglob("*.jsonl"):
        for row in mv.load_jsonl(path):
            run = mv.parse_dt(row.get("run_time"))
            model = row.get("model")
            if run and model in mv.MODEL_META and run.hour == RUN_HOUR_UTC:
                pairs.add((run.date(), model))
    return pairs


def backfill_surface(days, workers):
    existing = existing_run_pairs()
    tasks = []
    for d in days:
        for model, name, weight in mv.MODELS:
            if (d, model) not in existing:
                tasks.append((model, name, weight, d, RUN_HOUR_UTC))

    by_month = defaultdict(list)
    success = 0
    failures = []
    with ThreadPoolExecutor(max_workers=max(1, min(workers, 4))) as pool:
        futs = {pool.submit(bh.fetch_run, *task): task for task in tasks}
        for fut in as_completed(futs):
            model, _name, _weight, d, _hour = futs[fut]
            try:
                rows, _degraded = fut.result()
                by_month[d.strftime("%Y-%m")].extend(rows)
                success += 1
            except Exception as exc:
                failures.append([d.isoformat(), model, str(exc)])

    written = {}
    for month, rows in sorted(by_month.items()):
        path, count = bh.write_month(month, rows)
        written[str(path.relative_to(mv.ROOT))] = count
    return {"requested_runs": len(tasks), "recovered_runs": success, "failures": failures[:100], "written": written}


def enrich_context(days, workers):
    files = esc.load_files()
    now = mv.utcnow()
    selected_days = set(days)
    pending = [
        item for item in esc.candidate_runs(files, now)
        if item[0].date() in selected_days and item[0].hour == RUN_HOUR_UTC
    ]
    changed = set()
    success = 0
    failures = []
    unsupported_total = defaultdict(int)

    with ThreadPoolExecutor(max_workers=max(1, min(workers, 3))) as pool:
        futs = {pool.submit(esc.fetch_one, run, model): (run, model, refs) for run, model, refs in pending}
        for fut in as_completed(futs):
            run, model, refs = futs[fut]
            try:
                context, unsupported = fut.result()
                for var in unsupported:
                    unsupported_total[var] += 1
                updated = 0
                for path, idx, row in refs:
                    ctx = context.get(row.get("valid_time"))
                    if not ctx:
                        continue
                    new = dict(row)
                    new.update(ctx)
                    new["synoptic_context_version"] = esc.sr.VERSION
                    new["synoptic_context_source"] = "open-meteo-single-runs"
                    files[path][idx] = new
                    changed.add(path)
                    updated += 1
                if updated:
                    success += 1
                else:
                    failures.append([mv.iso(run), model, "no matching valid times"])
            except Exception as exc:
                failures.append([mv.iso(run), model, str(exc)])

    for path in changed:
        esc.write_jsonl(path, files[path])

    return {
        "requested_runs": len(pending),
        "enriched_runs": success,
        "failures": failures[:100],
        "unsupported_variables": dict(sorted(unsupported_total.items())),
        "changed_files": [str(p.relative_to(mv.ROOT)) for p in sorted(changed)],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-days", type=int, default=2, help="maximum model-run days processed per invocation")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()

    obs = observation_days()
    required = required_run_days(obs)
    previous = load_state()
    selected, before = select_days(required, previous, args.max_days)

    if not selected:
        print(json.dumps({
            "status": "no-work",
            "observation_days": len(obs),
            "required_run_days": len(required),
            "message": "All eligible historical observation days are already covered or have reached bounded retry state.",
        }, ensure_ascii=False))
        return

    surface = backfill_surface(selected, args.workers)
    profile = enrich_context(selected, args.workers)
    after = coverage_for_days(required)

    old_days = dict(previous.get("days") or {})
    now_s = mv.iso(mv.utcnow())
    for d in selected:
        key = d.isoformat()
        old = dict(old_days.get(key) or {})
        attempts = int(old.get("attempts") or 0) + 1
        cov = after.get(d) or {}
        if day_complete(cov):
            status = "complete"
        elif day_usable_after_retries(cov, attempts):
            status = "usable-degraded"
        elif attempts >= MAX_ATTEMPTS_PER_DAY:
            status = "exhausted"
        else:
            status = "pending"
        old_days[key] = {
            "attempts": attempts,
            "last_attempt_utc": now_s,
            "status": status,
            "surface_models": int(cov.get("surface_models") or 0),
            "context_models": int(cov.get("context_models") or 0),
        }

    pending_days = []
    for d in sorted(required):
        key = d.isoformat()
        attempts = int((old_days.get(key) or {}).get("attempts") or 0)
        cov = after.get(d) or {}
        if not day_complete(cov) and not day_usable_after_retries(cov, attempts) and attempts < MAX_ATTEMPTS_PER_DAY:
            pending_days.append(key)

    report = {
        "schema": "prognozaepir-observation-history-autofill-v1",
        "generated_at_utc": now_s,
        "source_policy": "User supplies METAR/SYNOP only; model runs and 925/850/700/500 hPa fields are fetched automatically from Open-Meteo Single Runs. No reanalysis substitution.",
        "run_hour_utc": RUN_HOUR_UTC,
        "lookback_days": LOOKBACK_DAYS,
        "target_models_per_run_day": TARGET_MODELS,
        "minimum_usable_models": MIN_USABLE_MODELS,
        "max_attempts_per_day": MAX_ATTEMPTS_PER_DAY,
        "observation_days": len(obs),
        "required_run_days": len(required),
        "selected_run_days": [d.isoformat() for d in selected],
        "surface_backfill": surface,
        "pressure_level_enrichment": profile,
        "remaining_pending_days": len(pending_days),
        "next_pending_days": pending_days[:20],
        "days": old_days,
    }
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "status": "processed",
        "selected_run_days": report["selected_run_days"],
        "surface_recovered": surface["recovered_runs"],
        "profiles_enriched": profile["enriched_runs"],
        "remaining_pending_days": report["remaining_pending_days"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
