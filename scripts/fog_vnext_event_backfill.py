#!/usr/bin/env python3
"""Event-stratified historical backfill for Fog Engine vNext.

The selector uses the canonical EPIR historical training archive when it is
present under ``data/import/epir-history`` and supplements it with the rolling
METAR/SPECI repository archive. For 2020-2024 the corrected package's
``fog_events_censored_2020_2024.csv`` supplies authoritative event boundaries
and censoring flags. Newer 2025-2026 events are reconstructed from the rolling
observation timeline.

The canonical 2020-2024 package remains the source of truth for historical
``fog_truth`` labels, including UNKNOWN handling for night AUTO reports without
visibility. Raw annual ZIP files in the same directory are retained as the
audit source and are not reparsed here.

The script is resumable: successful/attempted batches are written to
``data/learning/fog-vnext-backfill-state.json``. It deliberately limits the
number of batches per invocation so scheduled CI can accumulate a balanced
history without hammering the Single Runs API.
"""
from __future__ import annotations

import argparse
import io
import json
import zipfile
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import build_fog_event_learning_v2 as truth
import fog_vnext_censored_events as censored
import fog_vnext_model_archive as archive
import model_verification as mv

ROOT = Path(__file__).resolve().parents[1]
HISTORY_DIR = ROOT / "data" / "import" / "epir-history"
HISTORY_ARCHIVE = HISTORY_DIR / "fog_training_2020_2024_corrected_v2.zip"
HISTORY_OBS_BASENAME = "aviation_observations_2020_2024.jsonl"

STATE_PATH = mv.LEARNING / "fog-vnext-backfill-state.json"
LEAD_TARGETS_H = (3, 12, 30)
MAX_EVENT_GAP = timedelta(hours=2)


@dataclass
class Event:
    event_id: str
    start: datetime
    end: datetime
    first_state: str
    fog: bool
    mifg: bool
    br: bool
    obs_count: int
    left_censored_onset: bool = False
    right_censored_end: bool = False
    canonical_boundary: bool = False

    @property
    def priority(self):
        if self.fog:
            return 0
        if self.mifg:
            return 1
        return 2

    @property
    def exact_onset(self):
        return not self.left_censored_onset


def _bool_or_none(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        v = value.strip().lower()
        if v in {"1", "true", "yes", "y"}:
            return True
        if v in {"0", "false", "no", "n"}:
            return False
    return None


def _obs_dt(row):
    for key in ("obs_time", "time", "timestamp", "datetime", "valid_time"):
        dt = mv.parse_dt(row.get(key))
        if dt:
            return dt
    return None


def _normalize_history_row(row):
    row = dict(row)
    if not row.get("obs_time"):
        for key in ("time", "timestamp", "datetime", "valid_time"):
            if row.get(key):
                row["obs_time"] = row[key]
                break
    if not row.get("raw") and row.get("canonical_raw"):
        row["raw"] = row["canonical_raw"]
    row["_fog_vnext_history_source"] = "epir-history-2020-2024-v2"
    return row


def load_historical_training_rows(path=HISTORY_ARCHIVE):
    """Load canonical 2020-2024 aviation observations directly from the v2 ZIP."""
    path = Path(path)
    if not path.exists():
        return []

    try:
        with zipfile.ZipFile(path) as zf:
            member = next(
                (name for name in zf.namelist() if Path(name).name == HISTORY_OBS_BASENAME),
                None,
            )
            if not member:
                raise RuntimeError(f"{path} does not contain {HISTORY_OBS_BASENAME}")
            rows = []
            with zf.open(member, "r") as raw:
                with io.TextIOWrapper(raw, encoding="utf-8-sig") as text:
                    for lineno, line in enumerate(text, 1):
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            row = json.loads(line)
                        except json.JSONDecodeError as exc:
                            raise RuntimeError(
                                f"invalid JSON in {path}:{member}:{lineno}: {exc}"
                            ) from exc
                        if isinstance(row, dict):
                            rows.append(_normalize_history_row(row))
            return rows
    except zipfile.BadZipFile as exc:
        raise RuntimeError(f"invalid historical training archive: {path}") from exc


def load_repository_rows():
    rows = mv.unique_rows(
        mv.all_jsonl(mv.METAR_DIR) + mv.all_jsonl(mv.SPECI_DIR),
        ("obs_time", "raw"),
    )
    out = []
    for row in rows:
        row = dict(row)
        row["_fog_vnext_history_source"] = "rolling-repository"
        out.append(row)
    return out


def load_observation_rows():
    historical = load_historical_training_rows()
    rolling = load_repository_rows()

    # Prefer the canonical corrected historical row if the same observation is
    # also present in the rolling repository archive.
    dedup = {}
    for row in rolling + historical:
        dt = _obs_dt(row)
        if not dt:
            continue
        raw = str(row.get("canonical_raw") or row.get("raw") or "")
        key = (mv.iso(dt), raw)
        dedup[key] = row

    rows = list(dedup.values())
    inventory = {
        "historical_archive": str(HISTORY_ARCHIVE.relative_to(ROOT)),
        "historical_archive_present": HISTORY_ARCHIVE.exists(),
        "historical_rows": len(historical),
        "rolling_rows": len(rolling),
        "deduplicated_rows": len(rows),
    }
    return rows, inventory


def points_from_rows(rows):
    out = []
    for row in rows:
        dt = _obs_dt(row)
        if not dt:
            continue

        cls = truth.classify(row)
        canonical_fog = _bool_or_none(row.get("fog_truth"))
        fog = cls["fog"] if canonical_fog is None else canonical_fog

        vis = row.get("visibility_m")
        known_vis = mv.finite(vis)
        br_vis = known_vis and 1000 <= float(vis) <= 5000 and not fog

        if fog:
            state = "FG"
        elif cls["mifg"]:
            state = "MIFG"
        elif cls["br"] or br_vis:
            state = "BR"
        elif known_vis and float(vis) > 5000:
            state = "CLEAR"
        else:
            state = "UNKNOWN"

        out.append((dt, row, state))
    return sorted(out, key=lambda x: x[0])


def load_obs():
    rows, _inventory = load_observation_rows()
    return points_from_rows(rows)


def build_events(points):
    events = []
    current = []
    for dt, row, state in points:
        obscured = state in {"FG", "MIFG", "BR"}
        if not obscured:
            if current and dt - current[-1][0] > MAX_EVENT_GAP:
                events.append(finalize_event(current))
                current = []
            elif current and state == "CLEAR":
                events.append(finalize_event(current))
                current = []
            continue
        if current and dt - current[-1][0] > MAX_EVENT_GAP:
            events.append(finalize_event(current))
            current = []
        current.append((dt, row, state))
    if current:
        events.append(finalize_event(current))
    return events


def finalize_event(points):
    start = points[0][0]
    end = points[-1][0]
    states = [x[2] for x in points]
    return Event(
        event_id=f"{start:%Y%m%dT%H%MZ}-{end:%H%MZ}",
        start=start,
        end=end,
        first_state=states[0],
        fog="FG" in states,
        mifg="MIFG" in states,
        br="BR" in states,
        obs_count=len(points),
    )


def canonical_events_from_points(points, path=HISTORY_ARCHIVE):
    """Create Event objects using authoritative 2020-2024 CSV boundaries."""
    bounds, schema = censored.load(path)
    if not bounds:
        return [], None
    historical = [p for p in points if 2020 <= p[0].year <= 2024]
    events = []
    for bound in bounds:
        inside = [p for p in historical if bound["start"] <= p[0] <= bound["end"]]
        obscured = [p for p in inside if p[2] in {"FG", "MIFG", "BR"}]
        if not obscured:
            raise RuntimeError(
                f"canonical event {bound['event_id']} {mv.iso(bound['start'])}..{mv.iso(bound['end'])} "
                "does not overlap an obscured canonical observation"
            )
        states = [p[2] for p in obscured]
        events.append(Event(
            event_id=bound["event_id"],
            start=bound["start"],
            end=bound["end"],
            first_state=states[0],
            fog="FG" in states,
            mifg="MIFG" in states,
            br="BR" in states,
            obs_count=len(inside) if inside else len(obscured),
            left_censored_onset=bool(bound["left_censored"]),
            right_censored_end=bool(bound["right_censored"]),
            canonical_boundary=True,
        ))
    return events, schema


def _overlaps(a, b):
    return a.start <= b.end and b.start <= a.end


def build_canonical_aware_events(points, path=HISTORY_ARCHIVE):
    """Canonical boundaries override reconstructed 2020-2024 events.

    If the canonical table contains only a subset of obscuration episodes,
    reconstructed historical events that do not overlap any canonical boundary
    are retained. This prevents losing BR/MIFG-only episodes while ensuring all
    canonical events keep their exact censor metadata.
    """
    reconstructed = build_events(points)
    canonical, schema = canonical_events_from_points(points, path)
    if not canonical:
        return reconstructed, {
            "canonical_event_rows": 0,
            "left_censored_events": 0,
            "right_censored_events": 0,
            "canonical_headers": None,
        }

    kept = []
    for event in reconstructed:
        if event.start.year >= 2025:
            kept.append(event)
            continue
        if event.end.year < 2020:
            kept.append(event)
            continue
        if any(_overlaps(event, c) for c in canonical):
            continue
        kept.append(event)

    events = sorted(canonical + kept, key=lambda e: e.start)
    audit = {
        "canonical_event_rows": len(canonical),
        "left_censored_events": sum(1 for e in canonical if e.left_censored_onset),
        "right_censored_events": sum(1 for e in canonical if e.right_censored_end),
        "canonical_headers": schema.get("headers") if schema else None,
        "canonical_start_field": schema.get("start") if schema else None,
        "canonical_end_field": schema.get("end") if schema else None,
        "canonical_left_censor_field": schema.get("left_censored") if schema else None,
        "canonical_right_censor_field": schema.get("right_censored") if schema else None,
    }
    return events, audit


def load_events():
    rows, source_inventory = load_observation_rows()
    points = points_from_rows(rows)
    events, event_audit = build_canonical_aware_events(points)
    return events, points, {**source_inventory, **event_audit}


def read_state():
    if not STATE_PATH.exists():
        return {"schema": "prognozaepir-fog-vnext-backfill-state-v1", "batches": {}, "events": {}}
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            data.setdefault("batches", {})
            data.setdefault("events", {})
            return data
    except Exception:
        pass
    return {"schema": "prognozaepir-fog-vnext-backfill-state-v1", "batches": {}, "events": {}}


def write_state(state):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    state["updated_at"] = mv.iso(mv.utcnow())
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def batch_key(dt):
    return mv.iso(dt.replace(minute=0, second=0, microsecond=0))


def archived_batch_keys():
    keys = set()
    if archive.FULL_DIR.exists():
        for p in archive.FULL_DIR.glob("*.jsonl"):
            for row in mv.load_jsonl(p):
                if row.get("archive_time"):
                    keys.add(row["archive_time"])
    return keys


def candidate_batches(events, already, state, max_events=None):
    now = mv.utcnow().replace(minute=0, second=0, microsecond=0)
    candidates = []
    ordered = sorted(events, key=lambda e: (e.priority, -e.start.timestamp()))
    if max_events:
        ordered = ordered[:max_events]
    for e in ordered:
        state["events"][e.event_id] = {
            **asdict(e),
            "start": mv.iso(e.start),
            "end": mv.iso(e.end),
            "exact_onset": e.exact_onset,
        }
        for lead in LEAD_TARGETS_H:
            batch = (e.start - timedelta(hours=lead)).replace(minute=0, second=0, microsecond=0)
            key = batch_key(batch)
            if batch >= now or key in already:
                continue
            prior = state["batches"].get(key) or {}
            if prior.get("ok"):
                continue
            candidates.append((e.priority, e.start, lead, e, batch))
    candidates.sort(key=lambda x: (x[2], x[0], -x[1].timestamp()))
    return candidates


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-batches", type=int, default=6)
    ap.add_argument("--max-events", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    events, points, source_inventory = load_events()
    state = read_state()
    already = archived_batch_keys()
    candidates = candidate_batches(events, already, state, args.max_events or None)

    inventory = {
        **source_inventory,
        "observations": len(points),
        "events": len(events),
        "fog_events": sum(1 for e in events if e.fog),
        "mifg_events": sum(1 for e in events if e.mifg),
        "br_events": sum(1 for e in events if e.br),
        "candidate_batches": len(candidates),
    }
    print(json.dumps({"inventory": inventory}, ensure_ascii=False))

    selected = candidates[: max(0, args.max_batches)]
    if args.dry_run:
        print(json.dumps({
            "selected": [
                {
                    "event_id": e.event_id,
                    "event_start": mv.iso(e.start),
                    "lead_target_h": lead,
                    "batch": mv.iso(batch),
                    "left_censored_onset": e.left_censored_onset,
                    "exact_onset": e.exact_onset,
                }
                for _p, _s, lead, e, batch in selected
            ]
        }, ensure_ascii=False, indent=2))
        return

    for _p, _s, lead, e, batch in selected:
        key = batch_key(batch)
        record = {
            "event_id": e.event_id,
            "event_start": mv.iso(e.start),
            "event_end": mv.iso(e.end),
            "event_has_fog": e.fog,
            "event_has_mifg": e.mifg,
            "event_has_br": e.br,
            "left_censored_onset": e.left_censored_onset,
            "right_censored_end": e.right_censored_end,
            "exact_onset": e.exact_onset,
            "lead_target_h": lead,
            "attempted_at": mv.iso(mv.utcnow()),
        }
        try:
            status = archive.archive(batch)
            ok_models = [m for m, s in status.items() if s.get("ok")]
            record.update({"ok": len(ok_models) >= 2, "ok_models": ok_models, "models": status})
        except Exception as exc:
            record.update({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        state["batches"][key] = record
        write_state(state)
        print(json.dumps({"batch": key, **record}, ensure_ascii=False))

    write_state(state)


if __name__ == "__main__":
    main()
