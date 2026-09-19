#!/usr/bin/env python3
"""Prepare the single canonical GitHub Pages artifact for PrognozaEPIR."""
from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "_site"
ASSET_V = os.environ.get("GITHUB_SHA", "dev")[:12]
APP = "v0.10.25 HTML"
RADAR_VERSION = "RADAR / SAT / AI v0.12.5"


def rd(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def wr(path: Path, value: str) -> None:
    path.write_text(value, encoding="utf-8")


def strip_script(html: str, filename: str) -> str:
    return re.sub(
        rf'\s*<script\s+src="{re.escape(filename)}(?:\?[^\"]*)?"></script>',
        "",
        html,
        flags=re.I,
    )


def copy_assets() -> None:
    if SITE.exists():
        shutil.rmtree(SITE)
    SITE.mkdir(parents=True)
    allowed = {".html", ".js", ".css", ".png", ".svg", ".webmanifest", ".ico"}
    for src in ROOT.iterdir():
        if src.is_file() and src.suffix.lower() in allowed:
            shutil.copy2(src, SITE / src.name)
    if (ROOT / "data").exists():
        shutil.copytree(ROOT / "data", SITE / "data", dirs_exist_ok=True)


def patch_index() -> None:
    p = SITE / "index.html"
    s = rd(p)
    favicon = (
        '<link rel="icon" href="epir-icon-192.png" type="image/png" sizes="192x192">\n'
        '<link rel="shortcut icon" href="epir-icon-192.png" type="image/png">\n'
        '<link rel="apple-touch-icon" href="epir-icon-192.png">'
    )
    if 'href="epir-icon-192.png"' not in s:
        s = s.replace("<title>", favicon + "\n<title>", 1)
    s = re.sub(r"v0\.\d+\.\d+ HTML", APP, s)
    s = re.sub(r"HTML v0\.\d+\.\d+", "HTML v0.10.25", s)
    s = s.replace(
        "function timeline(){const now=Date.now(),t0=Math.ceil(now/3600e3)*3600e3",
        "function timeline(){const now=Date.now(),t0=Math.floor(now/3600e3)*3600e3",
    )

    icm = '<a class="control-link" href="https://www.meteo.pl/um/php/meteorogram_id_um.php?ntype=0n&amp;id=2077" target="_blank" rel="noopener noreferrer">ICM UM meteogram ↗</a>'
    for link in reversed([
        '<a class="control-link" href="radar.html">RADAR / SAT / AI</a>',
        '<a class="control-link" href="taf.html?v=2.4.0">GENERATOR TAF</a>',
        '<a class="control-link" href="sat-fog.html">SAT / FOG EUMETSAT</a>',
    ]):
        if link not in s and icm in s:
            s = s.replace(icm, link + "\n    " + icm, 1)

    s = s.replace(
        "{id:'icon_global',name:'ICON',w:.05,provider:'openmeteo'},",
        "{id:'icon_global',name:'ICON',w:.05,provider:'openmeteo',surfaceExclude:['visibility']},",
    )
    s = s.replace(
        "const vars=prof?profileVarsFor(model):SURFACE;",
        "const vars=prof?profileVarsFor(model):SURFACE.filter(v=>!(model.surfaceExclude||[]).includes(v));",
    )
    s = s.replace(
        "const msg=j?.error||j?.reason||j?.message||('HTTP '+r.status);",
        "const msg=j?.reason||j?.message||(typeof j?.error==='string'?j.error:('HTTP '+r.status));",
    )

    loader = '<script src="cloud-learning-client.js"></script>'
    inline = "<script>\n'use strict';"
    if loader not in s:
        if inline not in s:
            raise RuntimeError("index inline marker missing")
        s = s.replace(inline, loader + "\n" + inline, 1)

    old_cloud = "const pr=profile(items,terr),ceil=ceiling(pr)"
    new_cloud = "const cloudItems=items.map(i=>({...i,w:i.w*(window.PrognozaEPIRCloudLearning?.factor?.(i.model.id,t)||1)})),cloudSw=cloudItems.reduce((a,b)=>a+b.w,0);if(cloudSw)cloudItems.forEach(i=>i.w/=cloudSw);const pr=profile(cloudItems,terr),ceil=ceiling(pr)"
    if new_cloud not in s:
        if old_cloud not in s:
            raise RuntimeError("Cloud Learning profile hook missing")
        s = s.replace(old_cloud, new_cloud, 1)

    old_load = "async function load(){setBadge('ŁADOWANIE','');failures=[];datasets.clear();demo=false;"
    new_load = "async function load(){try{await window.PrognozaEPIRCloudLearning?.loadSkill?.()}catch(_){ }setBadge('ŁADOWANIE','');failures=[];datasets.clear();demo=false;"
    if new_load not in s:
        if old_load not in s:
            raise RuntimeError("Cloud Learning load hook missing")
        s = s.replace(old_load, new_load, 1)

    # observation-engine.js is the only loader of fog-engine.js.
    names = [
        "fog-engine.js", "observation-engine.js", "mifg-engine.js",
        "fog-meteogram-overlay.js", "fog-summary-layout.js", "index-fixes.js",
        "axis-layout-fix.js", "visual-style-fix.js", "meteogram-layout-v2.js",
        "meteogram-visfog-split.js", "meteogram-visfog-cleanup.js",
        "rh-axis-fix.js", "day-night-fix.js", "shortcut-mode.js",
        "meteogram-tap-details.js",
    ]
    for name in names:
        s = strip_script(s, name)
    addons = [
        f'<script src="index-fixes.js?v={ASSET_V}"></script>',
        f'<script src="axis-layout-fix.js?v={ASSET_V}"></script>',
        f'<script src="visual-style-fix.js?v={ASSET_V}"></script>',
        f'<script src="meteogram-layout-v2.js?v={ASSET_V}"></script>',
        f'<script src="meteogram-visfog-split.js?v={ASSET_V}"></script>',
        f'<script src="rh-axis-fix.js?v={ASSET_V}"></script>',
        f'<script src="meteogram-visfog-cleanup.js?v={ASSET_V}"></script>',
        f'<script src="day-night-fix.js?v={ASSET_V}"></script>',
        f'<script src="observation-engine.js?v={ASSET_V}"></script>',
        f'<script src="mifg-engine.js?v={ASSET_V}"></script>',
        f'<script src="fog-meteogram-overlay.js?v={ASSET_V}"></script>',
        f'<script src="shortcut-mode.js?v={ASSET_V}"></script>',
        f'<script src="meteogram-tap-details.js?v={ASSET_V}"></script>',
    ]
    s = s.replace("</body>", "\n".join(addons) + "\n</body>", 1)
    wr(p, s)

    for name in ("meteogram-layout-v2.js", "observation-engine.js", "fog-engine.js"):
        q = SITE / name
        if not q.exists():
            continue
        x = rd(q)
        x = re.sub(r"const VERSION = 'v0\.\d+\.\d+ HTML';", f"const VERSION = '{APP}';", x)
        x = re.sub(r"const APP_VERSION = 'v0\.\d+\.\d+ HTML';", f"const APP_VERSION = '{APP}';", x)
        if name == "fog-engine.js" and "PrognozaEPIRFogSeries" not in x:
            old = "fogSeries=out;renderFog();"
            new = "fogSeries=out;window.PrognozaEPIRFogSeries=fogSeries;window.dispatchEvent(new CustomEvent('prognozaepir:fog-series-updated',{detail:{count:fogSeries.length}}));renderFog();"
            if old not in x:
                raise RuntimeError("FOG series export hook missing")
            x = x.replace(old, new, 1)
        wr(q, x)


def patch_taf() -> None:
    p = SITE / "taf.html"
    s = rd(p)
    meta = '<meta name="prognozaepir-taf-engine-v2" content="2.4.0">'
    if "prognozaepir-taf-engine-v2" not in s:
        s = s.replace('<meta name="color-scheme" content="dark">', '<meta name="color-scheme" content="dark">\n  ' + meta, 1)
    else:
        s = re.sub(r'<meta name="prognozaepir-taf-engine-v2" content="[^"]+">', meta, s, count=1)
    s = re.sub(r'src="index\.html(?:\?v=[^"]*)?"', f'src="index.html?v={ASSET_V}"', s, count=1)
    s = re.sub(r'taf-engine-v2\.js\?v=[^"]+', 'taf-engine-v2.js?v=2.3.0-kernel', s)
    s = re.sub(r'taf-engine-v24\.js\?v=[^"]+', 'taf-engine-v24.js?v=2.4.0', s)
    s = re.sub(r'taf-app-v2\.js\?v=[^"]+', 'taf-app-v2.js?v=2.4.0-ui', s)
    wr(p, s)


def patch_radar() -> None:
    p = SITE / "radar.html"
    s = rd(p)
    favicon = (
        '<link rel="icon" href="epir-icon-192.png" type="image/png" sizes="192x192">\n'
        '<link rel="shortcut icon" href="epir-icon-192.png" type="image/png">\n'
        '<link rel="apple-touch-icon" href="epir-icon-192.png">'
    )
    if 'href="epir-icon-192.png"' not in s:
        s = s.replace("<title>", favicon + "\n<title>", 1)
    s = re.sub(r"RADAR / SAT / AI v\d+\.\d+\.\d+", RADAR_VERSION, s)
    s = s.replace(
        "function setDot(id,ok){$(id).className='dot '+(ok?'ok':'bad')}",
        "function setDot(id,ok){const el=$(id);if(el)el.className='dot '+(ok?'ok':'bad')}",
    )
    old_brand = '<div class="brand">PrognozaEPIR <small>'
    new_brand = '<div class="brand"><a href="index.html" title="Przejdź do meteogramu" aria-label="PrognozaEPIR — meteogram" style="color:inherit;text-decoration:none;cursor:pointer">PrognozaEPIR</a> <small>'
    if old_brand in s:
        s = s.replace(old_brand, new_brand, 1)
    meteo = '<a href="index.html">← Meteogram</a>'
    alert = '<a href="lightning-alerts.html">Alarm wyładowań</a>'
    if alert not in s and meteo in s:
        s = s.replace(meteo, alert + "\n    " + meteo, 1)

    names = [
        "radar-enhance.js", "warnings-readable.js", "radar-intelligence.js",
        "echo-analysis.js", "echo-fix.js", "lightning-layer.js", "ui-cleanup.js",
        "map-extras.js", "analysis-plus.js", "range-rings-reset.js",
        "opera-nowcast.js", "opera-convection-bridge.js", "radar-risk-policy.js",
        "shortcut-mode.js",
    ]
    for name in names:
        s = strip_script(s, name)
    addons = [
        f'<script src="radar-enhance.js?v={ASSET_V}"></script>',
        f'<script src="warnings-readable.js?v={ASSET_V}"></script>',
        f'<script src="radar-intelligence.js?v={ASSET_V}"></script>',
        f'<script src="echo-analysis.js?v={ASSET_V}"></script>',
        f'<script src="echo-fix.js?v={ASSET_V}"></script>',
        f'<script src="lightning-layer.js?v={ASSET_V}"></script>',
        f'<script src="ui-cleanup.js?v={ASSET_V}"></script>',
        f'<script src="map-extras.js?v={ASSET_V}"></script>',
        f'<script src="analysis-plus.js?v={ASSET_V}"></script>',
        f'<script src="range-rings-reset.js?v={ASSET_V}"></script>',
        f'<script src="opera-nowcast.js?v={ASSET_V}"></script>',
        f'<script src="opera-convection-bridge.js?v={ASSET_V}"></script>',
        f'<script src="radar-risk-policy.js?v={ASSET_V}"></script>',
        f'<script src="shortcut-mode.js?v={ASSET_V}"></script>',
    ]
    s = s.replace("</body>", "\n".join(addons) + "\n</body>", 1)
    wr(p, s)

    for name in (
        "radar-enhance.js", "radar-intelligence.js", "echo-analysis.js",
        "echo-fix.js", "lightning-layer.js", "map-extras.js",
        "analysis-plus.js", "range-rings-reset.js",
    ):
        q = SITE / name
        if q.exists():
            wr(q, re.sub(r"RADAR / SAT / AI v\d+\.\d+\.\d+", RADAR_VERSION, rd(q)))

    q = SITE / "radar-enhance.js"
    if q.exists():
        x = rd(q).replace("    setTimeout(loadPolradProducts, 150);\n", "")
        start = x.find("  // --- Official IMGW / POLRAD product API ---")
        end = x.rfind("  const sources = document.querySelector('.sources');")
        if start >= 0 and end > start:
            x = x[:start] + x[end:]
        wr(q, x)


def validate() -> None:
    required = [
        "index.html", "radar.html", "taf.html", "sat-fog.html", "arch.html",
        "taf-engine-v2.js", "taf-engine-v24.js", "taf-app-v2.js", "message-archive-client.js",
        "fog-engine.js", "observation-engine.js", "mifg-engine.js",
        "meteogram-tap-details.js",
        "radar-risk-policy.js", "lightning-alerts.html", "lightning-alert-sw.js",
    ]
    missing = [x for x in required if not (SITE / x).is_file()]
    if missing:
        raise RuntimeError(f"missing site assets: {missing}")

    taf = rd(SITE / "taf.html")
    for legacy in (
        "taf-hybrid-engine.js", "taf-hybrid-adapter.js", "taf-generator-policy.js",
        "taf-instruction-guard.js", "taf-output-sanitizer.js",
    ):
        if legacy in taf:
            raise RuntimeError(f"legacy TAF runtime in deployed taf.html: {legacy}")
    for marker in (
        "TAF ENGINE 2.4.0 · CALIBRATED · INSTRUCTION FIRST",
        "taf-engine-v2.js?v=2.3.0-kernel",
        "taf-engine-v24.js?v=2.4.0",
        "taf-app-v2.js?v=2.4.0-ui",
        "prognozaepir-taf-engine-v2",
    ):
        if marker not in taf:
            raise RuntimeError(f"missing TAF marker: {marker}")

    index = rd(SITE / "index.html")
    if "fog-summary-layout.js" in index:
        raise RuntimeError("dead fog-summary-layout.js reference deployed")
    if re.search(r'<script\s+src="fog-engine\.js', index, re.I):
        raise RuntimeError("fog-engine.js must be loaded only by observation-engine.js")
    if index.count("observation-engine.js") != 1:
        raise RuntimeError("observation-engine.js must be wired exactly once")

    radar = rd(SITE / "radar.html")
    if "radar-risk-policy.js" not in radar or "lightning-alerts.html" not in radar:
        raise RuntimeError("radar risk policy or lightning alert page not wired")
    for runtime in ("radar-intelligence.js", "map-extras.js", "lightning-layer.js", "range-rings-reset.js"):
        if not re.search(rf'src="{re.escape(runtime)}\?v=[^"]+"', radar):
            raise RuntimeError(f"radar runtime is not cache-busted: {runtime}")
    map_extras = rd(SITE / "map-extras.js")
    if "if ($('polrad_cappi')) return;" not in map_extras:
        raise RuntimeError("legacy duplicate CAPPI renderer is not guarded")


def main() -> int:
    copy_assets()
    patch_index()
    patch_taf()
    patch_radar()
    validate()
    print(f"prepared canonical Pages artifact: {SITE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
