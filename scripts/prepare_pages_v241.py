#!/usr/bin/env python3
"""Prepare the canonical GitHub Pages artifact with TAF Engine 2.4.1 enabled."""
from __future__ import annotations

import re
import prepare_pages as p


def patch_taf_v241() -> None:
    p.patch_taf()
    path = p.SITE / "taf.html"
    s = p.rd(path)
    s = re.sub(
        r'<meta name="prognozaepir-taf-engine-v2" content="[^"]+">',
        '<meta name="prognozaepir-taf-engine-v2" content="2.4.1">',
        s,
        count=1,
    )
    s = re.sub(r'taf-engine-v241\.js\?v=[^"]+', 'taf-engine-v241.js?v=2.4.1-audit', s)
    p.wr(path, s)


def validate_v241() -> None:
    required = [
        "index.html", "radar.html", "taf.html", "sat-fog.html", "arch.html",
        "taf-engine-v2.js", "taf-engine-v24.js", "taf-engine-v241.js", "taf-app-v2.js", "message-archive-client.js",
        "fog-engine.js", "observation-engine.js", "mifg-engine.js",
        "meteogram-tap-details.js",
        "radar-risk-policy.js", "lightning-alerts.html", "lightning-alert-sw.js",
    ]
    missing = [x for x in required if not (p.SITE / x).is_file()]
    if missing:
        raise RuntimeError(f"missing site assets: {missing}")

    taf = p.rd(p.SITE / "taf.html")
    for legacy in (
        "taf-hybrid-engine.js", "taf-hybrid-adapter.js", "taf-generator-policy.js",
        "taf-instruction-guard.js", "taf-output-sanitizer.js",
    ):
        if legacy in taf:
            raise RuntimeError(f"legacy TAF runtime in deployed taf.html: {legacy}")
    for marker in (
        "TAF ENGINE 2.4.1 · SEMANTIC QUALITY · INSTRUCTION FIRST",
        "taf-engine-v2.js?v=2.3.0-kernel",
        "taf-engine-v24.js?v=2.4.0",
        "taf-engine-v241.js?v=2.4.1-audit",
        "taf-app-v2.js?v=2.4.0-ui",
        "prognozaepir-taf-engine-v2",
    ):
        if marker not in taf:
            raise RuntimeError(f"missing TAF 2.4.1 marker: {marker}")

    index = p.rd(p.SITE / "index.html")
    if "fog-summary-layout.js" in index:
        raise RuntimeError("dead fog-summary-layout.js reference deployed")
    if re.search(r'<script\s+src="fog-engine\.js', index, re.I):
        raise RuntimeError("fog-engine.js must be loaded only by observation-engine.js")
    if index.count("observation-engine.js") != 1:
        raise RuntimeError("observation-engine.js must be wired exactly once")

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
    patch_taf_v241()
    p.patch_radar()
    validate_v241()
    print(f"prepared canonical Pages artifact with TAF 2.4.1: {p.SITE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
