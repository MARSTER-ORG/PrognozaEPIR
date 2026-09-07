#!/usr/bin/env python3
from pathlib import Path

HTML = Path('taf.html')
JS = Path('taf-verification.js')

html = HTML.read_text(encoding='utf-8')
js = JS.read_text(encoding='utf-8').strip()
if "const VERSION='TAF Verification v2.0'" not in js:
    raise SystemExit('taf-verification.js is not TAF Verification v2.0')

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
print('Embedded TAF Verification v2.0 into taf.html')
