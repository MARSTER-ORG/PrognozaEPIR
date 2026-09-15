#!/usr/bin/env python3
from __future__ import annotations
import sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
import build_fog_event_learning_v2 as fog
import model_verification as mv

def check(obs, **expected):
    got=fog.classify(obs)
    for key,value in expected.items():
        assert got[key] == value, (key, got, expected)
    return got

check({'canonical_raw':'METAR EPIR 150200Z 00000KT 3000 MIFG NSC 08/08 Q1020=','visibility_m':3000},kind='MIFG',fog=False,mifg=True)
check({'canonical_raw':'METAR EPIR 150230Z 00000KT 0800 MIFG NSC 08/08 Q1020=','visibility_m':800},kind='MIFG',fog=True,mifg=True,visibility_fog=True)
check({'canonical_raw':'METAR EPIR 150300Z AUTO VRB01KT 0600 BKN003 08/08 Q1020=','visibility_m':600},fog=True,visibility_fog=True)
check({'canonical_raw':'METAR EPIR 150330Z AUTO 18008KT 0800 +RA BKN004 08/07 Q1018=','visibility_m':800},fog=False,visibility_fog=False)
check({'canonical_raw':'METAR EPIR 150400Z 18004KT 0600 RA FG OVC002 08/08 Q1018=','visibility_m':600},fog=True)

fog.install_extra_models()
assert 'dmi_harmonie_arome_europe' in mv.MODEL_META
assert 'knmi_harmonie_arome_europe' in mv.MODEL_META
assert mv.MODEL_META['dmi_harmonie_arome_europe'][1] > 0
assert mv.MODEL_META['knmi_harmonie_arome_europe'][1] > 0
print('fog event learning v2 tests: OK')
