#!/usr/bin/env python3
"""Fail deployment if browser/API code bypasses central MessageArchive.

The check is intentionally semantic rather than formatting-sensitive: minifying or
reformatting message-archive-client.js must not break deployment as long as
Supabase remains PRIMARY and the shared fallback bridge is present.
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
DIRECT_MESSAGE_FILES = re.compile(r"data/messages/[^'\"`\s?#]+\.(?:json|jsonl)(?:[?#][^'\"`\s]*)?", re.I)
LEGACY_BULLETIN_FILES = re.compile(
    r"data/observations/(?:metar|synop)|data/taf/(?:latest|neighbors)\.json|(?:^|['\"`])taf-neighbors\.json(?:['\"`]|$)",
    re.I,
)
SERVICE_ROLE_CREDENTIAL = re.compile(r"SUPABASE_SERVICE_ROLE_KEY|['\"]service_role['\"]\s*[:=]", re.I)
CLIENT_SCRIPT = re.compile(r'<script\s+src=["\']message-archive-client\.js(?:\?[^"\']*)?["\']\s*></script>', re.I)
BRIDGED_LEGACY_READERS = {"fog-engine.js", "mifg-engine.js"}
TARGETS = [*ROOT.glob("*.html"), *ROOT.glob("*.js"), *ROOT.glob("api/*.js")]
BULLETIN_PAGES = ("index.html", "arch.html", "taf.html")


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def compact(text: str) -> str:
    return re.sub(r"\s+", "", text)


def validate_taf_archive_app(path: Path, label: str, violations: list[str]) -> None:
    if not path.exists():
        violations.append(f"{path.name}: missing {label}")
        return
    text = path.read_text(encoding="utf-8", errors="replace")
    if "window.PrognozaEPIRMessageArchive" not in text or "loadArchive()" not in text:
        violations.append(f"{path.name}: generator bypasses shared archive API")
    if "A.getLatest?.('TAF',id,true)" not in text:
        violations.append(f"{path.name}: neighbour TAFs are not read through MessageArchive.getLatest")


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
        if path.resolve() != CLIENT.resolve() and DIRECT_MESSAGE_FILES.search(text) and path.name not in BRIDGED_LEGACY_READERS:
            violations.append(f"{rel(path)}: direct bulletin JSON/JSONL access bypasses shared MessageArchive client")
        if path.resolve() != CLIENT.resolve() and LEGACY_BULLETIN_FILES.search(text):
            violations.append(f"{rel(path)}: legacy bulletin file/snapshot access bypasses MessageArchive")

    if not CLIENT.exists():
        violations.append("message-archive-client.js: missing shared archive client")
    else:
        text = CLIENT.read_text(encoding="utf-8", errors="replace")
        packed = compact(text)
        semantic_patterns = {
            "Supabase endpoint": SUPABASE_ARCHIVE,
            "public anon key": re.compile(r"\bSUPABASE_ANON\s*="),
            "Supabase enabled switch": re.compile(r"\bSUPABASE_ENABLED\s*="),
            "Railway fallback": RAILWAY_ARCHIVE,
            "Supabase request function": re.compile(r"\b(?:async\s+)?function\s+supabaseRequest\s*\(|\bsupabaseRequest\s*=", re.I),
            "range API": re.compile(r"\bgetRange\b"),
            "shared global API": re.compile(r"window\.PrognozaEPIRMessageArchive\s*=\s*api"),
            "legacy fetch bridge": re.compile(r"window\.fetch\s*=\s*async\s*function\s*\("),
            "Supabase source marker": re.compile(r"Supabase-primary-MessageArchive"),
        }
        for label, pattern in semantic_patterns.items():
            if not pattern.search(text):
                violations.append(f"message-archive-client.js: missing Supabase-primary invariant: {label}")
        # Accept both formatted and minified ternaries.
        if "PRIMARY_ROOT=SUPABASE_ENABLED?SUPABASE_API:" not in packed:
            violations.append("message-archive-client.js: Supabase is not configured as primary read source")
        # The bridge helper may be named legacy or legacyArchiveRequest; validate behavior, not identifier spelling.
        if not re.search(r"(?:legacy|legacyArchiveRequest)\s*=|function\s+(?:legacy|legacyArchiveRequest)\s*\(", text):
            violations.append("message-archive-client.js: same-origin legacy archive bridge helper missing")
        if SERVICE_ROLE_CREDENTIAL.search(text):
            violations.append("message-archive-client.js: service-role credential must never be present in browser code")

    for name in BULLETIN_PAGES:
        page = ROOT / name
        if not page.exists():
            violations.append(f"{name}: required bulletin-consuming page missing")
            continue
        text = page.read_text(encoding="utf-8", errors="replace")
        if not CLIENT_SCRIPT.search(text):
            violations.append(f"{name}: shared MessageArchive client is not loaded")

    index = ROOT / "index.html"
    if index.exists():
        text = index.read_text(encoding="utf-8", errors="replace")
        client_pos = text.find("message-archive-client.js")
        for script_name in sorted(BRIDGED_LEGACY_READERS):
            script_pos = text.find(script_name)
            if script_pos < 0:
                violations.append(f"index.html: expected bridged consumer {script_name} is not loaded")
            elif client_pos < 0 or client_pos > script_pos:
                violations.append(f"index.html: {script_name} loads before MessageArchive fetch bridge")
            module = ROOT / script_name
            if module.exists():
                module_text = module.read_text(encoding="utf-8", errors="replace")
                refs = DIRECT_MESSAGE_FILES.findall(module_text)
                if not refs or any(not ref.startswith("data/messages/latest.json") for ref in refs):
                    violations.append(f"{script_name}: compatibility read is not limited to data/messages/latest.json")

    taf = ROOT / "taf.html"
    if taf.exists():
        text = taf.read_text(encoding="utf-8", errors="replace")
        legacy_v2 = re.search(r'<script\s+src=["\']taf-app-v2\.js(?:\?[^"\']*)?["\']\s*></script>', text, re.I)
        active_v25 = re.search(r"loadScript\(['\"]taf-app-v25\.js(?:\?[^'\"]*)?['\"]", text, re.I)
        if active_v25:
            validate_taf_archive_app(ROOT / "taf-app-v25.js", "active TAF v2.5 application bridge", violations)
        elif legacy_v2:
            validate_taf_archive_app(ROOT / "taf-app-v2.js", "TAF Engine 2.3 application bridge", violations)
        else:
            violations.append("taf.html: no MessageArchive-backed TAF application bridge is loaded")

    observation = ROOT / "observation-engine.js"
    if observation.exists():
        text = observation.read_text(encoding="utf-8", errors="replace")
        if "PrognozaEPIRMessageArchive" not in text or "archiveLatest(" not in text or "archiveRecent(" not in text:
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

    if (ROOT / "taf-verification.js").exists():
        violations.append("taf-verification.js: obsolete private archive reader must not return")

    if violations:
        print("ARCHIVE BOUNDARY VIOLATIONS:")
        for item in violations:
            print(f" - {item}")
        return 1

    print(
        f"Archive boundary OK: checked {len(targets)} browser/API files; all METAR/SPECI/TAF/SYNOP consumers "
        "are Supabase-primary through MessageArchive; Railway/GitHub/static are client-owned fallbacks only"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())