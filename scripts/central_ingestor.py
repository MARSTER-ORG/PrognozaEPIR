#!/usr/bin/env python3
"""Single operational ingest entry point for PrognozaEPIR bulletins.

All automatic acquisition of METAR/SPECI/TAF/SYNOP must enter through this
orchestrator. Source-specific scripts are treated as internal adapters; only
message_archive.py writes the authoritative data/messages archive.

Modes:
  --once                 run one complete ingest cycle (CI / manual)
  --daemon               run continuously (systemd / VPS)
  --publish-git          publish changed data/messages to origin/main

The process is deliberately conservative: source failures are isolated, archive
normalization/validation is critical, overlapping local runs are blocked, and
no browser/frontend component is ever used for acquisition.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import random
import subprocess
import sys
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
DEFAULT_LOCK = Path(os.environ.get("PROGNOZAEPIR_INGEST_LOCK", "/tmp/prognozaepir-central-ingest.lock"))
DEFAULT_STATE = Path(os.environ.get("PROGNOZAEPIR_INGEST_STATE", "/tmp/prognozaepir-ingest-state.json"))
PYTHON = sys.executable or "python3"


@dataclass
class StepResult:
    name: str
    ok: bool
    attempts: int
    duration_s: float
    error: str | None = None


def utc_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def log(message: str) -> None:
    print(f"[{utc_iso()}] {message}", flush=True)


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    text = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    with tmp.open("w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def run_cmd(argv: list[str], *, timeout: int = 90, check: bool = False) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(
        argv,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
        check=False,
    )
    if proc.stdout:
        print(proc.stdout.rstrip(), flush=True)
    if check and proc.returncode != 0:
        raise RuntimeError(f"command failed ({proc.returncode}): {' '.join(argv)}")
    return proc


def script(name: str, *args: str) -> list[str]:
    return [PYTHON, str(SCRIPTS / name), *args]


def run_step(name: str, argv: list[str], *, attempts: int = 1, timeout: int = 90, critical: bool = False) -> StepResult:
    started = time.monotonic()
    last_error: str | None = None
    for attempt in range(1, attempts + 1):
        try:
            log(f"{name}: attempt {attempt}/{attempts}")
            proc = run_cmd(argv, timeout=timeout)
            if proc.returncode == 0:
                return StepResult(name, True, attempt, round(time.monotonic() - started, 3))
            last_error = f"exit {proc.returncode}"
        except subprocess.TimeoutExpired:
            last_error = f"timeout after {timeout}s"
        except Exception as exc:
            last_error = f"{type(exc).__name__}: {exc}"
        if attempt < attempts:
            delay = min(30.0, 2.5 * (2 ** (attempt - 1))) + random.uniform(0.0, 1.5)
            log(f"{name}: degraded ({last_error}); retry in {delay:.1f}s")
            time.sleep(delay)
    result = StepResult(name, False, attempts, round(time.monotonic() - started, 3), last_error)
    if critical:
        raise RuntimeError(f"critical step {name} failed: {last_error}")
    log(f"{name}: degraded ({last_error}); continuing with other sources")
    return result


def cleanup_staging() -> None:
    if not (ROOT / ".git").exists():
        return
    subprocess.run(
        ["git", "restore", "--worktree", "--", "data/observations", "data/taf"],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    subprocess.run(
        ["git", "clean", "-fd", "--", "data/observations", "data/taf"],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )


def publish_git() -> bool:
    if not (ROOT / ".git").exists():
        raise RuntimeError("--publish-git requires a git checkout")
    changed = run_cmd(["git", "status", "--porcelain", "--", "data/messages"], timeout=30)
    if not changed.stdout.strip():
        log("publish: archive unchanged")
        return False

    run_cmd(["git", "config", "user.name", "prognozaepir-ingestor"], timeout=15, check=True)
    run_cmd(["git", "config", "user.email", "ingestor@prognozaepir.invalid"], timeout=15, check=True)
    run_cmd(["git", "add", "data/messages"], timeout=30, check=True)
    commit = run_cmd(["git", "commit", "-m", "weather: central ingestor archive update"], timeout=30)
    if commit.returncode != 0:
        staged = run_cmd(["git", "diff", "--cached", "--quiet", "--", "data/messages"], timeout=20)
        if staged.returncode != 0:
            raise RuntimeError("unable to commit central archive")
        return False

    for attempt in range(1, 6):
        push = run_cmd(["git", "push", "origin", "HEAD:main"], timeout=60)
        if push.returncode == 0:
            log("publish: data/messages pushed to main")
            return True
        log(f"publish: push race/failure {attempt}/5")
        fetch = run_cmd(["git", "fetch", "origin", "main"], timeout=60)
        if fetch.returncode != 0:
            time.sleep(attempt * 3)
            continue
        rebase = run_cmd(["git", "rebase", "origin/main"], timeout=60)
        if rebase.returncode == 0:
            time.sleep(attempt * 2)
            continue
        run_cmd(["git", "rebase", "--abort"], timeout=20)
        raise RuntimeError("archive publish conflict; refusing to overwrite newer main")
    raise RuntimeError("unable to publish central archive after 5 attempts")


@contextlib.contextmanager
def exclusive_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+", encoding="utf-8") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("another central ingest cycle is already running") from exc
        handle.seek(0)
        handle.truncate()
        handle.write(f"pid={os.getpid()} started={utc_iso()}\n")
        handle.flush()
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def cycle(*, publish: bool, state_path: Path) -> dict:
    started = time.monotonic()
    results: list[StepResult] = []
    cycle_error: str | None = None
    published = False
    try:
        results.append(run_step("observations-primary", script("collect_epir_observations.py"), attempts=2, timeout=120))
        results.append(run_step("synop-supplement", script("supplement_synop_12342.py"), attempts=2, timeout=90))
        results.append(run_step("metar-armored", script("metar_armored.py"), attempts=3, timeout=120))
        results.append(run_step("taf-imgw-pilothub", script("collect_neighbor_tafs.py"), attempts=3, timeout=120))
        results.append(run_step("taf-awc-repair", script("repair_awc_tafs.py"), attempts=2, timeout=90))
        results.append(run_step("taf-sanitize", script("sanitize_neighbor_tafs.py"), attempts=1, timeout=60))

        results.append(run_step("archive-normalize", script("message_archive.py"), attempts=1, timeout=180, critical=True))
        results.append(run_step("taf-finalize", script("finalize_central_message_architecture.py"), attempts=1, timeout=120, critical=True))
        results.append(run_step("taf-native-archive", script("ensure_taf_native_archive.py"), attempts=1, timeout=90, critical=True))
        results.append(run_step("archive-validate", script("message_archive.py", "--validate-only"), attempts=1, timeout=120, critical=True))
        results.append(run_step("architecture-boundary", script("check_archive_boundaries.py"), attempts=1, timeout=60, critical=True))

        results.append(run_step("metar-freshness", script("check_epir_archive_freshness.py", "--metar-only"), attempts=1, timeout=60))
        results.append(run_step("synop-freshness", script("check_synop_archive_freshness.py"), attempts=1, timeout=60))
        results.append(run_step("taf-freshness", script("check_epir_archive_freshness.py", "--taf-only", "--all-tafs"), attempts=1, timeout=60))

        cleanup_staging()
        if publish:
            published = publish_git()
    except Exception as exc:
        cycle_error = f"{type(exc).__name__}: {exc}"
        log(f"cycle failed: {cycle_error}")
    finally:
        cleanup_staging()

    state = {
        "schema": "prognozaepir-central-ingestor-state-v1",
        "finished_at": utc_iso(),
        "duration_s": round(time.monotonic() - started, 3),
        "ok": cycle_error is None,
        "published": published,
        "error": cycle_error,
        "steps": [asdict(r) for r in results],
    }
    atomic_json(state_path, state)
    return state


def main() -> int:
    ap = argparse.ArgumentParser()
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true", help="run one cycle (default)")
    mode.add_argument("--daemon", action="store_true", help="run continuously (systemd / VPS)")
    ap.add_argument("--interval", type=int, default=120, help="daemon interval in seconds (min 60)")
    ap.add_argument("--publish-git", action="store_true", help="commit/push changed data/messages to origin/main")
    ap.add_argument("--lock-file", type=Path, default=DEFAULT_LOCK)
    ap.add_argument("--state-file", type=Path, default=DEFAULT_STATE)
    args = ap.parse_args()
    interval = max(60, args.interval)

    if not args.daemon:
        try:
            with exclusive_lock(args.lock_file):
                return 0 if cycle(publish=args.publish_git, state_path=args.state_file)["ok"] else 1
        except RuntimeError as exc:
            log(str(exc))
            return 2

    log(f"central ingestor daemon started; interval={interval}s publish_git={args.publish_git}")
    while True:
        loop_started = time.monotonic()
        try:
            with exclusive_lock(args.lock_file):
                cycle(publish=args.publish_git, state_path=args.state_file)
        except RuntimeError as exc:
            log(f"cycle skipped: {exc}")
        elapsed = time.monotonic() - loop_started
        sleep_for = max(1.0, interval - elapsed)
        time.sleep(sleep_for)


if __name__ == "__main__":
    raise SystemExit(main())
