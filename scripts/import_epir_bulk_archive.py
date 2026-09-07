#!/usr/bin/env python3
"""Bulk importer for historical EPIR METAR/SPECI, SYNOP (AAXX) and TAF.

Designed for archives pasted/exported in different text layouts. It accepts
Markdown tables, TSV/CSV-ish rows and ordinary text/log files. A record only
needs a UTC timestamp somewhere before/alongside the bulletin, or a date in the
filename that allows the DDHHMMZ / DDHH1 bulletin time to be resolved.

Input directory:
    data/import/epir/

Generated archives:
    data/observations/metar/YYYY/MM/DD.jsonl
    data/observations/synop/YYYY/MM/DD.jsonl
    data/taf/archive/YYYY/MM/DD.jsonl

The import is idempotent. METAR/SYNOP replace older rows for the same station
and observation time. TAF keeps every unique bulletin revision (NORMAL/AMD/COR)
without duplicating an identical raw bulletin.
"""
from __future__ import annotations

import argparse
import base64
import bz2
import json
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import collect_epir_observations as obs

ROOT = Path(__file__).resolve().parents[1]
INBOX = ROOT / "data" / "import" / "epir"
OBS_ROOT = ROOT / "data" / "observations"
TAF_ROOT = ROOT / "data" / "taf" / "archive"
TEXT_SUFFIXES = {".txt", ".md", ".csv", ".tsv", ".log", ".dat", ".b64"}

YMD_RE = re.compile(
    r"(?<!\d)(?P<y>20\d{2})[-/.](?P<m>\d{1,2})[-/.](?P<d>\d{1,2})"
    r"(?:[ T,;|\t]+(?P<h>\d{1,2}):(?P<mi>\d{2})(?::(?P<s>\d{2}))?)?"
    r"(?:\s*(?:Z|UTC))?",
    re.I,
)
DMY_RE = re.compile(
    r"(?<!\d)(?P<d>\d{1,2})[./](?P<m>\d{1,2})[./](?P<y>20\d{2})"
    r"(?:[ T,;|\t]+(?P<h>\d{1,2}):(?P<mi>\d{2})(?::(?P<s>\d{2}))?)?"
    r"(?:\s*(?:Z|UTC))?",
    re.I,
)
REPORT_START_RE = re.compile(r"\b(?:METAR|SPECI|TAF|AAXX)\b", re.I)
REPORT_WITH_END_RE = re.compile(r"\b(?:METAR|SPECI|TAF|AAXX)\b.*?=", re.I | re.S)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_explicit_dt(text: str) -> datetime | None:
    for rx in (YMD_RE, DMY_RE):
        m = rx.search(text)
        if not m:
            continue
        gd = m.groupdict()
        try:
            return datetime(
                int(gd["y"]), int(gd["m"]), int(gd["d"]),
                int(gd.get("h") or 0), int(gd.get("mi") or 0), int(gd.get("s") or 0),
                tzinfo=timezone.utc,
            )
        except ValueError:
            continue
    return None


def filename_anchor(path: Path) -> datetime | None:
    s = path.name
    for rx in (
        re.compile(r"(?<!\d)(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?!\d)"),
        re.compile(r"(?<!\d)(\d{2})[._-](\d{2})[._-](20\d{2})(?!\d)"),
    ):
        m = rx.search(s)
        if not m:
            continue
        try:
            if len(m.group(1)) == 4:
                y, mo, d = map(int, m.groups())
            else:
                d, mo, y = map(int, m.groups())
            return datetime(y, mo, d, tzinfo=timezone.utc)
        except ValueError:
            pass
    return None


def month_candidates(ref: datetime, day: int, hour: int, minute: int = 0):
    out = []
    for delta in (-1, 0, 1):
        y = ref.year
        mo = ref.month + delta
        if mo < 1:
            y -= 1
            mo += 12
        elif mo > 12:
            y += 1
            mo -= 12
        try:
            # Hour 24 is legal in TAF validity groups and means next-day 00 UTC.
            base = datetime(y, mo, day, 0, minute, tzinfo=timezone.utc)
            out.append(base + timedelta(hours=hour))
        except ValueError:
            continue
    return out


def infer_dt_from_report(report: str, anchor: datetime | None) -> datetime | None:
    if anchor is None:
        return None
    up = report.upper()
    if up.startswith(("METAR ", "SPECI ", "TAF ")):
        m = re.search(r"\b(\d{2})(\d{2})(\d{2})Z\b", up)
        if m:
            dd, hh, mm = map(int, m.groups())
            cands = month_candidates(anchor, dd, hh, mm)
            return min(cands, key=lambda d: abs((d - anchor).total_seconds())) if cands else None
    if up.startswith("AAXX "):
        # YYGGiw: day, UTC hour, wind indicator.
        m = re.search(r"\bAAXX\s+(\d{2})(\d{2})[0-4/]\b", up)
        if m:
            dd, hh = map(int, m.groups())
            cands = month_candidates(anchor, dd, hh, 0)
            return min(cands, key=lambda d: abs((d - anchor).total_seconds())) if cands else None
    return None


def clean_report(text: str) -> str | None:
    m = REPORT_WITH_END_RE.search(text)
    if not m:
        return None
    return re.sub(r"\s+", " ", m.group(0)).strip()


def read_source_text(path: Path) -> str:
    if path.name.lower().endswith(".bz2.b64"):
        packed = base64.b64decode(path.read_text(encoding="ascii").strip(), validate=True)
        return bz2.decompress(packed).decode("utf-8-sig", errors="replace")
    return path.read_text(encoding="utf-8-sig", errors="replace")


def iter_records(path: Path):
    text = read_source_text(path)
    base_anchor = filename_anchor(path) or parse_explicit_dt(text[:20000])
    pending = ""
    pending_dt = None
    pending_anchor = base_anchor

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        explicit = parse_explicit_dt(line)
        if explicit:
            pending_anchor = explicit

        if pending:
            pending += " " + line.strip(" |\t")
            if "=" not in line:
                continue
            report = clean_report(pending)
            if report:
                dt = pending_dt or infer_dt_from_report(report, pending_anchor)
                yield dt, report, raw_line
            pending = ""
            pending_dt = None
            continue

        start = REPORT_START_RE.search(line)
        if not start:
            continue
        chunk = line[start.start():].strip(" |\t\"")
        if "=" not in chunk:
            pending = chunk
            pending_dt = explicit
            continue
        report = clean_report(chunk)
        if report:
            dt = explicit or infer_dt_from_report(report, pending_anchor)
            yield dt, report, raw_line

    if pending:
        report = clean_report(pending)
        if report:
            dt = pending_dt or infer_dt_from_report(report, pending_anchor)
            yield dt, report, pending


def read_jsonl(path: Path):
    rows = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def write_jsonl(path: Path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    text = "".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in rows)
    old = path.read_text(encoding="utf-8") if path.exists() else None
    if old == text:
        return False
    path.write_text(text, encoding="utf-8")
    return True


def canonical_obs_path(kind: str, dt: datetime) -> Path:
    return OBS_ROOT / kind / f"{dt:%Y}" / f"{dt:%m}" / f"{dt:%d}.jsonl"


def merge_observations(path: Path, imported):
    # Manual archive is authoritative for identical station + observation time.
    imported_keys = {(r.get("station"), r.get("obs_time")) for r in imported}
    rows = [r for r in read_jsonl(path) if (r.get("station"), r.get("obs_time")) not in imported_keys]
    unique = {(r.get("station"), r.get("obs_time")): r for r in imported}
    rows.extend(unique.values())
    rows.sort(key=lambda r: (r.get("obs_time") or "", r.get("station") or ""))
    return write_jsonl(path, rows)


def resolve_taf_validity(token: str, issue: datetime) -> datetime | None:
    if not re.fullmatch(r"\d{4}", token):
        return None
    dd, hh = int(token[:2]), int(token[2:])
    cands = month_candidates(issue, dd, hh, 0)
    if not cands:
        return None
    return min(cands, key=lambda d: abs((d - issue).total_seconds()))


def decode_taf(report: str, issue: datetime, source_file: str):
    up = re.sub(r"\s+", " ", report).strip()
    if not up.upper().startswith("TAF ") or " EPIR " not in f" {up.upper()} ":
        return None
    status = "NORMAL"
    if re.match(r"^TAF\s+AMD\b", up, re.I):
        status = "AMD"
    elif re.match(r"^TAF\s+COR\b", up, re.I):
        status = "COR"
    mvalid = re.search(r"\b(\d{4})/(\d{4})\b", up)
    vstart = vend = None
    if mvalid:
        vstart = resolve_taf_validity(mvalid.group(1), issue)
        vend = resolve_taf_validity(mvalid.group(2), issue)
        if vstart and vend and vend <= vstart:
            while vend <= vstart:
                vend += timedelta(days=1)
    return {
        "schema": "prognozaepir-taf-archive-v1",
        "source": "MANUAL_BULK_IMPORT",
        "source_file": source_file,
        "station": "EPIR",
        "issue_time": iso(issue),
        "status": status,
        "cancelled": bool(re.search(r"\bCNL\b", up, re.I)),
        "valid_from": iso(vstart) if vstart else None,
        "valid_to": iso(vend) if vend else None,
        "raw": up,
    }


def merge_tafs(path: Path, imported):
    rows = read_jsonl(path)
    seen = {(r.get("issue_time"), r.get("raw")) for r in rows}
    for r in imported:
        key = (r.get("issue_time"), r.get("raw"))
        if key not in seen:
            rows.append(r)
            seen.add(key)
    rows.sort(key=lambda r: (r.get("issue_time") or "", r.get("status") or "", r.get("raw") or ""))
    return write_jsonl(path, rows)


def input_files(paths):
    if paths:
        for item in paths:
            p = Path(item)
            if not p.is_absolute():
                p = ROOT / p
            if p.is_file():
                yield p
            elif p.is_dir():
                yield from sorted(x for x in p.rglob("*") if x.is_file() and x.suffix.lower() in TEXT_SUFFIXES)
        return
    if INBOX.exists():
        yield from sorted(
            x for x in INBOX.rglob("*")
            if x.is_file() and x.suffix.lower() in TEXT_SUFFIXES and not x.name.lower().startswith("readme")
        )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="*", help="optional files/directories; default data/import/epir")
    ap.add_argument("--strict", action="store_true", help="fail if a recognizable bulletin cannot be timestamped/decoded")
    args = ap.parse_args()

    grouped_obs = {"metar": defaultdict(list), "synop": defaultdict(list)}
    grouped_taf = defaultdict(list)
    counts = {"metar": 0, "synop": 0, "taf": 0, "rejected": 0, "files": 0}
    rejects = []

    for path in input_files(args.paths):
        counts["files"] += 1
        rel = str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)
        for dt, report, _raw_line in iter_records(path):
            if dt is None:
                counts["rejected"] += 1
                rejects.append(f"{rel}: missing UTC timestamp: {report[:140]}")
                continue
            up = report.upper()
            decoded = None
            kind = None
            try:
                if up.startswith(("METAR ", "SPECI ")):
                    decoded = obs.decode_metar(report, dt, source="MANUAL_BULK_METAR")
                    kind = "metar"
                elif up.startswith("AAXX "):
                    decoded = obs.decode_synop(report, dt)
                    kind = "synop"
                    if decoded:
                        decoded["source"] = "MANUAL_BULK_SYNOP_RAW"
                elif up.startswith("TAF "):
                    decoded = decode_taf(report, dt, rel)
                    kind = "taf"
            except Exception as exc:
                rejects.append(f"{rel}: decode error {exc}: {report[:140]}")

            if not decoded or not kind:
                counts["rejected"] += 1
                if not any(report[:80] in x for x in rejects):
                    rejects.append(f"{rel}: rejected: {report[:140]}")
                continue

            if kind in ("metar", "synop"):
                decoded["source_file"] = rel
                grouped_obs[kind][dt.strftime("%Y-%m-%d")].append(decoded)
            else:
                grouped_taf[dt.strftime("%Y-%m-%d")].append(decoded)
            counts[kind] += 1

    changed = []
    for kind in ("metar", "synop"):
        for day, rows in sorted(grouped_obs[kind].items()):
            dt = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            path = canonical_obs_path(kind, dt)
            if merge_observations(path, rows):
                changed.append(str(path.relative_to(ROOT)))

    for day, rows in sorted(grouped_taf.items()):
        dt = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        path = TAF_ROOT / f"{dt:%Y}" / f"{dt:%m}" / f"{dt:%d}.jsonl"
        if merge_tafs(path, rows):
            changed.append(str(path.relative_to(ROOT)))

    summary = {
        "schema": "prognozaepir-bulk-import-v1",
        "input_files": counts["files"],
        "decoded_metar": counts["metar"],
        "decoded_synop": counts["synop"],
        "decoded_taf": counts["taf"],
        "rejected": counts["rejected"],
        "changed_files": changed,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if rejects:
        print("\n".join(rejects[:50]))
    if args.strict and counts["rejected"]:
        raise SystemExit(f"Rejected {counts['rejected']} recognizable bulletin(s)")


if __name__ == "__main__":
    main()
