#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import build_fog_event_learning as fog  # noqa: E402


def check(obs, *, kind=None, fog_expected=None, br=None, visibility_fog=None):
    got = fog.classify(obs)
    if kind is not None:
        assert got["kind"] == kind, got
    if fog_expected is not None:
        assert got["fog"] is fog_expected, got
    if br is not None:
        assert got["br"] is br, got
    if visibility_fog is not None:
        assert got["visibility_fog"] is visibility_fog, got
    return got


# EPIR 14.09.2026: AUTO reports reached fog-range visibility without an FG token.
# The learning/verifier must not label these cases as NONE.
check(
    {
        "canonical_raw": "METAR EPIR 140130Z AUTO VRB02KT 0800 BKN075 OVC091 14/13 Q1018=",
        "visibility_m": 800,
        "temperature_c": 14,
        "dew_point_c": 13,
    },
    kind="FG",
    fog_expected=True,
    br=False,
    visibility_fog=True,
)
check(
    {
        "canonical_raw": "METAR EPIR 140200Z AUTO VRB01KT 0450 BKN077 BKN094 14/13 Q1018=",
        "visibility_m": 450,
        "temperature_c": 14,
        "dew_point_c": 13,
    },
    kind="FG",
    fog_expected=True,
    visibility_fog=True,
)

# Heavy precipitation can reduce visibility below 1 km without fog; do not infer FG
# from visibility alone in that case unless an explicit fog code is present.
check(
    {
        "canonical_raw": "METAR EPIR 140200Z AUTO 18008KT 0800 +RA BKN004 14/13 Q1018=",
        "visibility_m": 800,
    },
    kind="NONE",
    fog_expected=False,
    visibility_fog=False,
)

# Explicit codes keep precedence.
check(
    {"canonical_raw": "METAR EPIR 140300Z 00000KT 0600 FG OVC002 13/13 Q1018=", "visibility_m": 600},
    kind="FG",
    fog_expected=True,
)
check(
    {"canonical_raw": "METAR EPIR 140400Z 02002KT 2000 BR SCT004 13/13 Q1019=", "visibility_m": 2000},
    kind="BR",
    fog_expected=False,
    br=True,
)

print("fog event learning tests: OK")
