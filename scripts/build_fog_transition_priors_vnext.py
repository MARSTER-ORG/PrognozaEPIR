#!/usr/bin/env python3
"""Build observation-only transition priors for Fog Engine vNext.

This learner uses the canonical EPIR 2020-2024 METAR/SPECI truth archive only
for state-transition priors. It does NOT infer SSOIL/PBL/Tsurface from
observations and therefore must not be used to calibrate physical predictor
weights.

Censoring rule: a transition is counted only when both the current and next
hour have a known state. An event that first appears as FG after a missing or
UNKNOWN hour is therefore not treated as a known one-hour onset.
"""
from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import fog_vnext_event_backfill as history
import model_verification as mv

OUT = mv.LEARNING / "fog-transition-priors-vnext.json"
KNOWN = {"FG", "MIFG", "BR", "CLEAR"}
PRIOR_STRENGTH = 20.0


def hourly_states(points):
    """Collapse multiple METAR/SPECI reports to one conservative hourly state."""
    priority = {"UNKNOWN": 0, "CLEAR": 1, "BR": 2, "MIFG": 3, "FG": 4}
    grouped = {}
    for dt, _row, state in points:
        hour = dt.replace(minute=0, second=0, microsecond=0)
        prev = grouped.get(hour)
        if prev is None or priority.get(state, 0) > priority.get(prev, 0):
            grouped[hour] = state
    return grouped


def smoothed(success, total, global_rate):
    if total <= 0:
        return None
    prior_p = global_rate if global_rate is not None else 0.0
    return (success + PRIOR_STRENGTH * prior_p) / (total + PRIOR_STRENGTH)


def transition_rows(states):
    out = []
    for dt in sorted(states):
        nxt_dt = dt + mv.timedelta(hours=1) if hasattr(mv, "timedelta") else None
        if nxt_dt is None:
            from datetime import timedelta
            nxt_dt = dt + timedelta(hours=1)
        a = states.get(dt)
        b = states.get(nxt_dt)
        if a not in KNOWN or b not in KNOWN:
            continue
        out.append((dt, a, b))
    return out


def build(points):
    states = hourly_states(points)
    transitions = transition_rows(states)

    pair_counts = Counter((a, b) for _dt, a, b in transitions)
    source_counts = Counter(a for _dt, a, _b in transitions)

    def rate(source, target):
        n = source_counts[source]
        return (pair_counts[(source, target)] / n) if n else None

    global_onset_num = sum(1 for _dt, a, b in transitions if a != "FG" and b == "FG")
    global_onset_den = sum(1 for _dt, a, _b in transitions if a != "FG")
    global_onset = global_onset_num / global_onset_den if global_onset_den else None

    global_exit_num = sum(1 for _dt, a, b in transitions if a == "FG" and b != "FG")
    global_exit_den = sum(1 for _dt, a, _b in transitions if a == "FG")
    global_exit = global_exit_num / global_exit_den if global_exit_den else None

    onset_cells = defaultdict(lambda: [0, 0])
    exit_cells = defaultdict(lambda: [0, 0])
    for dt, a, b in transitions:
        if a != "FG":
            for key in (("hour", dt.hour, a), ("month", dt.month, a)):
                onset_cells[key][1] += 1
                if b == "FG":
                    onset_cells[key][0] += 1
        if a == "FG":
            for key in (("hour", dt.hour, "FG"), ("month", dt.month, "FG")):
                exit_cells[key][1] += 1
                if b != "FG":
                    exit_cells[key][0] += 1

    def serialize(cells, global_rate):
        out = []
        for (dimension, value, state), (yes, total) in sorted(cells.items(), key=lambda x: (x[0][0], x[0][1], x[0][2])):
            out.append({
                "dimension": dimension,
                "value": value,
                "from_state": state,
                "positive": yes,
                "total": total,
                "raw_rate": round(yes / total, 6) if total else None,
                "shrunk_rate": round(smoothed(yes, total, global_rate), 6) if total else None,
            })
        return out

    return {
        "schema": "prognozaepir-fog-transition-priors-v1",
        "source": "canonical EPIR METAR/SPECI truth 2020-2024",
        "role": "observation-only transition prior; never calibrates SSOIL/PBL/Tsurface weights",
        "censoring_policy": "count only adjacent known hourly states; missing/UNKNOWN predecessor does not define onset",
        "hourly_known_states": sum(1 for s in states.values() if s in KNOWN),
        "adjacent_known_transitions": len(transitions),
        "pair_counts": {f"{a}->{b}": n for (a, b), n in sorted(pair_counts.items())},
        "rates": {
            "BR_to_FG": rate("BR", "FG"),
            "MIFG_to_FG": rate("MIFG", "FG"),
            "FG_to_FG": rate("FG", "FG"),
            "FG_to_BR": rate("FG", "BR"),
            "FG_to_MIFG": rate("FG", "MIFG"),
            "FG_to_CLEAR": rate("FG", "CLEAR"),
            "onset_next_1h_global": global_onset,
            "fog_exit_next_1h_global": global_exit,
        },
        "onset_priors": serialize(onset_cells, global_onset),
        "exit_priors": serialize(exit_cells, global_exit),
    }


def main():
    rows = history.load_historical_training_rows()
    if not rows:
        raise SystemExit(
            "canonical history archive missing: data/import/epir-history/fog_training_2020_2024_corrected_v2.zip"
        )
    points = history.points_from_rows(rows)
    result = build(points)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "rows": len(rows),
        "points": len(points),
        "known_hours": result["hourly_known_states"],
        "transitions": result["adjacent_known_transitions"],
        "output": str(OUT.relative_to(ROOT)),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
