#!/usr/bin/env python3
"""Wire the deployed FOG/BR/MIFG runtime and production Fog Engine vNext bridge.

Archive routing is owned solely by message-archive-client.js. This build step
normalizes FOG/MIFG display/input clock semantics to UTC, keeps the operational
fog logic available to the meteogram, and keeps the full EPIR FOG interface on
a dedicated fog.html page. BR is a separate target/state shared by LEGACY and
vNEXT, not a fifth fog mechanism.
"""
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "_site"
ASSET_V = os.environ.get("GITHUB_SHA", "dev")[:12]


def patch_fog() -> None:
    p = SITE / "fog-engine.js"
    s = p.read_text(encoding="utf-8")
    old_hour = """  function localHour(t){
    try{return new Intl.DateTimeFormat('pl-PL',{timeZone:PLACE.tz,hour:'2-digit',minute:'2-digit'}).format(new Date(t));}
    catch(_){return new Date(t).toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'});}
  }"""
    new_hour = """  function localHour(t){
    try{return new Intl.DateTimeFormat('pl-PL',{timeZone:'UTC',hour:'2-digit',minute:'2-digit'}).format(new Date(t))+' UTC';}
    catch(_){return String(new Date(t).getUTCHours()).padStart(2,'0')+':'+String(new Date(t).getUTCMinutes()).padStart(2,'0')+' UTC';}
  }"""
    old_dt = """  function localDateTime(t){
    try{return new Intl.DateTimeFormat('pl-PL',{timeZone:PLACE.tz,weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(t));}
    catch(_){return new Date(t).toLocaleString('pl-PL');}
  }"""
    new_dt = """  function localDateTime(t){
    try{return new Intl.DateTimeFormat('pl-PL',{timeZone:'UTC',weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(t))+' UTC';}
    catch(_){return new Date(t).toISOString().slice(0,16).replace('T',' ')+' UTC';}
  }"""
    if old_hour not in s or old_dt not in s:
        raise SystemExit("FOG UTC formatter markers not found")
    s = s.replace(old_hour, new_hour, 1).replace(old_dt, new_dt, 1)
    s = s.replace("timeZone:PLACE.tz,year:'numeric'", "timeZone:'UTC',year:'numeric'", 1)
    old_parse = "function parseLocalInput(v){return v?Date.parse(v):NaN;}"
    new_parse = "function parseLocalInput(v){return v?Date.parse(/[zZ]|[+-]\\d\\d:\\d\\d$/.test(v)?v:v+'Z'):NaN;}"
    if old_parse not in s:
        raise SystemExit("FOG datetime-local parser marker not found")
    s = s.replace(old_parse, new_parse, 1)
    p.write_text(s, encoding="utf-8")


def patch_mifg() -> None:
    p = SITE / "mifg-engine.js"
    s = p.read_text(encoding="utf-8")
    old = """  function localHour(t){
    try{return new Intl.DateTimeFormat('pl-PL',{timeZone:PLACE.tz,hour:'2-digit',minute:'2-digit'}).format(new Date(t));}
    catch(_){return new Date(t).toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'});}
  }"""
    new = """  function localHour(t){
    try{return new Intl.DateTimeFormat('pl-PL',{timeZone:'UTC',hour:'2-digit',minute:'2-digit'}).format(new Date(t))+' UTC';}
    catch(_){return String(new Date(t).getUTCHours()).padStart(2,'0')+':'+String(new Date(t).getUTCMinutes()).padStart(2,'0')+' UTC';}
  }"""
    if old not in s:
        raise SystemExit("MIFG UTC formatter marker not found")
    s = s.replace(old, new, 1)
    s = s.replace("timeZone:PLACE.tz,hour:'2-digit',hourCycle:'h23'", "timeZone:'UTC',hour:'2-digit',hourCycle:'h23'", 1)
    p.write_text(s, encoding="utf-8")


def patch_vnext() -> None:
    index = SITE / "index.html"
    bridge = SITE / "fog-summary-layout.js"
    physics = SITE / "fog-physics-vnext.js"
    probability = SITE / "fog-vnext-probability-layer.js"
    visibility = SITE / "fog-visibility-vnext.js"
    br = SITE / "br-engine.js"
    fog_page = SITE / "fog.html"
    for p in (bridge, physics, probability, visibility, br):
        if not p.is_file() or p.stat().st_size == 0:
            raise SystemExit(f"Fog production asset missing: {p.name}")

    # Every deployment gets a fresh URL for the bridge and modules loaded by it.
    b = bridge.read_text(encoding="utf-8")
    b = re.sub(r"fog-physics-vnext\.js\?v=[^']+", f"fog-physics-vnext.js?v={ASSET_V}", b)
    b = re.sub(r"fog-vnext-probability-layer\.js\?v=[^']+", f"fog-vnext-probability-layer.js?v={ASSET_V}", b)
    b = re.sub(r"fog-visibility-vnext\.js\?v=[^']+", f"fog-visibility-vnext.js?v={ASSET_V}", b)
    bridge.write_text(b, encoding="utf-8")

    s = index.read_text(encoding="utf-8")
    # Force the current global navigation runtime on every Pages deployment.
    s = re.sub(r'utc-ui-guard\.js(?:\?v=[^\"]*)?', f'utc-ui-guard.js?v={ASSET_V}', s)
    # EPIR FOG owns the full engine UI. The main page keeps only meteogram FG graphics.
    hide = '<style id="epirFogStandaloneOnly">#fogEngine,#fogEngineModeSwitch,#fogVNextDiagnostics,#fogSummaryStructured,#fogAuxStructured{display:none!important}</style>'
    if 'id="epirFogStandaloneOnly"' not in s:
        if '</head>' not in s:
            raise SystemExit("index.html head marker missing for Fog standalone policy")
        s = s.replace('</head>', hide + '\n</head>', 1)
    tag = f'<script src="fog-summary-layout.js?v={ASSET_V}"></script>'
    if 'fog-summary-layout.js?v=' not in s:
        if '</body>' not in s:
            raise SystemExit("index.html body marker missing for Fog vNext bridge")
        s = s.replace('</body>', tag + "\n</body>", 1)
    index.write_text(s, encoding="utf-8")

    # Standalone EPIR FOG page uses the same deployed, UTC-normalized runtime.
    if fog_page.is_file():
        f = fog_page.read_text(encoding="utf-8")
        f = re.sub(r'utc-ui-guard\.js(?:\?v=[^\"]*)?', f'utc-ui-guard.js?v={ASSET_V}', f)
        for asset in ("fog-engine.js", "mifg-engine.js", "fog-summary-layout.js", "fog-mode-switch.js", "br-engine.js"):
            if asset in f:
                f = re.sub(rf'{re.escape(asset)}\?v=[^\"]+', f'{asset}?v={ASSET_V}', f)
        fog_page.write_text(f, encoding="utf-8")


def validate() -> None:
    fog = (SITE / "fog-engine.js").read_text(encoding="utf-8")
    mifg = (SITE / "mifg-engine.js").read_text(encoding="utf-8")
    br = (SITE / "br-engine.js").read_text(encoding="utf-8")
    index = (SITE / "index.html").read_text(encoding="utf-8")
    nav = (SITE / "utc-ui-guard.js").read_text(encoding="utf-8")
    bridge = (SITE / "fog-summary-layout.js").read_text(encoding="utf-8")
    probability = (SITE / "fog-vnext-probability-layer.js").read_text(encoding="utf-8")
    fog_page = SITE / "fog.html"
    if "function parseLocalInput(v){return v?Date.parse(/[zZ]|[+-]\\d\\d:\\d\\d$/.test(v)?v:v+'Z'):NaN;}" not in fog:
        raise SystemExit("FOG datetime-local is not UTC")
    if "timeZone:PLACE.tz" in fog or "timeZone:PLACE.tz" in mifg:
        raise SystemExit("local timezone reference remains in deployed FOG/MIFG")
    if "+' UTC'" not in fog or "+' UTC'" not in mifg:
        raise SystemExit("explicit UTC label missing in FOG/MIFG")
    if 'fog-summary-layout.js?v=' not in index:
        raise SystemExit("Fog vNext production bridge is not wired into deployed index.html")
    if f'utc-ui-guard.js?v={ASSET_V}' not in index:
        raise SystemExit("global navigation runtime is not cache-busted")
    if 'id="epirFogStandaloneOnly"' not in index:
        raise SystemExit("Fog Engine panel is not hidden on the meteogram page")
    if 'href:\'fog.html\'' not in nav and 'href:"fog.html"' not in nav and "href:'fog.html'" not in nav:
        raise SystemExit("EPIR FOG missing from canonical global navigation")
    if "fogEngineMode:'vnext-production'" not in bridge or 'Probability.operationalScore' not in bridge:
        raise SystemExit("Fog vNext bridge is not in production mode")
    for asset in ("fog-physics-vnext.js", "fog-vnext-probability-layer.js", "fog-visibility-vnext.js"):
        if f'{asset}?v={ASSET_V}' not in bridge:
            raise SystemExit(f"Fog vNext dynamic asset is not cache-busted: {asset}")
    required_probability = (
        "P_model_final", "stateReadiness", "visibilityContradiction",
        "PrognozaEPIRFogRenderSeries", "const VNEXT_THRESHOLD=60", "const LEGACY_THRESHOLD=50",
    )
    for marker in required_probability:
        if marker not in probability:
            raise SystemExit(f"Fog vNext production probability layer contract missing: {marker}")
    for marker in ("VERSION:'1.0.0-br-target'", "ZAMGLENIE (BR)", "BR jest osobnym targetem"):
        if marker not in br:
            raise SystemExit(f"BR target module contract missing: {marker}")
    if not fog_page.is_file():
        raise SystemExit("standalone fog.html missing from Pages artifact")
    fog_html = fog_page.read_text(encoding="utf-8")
    for marker in (
        "EPIR FOG", f"fog-engine.js?v={ASSET_V}", f"fog-summary-layout.js?v={ASSET_V}",
        f"br-engine.js?v={ASSET_V}", "moduł zamglenia BR"
    ):
        if marker not in fog_html:
            raise SystemExit(f"standalone EPIR FOG page contract missing: {marker}")


def main() -> int:
    patch_fog()
    patch_mifg()
    patch_vnext()
    validate()
    print("wired UTC FOG/BR/MIFG runtime, standalone EPIR FOG UI and meteogram-only fog graphics")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
