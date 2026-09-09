from pathlib import Path

p = Path('.github/workflows/pages.yml')
s = p.read_text(encoding='utf-8')

old_block = """              if name == 'fog-engine.js':
                  old='fogSeries=out;renderFog();'
                  new=\"fogSeries=out;window.PrognozaEPIRFogSeries=fogSeries;window.dispatchEvent(new CustomEvent('prognozaepir:fog-series-updated',{detail:{count:fogSeries.length}}));renderFog();\"
                  if old not in s:
                      raise SystemExit('Fog Engine series export hook not found')
                  s=s.replace(old,new,1)
"""
new_block = """              if name == 'fog-engine.js':
                  old='fogSeries=out;renderFog();'
                  exported='window.PrognozaEPIRFogSeries=fogSeries'
                  if exported not in s:
                      new=\"fogSeries=out;window.PrognozaEPIRFogSeries=fogSeries;window.dispatchEvent(new CustomEvent('prognozaepir:fog-series-updated',{detail:{count:fogSeries.length}}));renderFog();\"
                      if old not in s:
                          raise SystemExit('Fog Engine series export hook not found')
                      s=s.replace(old,new,1)
"""

if old_block not in s and "exported='window.PrognozaEPIRFogSeries=fogSeries'" not in s:
    raise SystemExit('Pages fog export build block not found')
if old_block in s:
    s = s.replace(old_block, new_block, 1)

s = s.replace(
    'grep -F "EPIR FOG ENGINE v1.2" _site/fog-engine.js',
    'grep -F "EPIR FOG ENGINE v1.3" _site/fog-engine.js',
    1,
)

marker = '          grep -F "FOG_DRAW_THRESHOLD = 40" _site/fog-meteogram-overlay.js\n'
extra = (
    '          grep -F "FOG_DRAW_THRESHOLD = 40" _site/fog-meteogram-overlay.js\n'
    '          grep -F "if(s<40)return \'NIE\';" _site/fog-engine.js\n'
    '          grep -F "if(s<60)return \'MOŻLIWA\';" _site/fog-engine.js\n'
    '          grep -F "if(s<80)return \'PRAWDOPODOBNA\';" _site/fog-engine.js\n'
    '          grep -F "return \'BARDZO PRAWDOPODOBNA\';" _site/fog-engine.js\n'
    '          grep -F "MGŁA — OPERACYJNIE" _site/fog-engine.js\n'
)
if "grep -F \"MGŁA — OPERACYJNIE\" _site/fog-engine.js" not in s:
    if marker not in s:
        raise SystemExit('Pages fog verifier marker not found')
    s = s.replace(marker, extra, 1)

p.write_text(s, encoding='utf-8')
