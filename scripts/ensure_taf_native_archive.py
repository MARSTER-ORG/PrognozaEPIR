#!/usr/bin/env python3
"""Validate that the current TAF Engine reads bulletins via MessageArchive only."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / "taf.html"
APP = ROOT / "taf-app-v2.js"


def main() -> int:
    if not HTML.exists() or not APP.exists():
        raise SystemExit("TAF Engine v2 frontend files are missing")

    html = HTML.read_text(encoding="utf-8")
    app = APP.read_text(encoding="utf-8")

    required_html = (
        "prognozaepir-taf-engine-v2",
        "message-archive-client.js",
        "taf-app-v2.js",
    )
    missing_html = [token for token in required_html if token not in html]
    if missing_html:
        raise SystemExit("TAF Engine v2 shell incomplete: " + ", ".join(missing_html))

    required_app = (
        "PrognozaEPIRMessageArchive",
        "A.latest(true)",
        "A.recent(true)",
        "A.getLatest?.('TAF'",
    )
    missing_app = [token for token in required_app if token not in app]
    if missing_app:
        raise SystemExit("native MessageArchive hooks missing: " + ", ".join(missing_app))

    forbidden = (
        "taf-archive-source.js",
        "window.fetch=",
        "loadImgwLive(",
        "decodeMetarLive(",
        "latestStationReport(",
        "plainHtml(",
        "awiacja.imgw.pl",
        "aviation-api.imgw.pl",
        "aviationweather.gov/api/data/taf",
        "/api/taf-proxy",
        "data/observations/latest.json",
        "data/observations/recent.json",
        "data/taf/neighbors.json",
    )
    bad = [token for token in forbidden if token in app]
    if bad:
        raise SystemExit("legacy TAF acquisition remains: " + ", ".join(bad))

    print("TAF Engine v2: native MessageArchive boundary OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
