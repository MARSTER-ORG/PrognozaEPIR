#!/usr/bin/env python3
"""Low-memory Railway runtime for PrognozaEPIR.

The HTTP process stays lightweight. Every 5-minute acquisition cycle runs the
message ingestor and MTG LI collector in disposable child processes so numpy,
netCDF4 and EUMETSAT libraries are returned to the OS after each cycle.
"""
from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
ARCHIVE = (ROOT / "data" / "messages").resolve()
LIGHTNING = (ROOT / "data" / "lightning").resolve()
PYTHON = sys.executable or "python3"
PORT = int(os.environ.get("PORT", "8080"))
INTERVAL = max(60, int(os.environ.get("INGEST_INTERVAL_SECONDS", "300")))
STATE_PATH = Path(os.environ.get("PROGNOZAEPIR_RAILWAY_STATE", "/tmp/prognozaepir-railway-state.json"))
LOCK_PATH = Path(os.environ.get("PROGNOZAEPIR_INGEST_LOCK", "/tmp/prognozaepir-central-ingest.lock"))
STARTED_AT = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

_runtime_lock = threading.Lock()
_runtime = {
    "started_at": STARTED_AT,
    "mode": "low-memory-subprocess-v1",
    "cycle_running": False,
    "cycle_started_at": None,
    "last_cycle": None,
}
_manifest_lock = threading.Lock()
_manifest = {"schema": "prognozaepir-message-archive-manifest-v1", "generated_at": None, "files": []}


def utc_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def runtime_snapshot() -> dict:
    with _runtime_lock:
        return json.loads(json.dumps(_runtime))


def latest_summary() -> dict:
    payload = read_json(ARCHIVE / "latest.json")
    if not isinstance(payload, dict):
        return {"available": False}

    def compact(item):
        if not isinstance(item, dict):
            return None
        return {
            "station": item.get("station"),
            "type": item.get("type") or item.get("report_type"),
            "message_time": item.get("message_time") or item.get("obs_time") or item.get("issue_time"),
            "raw": item.get("canonical_raw") or item.get("raw"),
            "source": item.get("source"),
        }

    tafs = payload.get("taf_by_station") if isinstance(payload.get("taf_by_station"), dict) else {}
    return {
        "available": True,
        "metar": compact(payload.get("metar")),
        "speci": compact(payload.get("speci")),
        "synop": compact(payload.get("synop")),
        "taf": compact(payload.get("taf")),
        "taf_by_station": {key: compact(value) for key, value in tafs.items()},
    }


def lightning_summary() -> dict:
    payload = read_json(LIGHTNING / "latest.json")
    if not isinstance(payload, dict):
        return {"available": False}
    return {
        "available": True,
        "status": payload.get("status"),
        "updated_at": payload.get("updated_at"),
        "data_time": payload.get("data_time"),
        "source": payload.get("source"),
        "radial_counts_20min": payload.get("radial_counts_20min"),
        "time_counts_80km": payload.get("time_counts_80km"),
        "nearest": payload.get("nearest"),
        "trend_80km": payload.get("trend_80km"),
        "reason": payload.get("reason"),
    }


def rebuild_manifest() -> None:
    files = []
    if ARCHIVE.exists():
        for path in sorted(ARCHIVE.rglob("*")):
            if not path.is_file() or path.suffix.lower() not in {".json", ".jsonl"}:
                continue
            digest = hashlib.sha256()
            try:
                with path.open("rb") as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        digest.update(chunk)
                files.append({
                    "path": path.relative_to(ARCHIVE).as_posix(),
                    "size": path.stat().st_size,
                    "sha256": digest.hexdigest(),
                })
            except OSError:
                continue
    payload = {
        "schema": "prognozaepir-message-archive-manifest-v1",
        "generated_at": utc_iso(),
        "files": files,
    }
    with _manifest_lock:
        global _manifest
        _manifest = payload


def manifest_snapshot() -> dict:
    with _manifest_lock:
        return json.loads(json.dumps(_manifest))


def run_child(label: str, argv: list[str], timeout: int) -> dict:
    started = time.monotonic()
    print(f"[{utc_iso()}] {label}: start", flush=True)
    try:
        proc = subprocess.run(argv, cwd=ROOT, timeout=timeout, check=False)
        result = {
            "ok": proc.returncode == 0,
            "returncode": proc.returncode,
            "duration_s": round(time.monotonic() - started, 3),
        }
    except subprocess.TimeoutExpired:
        result = {"ok": False, "error": f"timeout after {timeout}s", "duration_s": round(time.monotonic() - started, 3)}
    except Exception as exc:
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}", "duration_s": round(time.monotonic() - started, 3)}
    print(f"[{utc_iso()}] {label}: {result}", flush=True)
    return result


def run_worker() -> None:
    print(f"[{utc_iso()}] low-memory worker started; interval={INTERVAL}s", flush=True)
    rebuild_manifest()
    while True:
        loop_started = time.monotonic()
        with _runtime_lock:
            _runtime["cycle_running"] = True
            _runtime["cycle_started_at"] = utc_iso()

        lightning_proc = run_child(
            "lightning-lfl",
            [PYTHON, str(SCRIPTS / "collect_lightning_features_lowmem.py")],
            timeout=240,
        )
        lightning_state = read_json(LIGHTNING / "latest.json", {}) or {}

        message_proc = run_child(
            "central-messages",
            [
                PYTHON,
                str(SCRIPTS / "central_ingestor.py"),
                "--once",
                "--state-file", str(STATE_PATH),
                "--lock-file", str(LOCK_PATH),
            ],
            timeout=720,
        )
        state = read_json(STATE_PATH, {}) or {}
        if not state:
            state = {
                "schema": "prognozaepir-central-ingestor-state-v1",
                "finished_at": utc_iso(),
                "ok": False,
                "error": message_proc.get("error") or f"central ingestor exit {message_proc.get('returncode')}",
                "steps": [],
            }

        state["processes"] = {"messages": message_proc, "lightning": lightning_proc}
        state["lightning"] = {
            "status": lightning_state.get("status"),
            "updated_at": lightning_state.get("updated_at"),
            "reason": lightning_state.get("reason"),
            "counts_80km": lightning_state.get("time_counts_80km"),
            "nearest": lightning_state.get("nearest"),
        }
        state["low_memory_mode"] = True
        rebuild_manifest()

        with _runtime_lock:
            _runtime["cycle_running"] = False
            _runtime["cycle_started_at"] = None
            _runtime["last_cycle"] = state

        elapsed = time.monotonic() - loop_started
        sleep_for = max(1.0, INTERVAL - elapsed)
        print(f"[{utc_iso()}] cycle finished ok={state.get('ok')} duration={elapsed:.1f}s; next in {sleep_for:.1f}s", flush=True)
        time.sleep(sleep_for)


class Handler(BaseHTTPRequestHandler):
    server_version = "PrognozaEPIR-Ingestor/1.2-lowmem"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{utc_iso()}] http {self.address_string()} {fmt % args}", flush=True)

    def _headers(self, status: int, content_type: str, length: int | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        if length is not None:
            self.send_header("Content-Length", str(length))
        self.end_headers()

    def _json(self, payload: dict, status: int = 200, head_only: bool = False) -> None:
        body = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        self._headers(status, "application/json; charset=utf-8", len(body))
        if not head_only:
            self.wfile.write(body)

    def _health(self, head_only: bool = False) -> None:
        runtime = runtime_snapshot()
        last = runtime.get("last_cycle") or {}
        self._json({
            "service": "prognozaepir-central-ingestor",
            "ok": not (last and last.get("ok") is False),
            "mode": runtime.get("mode"),
            "started_at": runtime.get("started_at"),
            "interval_seconds": INTERVAL,
            "cycle_running": runtime.get("cycle_running"),
            "cycle_started_at": runtime.get("cycle_started_at"),
            "last_cycle": last,
            "latest": latest_summary(),
            "lightning": lightning_summary(),
            "archive_manifest_files": len(manifest_snapshot().get("files") or []),
        }, head_only=head_only)

    def _file(self, request_path: str, head_only: bool = False) -> None:
        relative = unquote(request_path).lstrip("/")
        if relative.startswith("data/messages/"):
            allowed_root = ARCHIVE
        elif relative.startswith("data/lightning/"):
            allowed_root = LIGHTNING
        else:
            self._json({"error": "not found"}, 404, head_only)
            return
        candidate = (ROOT / relative).resolve()
        if candidate != allowed_root and allowed_root not in candidate.parents:
            self._json({"error": "forbidden"}, 403, head_only)
            return
        if candidate.suffix.lower() not in {".json", ".jsonl"} or not candidate.is_file():
            self._json({"error": "not found"}, 404, head_only)
            return
        try:
            body = candidate.read_bytes()
        except OSError as exc:
            self._json({"error": f"read failed: {exc}"}, 500, head_only)
            return
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if candidate.suffix.lower() == ".json":
            content_type = "application/json; charset=utf-8"
        elif candidate.suffix.lower() == ".jsonl":
            content_type = "application/x-ndjson; charset=utf-8"
        self._headers(200, content_type, len(body))
        if not head_only:
            self.wfile.write(body)

    def _dispatch(self, head_only: bool = False) -> None:
        path = urlparse(self.path).path
        if path in {"/", "/health"}:
            self._health(head_only)
        elif path == "/archive-manifest":
            self._json(manifest_snapshot(), head_only=head_only)
        else:
            self._file(path, head_only)

    def do_GET(self) -> None:
        self._dispatch(False)

    def do_HEAD(self) -> None:
        self._dispatch(True)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()


def main() -> int:
    worker = threading.Thread(target=run_worker, name="central-ingestor-lowmem", daemon=True)
    worker.start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[{utc_iso()}] http server listening on 0.0.0.0:{PORT}", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
