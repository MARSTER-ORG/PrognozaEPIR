#!/usr/bin/env python3
"""Railway entrypoint with low-cost continuous EPIR METAR/SPECI probing.

Full acquisition remains on the existing 5-minute low-memory cycle. A tiny
scheduler additionally probes only the official IMGW Aviation API every minute.
This is required for irregular SPECI and also gives bounded first-seen latency
for routine METAR. If a new bulletin appears, metar_fast_check.py updates the
central archive and the event runtime immediately dispatches the GitHub mirror.
No TAF/SYNOP/lightning/neighbor-airport work is added to these probes.
"""
from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timezone

import railway_ingestor_lowmem_server as base
import railway_ingestor_event_server as event
import railway_ingestor_compressed_server  # noqa: F401 - installs gzip handler patch

FAST_ENABLED = os.environ.get("METAR_FAST_CHECK_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}
PROBE_INTERVAL_SECONDS = max(30, int(os.environ.get("IMGW_AVIATION_PROBE_INTERVAL_SECONDS", "60")))
SCHEDULER_POLL_SECONDS = max(2, int(os.environ.get("METAR_FAST_SCHEDULER_POLL_SECONDS", "5")))
FAST_TIMEOUT_SECONDS = max(20, int(os.environ.get("METAR_FAST_TIMEOUT_SECONDS", "75")))


def run_fast_check(now: datetime, reason: str) -> dict:
    result = base.run_child(
        "aviation-fast-check",
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
        # fingerprint+repository_dispatch implementation. Telemetry JSONL and
        # newly archived METAR/SPECI therefore mirror immediately on change.
        base.rebuild_manifest()
    snapshot = {
        "scheduled_for": now.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "reason": reason,
        "probe_interval_seconds": PROBE_INTERVAL_SECONDS,
        **result,
    }
    with base._runtime_lock:
        base._runtime["last_aviation_fast_check"] = snapshot
        # Compatibility with existing health consumers.
        base._runtime["last_metar_fast_check"] = snapshot
    return result


def fast_scheduler() -> None:
    print(
        f"[{base.utc_iso()}] METAR/SPECI fast scheduler started; enabled={FAST_ENABLED} "
        f"probe_interval={PROBE_INTERVAL_SECONDS}s",
        flush=True,
    )
    if not FAST_ENABLED:
        return

    # Wait for the first complete heavy cycle. This avoids racing archive
    # bootstrap and makes the first successful API read an honest telemetry
    # baseline. Afterwards the probe is continuous because SPECI is irregular.
    saw_initial_full_cycle = False
    startup_probe_done = False
    next_due = time.monotonic()

    while True:
        runtime = base.runtime_snapshot()
        full_running = bool(runtime.get("cycle_running"))

        if full_running:
            saw_initial_full_cycle = True
        elif saw_initial_full_cycle and not startup_probe_done:
            startup_probe_done = True
            now = datetime.now(timezone.utc)
            run_fast_check(now, "post-startup-full-cycle-baseline")
            next_due = time.monotonic() + PROBE_INTERVAL_SECONDS
        elif startup_probe_done and time.monotonic() >= next_due:
            if not full_running:
                now = datetime.now(timezone.utc)
                run_fast_check(now, "continuous-metar-speci-probe")
                next_due = time.monotonic() + PROBE_INTERVAL_SECONDS
            # If the heavy cycle is holding the lock, do not skip a whole
            # interval. Retry after the short scheduler sleep and probe as soon
            # as the full cycle finishes.

        time.sleep(SCHEDULER_POLL_SECONDS)


def main() -> int:
    event.bootstrap_from_github()
    worker = threading.Thread(target=fast_scheduler, name="metar-speci-fast-check", daemon=True)
    worker.start()
    return base.main()


if __name__ == "__main__":
    raise SystemExit(main())
