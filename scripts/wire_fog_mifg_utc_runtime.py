#!/usr/bin/env python3
"""Wire the deployed integrated EPIR FOG 2.4.4 runtime.

``fog.html`` is the canonical same-origin provider.  The meteogram consumes its
published FG/BR/MIFG series through ``fog-index-bridge.js`` and renders them
through ``fog-meteogram-overlay.js``.  Legacy standalone Fog assets are not
started on the meteogram.
"""
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "_site"
ASSET_V = os.environ.get("GITHUB_SHA", "dev")[:12]
FOG_PAGE_ASSETS = (
    "fog-engine-v244.js",
    "fog-engine.js",
)
INDEX_FOG_RUNTIME_ASSETS = (
    "fog-engine-v244.js",
    "fog-engine.js",
    "observation-engine.js",
    "mifg-engine.js",
    "br-engine.js",
    "fog-summary-layout.js",
    "fog-mode-switch.js",
    "fog-index-bridge.js",
    "fog-meteogram-overlay.js",
)


def patch_fog_provider() -> None:
    """Keep the base provider in UTC and export a dedicated LEGACY series."""
    p = SITE / "fog-engine.js"
    s = p.read_text(encoding="utf-8")

    required = (
        "timeZone:'UTC'",
        "function parseLocalInput(v){return v?Date.parse(/[zZ]|[+-]\\d\\d:\\d\\d$/.test(v)?v:v+'Z'):NaN;}",
        "PrognozaEPIRFogLegacySeries",
        "PrognozaEPIRFogSeries",
    )
    for marker in required:
        if marker not in s:
            raise SystemExit(f"source FOG provider contract missing before build: {marker}")

    p.write_text(s, encoding="utf-8")


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
    s = p.read_text(encoding="utf-8")
    s = re.sub(r'utc-ui-guard\.js(?:\?v=[^\"]*)?', f'utc-ui-guard.js?v={ASSET_V}', s)
    for asset in FOG_PAGE_ASSETS:
        s = re.sub(rf"{re.escape(asset)}\?v=[^'\"\s<>,)]+", f"{asset}?v={ASSET_V}", s)
    p.write_text(s, encoding="utf-8")


def validate() -> None:
    fog_base = (SITE / "fog-engine.js").read_text(encoding="utf-8")
    fog244 = (SITE / "fog-engine-v244.js").read_text(encoding="utf-8")
    index = (SITE / "index.html").read_text(encoding="utf-8")
    index_bridge = (SITE / "fog-index-bridge.js").read_text(encoding="utf-8")
    overlay = (SITE / "fog-meteogram-overlay.js").read_text(encoding="utf-8")
    hover = (SITE / "meteogram-visfog-cleanup.js").read_text(encoding="utf-8")
    theme = (SITE / "theme.js").read_text(encoding="utf-8")
    app_css = (SITE / "app.css").read_text(encoding="utf-8")
    fog_html = (SITE / "fog.html").read_text(encoding="utf-8")

    if "PrognozaEPIRFogLegacySeries" not in fog_base:
        raise SystemExit("dedicated LEGACY fog series is not exported for the canonical provider")

    for marker in (
        "const V='2.4.4',H=3600e3,ACTIVE=60",
        "PrognozaEPIRFogRenderThreshold=ACTIVE",
        "PrognozaEPIRBRSeries=br",
        "PrognozaEPIRMIFG={",
    ):
        if marker not in fog244:
            raise SystemExit(f"integrated FOG 2.4.4 contract missing: {marker}")

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
        raise SystemExit("meteogram Fog/BR/MIFG overlay is missing, duplicated or cache-stale")
    if index.find(provider_tag) > index.find(overlay_tag):
        raise SystemExit("canonical Fog provider must load before meteogram overlay")
    for asset in (
        "fog-engine-v244.js", "fog-engine.js", "observation-engine.js", "mifg-engine.js",
        "br-engine.js", "fog-summary-layout.js", "fog-mode-switch.js",
    ):
        if re.search(rf'<script\s+src=["\']{re.escape(asset)}(?:\?[^"\']*)?["\']', index, re.I):
            raise SystemExit(f"duplicate Fog runtime leaked into meteogram: {asset}")

    for marker in (
        "frame.src='fog.html?runtime-provider=1",
        "const ACTIVE=60",
        "PrognozaEPIRFogRenderThreshold=ACTIVE",
        "PrognozaEPIRBRSeries",
        "PrognozaEPIRMIFGSeries",
    ):
        if marker not in index_bridge:
            raise SystemExit(f"canonical Fog index bridge contract missing: {marker}")

    for marker in (
        "FOG_DRAW_THRESHOLD=60", "MIFG_DRAW_THRESHOLD=60", "BR_DRAW_THRESHOLD=60",
        "FOG_INFO_THRESHOLD=60", "MIFG_INFO_THRESHOLD=60", "BR_INFO_THRESHOLD=60",
    ):
        if marker not in overlay:
            raise SystemExit(f"meteogram 60/100 display threshold missing: {marker}")

    for marker in (
        "FOG_TOOLTIP_THRESHOLD = 60",
        "function brAt(t)",
        "Zamglenie · BR",
        "data-epir-br-hover",
    ):
        if marker not in hover:
            raise SystemExit(f"meteogram quick-preview BR/60 contract missing: {marker}")

    forbidden = (
        '<iframe', 'index.html?fogpanel=', 'fogRuntime', 'runtime-wrap',
        'canvasViewport', '<canvas', 'MutationObserver', 'ResizeObserver',
        'epir-pages-compat-', 'observation-engine.js',
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
    archive_asset = 'message-archive-client.js?v=live-jsonl-v7'
    if archive_asset not in fog_html:
        raise SystemExit("native EPIR FOG page is missing MessageArchive client")
    if fog_html.find(archive_asset) > fog_html.find('fog-engine-v244.js'):
        raise SystemExit("MessageArchive client must load before integrated FOG 2.4.4")
    for asset in FOG_PAGE_ASSETS:
        if f'{asset}?v={ASSET_V}' not in fog_html:
            raise SystemExit(f"native EPIR FOG asset missing/cache stale: {asset}")
    if '["fog.html","EPIR FOG","fog"]' not in theme:
        raise SystemExit("EPIR FOG missing from shared theme navigation")


def main() -> int:
    patch_fog_provider()
    wire_meteogram_bridge()
    wire_standalone_page()
    validate()
    print("wired integrated EPIR FOG 2.4.4 provider with unified 60/100 thresholds")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
