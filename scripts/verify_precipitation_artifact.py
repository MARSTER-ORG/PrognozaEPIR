#!/usr/bin/env python3
"""Validate exact precipitation modules in a built or live Pages artifact."""
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
import argparse,hashlib,json
from pathlib import Path
from urllib.request import urlopen
from urllib.parse import urljoin,urlsplit

MODULES=['cloud-learning-client.js','meteogram-precipitation-types.js',
 'meteogram-precipitation-evidence.js','meteogram-precipitation-intelligence.js',
 'meteogram-precipitation-continuity.js','convection-horizon-12h.js',
 'meteogram-precip-compact-info.js']
class Assets(HTMLParser):
 def __init__(self):super().__init__();self.scripts=[];self.assets=[]
 def handle_starttag(self,tag,attrs):
  a=dict(attrs)
  if tag=='script' and a.get('src'):self.scripts.append(a['src']);self.assets.append(a['src'])
  if tag=='link' and a.get('href'):self.assets.append(a['href'])

def verify(target,expected_commit=None,compare_source=False):
 remote=target.startswith(('https://','http://'))
 def get(name):
  if remote:
   with urlopen(urljoin(target.rstrip('/')+'/',name),timeout=30) as r:
    assert r.status==200,(name,r.status)
    return r.read()
  return (Path(target)/urlsplit(name).path).read_bytes()
 html=get('index.html').decode();parser=Assets();parser.feed(html)
 scripts=[urlsplit(s).path for s in parser.scripts]
 for m in MODULES:assert scripts.count(m)==1,('script missing or duplicated',m)
 assert [scripts.index(m) for m in MODULES]==sorted(scripts.index(m) for m in MODULES),'runtime order'
 # All local CSS/JS references in index must exist as well.
 local=[s for s in parser.assets if not urlsplit(s).scheme and not s.startswith('//')]
 names=list(dict.fromkeys([*MODULES,*local,'visual-style-fix.js','meteogram-visfog-cleanup.js']))
 with ThreadPoolExecutor(max_workers=6) as pool:contents=dict(zip(names,pool.map(get,names)))
 source=Path(__file__).resolve().parents[1]
 hashes={}
 for m in MODULES:
  body=contents[m];assert body and not body.lstrip().lower().startswith(b'<!doctype'),m
  hashes[m]=hashlib.sha256(body).hexdigest()
  if compare_source:assert body==(source/m).read_bytes(),('deployed JS differs from tested source',m)
 assert b'DZ* / RA*' in contents['meteogram-visfog-cleanup.js']
 assert b'PrognozaEPIRPrecipCompactInfo' in contents['visual-style-fix.js']
 assert b'PrognozaEPIRPrecipCompactInfo' in contents['meteogram-precip-compact-info.js']
 assert b'PrognozaEPIRPrecipIntelligence' in contents['meteogram-precipitation-intelligence.js']
 commit=None
 if expected_commit:
  commit=json.loads(get('pages-build.json'))['commit'];assert commit==expected_commit,(commit,expected_commit)
 return {'target':target,'passed':True,'commit':commit,'local_index_assets':len(local),'module_sha256':hashes}
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('target');p.add_argument('--expected-commit');p.add_argument('--compare-source',action='store_true');a=p.parse_args()
 print(json.dumps(verify(a.target,a.expected_commit,a.compare_source),indent=2))
