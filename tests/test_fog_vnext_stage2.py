#!/usr/bin/env python3
from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))

import fog_vnext_event_backfill as backfill
import fog_vnext_verification as verify
import model_verification as mv

UTC = timezone.utc
base = datetime(2026, 9, 10, 1, 0, tzinfo=UTC)

# Event grouping keeps BR -> MIFG -> FG in one episode and closes it on CLEAR.
points = [
    (base, {}, 'BR'),
    (base + timedelta(minutes=30), {}, 'MIFG'),
    (base + timedelta(hours=1), {}, 'FG'),
    (base + timedelta(hours=2), {}, 'CLEAR'),
    (base + timedelta(hours=5), {}, 'BR'),
]
events = backfill.build_events(points)
assert len(events) == 2, events
assert events[0].first_state == 'BR'
assert events[0].br and events[0].mifg and events[0].fog
assert not events[1].fog and events[1].br

# A clearly separated score must give perfect discrimination.
m = verify.binary_metrics([(0.95, True), (0.8, True), (0.2, False), (0.05, False)])
assert m['auc'] == 1.0, m
assert m['positive'] == 2 and m['negative'] == 2

# Transition truth: BR immediately before FG is an onset case.
k0 = mv.iso(base)
k1 = mv.iso(base + timedelta(hours=1))
timeline = {
    k0: {'state': 'BR', 'fog_truth': False, 'truth_known': True, 'clear_truth': False, 'low_st_truth': False},
    k1: {'state': 'FG', 'fog_truth': True, 'truth_known': True, 'clear_truth': False, 'low_st_truth': False},
}
tr = verify.attach_transition_truth(k0, dict(timeline[k0]), timeline, {k0: 'OBS-X', k1: 'OBS-X'})
assert tr['onset_next_1h'] is True
assert tr['event_id'] == 'OBS-X'

# FG -> LOW_ST is not counted as full dissipation to CLEAR.
timeline2 = {
    k0: {'state': 'FG', 'fog_truth': True, 'truth_known': True, 'clear_truth': False, 'low_st_truth': False},
    k1: {'state': 'LOW_ST', 'fog_truth': False, 'truth_known': True, 'clear_truth': False, 'low_st_truth': True},
}
tr2 = verify.attach_transition_truth(k0, dict(timeline2[k0]), timeline2, {k0: 'OBS-Y'})
assert tr2['fog_exit_next_1h'] is True
assert tr2['fog_to_low_st_next_1h'] is True
assert tr2['dissipation_next_1h'] is False

# Sparse evidence must never unlock production.
empty_metrics = {
    'fog_truth': {'hourly': {'positive': 0}, 'event_balanced': {'auc': None}},
    'direct_visibility_baseline': {'event_balanced': {'auc': None}},
}
lead = {name: {'event_balanced': {'positive': 0, 'negative': 0}} for _a, _b, name, _t in mv.LEAD_BUCKETS}
gate = verify.activation_gate([], empty_metrics, {}, lead)
assert gate['statistical_ready'] is False
assert gate['operational_activation_ready'] is False
assert gate['mode'] == 'shadow'
assert gate['blockers']

print('fog vNext stage2 tests: OK')
