#!/usr/bin/env python3
"""Backfill model visibility skill from Open-Meteo Historical Forecast.

This is used for hours where PrognozaEPIR did not yet archive full local
forecast snapshots. The historical-forecast service contains archived
operational model output; observations remain EPIR METAR/SPECI / SYNOP 12342.
METAR 9999/CAVOK is treated as a lower bound of 10 km through the shared
model_verification.visibility_score() implementation.
"""
from __future__ import annotations

import json
import math
import urllib.parse
from datetime import timedelta

import model_verification as mv

API = "https://historical-forecast-api.open-meteo.com/v1/forecast"
MAX_DAYS = 14


def finite(v):
    return isinstance(v, (int, float)) and math.isfinite(v)


def historical_visibility(model_id: str, start_date: str, end_date: str):
    params = {
        "latitude": mv.LAT,
        "longitude": mv.LON,
        "hourly": "visibility",
        "models": model_id,
        "timezone": "UTC",
        "start_date": start_date,
        "end_date": end_date,
    }
    url = API + "?" + urllib.parse.urlencode(params)
    data = mv.get_json(url, timeout=40)
    hourly = data.get("hourly") or {}
    times = hourly.get("time") or []
    vis = hourly.get("visibility") or []
    out = {}
    for i, ts in enumerate(times):
        dt = mv.parse_dt(ts)
        value = vis[i] if i < len(vis) else None
        if dt and finite(value):
            out[mv.iso(dt.replace(minute=0, second=0, microsecond=0))] = float(value)
    return out


def observation_visibility(m, s):
    # Airport METAR/SPECI is preferred for operational visibility.
    if m and finite(m.get("visibility_m")):
        return float(m["visibility_m"]), bool(m.get("visibility_lower_bound"))
    if s and finite(s.get("visibility_m")):
        return float(s["visibility_m"]), bool(s.get("visibility_lower_bound"))
    return None, False


def recompute_overall(summary):
    for model, row in (summary.get("models") or {}).items():
        components = row.get("components") or {}
        total = 0.0
        weights = 0.0
        for comp, weight in mv.PARAM_WEIGHTS.items():
            score = (components.get(comp) or {}).get("score_pct")
            if finite(score):
                total += float(score) * weight
                weights += weight
        row["score_pct"] = round(total / weights) if weights else None


def main():
    if not mv.SUMMARY_PATH.exists():
        raise SystemExit("model-verification.json missing")

    summary = json.loads(mv.SUMMARY_PATH.read_text(encoding="utf-8"))
    metar_by_hour, synop_by_hour = mv.build_observation_maps()
    keys = sorted(set(metar_by_hour) | set(synop_by_hour))
    if not keys:
        print("visibility backfill: no observations")
        return

    now = mv.utcnow()
    valid_keys = []
    for key in keys:
        dt = mv.parse_dt(key)
        if dt and dt <= now:
            valid_keys.append((dt, key))
    if not valid_keys:
        print("visibility backfill: no completed observation hours")
        return

    end_dt = max(x[0] for x in valid_keys)
    start_dt = max(min(x[0] for x in valid_keys), end_dt - timedelta(days=MAX_DAYS))
    start_date = start_dt.date().isoformat()
    end_date = end_dt.date().isoformat()
    allowed = {key for dt, key in valid_keys if dt >= start_dt}

    model_predictions = {}
    details = {}

    for model_id, name, weight in mv.MODELS:
        try:
            pred = historical_visibility(model_id, start_date, end_date)
        except Exception as exc:
            print(f"visibility backfill {model_id}: {exc}")
            pred = {}
        model_predictions[model_id] = pred

        scores = []
        metar_n = synop_n = 0
        for key in allowed:
            value = pred.get(key)
            if not finite(value):
                continue
            m = metar_by_hour.get(key)
            s = synop_by_hour.get(key)
            obs, lower = observation_visibility(m, s)
            if not finite(obs):
                continue
            score = mv.visibility_score(value, obs, lower)
            if score is None or not finite(score):
                continue
            scores.append(float(score))
            if m and finite(m.get("visibility_m")):
                metar_n += 1
            elif s and finite(s.get("visibility_m")):
                synop_n += 1

        mean = sum(scores) / len(scores) if scores else None
        row = (summary.get("models") or {}).get(model_id)
        if row is not None:
            row.setdefault("components", {})["visibility"] = {
                "n": len(scores),
                "score_pct": round(mean) if mean is not None else None,
            }
        details[model_id] = {
            "n": len(scores),
            "score_pct": round(mean) if mean is not None else None,
            "metar_speci_n": metar_n,
            "synop_n": synop_n,
        }

    # Historical consensus: weighted visibility from whichever selected models
    # actually expose visibility for a given hour.
    consensus_scores = []
    consensus_metar = consensus_synop = 0
    for key in allowed:
        total = weights = 0.0
        for model_id, _name, weight in mv.MODELS:
            value = model_predictions.get(model_id, {}).get(key)
            if finite(value):
                total += float(value) * weight
                weights += weight
        if not weights:
            continue
        pred = total / weights
        m = metar_by_hour.get(key)
        s = synop_by_hour.get(key)
        obs, lower = observation_visibility(m, s)
        if not finite(obs):
            continue
        score = mv.visibility_score(pred, obs, lower)
        if score is None or not finite(score):
            continue
        consensus_scores.append(float(score))
        if m and finite(m.get("visibility_m")):
            consensus_metar += 1
        elif s and finite(s.get("visibility_m")):
            consensus_synop += 1

    mean = sum(consensus_scores) / len(consensus_scores) if consensus_scores else None
    consensus = (summary.get("models") or {}).get("consensus")
    if consensus is not None:
        consensus.setdefault("components", {})["visibility"] = {
            "n": len(consensus_scores),
            "score_pct": round(mean) if mean is not None else None,
        }
    details["consensus"] = {
        "n": len(consensus_scores),
        "score_pct": round(mean) if mean is not None else None,
        "metar_speci_n": consensus_metar,
        "synop_n": consensus_synop,
    }

    recompute_overall(summary)
    summary["generated_at"] = mv.iso(now)
    summary["visibility_verification"] = {
        "method": "Open-Meteo Historical Forecast archived operational model output vs corresponding-hour EPIR METAR/SPECI, SYNOP fallback",
        "period_start": start_date,
        "period_end": end_date,
        "metar_9999_cavok_rule": "observation is >=10000 m; model >=10000 m scores 100",
        "models": details,
    }
    mv.SUMMARY_PATH.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("visibility historical backfill:", json.dumps(details, ensure_ascii=False))


if __name__ == "__main__":
    main()
