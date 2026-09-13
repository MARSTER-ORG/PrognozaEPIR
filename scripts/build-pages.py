#!/usr/bin/env python3
from __future__ import annotations
import os, re, shutil
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'_site'
SHA=os.environ.get('GITHUB_SHA','dev')[:12]
PAGES=('index.html','radar.html','taf.html','sat-fog.html','arch.html','lightning-alerts.html')
LEGACY_TAF={
 'taf-hybrid-engine.js','taf-hybrid-adapter.js','taf-generator-policy.js','taf-instruction-guard.js',
 'taf-cloud-policy.js','taf-weather-policy.js','taf-output-sanitizer.js','taf-radar-nowcast-sync.js',
 'taf-gust-policy.js','taf-cavok-nsc-policy.js'
}
REQUIRED={'taf-engine-v2.js','taf-app-v2.js','message-archive-client.js','utc-ui-guard.js','site-shell.css','site-shell.js'}
LEGACY_TOKENS=('taf-hybrid-engine.js','taf-hybrid-adapter.js','taf-generator-policy.js','taf-instruction-guard.js','TAF ENGINE 2.2')

if OUT.exists(): shutil.rmtree(OUT)
OUT.mkdir()

# Static client files. Retired TAF modules are explicitly excluded from production.
for p in ROOT.iterdir():
    if not p.is_file(): continue
    if p.name in LEGACY_TAF: continue
    if p.suffix.lower() in {'.html','.js','.css','.png','.svg','.ico','.webmanifest'}:
        shutil.copy2(p,OUT/p.name)

for rel in ('data/messages','data/learning'):
    src=ROOT/rel
    if src.exists(): shutil.copytree(src,OUT/rel,dirs_exist_ok=True)

# One shared navigation/theme layer is injected into every public page.
for name in PAGES:
    p=OUT/name
    if not p.exists(): raise SystemExit(f'missing canonical page: {name}')
    s=p.read_text(encoding='utf-8')
    if name == 'index.html':
        # Removed module no longer exists in the repository; leaving the tag caused a 404
        # on every page load and let historical layout code appear to be current.
        s=re.sub(r'\s*<script[^>]+src=["\']fog-summary-layout\.js(?:\?[^"\']*)?["\'][^>]*></script>\s*','\n',s,flags=re.I)
    if 'site-shell.css' not in s:
        s=s.replace('</head>',f'  <link rel="stylesheet" href="site-shell.css?v={SHA}">\n</head>',1)
    if 'site-shell.js' not in s:
        s=s.replace('</body>',f'  <script src="site-shell.js?v={SHA}"></script>\n</body>',1)
    p.write_text(s,encoding='utf-8')

# Deterministic TAF production runtime: exactly one engine/app pair.
t=OUT/'taf.html'; s=t.read_text(encoding='utf-8')
s=re.sub(r'<meta name="prognozaepir-taf-engine-v2" content="[^"]+">','<meta name="prognozaepir-taf-engine-v2" content="2.3.0">',s,count=1)
s=re.sub(r'taf-engine-v2\.js(?:\?v=[^"\']*)?',f'taf-engine-v2.js?v=2.3.0-{SHA}',s)
s=re.sub(r'taf-app-v2\.js(?:\?v=[^"\']*)?',f'taf-app-v2.js?v=2.3.0-{SHA}',s)
s=re.sub(r'src="index\.html(?:\?v=[^"]*)?"',f'src="index.html?v={SHA}"',s,count=1)
t.write_text(s,encoding='utf-8')

# message-archive-client historically contained a conditional loader for a retired TAF guard.
# Keep the archive/freshness watcher, remove the fallback runtime from the production artifact.
m=OUT/'message-archive-client.js'; ms=m.read_text(encoding='utf-8')
start=ms.find("    const RAW = 'https://raw.githubusercontent.com/MARSTER-ORG/PrognozaEPIR/main/';")
end=ms.find('    const tafArchiveSignature = payload => [',start)
if start >= 0 and end > start:
    ms=ms[:start]+ms[end:]
m.write_text(ms,encoding='utf-8')

# utc-ui-guard had accumulated an older global navigation/theme implementation and
# a loader for taf-generator-policy.js. Production keeps only UTC/radar guards;
# site-shell owns navigation and visual normalization.
u=OUT/'utc-ui-guard.js'; us=u.read_text(encoding='utf-8')
start=us.find('  function installGlobalNavigation() {')
end=us.find('  function loadRadarRiskPolicy() {',start)
if start >= 0 and end > start:
    us=us[:start]+us[end:]
u.write_text(us,encoding='utf-8')

for name in REQUIRED:
    if not (OUT/name).is_file(): raise SystemExit(f'missing required runtime asset: {name}')
for name in LEGACY_TAF:
    if (OUT/name).exists(): raise SystemExit(f'legacy TAF asset leaked to production: {name}')

# No public HTML/JS may reference a retired TAF runtime.
for p in [*OUT.glob('*.html'),*OUT.glob('*.js')]:
    text=p.read_text(encoding='utf-8')
    for token in LEGACY_TOKENS:
        if token in text: raise SystemExit(f'{p.name}: legacy token present: {token}')

# Validate local static references so stale subpage links cannot ship.
attr=re.compile(r'(?:href|src)=["\']([^"\']+)["\']',re.I)
missing=[]
for p in OUT.glob('*.html'):
    text=p.read_text(encoding='utf-8')
    for raw in attr.findall(text):
        ref=raw.split('#',1)[0].split('?',1)[0]
        if not ref or ref.startswith(('http://','https://','data:','mailto:','tel:','javascript:','//')): continue
        target=OUT/ref.lstrip('/')
        if not target.exists(): missing.append(f'{p.name} -> {raw}')
if missing: raise SystemExit('stale local references:\n'+'\n'.join(sorted(set(missing))))

print(f'Canonical Pages artifact ready: {len(list(OUT.iterdir()))} top-level items; TAF 2.3 only; UI shell {SHA}')
