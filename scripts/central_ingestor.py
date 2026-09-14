#!/usr/bin/env python3
"""Single operational ingest entry point for PrognozaEPIR bulletins.

All automatic acquisition of METAR/SPECI/TAF/SYNOP enters through this
orchestrator. Source-specific scripts are internal adapters. Local JSONL remains
the fallback/mirror format, while Supabase is the primary operational archive.

The five-minute cycle avoids spawning maintenance subprocesses when their input
has not changed. Recovery and Supabase catch-up remain unconditional where they
matter for correctness.
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


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


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
            proc = subprocess.run(argv, cwd=ROOT, timeout=timeout, check=False)
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


def _file_state(path: Path) -> tuple[str, int, int]:
    try:
        stat = path.stat()
        return (path.as_posix(), stat.st_size, stat.st_mtime_ns)
    except OSError:
        return (path.as_posix(), 0, 0)


def _tree_state(root: Path) -> tuple:
    if not root.exists():
        return ((root.as_posix(), 0, 0),)
    if root.is_file():
        return (_file_state(root),)
    return tuple(_file_state(path) for path in sorted(root.rglob("*")) if path.is_file())


def taf_cache_state() -> tuple:
    return tuple(_file_state(ROOT / rel) for rel in (
        "data/taf/neighbors.json",
        "data/taf/latest.json",
    ))


def staging_payload_state() -> tuple:
    """Track only durable bulletin staging, not volatile latest/recent metadata.

    This avoids treating changing collection timestamps/age counters as new
    weather data. New METAR/SYNOP/manual/EPIR-TAF rows do change these trees.
    """
    roots = (
        ROOT / "data" / "observations" / "metar",
        ROOT / "data" / "observations" / "synop",
        ROOT / "data" / "observations" / "manual",
        ROOT / "data" / "taf" / "epir",
    )
    items: list[tuple[str, int, int]] = []
    for root in roots:
        items.extend(_tree_state(root))
    return tuple(items)


def archive_payload_state() -> tuple:
    """Cheap structural signature, not a full archive content scan."""
    root = ROOT / "data" / "messages"
    items = []
    if root.exists():
        for path in sorted(root.rglob("*.jsonl")):
            items.append(_file_state(path))
    items.extend(taf_cache_state())
    return tuple(items)


def previous_cycle_needs_recovery(state_path: Path) -> bool:
    state = read_json(state_path, {})
    return not isinstance(state, dict) or not state or state.get("ok") is not True


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
    recovery_cycle = previous_cycle_needs_recovery(state_path)
    taf_changed = False
    staging_changed = False
    archive_changed = False
    skipped: list[str] = []

    staging_before = staging_payload_state()
    archive_before_acquisition = archive_payload_state()

    try:
        results.append(run_step("observations-primary", script("collect_epir_observations.py"), attempts=2, timeout=120))
        results.append(run_step("synop-supplement", script("supplement_synop_12342.py"), attempts=2, timeout=90))

        metar_precheck = run_step(
            "metar-precheck",
            script("check_epir_archive_freshness.py", "--metar-only"),
            attempts=1,
            timeout=30,
        )
        results.append(metar_precheck)
        metar_recovery_ran = not metar_precheck.ok
        if metar_precheck.ok:
            log("metar-armored-repair: skipped; archive is fresh and continuous")
            skipped.append("metar-armored-repair")
        else:
            log("metar-armored-repair: freshness/continuity gate failed; running recovery")
            results.append(run_step("metar-armored-repair", script("metar_armored.py"), attempts=2, timeout=120))

        taf_before = taf_cache_state()
        results.append(run_step("taf-and-neighbors", script("collect_neighbor_tafs.py"), attempts=3, timeout=120))
        taf_changed = taf_before != taf_cache_state()
        if taf_changed or recovery_cycle:
            results.append(run_step("taf-sanitize", script("sanitize_neighbor_tafs.py"), attempts=1, timeout=60))
        else:
            log("taf-sanitize: skipped; TAF cache unchanged")
            skipped.append("taf-sanitize")

        staging_changed = staging_before != staging_payload_state()
        direct_archive_changed = archive_before_acquisition != archive_payload_state()

        before_normalize = archive_payload_state()
        if staging_changed or recovery_cycle:
            results.append(run_step("archive-normalize", script("message_archive.py"), attempts=1, timeout=180, critical=True))
        else:
            log("archive-normalize: skipped; durable bulletin staging unchanged")
            skipped.append("archive-normalize")
        after_normalize = archive_payload_state()
        archive_changed = direct_archive_changed or before_normalize != after_normalize or taf_changed

        if archive_changed or recovery_cycle:
            results.append(run_step("archive-finalize", script("finalize_central_message_architecture.py"), attempts=1, timeout=120, critical=True))
        else:
            log("archive-finalize: skipped; operational archive unchanged")
            skipped.append("archive-finalize")

        # Keep one five-minute catch-up sync even when nothing changed. It is a
        # cheap safety net for a failed one-minute fast sync or a service restart.
        results.append(run_step(
            "supabase-sync",
            script("supabase_message_mirror.py", "--lookback-days", os.environ.get("SUPABASE_INGEST_LOOKBACK_DAYS", "3")),
            attempts=2,
            timeout=120,
            critical=True,
        ))

        if metar_recovery_ran:
            results.append(run_step("metar-freshness", script("check_epir_archive_freshness.py", "--metar-only"), attempts=1, timeout=60))
        else:
            log("metar-freshness: skipped; precheck already passed and no repair was needed")
            skipped.append("metar-freshness")

        skipped.append("synop-archive-audit")
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
        "schema": "prognozaepir-central-ingestor-state-v4-lean",
        "finished_at": utc_iso(),
        "duration_s": round(time.monotonic() - started, 3),
        "ok": cycle_error is None,
        "published": published,
        "error": cycle_error,
        "recovery_cycle": recovery_cycle,
        "taf_changed": taf_changed,
        "staging_changed": staging_changed,
        "archive_changed": archive_changed,
        "skipped": skipped,
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
        time.sleep(max(1.0, interval - elapsed))


if __name__ == "__main__":
    raise SystemExit(main())
