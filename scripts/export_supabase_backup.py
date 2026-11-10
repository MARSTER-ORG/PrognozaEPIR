#!/usr/bin/env python3
"""Export the PrognozaEPIR Supabase database into a Git-friendly daily snapshot.

The export is logical, not a physical PostgreSQL dump. It contains all rows from
core application tables plus schema metadata (columns, constraints, indexes,
RLS policies, triggers, public functions and extensions). The Supabase anon key
is public by design and is read from message-archive-client.js if not supplied
through the environment. The Edge Function itself uses service-role privileges
and only exposes the fixed backup whitelist.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "backups" / "supabase" / "daily"
TMP = ROOT / "backups" / "supabase" / ".daily.tmp"
PROJECT_REF = os.getenv("SUPABASE_PROJECT_REF", "qozgntzeormujmqzkkmd")
BACKUP_URL = os.getenv(
    "SUPABASE_BACKUP_URL",
    f"https://{PROJECT_REF}.supabase.co/functions/v1/backup-export",
)
TABLES = (
    "message_sources",
    "stations",
    "messages",
    "ingest_runs",
    "forecasts",
    "forecast_verifications",
)
PAGE_SIZE = 1000
# This file is watched by the daily-backup workflow; updates also exercise the backup path immediately.


def public_anon_key() -> str:
    value = os.getenv("SUPABASE_ANON_KEY", "").strip()
    if value:
        return value
    client = (ROOT / "message-archive-client.js").read_text(encoding="utf-8")
    match = re.search(r"const\s+SUPABASE_ANON\s*=\s*['\"]([^'\"]+)['\"]", client)
    if not match:
        raise RuntimeError("SUPABASE_ANON_KEY not set and public key not found in message-archive-client.js")
    return match.group(1)


ANON_KEY = public_anon_key()


def get_json(params: dict[str, object], attempts: int = 4) -> dict:
    query = urllib.parse.urlencode({k: str(v) for k, v in params.items()})
    url = BACKUP_URL + ("?" + query if query else "")
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "Accept": "application/json",
                    "Authorization": f"Bearer {ANON_KEY}",
                    "apikey": ANON_KEY,
                    "User-Agent": "PrognozaEPIR-Supabase-Backup/1",
                },
            )
            with urllib.request.urlopen(req, timeout=40) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if not payload.get("ok"):
                raise RuntimeError(payload.get("error") or "backup-export returned ok=false")
            return payload
        except Exception as exc:
            last = exc
            if attempt + 1 < attempts:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"backup-export failed for {params}: {last}")


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def export_table(table: str, expected: int, max_id: str | None) -> dict[str, object]:
    """Export the fixed PK range using keyset pages, even during live ingestion."""
    path = TMP / f"{table}.jsonl"
    count = 0
    last_id: str | None = None
    if (max_id is None) != (expected == 0):
        raise RuntimeError(f"{table}: inconsistent manifest boundary: count={expected}, max_id={max_id}")
    with path.open("w", encoding="utf-8", newline="\n") as out:
        while max_id is not None:
            params: dict[str, object] = {
                "op": "table", "table": table, "limit": PAGE_SIZE, "max_id": max_id,
            }
            if last_id is not None:
                params["after"] = last_id
            payload = get_json(params)
            rows = payload.get("rows")
            if not isinstance(rows, list) or len(rows) > PAGE_SIZE:
                raise RuntimeError(f"{table}: invalid page payload")
            if not rows:
                break
            for row in rows:
                if not isinstance(row, dict) or row.get("id") is None:
                    raise RuntimeError(f"{table}: missing primary key in backup row")
                row_id = str(row["id"])
                if last_id is not None:
                    # Bigint IDs require numeric comparison; UUIDs use the
                    # canonical text order used by PostgreSQL.
                    previous = int(last_id) if last_id.isdecimal() else last_id
                    current = int(row_id) if row_id.isdecimal() else row_id
                    if current <= previous:
                        raise RuntimeError(f"{table}: non-increasing or duplicate primary key {row_id}")
                out.write(json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n")
                last_id = row_id
                count += 1
                if count > expected:
                    raise RuntimeError(f"{table}: exported more rows than manifest ({expected})")
            if len(rows) < PAGE_SIZE:
                break
    if count != expected:
        raise RuntimeError(f"{table}: incomplete bounded export: expected={expected}, exported={count}")
    return {
        "rows": count,
        "bytes": path.stat().st_size,
        "sha256": sha256(path),
        "file": path.name,
    }


def publish_snapshot() -> None:
    old = OUT.with_name(".daily.old")
    if old.exists():
        shutil.rmtree(old)
    if OUT.exists():
        OUT.rename(old)
    try:
        TMP.rename(OUT)
    except Exception:
        if old.exists() and not OUT.exists():
            old.rename(OUT)
        raise
    if old.exists():
        shutil.rmtree(old)


def main() -> int:
    if TMP.exists():
        shutil.rmtree(TMP)
    TMP.mkdir(parents=True, exist_ok=True)

    remote_manifest = get_json({"op": "manifest"})
    expected_raw = remote_manifest.get("tables") or {}
    max_ids_raw = remote_manifest.get("max_ids")
    if not isinstance(max_ids_raw, dict) or any(table not in max_ids_raw for table in TABLES):
        raise RuntimeError("backup-export must provide max_ids for bounded, consistent pagination")
    expected = {table: int(expected_raw.get(table) or 0) for table in TABLES}

    schema_payload = get_json({"op": "schema"})
    schema = schema_payload.get("schema")
    if not isinstance(schema, dict):
        raise RuntimeError("schema snapshot missing or invalid")
    schema_path = TMP / "schema.json"
    write_json(schema_path, schema)

    files: dict[str, object] = {
        "schema.json": {
            "bytes": schema_path.stat().st_size,
            "sha256": sha256(schema_path),
        }
    }
    table_meta: dict[str, object] = {}
    for table in TABLES:
        max_id = max_ids_raw[table]
        meta = export_table(table, expected[table], None if max_id is None else str(max_id))
        table_meta[table] = meta
        files[str(meta["file"])] = {
            "bytes": meta["bytes"],
            "sha256": meta["sha256"],
        }

    manifest = {
        "schema": "prognozaepir-supabase-logical-backup-v1",
        "project_ref": PROJECT_REF,
        "exported_at": remote_manifest.get("generated_at"),
        "timezone": "UTC",
        "format": "JSONL per table + schema.json",
        "tables": table_meta,
        "max_ids": max_ids_raw,
        "files": files,
        "restore_note": "Schema metadata plus complete logical rows for the whitelisted public application tables. Git history stores each daily revision.",
    }
    write_json(TMP / "manifest.json", manifest)

    publish_snapshot()
    print(json.dumps({"ok": True, "exported_at": manifest["exported_at"], "counts": expected}, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Supabase backup failed: {exc}", file=sys.stderr)
        raise
