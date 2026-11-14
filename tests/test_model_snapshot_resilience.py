#!/usr/bin/env python3
"""Offline regression tests: never contact Open-Meteo or modify real snapshots."""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_model_snapshot as snapshot  # noqa: E402


def payload(times, **variables):
    return {
        "latitude": snapshot.LAT,
        "longitude": snapshot.LON,
        "hourly": {"time": list(times), **variables},
        "hourly_units": {},
    }


def usable_cache(age_hours=1):
    at = (datetime.now(timezone.utc) - timedelta(hours=age_hours)).isoformat().replace("+00:00", "Z")
    row = {"hourly": {"time": [f"2026-11-15T{i:02d}:00" for i in range(24)]}}
    return {
        "schema": "prognozaepir-model-snapshot-v1",
        "generated_at": at,
        "models": {name: row for name in ("a", "b", "c")},
    }


class ModelSnapshotResilienceTests(unittest.TestCase):
    def test_http_429_does_not_retry_or_split(self):
        err = urllib.error.HTTPError(
            "https://api.open-meteo.com", 429, "Too Many Requests", {},
            io.BytesIO(b'{"error":true,"reason":"Daily API request limit exceeded"}'),
        )
        with patch.object(snapshot.urllib.request, "urlopen", side_effect=err) as send:
            with self.assertRaisesRegex(snapshot.ModelAPIError, "HTTP 429"):
                snapshot.fetch_resilient("ecmwf_ifs", ["a", "b", "c"], budget=24)
        self.assertEqual(send.call_count, 1)

    def test_bad_model_400_is_not_split(self):
        def fail(*_args, **_kwargs):
            raise snapshot.ModelAPIError("HTTP 400: Invalid models parameter", status=400)
        with patch.object(snapshot, "request_json", side_effect=fail) as send:
            with self.assertRaisesRegex(snapshot.ModelAPIError, "Invalid models"):
                snapshot.fetch_resilient("wrong_model", ["a", "b", "c"])
        self.assertEqual(send.call_count, 1)

    def test_unsupported_hourly_field_isolated_within_budget(self):
        def fetch(_model, variables):
            if "unsupported_hourly" in variables:
                raise snapshot.ModelAPIError(
                    "HTTP 400: Invalid hourly variable unsupported_hourly", status=400
                )
            return payload(["2026-11-15T00:00", "2026-11-15T01:00"], **{v: [1, 2] for v in variables})
        with patch.object(snapshot, "request_json", side_effect=fetch) as send:
            result, errors = snapshot.fetch_resilient(
                "ecmwf_ifs", ["temperature_2m", "unsupported_hourly"], budget=6
            )
        self.assertIn("temperature_2m", result["hourly"])
        self.assertNotIn("unsupported_hourly", result["hourly"])
        self.assertEqual(len(errors), 1)
        self.assertLessEqual(send.call_count, 6)

    def test_merge_aligns_by_timestamp_not_array_index(self):
        base = payload(["t0", "t1", "t2"], temperature_2m=[0, 1, 2])
        extra = payload(["t1", "t2", "t3"], cloud_cover=[10, 20, 30])
        merged = snapshot.merge_payload(base, extra)
        self.assertEqual(merged["hourly"]["cloud_cover"], [None, 10, 20])
        self.assertEqual(merged["hourly"]["temperature_2m"], [0, 1, 2])

    def test_cached_data_preserved_on_quota_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "models-latest.json"
            dest.write_text(json.dumps(usable_cache()), encoding="utf-8")
            before = dest.read_bytes()
            with patch.object(snapshot, "OUT", dest), patch.object(
                snapshot, "fetch_model",
                side_effect=snapshot.ModelAPIError("HTTP 429: quota", status=429),
            ):
                with patch.dict(os.environ, {"EPIR_SNAPSHOT_MIN_REFRESH_HOURS": "0"}):
                    snapshot.main()
            self.assertEqual(dest.read_bytes(), before)

    def test_no_valid_cache_still_fails_loudly(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "models-latest.json"
            dest.write_text(json.dumps(usable_cache(age_hours=24)), encoding="utf-8")
            with patch.object(snapshot, "OUT", dest), patch.object(
                snapshot, "fetch_model",
                side_effect=snapshot.ModelAPIError("HTTP 429: quota", status=429),
            ):
                with patch.dict(os.environ, {"EPIR_SNAPSHOT_MIN_REFRESH_HOURS": "0"}):
                    with self.assertRaises(SystemExit):
                        snapshot.main()

    def test_recent_cache_skips_scheduled_poll(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "models-latest.json"
            dest.write_text(json.dumps(usable_cache()), encoding="utf-8")
            with patch.object(snapshot, "OUT", dest), patch.object(
                snapshot, "fetch_model",
                side_effect=AssertionError("should not call the network"),
            ):
                with patch.dict(os.environ, {"EPIR_SNAPSHOT_MIN_REFRESH_HOURS": "3"}):
                    snapshot.main()

    def test_taf_git_stage_excludes_shared_aggregates(self):
        workflow = (ROOT / ".github/workflows/taf-heartbeat.yml").read_text(encoding="utf-8")
        staging = next(line for line in workflow.splitlines() if "git add -- data/taf/neighbors.json" in line)
        for path in ("data/messages/latest.json", "data/messages/recent.json", "data/messages/status.json"):
            self.assertNotIn(path, staging)


if __name__ == "__main__":
    unittest.main()
