#!/usr/bin/env python3
"""Railway entrypoint with lightweight EPIR METAR/SPECI fast probing.

The full acquisition cycle remains on the five-minute low-memory scheduler. The
fast path probes only IMGW Aviation METAR/SPECI. Supabase synchronisation is
spawned only when the probe actually changes today's/yesterday's central
METAR/SPECI JSONL; unchanged one-minute probes therefore cost one short process,
not two.

The full bulletin cycle is routed through central_ingestor_tiered.py, which
changes only TAF source scheduling: PilotHub/IMGW first, expensive/broken
provider calls only as fallbacks for stations still missing a current TAF.
"""
from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timedelta, timezone

import railway_ingestor_lowmem_server as base
import railway_ingestor_event_server as event
import railway_ingestor_compressed_server  # noqa: F401 - installs gzip handler patch

FAST_ENABLED = os.environ.get("METAR_FAST_CHECK_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}
PROBE_INTERVAL_SECONDS = max(30, int(os.environ.get("IMGW_AVIATION_PROBE_INTERVAL_SECONDS", "60")))
SCHEDULER_POLL_SECONDS = max(2, int(os.environ.get("METAR_FAST_SCHEDULER_POLL_SECONDS", "5")))
FAST_TIMEOUT_SECONDS = max(20, int(os.environ.get("METAR_FAST_TIMEOUT_SECONDS", "75")))
SUPABASE_FAST_SYNC_TIMEOUT_SECONDS = max(20, int(os.environ.get("SUPABASE_FAST_SYNC_TIMEOUT_SECONDS", "60")))

# Keep the low-memory runtime intact and redirect only its central bulletin
# subprocess to the compatibility entrypoint that installs tiered TAF sourcing.
_ORIGINAL_RUN_CHILD = base.run_child


def _run_child_with_tiered_taf(label: str, argv: list[str], timeout: int) -> dict:
    if label == "central-messages":
        argv = list(argv)
        for idx, value in enumerate(argv):
            if str(value).endswith("/central_ingestor.py") or str(value).endswith("\\central_ingestor.py"):
                argv[idx] = str(base.SCRIPTS / "central_ingestor_tiered.py")
                break
    return _ORIGINAL_RUN_CHILD(label, argv, timeout)


base.run_child = _run_child_with_tiered_taf


def _fast_archive_signature(now: datetime) -> tuple:
    """Cheap change detector for files the fast path can modify.

    Reports around midnight may belong to yesterday UTC, so both UTC dates are
    watched. Size + nanosecond mtime is enough because metar_fast_check writes
    atomically only when a new bulletin is staged/normalised.
    """
    items = []
    for offset in (0, 1):
        day = now - timedelta(days=offset)
        for kind in ("metar", "speci"):
            path = base.ARCHIVE / kind / f"{day:%Y}" / f"{day:%m}" / f"{day:%d}.jsonl"
            try:
                stat = path.stat()
                items.append((path.as_posix(), stat.st_size, stat.st_mtime_ns))
            except OSError:
                items.append((path.as_posix(), 0, 0))
    return tuple(items)


def run_fast_check(now: datetime, reason: str) -> dict:
    before = _fast_archive_signature(now)
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
    after = _fast_archive_signature(datetime.now(timezone.utc))
    archive_changed = before != after

    mirror = None
    if result.get("ok") and archive_changed:
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
    elif result.get("ok"):
        mirror = {
            "ok": True,
            "skipped": True,
            "reason": "archive-unchanged",
            "duration_s": 0.0,
        }
        print(f"[{base.utc_iso()}] supabase-fast-sync: skipped; archive unchanged", flush=True)

    snapshot = {
        "scheduled_for": now.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "reason": reason,
        "probe_interval_seconds": PROBE_INTERVAL_SECONDS,
        "archive_changed": archive_changed,
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
    event.bootstrap_from_github()
    worker = threading.Thread(target=fast_scheduler, name="metar-speci-fast-check", daemon=True)
    worker.start()
    return base.main()


if __name__ == "__main__":
    raise SystemExit(main())
