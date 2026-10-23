#!/usr/bin/env python3
"""Offline regression tests for archive-ingestion source recovery."""
from __future__ import annotations

import io
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import collect_neighbor_tafs as taf
import collect_neighbor_tafs_tiered as tiered
import metar_fast_check as fast
import neighbor_observations as neighbor


class ArchiveIngestRecoveryTests(unittest.TestCase):
    def test_strict_api_does_not_receive_undocumented_query(self):
        urls = []

        def fake_open(req, timeout):
            urls.append(req.full_url)
            return io.BytesIO(b"[]")

        with patch.object(taf.urllib.request, "urlopen", side_effect=fake_open):
            taf.fetch_text("https://aviationweather.gov/api/data/taf?ids=EPIR&format=json")
            taf.fetch_text("https://aviation-api.imgw.pl/data/last?params=taf&format=json")
        self.assertEqual(urls, [
            "https://aviationweather.gov/api/data/taf?ids=EPIR&format=json",
            "https://aviation-api.imgw.pl/data/last?params=taf&format=json",
        ])

    def test_raw_neighbor_reports_keep_actual_provider(self):
        now = datetime.now(timezone.utc)
        raw = f"SPECI EPBY {now:%d%H%M}Z 26005KT 5000 BR SCT030 12/11 Q1022="
        records = neighbor._extract(raw, "EPBY", "https://example.test/metar", "AWC METAR")
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["type"], "SPECI")
        self.assertEqual(records[0]["source"], "AWC METAR")
        self.assertEqual(records[0]["station"], "EPBY")
        self.assertEqual(records[0]["sources"][0]["name"], "AWC METAR")

    def test_official_imgw_payload_archives_neighbors_without_new_http_call(self):
        raw = "EPBY 151400Z 26005KT 9999 SCT030 12/08 Q1022="
        payload = {
            "EPBY": {"metars": [{"message": raw, "messageType": "SPECI"}]},
            "EPKS": {"metars": []},
            "EPPW": {"metars": []},
        }
        captured = []

        def record(station, page, source_url, source=None):
            captured.append((station, page, source_url, source))
            return {"decoded": 1, "added": 1}

        with patch.object(fast.neighbor, "capture_pilothub_page", side_effect=record):
            counts = fast.capture_imgw_neighbor_observations(payload)
        self.assertEqual(counts["EPBY"]["decoded"], 1)
        self.assertEqual(len(captured), 1)
        self.assertTrue(captured[0][1].startswith("SPECI EPBY"))
        self.assertEqual(captured[0][3], "IMGW Aviation API")

    def test_imgw_api_is_first_and_skips_blocked_pilothub_when_current(self):
        order = []
        missing = set(taf.STATIONS)

        def api(store, stations):
            self.assertEqual(stations, missing)
            order.append("IMGW")
            return set()

        with patch.object(tiered, "_collect_awc_neighbor_observations"), \
             patch.object(tiered, "_missing_current", return_value=missing), \
             patch.object(tiered, "_fallback_imgw_api", side_effect=api), \
             patch.object(tiered, "_collect_pilothub", side_effect=lambda store: order.append("PilotHub")):
            result = tiered.collect_candidates()
        self.assertEqual(order, ["IMGW"])
        self.assertEqual(dict(result), {})

    def test_additional_fallbacks_follow_imgw_failure(self):
        order = []
        missing = {"EPIR"}

        def imgw(store, stations):
            order.append("IMGW")
            return missing

        def pilot(store):
            order.append("PilotHub")

        def failover(source):
            def fake(store, stations):
                order.append(source)
                return missing if source != "Ogimet" else set()
            return fake

        with patch.object(tiered, "_collect_awc_neighbor_observations"), \
             patch.object(tiered, "_missing_current", return_value=missing), \
             patch.object(tiered, "_fallback_imgw_api", side_effect=imgw), \
             patch.object(tiered, "_collect_pilothub", side_effect=pilot), \
             patch.object(tiered, "_fallback_imgw_page", side_effect=failover("Awiacja")), \
             patch.object(tiered, "_fallback_awc", side_effect=failover("AWC")), \
             patch.object(tiered, "_fallback_ogimet_epir", side_effect=failover("Ogimet")):
            tiered.collect_candidates()
        self.assertEqual(order, ["IMGW", "PilotHub", "Awiacja", "AWC", "Ogimet"])

    def test_neighbour_awc_collection_runs_without_pilothub(self):
        sample = "METAR EPBY 151000Z 26005KT 9999 SCT030 12/08 Q1022="
        captured = []

        def capture(station, page, source_url, source=None):
            captured.append((station, source, page, source_url))
            return {"decoded": 1, "added": 1}

        with patch.object(tiered.legacy, "fetch_text", return_value=sample), patch.object(
            tiered.legacy.neighbor_obs, "capture_pilothub_page", side_effect=capture
        ):
            tiered._collect_awc_neighbor_observations()
        self.assertEqual({x[0] for x in captured}, {"EPBY", "EPPW", "EPKS"})
        self.assertTrue(all(x[1] == "AWC METAR" for x in captured))
        self.assertTrue(all("format=raw" in x[3] for x in captured))


if __name__ == "__main__":
    unittest.main()
