#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def main():
    fog = (ROOT / "fog-engine.js").read_text(encoding="utf-8")
    prepare = (ROOT / "scripts" / "prepare_pages.py").read_text(encoding="utf-8")
    wire = (ROOT / "scripts" / "wire_fog_mifg_utc_runtime.py").read_text(encoding="utf-8")
    utc = (ROOT / "scripts" / "enforce_global_utc.py").read_text(encoding="utf-8")
    node_test = (ROOT / "tests" / "test_fog_vnext_probability_units.py").read_text(encoding="utf-8")
    taf = (ROOT / "taf-app-v25.js").read_text(encoding="utf-8")

    assert "window.PrognozaEPIRFogLegacySeries=" in fog
    assert "window.PrognozaEPIRFogSeries=" in fog
    assert "timeZone:'UTC'" in fog
    assert "function parseLocalInput(v){return v?Date.parse(/[zZ]|[+-]\\d\\d:\\d\\d$/.test(v)?v:v+'Z'):NaN;}" in fog
    assert 'old = "fogSeries=out;renderFog();"' not in prepare
    assert 's = s.replace("timeZone:PLACE.tz"' not in wire
    assert "legacy_export = (" not in wire
    assert "'_site'" in utc.split("SKIP_DIRS =", 1)[1].split("\n", 1)[0]
    assert 'shutil.which("node") or shutil.which("nodejs")' in node_test
    assert "APP_ENGINE_VERSION='2.4.3'" in taf
    print("Stage 2 stability contracts: OK")

if __name__ == "__main__":
    main()
