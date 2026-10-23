"""Regression: published military TAF acquisition, NIL and durable EPKS/EPPW history."""
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import collect_neighbor_tafs_tiered as taf  # noqa: E402
import finalize_central_message_architecture_v2 as finalizer  # noqa: E402


class MilitaryTafArchiveTests(unittest.TestCase):
    def test_ogimet_station_and_timestamp_verified(self):
        now = datetime(2026, 10, 23, 19, 5, tzinfo=timezone.utc)
        report = "TAF EPPW 231700Z 2318/2406 33010KT 9999 BKN040="
        csv = "ICAO,YEAR,MONTH,DAY,HOUR,MIN,REPORT\n" + "EPPW,2026,10,23,17,00," + report + "\n"
        self.assertEqual(taf._parse_ogimet_tafs(csv, "EPPW", now), [("EPPW", report)])
        self.assertEqual(taf._parse_ogimet_tafs(csv, "EPKS", now), [])
        self.assertEqual(taf._parse_ogimet_tafs(csv.replace(",17,00,", ",11,00,"), "EPPW", now), [])

    def test_nil_is_never_archived_as_forecast(self):
        now = datetime(2026, 10, 23, 19, 5, tzinfo=timezone.utc)
        csv = "EPPW,2026,10,23,17,00,TAF EPPW 231700Z NIL=\n"
        self.assertEqual(taf._parse_ogimet_tafs(csv, "EPPW", now), [])
        store = {}
        taf._add_rows(store, [("EPPW", "TAF EPPW 231700Z NIL=")], "OGIMET", "example")
        self.assertEqual(store, {})

    def test_archive_eppw_once_with_validity(self):
        current = datetime.now(timezone.utc) - timedelta(minutes=10)
        end = current + timedelta(hours=6)
        issue = current.strftime("%d%H%M")
        validity = current.strftime("%d%H") + "/" + end.strftime("%d%H")
        raw = f"TAF EPPW {issue}Z {validity} 25008KT CAVOK="
        snap = {"stations": {"EPPW": finalizer.snapshot_record("EPPW", {
            "raw": raw, "source": "OGIMET", "updated_at": current.isoformat()
        })}}
        with tempfile.TemporaryDirectory() as tmp, patch.object(finalizer, "TAF_HISTORY", Path(tmp)):
            self.assertEqual(finalizer.archive_published_neighbor_tafs(snap), 1)
            self.assertEqual(finalizer.archive_published_neighbor_tafs(snap), 0)
            path = Path(tmp) / current.strftime("%Y/%m/%d.jsonl")
            rows = finalizer.read_jsonl(path)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["station"], "EPPW")
            self.assertFalse(rows[0]["snapshot_only"])
            self.assertTrue(rows[0]["valid_end"])

    def test_stale_neighbor_snapshot_is_not_backfilled(self):
        old = datetime.now(timezone.utc) - timedelta(days=5)
        raw = f"TAF EPKS {old:%d%H%M}Z {old:%d%H}/{(old + timedelta(hours=6)):%d%H} 16007KT CAVOK="
        snap = {"stations": {"EPKS": finalizer.snapshot_record("EPKS", {
            "raw": raw, "source": "PilotHub", "updated_at": old.isoformat()
        })}}
        with tempfile.TemporaryDirectory() as tmp, patch.object(finalizer, "TAF_HISTORY", Path(tmp)):
            self.assertEqual(finalizer.archive_published_neighbor_tafs(snap), 0)


if __name__ == "__main__":
    unittest.main()
