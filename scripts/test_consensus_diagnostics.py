#!/usr/bin/env python3
from __future__ import annotations

import unittest

import consensus_diagnostics as cd


class ConsensusDiagnosticsTests(unittest.TestCase):
    def test_relative_humidity_from_temperature_and_dewpoint(self):
        rh = cd.relative_humidity_from_temp_dewpoint(20.0, 10.0)
        self.assertIsNotNone(rh)
        self.assertAlmostEqual(rh, 52.5, delta=0.5)

    def test_signed_range_error(self):
        self.assertEqual(cd.signed_range_error(4, (3, 4)), 0.0)
        self.assertEqual(cd.signed_range_error(2, (3, 4)), -1.0)
        self.assertEqual(cd.signed_range_error(6, (3, 4)), 2.0)

    def test_continuous_summary_reports_bias_mae_rmse(self):
        out = cd._continuous_summary([1.0, -1.0, 2.0])
        self.assertEqual(out["n"], 3)
        self.assertAlmostEqual(out["bias"], 0.667, places=3)
        self.assertAlmostEqual(out["mae"], 1.333, places=3)
        self.assertAlmostEqual(out["rmse"], 1.414, places=3)

    def test_event_summary(self):
        counts = {"hit": 3, "miss": 1, "false_alarm": 2, "correct_negative": 4}
        out = cd._event_summary(counts)
        self.assertEqual(out["n"], 10)
        self.assertEqual(out["pod_pct"], 75.0)
        self.assertEqual(out["far_pct"], 40.0)
        self.assertEqual(out["csi_pct"], 50.0)
        self.assertEqual(out["accuracy_pct"], 70.0)

    def test_visibility_lower_bound_is_not_exact_bias(self):
        acc = cd._new_accumulator()
        forecast = {
            "temperature_c": None,
            "dew_point_c": None,
            "pressure_hpa": None,
            "relative_humidity_pct": None,
            "wind_gust_ms": None,
            "visibility_m": 8000.0,
            "precipitation_mm": 0.0,
        }
        m = {
            "visibility_m": 10000.0,
            "visibility_lower_bound": True,
            "raw": "METAR EPIR 101200Z 24010KT 9999 NSC 18/08 Q1016=",
            "clouds": [],
        }
        cd._consume(acc, forecast, [], m, None)
        self.assertEqual(len(acc["continuous"].get("visibility_exact", [])), 0)
        self.assertEqual(acc["visibility_censored"]["n"], 1)
        self.assertEqual(acc["visibility_censored"]["underforecast_n"], 1)
        self.assertEqual(acc["visibility_censored"]["deficits_m"], [2000.0])

    def test_sub_10km_visibility_is_tracked_separately(self):
        acc = cd._new_accumulator()
        forecast = {
            "temperature_c": None,
            "dew_point_c": None,
            "pressure_hpa": None,
            "relative_humidity_pct": None,
            "wind_gust_ms": None,
            "visibility_m": 5000.0,
            "precipitation_mm": 0.0,
        }
        m = {
            "visibility_m": 4000.0,
            "visibility_lower_bound": False,
            "raw": "METAR EPIR 101200Z 24010KT 4000 BR SCT010 08/07 Q1016=",
            "clouds": [],
        }
        cd._consume(acc, forecast, [], m, None)
        self.assertEqual(acc["continuous"]["visibility_exact"], [1000.0])
        self.assertEqual(acc["continuous"]["visibility_sub_10km"], [1000.0])

    def test_weighted_weather_event_uses_model_votes(self):
        rows = [
            {"weather_code": 45, "base_weight": 0.6},
            {"weather_code": 3, "base_weight": 0.4},
        ]
        predicted, probability = cd.weighted_weather_event(rows, cd.FOG_CODES)
        self.assertTrue(predicted)
        self.assertAlmostEqual(probability, 0.6)

    def test_mifg_is_fog_but_br_is_not(self):
        fog, source, mifg = cd.fog_observation({"raw": "METAR EPIR 100500Z 00000KT 0800 MIFG NSC 05/05 Q1020="}, None)
        self.assertTrue(fog)
        self.assertTrue(mifg)
        self.assertEqual(source, "METAR")

        fog, _, mifg = cd.fog_observation({"raw": "METAR EPIR 100500Z 00000KT 5000 BR NSC 05/05 Q1020="}, None)
        self.assertFalse(fog)
        self.assertFalse(mifg)

    def test_synop_can_establish_event_when_metar_has_no_event_code(self):
        m = {"raw": "METAR EPIR 101200Z 22008KT 9999 SCT020 18/10 Q1012="}
        s_fog = {"present_weather_code": 45}
        fog, source, _ = cd.fog_observation(m, s_fog)
        self.assertTrue(fog)
        self.assertEqual(source, "SYNOP")

        s_ts = {"present_weather_code": 95}
        ts, source = cd.thunderstorm_observation(m, s_ts)
        self.assertTrue(ts)
        self.assertEqual(source, "SYNOP")

    def test_event_sources_count_only_samples_with_prediction_and_observation(self):
        acc = cd._new_accumulator()
        forecast = {
            "temperature_c": None,
            "dew_point_c": None,
            "pressure_hpa": None,
            "relative_humidity_pct": None,
            "wind_gust_ms": None,
            "visibility_m": None,
            "precipitation_mm": None,
        }
        m = {"raw": "METAR EPIR 101200Z 22008KT 9999 NSC 18/10 Q1012=", "clouds": []}
        cd._consume(acc, forecast, [], m, None)
        self.assertEqual(sum(acc["event_sources"]["precipitation"].values()), 0)
        self.assertEqual(sum(acc["event_sources"]["fog"].values()), 0)
        self.assertEqual(sum(acc["event_sources"]["thunderstorm"].values()), 0)

    def test_thunderstorm_observation(self):
        ts, source = cd.thunderstorm_observation({"raw": "METAR EPIR 101400Z 22012KT 5000 TSRA BKN020CB 20/17 Q1008="}, None)
        self.assertTrue(ts)
        self.assertEqual(source, "METAR")

        ts, _ = cd.thunderstorm_observation({"raw": "METAR EPIR 101400Z 22012KT 9999 VCTS SCT030CB 20/17 Q1008="}, None)
        self.assertFalse(ts)


if __name__ == "__main__":
    unittest.main()
