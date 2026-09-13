#!/usr/bin/env python3
"""Fail CI if browser/API code bypasses the central MessageArchive boundary.

Bulletin providers are allowed only in server-side source adapters under scripts/.
The browser may know the Railway central archive URL only inside the shared
``message-archive-client.js``. All other frontend/API consumers must use the
public ``PrognozaEPIRMessageArchive`` API or the same-origin compatibility bridge
owned by that client. Source priority is Railway live first, then GitHub/static
fallbacks.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLIENT = ROOT / "message-archive-client.js"

FORBIDDEN_PROVIDERS = {
    "IMGW Aviation API": re.compile(r"aviation-api\.imgw\.pl", re.I),
    "IMGW aviation web": re.compile(r"awiacja\.imgw\.pl", re.I),
    "AWC METAR/TAF API": re.compile(r"aviationweather\.gov/api/data/(?:metar|taf)", re.I),
    "PilotHub bulletin source": re.compile(r"pilothub\.pl", re.I),
    "legacy TAF proxy": re.compile(r"/api/taf-proxy", re.I),
}
RAILWAY_ARCHIVE = re.compile(r"central-ingestor-production\.up\.railway\.app/data/messages", re.I)

TARGETS = [
    *ROOT.glob("*.html"),
    *ROOT.glob("*.js"),
    *ROOT.glob("api/*.js"),
]


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def main() -> int:
    violations: list[str] = []
    targets = sorted(set(TARGETS))

    for path in targets:
        text = path.read_text(encoding="utf-8", errors="replace")
        for label, pattern in FORBIDDEN_PROVIDERS.items():
            if pattern.search(text):
                violations.append(f"{rel(path)}: forbidden direct bulletin source: {label}")
        if path.resolve() != CLIENT.resolve() and RAILWAY_ARCHIVE.search(text):
            violations.append(f"{rel(path)}: direct Railway archive URL bypasses shared MessageArchive client")

    if not CLIENT.exists():
        violations.append("message-archive-client.js: missing shared archive client")
    else:
        text = CLIENT.read_text(encoding="utf-8")
        required = [
            "const RAILWAY_ROOT = 'https://central-ingestor-production.up.railway.app/data/messages';",
            "[CUSTOM_ROOT, RAILWAY_ROOT, GITHUB_ROOT, STATIC_ROOT]",
            "window.PrognozaEPIRMessageArchive = api",
            "const legacyArchiveName = input =>",
            "MessageArchive-live-first",
        ]
        for token in required:
            if token not in text:
                violations.append(f"message-archive-client.js: missing archive boundary invariant: {token}")

    taf = ROOT / "taf.html"
    taf_app = ROOT / "taf-app-v2.js"
    if taf.exists():
        text = taf.read_text(encoding="utf-8", errors="replace")
        if not re.search(r'<script\s+src=["\']message-archive-client\.js(?:\?[^"\']*)?["\']\s*></script>', text, re.I):
            violations.append("taf.html: shared archive client is not loaded")
        if not re.search(r'<script\s+src=["\']taf-app-v2\.js(?:\?[^"\']*)?["\']\s*></script>', text, re.I):
            violations.append("taf.html: TAF Engine 2.3 application bridge is not loaded")
    if not taf_app.exists():
        violations.append("taf-app-v2.js: missing TAF Engine 2.3 application bridge")
    else:
        text = taf_app.read_text(encoding="utf-8", errors="replace")
        if "window.PrognozaEPIRMessageArchive" not in text:
            violations.append("taf-app-v2.js: generator bypasses shared archive API")
        if "loadArchive()" not in text:
            violations.append("taf-app-v2.js: shared archive load path missing")

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

    print(f"Archive boundary OK: checked {len(targets)} browser/API files; Railway is owned only by message-archive-client.js")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
