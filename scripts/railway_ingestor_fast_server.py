#!/usr/bin/env python3
"""Railway entrypoint with lightweight EPIR METAR/SPECI fast probing.

The full acquisition cycle remains on the five-minute low-memory scheduler. The
fast path probes only IMGW Aviation METAR/SPECI and then performs a tiny recent
Supabase sync. It deliberately does not rebuild/dispatch the GitHub fallback on
every probe; the full cycle owns fallback publication.
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
SUPABASE_FAST_SYNC_TIMEOUT_SECONDS = max(20, int(os.environ.get("SUPABASE_FAST_SYNC_TIMEOUT_SECONDS", "60")))


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

    mirror = None
    if result.get("ok"):
        # Supabase is PRIMARY. The mirror state makes an unchanged probe a very
        # cheap no-op, while a newly published METAR/SPECI is visible to all
        # frontend modules without waiting for the five-minute heavy cycle.
        mirror = base.run_child(
            "supabase-fast-sync",
            [
                base.PYTHON,
                str(base.SCRIPTS / "supabase_message_mirror.py"),
                "--lookback-days",
                "1",
            ],
            timeout=SUPABASE_FAST_SYNC_TIMEOUT_SECONDS,
        )
        if not mirror.get("ok"):
            result = {**result, "ok": False, "error": "fast bulletin acquired but Supabase sync failed"}

    snapshot = {
        "scheduled_for": now.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "reason": reason,
        "probe_interval_seconds": PROBE_INTERVAL_SECONDS,
        "supabase_sync": mirror,
        **result,
    }
    with base._runtime_lock:
        base._runtime["last_aviation_fast_check"] = snapshot
        base._runtime["last_metar_fast_check"] = snapshot
        if mirror is not None:
            base._runtime["last_supabase_mirror"] = {
                "mode": "fast-path",
                "scheduled_for": snapshot["scheduled_for"],
                **mirror,
            }
    return result


def fast_scheduler() -> None:
    print(
        f"[{base.utc_iso()}] METAR/SPECI fast scheduler started; enabled={FAST_ENABLED} "
        f"probe_interval={PROBE_INTERVAL_SECONDS}s primary=Supabase",
        flush=True,
    )
    if not FAST_ENABLED:
        return

    # Let bootstrap + the first heavy cycle establish a complete archive first.
    # Afterwards SPECI polling is continuous and waits only while a heavy cycle
    # owns the ingest lock/runtime slot.
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

        time.sleep(SCHEDULER_POLL_SECONDS)


def main() -> int:
    # Bootstrap local fallback files once. Full-cycle manifest publication stays
    # available as disaster fallback, but the fast path writes PRIMARY directly.
    event.bootstrap_from_github()
    worker = threading.Thread(target=fast_scheduler, name="metar-speci-fast-check", daemon=True)
    worker.start()
    return base.main()


if __name__ == "__main__":
    raise SystemExit(main())
