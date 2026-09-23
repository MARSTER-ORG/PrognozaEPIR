#!/usr/bin/env python3
"""Prepare the canonical GitHub Pages artifact with TAF Engine 2.4.3 enabled."""
from __future__ import annotations

import re
import prepare_pages as p
from finalize_central_message_architecture_v2 import validate_taf_frontend


TAF_FOG_POLICY_VERSION = "20260919-4"
TAF_FOG_GATE_BUILD = "20260920-fg-vis-gate"


def patch_taf_v243() -> None:
    # Patch only real script/src attributes. Do not call the historical
    # p.patch_taf() helper here because its broad regexes also matched marker
    # comments and could consume the inline TAF startup runtime.
    path = p.SITE / "taf.html"
    s = p.rd(path)
    s = re.sub(
        r'<meta name="prognozaepir-taf-engine-v2" content="[^"]+">',
        '<meta name="prognozaepir-taf-engine-v2" content="2.4.3">',
        s,
        count=1,
    )

    # Keep the semantic version markers used by the deployment contract, but
    # add the current commit as a second query parameter. This makes every
    # deployed TAF runtime URL unique, so a browser/CDN cannot mix a corrected
    # Fog Policy with cached pre-fix engine layers.
    build = p.ASSET_V
    s = re.sub(
        r'(src="taf-fog-policy\.js\?v=)[^"]+',
        rf'\g<1>{TAF_FOG_POLICY_VERSION}&amp;build={build}',
        s,
    )
    s = re.sub(r'(src="taf-engine-v2\.js\?v=)[^"]+', rf'\g<1>2.3.0-kernel&amp;build={build}', s)
    s = re.sub(r'(src="taf-engine-v24\.js\?v=)[^"]+', rf'\g<1>2.4.0&amp;build={build}', s)
    s = re.sub(r'(src="taf-engine-v241\.js\?v=)[^"]+', rf'\g<1>2.4.1-audit&amp;build={build}', s)
    s = re.sub(r'(src="taf-engine-v242\.js\?v=)[^"]+', rf'\g<1>2.4.2-cloud-fog&amp;build={build}', s)

    # The two current runtime layers are loaded from inline JavaScript rather
    # than static <script> tags, so cache-bust those explicitly as well.
    s = re.sub(
        r"(loadScript\('taf-engine-v243\.js\?v=)[^']+",
        rf"\g<1>{TAF_FOG_GATE_BUILD}&build={build}",
        s,
    )
    s = re.sub(
        r"(loadScript\('taf-app-v25\.js\?v=)[^']+",
        rf"\g<1>{TAF_FOG_GATE_BUILD}&build={build}",
        s,
    )

    # Cache-bust the hidden model iframe without changing its mode query.
    s = re.sub(
        r'(<iframe\b[^>]*\bid="engine"[^>]*\bsrc=")([^"]+)(")',
        lambda m: m.group(1) + re.sub(r'([?&])v=[^&"]+', r'\1v=' + p.ASSET_V, m.group(2)) + m.group(3),
        s,
        count=1,
        flags=re.I,
    )
    p.wr(path, s)



def patch_global_theme() -> None:
    """Wire the shared app.css/theme.js pair on every deployed HTML page."""
    theme = f'<script src="theme.js?v={p.ASSET_V}"></script>'
    style = f'<link rel="stylesheet" href="app.css?v={p.ASSET_V}">'
    html_pages = sorted(p.SITE.glob("*.html"))
    if not html_pages:
        raise RuntimeError("no HTML pages available for shared UI wiring")

    for path in html_pages:
        s = p.rd(path)
        for pattern in (
            r'\s*<script\s+src=["\']theme-control\.js(?:\?[^"\']*)?["\'][^>]*></script>',
            r'\s*<script\s+src=["\']theme\.js(?:\?[^"\']*)?["\'][^>]*></script>',
            r'\s*<link\s+[^>]*href=["\']app\.css(?:\?[^"\']*)?["\'][^>]*>',
        ):
            s = re.sub(pattern, '', s, flags=re.I)

        color_meta = re.compile(r'<meta\b[^>]*\bname=["\']color-scheme["\'][^>]*>', flags=re.I)
        if color_meta.search(s):
            s = color_meta.sub('<meta name="color-scheme" content="light dark">', s, count=1)
        elif re.search(r'</head>', s, re.I):
            s = re.sub(r'</head>', '  <meta name="color-scheme" content="light dark">\n</head>', s, count=1, flags=re.I)
        else:
            raise RuntimeError(f"HTML page has no </head> for shared UI wiring: {path.name}")

        s = re.sub(r'</head>', f'  {theme}\n  {style}\n</head>', s, count=1, flags=re.I)
        p.wr(path, s)


def validate_v243() -> None:
    required = [
        "index.html", "radar.html", "taf.html", "sat-fog.html", "arch.html",
        "taf-engine-v2.js", "taf-engine-v24.js", "taf-engine-v241.js", "taf-engine-v242.js", "taf-engine-v243.js",
        "taf-fog-policy.js", "taf-app-v25.js", "taf-runtime-bootstrap.js", "message-archive-client.js",
        "fog-engine.js", "observation-engine.js", "mifg-engine.js",
        "meteogram-tap-details.js", "theme.js", "app.css",
        "radar-risk-policy.js", "lightning-alerts.html", "lightning-alert-sw.js",
    ]
    missing = [x for x in required if not (p.SITE / x).is_file()]
    if missing:
        raise RuntimeError(f"missing site assets: {missing}")

    html_pages = sorted(p.SITE.glob("*.html"))
    if not html_pages:
        raise RuntimeError("no deployed HTML pages found")
    for page in html_pages:
        html = p.rd(page)
        if html.count('theme.js?v=') != 1:
            raise RuntimeError(f"shared theme controller must be wired exactly once: {page.name}")
        if html.count('app.css?v=') != 1:
            raise RuntimeError(f"shared stylesheet must be wired exactly once: {page.name}")
        if 'theme-control.js' in html:
            raise RuntimeError(f"legacy theme-control.js leaked into deployed page: {page.name}")
        if '<meta name="color-scheme" content="light dark">' not in html:
            raise RuntimeError(f"global light/dark color scheme missing: {page.name}")

    taf = p.rd(p.SITE / "taf.html")
    for legacy in (
        "taf-hybrid-engine.js", "taf-hybrid-adapter.js", "taf-generator-policy.js",
        "taf-instruction-guard.js", "taf-output-sanitizer.js",
    ):
        if legacy in taf:
            raise RuntimeError(f"legacy TAF runtime in deployed taf.html: {legacy}")
    for marker in (
        "TAF ENGINE 2.4.3 ·",
        "taf-fog-policy.js?v=20260919-4",
        "taf-engine-v2.js?v=2.3.0-kernel",
        "taf-engine-v24.js?v=2.4.0",
        "taf-engine-v241.js?v=2.4.1-audit",
        "taf-engine-v242.js?v=2.4.2-cloud-fog",
        "taf-runtime-bootstrap.js?v=20260919-1",
        "prognozaepir-taf-engine-v2",
        "id=\"tafFogSource\"",
        "Fog source: vNext",
    ):
        if marker not in taf:
            raise RuntimeError(f"missing TAF 2.4.3 marker: {marker}")
    if f"build={p.ASSET_V}" not in taf:
        raise RuntimeError("deployed TAF runtime is missing per-build cache busting")
    if f"REQUIRED_FOG_POLICY_BUILD='{TAF_FOG_GATE_BUILD}'" not in taf:
        raise RuntimeError("deployed TAF runtime is missing the strict Fog Policy build gate")
    if "data-taf-fog-mode" in taf or "localStorage.getItem(MODE_KEY)" in taf:
        raise RuntimeError("deployed TAF page still exposes a selectable Fog mode")
    if validate_taf_frontend(p.SITE) != "v25-v243":
        raise RuntimeError("deployed TAF runtime validator returned an unexpected mode")

    bootstrap = p.rd(p.SITE / "taf-runtime-bootstrap.js")
    for marker in (
        "primeCycleSelect", "taf-engine-v243.js?v=${BUILD}", "taf-app-v25.js?v=${BUILD}",
        "TAF Fog Policy nie został załadowany", "TAF Engine 2.4.3 nie został załadowany",
        "Interfejs generatora TAF nie uruchomił się",
    ):
        if marker not in bootstrap:
            raise RuntimeError(f"TAF runtime bootstrap contract missing: {marker}")

    index = p.rd(p.SITE / "index.html")
    if "fog-summary-layout.js" in index:
        raise RuntimeError("dead fog-summary-layout.js reference deployed")
    if re.search(r'<script\s+src="fog-engine\.js', index, re.I):
        raise RuntimeError("fog-engine.js must be loaded only by observation-engine.js")
    if index.count("observation-engine.js") != 1:
        raise RuntimeError("observation-engine.js must be wired exactly once")
    theme = p.rd(p.SITE / "theme.js")
    if '["taf.html","TAF GENERATOR","taf"]' not in theme:
        raise RuntimeError("shared navigation does not expose TAF Generator")
    if re.search(r'<a[^>]+class="control-link"[^>]+href="taf\.html', index, re.I):
        raise RuntimeError("duplicate TAF control leaked into meteogram controls")

    radar = p.rd(p.SITE / "radar.html")
    if "radar-risk-policy.js" not in radar or "lightning-alerts.html" not in radar:
        raise RuntimeError("radar risk policy or lightning alert page not wired")
    for runtime in ("radar-intelligence.js", "map-extras.js", "lightning-layer.js", "range-rings-reset.js"):
        if not re.search(rf'src="{re.escape(runtime)}\?v=[^"]+"', radar):
            raise RuntimeError(f"radar runtime is not cache-busted: {runtime}")
    map_extras = p.rd(p.SITE / "map-extras.js")
    if "if ($('polrad_cappi')) return;" not in map_extras:
        raise RuntimeError("legacy duplicate CAPPI renderer is not guarded")


def main() -> int:
    p.copy_assets()
    p.patch_index()
    patch_taf_v243()
    p.patch_radar()
    patch_global_theme()
    validate_v243()
    print(f"prepared canonical Pages artifact with TAF 2.4.3 and shared UI: {p.SITE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
