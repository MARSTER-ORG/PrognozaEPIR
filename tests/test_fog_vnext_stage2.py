#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import tempfile
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))

import fog_vnext_event_backfill as backfill
import fog_vnext_history_coverage as history_coverage
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

# Canonical historical ZIP loader: locate the JSONL even when the handoff ZIP
# contains it in a nested directory, preserve fog_truth and keep missing AUTO
# visibility UNKNOWN rather than CLEAR.
with tempfile.TemporaryDirectory() as td:
    archive_path = Path(td) / 'fog_training_2020_2024_corrected_v2.zip'
    historical = [
        {
            'obs_time': '2024-10-01T03:00:00Z',
            'canonical_raw': 'METAR EPIR 010300Z AUTO 00000KT 0800 FG VV001 08/08 Q1018=',
            'visibility_m': 800,
            'fog_truth': True,
        },
        {
            'obs_time': '2024-10-01T04:00:00Z',
            'canonical_raw': 'METAR EPIR 010400Z AUTO 00000KT 5000 MIFG NSC 08/08 Q1018=',
            'visibility_m': 5000,
            'fog_truth': False,
        },
        {
            'obs_time': '2024-10-01T05:00:00Z',
            'canonical_raw': 'METAR EPIR 010500Z AUTO 00000KT NCD 08/08 Q1018=',
            'visibility_m': None,
            'fog_truth': False,
        },
    ]
    payload = ''.join(json.dumps(row) + '\n' for row in historical)
    with zipfile.ZipFile(archive_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('FogEngine_vNext_training/aviation_observations_2020_2024.jsonl', payload)

    loaded = backfill.load_historical_training_rows(archive_path)
    assert len(loaded) == 3
    assert loaded[0]['raw'] == historical[0]['canonical_raw']
    classified = backfill.points_from_rows(loaded)
    assert [x[2] for x in classified] == ['FG', 'MIFG', 'UNKNOWN'], classified

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

# Sparse evidence must never unlock production. v3 per-lead metrics expose
# blend, physics and direct channels separately; activation is based on blend.
empty_metrics = {
    'fog_truth': {'hourly': {'positive': 0}, 'event_balanced': {'auc': None}},
    'direct_visibility_baseline': {'event_balanced': {'auc': None}},
}
lead = {
    name: {
        'blend': {'event_balanced': {'positive': 0, 'negative': 0}},
        'physics': {'event_balanced': {'positive': 0, 'negative': 0}},
        'direct': {'event_balanced': {'positive': 0, 'negative': 0}},
    }
    for _a, _b, name, _t in mv.LEAD_BUCKETS
}
gate = verify.activation_gate([], empty_metrics, {}, lead)
assert gate['statistical_ready'] is False
assert gate['operational_activation_ready'] is False
assert gate['mode'] == 'shadow'
assert gate['blockers']

# Audit the real canonical binary archives when CI has attached them from main.
# This deliberately checks ZIP internals rather than trusting outer filenames.
history_root = ROOT / 'data/import/epir-history'
if history_root.exists():
    year_2025 = []
    for archive_path in sorted(history_root.glob('*.zip')):
        try:
            with zipfile.ZipFile(archive_path) as zf:
                summary = history_coverage.scan_zip(zf, str(archive_path))
        except zipfile.BadZipFile:
            continue
        member_hits = summary.get('year_member_hits', {}).get('2025', 0)
        content_hits = summary.get('year_content_hits', {}).get('2025', 0)
        if member_hits or content_hits:
            year_2025.append({
                'archive': archive_path.name,
                'member_hits': member_hits,
                'content_hits': content_hits,
                'examples': summary.get('examples', {}).get('2025', []),
            })
    print('EPIR_HISTORY_2025=' + json.dumps(year_2025, ensure_ascii=False))

print('fog vNext stage2 tests: OK')
