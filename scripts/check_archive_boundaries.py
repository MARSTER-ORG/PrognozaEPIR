#!/usr/bin/env python3
"""Fail CI if browser/API code bypasses the central message archive.

Bulletin providers are allowed only in server-side source adapters under scripts/.
Frontend code and Vercel API handlers must read the GitHub data/messages archive,
never Railway or bulletin providers directly.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

FORBIDDEN = {
    "IMGW Aviation API": re.compile(r"aviation-api\.imgw\.pl", re.I),
    "IMGW aviation web": re.compile(r"awiacja\.imgw\.pl", re.I),
    "AWC METAR/TAF API": re.compile(r"aviationweather\.gov/api/data/(?:metar|taf)", re.I),
    "PilotHub bulletin source": re.compile(r"pilothub\.pl", re.I),
    "legacy TAF proxy": re.compile(r"/api/taf-proxy", re.I),
    "Railway central archive": re.compile(r"central-ingestor-production\.up\.railway\.app/data/messages", re.I),
}

TARGETS = [
    *ROOT.glob("*.html"),
    *ROOT.glob("*.js"),
    *ROOT.glob("api/*.js"),
]


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def main() -> int:
    violations: list[str] = []
    for path in sorted(set(TARGETS)):
        text = path.read_text(encoding="utf-8", errors="replace")
        for label, pattern in FORBIDDEN.items():
            if pattern.search(text):
                violations.append(f"{rel(path)}: forbidden direct bulletin source: {label}")

    client = ROOT / "message-archive-client.js"
    if not client.exists():
        violations.append("message-archive-client.js: missing shared archive client")
    else:
        text = client.read_text(encoding="utf-8")
        if "data/messages" not in text:
            violations.append("message-archive-client.js: does not target data/messages")
        if "PrognozaEPIRMessageArchive" not in text:
            violations.append("message-archive-client.js: public archive API missing")

    taf = ROOT / "taf.html"
    if taf.exists():
        text = taf.read_text(encoding="utf-8", errors="replace")
        # Query-string cache busting is allowed and expected for the shared client.
        if not re.search(r'<script\s+src=["\']message-archive-client\.js(?:\?[^"\']*)?["\']\s*></script>', text, re.I):
            violations.append("taf.html: shared archive client is not loaded")
        if "PrognozaEPIRMessageArchive" not in text:
            violations.append("taf.html: generator bypasses shared archive API")

    observation = ROOT / "observation-engine.js"
    if observation.exists():
        text = observation.read_text(encoding="utf-8", errors="replace")
        if "PrognozaEPIRMessageArchive" not in text:
            violations.append("observation-engine.js: observations bypass shared archive API")
        if "data/messages/latest.json" in text or "data/messages/recent.json" in text:
            violations.append("observation-engine.js: direct archive URLs remain instead of shared client")

    if violations:
        print("ARCHIVE BOUNDARY VIOLATIONS:")
        for item in violations:
            print(f" - {item}")
        return 1

    print(f"Archive boundary OK: checked {len(set(TARGETS))} browser/API files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
