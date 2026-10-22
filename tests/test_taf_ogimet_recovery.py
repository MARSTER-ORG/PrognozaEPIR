"""Regression tests for recovery of authentic Ogimet TAF CSV reports."""
from __future__ import annotations

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import collect_neighbor_tafs_tiered as tiered


class OgimetTafRecoveryTests(unittest.TestCase):
    NOW = datetime(2026, 10, 22, 13, 30, tzinfo=timezone.utc)
    VALID = "TAF EPIR 221100Z 2212/2224 25012KT 8000 -RA SCT008 OVC014 BECMG 2216/2218 9999 BKN030="

    def test_bare_epir_telegram_is_accepted(self):
        csv_data = "ICAOIND,YEAR,MONTH,DAY,HOUR,MIN,REPORT\n" \
                   "EPIR,2026,10,22,11,00,EPIR 221100Z 2212/2224 25012KT CAVOK\n"
        result = tiered._parse_ogimet_epir_tafs(csv_data, self.NOW)
        self.assertEqual(result, [("EPIR", "TAF EPIR 221100Z 2212/2224 25012KT CAVOK=")])

    def test_full_taf_is_preserved(self):
        csv_data = "EPIR,2026,10,22,11,00," + self.VALID + "\n"
        self.assertEqual(tiered._parse_ogimet_epir_tafs(csv_data, self.NOW), [("EPIR", self.VALID)])

    def test_reject_stale_mismatched_and_nil_reports(self):
        csv_data = "\n".join([
            "EPIR,2026,10,21,17,00,TAF EPIR 211700Z 2118/2206 12006KT CAVOK",
            "EPIR,2026,10,22,11,15," + self.VALID,
            "EPIR,2026,10,22,11,00,TAF EPIR 221100Z 2212/2224 NIL",
            "EPBY,2026,10,22,11,00,TAF EPBY 221100Z 2212/2224 CAVOK",
        ]) + "\n"
        self.assertEqual(tiered._parse_ogimet_epir_tafs(csv_data, self.NOW), [])

    def test_deduplicate_same_issue_and_text(self):
        line = "EPIR,2026,10,22,11,00," + self.VALID + "\n"
        self.assertEqual(tiered._parse_ogimet_epir_tafs(line + line, self.NOW),
                         [("EPIR", self.VALID)])


if __name__ == "__main__":
    unittest.main()
