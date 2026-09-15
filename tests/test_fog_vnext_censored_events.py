#!/usr/bin/env python3
from __future__ import annotations

import csv
import io
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import fog_vnext_censored_events as ce
import fog_vnext_verification_censored as cv


def make_zip(path, headers, rows):
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=headers)
    w.writeheader()
    w.writerows(rows)
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(f"nested/{ce.CSV_BASENAME}", buf.getvalue())


def main():
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "history.zip"
        make_zip(
            p,
            ["event_id", "event_start", "event_end", "left_censored_onset", "right_censored_end"],
            [{
                "event_id": "E1",
                "event_start": "2024-10-01T03:00:00Z",
                "event_end": "2024-10-01T06:00:00Z",
                "left_censored_onset": "1",
                "right_censored_end": "0",
            }],
        )
        rows, schema = ce.load(p)
        assert schema["start"] == "event_start"
        assert schema["end"] == "event_end"
        assert rows[0]["left_censored"] is True
        assert rows[0]["right_censored"] is False

    # Unknown/censored transition target must not be converted into a negative.
    cases = [
        {"truth": {"event_id": "A", "x": True}, "lead_bucket": "3-6h", "s": 0.9},
        {"truth": {"event_id": "B", "x": False}, "lead_bucket": "3-6h", "s": 0.1},
        {"truth": {"event_id": "C", "x": None}, "lead_bucket": "3-6h", "s": 0.0},
    ]
    m = cv.target_metrics(cases, lambda c: c["s"], "x")
    assert m["hourly"]["n"] == 2
    assert m["hourly"]["positive"] == 1
    assert m["hourly"]["negative"] == 1
    print("canonical censor parsing + unknown-target exclusion: OK")


if __name__ == "__main__":
    main()
