#!/usr/bin/env python3
"""Normalize durable staging before running the archive freshness gate.

The central cycle acquires a new routine METAR into data/observations before the
METAR precheck. Without this bridge the check can see MessageArchive one step
behind staging and start an unnecessary armored recovery. Normalization is
idempotent, so the same wrapper is safe for the post-recovery METAR check too.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
PYTHON = sys.executable or "python3"


def run(argv: list[str], timeout: int) -> int:
    try:
        proc = subprocess.run(argv, cwd=ROOT, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        print(f"freshness pre-normalize timeout after {timeout}s", flush=True)
        return 124
    return proc.returncode


def main() -> int:
    normalize_rc = run([PYTHON, str(SCRIPTS / "message_archive.py")], 180)
    if normalize_rc != 0:
        print(f"freshness pre-normalize failed: exit {normalize_rc}", flush=True)
        return normalize_rc
    return run(
        [PYTHON, str(SCRIPTS / "check_epir_archive_freshness.py"), *sys.argv[1:]],
        60,
    )


if __name__ == "__main__":
    raise SystemExit(main())
