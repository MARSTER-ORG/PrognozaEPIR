#!/usr/bin/env python3
from pathlib import Path

HTML = Path('taf.html')
JS = Path('taf-verification.js')


def patch_once(text: str, old: str, new: str, name: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise SystemExit(f'TAF verification patch target missing: {name}')
    return text.replace(old, new, 1)


html = HTML.read_text(encoding='utf-8')
js = JS.read_text(encoding='utf-8').strip()
if "const VERSION='TAF Verification v2.0'" not in js:
    raise SystemExit('taf-verification.js is not TAF Verification v2.0')

# A TAF belongs to every UTC day it overlaps, not only to the day on which
# its validity starts. This keeps cross-midnight issues visible and scored.
js = patch_once(
    js,
    "filter(e=>e.p.vs>=target&&e.p.vs<end)",
    "filter(e=>e.p.ve>target&&e.p.vs<end)",
    'validity-day overlap',
)

# Finalize exactly at validity end. A newer TAF does not replace the previous
# verification; both remain independent until their own validity ends.
js = patch_once(
    js,
    "final:Date.now()>=p.ve+30*60e3",
    "final:Date.now()>=p.ve",
    'final at validity end',
)

# Keep the current UTC day live. The five-minute backend archive adds a new
# issue as a separate record; the open page notices it without manual reload.
js = patch_once(
    js,
    "async function refreshDay(){\n    installPanel();const day=$('tafVerifyDay')?.value;if(!day)return;\n    $('tafDayBusy').textContent='Ładowanie archiwum TAF i METAR…';\n    $('tafDayRows').innerHTML='<tr><td colspan=\"9\">Liczenie…</td></tr>';$('tafDayDetails').innerHTML='';",
    "let tafVerifyBusy=false;async function refreshDay(silent=false){\n    silent=silent===true;if(tafVerifyBusy)return;installPanel();const day=$('tafVerifyDay')?.value;if(!day)return;tafVerifyBusy=true;\n    if(!silent){$('tafDayBusy').textContent='Ładowanie archiwum TAF i METAR…';$('tafDayRows').innerHTML='<tr><td colspan=\"9\">Liczenie…</td></tr>';$('tafDayDetails').innerHTML='';}",
    'live refresh guard',
)
js = patch_once(
    js,
    "}finally{$('tafDayBusy').textContent=VERSION+' · dane TAF tylko do weryfikacji'}",
    "}finally{tafVerifyBusy=false;$('tafDayBusy').textContent=VERSION+' · auto 60 s · dane TAF tylko do weryfikacji'}",
    'live refresh finally',
)
js = patch_once(
    js,
    "function start(){installPanel();refreshDay()}",
    "function start(){installPanel();refreshDay();setInterval(()=>{if(!document.hidden&&$('tafVerifyDay')?.value===utcDate(Date.now()))refreshDay(true)},60000);document.addEventListener('visibilitychange',()=>{if(!document.hidden&&$('tafVerifyDay')?.value===utcDate(Date.now()))refreshDay(true)})}",
    'live refresh timer',
)

JS.write_text(js + '\n', encoding='utf-8')

marker = '/* TAF Verification '
start = html.rfind('<script>\n' + marker)
if start < 0:
    start = html.rfind('<script>\r\n' + marker)
if start < 0:
    raise SystemExit('TAF Verification inline marker not found in taf.html')
end = html.find('</script>', start)
if end < 0:
    raise SystemExit('closing </script> for TAF Verification not found')
end += len('</script>')

block = '<script>\n/* TAF Verification v2.0 inline — generated from taf-verification.js */\n' + js + '\n</script>'
updated = html[:start] + block + html[end:]
HTML.write_text(updated, encoding='utf-8')
print('Patched and embedded TAF Verification v2.0 into taf.html')
