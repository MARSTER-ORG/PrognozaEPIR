#!/usr/bin/env python3
"""Regression: EPIR fog scoring may not use another airport's METAR."""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import model_verification as mv
import fog_legacy_archive as legacy


def metar(station, vis, raw, instant="2026-11-05T01:00:00Z", kind="METAR"):
    return {
        "station": station, "obs_time": instant, "raw": raw,
        "canonical_raw": f"{kind} {station} " + raw.split(" ", 1)[-1],
        "visibility_m": vis, "wind_direction_deg": 240,
        "wind_speed_ms": 1.0, "type": kind,
    }


def sample_archive():
    original = metar("EPIR", 400, "EPIR 050100Z 0400 FZFG")
    corrected = metar("EPIR", 400, "COR EPIR 050100Z 0400 FZFG")
    # Normalized canonical_raw intentionally lacks COR, as in the real archive.
    corrected["canonical_raw"] = "METAR EPIR 050100Z 0400 FZFG"
    other = metar("EPPW", 200, "EPPW 050100Z 0200 FZFG")
    bydgoszcz = metar("EPBY", 7000, "EPBY 050100Z 7000 NSC")
    bad_metadata = metar("EPIR", 100, "EPPW 050100Z 0100 FG")
    bad_metadata["canonical_raw"] = "METAR EPPW 050100Z 0100 FG"
    speci = metar("EPIR", 200, "EPIR 050641Z 0200 FZFG", "2026-11-05T06:41:00Z", "SPECI")
    synop = {
        "station": "12342", "obs_time": "2026-11-05T01:00:00Z",
        "raw": "AAXX 05011 12342 42460", "visibility_m": 500,
    }
    foreign_synop = {
        "station": "12343", "obs_time": "2026-11-05T01:00:00Z",
        "raw": "AAXX 05011 12343 42460", "visibility_m": 100,
    }
    # Worst-case archive ordering: wrong airports and original report first.
    return {
        mv.METAR_DIR: [other, original, bydgoszcz, bad_metadata, corrected],
        mv.SPECI_DIR: [speci],
        mv.SYNOP_DIR: [foreign_synop, synop],
    }


def test_station_identity_and_correction():
    assert mv.observation_station({"raw": "METAR EPIR 050100Z 0400 FZFG"}) == "EPIR"
    assert mv.observation_station({"raw": "SPECI COR EPIR 050641Z 0200 FZFG"}) == "EPIR"
    assert mv.observation_station({"raw": "AAXX 05011 12342 42460"}) == "12342"
    assert mv.observation_station({"station": "EPIR", "raw": "EPPW 050100Z 0200 FG"}) is None
    assert mv.observation_station({"station": "EPIR"}) == "EPIR"
    assert mv.observation_station({}) is None
    assert mv.is_corrected_report({"raw": "COR EPIR 050100Z 0400 FG", "canonical_raw": "METAR EPIR 050100Z 0400 FG"})


def test_both_verifiers_never_cross_airports():
    data = sample_archive()
    with patch.object(mv, "all_jsonl", side_effect=lambda path: list(data.get(path, []))):
        metars, synops = mv.build_observation_maps()
        stamp = "2026-11-05T01:00:00Z"
        assert metars[stamp]["station"] == "EPIR", metars[stamp]
        assert metars[stamp]["visibility_m"] == 400, metars[stamp]
        assert mv.is_corrected_report(metars[stamp]), metars[stamp]
        assert synops[stamp]["station"] == "12342", synops[stamp]

        observations = legacy.load_observations()
        at_01 = [o for o in observations if legacy.iso(o["_dt"]) == stamp]
        assert len(at_01) == 1, at_01
        assert at_01[0]["visibility_m"] == 400, at_01
        assert mv.is_corrected_report(at_01[0]), at_01
        assert all(mv.observation_station(o) == "EPIR" for o in observations)

        t = datetime(2026, 11, 5, 7, tzinfo=timezone.utc)
        nearest = legacy.nearest_observation(observations, [o["_dt"].timestamp() for o in observations], t)
        assert nearest is not None
        assert nearest["visibility_m"] == 200
        assert nearest["_source"] == "SPECI"


def test_real_november_archive_fixture():
    path = mv.METAR_DIR / "2026/11/05.jsonl"
    if not path.exists():
        return
    reports = mv.load_jsonl(path)
    relevant = [r for r in reports if r.get("obs_time") == "2026-11-05T01:00:00Z"]
    epir = [r for r in relevant if mv.observation_station(r) == "EPIR"]
    eppw = [r for r in relevant if mv.observation_station(r) == "EPPW"]
    # The same UTC timestamp is NOT sufficient to join these observations.
    assert epir and eppw
    assert all(r.get("visibility_m") == 400 for r in epir)
    assert any(r.get("visibility_m") == 200 for r in eppw)


def run():
    test_station_identity_and_correction()
    test_both_verifiers_never_cross_airports()
    test_real_november_archive_fixture()
    print("EPIR visibility truth isolation: OK")


if __name__ == "__main__":
    run()
