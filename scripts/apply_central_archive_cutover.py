#!/usr/bin/env python3
"""Idempotently route every bulletin consumer to data/messages."""
from __future__ import annotations
import re
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]

def patch_observation_engine() -> bool:
    p=ROOT/'observation-engine.js'; s=p.read_text(encoding='utf-8'); before=s
    s=s.replace("const LATEST_URL = 'data/observations/latest.json';","const LATEST_URL = 'data/messages/latest.json';")
    s=s.replace("const RECENT_URL = 'data/observations/recent.json';","const RECENT_URL = 'data/messages/recent.json';")
    s=re.sub(r"\n\s*const IMGW_METAR_URL = 'https://aviation-api\.imgw\.pl/[^']+';",'',s,count=1)
    a=s.find('  function walkImgwMessages('); b=s.find('  function metarPhenomena(',a)
    if a>=0 and b>a: s=s[:a]+s[b:]
    elif 'fetchImgwLiveMetar' in s or 'decodeImgwLiveMetar' in s: raise SystemExit('cannot remove direct IMGW observation block')
    a=s.find('  async function refreshLiveMetar(){'); b=s.find('  async function bootstrap(){',a)
    if a>=0 and b>a:
        s=s[:a]+"""  async function refreshLiveMetar(){
    try{
      const l=await fetchJson(LATEST_URL);
      if(l)latestData=l;
      if(recentData)storeAutomaticObservations(recentData);
      installPanel();refreshVerification();
    }catch(e){console.warn('EPIR central message archive:',e);}
  }

"""+s[b:]
    elif 'async function refreshLiveMetar' not in s: raise SystemExit('observation archive refresh function missing')
    s=s.replace('EPIR live METAR from IMGW','EPIR aviation observation from central archive').replace('EPIR live IMGW METAR','EPIR central archive')
    s=s.replace('Obserwacje automatyczne EPIR — METAR + SYNOP 12342','Obserwacje EPIR — METAR/SPECI + SYNOP 12342')
    if 'aviation-api.imgw.pl' in s or 'fetchImgwLiveMetar' in s or 'data/observations/latest.json' in s or 'data/observations/recent.json' in s: raise SystemExit('legacy observation acquisition survived cutover')
    if s!=before: p.write_text(s,encoding='utf-8'); return True
    return False

def patch_taf_html() -> bool:
    p=ROOT/'taf.html'; s=p.read_text(encoding='utf-8'); before=s
    marker="const VERSION = 'TAF Sources v0.3.3';"; pos=s.find(marker)
    if pos>=0:
        a=s.rfind('<script>',0,pos); b=s.find('</script>',pos)
        if a<0 or b<0: raise SystemExit('cannot isolate old TAF multi-source script')
        s=s[:a]+'<script src="message-archive-client.js"></script>'+s[b+9:]
    elif 'src="message-archive-client.js"' not in s:
        raise SystemExit('TAF MessageArchive client loader not found')
    s=s.replace('<script src="taf-archive-source.js"></script>\n','').replace('\n<script src="taf-archive-source.js"></script>','')
    s=s.replace("json('data/observations/latest.json')","json('data/messages/latest.json')")
    s=s.replace("json('data/observations/recent.json')","json('data/messages/recent.json')")
    s=s.replace('TAF-y zostaną pobrane bezpośrednio z IMGW po kliknięciu „Odśwież i generuj”.','TAF-y są odczytywane wyłącznie z centralnego archiwum depesz.')
    s=s.replace('Generator po kliknięciu „Odśwież i generuj” scala TAF z IMGW, AWC, PilotHub przez proxy, cache i źródeł ręcznych, a następnie korzysta z SYNOP, silnika multimodelowego, Cloud Learning oraz kierunkowych TAF EPBY / EPPW / EPKS.','Generator po kliknięciu „Odśwież i generuj” odczytuje METAR/SPECI, SYNOP i TAF wyłącznie z centralnego archiwum depesz, a następnie korzysta z silnika multimodelowego, Cloud Learning oraz kierunkowych TAF EPBY / EPPW / EPKS.')
    if marker in s or 'function fromProxy(' in s or 'function fromImgw(' in s or 'function fromAwc(' in s: raise SystemExit('old browser-side TAF acquisition survived cutover')
    if 'data/observations/latest.json' in s or 'data/observations/recent.json' in s: raise SystemExit('legacy observation path survived TAF cutover')
    if 'taf-archive-source.js' in s: raise SystemExit('TAF compatibility source survived native cutover')
    if s!=before: p.write_text(s,encoding='utf-8'); return True
    return False

def patch_model_verification() -> bool:
    p=ROOT/'scripts/model_verification.py'; s=p.read_text(encoding='utf-8'); before=s
    old='METAR_DIR = ROOT / "data" / "observations" / "metar"\nSYNOP_DIR = ROOT / "data" / "observations" / "synop"'; new='METAR_DIR = ROOT / "data" / "messages" / "metar"\nSPECI_DIR = ROOT / "data" / "messages" / "speci"\nSYNOP_DIR = ROOT / "data" / "messages" / "synop"'
    if old in s: s=s.replace(old,new,1)
    elif new not in s: raise SystemExit('model verification archive constants anchor missing')
    old='metars = unique_rows(all_jsonl(METAR_DIR), ("obs_time", "raw"))'; new='metars = unique_rows(all_jsonl(METAR_DIR) + all_jsonl(SPECI_DIR), ("obs_time", "raw"))'
    if old in s: s=s.replace(old,new,1)
    elif new not in s: raise SystemExit('model verification METAR/SPECI reader anchor missing')
    old='source_hits[model]["SPECI" if raw.startswith("SPECI") else "METAR"] += 1'; new='source_hits[model]["SPECI" if str(m.get("type") or "").upper() == "SPECI" or raw.startswith("SPECI") else "METAR"] += 1'
    if old in s: s=s.replace(old,new,1)
    elif new not in s: raise SystemExit('model verification SPECI classification anchor missing')
    if 'data" / "observations"' in s: raise SystemExit('legacy observation directory survived model verification cutover')
    if s!=before: p.write_text(s,encoding='utf-8'); return True
    return False

def patch_cloud_learning() -> bool:
    p=ROOT/'scripts/cloud_learning.py'; s=p.read_text(encoding='utf-8'); before=s
    old='METAR_DIR = ROOT / "data" / "observations" / "metar"'; new='METAR_DIR = ROOT / "data" / "messages" / "metar"\nSPECI_DIR = ROOT / "data" / "messages" / "speci"'
    if new not in s:
        if old in s: s=s.replace(old,new,1)
        else: raise SystemExit('cloud learning archive constant anchor missing')
    canonical='metars = all_jsonl(METAR_DIR) + all_jsonl(SPECI_DIR)'
    s=re.sub(r'metars = all_jsonl\(METAR_DIR\)(?: \+ all_jsonl\(SPECI_DIR\))+',canonical,s,count=1)
    if canonical not in s: raise SystemExit('cloud learning METAR/SPECI reader anchor missing')
    if 'data" / "observations"' in s: raise SystemExit('legacy observation directory survived cloud learning cutover')
    if s!=before: p.write_text(s,encoding='utf-8'); return True
    return False

def patch_pages_workflow() -> bool:
    p=ROOT/'.github/workflows/pages.yml'; s=p.read_text(encoding='utf-8'); before=s
    s=s.replace('mkdir -p _site/data/observations _site/data/learning _site/data/taf','mkdir -p _site/data/messages _site/data/learning')
    s=s.replace('cloud-learning-client.js \\\n             radar-enhance.js','cloud-learning-client.js message-archive-client.js taf-archive-source.js \\\n             radar-enhance.js')
    s=s.replace('cp data/observations/latest.json data/observations/recent.json _site/data/observations/','cp -R data/messages/. _site/data/messages/')
    s=s.replace('          cp data/taf/neighbors.json _site/data/taf/\n','')
    s=s.replace('cloud-learning-client.js radar-enhance.js','cloud-learning-client.js message-archive-client.js taf-archive-source.js radar-enhance.js')
    s=s.replace('          test -s _site/data/observations/latest.json\n          test -s _site/data/observations/recent.json','          test -s _site/data/messages/latest.json\n          test -s _site/data/messages/recent.json\n          test -s _site/data/messages/status.json')
    s=s.replace('          test -s _site/data/taf/neighbors.json\n','')
    s=s.replace('          python3 -m json.tool _site/data/observations/latest.json >/dev/null\n          python3 -m json.tool _site/data/observations/recent.json >/dev/null','          python3 -m json.tool _site/data/messages/latest.json >/dev/null\n          python3 -m json.tool _site/data/messages/recent.json >/dev/null\n          python3 -m json.tool _site/data/messages/status.json >/dev/null')
    s=s.replace('          python3 -m json.tool _site/data/taf/neighbors.json >/dev/null\n','')
    s=s.replace('          grep -F "data/observations/recent.json" _site/observation-engine.js','          grep -F "data/messages/recent.json" _site/observation-engine.js')
    if '_site/data/observations' in s or '_site/data/taf' in s: raise SystemExit('legacy bulletin trees survived Pages cutover')
    if 'message-archive-client.js' not in s or '_site/data/messages' not in s: raise SystemExit('central archive assets missing from Pages workflow')
    if s!=before: p.write_text(s,encoding='utf-8'); return True
    return False

def main() -> int:
    changed=[]
    if patch_observation_engine(): changed.append('observation-engine.js')
    if patch_taf_html(): changed.append('taf.html')
    if patch_model_verification(): changed.append('scripts/model_verification.py')
    if patch_cloud_learning(): changed.append('scripts/cloud_learning.py')
    if patch_pages_workflow(): changed.append('.github/workflows/pages.yml')
    print('central archive consumer cutover:',', '.join(changed) if changed else 'already applied')
    return 0
if __name__=='__main__': raise SystemExit(main())
