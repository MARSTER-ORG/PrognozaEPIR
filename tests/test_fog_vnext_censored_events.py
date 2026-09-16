#!/usr/bin/env python3
from __future__ import annotations

import csv
import io
import sys
import tempfile
import zipfile
from datetime import datetime, timedelta, timezone
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

    # Regression for the real corrected-v2 schema: a left-censored event may
    # have no reliable clear timestamp before onset. The event itself still
    # starts at onset and ends at last_positive.
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "real-schema.zip"
        headers = [
            "event_id", "onset", "last_positive",
            "onset_interval_start_reliable_clear",
            "onset_interval_end_first_positive",
            "onset_left_censored",
            "dissipation_interval_start_last_positive",
            "dissipation_interval_end_reliable_clear",
            "dissipation_right_censored",
        ]
        make_zip(
            p,
            headers,
            [{
                "event_id": "2",
                "onset": "2020-05-04T04:30:00Z",
                "last_positive": "2020-05-04T05:00:00Z",
                "onset_interval_start_reliable_clear": "",
                "onset_interval_end_first_positive": "2020-05-04T04:30:00Z",
                "onset_left_censored": "True",
                "dissipation_interval_start_last_positive": "2020-05-04T05:00:00Z",
                "dissipation_interval_end_reliable_clear": "2020-05-04T05:30:00Z",
                "dissipation_right_censored": "False",
            }],
        )
        rows, schema = ce.load(p)
        assert schema["start"] == "onset"
        assert schema["end"] == "last_positive"
        assert rows[0]["start"].isoformat() == "2020-05-04T04:30:00+00:00"
        assert rows[0]["end"].isoformat() == "2020-05-04T05:00:00+00:00"
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

    # The indexed METAR lookup must be bit-for-bit equivalent to the existing
    # +/-31 minute selection policy, including circular averaging in weak wind.
    target = datetime(2026, 9, 15, 1, 0, tzinfo=timezone.utc)
    points = [
        (target - timedelta(hours=3), {"obs_time": "2026-09-14T22:00:00Z", "wind_direction_deg": 180.0, "wind_speed_ms": 4.0}),
        (target - timedelta(minutes=30), {"obs_time": "2026-09-15T00:30:00Z", "wind_direction_deg": 350.0, "wind_speed_ms": 1.2}),
        (target, {"obs_time": "2026-09-15T01:00:00Z", "wind_direction_deg": 10.0, "wind_speed_ms": 1.0}),
        (target + timedelta(minutes=30), {"obs_time": "2026-09-15T01:30:00Z", "wind_direction_deg": 20.0, "wind_speed_ms": 1.1}),
        (target + timedelta(hours=3), {"obs_time": "2026-09-15T04:00:00Z", "wind_direction_deg": 270.0, "wind_speed_ms": 5.0}),
    ]
    legacy = cv._ORIGINAL_WIND_REFERENCE(target, points)
    indexed = cv.indexed_metar_wind_reference(target, points)
    assert indexed == legacy
    assert indexed["wind_direction_reference_source"] == "METAR_3_CIRCULAR_MEAN"
    assert len(indexed["wind_direction_reference_samples"]) == 3

    print("canonical censor parsing + unknown-target exclusion + indexed wind reference: OK")


if __name__ == "__main__":
    main()
