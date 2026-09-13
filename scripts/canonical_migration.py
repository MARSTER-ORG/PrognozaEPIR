#!/usr/bin/env python3
from pathlib import Path
import re

# TAF 2.3.1: a probability group that improves visibility while prevailing
# FG/BR exists must explicitly terminate the old weather with NSW.
p=Path('taf-engine-v2.js'); s=p.read_text(encoding='utf-8')
s=s.replace("const VERSION='2.3.0';","const VERSION='2.3.1';",1)
s=s.replace("const NAME='TAF Engine 2.3 — Instruction First + EPIR Operational Policy';","const NAME='TAF Engine 2.3.1 — Instruction First + EPIR Operational Policy';",1)
old="""    } else if((fields.includes('visibility')||kind.startsWith('PROB30'))&&newWx)out.push(newWx);
"""
new="""    } else if(fields.includes('visibility')||kind.startsWith('PROB30')){
      if(newWx)out.push(newWx);
      else if(oldWx)out.push('NSW');
    }
"""
if old not in s and new not in s: raise SystemExit('taf-engine payload anchor not found')
s=s.replace(old,new,1)
anchor="""      if(/^TEMPO\\b/.test(line)){
        const wx=(line.match(/\\b(?:FZFG|FG|BR)\\b/)||[])[0]||'NONE';
        if((wx==='FG'||wx==='FZFG')&&prevailingFog!=='FG')errors.push(`TEMPO nie może prognozować pojawienia się FG: ${line}`);
        if(wx==='BR'&&prevailingFog!=='BR')errors.push(`TEMPO nie może prognozować pojawienia się BR: ${line}`);
      }
"""
addition=anchor+"""      if(/^PROB30\\b/.test(line)&&prevailingFog!=='NONE'&&/\\b(?:9999|[0-9]{4})\\b/.test(line)&&!/\\b(?:FZFG|FG|BR|NSW|CAVOK|DZ|RA|SN|SG|PL|FZDZ|FZRA|SHRA|SHSN|TS|TSRA|HZ|FU|DU|SA)\\b/.test(line)){
        errors.push(`PROB30 zmienia widzialność przy przeważającym ${prevailingFog}, ale nie określa zmiany zjawiska: ${line}`);
      }
"""
if addition not in s:
    if anchor not in s: raise SystemExit('taf-engine validator anchor not found')
    s=s.replace(anchor,addition,1)
p.write_text(s,encoding='utf-8')

# Version tags and visible label.
p=Path('taf.html'); s=p.read_text(encoding='utf-8')
s=s.replace('content="2.3.0"','content="2.3.1"')
s=s.replace('TAF ENGINE 2.3.0 · INSTRUCTION FIRST','TAF ENGINE 2.3.1 · INSTRUCTION FIRST')
s=s.replace('taf-engine-v2.js?v=2.3.0','taf-engine-v2.js?v=2.3.1')
s=s.replace('taf-app-v2.js?v=2.3.0','taf-app-v2.js?v=2.3.1')
p.write_text(s,encoding='utf-8')

# Regression tests, including the exact semantic failure visible in production.
p=Path('tests/taf-engine-v2.test.js'); s=p.read_text(encoding='utf-8')
s=s.replace("assert.equal(E.ENGINE_VERSION,'2.3.0');","assert.equal(E.ENGINE_VERSION,'2.3.1');")
marker="""assert.equal(E.validateTaf('TAF EPIR 132300Z 1400/1412 27004KT 0800 FG OVC004 TEMPO 1404/1406 0400 FG OVC002=',{issue,start,end}).ok,true);
"""
extra=marker+"""assert.equal(E.validateTaf('TAF EPIR 132300Z 1400/1412 VRB02KT 0900 FG FEW002 PROB30 1407/1409 9999=',{issue,start,end}).ok,false,'bare PROB30 visibility improvement may not silently retain prevailing FG');
"""
if extra not in s:
    if marker not in s: raise SystemExit('TAF regression test anchor not found')
    s=s.replace(marker,extra,1)
insert="""
// When prevailing FG ceases only probabilistically, the group must explicitly carry NSW.
rows=Array.from({length:12},(_,i)=>row(i,{vis:i<5?900:9999,fgRisk:i<5?70:(i===7?35:0),fogRisk:i<5?70:(i===7?35:0),fogAltVisM:800}));
r=gen(rows);for(const line of r.taf.split(/\\n/)){if(/^PROB30\\b/.test(line)&&/\\b9999\\b/.test(line))assert.match(line,/\\bNSW\\b|\\b(?:RA|DZ|SN|FG|BR)\\b/,line);}
"""
hook="""// PROB30 BR: one 2h probability window, never duplicate TEMPO/BECMG for the same event.
"""
if insert.strip() not in s:
    if hook not in s: raise SystemExit('TAF PROB30 test hook not found')
    s=s.replace(hook,insert+'\n'+hook,1)
s=s.replace("assert.ok(html.includes('taf-engine-v2.js?v=2.3.0'));assert.ok(html.includes('taf-app-v2.js?v=2.3.0'));","assert.ok(html.includes('taf-engine-v2.js?v=2.3.1'));assert.ok(html.includes('taf-app-v2.js?v=2.3.1'));")
s=s.replace('TAF Engine 2.3 tests: OK','TAF Engine 2.3.1 tests: OK')
p.write_text(s,encoding='utf-8')

# Remove one confirmed 404 asset from the canonical source.
p=Path('index.html'); s=p.read_text(encoding='utf-8')
s=re.sub(r'\s*<script[^>]+src=["\']fog-summary-layout\.js(?:\?[^"\']*)?["\'][^>]*></script>\s*','\n',s,flags=re.I)
p.write_text(s,encoding='utf-8')

# Remove obsolete TAF fallback loader from the source archive client.
p=Path('message-archive-client.js'); s=p.read_text(encoding='utf-8')
a=s.find("    const RAW = 'https://raw.githubusercontent.com/MARSTER-ORG/PrognozaEPIR/main/';")
b=s.find('    const tafArchiveSignature = payload => [',a)
if a>=0 and b>a: s=s[:a]+s[b:]
p.write_text(s,encoding='utf-8')

# UTC guard no longer owns global navigation/styles or any TAF policy loader.
p=Path('utc-ui-guard.js'); s=p.read_text(encoding='utf-8')
a=s.find('  function installGlobalNavigation() {')
b=s.find('  function loadRadarRiskPolicy() {',a)
if a>=0 and b>a: s=s[:a]+s[b:]
p.write_text(s,encoding='utf-8')

# Purge retired policy/mutator modules; TAF 2.3.1 is the only production engine.
for name in [
    'taf-cloud-policy.js','taf-weather-policy.js','taf-output-sanitizer.js',
    'taf-radar-nowcast-sync.js','taf-gust-policy.js','taf-cavok-nsc-policy.js'
]:
    Path(name).unlink(missing_ok=True)

print('Canonical source migration applied.')
