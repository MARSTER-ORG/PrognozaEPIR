#!/usr/bin/env python3
"""Lightweight official-IMGW METAR fast path for PrognozaEPIR.

This checker deliberately does only three things:
1. query the official IMGW Aviation API for EPIR METAR/SPECI,
2. stage only records missing from the authoritative central archive,
3. run the local archive normalizer so data/messages is immediately current.

It performs no TAF, SYNOP, lightning, neighbor-airport or fallback-source work.
The same flock as central_ingestor.py prevents concurrent archive writes.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import live_metar_collector as live
import refresh_epir_metar as refresh

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
MESSAGES = ROOT / "data" / "messages"
PYTHON = sys.executable or "python3"
DEFAULT_LOCK = Path(os.environ.get("PROGNOZAEPIR_INGEST_LOCK", "/tmp/prognozaepir-central-ingest.lock"))


def utc_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def compact_raw(value: str) -> str:
    raw = re.sub(r"\s+", " ", str(value or "")).strip().rstrip("=").strip().upper()
    raw = re.sub(r"^(?:METAR|SPECI)\s+", "", raw)
    return raw


def read_jsonl(path: Path) -> list[dict]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    out: list[dict] = []
    for line in lines:
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            out.append(row)
    return out


def central_has(row: dict) -> bool:
    when = refresh.obs_time(row)
    if when is None:
        return False
    kind = "speci" if str(row.get("report_type") or "").upper() == "SPECI" else "metar"
    path = MESSAGES / kind / when.strftime("%Y") / when.strftime("%m") / f"{when:%d}.jsonl"
    wanted_time = refresh.c.iso(when)
    wanted_raw = compact_raw(row.get("raw"))
    for current in read_jsonl(path):
        current_time = str(current.get("message_time") or current.get("obs_time") or "")
        current_raw = compact_raw(current.get("raw") or current.get("canonical_raw"))
        if current_time == wanted_time and current_raw == wanted_raw:
            return True
    return False


@contextmanager
def try_exclusive_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+", encoding="utf-8")
    try:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield None
            return
        handle.seek(0)
        handle.truncate()
        handle.write(f"pid={os.getpid()} fast-check={utc_iso()}\n")
        handle.flush()
        yield handle
    finally:
        try:
            if handle:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        handle.close()


def normalize_archive() -> tuple[bool, str]:
    try:
        proc = subprocess.run(
            [PYTHON, str(SCRIPTS / "message_archive.py")],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=60,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return False, "archive normalizer timeout"
    if proc.stdout:
        print(proc.stdout.rstrip(), flush=True)
    if proc.returncode != 0:
        return False, f"archive normalizer exit {proc.returncode}"
    return True, "ok"


def run_once(lock_file: Path) -> int:
    with try_exclusive_lock(lock_file) as lock:
        if lock is None:
            print(json.dumps({
                "metar_fast_check": True,
                "checked_at": utc_iso(),
                "ok": True,
                "skipped": "central-ingest-lock-busy",
            }, separators=(",", ":")), flush=True)
            return 0

        rows = [
            row for row in live.fetch_imgw_api_reports()
            if live.structurally_valid_metar(row) and refresh.latest_valid(row)
        ]
        rows.sort(key=refresh.rank)
        if not rows:
            print(json.dumps({
                "metar_fast_check": True,
                "checked_at": utc_iso(),
                "ok": True,
                "source": "IMGW_AVIATION_METAR",
                "new": 0,
                "newest": None,
            }, separators=(",", ":")), flush=True)
            return 0

        missing = [row for row in rows if not central_has(row)]
        if not missing:
            newest = rows[-1]
            print(json.dumps({
                "metar_fast_check": True,
                "checked_at": utc_iso(),
                "ok": True,
                "source": "IMGW_AVIATION_METAR",
                "new": 0,
                "newest": newest.get("obs_time"),
            }, separators=(",", ":")), flush=True)
            return 0

        staged = 0
        for row in missing:
            if refresh.archive(row):
                staged += 1

        ok, reason = normalize_archive()
        if not ok:
            print(json.dumps({
                "metar_fast_check": True,
                "checked_at": utc_iso(),
                "ok": False,
                "source": "IMGW_AVIATION_METAR",
                "new": len(missing),
                "staged": staged,
                "error": reason,
            }, separators=(",", ":")), flush=True)
            return 1

        unresolved = [row for row in missing if not central_has(row)]
        newest = max(missing, key=refresh.rank)
        result = {
            "metar_fast_check": True,
            "checked_at": utc_iso(),
            "ok": not unresolved,
            "source": "IMGW_AVIATION_METAR",
            "new": len(missing),
            "staged": staged,
            "newest": newest.get("obs_time"),
            "raw": newest.get("raw"),
            "unresolved": len(unresolved),
        }
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")), flush=True)
        return 0 if not unresolved else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock-file", type=Path, default=DEFAULT_LOCK)
    args = parser.parse_args()
    return run_once(args.lock_file)


if __name__ == "__main__":
    raise SystemExit(main())
