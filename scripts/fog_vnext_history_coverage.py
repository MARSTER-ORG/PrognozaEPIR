#!/usr/bin/env python3
"""Audit year coverage inside canonical EPIR history archives.

Diagnostic only; it never changes training labels or production data.
Besides member names and raw token hits, it opens every DOCX and looks for
explicit calendar dates containing 2025. This avoids false positives such as
SYNOP groups like 52025 or Word rsid values.
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
DATE_2025_RE = re.compile(r"(?:\b2025[-./]\d{1,2}[-./]\d{1,2}\b|\b\d{1,2}[-./]\d{1,2}[-./]2025\b)")


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


def inspect_docx(data: bytes, outer_info: zipfile.ZipInfo, member_name: str) -> dict | None:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as dz:
            text = docx_text(dz)
            core = docx_core_dates(dz)
    except zipfile.BadZipFile:
        return None

    reports = re.findall(r"\b(?:METAR|SPECI)\s+EPIR\s+\d{6}Z(?:\s+[^=]{0,500})?=", text, flags=re.I)
    times = re.findall(r"\b(?:METAR|SPECI)\s+EPIR\s+(\d{6}Z)\b", text, flags=re.I)
    explicit_dates = sorted(set(DATE_2025_RE.findall(text)))
    return {
        "member": member_name,
        "zip_member_timestamp": "%04d-%02d-%02dT%02d:%02d:%02d" % outer_info.date_time,
        "core_dates": core,
        "explicit_2025_dates": explicit_dates,
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
        "docx_named_2025": [],
        "docx_explicit_2025_dates": [],
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

        if ext == ".docx":
            details = inspect_docx(data, info, name)
            if details:
                if "2025" in name:
                    result["docx_named_2025"].append(details)
                if details.get("explicit_2025_dates"):
                    result["docx_explicit_2025_dates"].append(details)

        found = years_in_bytes(data)
        for year in found:
            result["year_content_hits"][year] += 1
            if len(result["examples"][year]) < MAX_HITS_PER_YEAR:
                result["examples"][year].append(f"content:{name}:{safe_snippet(data, year)}")

        if depth < 2 and ext in NESTED_ZIP_EXT and len(data) <= MAX_NESTED_BYTES:
            try:
                with zipfile.ZipFile(io.BytesIO(data)) as nested:
                    nested_result = scan_zip(nested, f"{label}!{name}", depth + 1)
                for year, count in nested_result["year_member_hits"].items():
                    result["year_member_hits"][year] += count
                for year, count in nested_result["year_content_hits"].items():
                    result["year_content_hits"][year] += count
                result["docx_named_2025"].extend(nested_result.get("docx_named_2025", []))
                result["docx_explicit_2025_dates"].extend(nested_result.get("docx_explicit_2025_dates", []))
                for year in YEARS:
                    room = MAX_HITS_PER_YEAR - len(result["examples"][year])
                    if room > 0:
                        result["examples"][year].extend(nested_result.get("examples", {}).get(year, [])[:room])
            except zipfile.BadZipFile:
                pass

    result["year_member_hits"] = dict(sorted(result["year_member_hits"].items()))
    result["year_content_hits"] = dict(sorted(result["year_content_hits"].items()))
    result["examples"] = {y: xs for y, xs in result["examples"].items() if xs}
    return result


def compact_doc(d: dict) -> dict:
    return {
        "member": d.get("member"),
        "zip_member_timestamp": d.get("zip_member_timestamp"),
        "core_dates": d.get("core_dates"),
        "explicit_2025_dates": d.get("explicit_2025_dates"),
        "epir_report_count": d.get("epir_report_count"),
        "first_report_time": d.get("first_report_time"),
        "last_report_time": d.get("last_report_time"),
        "first_report": d.get("first_report"),
        "last_report": d.get("last_report"),
        "text_preview": d.get("text_preview"),
    }


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

    # Full scan remains useful for debugging, but concise markers below are the
    # authoritative human-readable audit outputs.
    named = []
    dated = []
    for s in summaries:
        for d in s.get("docx_named_2025", []):
            named.append({"archive": s["label"], **compact_doc(d)})
        for d in s.get("docx_explicit_2025_dates", []):
            dated.append({"archive": s["label"], **compact_doc(d)})

    print("YEAR_2025_NAMED_DOCX=" + json.dumps(named, ensure_ascii=False))
    print("YEAR_2025_EXPLICIT_DATE_DOCX=" + json.dumps(dated, ensure_ascii=False))
    print("YEAR_2025_EXPLICIT_DATE_DOCX_COUNT=" + str(len(dated)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
