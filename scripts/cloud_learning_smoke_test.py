#!/usr/bin/env python3
from pathlib import Path
import importlib.util

p=Path(__file__).with_name('cloud_learning.py')
spec=importlib.util.spec_from_file_location('cloud_learning',p)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

assert m.okta_from_pct(0)==0
assert m.okta_from_pct(62.5)==5
assert m.metar_cover_range('BKN')==(5,7)
assert m.distance_to_range(6,5,7)==0
assert m.distance_to_range(3,5,7)==2
assert m.lead_bucket(2.9)=='0-3h'
assert m.lead_bucket(5.9)=='3-6h'
assert m.lead_bucket(47.9)=='24-48h'
print('Cloud Learning smoke test: OK')
