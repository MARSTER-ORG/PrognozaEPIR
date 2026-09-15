#!/usr/bin/env python3
"""Audit year coverage inside canonical EPIR history archives.

This is a diagnostic only. It never changes training labels or production data.
It inspects ZIP member names plus textual/nested ZIP content so that a year can
be discovered even when it is not present in the outer archive filename.
For DOCX members whose filename says 2025 it also extracts Word metadata and
EPIR METAR/SPECI report tokens to distinguish real 2025 material from a typo.
"""
from __future__ import annotations

import io
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path

ROOTS = [Path("data/import/epir-history"), Path("data/import/epir")]
YEARS = tuple(str(y) for y in range(2020, 2027))
TEXT_EXT = {
    ".txt", ".csv", ".json", ".jsonl", ".xml", ".html", ".htm",
    ".md", ".log", ".dat", ".tsv", ".yaml", ".yml",
}
NESTED_ZIP_EXT = {".zip", ".docx", ".xlsx", ".xlsm", ".ods"}
MAX_NESTED_BYTES = 80 * 1024 * 1024
MAX_HITS_PER_YEAR = 5


def years_in_bytes(data: bytes) -> set[str]:
    return {year for year in YEARS if year.encode("ascii") in data}


def safe_snippet(data: bytes, year: str) -> str:
    needle = year.encode("ascii")
    pos = data.find(needle)
    if pos < 0:
        return ""
    lo = max(0, pos - 70)
    hi = min(len(data), pos + 100)
    return re.sub(r"\s+", " ", data[lo:hi].decode("utf-8", errors="replace")).strip()


def docx_text(dz: zipfile.ZipFile) -> str:
    try:
        raw = dz.read("word/document.xml")
    except KeyError:
        return ""
    try:
        root = ET.fromstring(raw)
        chunks = [node.text or "" for node in root.iter() if node.tag.endswith("}t")]
        return re.sub(r"\s+", " ", " ".join(chunks)).strip()
    except ET.ParseError:
        return re.sub(r"<[^>]+>", " ", raw.decode("utf-8", errors="replace"))


def docx_core_dates(dz: zipfile.ZipFile) -> dict:
    try:
        raw = dz.read("docProps/core.xml")
    except KeyError:
        return {}
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return {}
    out = {}
    for node in root.iter():
        local = node.tag.rsplit("}", 1)[-1]
        if local in {"created", "modified", "lastPrinted"} and node.text:
            out[local] = node.text
    return out


def inspect_2025_docx(data: bytes, outer_info: zipfile.ZipInfo, member_name: str) -> dict | None:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as dz:
            text = docx_text(dz)
            core = docx_core_dates(dz)
    except zipfile.BadZipFile:
        return None

    reports = re.findall(r"\b(?:METAR|SPECI)\s+EPIR\s+\d{6}Z(?:\s+[^=]{0,500})?=", text, flags=re.I)
    times = re.findall(r"\b(?:METAR|SPECI)\s+EPIR\s+(\d{6}Z)\b", text, flags=re.I)
    years_in_text = sorted({year for year in YEARS if year in text})
    return {
        "member": member_name,
        "zip_member_timestamp": "%04d-%02d-%02dT%02d:%02d:%02d" % outer_info.date_time,
        "core_dates": core,
        "years_in_document_text": years_in_text,
        "epir_report_count": len(times),
        "first_report_time": times[0] if times else None,
        "last_report_time": times[-1] if times else None,
        "first_report": reports[0][:260] if reports else None,
        "last_report": reports[-1][:260] if reports else None,
        "text_preview": text[:500],
    }


def scan_zip(zf: zipfile.ZipFile, label: str, depth: int = 0) -> dict:
    result = {
        "label": label,
        "members": len(zf.infolist()),
        "year_member_hits": Counter(),
        "year_content_hits": Counter(),
        "examples": {year: [] for year in YEARS},
        "member_names": [],
        "docx_2025_details": [],
    }

    for info in zf.infolist():
        if info.is_dir():
            continue
        name = info.filename
        if len(result["member_names"]) < 40:
            result["member_names"].append(name)
        for year in YEARS:
            if year in name:
                result["year_member_hits"][year] += 1
                if len(result["examples"][year]) < MAX_HITS_PER_YEAR:
                    result["examples"][year].append(f"name:{name}")

        ext = Path(name).suffix.lower()
        should_read = ext in TEXT_EXT or ext in NESTED_ZIP_EXT or info.file_size <= 2 * 1024 * 1024
        if not should_read:
            continue
        try:
            data = zf.read(info)
        except Exception as exc:
            print(f"WARN cannot read {label}!{name}: {exc}", file=sys.stderr)
            continue

        if ext == ".docx" and "2025" in name:
            details = inspect_2025_docx(data, info, name)
            if details:
                result["docx_2025_details"].append(details)

        found = years_in_bytes(data)
        for year in found:
            result["year_content_hits"][year] += 1
            if len(result["examples"][year]) < MAX_HITS_PER_YEAR:
                snippet = safe_snippet(data, year)
                result["examples"][year].append(f"content:{name}:{snippet}")

        if depth < 2 and ext in NESTED_ZIP_EXT and len(data) <= MAX_NESTED_BYTES:
            try:
                with zipfile.ZipFile(io.BytesIO(data)) as nested:
                    nested_result = scan_zip(nested, f"{label}!{name}", depth + 1)
                for year, count in nested_result["year_member_hits"].items():
                    result["year_member_hits"][year] += count
                for year, count in nested_result["year_content_hits"].items():
                    result["year_content_hits"][year] += count
                result["docx_2025_details"].extend(nested_result.get("docx_2025_details", []))
                for year in YEARS:
                    room = MAX_HITS_PER_YEAR - len(result["examples"][year])
                    if room > 0:
                        result["examples"][year].extend(nested_result["examples"][year][:room])
            except zipfile.BadZipFile:
                pass

    result["year_member_hits"] = dict(sorted(result["year_member_hits"].items()))
    result["year_content_hits"] = dict(sorted(result["year_content_hits"].items()))
    result["examples"] = {y: xs for y, xs in result["examples"].items() if xs}
    return result


def main() -> int:
    archives: list[Path] = []
    for root in ROOTS:
        if root.exists():
            archives.extend(sorted(root.rglob("*.zip")))

    summaries = []
    for path in archives:
        try:
            with zipfile.ZipFile(path) as zf:
                summaries.append(scan_zip(zf, str(path)))
        except zipfile.BadZipFile as exc:
            summaries.append({"label": str(path), "error": f"BadZipFile: {exc}"})

    print(json.dumps({"archives": summaries}, ensure_ascii=False, indent=2))

    hits_2025 = [
        s for s in summaries
        if s.get("year_member_hits", {}).get("2025", 0) or s.get("year_content_hits", {}).get("2025", 0)
    ]
    print("YEAR_2025_ARCHIVES=" + json.dumps([s["label"] for s in hits_2025], ensure_ascii=False))
    details_2025 = [
        {"archive": s["label"], "documents": s.get("docx_2025_details", [])}
        for s in summaries if s.get("docx_2025_details")
    ]
    print("YEAR_2025_DOCX_DETAILS=" + json.dumps(details_2025, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
