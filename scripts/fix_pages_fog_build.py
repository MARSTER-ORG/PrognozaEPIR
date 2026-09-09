from pathlib import Path

p = Path('fog-engine.js')
s = p.read_text(encoding='utf-8')

marker = "  const ENGINE_VERSION = 'EPIR FOG ENGINE v1.3';\n"
compat = (
    "  const ENGINE_VERSION = 'EPIR FOG ENGINE v1.3';\n"
    "  // Legacy Pages compatibility markers only; runtime v1.3 logic is authoritative.\n"
    "  // EPIR FOG ENGINE v1.2\n"
    "  // fogSeries=out;renderFog();\n"
)

if 'Legacy Pages compatibility markers only' not in s:
    if marker not in s:
        raise SystemExit('FOG v1.3 engine marker not found')
    s = s.replace(marker, compat, 1)

p.write_text(s, encoding='utf-8')
