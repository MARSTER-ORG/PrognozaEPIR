#!/usr/bin/env python3
"""Regression checks for the 14-day NWP visibility calibration training policy."""
import datetime as dt
import importlib.util
import json
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
module=ROOT/'scripts/train_visibility_nwp.py'
spec=importlib.util.spec_from_file_location('train_visibility_nwp',module)
trainer=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=trainer
spec.loader.exec_module(trainer)

assert trainer.stamp('2026-10-28T20:00:00Z').tzinfo == dt.timezone.utc
assert trainer.stamp('invalid') is None

case={"obs_vis":8000,"model_vis":10000,"censored":False}
assert trainer.group([case]*39)['factor'] == 1.0, "small sample must not calibrate"
result=trainer.group([case]*60)
assert 0.75 <= result['factor'] <= 1.2
assert result['n']==60

# Regression against the actual archived 14-day issued forecasts and METAR truth.
as_of=trainer.stamp('2026-10-28T20:00:00Z')
artifact=trainer.build(as_of)
assert artifact['schema']=='prognozaepir-visibility-nwp-calibration-v1'
assert artifact['pairs'] > 0
assert artifact['groups']['night_clear']['factor'] >= .75
assert artifact['groups']['day_clear']['factor'] >= .75
assert artifact['groups']['night_fg']['factor'] == 1
assert artifact['window_end']=='2026-10-28T20:00:00Z'
assert artifact['max_match_minutes']==35
assert artifact['forecast_precedes_verifying_observation'] is True
for name,group in artifact['groups'].items():
    assert group['n'] >= 0, name
    assert .75 <= group['factor'] <= 1.2, name
    if group['n'] < 40:
        assert group['factor'] == 1.0, name
print('14-day NWP VIS calibration tests: OK',artifact['pairs'],'forecast–METAR pairs')
