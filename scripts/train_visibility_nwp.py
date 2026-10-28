#!/usr/bin/env python3
"""Censor-aware NWP VIS bias reference for the NEXT visibility branch.

This is fitted on *issued* LEGACY browser snapshots' NWP means, not on NEXT
predictions. It calibrates only the NWP reference used by NEXT above 5 km;
it does NOT claim to validate NEXT fog skill or alter FG/BR probabilities.
"""
from __future__ import annotations
import argparse
import datetime as dt
import json
import math
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UTC = dt.timezone.utc
HOUR = dt.timedelta(hours=1)
DAY = dt.timedelta(days=1)
WINDOW_DAYS = 14
MAX_OBS_DELTA_SECONDS = 35 * 60
LEAD_MIN_H = 1
LEAD_MAX_H = 24


def stamp(value):
    if not isinstance(value, str):
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)
    except (ValueError, TypeError):
        return None


def metar_observations(start, end):
    found = {}
    day = start.date()
    while day <= end.date():
        file = ROOT / "data/messages/metar" / day.strftime("%Y/%m/%d.jsonl")
        if file.is_file():
            for line in file.read_text(encoding="utf-8").splitlines():
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if str(row.get("station") or row.get("station_code") or "").upper() != "EPIR":
                    continue
                t = stamp(row.get("obs_time") or row.get("observed_at"))
                vis = row.get("visibility_m")
                if t is None or not start <= t <= end or not isinstance(vis, (int, float)) or vis <= 0:
                    continue
                lower = bool(row.get("visibility_lower_bound")) or str(row.get("visibility_report") or "").upper() in {"9999", "CAVOK"}
                prev = found.get(t)
                # In case of duplicate observations, prefer a corrected report.
                corrected = str(row.get("raw") or "").startswith("COR ")
                if prev is None or (corrected and not prev[2]):
                    found[t] = (float(vis), lower, corrected)
        day += DAY
    return sorted((t, v, lower) for t, (v, lower, _) in found.items())


def forecasts(start, end, observations):
    by_day = {}
    for t, vis, lower in observations:
        by_day.setdefault(t.date(), []).append((t, vis, lower))
    out = []
    day = start.date()
    while day <= end.date():
        file = ROOT / "data/learning/fog-legacy-forecasts" / day.strftime("%Y-%m-%d.jsonl")
        if file.is_file():
            for line in file.read_text(encoding="utf-8").splitlines():
                try:
                    snap = json.loads(line)
                except json.JSONDecodeError:
                    continue
                issued = stamp(snap.get("captured_at"))
                if issued is None or not start <= issued <= end:
                    continue
                for hour in snap.get("hours", []):
                    target = stamp(hour.get("valid_time"))
                    value = (hour.get("model_mean") or {}).get("visibility_m")
                    if target is None or not isinstance(value, (int, float)) or value <= 0:
                        continue
                    lead = (target - issued).total_seconds() / 3600
                    if not LEAD_MIN_H <= lead <= LEAD_MAX_H or target > end:
                        continue
                    pool = []
                    for offset in (-1, 0, 1):
                        pool.extend(by_day.get((target + offset * DAY).date(), []))
                    if not pool:
                        continue
                    obs_t, obs_vis, lower = min(pool, key=lambda row: abs((row[0] - target).total_seconds()))
                    if abs((obs_t - target).total_seconds()) > MAX_OBS_DELTA_SECONDS:
                        continue
                    # 9999/CAVOK is >=10 km; never train it as an exact 10-km error.
                    # If NWP is below that lower bound, the log-ratio is only a
                    # conservative lower bound on the needed upward correction.
                    if lower and value >= obs_vis:
                        continue
                    night = target.hour >= 18 or target.hour < 6
                    regime = "FG" if value < 1000 else "BR" if value <= 5000 else "CLEAR"
                    out.append({"issued": issued, "valid": target, "model_vis": value,
                                "obs_vis": obs_vis, "censored": lower,
                                "night": night, "regime": regime})
        day += DAY
    return out


def group(rows):
    ratios = sorted(math.log(r["obs_vis"] / r["model_vis"]) for r in rows)
    median_log = statistics.median(ratios) if ratios else None
    # A conservative, sample-size shrunk correction, never more than 25%.
    n = len(ratios)
    factor = math.exp(max(-0.60, min(0.60, median_log)) * min(0.45, n / (n + 100))) if n >= 40 else 1.0
    factor = max(0.75, min(1.20, factor))
    return {"n": n, "median_log_obs_over_model": round(median_log, 4) if median_log is not None else None,
            "factor": round(factor, 4) if n >= 40 else 1.0,
            "censored_lower_bounds": sum(r["censored"] for r in rows),
            "observed_fg": sum(r["obs_vis"] < 1000 for r in rows),
            "observed_br": sum(1000 <= r["obs_vis"] <= 5000 for r in rows)}


def build(as_of):
    end = as_of
    start = end - WINDOW_DAYS * DAY
    obs = metar_observations(start, end)
    pairs = forecasts(start, end, obs)
    groups = {"all": group(pairs)}
    for part, is_night in (("night", True), ("day", False)):
        for regime in ("FG", "BR", "CLEAR"):
            groups[part + "_" + regime.lower()] = group(
                [r for r in pairs if r["night"] == is_night and r["regime"] == regime])
    return {
        "schema": "prognozaepir-visibility-nwp-calibration-v1",
        "generated_at": end.isoformat().replace("+00:00", "Z"),
        "window_start": start.isoformat().replace("+00:00", "Z"),
        "window_end": end.isoformat().replace("+00:00", "Z"),
        "source": "legacy-issued-snapshots-nwp-mean-vs-epir-metar",
        "training_uses_observations_after_issue": False,
        "censoring": "9999/CAVOK treated as lower bounds, never as exact 10000",
        "min_lead_hours": LEAD_MIN_H,
        "max_lead_hours": LEAD_MAX_H,
        "max_match_minutes": 35,
        "observation_count": len(obs),
        "pairs": len(pairs),
        "groups": groups,
        "scope": "secondary NWP reference for NEXT VIS >=5000 m; no FG/BR/MIFG probability changes"
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--as-of", help="UTC timestamp, e.g. 2026-10-28T20:00:00Z")
    parser.add_argument("--output", default="data/learning/visibility-nwp-calibration.json")
    args = parser.parse_args()
    as_of = stamp(args.as_of) if args.as_of else dt.datetime.now(UTC)
    if as_of is None:
        parser.error("invalid --as-of")
    result = build(as_of)
    path = ROOT / args.output
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Visibility calibration: METAR", result["observation_count"], "paired", result["pairs"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
