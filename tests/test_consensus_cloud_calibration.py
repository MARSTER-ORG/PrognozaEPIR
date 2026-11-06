#!/usr/bin/env python3
"""Fast, synthetic no-leakage and out-of-sample cloud calibration tests."""
import sys
from datetime import timedelta
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import build_consensus_cloud_calibration as mod

t=mod.CUTOFF-timedelta(days=2)
h=mod.CUTOFF+timedelta(days=2)
tr=[(t,75,4)]*120
hold=[(h,75,4)]*60
fit=mod.fit(tr+hold,"total")
assert fit["active"],fit
assert fit["shift_okta"]<0,fit
assert fit["holdout_mae_gain"]>0,fit

wrong=mod.fit(tr+[(h,75,6)]*60,"total")
assert not wrong["active"],wrong
assert wrong["reason"]=="holdout_not_improved",wrong

small=mod.fit([(t,75,4)]*7+[(h,75,4)]*4,"total")
assert not small["active"] and small["reason"]=="insufficient_data"

# MID uses observed METAR FEW/SCT/BKN/OVC intervals, not false exact okta.
mid=mod.fit([(t,25,(5,7))]*25+[(h,25,(5,7))]*12,"mid")
assert mid["active"] and mid["shift_okta"]>0,mid
print("cloud train/holdout guards and METAR intervals: OK")
