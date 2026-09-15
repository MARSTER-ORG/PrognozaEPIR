#!/usr/bin/env python3
"""Event-stratified historical backfill for Fog Engine vNext.

The selector scans real EPIR METAR/SPECI observations already archived in the
repository, groups BR/MIFG/FG-family observations into independent events and
requests explicit historical model runs before those events. This avoids random
hour sampling and preserves the no-lookahead rule.

The script is resumable: successful/attempted batches are written to
`data/learning/fog-vnext-backfill-state.json`. It deliberately limits the number
of batches per invocation so scheduled CI can accumulate a balanced history
without hammering the Single Runs API.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import build_fog_event_learning_v2 as truth
import fog_vnext_model_archive as archive
import model_verification as mv

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

    @property
    def priority(self):
        if self.fog:
            return 0
        if self.mifg:
            return 1
        return 2


def load_obs():
    rows = mv.unique_rows(
        mv.all_jsonl(mv.METAR_DIR) + mv.all_jsonl(mv.SPECI_DIR),
        ("obs_time", "raw"),
    )
    out = []
    for row in rows:
        dt = mv.parse_dt(row.get("obs_time"))
        if not dt:
            continue
        cls = truth.classify(row)
        vis = row.get("visibility_m")
        known_vis = mv.finite(vis)
        br_vis = known_vis and 1000 <= float(vis) <= 5000 and not cls["fog"]
        if cls["fog"]:
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
        # Keep class priority, but cap events rather than individual lead batches.
        ordered = ordered[:max_events]
    for e in ordered:
        state["events"][e.event_id] = {
            **asdict(e),
            "start": mv.iso(e.start),
            "end": mv.iso(e.end),
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
    # Interleave events before taking additional lead-times from the same event.
    candidates.sort(key=lambda x: (x[2], x[0], -x[1].timestamp()))
    return candidates


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-batches", type=int, default=6)
    ap.add_argument("--max-events", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    points = load_obs()
    events = build_events(points)
    state = read_state()
    already = archived_batch_keys()
    candidates = candidate_batches(events, already, state, args.max_events or None)

    inventory = {
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
                {"event_id": e.event_id, "event_start": mv.iso(e.start), "lead_target_h": lead, "batch": mv.iso(batch)}
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
