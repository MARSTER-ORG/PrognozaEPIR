#!/usr/bin/env python3
"""Finalize central bulletin policy for the external TAF Engine v2 frontend.

The old finalizer patched a monolithic taf.html in place. TAF Engine v2 moved the
application logic to taf-app-v2.js, so mutating HTML during every ingest cycle is
both unnecessary and brittle. This compatibility finalizer keeps the archive
policy work, then validates the current frontend boundary without rewriting it.
"""
from __future__ import annotations

import json
from pathlib import Path

import finalize_central_message_architecture as legacy

ROOT = Path(__file__).resolve().parents[1]


def validate_taf_frontend() -> str:
    html_path = ROOT / "taf.html"
    app_path = ROOT / "taf-app-v2.js"
    if not html_path.exists():
        raise RuntimeError("taf.html not found")

    html = html_path.read_text(encoding="utf-8")
    modern = "taf-app-v2.js" in html or "prognozaepir-taf-engine-v2" in html
    if not modern:
        # Preserve compatibility with an older checkout if it is ever deployed.
        legacy.clean_taf_html()
        return "legacy-inline"

    if "message-archive-client.js" not in html:
        raise RuntimeError("TAF Engine v2 is missing message-archive-client.js")
    if "taf-app-v2.js" not in html:
        raise RuntimeError("TAF Engine v2 is missing taf-app-v2.js")
    if not app_path.exists():
        raise RuntimeError("taf-app-v2.js not found")

    app = app_path.read_text(encoding="utf-8")
    required = (
        "PrognozaEPIRMessageArchive",
        "A.latest(true)",
        "A.recent(true)",
        "A.getLatest?.('TAF'",
    )
    missing = [token for token in required if token not in app]
    if missing:
        raise RuntimeError("TAF Engine v2 MessageArchive boundary incomplete: " + ", ".join(missing))

    forbidden = (
        "aviation-api.imgw.pl",
        "awiacja.imgw.pl",
        "aviationweather.gov/api/data/taf",
        "/api/taf-proxy",
        "loadImgwLive(",
    )
    bad = [token for token in forbidden if token in app]
    if bad:
        raise RuntimeError("TAF Engine v2 contains direct bulletin acquisition: " + ", ".join(bad))

    return "external-v2"


def validate_verifier_file() -> None:
    path = ROOT / "taf-verification.js"
    if not path.exists():
        return
    text = path.read_text(encoding="utf-8")
    required = (
        "CENTRAL_RAW_BASE",
        "centralDayUrls(kind,day)",
        "fetchMetarDay(day)",
        "fetchTafIssueDay(day)",
    )
    missing = [token for token in required if token not in text]
    if missing:
        raise RuntimeError("TAF verifier central archive boundary incomplete: " + ", ".join(missing))


def main() -> int:
    removed, kept = legacy.prune_neighbor_taf_history()
    snapshot = legacy.build_neighbor_snapshot()
    legacy.refresh_views(snapshot)
    frontend_mode = validate_taf_frontend()
    validate_verifier_file()
    print(json.dumps({
        "taf_history_epir": kept,
        "neighbor_taf_history_removed": removed,
        "neighbor_snapshot_stations": sorted((snapshot.get("stations") or {}).keys()),
        "taf_html_native_message_archive": True,
        "taf_frontend_mode": frontend_mode,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
