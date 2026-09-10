#!/usr/bin/env python3
from pathlib import Path

# This installer is intentionally idempotent; touching it also gives Pages an
# explicit user-authored deploy trigger after workflow-generated code changes.
ROOT = Path(__file__).resolve().parents[1]
FILES = [ROOT / 'aviation-hazards.js', ROOT / 'warnings-readable.js']

label_fn = """  function probabilityLabel(p){
    p=Math.round(Number(p)||0);
    if(p<20)return'brak istotnego sygnału';
    if(p<40)return'możliwe';
    if(p<60)return'prawdopodobne';
    if(p<80)return'bardzo prawdopodobne';
    return'niemal pewne';
  }
"""

for path in FILES:
    s = path.read_text(encoding='utf-8')

    anchor = "  function riskClass(p){return p>=75?'high':p>=50?'mid':'low';}\n"
    if 'function probabilityLabel(p)' not in s:
        if anchor not in s:
            raise SystemExit(f'riskClass hook not found in {path.name}')
        s = s.replace(anchor, anchor + label_fn, 1)

    old = "    $(kind+'Now').textContent=now?Math.round(now.prob)+'%':'—';$(kind+'NowSub').textContent=now?`${isIce?icingIntensity(now.sev,now.prob):turbIntensity(now.sev,now.prob)} · ${fmtHeight(now.band.lo,now.band.hi)}`:'—';"
    new = "    $(kind+'Now').textContent=now?`${Math.round(now.prob)}% · ${probabilityLabel(now.prob)}`:'—';$(kind+'NowSub').textContent=now?`${isIce?icingIntensity(now.sev,now.prob):turbIntensity(now.sev,now.prob)} · ${fmtHeight(now.band.lo,now.band.hi)}`:'—';"
    if old in s:
        s = s.replace(old, new, 1)
    elif "probabilityLabel(now.prob)" not in s:
        raise SystemExit(f'Now probability hook not found in {path.name}')

    old = "    $(kind+'Peak').textContent=Math.round(peak.prob)+'%';$(kind+'PeakSub').textContent=fmtUtc(peak.time);"
    new = "    $(kind+'Peak').textContent=`${Math.round(peak.prob)}% · ${probabilityLabel(peak.prob)}`;$(kind+'PeakSub').textContent=fmtUtc(peak.time);"
    if old in s:
        s = s.replace(old, new, 1)
    elif "probabilityLabel(peak.prob)" not in s:
        raise SystemExit(f'Peak probability hook not found in {path.name}')

    old = '<b>${Math.round(p.prob)}%</b><span>${intensity}</span>'
    new = '<b>${Math.round(p.prob)}% · ${probabilityLabel(p.prob)}</b><span>${intensity}</span>'
    if old in s:
        s = s.replace(old, new, 1)
    elif 'probabilityLabel(p.prob)' not in s:
        raise SystemExit(f'Window probability hook not found in {path.name}')

    # Give the probability + text label enough room in the hourly rows.
    s = s.replace('grid-template-columns:120px 85px 115px 1fr',
                  'grid-template-columns:120px 130px 115px 1fr', 1)
    s = s.replace('.avh-window{grid-template-columns:1fr 80px}',
                  '.avh-window{grid-template-columns:1fr 125px}', 1)

    path.write_text(s, encoding='utf-8')

print('hazard probability labels installed')