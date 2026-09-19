#!/usr/bin/env python3
"""Quality gate for historical model-learning inputs.

Previous Runs months are downloaded incrementally. A partially downloaded month
must remain on disk so the backfill can resume, but it must not influence
production verification/weights until enough peer models are available.

Policy:
- >= 5 models with rows: training input
- 3-4 models with rows: auxiliary only (kept, excluded from adaptive learning)
- < 3 models with rows: excluded from learning

The context manager below temporarily moves non-training Previous Runs files out
of data/learning/model-forecasts while the existing learning scripts run, then
restores them in a finally block. Raw data are never deleted or rewritten.
"""
from __future__ import annotations

import json
import re
import shutil
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, Iterator, Any

ROOT = Path(__file__).resolve().parents[1]
LEARNING_DIR = ROOT / "data" / "learning"
FORECAST_DIR = LEARNING_DIR / "model-forecasts"
STATE_FILE = LEARNING_DIR / "previous-runs-backfill-state.json"
PREVIOUS_RUNS_RE = re.compile(r"^backfill-previous-runs-(\d{4}-\d{2})\.jsonl$")

TRAINING_MIN_MODELS = 5
AUXILIARY_MIN_MODELS = 3


def _load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def classify_month(info: dict | None) -> str:
    if not info:
        return "unknown"
    n = int(info.get("models_with_rows") or 0)
    if n >= TRAINING_MIN_MODELS:
        return "training"
    if n >= AUXILIARY_MIN_MODELS:
        return "auxiliary"
    return "excluded"


def quality_report() -> Dict[str, Any]:
    state = _load_json(STATE_FILE, {})
    months = state.get("months") or {}
    report_months = {}
    counts = {"training": 0, "auxiliary": 0, "excluded": 0, "unknown": 0}

    known = set(months)
    if FORECAST_DIR.exists():
        for path in FORECAST_DIR.iterdir():
            match = PREVIOUS_RUNS_RE.match(path.name)
            if match:
                known.add(match.group(1))

    for month in sorted(known):
        info = months.get(month) or {}
        cls = classify_month(info)
        counts[cls] += 1
        report_months[month] = {
            "classification": cls,
            "status": info.get("status"),
            "models_with_rows": int(info.get("models_with_rows") or 0),
            "rows": int(info.get("rows") or 0),
            "attempts": int(info.get("attempts") or 0),
            "last_attempt_utc": info.get("last_attempt_utc"),
            "file": info.get("file") or f"data/learning/model-forecasts/backfill-previous-runs-{month}.jsonl",
        }

    return {
        "schema": "prognozaepir-learning-quality-gate-v1",
        "policy": {
            "training_min_models": TRAINING_MIN_MODELS,
            "auxiliary_min_models": AUXILIARY_MIN_MODELS,
            "training": ">=5 models; included in verification and adaptive weights",
            "auxiliary": "3-4 models; retained for diagnostics/backfill, excluded from adaptive weights",
            "excluded": "<3 models; retained only as raw backfill data",
            "unknown": "file without state metadata; excluded fail-safe",
        },
        "counts": counts,
        "months": report_months,
    }


@contextmanager
def training_only_previous_runs() -> Iterator[Dict[str, Any]]:
    """Temporarily hide non-training Previous Runs files from learning scripts."""
    report = quality_report()
    moved: list[tuple[Path, Path]] = []

    FORECAST_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="prognozaepir-learning-gate-") as tmp:
        tmpdir = Path(tmp)
        try:
            for path in sorted(FORECAST_DIR.glob("backfill-previous-runs-*.jsonl")):
                match = PREVIOUS_RUNS_RE.match(path.name)
                if not match:
                    continue
                month = match.group(1)
                cls = ((report.get("months") or {}).get(month) or {}).get("classification", "unknown")
                if cls == "training":
                    continue
                target = tmpdir / path.name
                shutil.move(str(path), str(target))
                moved.append((target, path))

            report["temporarily_quarantined_files"] = [dst.name for _src, dst in moved]
            report["temporarily_quarantined_count"] = len(moved)
            yield report
        finally:
            for source, destination in moved:
                destination.parent.mkdir(parents=True, exist_ok=True)
                if source.exists():
                    shutil.move(str(source), str(destination))


def main() -> None:
    print(json.dumps(quality_report(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
