#!/usr/bin/env python3
"""Serverless Railway gateway for OPERA and emergency raw archive fallback.

Unlike railway_ingestor_lowmem_server.py this process starts no acquisition
worker. It only serves HTTP, so Railway App Sleep can suspend it when idle.
On each cold start the recent message archive is reconciled from the durable
GitHub mirror before the existing /data/messages and OPERA handlers go live.
"""
from __future__ import annotations

import threading

import railway_ingestor_lowmem_server as base
import railway_ingestor_event_server as event


def main() -> int:
    with base._runtime_lock:
        base._runtime["mode"] = "serverless-gateway-opera-archive"
        base._runtime["cycle_running"] = False
        base._runtime["cycle_started_at"] = None

    event.bootstrap_from_github()
    base.rebuild_manifest()

    try:
        threading.stack_size(base.HTTP_THREAD_STACK_BYTES)
    except (ValueError, RuntimeError):
        pass

    server = base.LowMemThreadingHTTPServer(("0.0.0.0", base.PORT), base.Handler)
    print(
        f"[{base.utc_iso()}] serverless gateway listening on 0.0.0.0:{base.PORT}; "
        f"OPERA proxy + raw archive fallback; acquisition worker disabled; "
        f"max_http_threads={base.HTTP_MAX_THREADS}",
        flush=True,
    )
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
