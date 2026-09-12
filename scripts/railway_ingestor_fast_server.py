#!/usr/bin/env python3
"""Railway entrypoint with low-cost EPIR METAR fast checks.

Full acquisition remains on the existing 5-minute low-memory cycle. A tiny
scheduler additionally probes only the official IMGW Aviation API around the
routine EPIR METAR slots. If a new bulletin appears, metar_fast_check.py updates
the central archive and the event runtime immediately dispatches the GitHub
mirror. No TAF/SYNOP/lightning work is added to these fast checks.
"""
from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timezone

import railway_ingestor_lowmem_server as base
import railway_ingestor_event_server as event
import railway_ingestor_compressed_server  # noqa: F401 - installs gzip handler patch

FAST_OFFSETS = tuple(
    sorted({int(x) for x in os.environ.get("METAR_FAST_OFFSETS_MIN", "2,5,8,11,14").split(",") if x.strip().isdigit()})
)
FAST_ENABLED = os.environ.get("METAR_FAST_CHECK_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}
FAST_POLL_SECONDS = max(2, int(os.environ.get("METAR_FAST_SCHEDULER_POLL_SECONDS", "5")))
FAST_TIMEOUT_SECONDS = max(20, int(os.environ.get("METAR_FAST_TIMEOUT_SECONDS", "75")))


def is_fast_minute(minute: int) -> bool:
    base_minute = 0 if minute < 30 else 30
    return (minute - base_minute) in FAST_OFFSETS


def run_fast_check(now: datetime, reason: str) -> dict:
    result = base.run_child(
        "metar-fast-check",
        [
            base.PYTHON,
            str(base.SCRIPTS / "metar_fast_check.py"),
            "--lock-file",
            str(base.LOCK_PATH),
        ],
        timeout=FAST_TIMEOUT_SECONDS,
    )
    if result.get("ok"):
        # event.py replaces rebuild_manifest with the incremental
        # fingerprint+repository_dispatch implementation.
        base.rebuild_manifest()
    with base._runtime_lock:
        base._runtime["last_metar_fast_check"] = {
            "scheduled_for": now.replace(second=0, microsecond=0).isoformat().replace("+00:00", "Z"),
            "reason": reason,
            **result,
        }
    return result


def fast_scheduler() -> None:
    print(
        f"[{base.utc_iso()}] METAR fast scheduler started; enabled={FAST_ENABLED} offsets={FAST_OFFSETS}",
        flush=True,
    )
    if not FAST_ENABLED:
        return

    last_key: str | None = None
    saw_initial_full_cycle = False
    startup_probe_done = False

    while True:
        now = datetime.now(timezone.utc)
        runtime = base.runtime_snapshot()
        full_running = bool(runtime.get("cycle_running"))

        if full_running:
            saw_initial_full_cycle = True
        elif saw_initial_full_cycle and not startup_probe_done:
            # Exercise the fast path once after the first complete ingest cycle.
            # This gives every deployment a self-test without racing the initial
            # full archive update.
            startup_probe_done = True
            if is_fast_minute(now.minute):
                last_key = now.strftime("%Y%m%d%H%M")
            run_fast_check(now, "post-startup-full-cycle")
        elif is_fast_minute(now.minute):
            key = now.strftime("%Y%m%d%H%M")
            if key != last_key:
                last_key = key
                if full_running:
                    result = {
                        "ok": True,
                        "skipped": "full-cycle-running",
                        "scheduled_for": now.replace(second=0, microsecond=0).isoformat().replace("+00:00", "Z"),
                    }
                    print(f"[{base.utc_iso()}] metar-fast-check: {result}", flush=True)
                else:
                    run_fast_check(now, "scheduled")

        time.sleep(FAST_POLL_SECONDS)


def main() -> int:
    event.bootstrap_from_github()
    worker = threading.Thread(target=fast_scheduler, name="metar-fast-check", daemon=True)
    worker.start()
    return base.main()


if __name__ == "__main__":
    raise SystemExit(main())
