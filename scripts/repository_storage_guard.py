#!/usr/bin/env python3
"""Guard Git repository growth by pruning only Supabase-backed neighbor history.

The Git repository remains the hot/working archive. When repository size reaches
75% of the configured organizational limit, historical neighbor-airport JSONL
files switch to a rolling window. At the hard limit only a short hot window is
kept in Git. A file is deleted only after every local message is confirmed in
Supabase.

This script intentionally never removes core EPIR/SYNOP history or model-learning
archives. Those datasets require a separate durable external archive before they
can be evicted safely.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NEIGHBOR_ROOT = ROOT / "data" / "messages" / "neighbors"
DEFAULT_LIMIT_MB = 500
SOFT_RATIO = 0.75
ROLLING_RETENTION_DAYS = 30
EXTERNAL_RETENTION_DAYS = 7
PAGE_SIZE = 1000
PROJECT_REF = os.getenv("SUPABASE_PROJECT_REF", "qozgntzeormujmqzkkmd")
REST_URL = os.getenv("SUPABASE_REST_URL", f"https://{PROJECT_REF}.supabase.co/rest/v1/messages")
PATH_RE = re.compile(r"^([a-z0-9]+)/([0-9]{4})/([0-9]{2})/([0-9]{2})\.jsonl$")


def public_anon_key() -> str:
    value = os.getenv("SUPABASE_ANON_KEY", "").strip()
    if value:
        return value
    client = (ROOT / "message-archive-client.js").read_text(encoding="utf-8")
    match = re.search(r"const\s+SUPABASE_ANON\s*=\s*['\"]([^'\"]+)['\"]", client)
    if not match:
        raise RuntimeError("SUPABASE_ANON_KEY not set and public key not found in message-archive-client.js")
    return match.group(1)


def storage_mode(repo_size_kb: int, limit_mb: int = DEFAULT_LIMIT_MB) -> str:
    hard_kb = int(limit_mb) * 1024
    soft_kb = int(hard_kb * SOFT_RATIO)
    if repo_size_kb >= hard_kb:
        return "external"
    if repo_size_kb >= soft_kb:
        return "rolling"
    return "normal"


def retention_days(mode: str) -> int | None:
    if mode == "rolling":
        return ROLLING_RETENTION_DAYS
    if mode == "external":
        return EXTERNAL_RETENTION_DAYS
    return None


def parse_neighbor_path(path: Path) -> tuple[str, date] | None:
    try:
        rel = path.relative_to(NEIGHBOR_ROOT).as_posix()
    except ValueError:
        return None
    match = PATH_RE.fullmatch(rel)
    if not match:
        return None
    station, year, month, day = match.groups()
    try:
        d = date(int(year), int(month), int(day))
    except ValueError:
        return None
    return station.upper(), d


def normalize_raw(value: object) -> str:
    text = " ".join(str(value or "").strip().upper().split()).rstrip("=").strip()
    for prefix in ("METAR ", "SPECI "):
        if text.startswith(prefix):
            text = text[len(prefix):].strip()
            break
    return text


def normalize_time(value: object) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def local_message_keys(path: Path) -> set[tuple[str, str, str]]:
    out: set[tuple[str, str, str]] = set()
    for number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not raw_line.strip():
            continue
        try:
            row = json.loads(raw_line)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"{path}:{number}: invalid JSON: {exc}") from exc
        kind = str(row.get("type") or row.get("report_type") or "").upper().strip()
        when = normalize_time(row.get("message_time") or row.get("obs_time") or row.get("issue_time"))
        raw = normalize_raw(row.get("canonical_raw") or row.get("raw"))
        if not kind or not when or not raw:
            raise RuntimeError(f"{path}:{number}: missing type/time/raw identity")
        out.add((kind, when, raw))
    return out


def fetch_remote_keys(station: str, day: date) -> set[tuple[str, str, str]]:
    key = public_anon_key()
    start = datetime.combine(day, datetime.min.time(), tzinfo=timezone.utc)
    end = start + timedelta(days=1)
    start_iso = start.isoformat().replace("+00:00", "Z")
    end_iso = end.isoformat().replace("+00:00", "Z")
    offset = 0
    out: set[tuple[str, str, str]] = set()
    while True:
        params = [
            ("select", "message_type,archive_time,raw_text"),
            ("station_code", f"eq.{station}"),
            ("archive_time", f"gte.{start_iso}"),
            ("archive_time", f"lt.{end_iso}"),
            ("order", "archive_time.asc,id.asc"),
            ("limit", str(PAGE_SIZE)),
            ("offset", str(offset)),
        ]
        req = urllib.request.Request(
            REST_URL + "?" + urllib.parse.urlencode(params),
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {key}",
                "apikey": key,
                "User-Agent": "PrognozaEPIR-Repository-Storage-Guard/1",
            },
        )
        with urllib.request.urlopen(req, timeout=40) as response:
            rows = json.loads(response.read().decode("utf-8"))
        if not isinstance(rows, list):
            raise RuntimeError(f"{station} {day}: invalid Supabase response")
        for row in rows:
            kind = str(row.get("message_type") or "").upper().strip()
            when = normalize_time(row.get("archive_time"))
            raw = normalize_raw(row.get("raw_text"))
            if kind and when and raw:
                out.add((kind, when, raw))
        if len(rows) < PAGE_SIZE:
            break
        offset += len(rows)
    return out


def supabase_covers(path: Path, station: str, day: date) -> tuple[bool, int, int]:
    local = local_message_keys(path)
    if not local:
        return False, 0, 0
    remote = fetch_remote_keys(station, day)
    missing = local - remote
    return not missing, len(local), len(missing)


def candidate_files(keep_days: int, today: date | None = None) -> list[tuple[date, str, Path]]:
    today = today or datetime.now(timezone.utc).date()
    cutoff = today - timedelta(days=max(0, keep_days))
    found: list[tuple[date, str, Path]] = []
    if not NEIGHBOR_ROOT.exists():
        return found
    for path in NEIGHBOR_ROOT.rglob("*.jsonl"):
        parsed = parse_neighbor_path(path)
        if not parsed:
            continue
        station, day = parsed
        if day < cutoff:
            found.append((day, station, path))
    found.sort(key=lambda item: (item[0], item[1], item[2].as_posix()))
    return found


def remove_empty_dirs(start: Path) -> None:
    for path in sorted((p for p in start.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        try:
            path.rmdir()
        except OSError:
            pass


def run(repo_size_kb: int, limit_mb: int, apply: bool) -> dict[str, object]:
    mode = storage_mode(repo_size_kb, limit_mb)
    keep = retention_days(mode)
    report: dict[str, object] = {
        "schema": "prognozaepir-repository-storage-guard-v1",
        "repo_size_kb": repo_size_kb,
        "repo_size_mib": round(repo_size_kb / 1024.0, 2),
        "organizational_limit_mib": limit_mb,
        "soft_threshold_mib": round(limit_mb * SOFT_RATIO, 2),
        "mode": mode,
        "neighbor_retention_days": keep,
        "apply": apply,
        "candidates": 0,
        "verified": 0,
        "deleted": 0,
        "freed_worktree_bytes": 0,
        "blocked": [],
        "protected": ["data/messages/metar", "data/messages/speci", "data/messages/synop", "data/messages/taf", "data/learning"],
        "note": "Git history is not rewritten; the guard limits future growth and prunes only Supabase-backed neighbor history.",
    }
    if keep is None:
        return report

    candidates = candidate_files(keep)
    report["candidates"] = len(candidates)
    blocked: list[dict[str, object]] = []
    freed = 0
    verified = 0
    deleted = 0
    for day, station, path in candidates:
        try:
            covered, local_count, missing_count = supabase_covers(path, station, day)
        except Exception as exc:
            blocked.append({"path": path.relative_to(ROOT).as_posix(), "reason": f"verification error: {exc}"})
            continue
        if not covered:
            blocked.append({
                "path": path.relative_to(ROOT).as_posix(),
                "reason": "Supabase does not contain every local message",
                "local_messages": local_count,
                "missing_messages": missing_count,
            })
            continue
        verified += 1
        size = path.stat().st_size
        if apply:
            path.unlink()
            deleted += 1
            freed += size

    if apply and deleted:
        remove_empty_dirs(NEIGHBOR_ROOT)
    report["verified"] = verified
    report["deleted"] = deleted
    report["freed_worktree_bytes"] = freed
    report["blocked"] = blocked[:50]
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-size-kb", required=True, type=int)
    parser.add_argument("--limit-mb", type=int, default=DEFAULT_LIMIT_MB)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--mode-only", action="store_true")
    args = parser.parse_args()

    if args.repo_size_kb < 0 or args.limit_mb <= 0:
        raise SystemExit("repo size and limit must be positive")
    mode = storage_mode(args.repo_size_kb, args.limit_mb)
    if args.mode_only:
        print(mode)
        return 0
    report = run(args.repo_size_kb, args.limit_mb, args.apply)
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    blocked = report.get("blocked") or []
    if args.apply and report.get("candidates") and not report.get("verified") and blocked:
        print("Storage guard made no destructive changes because Supabase verification failed.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
