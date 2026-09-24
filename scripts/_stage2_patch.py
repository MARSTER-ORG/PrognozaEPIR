#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    if new in text:
        return
    if old not in text:
        raise SystemExit(f"{label}: expected source marker not found in {path}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


# I-15: do not assume that the executable is literally named `node`.
p = ROOT / "tests" / "test_fog_vnext_probability_units.py"
s = p.read_text(encoding="utf-8")
if "NODE = shutil.which" not in s:
    s = s.replace("import json\nimport subprocess\n", "import json\nimport shutil\nimport subprocess\n", 1)
    s = s.replace(
        'EVAL = ROOT / "scripts" / "fog_vnext_eval.js"\n',
        'EVAL = ROOT / "scripts" / "fog_vnext_eval.js"\nNODE = shutil.which("node") or shutil.which("nodejs")\n',
        1,
    )
    s = s.replace(
        'def main():\n    sample = [{',
        'def main():\n    if not NODE:\n        raise RuntimeError("Node.js executable not found (tried node/nodejs)")\n    sample = [{',
        1,
    )
    s = s.replace('["node", str(EVAL)]', '[NODE, str(EVAL)]', 1)
p.write_text(s, encoding="utf-8")

# I-19: UTC validation is a source check; generated _site is validated separately.
p = ROOT / "scripts" / "enforce_global_utc.py"
s = p.read_text(encoding="utf-8")
if "'_site'" not in s.split("SKIP_DIRS =", 1)[1].split("\n", 1)[0]:
    s = s.replace(
        "SKIP_DIRS = {'.git', '.github', 'node_modules', 'data'}",
        "SKIP_DIRS = {'.git', '.github', 'node_modules', 'data', '_site'}",
        1,
    )
p.write_text(s, encoding="utf-8")

# I-06/I-07: the source Fog provider owns the UTC input semantics and LEGACY export.
p = ROOT / "fog-engine.js"
s = p.read_text(encoding="utf-8")
s = s.replace("timeZone:PLACE.tz", "timeZone:'UTC'")
s = s.replace(
    "function parseLocalInput(v){return v?Date.parse(v):NaN;}",
    "function parseLocalInput(v){return v?Date.parse(/[zZ]|[+-]\\d\\d:\\d\\d$/.test(v)?v:v+'Z'):NaN;}",
)
legacy_line = (
    "    fogSeries=out;"
    "window.PrognozaEPIRFogLegacySeries=fogSeries.map(h=>({...h,models:Array.isArray(h?.models)?h.models.map(m=>({...m,components:m?.components?{...m.components}:m?.components})):h?.models,fogEngineMode:'legacy',fogEngineSource:'legacy'}));"
    "window.PrognozaEPIRFogSeries=fogSeries;renderFog();"
    "window.dispatchEvent(new CustomEvent('prognozaepir:fog-series-updated'));"
)
old_line = "    fogSeries=out;window.PrognozaEPIRFogSeries=fogSeries;renderFog();window.dispatchEvent(new CustomEvent('prognozaepir:fog-series-updated'));"
if "window.PrognozaEPIRFogLegacySeries=" not in s:
    if old_line not in s:
        raise SystemExit("fog-engine.js: executable Fog export marker not found")
    s = s.replace(old_line, legacy_line, 1)
p.write_text(s, encoding="utf-8")

# Build must validate the source contract instead of creating it in _site.
p = ROOT / "scripts" / "prepare_pages.py"
s = p.read_text(encoding="utf-8")
old = '''        if name == "fog-engine.js" and "PrognozaEPIRFogSeries" not in x:\n            old = "fogSeries=out;renderFog();"\n            new = "fogSeries=out;window.PrognozaEPIRFogSeries=fogSeries;window.dispatchEvent(new CustomEvent('prognozaepir:fog-series-updated',{detail:{count:fogSeries.length}}));renderFog();"\n            if old not in x:\n                raise RuntimeError("FOG series export hook missing")\n            x = x.replace(old, new, 1)\n'''
new = '''        if name == "fog-engine.js":\n            for marker in ("PrognozaEPIRFogLegacySeries", "PrognozaEPIRFogSeries", "prognozaepir:fog-series-updated"):\n                if marker not in x:\n                    raise RuntimeError(f"source FOG export contract missing: {marker}")\n'''
if old in s:
    s = s.replace(old, new, 1)
elif new not in s:
    raise SystemExit("prepare_pages.py: Fog build-mutation block not found")
p.write_text(s, encoding="utf-8")

p = ROOT / "scripts" / "wire_fog_mifg_utc_runtime.py"
s = p.read_text(encoding="utf-8")
old = '''    s = s.replace("timeZone:PLACE.tz", "timeZone:'UTC'")\n    old_parse = "function parseLocalInput(v){return v?Date.parse(v):NaN;}"\n    if old_parse in s:\n        s = s.replace(\n            old_parse,\n            "function parseLocalInput(v){return v?Date.parse(/[zZ]|[+-]\\\\d\\\\d:\\\\d\\\\d$/.test(v)?v:v+'Z'):NaN;}",\n            1,\n        )\n\n    if "PrognozaEPIRFogLegacySeries" not in s:\n        active_export = "fogSeries=out;window.PrognozaEPIRFogSeries=fogSeries;"\n        legacy_export = (\n            "fogSeries=out;"\n            "window.PrognozaEPIRFogLegacySeries=fogSeries.map(h=>({...h,models:Array.isArray(h?.models)?h.models.map(m=>({...m,components:m?.components?{...m.components}:m?.components})):h?.models,fogEngineMode:'legacy',fogEngineSource:'legacy'}));"\n            "window.PrognozaEPIRFogSeries=fogSeries;"\n        )\n        if active_export not in s:\n            raise SystemExit("FOG active series export marker not found")\n        s = s.replace(active_export, legacy_export, 1)\n'''
new = '''    required = (\n        "timeZone:'UTC'",\n        "function parseLocalInput(v){return v?Date.parse(/[zZ]|[+-]\\\\d\\\\d:\\\\d\\\\d$/.test(v)?v:v+'Z'):NaN;}",\n        "PrognozaEPIRFogLegacySeries",\n        "PrognozaEPIRFogSeries",\n    )\n    for marker in required:\n        if marker not in s:\n            raise SystemExit(f"source FOG provider contract missing before build: {marker}")\n'''
if old in s:
    s = s.replace(old, new, 1)
elif new not in s:
    raise SystemExit("wire_fog_mifg_utc_runtime.py: source-mutation block not found")
p.write_text(s, encoding="utf-8")

# Persistent Stage 2 regression contract.
test = ROOT / "tests" / "test_stage2_stability_contracts.py"
test.write_text('''#!/usr/bin/env python3\nfrom pathlib import Path\n\nROOT = Path(__file__).resolve().parents[1]\n\ndef main():\n    fog = (ROOT / "fog-engine.js").read_text(encoding="utf-8")\n    prepare = (ROOT / "scripts" / "prepare_pages.py").read_text(encoding="utf-8")\n    wire = (ROOT / "scripts" / "wire_fog_mifg_utc_runtime.py").read_text(encoding="utf-8")\n    utc = (ROOT / "scripts" / "enforce_global_utc.py").read_text(encoding="utf-8")\n    node_test = (ROOT / "tests" / "test_fog_vnext_probability_units.py").read_text(encoding="utf-8")\n    taf = (ROOT / "taf-app-v25.js").read_text(encoding="utf-8")\n\n    assert "window.PrognozaEPIRFogLegacySeries=" in fog\n    assert "window.PrognozaEPIRFogSeries=" in fog\n    assert "timeZone:'UTC'" in fog\n    assert "function parseLocalInput(v){return v?Date.parse(/[zZ]|[+-]\\\\d\\\\d:\\\\d\\\\d$/.test(v)?v:v+'Z'):NaN;}" in fog\n    assert 'old = "fogSeries=out;renderFog();"' not in prepare\n    assert 's = s.replace("timeZone:PLACE.tz"' not in wire\n    assert "legacy_export = (" not in wire\n    assert "'_site'" in utc.split("SKIP_DIRS =", 1)[1].split("\\n", 1)[0]\n    assert 'shutil.which("node") or shutil.which("nodejs")' in node_test\n    assert "APP_ENGINE_VERSION='2.4.3'" in taf\n    print("Stage 2 stability contracts: OK")\n\nif __name__ == "__main__":\n    main()\n''', encoding="utf-8")

print("Stage 2 patch applied")
