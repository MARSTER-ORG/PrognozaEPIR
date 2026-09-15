#!/usr/bin/env python3
"""Backfill genuine historical forecast runs for Fog Engine vNext.

Policy:
- no reanalysis and no stitched analysis is accepted as a forecast run;
- ECMWF IFS individual runs may be used from 2024-03-14 onward;
- DMI/KNMI/ICON-D2 individual runs are intentionally not requested before
  2026-04-02 because the current Single Runs archive does not contain them;
- 2020-2023 therefore remain truth/event-learning years unless another genuine
  issued-forecast archive is added later.

The historical ECMWF path probes only the real 00/06/12/18 UTC synoptic cycles
instead of walking hour-by-hour.  This keeps archive CI bounded and preserves
the rule that the selected forecast run must not be newer than the simulated
forecast issuance time (batch).
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone

import fog_vnext_event_backfill as events_mod
import fog_vnext_model_archive as archive
import model_verification as mv

STATE_PATH = mv.LEARNING / "fog-vnext-historical-backfill-state.json"
ECMWF_AVAILABLE_FROM = datetime(2024, 3, 14, tzinfo=timezone.utc)
OTHER_SINGLE_RUNS_AVAILABLE_FROM = datetime(2026, 4, 2, tzinfo=timezone.utc)
LEADS = (3, 12, 30)
ECMWF_CYCLE_HOURS = (0, 6, 12, 18)


def read_state():
    if not STATE_PATH.exists():
        return {"schema": "prognozaepir-fog-vnext-historical-backfill-v1", "batches": {}}
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            data.setdefault("batches", {})
            return data
    except Exception:
        pass
    return {"schema": "prognozaepir-fog-vnext-historical-backfill-v1", "batches": {}}


def write_state(state):
    state["updated_at"] = mv.iso(mv.utcnow())
    state["source_policy"] = {
        "ecmwf_ifs_single_runs_from": mv.iso(ECMWF_AVAILABLE_FROM),
        "dmi_knmi_icon_d2_single_runs_from": mv.iso(OTHER_SINGLE_RUNS_AVAILABLE_FROM),
        "ecmwf_synoptic_cycles_utc": list(ECMWF_CYCLE_HOURS),
        "no_reanalysis": True,
    }
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def archived_batches_ecmwf():
    """Load the archive index once instead of rescanning files per event."""
    found = set()
    if not archive.FULL_DIR.exists():
        return found
    for path in archive.FULL_DIR.glob("*.jsonl"):
        for row in mv.load_jsonl(path):
            if row.get("model") == "ecmwf_ifs" and row.get("archive_time"):
                found.add(row["archive_time"])
    return found


def candidate_batches(years, state):
    rows, _inventory = events_mod.load_observation_rows()
    events = events_mod.build_events(events_mod.points_from_rows(rows))
    archived = archived_batches_ecmwf()
    out = []
    seen = set()
    for event in events:
        if event.start.year not in years or not event.fog:
            continue
        for lead in LEADS:
            batch = (event.start - timedelta(hours=lead)).replace(minute=0, second=0, microsecond=0)
            if batch < ECMWF_AVAILABLE_FROM or batch >= mv.utcnow():
                continue
            key = mv.iso(batch)
            prior = state["batches"].get(key) or {}
            if key in seen or prior.get("ok") or key in archived:
                continue
            seen.add(key)
            out.append((lead, -event.start.timestamp(), event, batch))
    # 3 h first, then recent events; later invocations naturally expand coverage.
    out.sort(key=lambda x: (x[0], x[1]))
    return out


def cycle_at_or_before(batch):
    hour = max(h for h in ECMWF_CYCLE_HOURS if h <= batch.hour)
    return batch.replace(hour=hour, minute=0, second=0, microsecond=0)


def latest_ecmwf_run(batch):
    """Find the latest usable ECMWF synoptic cycle not newer than batch."""
    errors = []
    first = cycle_at_or_before(batch)
    # Two previous cycles provide a 12 h fallback, matching the generic
    # archive policy without issuing thirteen hourly probes.
    for cycles_back in range(3):
        run = first - timedelta(hours=6 * cycles_back)
        if run < ECMWF_AVAILABLE_FROM:
            continue
        try:
            if not archive.probe_run("ecmwf_ifs", run):
                errors.append(f"{run:%Y-%m-%d %H}Z empty")
                continue
            variables, data = archive.fetch_run_bundle("ecmwf_ifs", run)
            return run, variables, data
        except Exception as exc:
            errors.append(f"{run:%Y-%m-%d %H}Z {type(exc).__name__}: {exc}")
    raise RuntimeError(f"no archived ECMWF synoptic run at/before {mv.iso(batch)}: {'; '.join(errors[-3:])}")


def archive_ecmwf(batch):
    model = "ecmwf_ifs"
    name, base_weight = archive.base_meta(model)
    model_run, variables, data = latest_ecmwf_run(batch)
    rows = archive.rows_from(model, model_run, batch, data)
    for row in rows:
        row["name"] = name
        row["base_weight"] = base_weight
        row["archive_variable_count"] = len(variables)
        row["archive_source"] = "open-meteo-single-runs"
        row["historical_backfill"] = True
    full_path = archive.FULL_DIR / f"{batch:%Y-%m-%d}.jsonl"
    pair_path = mv.FORECAST_DIR / f"fog-vnext-{batch:%Y-%m-%d}.jsonl"
    full_n = archive.merge_write(full_path, rows, ("archive_time", "model", "model_run_time", "valid_time"))
    pair_n = archive.merge_write(pair_path, archive.representative_rows(rows), ("run_time", "model", "valid_time"))
    return {
        "ok": bool(rows),
        "model": model,
        "model_run_time": mv.iso(model_run),
        "variables": len(variables),
        "hours": len(rows),
        "full_rows_after_merge": full_n,
        "paired_rows_after_merge": pair_n,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", default="2024,2025")
    ap.add_argument("--max-batches", type=int, default=4)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    years = {int(x) for x in args.years.split(",") if x.strip()}
    state = read_state()
    candidates = candidate_batches(years, state)
    selected = candidates[: max(0, args.max_batches)]
    print(json.dumps({
        "years": sorted(years),
        "candidate_batches": len(candidates),
        "selected": [
            {"event_id": e.event_id, "event_start": mv.iso(e.start), "lead_target_h": lead, "batch": mv.iso(batch)}
            for lead, _neg, e, batch in selected
        ],
    }, ensure_ascii=False))
    if args.dry_run:
        return

    for lead, _neg, event, batch in selected:
        key = mv.iso(batch)
        rec = {
            "event_id": event.event_id,
            "event_start": mv.iso(event.start),
            "event_end": mv.iso(event.end),
            "lead_target_h": lead,
            "attempted_at": mv.iso(mv.utcnow()),
        }
        try:
            rec.update(archive_ecmwf(batch))
        except Exception as exc:
            rec.update({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        state["batches"][key] = rec
        write_state(state)
        print(json.dumps({"batch": key, **rec}, ensure_ascii=False))
    write_state(state)


if __name__ == "__main__":
    main()
