#!/usr/bin/env python3
from __future__ import annotations
import json,re
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

def main():
    st=json.loads((ROOT/'station-metadata.json').read_text(encoding='utf-8'))['EPIR']
    assert st['lat']==52.828611 and st['lon']==18.330278
    assert st['icao']=='EPIR' and st['synop']=='12342'
    collect=(ROOT/'scripts/collect_epir_observations.py').read_text(encoding='utf-8')
    archive=(ROOT/'scripts/message_archive.py').read_text(encoding='utf-8')
    assert 'LAT=52.83' not in collect and 'LON=18.33' not in collect
    assert "'lat':52.83" not in archive and "'lon':18.33" not in archive
    assert 'from station_metadata import' in collect
    assert 'dict(EPIR_META)' in archive
    py=(ROOT/'scripts/meteo_units.py').read_text(encoding='utf-8')
    js=(ROOT/'meteo-units.js').read_text(encoding='utf-8')
    assert 'MPS_TO_KT=1.9438444924406' in py and 'M_TO_FT=3.2808398950131' in py
    assert 'MPS_TO_KT=1.9438444924406' in js and 'M_TO_FT=3.2808398950131' in js
    # Formal versioned kernels stay standalone but must share canonical values.
    for name in ('taf-engine-v2.js','taf-engine-v241.js','taf-engine-v242.js'):
        text=(ROOT/name).read_text(encoding='utf-8')
        if 'KT=' in text: assert '1.9438444924406' in text
        if 'FT=' in text: assert '3.2808398950131' in text
    for name in ('arch.html','message-archive-client.js','visual-style-fix.js','meteogram-visfog-cleanup.js','meteogram-visfog-split.js','rh-axis-fix.js','aviation-hazards.js','warnings-readable.js'):
        text=(ROOT/name).read_text(encoding='utf-8')
        assert 'PrognozaEPIRUnits' in text, name
    print('Station/unit contracts: OK')

if __name__=='__main__': main()
