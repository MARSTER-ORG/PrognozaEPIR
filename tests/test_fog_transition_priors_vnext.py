#!/usr/bin/env python3
from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))

import build_fog_transition_priors_vnext as priors

UTC = timezone.utc
base = datetime(2026, 9, 10, 1, 0, tzinfo=UTC)

# Known BR -> FG is a valid one-hour onset.
points = [
    (base, {}, 'BR'),
    (base + timedelta(hours=1), {}, 'FG'),
    (base + timedelta(hours=2), {}, 'FG'),
    (base + timedelta(hours=3), {}, 'CLEAR'),
]
r = priors.build(points)
assert r['pair_counts']['BR->FG'] == 1
assert r['pair_counts']['FG->FG'] == 1
assert r['pair_counts']['FG->CLEAR'] == 1
assert r['rates']['BR_to_FG'] == 1.0
assert r['rates']['FG_to_CLEAR'] == 0.5

# Missing/UNKNOWN predecessor must not manufacture a known onset.
points2 = [
    (base, {}, 'UNKNOWN'),
    (base + timedelta(hours=1), {}, 'FG'),
]
r2 = priors.build(points2)
assert 'UNKNOWN->FG' not in r2['pair_counts']
assert r2['adjacent_known_transitions'] == 0

# Multiple reports in one hour collapse conservatively to the most fog-like state.
points3 = [
    (base, {}, 'BR'),
    (base + timedelta(minutes=30), {}, 'MIFG'),
    (base + timedelta(minutes=45), {}, 'FG'),
]
h = priors.hourly_states(points3)
assert h[base] == 'FG'

print('fog vNext transition priors tests: OK')
