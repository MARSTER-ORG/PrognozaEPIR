#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

# Canonical station metadata. WMO 12342 is an observation identifier; EPIR
# coordinates remain the project forecast/reference point.
station={
  "schema":"prognozaepir-station-metadata-v1",
  "EPIR":{
    "name":"Inowrocław",
    "icao":"EPIR",
    "synop":"12342",
    "wigos":"0-20000-0-12342",
    "lat":52.828611,
    "lon":18.330278
  }
}
(ROOT/'station-metadata.json').write_text(json.dumps(station,ensure_ascii=False,indent=2)+"\n",encoding='utf-8')

(ROOT/'scripts'/'station_metadata.py').write_text('''#!/usr/bin/env python3\nfrom __future__ import annotations\nimport json\nfrom pathlib import Path\n\nROOT=Path(__file__).resolve().parents[1]\n_DATA=json.loads((ROOT/'station-metadata.json').read_text(encoding='utf-8'))\nEPIR=dict(_DATA['EPIR'])\nICAO=EPIR['icao']\nSYNOP_ID=EPIR['synop']\nWIGOS_ID=EPIR['wigos']\nLAT=float(EPIR['lat'])\nLON=float(EPIR['lon'])\n''',encoding='utf-8')

# Canonical unit constants for non-versioned UI/archive code. Versioned TAF
# kernels remain self-contained but are contract-tested against these values.
(ROOT/'meteo-units.js').write_text("""'use strict';\n(() => {\n  if(window.PrognozaEPIRUnits)return;\n  const MPS_TO_KT=1.9438444924406;\n  const KT_TO_MPS=0.5144444444444445;\n  const M_TO_FT=3.2808398950131;\n  const FT_TO_M=0.3048;\n  const finite=v=>Number.isFinite(Number(v));\n  const cv=(v,k)=>finite(v)?Number(v)*k:null;\n  window.PrognozaEPIRUnits=Object.freeze({\n    MPS_TO_KT,KT_TO_MPS,M_TO_FT,FT_TO_M,\n    mpsToKt:v=>cv(v,MPS_TO_KT),\n    ktToMps:v=>cv(v,KT_TO_MPS),\n    mToFt:v=>cv(v,M_TO_FT),\n    ftToM:v=>cv(v,FT_TO_M)\n  });\n})();\n""",encoding='utf-8')

(ROOT/'scripts'/'meteo_units.py').write_text('''#!/usr/bin/env python3\nfrom __future__ import annotations\nimport math\n\nMPS_TO_KT=1.9438444924406\nKT_TO_MPS=0.5144444444444445\nM_TO_FT=3.2808398950131\nFT_TO_M=0.3048\n\ndef _cv(value, factor):\n    try:\n        x=float(value)\n    except (TypeError, ValueError):\n        return None\n    return x*factor if math.isfinite(x) else None\n\ndef mps_to_kt(value): return _cv(value,MPS_TO_KT)\ndef kt_to_mps(value): return _cv(value,KT_TO_MPS)\ndef m_to_ft(value): return _cv(value,M_TO_FT)\ndef ft_to_m(value): return _cv(value,FT_TO_M)\n''',encoding='utf-8')

# Python observation collector: canonical station metadata and unit helpers.
p=ROOT/'scripts'/'collect_epir_observations.py'; s=p.read_text(encoding='utf-8')
if 'from station_metadata import' not in s:
    s=s.replace('from pathlib import Path\n','from pathlib import Path\nfrom station_metadata import ICAO, SYNOP_ID, WIGOS_ID, LAT, LON\nfrom meteo_units import kt_to_mps, ft_to_m\n',1)
s=s.replace("ICAO='EPIR'; SYNOP_ID='12342'; WIGOS_ID='0-20000-0-12342'\nLAT=52.83; LON=18.33; OUT=Path('data/observations')","OUT=Path('data/observations')")
s=s.replace("ws=int(w.group(2))*.514444 if w else None; gust=int(w.group(3))*.514444 if w and w.group(3) else None","ws=kt_to_mps(int(w.group(2))) if w else None; gust=kt_to_mps(int(w.group(3))) if w and w.group(3) else None")
s=s.replace("ft=int(h)*100; clouds.append({'cover':c,'base_ft_agl':ft,'base_m_agl':round(ft*.3048)})","ft=int(h)*100; clouds.append({'cover':c,'base_ft_agl':ft,'base_m_agl':round(ft_to_m(ft))})")
p.write_text(s,encoding='utf-8')

# MessageArchive station metadata must use the exact same canonical record.
p=ROOT/'scripts'/'message_archive.py'; s=p.read_text(encoding='utf-8')
if 'from station_metadata import EPIR as EPIR_META' not in s:
    s=s.replace('import import_epir_bulk_archive as bulk\n','import import_epir_bulk_archive as bulk\nfrom station_metadata import EPIR as EPIR_META\n',1)
old="'station':{'icao':'EPIR','synop':'12342','wigos':'0-20000-0-12342','lat':52.83,'lon':18.33}"
new="'station':dict(EPIR_META)"
if old not in s and new not in s: raise SystemExit('message_archive canonical station marker missing')
s=s.replace(old,new)
p.write_text(s,encoding='utf-8')

# Neighbor parser shares the exact aviation conversions.
p=ROOT/'scripts'/'neighbor_observations.py'; s=p.read_text(encoding='utf-8')
if 'from meteo_units import kt_to_mps, ft_to_m' not in s:
    # insert after stdlib imports, before local declarations
    anchor='from pathlib import Path\n'
    if anchor in s: s=s.replace(anchor,anchor+'from meteo_units import kt_to_mps, ft_to_m\n',1)
    else: s='from meteo_units import kt_to_mps, ft_to_m\n'+s
s=s.replace('round(int(wind.group(2)) * 0.514444, 2)','round(kt_to_mps(int(wind.group(2))), 2)')
s=s.replace('round(int(wind.group(3)) * 0.514444, 2)','round(kt_to_mps(int(wind.group(3))), 2)')
s=s.replace('round(ft * 0.3048)','round(ft_to_m(ft))')
p.write_text(s,encoding='utf-8')

# Load canonical browser unit helpers on every source HTML page using shared UI.
for p in ROOT.glob('*.html'):
    s=p.read_text(encoding='utf-8')
    if 'theme.js' not in s: continue
    if 'meteo-units.js' not in s:
        s=re.sub(r'(<script\s+src=["\']theme\.js(?:\?[^"\']*)?["\'][^>]*></script>)',r'<script src="meteo-units.js?v=20260924-u1"></script>\n\1',s,count=1,flags=re.I)
    p.write_text(s,encoding='utf-8')

# Non-versioned UI/archive clients now share one conversion implementation.
repls={
 'message-archive-client.js':{
  'x*1.9438444924406':'window.PrognozaEPIRUnits.mpsToKt(x)',
 },
 'visual-style-fix.js':{
  'Math.round(Number(v)*1.94384)':'Math.round(window.PrognozaEPIRUnits.mpsToKt(Number(v)))',
 },
 'meteogram-visfog-cleanup.js':{
  'Math.round(z.ceiling*3.28084)':'Math.round(window.PrognozaEPIRUnits.mToFt(z.ceiling))',
 },
 'meteogram-visfog-split.js':{
  'Math.round(z.ceiling*3.28084)':'Math.round(window.PrognozaEPIRUnits.mToFt(z.ceiling))',
 },
 'rh-axis-fix.js':{
  'Math.round(z.ceiling*3.28084)':'Math.round(window.PrognozaEPIRUnits.mToFt(z.ceiling))',
 },
 'aviation-hazards.js':{
  'Math.round((m*3.28084)/10)*10':'Math.round(window.PrognozaEPIRUnits.mToFt(m)/10)*10',
 },
 'warnings-readable.js':{
  'Math.round((m*3.28084)/10)*10':'Math.round(window.PrognozaEPIRUnits.mToFt(m)/10)*10',
 },
}
for name,m in repls.items():
    p=ROOT/name
    if not p.exists(): continue
    s=p.read_text(encoding='utf-8')
    for old,new in m.items(): s=s.replace(old,new)
    p.write_text(s,encoding='utf-8')

p=ROOT/'arch.html'; s=p.read_text(encoding='utf-8')
s=s.replace('num(x.wind_speed_ms)*1.943844','window.PrognozaEPIRUnits.mpsToKt(num(x.wind_speed_ms))')
s=s.replace('num(x.wind_gust_ms)*1.943844','window.PrognozaEPIRUnits.mpsToKt(num(x.wind_gust_ms))')
s=s.replace('num(x.ceiling_m_agl)*3.28084','window.PrognozaEPIRUnits.mToFt(num(x.ceiling_m_agl))')
p.write_text(s,encoding='utf-8')

# Canonical Pages build owns cache busting, not semantics.
p=ROOT/'scripts'/'prepare_pages_v241.py'; s=p.read_text(encoding='utf-8')
if 'meteo-units.js' not in s:
    s=s.replace("    theme = f'<script src=\"theme.js?v={p.ASSET_V}\"></script>'\n    style = f'<link rel=\"stylesheet\" href=\"app.css?v={p.ASSET_V}\">'","    units = f'<script src=\"meteo-units.js?v={p.ASSET_V}\"></script>'\n    theme = f'<script src=\"theme.js?v={p.ASSET_V}\"></script>'\n    style = f'<link rel=\"stylesheet\" href=\"app.css?v={p.ASSET_V}\">'",1)
    s=s.replace("            r'\\s*<script\\s+src=[\"\\']theme\\.js(?:\\?[^\"\\']*)?[\"\\'][^>]*></script>',","            r'\\s*<script\\s+src=[\"\\']meteo-units\\.js(?:\\?[^\"\\']*)?[\"\\'][^>]*></script>',\n            r'\\s*<script\\s+src=[\"\\']theme\\.js(?:\\?[^\"\\']*)?[\"\\'][^>]*></script>',",1)
    s=s.replace("s = re.sub(r'</head>', f'  {theme}\\n  {style}\\n</head>', s, count=1, flags=re.I)","s = re.sub(r'</head>', f'  {units}\\n  {theme}\\n  {style}\\n</head>', s, count=1, flags=re.I)",1)
    s=s.replace("        if html.count('theme.js?v=') != 1:\n            raise RuntimeError(f\"shared theme controller must be wired exactly once: {page.name}\")","        if html.count('meteo-units.js?v=') != 1:\n            raise RuntimeError(f\"shared unit contract must be wired exactly once: {page.name}\")\n        if html.count('theme.js?v=') != 1:\n            raise RuntimeError(f\"shared theme controller must be wired exactly once: {page.name}\")",1)
p.write_text(s,encoding='utf-8')

# Persistent regression tests.
(ROOT/'tests'/'test_station_unit_contracts.py').write_text('''#!/usr/bin/env python3\nfrom __future__ import annotations\nimport json,re\nfrom pathlib import Path\n\nROOT=Path(__file__).resolve().parents[1]\n\ndef main():\n    st=json.loads((ROOT/'station-metadata.json').read_text(encoding='utf-8'))['EPIR']\n    assert st['lat']==52.828611 and st['lon']==18.330278\n    assert st['icao']=='EPIR' and st['synop']=='12342'\n    collect=(ROOT/'scripts/collect_epir_observations.py').read_text(encoding='utf-8')\n    archive=(ROOT/'scripts/message_archive.py').read_text(encoding='utf-8')\n    assert 'LAT=52.83' not in collect and 'LON=18.33' not in collect\n    assert "'lat':52.83" not in archive and "'lon':18.33" not in archive\n    assert 'from station_metadata import' in collect\n    assert 'dict(EPIR_META)' in archive\n    py=(ROOT/'scripts/meteo_units.py').read_text(encoding='utf-8')\n    js=(ROOT/'meteo-units.js').read_text(encoding='utf-8')\n    assert 'MPS_TO_KT=1.9438444924406' in py and 'M_TO_FT=3.2808398950131' in py\n    assert 'MPS_TO_KT=1.9438444924406' in js and 'M_TO_FT=3.2808398950131' in js\n    # Formal versioned kernels stay standalone but must share canonical values.\n    for name in ('taf-engine-v2.js','taf-engine-v241.js','taf-engine-v242.js'):\n        text=(ROOT/name).read_text(encoding='utf-8')\n        if 'KT=' in text: assert '1.9438444924406' in text\n        if 'FT=' in text: assert '3.2808398950131' in text\n    for name in ('arch.html','message-archive-client.js','visual-style-fix.js','meteogram-visfog-cleanup.js','meteogram-visfog-split.js','rh-axis-fix.js','aviation-hazards.js','warnings-readable.js'):\n        text=(ROOT/name).read_text(encoding='utf-8')\n        assert 'PrognozaEPIRUnits' in text, name\n    print('Station/unit contracts: OK')\n\nif __name__=='__main__': main()\n''',encoding='utf-8')

print('Stage 2 station/unit patch applied')
