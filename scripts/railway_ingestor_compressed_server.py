#!/usr/bin/env python3
"""Railway entrypoint with transparent gzip for lightning JSON.

The browser intentionally requests fresh MTG LI data. Keep that freshness, but
avoid sending the large point payload uncompressed on every request. Message
archive responses keep the existing behavior unchanged.
"""
from __future__ import annotations

import gzip
import os
import threading
from pathlib import Path
from urllib.parse import unquote

import railway_ingestor_lowmem_server as base
import railway_ingestor_event_server as event

_ORIGINAL_FILE = base.Handler._file
_GZIP_CACHE_LOCK = threading.Lock()
_GZIP_CACHE: dict[str, tuple[int, int, bytes]] = {}


def _lightning_file(self: base.Handler, request_path: str, head_only: bool = False) -> None:
    relative = unquote(request_path).lstrip("/")
    if not relative.startswith("data/lightning/"):
        _ORIGINAL_FILE(self, request_path, head_only)
        return

    candidate = (base.ROOT / relative).resolve()
    if candidate != base.LIGHTNING and base.LIGHTNING not in candidate.parents:
        self._json({"error": "forbidden"}, 403, head_only)
        return
    if candidate.suffix.lower() != ".json" or not candidate.is_file():
        self._json({"error": "not found"}, 404, head_only)
        return

    try:
        stat = candidate.stat()
    except OSError as exc:
        self._json({"error": f"read failed: {exc}"}, 500, head_only)
        return

    accepts_gzip = "gzip" in (self.headers.get("Accept-Encoding") or "").lower()
    body: bytes | None = None
    if accepts_gzip:
        key = str(candidate)
        with _GZIP_CACHE_LOCK:
            cached = _GZIP_CACHE.get(key)
        if cached and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
            body = cached[2]
        else:
            try:
                raw = candidate.read_bytes()
            except OSError as exc:
                self._json({"error": f"read failed: {exc}"}, 500, head_only)
                return
            body = gzip.compress(raw, compresslevel=5, mtime=0)
            with _GZIP_CACHE_LOCK:
                _GZIP_CACHE[key] = (stat.st_mtime_ns, stat.st_size, body)

    self.send_response(200)
    self.send_header("Content-Type", "application/json; charset=utf-8")
    self.send_header("Access-Control-Allow-Origin", "*")
    self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
    self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
    self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Encoding, Vary")
    self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
    self.send_header("Pragma", "no-cache")
    self.send_header("Vary", "Accept-Encoding")

    if accepts_gzip:
        assert body is not None
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                return
        return

    self.send_header("Content-Length", str(stat.st_size))
    self.end_headers()
    if head_only:
        return
    try:
        with candidate.open("rb") as handle:
            while True:
                chunk = handle.read(64 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
    except (BrokenPipeError, ConnectionResetError):
        return
    except OSError:
        return


base.Handler._file = _lightning_file


if __name__ == "__main__":
    event.bootstrap_from_github()
    raise SystemExit(base.main())
