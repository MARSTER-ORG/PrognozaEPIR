#!/usr/bin/env python3
"""Optimized Railway runtime wrapper for the central ingestor.

The proven low-memory server remains the worker/HTTP implementation. This
wrapper adds three durability/efficiency layers:
1. on container start, reconcile the recent local archive with the durable
   GitHub mirror so an old Railway deployment snapshot cannot regress history;
2. rebuild the Railway archive manifest incrementally, hashing only files whose
   size/mtime changed since the previous cycle;
3. when configured with a GitHub dispatch token, notify the mirror only after
   the archive fingerprint actually changes. GitHub keeps a scheduled fallback.
"""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError

import railway_ingestor_lowmem_server as base

_DISPATCH_TOKEN = os.environ.get("GITHUB_ARCHIVE_DISPATCH_TOKEN", "").strip()
_DISPATCH_URL = os.environ.get(
    "GITHUB_ARCHIVE_DISPATCH_URL",
    "https://api.github.com/repos/MARSTER-ORG/PrognozaEPIR/dispatches",
).strip()
_GITHUB_RAW_BASE = os.environ.get(
    "PROGNOZAEPIR_GITHUB_RAW_BASE",
    "https://raw.githubusercontent.com/MARSTER-ORG/PrognozaEPIR/main/data/messages",
).rstrip("/")
_BOOTSTRAP_DAYS = max(1, min(31, int(os.environ.get("ARCHIVE_BOOTSTRAP_DAYS", "7"))))

_manifest_cache: dict[str, dict] = {}
_manifest_initialized = False
_last_fingerprint: str | None = None


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(128 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.bootstrap.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _jsonl_key(raw: str) -> str:
    try:
        row = json.loads(raw)
    except json.JSONDecodeError:
        return "raw:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()
    ident = str(row.get("message_id") or "").strip()
    if ident:
        return "id:" + ident
    material = "|".join(
        [
            str(row.get("type") or ""),
            str(row.get("station") or ""),
            str(row.get("canonical_raw") or row.get("raw") or ""),
        ]
    )
    return "fallback:" + hashlib.sha256(material.encode("utf-8")).hexdigest()


def _merge_jsonl(path: Path, durable: bytes) -> tuple[int, int]:
    durable_lines = [line for line in durable.decode("utf-8").splitlines() if line.strip()]
    local_lines: list[str] = []
    try:
        local_lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    except OSError:
        pass

    merged: list[str] = []
    seen: set[str] = set()
    for line in durable_lines + local_lines:
        key = _jsonl_key(line)
        if key in seen:
            continue
        seen.add(key)
        merged.append(line)

    encoded = (("\n".join(merged) + "\n") if merged else "").encode("utf-8")
    current = None
    try:
        current = path.read_bytes()
    except OSError:
        pass
    if current != encoded:
        _atomic_bytes(path, encoded)
    return len(durable_lines), len(merged)


def _github_get(rel: str) -> bytes | None:
    url = f"{_GITHUB_RAW_BASE}/{rel}"
    request = base.Request(
        url,
        headers={"Accept": "application/octet-stream", "User-Agent": "PrognozaEPIR-Railway-Bootstrap/1"},
    )
    try:
        with base.urlopen(request, timeout=15) as response:
            return response.read()
    except HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def bootstrap_from_github() -> dict:
    """Merge recent durable archive files from GitHub before acquisition starts."""
    fetched = 0
    changed = 0
    merged_records = 0
    errors: list[str] = []

    for rel in ("status.json", "latest.json", "recent.json", "taf-neighbors.json"):
        try:
            data = _github_get(rel)
            if data is None:
                continue
            fetched += 1
            dest = base.ARCHIVE / rel
            previous = None
            try:
                previous = dest.read_bytes()
            except OSError:
                pass
            if previous != data:
                _atomic_bytes(dest, data)
                changed += 1
        except Exception as exc:
            errors.append(f"{rel}: {type(exc).__name__}: {exc}")

    today = datetime.now(timezone.utc).date()
    for offset in range(_BOOTSTRAP_DAYS):
        day = today - timedelta(days=offset)
        day_rel = day.strftime("%Y/%m/%d.jsonl")
        for kind in ("metar", "speci", "taf", "synop"):
            rel = f"{kind}/{day_rel}"
            try:
                data = _github_get(rel)
                if data is None:
                    continue
                fetched += 1
                dest = base.ARCHIVE / rel
                before = None
                try:
                    before = dest.read_bytes()
                except OSError:
                    pass
                _, merged = _merge_jsonl(dest, data)
                merged_records += merged
                try:
                    after = dest.read_bytes()
                except OSError:
                    after = None
                if before != after:
                    changed += 1
            except Exception as exc:
                errors.append(f"{rel}: {type(exc).__name__}: {exc}")

    result = {
        "days": _BOOTSTRAP_DAYS,
        "fetched_files": fetched,
        "changed_files": changed,
        "merged_records_seen": merged_records,
        "errors": errors[:8],
        "ok": not errors,
    }
    with base._runtime_lock:
        base._runtime["archive_bootstrap"] = result
    print(f"[{base.utc_iso()}] archive bootstrap: {result}", flush=True)
    return result


def _dispatch_archive_changed(generated_at: str, fingerprint: str) -> dict:
    if not _DISPATCH_TOKEN:
        return {"enabled": False, "sent": False, "reason": "missing GITHUB_ARCHIVE_DISPATCH_TOKEN"}

    body = json.dumps(
        {
            "event_type": "archive-updated",
            "client_payload": {
                "generated_at": generated_at,
                "fingerprint": fingerprint,
            },
        },
        separators=(",", ":"),
    ).encode("utf-8")
    request = base.Request(
        _DISPATCH_URL,
        data=body,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {_DISPATCH_TOKEN}",
            "Content-Type": "application/json",
            "User-Agent": "PrognozaEPIR-Railway-Archive-Dispatch/1",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        method="POST",
    )
    try:
        with base.urlopen(request, timeout=10) as response:
            status = int(getattr(response, "status", 0) or 0)
        ok = status in {200, 201, 202, 204}
        return {"enabled": True, "sent": ok, "status": status}
    except Exception as exc:
        return {"enabled": True, "sent": False, "error": f"{type(exc).__name__}: {exc}"}


def rebuild_manifest_incremental() -> None:
    global _manifest_initialized, _last_fingerprint, _manifest_cache

    files = []
    live_paths: set[str] = set()
    if base.ARCHIVE.exists():
        for path in sorted(base.ARCHIVE.rglob("*")):
            if not path.is_file() or path.suffix.lower() not in {".json", ".jsonl"}:
                continue
            rel = path.relative_to(base.ARCHIVE).as_posix()
            live_paths.add(rel)
            try:
                stat = path.stat()
            except OSError:
                continue

            cached = _manifest_cache.get(rel)
            if cached and cached.get("size") == stat.st_size and cached.get("mtime_ns") == stat.st_mtime_ns:
                sha256 = cached["sha256"]
            else:
                try:
                    sha256 = _file_sha256(path)
                except OSError:
                    continue
                _manifest_cache[rel] = {
                    "size": stat.st_size,
                    "mtime_ns": stat.st_mtime_ns,
                    "sha256": sha256,
                }

            files.append({"path": rel, "size": stat.st_size, "sha256": sha256})

    if _manifest_cache:
        _manifest_cache = {key: value for key, value in _manifest_cache.items() if key in live_paths}

    generated_at = base.utc_iso()
    payload = {
        "schema": "prognozaepir-message-archive-manifest-v1",
        "generated_at": generated_at,
        "files": files,
    }
    fingerprint = hashlib.sha256(
        json.dumps(
            [(item["path"], item["size"], item["sha256"]) for item in files],
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()

    with base._manifest_lock:
        base._manifest = payload

    changed = _manifest_initialized and fingerprint != _last_fingerprint
    _last_fingerprint = fingerprint
    _manifest_initialized = True

    if changed:
        dispatch = _dispatch_archive_changed(generated_at, fingerprint)
        with base._runtime_lock:
            base._runtime["archive_dispatch"] = dispatch
            base._runtime["archive_fingerprint"] = fingerprint
        if dispatch.get("enabled"):
            print(f"[{base.utc_iso()}] archive dispatch: {dispatch}", flush=True)
    else:
        with base._runtime_lock:
            base._runtime["archive_fingerprint"] = fingerprint


base.rebuild_manifest = rebuild_manifest_incremental


if __name__ == "__main__":
    bootstrap_from_github()
    raise SystemExit(base.main())
