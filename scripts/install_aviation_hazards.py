#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Extend the server-side model snapshot with the vertical fields required by
# icing and turbulence diagnostics. Unsupported fields are salvaged by the
# existing fetch_resilient() path, so one model cannot break the ensemble.
p = ROOT / 'scripts' / 'build_model_snapshot.py'
s = p.read_text(encoding='utf-8')
s = s.replace(
    'COMMON_LEVELS = [1000, 925, 850, 700, 500, 300, 200]',
    'COMMON_LEVELS = [1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 275, 250, 200]'
)
s = s.replace(
    'ALADIN_LEVELS = [1000, 950, 925, 850, 700, 500, 300, 250, 200]',
    'ALADIN_LEVELS = [1000, 950, 925, 850, 800, 700, 600, 500, 450, 400, 350, 300, 275, 250, 200]'
)
old = '        out += [f"cloud_cover_{p}hPa", f"relative_humidity_{p}hPa", f"geopotential_height_{p}hPa"]'
new = '''        out += [
            f"temperature_{p}hPa",
            f"relative_humidity_{p}hPa",
            f"cloud_cover_{p}hPa",
            f"wind_speed_{p}hPa",
            f"wind_direction_{p}hPa",
            f"vertical_velocity_{p}hPa",
            f"geopotential_height_{p}hPa",
        ]'''
if old in s:
    s = s.replace(old, new, 1)
elif 'f"vertical_velocity_{p}hPa"' not in s:
    raise SystemExit('profile_variables hook not found')
p.write_text(s, encoding='utf-8')

# Append the independently maintained browser module to a bundle that the Pages
# workflow already copies and loads. This keeps the deploy pipeline unchanged.
module = (ROOT / 'aviation-hazards.js').read_text(encoding='utf-8').strip()
target = ROOT / 'warnings-readable.js'
w = target.read_text(encoding='utf-8').rstrip()
marker = 'window.__PrognozaEPIRAviationHazardsV1'
if marker not in w:
    w += '\n\n' + module + '\n'
    target.write_text(w, encoding='utf-8')

print('aviation hazards installed')
