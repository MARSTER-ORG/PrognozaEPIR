#!/usr/bin/env python3
"""Prepare the canonical GitHub Pages artifact with TAF Engine 2.4.3 enabled."""
from __future__ import annotations

import re
import prepare_pages as p


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
    s = re.sub(r'(src="taf-engine-v2\.js\?v=)[^"]+', r'\g<1>2.3.0-kernel', s)
    s = re.sub(r'(src="taf-engine-v24\.js\?v=)[^"]+', r'\g<1>2.4.0', s)
    s = re.sub(r'(src="taf-engine-v241\.js\?v=)[^"]+', r'\g<1>2.4.1-audit', s)
    s = re.sub(r'(src="taf-engine-v242\.js\?v=)[^"]+', r'\g<1>2.4.2-cloud-fog', s)
    # Cache-bust the hidden model iframe without changing its mode query.
    s = re.sub(
        r'(<iframe\b[^>]*\bid="engine"[^>]*\bsrc=")([^"]+)(")',
        lambda m: m.group(1) + re.sub(r'([?&])v=[^&"]+', r'\1v=' + p.ASSET_V, m.group(2)) + m.group(3),
        s,
        count=1,
        flags=re.I,
    )
    p.wr(path, s)

    # Cache-bust the entry point shown on the main meteogram page as well.
    index = p.SITE / "index.html"
    x = p.rd(index)
    x = re.sub(r'href="taf\.html(?:\?v=[^"]*)?"', 'href="taf.html?v=2.4.3"', x)
    p.wr(index, x)


def patch_global_theme() -> None:
    """Install one shared System/Light/Dark control on every deployed HTML page."""
    script = f'<script src="theme-control.js?v={p.ASSET_V}"></script>'
    html_pages = sorted(p.SITE.glob("*.html"))
    if not html_pages:
        raise RuntimeError("no HTML pages available for global theme wiring")

    for path in html_pages:
        s = p.rd(path)
        s = re.sub(
            r'\s*<script\s+src=["\']theme-control\.js(?:\?[^"\']*)?["\'][^>]*></script>',
            '',
            s,
            flags=re.I,
        )

        color_meta = re.compile(
            r'<meta\b[^>]*\bname=["\']color-scheme["\'][^>]*>',
            flags=re.I,
        )
        if color_meta.search(s):
            s = color_meta.sub('<meta name="color-scheme" content="light dark">', s, count=1)
        elif re.search(r'</head>', s, re.I):
            s = re.sub(r'</head>', '  <meta name="color-scheme" content="light dark">\n</head>', s, count=1, flags=re.I)
        else:
            raise RuntimeError(f"HTML page has no </head> for theme wiring: {path.name}")

        s = re.sub(r'</head>', f'  {script}\n</head>', s, count=1, flags=re.I)
        p.wr(path, s)


def validate_v243() -> None:
    required = [
        "index.html", "radar.html", "taf.html", "sat-fog.html", "arch.html",
        "taf-engine-v2.js", "taf-engine-v24.js", "taf-engine-v241.js", "taf-engine-v242.js", "taf-engine-v243.js",
        "taf-fog-policy.js", "taf-app-v25.js", "taf-runtime-bootstrap.js", "message-archive-client.js",
        "fog-engine.js", "observation-engine.js", "mifg-engine.js",
        "meteogram-tap-details.js", "theme-control.js",
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
        if html.count('theme-control.js?v=') != 1:
            raise RuntimeError(f"global theme control must be wired exactly once: {page.name}")
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
        "id=\"tafFogModeSwitch\"",
        "data-taf-fog-mode=\"legacy\"",
        "data-taf-fog-mode=\"vnext\"",
    ):
        if marker not in taf:
            raise RuntimeError(f"missing TAF 2.4.3 marker: {marker}")

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
    if 'href="taf.html?v=2.4.3"' not in index:
        raise RuntimeError("main page does not link to cache-busted TAF 2.4.3")

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
    print(f"prepared canonical Pages artifact with TAF 2.4.3 and global theme control: {p.SITE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
