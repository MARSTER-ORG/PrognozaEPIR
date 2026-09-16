#!/usr/bin/env python3
"""Install an indexed METAR wind-reference lookup for long history scans.

The meteorological selection policy remains in model_verification.py. This
module only limits each call to the already-sorted +/-31 minute time slice,
then delegates to the original implementation. It is used by offline Fog
learning/verification jobs where materialized 2020-2026 METAR makes a full
series scan per verification hour unnecessarily quadratic.
"""
from __future__ import annotations

from bisect import bisect_left, bisect_right


def install(mv):
    current = mv.metar_wind_reference
    if getattr(current, "_prognozaepir_indexed", False):
        return current

    original = current
    cache = {}

    def indexed(target_dt, regular_wind_points):
        if not target_dt or not regular_wind_points:
            return original(target_dt, regular_wind_points)

        key = id(regular_wind_points)
        cached = cache.get(key)
        if cached is None or cached[0] is not regular_wind_points:
            seconds = [dt.timestamp() for dt, _row in regular_wind_points]
            cached = (regular_wind_points, seconds)
            cache[key] = cached
        seconds = cached[1]

        center = target_dt.timestamp()
        half = float(mv.WIND_REFERENCE_HALF_WINDOW_SECONDS)
        lo = bisect_left(seconds, center - half)
        hi = bisect_right(seconds, center + half)
        return original(target_dt, regular_wind_points[lo:hi])

    indexed._prognozaepir_indexed = True
    indexed._prognozaepir_original = original
    mv.metar_wind_reference = indexed
    return indexed
