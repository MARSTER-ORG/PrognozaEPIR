#!/usr/bin/env python3
import importlib.util
import json
import sys
import unittest
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

spec = importlib.util.spec_from_file_location("sync_supabase_messages_to_git", SCRIPTS / "sync_supabase_messages_to_git.py")
mirror = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(mirror)


class MirrorTests(unittest.TestCase):
    def test_metar_becomes_canonical_archive_row(self):
        row = {
            "id": 32275,
            "message_type": "METAR",
            "station_code": "EPIR",
            "observed_at": "2025-01-01T00:00:00Z",
            "raw_text": "METAR EPIR 010000Z AUTO 21012KT 01/M02 Q1017 RMK 014 076 ///=",
            "source_ref": "STYCZEŃ/depesze meteo 01.01.2025.docx",
            "payload": {"source": "DOCX_ARCHIVE_2025"},
        }
        msg = mirror.canonical_from_row(row)
        self.assertIsNotNone(msg)
        self.assertEqual(msg["type"], "METAR")
        self.assertEqual(msg["station"], "EPIR")
        self.assertEqual(msg["message_time"], "2025-01-01T00:00:00Z")
        self.assertEqual(msg["canonical_raw"], "METAR EPIR 010000Z AUTO 21012KT 01/M02 Q1017 RMK 014 076 ///=")
        self.assertEqual(msg["pressure_hpa"], 1017)
        self.assertEqual(msg["temperature_c"], 1)
        self.assertEqual(msg["dew_point_c"], -2)
        self.assertEqual(msg["supabase_message_id"], 32275)
        self.assertEqual(msg["message_id"], mirror.archive.mid("METAR", "EPIR", msg["canonical_raw"]))
        self.assertTrue(any(s.get("file") == row["source_ref"] for s in msg["sources"]))

    def test_synop_preserves_synop_station(self):
        row = {
            "id": 40001,
            "message_type": "SYNOP",
            "station_code": "12342",
            "observed_at": "2025-01-01T00:00:00Z",
            "raw_text": "AAXX 01001 12342 469// /2106 10014 21024 30070 40180 5/012 555 6//76=",
            "source_ref": "STYCZEŃ/depesze meteo 01.01.2025.docx",
            "payload": {"source": "DOCX_ARCHIVE_2025"},
        }
        msg = mirror.canonical_from_row(row)
        self.assertIsNotNone(msg)
        self.assertEqual(msg["type"], "SYNOP")
        self.assertEqual(msg["station"], "12342")
        self.assertEqual(msg["message_time"], "2025-01-01T00:00:00Z")
        self.assertEqual(msg["message_id"], mirror.archive.mid("SYNOP", "12342", msg["canonical_raw"]))

    def test_taf_gets_canonical_validity(self):
        row = {
            "id": 50001,
            "message_type": "TAF",
            "station_code": "EPIR",
            "issued_at": "2025-01-02T05:00:00Z",
            "archive_time": "2025-01-02T05:00:00Z",
            "raw_text": "TAF EPIR 020500Z 0206/0218 27010KT 9999 BKN020=",
            "source_ref": "STYCZEŃ/depesze meteo 02.01.2025.docx",
            "payload": {"source": "DOCX_ARCHIVE_2025"},
        }
        msg = mirror.canonical_from_row(row)
        self.assertIsNotNone(msg)
        self.assertEqual(msg["type"], "TAF")
        self.assertEqual(msg["issue_time"], "2025-01-02T05:00:00Z")
        self.assertEqual(msg["valid_start"], "2025-01-02T06:00:00Z")
        self.assertEqual(msg["valid_end"], "2025-01-02T18:00:00Z")

    def test_parse_time_normalizes_utc(self):
        got = mirror.parse_time("2025-01-01 01:00:00+01:00")
        self.assertEqual(got, datetime(2025, 1, 1, 0, 0, tzinfo=timezone.utc))

    def test_message_archive_projection_is_accepted(self):
        row = {
            "message_id": "archive-id",
            "type": "SYNOP",
            "station": "12342",
            "message_time": "2025-01-01T00:00:00Z",
            "raw": "AAXX 01001 12342 469// /2106 10014 21024 30070 40180 5/012 555 6//76=",
            "source": "MESSAGE_ARCHIVE",
        }
        msg = mirror.canonical_from_row(row)
        self.assertIsNotNone(msg)
        self.assertEqual(msg["type"], "SYNOP")
        self.assertEqual(msg["station"], "12342")
        self.assertEqual(msg["supabase_message_id"], "archive-id")

    def test_fetch_type_uses_message_archive_edge_api(self):
        payload = {
            "ok": True,
            "rows": [{
                "message_id": "edge-row",
                "type": "METAR",
                "station": "EPIR",
                "message_time": "2025-01-01T00:00:00Z",
                "raw": "METAR EPIR 010000Z 21012KT CAVOK 01/M02 Q1017=",
            }],
            "count": 1,
        }
        captured = {}

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps(payload).encode("utf-8")

        def fake_urlopen(request, timeout):
            captured["request"] = request
            captured["timeout"] = timeout
            return Response()

        with mock.patch.object(mirror, "public_anon_key", return_value="anon-test-key"), mock.patch.object(
            mirror.urllib.request, "urlopen", side_effect=fake_urlopen
        ):
            rows = mirror.fetch_type(
                "METAR",
                datetime(2025, 1, 1, tzinfo=timezone.utc),
                datetime(2025, 1, 2, tzinfo=timezone.utc),
            )

        request = captured["request"]
        query = urllib.parse.parse_qs(urllib.parse.urlparse(request.full_url).query)
        self.assertTrue(request.full_url.startswith(mirror.ARCHIVE_URL + "?"))
        self.assertEqual(query["op"], ["search"])
        self.assertEqual(query["type"], ["METAR"])
        self.assertEqual(query["station"], ["EPIR"])
        self.assertEqual(request.get_header("Authorization"), "Bearer anon-test-key")
        self.assertEqual(rows, payload["rows"])


if __name__ == "__main__":
    unittest.main()
