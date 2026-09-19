#!/usr/bin/env python3
"""Wire the deployed FOG/BR/MIFG runtimes.

``fog.html`` is the canonical Fog runtime.  The meteogram must not execute its
own copy of Fog/BR/MIFG engines because its global model state differs from the
standalone Fog page.  ``index.html`` therefore consumes the canonical same-
origin ``fog.html`` runtime through ``fog-index-bridge.js`` and only draws the
published series.
"""
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "_site"
ASSET_V = os.environ.get("GITHUB_SHA", "dev")[:12]
FOG_PAGE_ASSETS = (
    "fog-mode-switch.js",
    "fog-engine.js",
    "mifg-engine.js",
    "fog-summary-layout.js",
    "br-engine.js",
    "fog-page-layout.js",
    "fog-visibility-cells.js",
)
INDEX_FOG_RUNTIME_ASSETS = (
    "fog-engine.js",
    "observation-engine.js",
    "mifg-engine.js",
    "br-engine.js",
    "fog-summary-layout.js",
    "fog-mode-switch.js",
    "fog-index-bridge.js",
    "fog-meteogram-overlay.js",
)


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

    active_export = "fogSeries=out;window.PrognozaEPIRFogSeries=fogSeries;"
    legacy_export = (
        "fogSeries=out;"
        "window.PrognozaEPIRFogLegacySeries=fogSeries.map(h=>({...h,models:Array.isArray(h?.models)?h.models.map(m=>({...m,components:m?.components?{...m.components}:m?.components})):h?.models,fogEngineMode:'legacy',fogEngineSource:'legacy'}));"
        "window.PrognozaEPIRFogSeries=fogSeries;"
    )
    if "PrognozaEPIRFogLegacySeries" not in s:
        if active_export not in s:
            raise SystemExit("FOG active series export marker not found")
        s = s.replace(active_export, legacy_export, 1)
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


def cache_bust_bridge() -> None:
    bridge = SITE / "fog-summary-layout.js"
    b = bridge.read_text(encoding="utf-8")
    for asset in ("fog-physics-vnext.js", "fog-vnext-probability-layer.js", "fog-visibility-vnext.js"):
        b = re.sub(rf"{re.escape(asset)}\?v=[^'\"]+", f"{asset}?v={ASSET_V}", b)
    bridge.write_text(b, encoding="utf-8")


def strip_script(html: str, asset: str) -> str:
    return re.sub(
        rf'\s*<script\s+src=["\']{re.escape(asset)}(?:\?[^"\']*)?["\'][^>]*></script>',
        '',
        html,
        flags=re.I,
    )


def wire_meteogram_bridge() -> None:
    p = SITE / "index.html"
    s = p.read_text(encoding="utf-8")
    s = re.sub(r'utc-ui-guard\.js(?:\?v=[^\"]*)?', f'utc-ui-guard.js?v={ASSET_V}', s)

    # Remove every in-page Fog runtime.  The old chain let fog-engine.js see
    # meteogram globals (MODELS/datasets) and later fog-summary-layout.js could
    # overwrite the selected series.  The meteogram must only consume the
    # isolated canonical fog.html runtime.
    for asset in INDEX_FOG_RUNTIME_ASSETS:
        s = strip_script(s, asset)

    if '</body>' not in s:
        raise SystemExit("index.html body marker missing")
    provider = f'<script src="fog-index-bridge.js?v={ASSET_V}"></script>'
    overlay = f'<script src="fog-meteogram-overlay.js?v={ASSET_V}"></script>'
    s = s.replace('</body>', provider + '\n' + overlay + '\n</body>', 1)
    p.write_text(s, encoding="utf-8")


def wire_standalone_page() -> None:
    p = SITE / "fog.html"
    f = p.read_text(encoding="utf-8")
    f = re.sub(r'utc-ui-guard\.js(?:\?v=[^\"]*)?', f'utc-ui-guard.js?v={ASSET_V}', f)
    for asset in FOG_PAGE_ASSETS:
        f = re.sub(rf"{re.escape(asset)}\?v=[^'\"\s<>,)]+", f"{asset}?v={ASSET_V}", f)
    p.write_text(f, encoding="utf-8")


def validate() -> None:
    fog = (SITE / "fog-engine.js").read_text(encoding="utf-8")
    mifg = (SITE / "mifg-engine.js").read_text(encoding="utf-8")
    br = (SITE / "br-engine.js").read_text(encoding="utf-8")
    index = (SITE / "index.html").read_text(encoding="utf-8")
    index_bridge = (SITE / "fog-index-bridge.js").read_text(encoding="utf-8")
    theme = (SITE / "theme.js").read_text(encoding="utf-8")
    app_css = (SITE / "app.css").read_text(encoding="utf-8")
    bridge = (SITE / "fog-summary-layout.js").read_text(encoding="utf-8")
    probability = (SITE / "fog-vnext-probability-layer.js").read_text(encoding="utf-8")
    fog_html = (SITE / "fog.html").read_text(encoding="utf-8")

    if "timeZone:PLACE.tz" in fog or "timeZone:PLACE.tz" in mifg:
        raise SystemExit("local timezone reference remains in deployed FOG/MIFG")
    if "PrognozaEPIRFogLegacySeries" not in fog:
        raise SystemExit("dedicated LEGACY fog series is not exported for TAF")

    if 'app.css?v=' not in index:
        raise SystemExit("meteogram shared stylesheet contract missing")
    if '#fogEngine' not in app_css or 'data-epir-page="index"' not in app_css:
        raise SystemExit("shared stylesheet is missing the meteogram-only Fog panel rule")
    if f'utc-ui-guard.js?v={ASSET_V}' not in index:
        raise SystemExit("global navigation runtime is not cache-busted")

    provider_tag = f'fog-index-bridge.js?v={ASSET_V}'
    overlay_tag = f'fog-meteogram-overlay.js?v={ASSET_V}'
    if index.count('fog-index-bridge.js?v=') != 1 or provider_tag not in index:
        raise SystemExit("canonical fog.html provider is missing, duplicated or cache-stale")
    if index.count('fog-meteogram-overlay.js?v=') != 1 or overlay_tag not in index:
        raise SystemExit("meteogram Fog/BR overlay is missing, duplicated or cache-stale")
    if index.find(provider_tag) > index.find(overlay_tag):
        raise SystemExit("canonical Fog provider must load before meteogram overlay")
    for asset in ("fog-engine.js", "observation-engine.js", "mifg-engine.js", "br-engine.js", "fog-summary-layout.js", "fog-mode-switch.js"):
        if re.search(rf'<script\s+src=["\']{re.escape(asset)}(?:\?[^"\']*)?["\']', index, re.I):
            raise SystemExit(f"duplicate Fog runtime leaked into meteogram: {asset}")
    for marker in (
        "frame.src='fog.html?runtime-provider=1",
        'PrognozaEPIRFogLegacySeries',
        'PrognozaEPIRFogVNextSeries',
        'PrognozaEPIRBRSeries',
        'PrognozaEPIRMIFGSeries',
    ):
        if marker not in index_bridge:
            raise SystemExit(f"canonical Fog index bridge contract missing: {marker}")

    if "fogEngineMode:'vnext-production'" not in bridge or 'Probability.operationalScore' not in bridge:
        raise SystemExit("Fog vNext bridge is not in production mode")
    for asset in ("fog-physics-vnext.js", "fog-vnext-probability-layer.js", "fog-visibility-vnext.js"):
        if f'{asset}?v={ASSET_V}' not in bridge:
            raise SystemExit(f"Fog vNext dynamic asset is not cache-busted: {asset}")
    for marker in (
        "P_model_final", "stateReadiness", "visibilityContradiction",
        "PrognozaEPIRFogRenderSeries", "const VNEXT_THRESHOLD=60", "const LEGACY_THRESHOLD=50",
    ):
        if marker not in probability:
            raise SystemExit(f"Fog vNext probability contract missing: {marker}")
    for marker in ("VERSION:'1.0.0-br-target'", "ZAMGLENIE (BR)", "BR jest osobnym targetem"):
        if marker not in br:
            raise SystemExit(f"BR target contract missing: {marker}")

    forbidden = (
        '<iframe', 'index.html?fogpanel=', 'fogRuntime', 'runtime-wrap',
        'canvasViewport', '<canvas', 'MutationObserver', 'ResizeObserver',
        'epir-pages-compat-', 'message-archive-client.js', 'observation-engine.js',
        'fog-meteogram-overlay.js', 'shortcut-mode.js',
    )
    for marker in forbidden:
        if marker in fog_html:
            raise SystemExit(f"dead/meteogram runtime leaked into fog.html: {marker}")
    for marker in (
        'id="epirGlobalNav"', 'href="index.html"', 'href="taf.html"',
        'id="fogStandaloneMount"', 'window.__PROGNOZA_EPIR_FOG_STANDALONE__=true',
    ):
        if marker not in fog_html:
            raise SystemExit(f"native EPIR FOG page marker missing: {marker}")
    for asset in FOG_PAGE_ASSETS:
        if f'{asset}?v={ASSET_V}' not in fog_html:
            raise SystemExit(f"native EPIR FOG asset missing/cache stale: {asset}")
    if '["fog.html","EPIR FOG","fog"]' not in theme:
        raise SystemExit("EPIR FOG missing from shared theme navigation")


def main() -> int:
    patch_fog()
    patch_mifg()
    cache_bust_bridge()
    wire_meteogram_bridge()
    wire_standalone_page()
    validate()
    print("wired canonical fog.html runtime provider for meteogram plus native EPIR FOG page")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())