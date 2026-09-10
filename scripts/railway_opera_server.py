#!/usr/bin/env python3
"""Railway entrypoint extending the central ingestor with an OPERA DBZH proxy.

The browser cannot reliably read the public CloudFerro OPERA GeoTIFF objects because
of cross-origin/range-request restrictions on some clients.  This wrapper keeps the
existing central-ingestor worker unchanged and adds one tightly-scoped, read-only
endpoint with CORS and HTTP Range passthrough:

    /opera/dbzh/YYYYMMDDHHMM.tiff

Only recent 5-minute OPERA DBZH timestamps are accepted; this is not an open proxy.
"""
from __future__ import annotations

import re
import threading
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import railway_ingestor_server as base

S3_BASE = "https://s3.waw3-1.cloudferro.com/openradar-24h"
FRAME_RE = re.compile(r"^/opera/dbzh/(20\d{10})\.tiff$")
MAX_AGE_SECONDS = 26 * 3600
MAX_FUTURE_SECONDS = 15 * 60


def _frame_time(token: str) -> datetime:
    return datetime.strptime(token, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)


def _upstream_url(token: str) -> str:
    dt = _frame_time(token)
    return (
        f"{S3_BASE}/{dt:%Y/%m/%d}/OPERA/COMP/"
        f"OPERA@{token}@0@DBZH.tiff"
    )


class Handler(base.Handler):
    server_version = "PrognozaEPIR-Ingestor/1.2"

    def _opera_headers(self, status: int, upstream_headers) -> None:
        self.send_response(status)
        self.send_header("Content-Type", upstream_headers.get("Content-Type") or "image/tiff")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        self.send_header("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length, ETag, Last-Modified")
        self.send_header("Accept-Ranges", upstream_headers.get("Accept-Ranges") or "bytes")
        self.send_header("Cache-Control", "public, max-age=300")
        for name in ("Content-Length", "Content-Range", "ETag", "Last-Modified"):
            value = upstream_headers.get(name)
            if value:
                self.send_header(name, value)
        self.end_headers()

    def _opera_proxy(self, path: str, head_only: bool = False) -> None:
        match = FRAME_RE.fullmatch(path)
        if not match:
            self._json({"error": "invalid OPERA DBZH path"}, status=400, head_only=head_only)
            return

        token = match.group(1)
        try:
            frame_dt = _frame_time(token)
        except ValueError:
            self._json({"error": "invalid OPERA timestamp"}, status=400, head_only=head_only)
            return

        now = datetime.now(timezone.utc)
        delta = (now - frame_dt).total_seconds()
        if frame_dt.minute % 5 != 0 or delta > MAX_AGE_SECONDS or delta < -MAX_FUTURE_SECONDS:
            self._json({"error": "OPERA timestamp outside allowed recent 5-minute window"}, status=400, head_only=head_only)
            return

        headers = {
            "Accept": "image/tiff,application/octet-stream;q=0.9,*/*;q=0.1",
            "User-Agent": "PrognozaEPIR/1.2",
        }
        range_header = self.headers.get("Range")
        if range_header:
            if not re.fullmatch(r"bytes=\d+-\d*", range_header.strip()):
                self._json({"error": "unsupported Range header"}, status=416, head_only=head_only)
                return
            headers["Range"] = range_header.strip()

        request = Request(
            _upstream_url(token),
            headers=headers,
            method="HEAD" if head_only else "GET",
        )
        try:
            with urlopen(request, timeout=20) as response:
                self._opera_headers(getattr(response, "status", 200), response.headers)
                if head_only:
                    return
                while True:
                    chunk = response.read(128 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except HTTPError as exc:
            if exc.code == 404:
                self._json({"error": "OPERA frame not available", "frame": token}, status=404, head_only=head_only)
            elif exc.code == 416:
                self.send_response(416)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
                content_range = exc.headers.get("Content-Range") if exc.headers else None
                if content_range:
                    self.send_header("Content-Range", content_range)
                self.end_headers()
            else:
                self._json({"error": f"OPERA upstream HTTP {exc.code}"}, status=502, head_only=head_only)
        except (URLError, TimeoutError, OSError) as exc:
            self._json({"error": f"OPERA upstream unavailable: {type(exc).__name__}"}, status=502, head_only=head_only)
        except (BrokenPipeError, ConnectionResetError):
            # Client cancelled a range request; this is normal while GeoTIFF probes tiles.
            return

    def _dispatch(self, head_only: bool = False) -> None:
        path = urlparse(self.path).path
        if path == "/opera/health":
            self._json(
                {
                    "service": "prognozaepir-opera-proxy",
                    "ok": True,
                    "source": "EUMETNET OPERA openradar-24h DBZH GeoTIFF",
                    "range": True,
                    "time": base.utc_iso(),
                },
                status=200,
                head_only=head_only,
            )
            return
        if path.startswith("/opera/dbzh/"):
            self._opera_proxy(path, head_only=head_only)
            return
        super()._dispatch(head_only=head_only)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        self.send_header("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length, ETag, Last-Modified")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()


def main() -> int:
    worker = threading.Thread(target=base.run_worker, name="central-ingestor", daemon=True)
    worker.start()
    server = ThreadingHTTPServer(("0.0.0.0", base.PORT), Handler)
    print(f"[{base.utc_iso()}] http+opera server listening on 0.0.0.0:{base.PORT}", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
