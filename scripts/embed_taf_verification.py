#!/usr/bin/env python3
from pathlib import Path

HTML = Path('taf.html')
JS = Path('taf-verification.js')

html = HTML.read_text(encoding='utf-8')
js = JS.read_text(encoding='utf-8').strip()
if "const VERSION='TAF Verification v2.0'" not in js:
    raise SystemExit('taf-verification.js is not TAF Verification v2.0')

# These are stable verification semantics. Keep this tiny normalization here,
# but do not re-apply historical live-refresh/archive patches: those belong to
# fix_taf_verification_live_archive.py and are enforced before embedding.
js = js.replace(
    "final:Date.now()>=p.ve+30*60e3",
    "final:Date.now()>=p.ve",
)
if "final:Date.now()>=p.ve" not in js:
    raise SystemExit('TAF verification final-at-validity-end invariant missing')
if "e.p.ve>target&&e.p.vs<end" not in js:
    raise SystemExit('TAF verification validity-day overlap invariant missing')
if "let tafVerifyBusy=false;async function refreshDay(silent=false)" not in js:
    raise SystemExit('TAF verification live refresh guard missing')
if "setInterval(()=>" not in js or "visibilitychange" not in js:
    raise SystemExit('TAF verification live refresh timer missing')
if "A.getLatest('TAF','EPIR',true)" not in js:
    raise SystemExit('TAF verification current EPIR TAF MessageArchive read missing')
if "central-ingestor-production.up.railway.app/data/messages/" not in js:
    raise SystemExit('TAF verification Railway archive transport missing')
if js.count("function centralDayUrls(kind,day)") != 1:
    raise SystemExit('TAF verification centralDayUrls must exist exactly once')

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
print('Embedded TAF Verification v2.0 from live-archive source into taf.html')
