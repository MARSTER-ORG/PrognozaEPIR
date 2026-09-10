#!/usr/bin/env python3
"""Minimal CORS + Range proxy for recent EUMETNET OPERA DBZH GeoTIFF frames."""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

PORT = int(os.environ.get("PORT", "8080"))
S3_BASE = "https://s3.waw3-1.cloudferro.com/openradar-24h"
FRAME_RE = re.compile(r"^/opera/dbzh/(20\d{10})\.tiff$")
MAX_AGE_SECONDS = 26 * 3600
MAX_FUTURE_SECONDS = 15 * 60


def utc_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def frame_time(token: str) -> datetime:
    return datetime.strptime(token, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)


def upstream_url(token: str) -> str:
    dt = frame_time(token)
    return f"{S3_BASE}/{dt:%Y/%m/%d}/OPERA/COMP/OPERA@{token}@0@DBZH.tiff"


class Handler(BaseHTTPRequestHandler):
    server_version = "PrognozaEPIR-OPERA-Proxy/1.0"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{utc_iso()}] {self.address_string()} {fmt % args}", flush=True)

    def cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        self.send_header("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length, ETag, Last-Modified")

    def send_json(self, status: int, payload: dict, head_only: bool = False) -> None:
        body = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.cors()
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def proxy_frame(self, path: str, head_only: bool = False) -> None:
        match = FRAME_RE.fullmatch(path)
        if not match:
            self.send_json(400, {"error": "invalid OPERA path"}, head_only)
            return
        token = match.group(1)
        try:
            dt = frame_time(token)
        except ValueError:
            self.send_json(400, {"error": "invalid timestamp"}, head_only)
            return
        delta = (datetime.now(timezone.utc) - dt).total_seconds()
        if dt.minute % 5 or delta > MAX_AGE_SECONDS or delta < -MAX_FUTURE_SECONDS:
            self.send_json(400, {"error": "timestamp outside recent OPERA window"}, head_only)
            return

        headers = {
            "Accept": "image/tiff,application/octet-stream;q=0.9,*/*;q=0.1",
            "User-Agent": "PrognozaEPIR-OPERA-Proxy/1.0",
        }
        requested_range = self.headers.get("Range")
        if requested_range:
            requested_range = requested_range.strip()
            if not re.fullmatch(r"bytes=\d+-\d*", requested_range):
                self.send_json(416, {"error": "unsupported range"}, head_only)
                return
            headers["Range"] = requested_range

        req = Request(upstream_url(token), headers=headers, method="HEAD" if head_only else "GET")
        try:
            with urlopen(req, timeout=20) as upstream:
                self.send_response(getattr(upstream, "status", 200))
                self.send_header("Content-Type", upstream.headers.get("Content-Type") or "image/tiff")
                self.cors()
                self.send_header("Accept-Ranges", upstream.headers.get("Accept-Ranges") or "bytes")
                self.send_header("Cache-Control", "public, max-age=300")
                for name in ("Content-Length", "Content-Range", "ETag", "Last-Modified"):
                    value = upstream.headers.get(name)
                    if value:
                        self.send_header(name, value)
                self.end_headers()
                if head_only:
                    return
                while True:
                    chunk = upstream.read(128 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except HTTPError as exc:
            if exc.code == 404:
                self.send_json(404, {"error": "OPERA frame not available", "frame": token}, head_only)
            elif exc.code == 416:
                self.send_response(416)
                self.cors()
                if exc.headers and exc.headers.get("Content-Range"):
                    self.send_header("Content-Range", exc.headers.get("Content-Range"))
                self.end_headers()
            else:
                self.send_json(502, {"error": f"OPERA upstream HTTP {exc.code}"}, head_only)
        except (URLError, TimeoutError, OSError) as exc:
            self.send_json(502, {"error": f"OPERA upstream unavailable: {type(exc).__name__}"}, head_only)
        except (BrokenPipeError, ConnectionResetError):
            return

    def dispatch(self, head_only: bool) -> None:
        path = urlparse(self.path).path
        if path in {"/", "/health", "/opera/health"}:
            self.send_json(200, {
                "service": "prognozaepir-opera-proxy",
                "ok": True,
                "source": "EUMETNET OPERA openradar-24h DBZH GeoTIFF",
                "range": True,
                "time": utc_iso(),
            }, head_only)
            return
        if path.startswith("/opera/dbzh/"):
            self.proxy_frame(path, head_only)
            return
        self.send_json(404, {"error": "not found"}, head_only)

    def do_GET(self) -> None:  # noqa: N802
        self.dispatch(False)

    def do_HEAD(self) -> None:  # noqa: N802
        self.dispatch(True)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()


def main() -> int:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[{utc_iso()}] OPERA proxy listening on 0.0.0.0:{PORT}", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
