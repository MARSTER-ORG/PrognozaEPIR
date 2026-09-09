#!/usr/bin/env python3
"""Railway runtime for the central PrognozaEPIR archive.

Runs the existing bulletin ingestor and the independent MTG LI LFL lightning
feature collector every five minutes (default), then exposes both archives
through a tiny read-only HTTP API.
"""
from __future__ import annotations

import json
import mimetypes
import os
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
sys.path.insert(0, str(SCRIPTS))

import central_ingestor  # noqa: E402
import collect_lightning_features  # noqa: E402

PORT = int(os.environ.get("PORT", "8080"))
INTERVAL = max(60, int(os.environ.get("INGEST_INTERVAL_SECONDS", "300")))
STATE_PATH = Path(
    os.environ.get("PROGNOZAEPIR_RAILWAY_STATE", "/tmp/prognozaepir-railway-state.json")
)
LOCK_PATH = Path(
    os.environ.get("PROGNOZAEPIR_INGEST_LOCK", "/tmp/prognozaepir-central-ingest.lock")
)
STARTED_AT = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

_runtime_lock = threading.Lock()
_runtime: dict = {
    "started_at": STARTED_AT,
    "cycle_running": False,
    "cycle_started_at": None,
    "last_cycle": None,
}


def utc_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def runtime_snapshot() -> dict:
    with _runtime_lock:
        return json.loads(json.dumps(_runtime))


def latest_summary() -> dict:
    path = ARCHIVE / "latest.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"available": False, "error": f"{type(exc).__name__}: {exc}"}

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
    path = LIGHTNING / "latest.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"available": False, "error": f"{type(exc).__name__}: {exc}"}
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


def run_worker() -> None:
    print(
        f"[{utc_iso()}] railway worker started; interval={INTERVAL}s archive={ARCHIVE}",
        flush=True,
    )
    while True:
        loop_started = time.monotonic()
        with _runtime_lock:
            _runtime["cycle_running"] = True
            _runtime["cycle_started_at"] = utc_iso()

        # Collect lightning first so the Cb engine gets the freshest LFL signal.
        try:
            lightning_state = collect_lightning_features.collect_and_write()
            print(
                f"[{utc_iso()}] lightning LFL status={lightning_state.get('status')} "
                f"80km/10min={lightning_state.get('time_counts_80km', {}).get('10')}",
                flush=True,
            )
        except Exception as exc:
            lightning_state = {
                "status": "error",
                "updated_at": utc_iso(),
                "reason": f"{type(exc).__name__}: {exc}",
            }
            print(f"[{utc_iso()}] lightning collector exception: {lightning_state['reason']}", flush=True)

        try:
            with central_ingestor.exclusive_lock(LOCK_PATH):
                state = central_ingestor.cycle(publish=False, state_path=STATE_PATH)
        except Exception as exc:  # keep the long-lived worker alive
            state = {
                "schema": "prognozaepir-central-ingestor-state-v1",
                "finished_at": utc_iso(),
                "ok": False,
                "published": False,
                "error": f"{type(exc).__name__}: {exc}",
                "steps": [],
            }
            print(f"[{utc_iso()}] worker cycle exception: {state['error']}", flush=True)
        finally:
            state["lightning"] = {
                "status": lightning_state.get("status"),
                "updated_at": lightning_state.get("updated_at"),
                "reason": lightning_state.get("reason"),
                "counts_80km": lightning_state.get("time_counts_80km"),
                "nearest": lightning_state.get("nearest"),
            }
            with _runtime_lock:
                _runtime["cycle_running"] = False
                _runtime["last_cycle"] = state

        elapsed = time.monotonic() - loop_started
        sleep_for = max(1.0, INTERVAL - elapsed)
        print(
            f"[{utc_iso()}] worker cycle finished ok={state.get('ok')} "
            f"duration={elapsed:.1f}s; next in {sleep_for:.1f}s",
            flush=True,
        )
        time.sleep(sleep_for)


class Handler(BaseHTTPRequestHandler):
    server_version = "PrognozaEPIR-Ingestor/1.1"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{utc_iso()}] http {self.address_string()} {fmt % args}", flush=True)

    def _common_headers(self, status: int, content_type: str, content_length: int | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        if content_length is not None:
            self.send_header("Content-Length", str(content_length))
        self.end_headers()

    def _json(self, payload: dict, status: int = 200, head_only: bool = False) -> None:
        body = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        self._common_headers(status, "application/json; charset=utf-8", len(body))
        if not head_only:
            self.wfile.write(body)

    def _health(self, head_only: bool = False) -> None:
        runtime = runtime_snapshot()
        last = runtime.get("last_cycle") or {}
        payload = {
            "service": "prognozaepir-central-ingestor",
            "ok": not (last and last.get("ok") is False),
            "started_at": runtime.get("started_at"),
            "interval_seconds": INTERVAL,
            "cycle_running": runtime.get("cycle_running"),
            "cycle_started_at": runtime.get("cycle_started_at"),
            "last_cycle": last,
            "latest": latest_summary(),
            "lightning": lightning_summary(),
        }
        self._json(payload, status=200, head_only=head_only)

    def _archive_file(self, request_path: str, head_only: bool = False) -> None:
        relative = unquote(request_path).lstrip("/")
        if relative.startswith("data/messages/"):
            allowed_root = ARCHIVE
        elif relative.startswith("data/lightning/"):
            allowed_root = LIGHTNING
        else:
            self._json({"error": "not found"}, status=404, head_only=head_only)
            return

        candidate = (ROOT / relative).resolve()
        if candidate != allowed_root and allowed_root not in candidate.parents:
            self._json({"error": "forbidden"}, status=403, head_only=head_only)
            return
        if candidate.suffix.lower() not in {".json", ".jsonl"} or not candidate.is_file():
            self._json({"error": "not found"}, status=404, head_only=head_only)
            return
        try:
            body = candidate.read_bytes()
        except OSError as exc:
            self._json({"error": f"read failed: {exc}"}, status=500, head_only=head_only)
            return
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if candidate.suffix.lower() in {".json", ".jsonl"}:
            content_type = (
                "application/json; charset=utf-8"
                if candidate.suffix.lower() == ".json"
                else "application/x-ndjson; charset=utf-8"
            )
        self._common_headers(200, content_type, len(body))
        if not head_only:
            self.wfile.write(body)

    def _dispatch(self, head_only: bool = False) -> None:
        path = urlparse(self.path).path
        if path in {"/", "/health"}:
            self._health(head_only=head_only)
            return
        self._archive_file(path, head_only=head_only)

    def do_GET(self) -> None:  # noqa: N802
        self._dispatch(False)

    def do_HEAD(self) -> None:  # noqa: N802
        self._dispatch(True)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()


def main() -> int:
    worker = threading.Thread(target=run_worker, name="central-ingestor", daemon=True)
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
