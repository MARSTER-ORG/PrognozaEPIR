#!/usr/bin/env python3
"""Railway entrypoint with non-blocking Supabase parallel archive mirroring."""
from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timezone

import railway_ingestor_fast_server as fast

base = fast.base
RUNTIME_VERSION = "supabase-parallel-v1"
MIRROR_ENABLED = os.environ.get("SUPABASE_INGEST_ENABLED", "0").strip().lower() in {"1", "true", "yes", "on"}
MIRROR_INTERVAL_SECONDS = max(30, int(os.environ.get("SUPABASE_MIRROR_INTERVAL_SECONDS", "60")))
MIRROR_TIMEOUT_SECONDS = max(20, int(os.environ.get("SUPABASE_MIRROR_TIMEOUT_SECONDS", "90")))


def mirror_scheduler() -> None:
    print(
        f"[{base.utc_iso()}] Supabase mirror scheduler started; version={RUNTIME_VERSION} "
        f"enabled={MIRROR_ENABLED} interval={MIRROR_INTERVAL_SECONDS}s",
        flush=True,
    )
    if not MIRROR_ENABLED:
        return

    while True:
        runtime = base.runtime_snapshot()
        if not runtime.get("cycle_running"):
            scheduled_for = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
            result = base.run_child(
                "supabase-message-mirror",
                [
                    base.PYTHON,
                    str(base.SCRIPTS / "supabase_message_mirror.py"),
                    "--lookback-days",
                    os.environ.get("SUPABASE_INGEST_LOOKBACK_DAYS", "3"),
                ],
                timeout=MIRROR_TIMEOUT_SECONDS,
            )
            snapshot = {
                "scheduled_for": scheduled_for,
                "interval_seconds": MIRROR_INTERVAL_SECONDS,
                **result,
            }
            with base._runtime_lock:
                base._runtime["last_supabase_mirror"] = snapshot
        time.sleep(MIRROR_INTERVAL_SECONDS)


def main() -> int:
    # Preserve the established bootstrap and fast METAR/SPECI scheduler exactly,
    # then add a fully independent best-effort Supabase mirror thread.
    fast.event.bootstrap_from_github()
    fast_worker = threading.Thread(target=fast.fast_scheduler, name="metar-speci-fast-check", daemon=True)
    fast_worker.start()
    mirror_worker = threading.Thread(target=mirror_scheduler, name="supabase-message-mirror", daemon=True)
    mirror_worker.start()
    return base.main()


if __name__ == "__main__":
    raise SystemExit(main())
