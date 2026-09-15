#!/usr/bin/env python3
"""Run Fog vNext verifier with canonical event/censor semantics.

This is intentionally a thin policy layer over fog_vnext_verification.py. It
keeps the existing v3 probability/ablation implementation intact while:
- assigning canonical 2020-2024 event IDs/boundaries;
- using reconstructed event IDs for 2025-2026;
- excluding left-censored onset and right-censored event-end transitions from
  exact next-hour scoring instead of treating UNKNOWN as a negative;
- excluding any None transition target from hourly/event-balanced metrics;
- indexing the long METAR wind-reference series so full-history verification
  preserves the same +/-31 minute reference policy without an O(N^2) scan.
"""
from __future__ import annotations

import json
from bisect import bisect_left, bisect_right
from datetime import timedelta

import fog_vnext_event_backfill as event_source
import fog_vnext_verification as base
import model_verification as mv

LEFT_CENSORED_IDS = set()
RIGHT_CENSORED_END_HOURS = set()
EVENTS = []

_ORIGINAL_WIND_REFERENCE = mv.metar_wind_reference
_WIND_REFERENCE_INDEX = {}


def indexed_metar_wind_reference(target_dt, regular_wind_points):
    """Exact metar_wind_reference semantics with a bisected time window.

    model_verification.build_observation_maps() calls the reference helper once
    for every verification hour. Its legacy helper scans the complete METAR
    series on every call. With 2020-2026 materialized truth that becomes nearly
    quadratic. The points are already sorted by time, so cache their timestamps
    once and pass only the exact +/-31 minute slice to the unchanged reference
    implementation.
    """
    if not target_dt or not regular_wind_points:
        return _ORIGINAL_WIND_REFERENCE(target_dt, regular_wind_points)

    key = id(regular_wind_points)
    cached = _WIND_REFERENCE_INDEX.get(key)
    if cached is None or cached[0] is not regular_wind_points:
        seconds = [dt.timestamp() for dt, _row in regular_wind_points]
        cached = (regular_wind_points, seconds)
        _WIND_REFERENCE_INDEX[key] = cached
    seconds = cached[1]

    center = target_dt.timestamp()
    half = float(mv.WIND_REFERENCE_HALF_WINDOW_SECONDS)
    lo = bisect_left(seconds, center - half)
    hi = bisect_right(seconds, center + half)
    return _ORIGINAL_WIND_REFERENCE(target_dt, regular_wind_points[lo:hi])


def load_event_policy():
    global LEFT_CENSORED_IDS, RIGHT_CENSORED_END_HOURS, EVENTS
    events, _points, inventory = event_source.load_events()
    EVENTS = sorted(events, key=lambda e: (e.start, e.end))
    LEFT_CENSORED_IDS = {e.event_id for e in EVENTS if e.left_censored_onset}
    RIGHT_CENSORED_END_HOURS = {
        (mv.iso(e.end.replace(minute=0, second=0, microsecond=0)), e.event_id)
        for e in EVENTS if e.right_censored_end
    }
    return inventory


def build_truth_timeline(metar_by_hour, synop_by_hour):
    timeline, fallback_map = ORIGINAL_BUILD_TRUTH_TIMELINE(metar_by_hour, synop_by_hour)
    if not EVENTS:
        return timeline, fallback_map

    event_map = dict(fallback_map)
    obscured_keys = []
    for key, tr in timeline.items():
        dt = mv.parse_dt(key)
        if dt and tr.get("state") in {"FG", "MIFG", "BR"}:
            obscured_keys.append((dt, key))

    # Canonical/reconstructed Event objects take precedence over the generic
    # hourly grouping. Only obscured hours are mapped; controls remain controls.
    for dt, key in obscured_keys:
        matches = [e for e in EVENTS if e.start <= dt <= e.end]
        if matches:
            # Boundaries are expected to be disjoint. If an overlap exists, the
            # shortest interval is the most specific and therefore wins.
            event = min(matches, key=lambda e: (e.end - e.start, e.start))
            event_map[key] = event.event_id
    return timeline, event_map


def attach_transition_truth(valid_s, tr, timeline, event_map):
    out = ORIGINAL_ATTACH(valid_s, tr, timeline, event_map)
    valid = mv.parse_dt(valid_s)
    if not valid:
        return out
    next_key = mv.iso(valid + timedelta(hours=1))
    next_event_id = event_map.get(next_key)
    current_event_id = event_map.get(valid_s)

    if out.get("onset_next_1h") and next_event_id in LEFT_CENSORED_IDS:
        out["onset_next_1h"] = None
        out["onset_censoring"] = "left-censored"
    else:
        out["onset_censoring"] = "exact-or-negative"

    end_key = mv.iso(valid.replace(minute=0, second=0, microsecond=0))
    if (end_key, current_event_id) in RIGHT_CENSORED_END_HOURS:
        out["fog_exit_next_1h"] = None
        out["dissipation_next_1h"] = None
        out["fog_to_low_st_next_1h"] = None
        out["dissipation_censoring"] = "right-censored"
    else:
        out["dissipation_censoring"] = "exact-or-negative"
    return out


def event_balanced_pairs(cases, score_getter, truth_key):
    grouped = {}
    for c in cases:
        y = c["truth"].get(truth_key)
        if y is None:
            continue
        event_id = c["truth"].get("event_id")
        if not event_id:
            continue
        grouped.setdefault((event_id, c.get("lead_bucket")), []).append(c)
    out = []
    for rows in grouped.values():
        scores = [score_getter(c) for c in rows]
        scores = [s for s in scores if base.finite(s)]
        if not scores:
            continue
        y = any(bool(c["truth"].get(truth_key)) for c in rows)
        out.append((max(scores), y))
    return out


def target_metrics(cases, score_getter, truth_key):
    known = [c for c in cases if c["truth"].get(truth_key) is not None]
    hourly = [(score_getter(c), c["truth"].get(truth_key)) for c in known]
    event_pairs = event_balanced_pairs(known, score_getter, truth_key)
    return {"hourly": base.binary_metrics(hourly), "event_balanced": base.binary_metrics(event_pairs)}


def annotate_summary(inventory):
    if not base.SUMMARY_PATH.exists():
        return
    summary = json.loads(base.SUMMARY_PATH.read_text(encoding="utf-8"))
    summary["censoring_policy"] = {
        "canonical_2020_2024_event_boundaries": True,
        "left_censored_onset_excluded_from_exact_scoring": True,
        "right_censored_end_excluded_from_exact_scoring": True,
        "unknown_transition_targets_excluded_not_negative": True,
        "canonical_event_rows": inventory.get("canonical_event_rows", 0),
        "left_censored_events": inventory.get("left_censored_events", 0),
        "right_censored_events": inventory.get("right_censored_events", 0),
        "canonical_start_field": inventory.get("canonical_start_field"),
        "canonical_end_field": inventory.get("canonical_end_field"),
        "canonical_left_censor_field": inventory.get("canonical_left_censor_field"),
        "canonical_right_censor_field": inventory.get("canonical_right_censor_field"),
    }
    summary["method"] += "; canonical 2020-2024 censored event boundaries used for event identity/onset-exit eligibility"
    base.SUMMARY_PATH.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


ORIGINAL_BUILD_TRUTH_TIMELINE = base.build_truth_timeline
ORIGINAL_ATTACH = base.attach_transition_truth


def main():
    inventory = load_event_policy()
    mv.metar_wind_reference = indexed_metar_wind_reference
    base.build_truth_timeline = build_truth_timeline
    base.attach_transition_truth = attach_transition_truth
    base.event_balanced_pairs = event_balanced_pairs
    base.target_metrics = target_metrics
    base.main()
    annotate_summary(inventory)
    print(json.dumps({
        "censor_aware": True,
        "events": len(EVENTS),
        "canonical_event_rows": inventory.get("canonical_event_rows", 0),
        "left_censored_events": len(LEFT_CENSORED_IDS),
        "right_censored_events": len(RIGHT_CENSORED_END_HOURS),
        "indexed_metar_wind_reference": True,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
