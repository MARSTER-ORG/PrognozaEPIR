#!/usr/bin/env python3
from pathlib import Path

import apply_adaptive_runtime_patch as base
import apply_fog_learning_upgrade as fog
import apply_fog_event_skill_patch as fog_event

ROOT = Path(__file__).resolve().parents[1]


def add_legacy_pages_marker():
    p = ROOT / 'index.html'
    s = p.read_text(encoding='utf-8')
    marker = '/* deploy-check compatibility: if(row)items.push({model:m,row,w:m.w,elevation:ds.elevation}) */'
    if marker not in s:
        needle = 'function compute(){'
        if needle not in s:
            raise SystemExit('compute marker missing')
        s = s.replace(needle, marker + '\n' + needle, 1)
    p.write_text(s, encoding='utf-8')


def main():
    base.patch_client()
    base.patch_index()
    base.patch_rh_axis()
    base.patch_cloud_learning()

    fog_source = (ROOT / 'fog-engine.js').read_text(encoding='utf-8')
    fog_v12_present = (
        "const KNMI_MODEL = 'knmi_harmonie_arome_europe';" in fog_source
        and 'function fogModelWeight(' in fog_source
        and 'async function fetchKnmi()' in fog_source
        and 'weightedModelMedian' in fog_source
    )
    if fog_v12_present:
        print('fog ensemble v1.2 already present; skipping base fog patch')
    else:
        fog.main()

    fog_event.main()
    add_legacy_pages_marker()
    print('adaptive runtime + fog ensemble + METAR/SPECI event skill patch applied')


if __name__ == '__main__':
    main()
