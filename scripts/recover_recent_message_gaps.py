#!/usr/bin/env python3
"""Bounded, idempotent recovery of original EPIR TAF and WMO 12342 SYNOP.

Only imports bulletins actually returned by the provider. Never estimates
SYNOP from METAR or constructs a replacement TAF.
"""
from __future__ import annotations

import json
import re
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collect_epir_observations as obs
import import_epir_bulk_archive as bulk
import message_archive as archive
import supabase_message_mirror as mirror

MAX_DAYS = 14


def fetch_csv(kind: str, begin: datetime, end: datetime):
    if kind == "TAF":
        name, selector, station = "gettafor", {"icao": "EPIR"}, "EPIR"
    elif kind == "SYNOP":
        name, selector, station = "getsynop", {"block": "12342"}, "12342"
    else:
        raise ValueError(kind)
    query = {
        **selector,
        "begin": begin.strftime("%Y%m%d%H%M"),
        "end": end.strftime("%Y%m%d%H%M"),
        "header": "yes",
        "lang": "eng",
    }
    url = "https://www.ogimet.com/cgi-bin/" + name + "?" + urllib.parse.urlencode(query)
    response = obs.get_text(url, timeout=35)
    if not response or "<html" in response[:500].lower():
        raise RuntimeError(f"{kind}: source did not return CSV")
    rows = [(when, raw) for when, raw in obs.csv_rows(response, station)
            if begin <= when <= end and 0 < len(raw) <= 32768]
    return url, rows


def parse_records(kind: str, url: str, csv_records):
    out = []
    for when, raw in csv_records:
        if kind == "TAF":
            report = re.sub(r"\s+", " ", raw).strip().rstrip("=")
            if re.match(r"^EPIR\s+\d{6}Z\b", report, re.I):
                report = "TAF " + report
            if not re.match(r"^TAF\s+(?:(?:AMD|COR)\s+)?EPIR\s+\d{6}Z\b", report, re.I):
                continue
            match = re.search(r"\bEPIR\s+(\d{2})(\d{2})(\d{2})Z\b", report, re.I)
            if not match or (when.day, when.hour, when.minute) != tuple(map(int, match.groups())):
                continue
            decoded = bulk.decode_taf(report, when, url)
        else:
            decoded = obs.decode_synop(raw, when)
            if decoded:
                decoded["source"] = "OGIMET_SYNOP_HISTORY_RECOVERY"
        if not decoded:
            continue
        decoded["source"] = decoded.get("source") or "OGIMET_TAF_HISTORY_RECOVERY"
        decoded["source_url"] = url
        row = archive.norm(decoded, kind)
        if row:
            out.append(row)
    return out


def main():
    now = datetime.now(timezone.utc)
    begin = (now - timedelta(days=MAX_DAYS)).replace(hour=0, minute=0, second=0, microsecond=0)
    end = now + timedelta(minutes=5)
    recovered, status = [], {}
    for kind in ("TAF", "SYNOP"):
        try:
            url, csv_records = fetch_csv(kind, begin, end)
            rows = parse_records(kind, url, csv_records)
            recovered.extend(rows)
            status[kind.lower()] = {"source_rows": len(csv_records), "validated": len(rows)}
        except Exception as exc:
            status[kind.lower()] = {"source_error": f"{type(exc).__name__}: {exc}"}

    unique = {row["message_id"]: row for row in recovered}
    rows = sorted(unique.values(), key=lambda row: (row["message_time"], row["message_id"]))
    stats = archive.ingest(rows) if rows else {"added": 0, "enriched": 0, "files": []}
    if stats["added"] or stats["enriched"]:
        archive.views(stats)

    mirrored = {"sent": 0, "inserted": 0, "duplicates": 0}
    if rows and mirror.ENABLED and mirror.URL and mirror.INGEST_TOKEN:
        try:
            batch_size = min(mirror.BATCH_SIZE, 100)
            for start in range(0, len(rows), batch_size):
                batch = rows[start:start + batch_size]
                result = mirror.post_batch(batch)
                mirrored["sent"] += len(batch)
                mirrored["inserted"] += int(result.get("inserted") or 0)
                mirrored["duplicates"] += int(result.get("duplicates") or 0)
        except Exception as exc:
            mirrored["error"] = f"{type(exc).__name__}: {exc}"

    print(json.dumps({
        "schema": "prognozaepir-message-gap-recovery-v1",
        "lookback_days": MAX_DAYS,
        "source": status,
        "validated_unique": len(rows),
        "local_archive": stats,
        "supabase": mirrored,
    }, ensure_ascii=False), flush=True)
    return 0 if "error" not in mirrored else 2


if __name__ == "__main__":
    raise SystemExit(main())
