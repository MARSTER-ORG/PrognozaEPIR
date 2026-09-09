#!/usr/bin/env python3
"""Keep short weak precipitation out of the operational TAF text.

The hourly analysis may still show an isolated -RA/-DZ/-SN cell.  Such a
single-hour weak-precipitation signal is too short and too low-impact to become
prevailing TAF weather.  The generator therefore requires at least two
consecutive hourly weak-precipitation cells before that weather is eligible for
the TAF.  The analysis table remains raw/diagnostic.
"""
from pathlib import Path

P = Path('taf.html')
s = P.read_text(encoding='utf-8')

HELPER = """const TAF_WEAK_WX_MIN_HOURS=2;function weakTafWxCode(w){return /^-(?:RA|DZ|SN)$/.test(String(w||''))}function applyTafWxSignificance(a){let raw=a.map(z=>wx(z));for(let i=0;i<a.length;i++){let w=raw[i];if(!weakTafWxCode(w)){a[i].tafWx=w;continue}let l=i,r=i;while(l>0&&weakTafWxCode(raw[l-1])&&a[l].t-a[l-1].t<=54e5)l--;while(r+1<a.length&&weakTafWxCode(raw[r+1])&&a[r+1].t-a[r].t<=54e5)r++;let hours=(a[r].t-a[l].t)/36e5+1;a[i].tafWx=hours>=TAF_WEAK_WX_MIN_HOURS?w:''}return a}function tafWx(z){return Object.prototype.hasOwnProperty.call(z,'tafWx')?z.tafWx:wx(z)}"""

if 'TAF_WEAK_WX_MIN_HOURS=2' not in s:
    anchor = 'function cg(z){'
    if anchor not in s:
        raise SystemExit('TAF weak WX: cg anchor not found')
    s = s.replace(anchor, HELPER + anchor, 1)

old_state = "function state(z){let w=wx(z),cl=cg(z);if(z.VIS>=10000&&!w&&!lowCloud(z))return ewin(z)+' CAVOK';return [ewin(z),evis(z.VIS),w,cl].filter(Boolean).join(' ')}"
new_state = "function state(z){let w=tafWx(z),cl=cg(z);if(z.VIS>=10000&&!w&&!lowCloud(z))return ewin(z)+' CAVOK';return [ewin(z),evis(z.VIS),w,cl].filter(Boolean).join(' ')}"
if old_state in s:
    s = s.replace(old_state, new_state, 1)
elif new_state not in s:
    raise SystemExit('TAF weak WX: state anchor not found')

old_sigwx = "function sigwx(z){let w=wx(z);return /MIFG|FZ|TS|(^|\\s)[+]?RA|[+]?SN|SHRA|SHSN|FG/.test(w)&&!/^-(RA|SN|DZ)$/.test(w)}"
new_sigwx = "function sigwx(z){let w=tafWx(z);return /MIFG|FZ|TS|(^|\\s)[+]?RA|[+]?SN|SHRA|SHSN|FG/.test(w)&&!/^-(RA|SN|DZ)$/.test(w)}"
if old_sigwx in s:
    s = s.replace(old_sigwx, new_sigwx, 1)
elif new_sigwx not in s:
    raise SystemExit('TAF weak WX: sigwx anchor not found')

old_diff = "if(sigwx(a)!==sigwx(b)||((wx(a)||'')!==(wx(b)||'')&&(sigwx(a)||sigwx(b))))f.push('pogoda');"
new_diff = "if(sigwx(a)!==sigwx(b)||((tafWx(a)||'')!==(tafWx(b)||'')&&(sigwx(a)||sigwx(b))))f.push('pogoda');"
if old_diff in s:
    s = s.replace(old_diff, new_diff, 1)
elif new_diff not in s:
    raise SystemExit('TAF weak WX: diff weather anchor not found')

old_payload = "function payload(z,f){let a=[];if(f.includes('wiatr'))a.push(ewin(z));let met=f.some(x=>x!=='wiatr');if(met&&z.VIS>=10000&&!wx(z)&&!lowCloud(z))return [...a,'CAVOK'].join(' ');if(f.includes('widzialność')){a.push(evis(z.VIS));if(wx(z))a.push(wx(z))}if(f.includes('pogoda'))a.push(wx(z)||'NSW');if(f.includes('pułap'))a.push(cg(z));return [...new Set(a)].join(' ')}"
new_payload = "function payload(z,f){let a=[],tw=tafWx(z);if(f.includes('wiatr'))a.push(ewin(z));let met=f.some(x=>x!=='wiatr');if(met&&z.VIS>=10000&&!tw&&!lowCloud(z))return [...a,'CAVOK'].join(' ');if(f.includes('widzialność')){a.push(evis(z.VIS));if(tw)a.push(tw)}if(f.includes('pogoda'))a.push(tw||'NSW');if(f.includes('pułap'))a.push(cg(z));return [...new Set(a)].join(' ')}"
if old_payload in s:
    s = s.replace(old_payload, new_payload, 1)
elif new_payload not in s:
    raise SystemExit('TAF weak WX: payload anchor not found')

old_rows = "rows=addUpstream(anchor(ed.period,ed.modelNow));"
new_rows = "rows=applyTafWxSignificance(addUpstream(anchor(ed.period,ed.modelNow)));"
if old_rows in s:
    s = s.replace(old_rows, new_rows, 1)
elif new_rows not in s:
    raise SystemExit('TAF weak WX: rows preprocessing anchor not found')

required = [
    'TAF_WEAK_WX_MIN_HOURS=2',
    'function applyTafWxSignificance(a)',
    "function tafWx(z)",
    'let w=tafWx(z),cl=cg(z)',
    'let a=[],tw=tafWx(z)',
    'rows=applyTafWxSignificance(addUpstream(anchor(ed.period,ed.modelNow)))',
    "$('hours').innerHTML=rows.map(z=>",  # raw analysis table remains separate
    "<td>${wx(z)||'—'}</td>",            # and still displays the raw hourly WX
]
for token in required:
    if token not in s:
        raise SystemExit(f'TAF weak WX: required invariant missing: {token}')

P.write_text(s, encoding='utf-8')
print('TAF generator: isolated one-hour weak precipitation is excluded from TAF text')
