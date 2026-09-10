#!/usr/bin/env python3
from __future__ import annotations

import math
import unittest

import consensus_wind_bias as cwb


class ConsensusWindBiasTests(unittest.TestCase):
    def test_signed_direction_wraparound(self):
        self.assertAlmostEqual(cwb.signed_circular_error_deg(5.0, 355.0), 10.0)
        self.assertAlmostEqual(cwb.signed_circular_error_deg(355.0, 5.0), -10.0)

    def test_circular_bias_uses_signed_shortest_errors(self):
        self.assertAlmostEqual(cwb.circular_bias_deg([10.0, -10.0]), 0.0, places=9)
        self.assertAlmostEqual(cwb.circular_bias_deg([20.0, 20.0, -10.0]), 10.1, places=1)

    def test_speed_reference_keeps_synop_priority(self):
        m = {"wind_speed_ms": 3.0}
        s = {"wind_speed_ms": 5.0}
        ref = cwb.wind_reference(m, s)
        self.assertEqual(ref["speed_obs_ms"], 5.0)
        self.assertEqual(ref["speed_source"], "SYNOP")

    def test_direction_reference_prefers_regular_metar_reference(self):
        m = {
            "wind_direction_reference_deg": 270.0,
            "wind_direction_reference_speed_ms": 4.0,
            "wind_direction_reference_source": "METAR_SINGLE",
            "wind_direction_deg": 250.0,
            "wind_speed_ms": 4.0,
        }
        s = {"wind_direction_deg": 230.0, "wind_speed_ms": 6.0}
        ref = cwb.wind_reference(m, s)
        self.assertEqual(ref["direction_obs_deg"], 270.0)
        self.assertEqual(ref["direction_source"], "METAR_SINGLE")
        self.assertTrue(ref["direction_reliable"])

    def test_weak_single_metar_direction_is_excluded(self):
        m = {
            "wind_direction_reference_deg": 90.0,
            "wind_direction_reference_speed_ms": 1.0,
            "wind_direction_reference_source": "METAR_SINGLE",
        }
        ref = cwb.wind_reference(m, None)
        self.assertFalse(ref["direction_reliable"])

    def test_three_metar_circular_mean_remains_reliable_in_weak_wind(self):
        m = {
            "wind_direction_reference_deg": 2.0,
            "wind_direction_reference_speed_ms": 1.0,
            "wind_direction_reference_source": "METAR_3_CIRCULAR_MEAN",
        }
        ref = cwb.wind_reference(m, None)
        self.assertTrue(ref["direction_reliable"])

    def test_summary_reports_bias_and_mae(self):
        acc = cwb._new_accumulator()
        acc["speed_errors"].extend([1.0, -0.5, 1.5])
        acc["direction_errors"].extend([10.0, -5.0, 15.0])
        out = cwb._summary(acc)
        self.assertEqual(out["wind_speed"]["n"], 3)
        self.assertAlmostEqual(out["wind_speed"]["bias_ms"], 0.667, places=3)
        self.assertAlmostEqual(out["wind_speed"]["mae_ms"], 1.0, places=3)
        self.assertEqual(out["wind_direction"]["n"], 3)
        self.assertTrue(math.isfinite(out["wind_direction"]["circular_bias_deg"]))
        self.assertAlmostEqual(out["wind_direction"]["circular_mae_deg"], 10.0, places=2)


if __name__ == "__main__":
    unittest.main()
