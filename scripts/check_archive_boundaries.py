#!/usr/bin/env python3
"""Fail deployment if browser/API code bypasses central MessageArchive.

Bulletin providers are allowed only in server-side source adapters under scripts/.
Supabase is the primary archive read source. Railway and GitHub/static JSON are
fallbacks owned only by message-archive-client.js. Frontend consumers use the
public PrognozaEPIRMessageArchive API; no page may read bulletin files directly.
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
SUPABASE_ARCHIVE = re.compile(r"qozgntzeormujmqzkkmd\.supabase\.co/functions/v1/message-archive", re.I)
DIRECT_MESSAGE_FILES = re.compile(r"(?:^|[^A-Za-z0-9_-])data/messages(?:/|\\)", re.I)
LEGACY_BULLETIN_FILES = re.compile(
    r"data/observations/(?:metar|synop)|data/taf/(?:latest|neighbors)\.json|(?:^|['\"`])taf-neighbors\.json(?:['\"`]|$)",
    re.I,
)
SERVICE_ROLE_CREDENTIAL = re.compile(r"SUPABASE_SERVICE_ROLE_KEY|['\"]service_role['\"]\s*[:=]", re.I)
CLIENT_SCRIPT = re.compile(r'<script\s+src=["\']message-archive-client\.js(?:\?[^"\']*)?["\']\s*></script>', re.I)

TARGETS = [*ROOT.glob("*.html"), *ROOT.glob("*.js"), *ROOT.glob("api/*.js")]
BULLETIN_PAGES = ("index.html", "arch.html", "taf.html")


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
        if path.resolve() != CLIENT.resolve() and SUPABASE_ARCHIVE.search(text):
            violations.append(f"{rel(path)}: direct Supabase archive URL bypasses shared MessageArchive client")
        if path.resolve() != CLIENT.resolve() and DIRECT_MESSAGE_FILES.search(text):
            violations.append(f"{rel(path)}: direct data/messages access bypasses shared MessageArchive client")
        if path.resolve() != CLIENT.resolve() and LEGACY_BULLETIN_FILES.search(text):
            violations.append(f"{rel(path)}: legacy bulletin file/snapshot access bypasses MessageArchive")

    if not CLIENT.exists():
        violations.append("message-archive-client.js: missing shared archive client")
    else:
        text = CLIENT.read_text(encoding="utf-8")
        required = [
            "const SUPABASE_API = 'https://qozgntzeormujmqzkkmd.supabase.co/functions/v1/message-archive';",
            "const SUPABASE_ANON =",
            "const SUPABASE_ENABLED =",
            "const RAILWAY_ROOT = 'https://central-ingestor-production.up.railway.app/data/messages';",
            "supabaseRequest(",
            "getRange",
            "window.PrognozaEPIRMessageArchive=api",
            "Supabase-primary-MessageArchive",
        ]
        for token in required:
            if token not in text:
                violations.append(f"message-archive-client.js: missing Supabase-primary invariant: {token}")
        if not SUPABASE_ARCHIVE.search(text):
            violations.append("message-archive-client.js: Supabase archive endpoint missing")
        if SERVICE_ROLE_CREDENTIAL.search(text):
            violations.append("message-archive-client.js: service-role credential must never be present in browser code")
        if "PRIMARY_ROOT = SUPABASE_ENABLED ? SUPABASE_API" not in text:
            violations.append("message-archive-client.js: Supabase is not configured as primary read source")

    # Every page that consumes METAR/SPECI/TAF/SYNOP must load the one shared
    # client. Radar, satellite and lightning pages use different data domains
    # and are intentionally not forced to load the bulletin archive.
    for name in BULLETIN_PAGES:
        page = ROOT / name
        if not page.exists():
            violations.append(f"{name}: required bulletin-consuming page missing")
            continue
        text = page.read_text(encoding="utf-8", errors="replace")
        if not CLIENT_SCRIPT.search(text):
            violations.append(f"{name}: shared MessageArchive client is not loaded")

    taf = ROOT / "taf.html"
    taf_app = ROOT / "taf-app-v2.js"
    if taf.exists():
        text = taf.read_text(encoding="utf-8", errors="replace")
        if not re.search(r'<script\s+src=["\']taf-app-v2\.js(?:\?[^"\']*)?["\']\s*></script>', text, re.I):
            violations.append("taf.html: TAF Engine 2.3 application bridge is not loaded")
    if not taf_app.exists():
        violations.append("taf-app-v2.js: missing TAF Engine 2.3 application bridge")
    else:
        text = taf_app.read_text(encoding="utf-8", errors="replace")
        if "window.PrognozaEPIRMessageArchive" not in text or "loadArchive()" not in text:
            violations.append("taf-app-v2.js: generator bypasses shared archive API")
        if "A.getLatest?.('TAF',id,true)" not in text:
            violations.append("taf-app-v2.js: neighbour TAFs are not read through MessageArchive.getLatest")

    observation = ROOT / "observation-engine.js"
    if observation.exists():
        text = observation.read_text(encoding="utf-8", errors="replace")
        if "PrognozaEPIRMessageArchive" not in text:
            violations.append("observation-engine.js: observations bypass shared archive API")
        if "archiveLatest(" not in text or "archiveRecent(" not in text:
            violations.append("observation-engine.js: shared latest/recent archive access is incomplete")

    neighbor = ROOT / "neighbor-observation-context.js"
    if not neighbor.exists():
        violations.append("neighbor-observation-context.js: missing neighbour observation consumer")
    else:
        text = neighbor.read_text(encoding="utf-8", errors="replace")
        if "A.getLatest('AVIATION',id,force)" not in text:
            violations.append("neighbor-observation-context.js: neighbour METAR/SPECI are not read through MessageArchive")
        if "neighbors/latest.json" in text:
            violations.append("neighbor-observation-context.js: legacy neighbour snapshot bypass remains")

    neighbor_taf = ROOT / "neighbor-taf-context.js"
    if neighbor_taf.exists():
        text = neighbor_taf.read_text(encoding="utf-8", errors="replace")
        if "A.getLatest('TAF',id,force)" not in text:
            violations.append("neighbor-taf-context.js: neighbour TAFs are not read through MessageArchive")
        if "taf-neighbors.json" in text:
            violations.append("neighbor-taf-context.js: legacy TAF snapshot bypass remains")

    if violations:
        print("ARCHIVE BOUNDARY VIOLATIONS:")
        for item in violations:
            print(f" - {item}")
        return 1

    print(
        f"Archive boundary OK: checked {len(targets)} browser/API files; all bulletin consumers use "
        "the shared Supabase-primary MessageArchive; Railway/GitHub/static are client-owned fallbacks only"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
