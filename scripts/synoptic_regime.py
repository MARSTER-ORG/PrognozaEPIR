#!/usr/bin/env python3
"""Shared synoptic/seasonal context classification for PrognozaEPIR.

The labels are deliberately operational project regimes, not official WMO
front/high/low analyses. Historical learning must derive them only from fields
available in the archived operational forecast run being verified.
"""
from __future__ import annotations

import math
from datetime import datetime
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Warsaw")
VERSION = "epir-synoptic-regime-v1"
LEVELS = (925, 850, 700, 500)
DIMENSION_WEIGHTS = {
    "season": 0.25,
    "daypart": 0.10,
    "inflow_850": 0.25,
    "stability_925": 0.20,
    "moisture_low": 0.15,
    "pressure_regime": 0.05,
}


def finite(v):
    return isinstance(v, (int, float)) and math.isfinite(v)


def season(dt: datetime) -> str:
    m = dt.month
    if m in (12, 1, 2):
        return "winter"
    if m in (3, 4, 5):
        return "spring"
    if m in (6, 7, 8):
        return "summer"
    return "autumn"


def daypart(dt: datetime) -> str:
    h = dt.astimezone(TZ).hour
    if h < 6:
        return "night"
    if h < 12:
        return "morning"
    if h < 18:
        return "afternoon"
    return "evening"


def direction_sector(deg):
    if not finite(deg):
        return None
    labels = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")
    return labels[int(((float(deg) % 360.0) + 22.5) // 45.0) % 8]


def pressure_regime(hpa):
    if not finite(hpa):
        return None
    if hpa >= 1022.0:
        return "high_pressure_environment"
    if hpa <= 1005.0:
        return "low_pressure_environment"
    return "intermediate_pressure"


def moisture_regime(rh925, rh850):
    vals = [float(v) for v in (rh925, rh850) if finite(v)]
    if not vals:
        return None
    mean = sum(vals) / len(vals)
    if mean >= 85.0:
        return "very_moist_lower_troposphere"
    if mean >= 70.0:
        return "moist_lower_troposphere"
    if mean >= 50.0:
        return "moderate_lower_troposphere"
    return "dry_lower_troposphere"


def stability_regime(t2m, t925, z925=None, terrain_m=90.0):
    if not finite(t2m) or not finite(t925):
        return None
    if finite(z925) and finite(terrain_m) and z925 > terrain_m + 150.0:
        lapse_k_km = (float(t2m) - float(t925)) / (float(z925) - float(terrain_m)) * 1000.0
        if lapse_k_km < 0.0:
            return "inversion"
        if lapse_k_km < 4.0:
            return "stable"
        if lapse_k_km <= 8.0:
            return "mixed_neutral"
        return "unstable"
    delta = float(t925) - float(t2m)
    if delta >= 0.0:
        return "inversion"
    if delta >= -3.0:
        return "stable"
    if delta >= -7.0:
        return "mixed_neutral"
    return "unstable"


def classify(valid: datetime, fields: dict, terrain_m=90.0) -> dict:
    return {
        "version": VERSION,
        "season": season(valid),
        "daypart": daypart(valid),
        "inflow_850": direction_sector(fields.get("wind_direction_850hpa_deg")),
        "stability_925": stability_regime(
            fields.get("temperature_c"),
            fields.get("temperature_925hpa_c"),
            fields.get("geopotential_height_925hpa_m"),
            terrain_m,
        ),
        "moisture_low": moisture_regime(
            fields.get("relative_humidity_925hpa_pct"),
            fields.get("relative_humidity_850hpa_pct"),
        ),
        "pressure_regime": pressure_regime(fields.get("pressure_hpa")),
    }


def weighted_mean(rows, key):
    num = den = 0.0
    for row in rows:
        v = row.get(key)
        w = row.get("base_weight")
        if finite(v) and finite(w) and w > 0:
            num += float(v) * float(w)
            den += float(w)
    return num / den if den else None


def weighted_direction(rows, key):
    sx = cy = den = 0.0
    for row in rows:
        d = row.get(key)
        w = row.get("base_weight")
        if not finite(d) or not finite(w) or w <= 0:
            continue
        rad = math.radians(float(d))
        sx += math.sin(rad) * float(w)
        cy += math.cos(rad) * float(w)
        den += float(w)
    if not den or math.hypot(sx, cy) < 1e-9:
        return None
    return (math.degrees(math.atan2(sx / den, cy / den)) + 360.0) % 360.0


def consensus_fields(rows):
    keys = (
        "temperature_c", "pressure_hpa",
        "temperature_925hpa_c", "relative_humidity_925hpa_pct", "geopotential_height_925hpa_m",
        "temperature_850hpa_c", "relative_humidity_850hpa_pct", "geopotential_height_850hpa_m",
        "temperature_700hpa_c", "relative_humidity_700hpa_pct", "geopotential_height_700hpa_m",
        "temperature_500hpa_c", "relative_humidity_500hpa_pct", "geopotential_height_500hpa_m",
    )
    out = {k: weighted_mean(rows, k) for k in keys}
    for p in LEVELS:
        out[f"wind_speed_{p}hpa_ms"] = weighted_mean(rows, f"wind_speed_{p}hpa_ms")
        out[f"wind_direction_{p}hpa_deg"] = weighted_direction(rows, f"wind_direction_{p}hpa_deg")
    return out
