#!/usr/bin/env python3
"""Optimized Railway runtime wrapper for the central ingestor.

It keeps the proven low-memory server unchanged, but replaces archive manifest
rebuilding with an incremental stat/hash cache. When the archive snapshot
actually changes, it can notify GitHub through repository_dispatch. The token
is optional; the GitHub mirror keeps an hourly scheduled fallback.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import railway_ingestor_lowmem_server as base

_DISPATCH_TOKEN = os.environ.get("GITHUB_ARCHIVE_DISPATCH_TOKEN", "").strip()
_DISPATCH_URL = os.environ.get(
    "GITHUB_ARCHIVE_DISPATCH_URL",
    "https://api.github.com/repos/MARSTER-ORG/PrognozaEPIR/dispatches",
).strip()

_manifest_cache: dict[str, dict] = {}
_manifest_initialized = False
_last_fingerprint: str | None = None


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(128 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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
            if (
                cached
                and cached.get("size") == stat.st_size
                and cached.get("mtime_ns") == stat.st_mtime_ns
            ):
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
    raise SystemExit(base.main())
