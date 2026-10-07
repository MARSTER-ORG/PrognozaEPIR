#!/usr/bin/env python3
"""One-shot Railway cron entrypoint for PrognozaEPIR acquisition.

This replaces the old 24/7 in-process scheduler. Each invocation:
1. restores the recent durable message archive and LFL collector state,
2. performs one fast METAR/SPECI probe,
3. refreshes MTG LI LFL and publishes it to Supabase,
4. runs one full tiered message-ingest cycle,
5. dispatches a durable archive mirror only when content changed,
then exits so Railway stops billing compute until the next cron invocation.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import railway_ingestor_lowmem_server as base  # noqa: E402
import railway_ingestor_event_server as event  # noqa: E402


def main() -> int:
    results: dict[str, object] = {}

    bootstrap = event.bootstrap_from_github()
    results["archive_bootstrap"] = bootstrap

    # Establish the pre-cycle fingerprint. A second rebuild after acquisition
    # can then emit the existing GitHub archive-dispatch event only on changes.
    event.rebuild_manifest_incremental()

    results["lightning_restore"] = base.run_child(
        "lightning-restore",
        [base.PYTHON, str(base.SCRIPTS / "supabase_lightning_mirror.py"), "restore"],
        timeout=60,
    )

    results["aviation_fast_check"] = base.run_child(
        "aviation-fast-check",
        [
            base.PYTHON,
            str(base.SCRIPTS / "metar_fast_check.py"),
            "--lock-file",
            str(base.LOCK_PATH),
        ],
        timeout=90,
    )

    results["lightning_lfl"] = base.run_child(
        "lightning-lfl",
        [base.PYTHON, str(base.SCRIPTS / "collect_lightning_features_lowmem.py")],
        timeout=240,
    )

    results["lightning_publish"] = base.run_child(
        "lightning-publish",
        [base.PYTHON, str(base.SCRIPTS / "supabase_lightning_mirror.py"), "publish"],
        timeout=90,
    )

    results["central_messages"] = base.run_child(
        "central-messages",
        [
            base.PYTHON,
            str(base.SCRIPTS / "central_ingestor_tiered.py"),
            "--once",
            "--state-file",
            str(base.STATE_PATH),
            "--lock-file",
            str(base.LOCK_PATH),
        ],
        timeout=720,
    )

    event.rebuild_manifest_incremental()

    messages_ok = bool((results["central_messages"] or {}).get("ok"))
    lightning_ok = bool((results["lightning_publish"] or {}).get("ok"))
    ok = messages_ok and lightning_ok
    summary = {
        "schema": "prognozaepir-railway-cron-run-v1",
        "ok": ok,
        "results": results,
        "archive_fingerprint": base.runtime_snapshot().get("archive_fingerprint"),
        "archive_dispatch": base.runtime_snapshot().get("archive_dispatch"),
    }
    print(json.dumps(summary, ensure_ascii=False, separators=(",", ":")), flush=True)
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
