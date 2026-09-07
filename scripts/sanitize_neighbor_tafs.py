#!/usr/bin/env python3
from __future__ import annotations

import html
import json
import re
from pathlib import Path

PATH = Path("data/taf/neighbors.json")
STATIONS = ("EPIR", "EPBY", "EPPW", "EPKS")

# A raw TAF consists of uppercase aviation groups, numbers and the standard
# separators used inside groups. Human-readable web-page prose therefore
# terminates the message even when the upstream page omits the final '='.
TOKEN_RE = re.compile(r"^[A-Z0-9+./-]+=?$")
HEADER_RE_TEMPLATE = r"^TAF(?:\s+(?:AMD|COR))?\s+{station}\s+\d{{6}}Z\s+\d{{4}}/\d{{4}}\b"

# Known presentation labels from HTML fallbacks. These are only an early cut;
# token validation below is the generic protection against future page changes.
PAGE_MARKERS_RE = re.compile(
    r"\s+(?:Pokaż\s+zdekodowaną\s+prognozę|Prognoza\s+ważna|"
    r"NOTAMy?\b|Chmury\s+i\s+widoczność|Pasy\s+i\s+wiatr|"
    r"Źródło\s*:|Ostatnia\s+aktualizacja\s*:)",
    re.I,
)


def sanitize_taf(raw: str, station: str) -> str | None:
    if not raw:
        return None
    text = html.unescape(str(raw))
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()

    start_re = re.compile(
        rf"\bTAF(?:\s+(?:AMD|COR))?\s+{re.escape(station)}\b", re.I
    )
    m = start_re.search(text)
    if not m:
        return None
    text = text[m.start():]

    # Prefer the explicit terminator whenever it is present.
    eq = text.find("=")
    if eq >= 0:
        text = text[: eq + 1]
    else:
        marker = PAGE_MARKERS_RE.search(text)
        if marker:
            text = text[: marker.start()]

        tokens: list[str] = []
        for token in text.split():
            if not TOKEN_RE.fullmatch(token):
                break
            tokens.append(token)
            if token.endswith("="):
                break
            # A genuine TAF is short. This also prevents swallowing a page made
            # mostly of uppercase labels if an upstream layout changes again.
            if len(tokens) >= 90:
                break
        text = " ".join(tokens)
        if text and not text.endswith("="):
            text += "="

    text = re.sub(r"\s*=\s*$", "=", re.sub(r"\s+", " ", text).strip())
    header_re = re.compile(
        HEADER_RE_TEMPLATE.format(station=re.escape(station)), re.I
    )
    if not header_re.search(text):
        return None
    if len(text) > 1600:
        return None
    return text


def main() -> int:
    payload = json.loads(PATH.read_text(encoding="utf-8"))
    stations = payload.get("stations") or {}
    changed = False

    for station in STATIONS:
        row = stations.get(station) or {}
        raw = row.get("raw")
        if not raw:
            continue
        cleaned = sanitize_taf(raw, station)
        if not cleaned:
            # Never publish an unvalidated scraped page as a TAF.
            row["available"] = False
            row["raw"] = None
            changed = True
            print(f"{station}: rejected invalid TAF payload")
            continue
        if cleaned != raw:
            print(f"{station}: sanitized {len(raw)} -> {len(cleaned)} chars")
            row["raw"] = cleaned
            changed = True

    if changed:
        PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    else:
        print("TAF cache already clean")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
