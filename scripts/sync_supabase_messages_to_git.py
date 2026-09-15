#!/usr/bin/env python3
"""Mirror canonical weather messages from Supabase into GitHub JSONL history.

This intentionally uses only the public SELECT policy on ``public.messages``.
It does not use the service-role backup Edge Function. Rows are normalized by
scripts/message_archive.py so the mirror writes exactly the same canonical
``data/messages/<type>/YYYY/MM/DD.jsonl`` tree used by the live archive.

Typical use:
  python3 scripts/sync_supabase_messages_to_git.py --year 2025
  python3 scripts/sync_supabase_messages_to_git.py --days 3
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import collect_epir_observations as obs  # noqa: E402
import message_archive as archive  # noqa: E402

PROJECT_REF = os.getenv("SUPABASE_PROJECT_REF", "qozgntzeormujmqzkkmd")
REST_URL = os.getenv("SUPABASE_REST_URL", f"https://{PROJECT_REF}.supabase.co/rest/v1/messages")
PAGE_SIZE = 1000
TYPE_CONFIG = {
    "METAR": {"station": "EPIR", "time_col": "observed_at"},
    "SPECI": {"station": "EPIR", "time_col": "observed_at"},
    "SYNOP": {"station": "12342", "time_col": "observed_at"},
    "TAF": {"station": "EPIR", "time_col": "issued_at"},
}
SELECT_FIELDS = "id,message_type,station_code,observed_at,issued_at,archive_time,raw_text,source_ref,payload"


def public_anon_key() -> str:
    value = os.getenv("SUPABASE_ANON_KEY", "").strip()
    if value:
        return value
    client = (ROOT / "message-archive-client.js").read_text(encoding="utf-8")
    match = re.search(r"const\s+SUPABASE_ANON\s*=\s*['\"]([^'\"]+)['\"]", client)
    if not match:
        raise RuntimeError("SUPABASE_ANON_KEY not set and public key not found in message-archive-client.js")
    return match.group(1)


def parse_time(value: object) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def iso(dt: datetime | None) -> str | None:
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z") if dt else None


def fetch_type(kind: str, start: datetime, end: datetime) -> list[dict]:
    cfg = TYPE_CONFIG[kind]
    key = public_anon_key()
    offset = 0
    out: list[dict] = []
    while True:
        params = {
            "select": SELECT_FIELDS,
            "message_type": f"eq.{kind}",
            "station_code": f"eq.{cfg['station']}",
            cfg["time_col"]: f"gte.{iso(start)}",
            f"{cfg['time_col']}.lt": iso(end),
            "order": f"{cfg['time_col']}.asc,id.asc",
            "limit": PAGE_SIZE,
            "offset": offset,
        }
        # PostgREST uses the column name once for each operator. urllib cannot
        # represent duplicate keys cleanly through a dict, so build the two
        # time predicates explicitly.
        base = {
            "select": SELECT_FIELDS,
            "message_type": f"eq.{kind}",
            "station_code": f"eq.{cfg['station']}",
            "order": f"{cfg['time_col']}.asc,id.asc",
            "limit": str(PAGE_SIZE),
            "offset": str(offset),
        }
        query = urllib.parse.urlencode(base)
        query += "&" + urllib.parse.quote(cfg["time_col"], safe="") + "=" + urllib.parse.quote(f"gte.{iso(start)}", safe=".-:TZ+")
        query += "&" + urllib.parse.quote(cfg["time_col"], safe="") + "=" + urllib.parse.quote(f"lt.{iso(end)}", safe=".-:TZ+")
        req = urllib.request.Request(
            REST_URL + "?" + query,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {key}",
                "apikey": key,
                "User-Agent": "PrognozaEPIR-Message-Mirror/1",
            },
        )
        with urllib.request.urlopen(req, timeout=45) as response:
            page = json.loads(response.read().decode("utf-8"))
        if not isinstance(page, list):
            raise RuntimeError(f"{kind}: invalid Supabase response")
        out.extend(page)
        if len(page) < PAGE_SIZE:
            break
        offset += len(page)
    return out


def canonical_from_row(row: dict) -> dict | None:
    kind = str(row.get("message_type") or "").upper()
    cfg = TYPE_CONFIG.get(kind)
    if not cfg:
        return None
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
    raw = str(row.get("raw_text") or payload.get("raw") or "").strip()
    when = parse_time(row.get(cfg["time_col"]) or row.get("archive_time") or payload.get("message_time"))
    if not raw or not when:
        return None

    source = str(payload.get("source") or "SUPABASE_MESSAGE_MIRROR")
    source_ref = str(row.get("source_ref") or payload.get("archive_source_file") or "").strip() or None

    decoded: dict | None
    if kind in {"METAR", "SPECI"}:
        decoded = obs.decode_metar(raw, when, source=source)
        if decoded:
            decoded["report_type"] = kind
    elif kind == "SYNOP":
        decoded = obs.decode_synop(raw, when)
        if decoded:
            decoded["source"] = source
    else:  # TAF payload already contains the canonical issue-time metadata.
        decoded = dict(payload)
        decoded.setdefault("raw", raw)
        decoded.setdefault("station", cfg["station"])
        decoded.setdefault("issue_time", iso(when))
        decoded.setdefault("source", source)

    if not decoded:
        decoded = dict(payload)
        decoded.update(raw=raw, station=cfg["station"], source=source)
        if kind == "TAF":
            decoded.setdefault("issue_time", iso(when))
        else:
            decoded.setdefault("obs_time", iso(when))

    if source_ref:
        decoded["archive_source_file"] = source_ref
        decoded["source_file"] = source_ref
    decoded["supabase_message_id"] = row.get("id")
    return archive.norm(decoded, kind, source_ref)


def resolve_window(args: argparse.Namespace) -> tuple[datetime, datetime]:
    if args.year is not None:
        return (
            datetime(args.year, 1, 1, tzinfo=timezone.utc),
            datetime(args.year + 1, 1, 1, tzinfo=timezone.utc),
        )
    if args.from_date or args.to_date:
        if not args.from_date or not args.to_date:
            raise SystemExit("--from-date and --to-date must be supplied together")
        start = datetime.combine(date.fromisoformat(args.from_date), datetime.min.time(), tzinfo=timezone.utc)
        # --to-date is inclusive for operator convenience.
        end = datetime.combine(date.fromisoformat(args.to_date) + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc)
        return start, end
    days = max(1, int(args.days or 3))
    today = datetime.now(timezone.utc).date()
    start = datetime.combine(today - timedelta(days=days - 1), datetime.min.time(), tzinfo=timezone.utc)
    end = datetime.combine(today + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc)
    return start, end


def main() -> int:
    ap = argparse.ArgumentParser()
    window = ap.add_mutually_exclusive_group()
    window.add_argument("--year", type=int)
    window.add_argument("--days", type=int, default=3)
    ap.add_argument("--from-date", help="UTC YYYY-MM-DD, requires --to-date")
    ap.add_argument("--to-date", help="UTC YYYY-MM-DD inclusive, requires --from-date")
    ap.add_argument("--types", default=",".join(TYPE_CONFIG), help="comma-separated METAR,SPECI,SYNOP,TAF")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    start, end = resolve_window(args)
    kinds = [x.strip().upper() for x in args.types.split(",") if x.strip()]
    unknown = sorted(set(kinds) - set(TYPE_CONFIG))
    if unknown:
        raise SystemExit(f"unsupported message types: {unknown}")

    db_rows: list[dict] = []
    fetched_by_type: Counter[str] = Counter()
    for kind in kinds:
        rows = fetch_type(kind, start, end)
        db_rows.extend(rows)
        fetched_by_type[kind] += len(rows)

    canonical: list[dict] = []
    rejected: list[dict] = []
    for row in db_rows:
        msg = canonical_from_row(row)
        if msg:
            canonical.append(msg)
        else:
            rejected.append({
                "id": row.get("id"),
                "message_type": row.get("message_type"),
                "time": row.get("observed_at") or row.get("issued_at") or row.get("archive_time"),
                "source_ref": row.get("source_ref"),
            })

    if rejected:
        print(json.dumps({"rejected": rejected[:20], "rejected_count": len(rejected)}, ensure_ascii=False), file=sys.stderr)
        raise RuntimeError(f"refusing partial mirror: {len(rejected)} Supabase rows could not be normalized")

    result = {
        "schema": "prognozaepir-supabase-message-mirror-v1",
        "window": {"from": iso(start), "to_exclusive": iso(end)},
        "fetched": len(db_rows),
        "fetched_by_type": dict(sorted(fetched_by_type.items())),
        "normalized": len(canonical),
        "dry_run": bool(args.dry_run),
    }
    if args.dry_run:
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
        return 0

    stat = archive.ingest(canonical)
    counts = archive.views(stat, full=True)
    checked = archive.validate()
    result.update(ingest=stat, archive_counts=counts, checked_records=checked)
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
