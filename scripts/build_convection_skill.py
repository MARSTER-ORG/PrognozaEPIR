#!/usr/bin/env python3
"""Build empirical EPIR convection calibration from archived METAR + model history.

The training target intentionally distinguishes:
- explicit TCU in METAR cloud groups,
- explicit CB in METAR cloud groups,
- TS weather as a weaker "deep convection" label.

The resulting calibration is written into data/learning/cloud-skill.json["convection"].
No radar history is fabricated: reflectivity thresholds remain documented operational priors,
while the archive calibrates the environmental prior used by the live radar classifier.
"""
from __future__ import annotations

import bisect
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
METAR_ROOT = ROOT / "data" / "messages" / "metar"
FORECAST_ROOT = ROOT / "data" / "learning" / "model-forecasts"
SKILL_PATH = ROOT / "data" / "learning" / "cloud-skill.json"
MAX_MATCH_SECONDS = 45 * 60

CLOUD_CONV_RE = re.compile(r"\b(?:FEW|SCT|BKN|OVC)\d{3}(TCU|CB)\b")
TS_RE = re.compile(r"(?:^|\s)[+-]?(?:VC)?TS[A-Z]*(?=\s|=|$)")

def clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))

def number(v: Any) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None

def parse_time(value: Any) -> float | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None

def iter_jsonl(path: Path):
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue

def read_metar():
    rows = []
    explicit_tcu = explicit_cb = ts_count = 0
    for path in sorted(METAR_ROOT.glob("*/*/*.jsonl")):
        for obj in iter_jsonl(path):
            if str(obj.get("station", "")).upper() != "EPIR":
                continue
            t = parse_time(obj.get("obs_time") or obj.get("message_time"))
            if t is None:
                continue
            raw = str(obj.get("canonical_raw") or obj.get("raw") or "").upper()
            groups = CLOUD_CONV_RE.findall(raw)
            tcu = "TCU" in groups
            cb = "CB" in groups
            ts = bool(TS_RE.search(raw))
            explicit_tcu += int(tcu)
            explicit_cb += int(cb)
            ts_count += int(ts)
            rows.append({"time": t, "tcu": tcu, "cb": cb, "ts": ts, "raw": raw})
    rows.sort(key=lambda r: r["time"])
    return rows, {
        "metar_samples": len(rows),
        "explicit_tcu": explicit_tcu,
        "explicit_cb": explicit_cb,
        "ts": ts_count,
    }

def nearest_obs(obs, times, t):
    if not times:
        return None
    i = bisect.bisect_left(times, t)
    candidates = []
    if i < len(times):
        candidates.append(obs[i])
    if i:
        candidates.append(obs[i - 1])
    if not candidates:
        return None
    best = min(candidates, key=lambda r: abs(r["time"] - t))
    return best if abs(best["time"] - t) <= MAX_MATCH_SECONDS else None

def forecast_score(f: dict[str, Any]) -> float:
    """Archive-only environment proxy; deliberately does not pretend historical CAPE exists."""
    rh = number(f.get("relative_humidity_pct"))
    temp = number(f.get("temperature_c"))
    dew = number(f.get("dew_point_c"))
    precip = number(f.get("precipitation_mm"))
    gust = number(f.get("wind_gust_ms"))
    mid = number(f.get("mid_pct"))
    high = number(f.get("high_pct"))
    code = int(number(f.get("weather_code")) or 0)

    humid = clamp(((rh or 45.0) - 50.0) / 45.0)
    spread = (temp - dew) if temp is not None and dew is not None else 12.0
    moisture = clamp((10.0 - max(0.0, spread)) / 10.0)
    wet = clamp((precip or 0.0) / 3.0)
    gusty = clamp(((gust or 0.0) - 6.0) / 14.0)
    deep_cloud = clamp((((mid or 0.0) + (high or 0.0)) - 70.0) / 130.0)
    shower = 1.0 if code in (80, 81, 82) else 0.0
    thunder_code = 1.0 if code in (95, 96, 99) else 0.0

    score = (
        0.20 * humid + 0.17 * moisture + 0.22 * wet + 0.13 * gusty
        + 0.12 * deep_cloud + 0.10 * shower + 0.06 * thunder_code
    )
    if thunder_code:
        score = max(score, 0.88)
    return clamp(score)

def read_best_forecasts():
    """Deduplicate (model, valid_time), retaining the shortest lead forecast."""
    best = {}
    for path in sorted(FORECAST_ROOT.glob("*.jsonl")):
        for obj in iter_jsonl(path):
            valid = parse_time(obj.get("valid_time"))
            model = str(obj.get("model") or obj.get("name") or "")
            if valid is None or not model:
                continue
            lead = number(obj.get("lead_hours"))
            key = (model, int(valid))
            old = best.get(key)
            if old is None or (lead is not None and (number(old.get("lead_hours")) is None or lead < float(old["lead_hours"]))):
                best[key] = obj
    return list(best.values())

def smoothed_rate(events: float, weight: float, global_rate: float, strength: float = 10.0) -> float:
    if weight <= 0:
        return global_rate
    return (events + strength * global_rate) / (weight + strength)

def main():
    observations, obs_meta = read_metar()
    times = [r["time"] for r in observations]
    forecasts = read_best_forecasts()

    samples = []
    first_t = last_t = None
    for f in forecasts:
        valid = parse_time(f.get("valid_time"))
        if valid is None:
            continue
        o = nearest_obs(observations, times, valid)
        if o is None:
            continue
        weight = number(f.get("base_weight"))
        weight = clamp(weight if weight is not None else 0.1, 0.03, 0.30)
        score = forecast_score(f)
        samples.append({
            "score": score,
            "weight": weight,
            "tcu_or_cb": bool(o["tcu"] or o["cb"]),
            "cb": bool(o["cb"]),
            "deep": bool(o["cb"] or o["ts"]),
        })
        first_t = valid if first_t is None else min(first_t, valid)
        last_t = valid if last_t is None else max(last_t, valid)

    total_w = sum(s["weight"] for s in samples)
    def weighted_event_rate(key):
        return (sum(s["weight"] for s in samples if s[key]) / total_w) if total_w else 0.0

    global_tcu = weighted_event_rate("tcu_or_cb")
    global_cb = weighted_event_rate("cb")
    global_deep = weighted_event_rate("deep")

    edges = [0.0, 0.2, 0.4, 0.6, 0.8, 1.000001]
    bins = []
    for lo, hi in zip(edges, edges[1:]):
        bucket = [s for s in samples if lo <= s["score"] < hi]
        w = sum(s["weight"] for s in bucket)
        tcu_e = sum(s["weight"] for s in bucket if s["tcu_or_cb"])
        cb_e = sum(s["weight"] for s in bucket if s["cb"])
        deep_e = sum(s["weight"] for s in bucket if s["deep"])
        bins.append({
            "min": round(lo, 3),
            "max": 1.0 if hi > 1 else round(hi, 3),
            "n": len(bucket),
            "effective_weight": round(w, 3),
            "tcu_or_cb_rate": round(smoothed_rate(tcu_e, w, global_tcu), 5),
            "cb_rate": round(smoothed_rate(cb_e, w, global_cb), 5),
            "deep_rate": round(smoothed_rate(deep_e, w, global_deep), 5),
        })

    explicit_total = obs_meta["explicit_tcu"] + obs_meta["explicit_cb"]
    if explicit_total >= 10:
        quality = "explicit_metar"
    elif obs_meta["ts"] >= 10 or explicit_total:
        quality = "mixed_explicit_and_ts_proxy"
    else:
        quality = "sparse_labels"

    convection = {
        "schema": "prognozaepir-convection-skill-v1",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "station": "EPIR",
        "method": (
            "Nearest METAR within 45 min paired with deduplicated archived model forecasts; "
            "TCU/CB are explicit METAR cloud labels, TS is used only as a weaker deep-convection proxy. "
            "Historical model archive has no radar reflectivity, so dBZ thresholds remain operational priors."
        ),
        "training": {
            **obs_meta,
            "forecast_rows_deduplicated": len(forecasts),
            "matched_samples": len(samples),
            "effective_weight": round(total_w, 3),
            "from": datetime.fromtimestamp(first_t, timezone.utc).isoformat().replace("+00:00", "Z") if first_t else None,
            "to": datetime.fromtimestamp(last_t, timezone.utc).isoformat().replace("+00:00", "Z") if last_t else None,
            "label_quality": quality,
        },
        "reflectivity_priors_dbz": {
            "cu_signal": 20,
            "tcu_watch": 30,
            "tcu_likely": 35,
            "cb_likely": 40,
            "cb_strong": 50,
        },
        "calibration": {
            "environment_score_bins": bins,
            "global_tcu_or_cb_rate": round(global_tcu, 6),
            "global_cb_rate": round(global_cb, 6),
            "global_deep_rate": round(global_deep, 6),
            "minimum_explicit_labels_for_direct_use": 10,
        },
        "limitations": [
            "TCU can exist before a strong radar echo appears.",
            "CMAX reflectivity does not identify cloud type by itself.",
            "TS without an explicit CB cloud group is retained as a weak deep-convection label, not silently relabelled as CB.",
            "Radar/satellite/lightning verification should supersede this environment calibration as those archives grow."
        ],
    }

    skill = {}
    if SKILL_PATH.exists():
        with SKILL_PATH.open("r", encoding="utf-8") as f:
            skill = json.load(f)
    skill["convection"] = convection
    with SKILL_PATH.open("w", encoding="utf-8") as f:
        json.dump(skill, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(json.dumps({
        "matched_samples": len(samples),
        "explicit_tcu": obs_meta["explicit_tcu"],
        "explicit_cb": obs_meta["explicit_cb"],
        "ts": obs_meta["ts"],
        "label_quality": quality,
        "global_deep_rate": round(global_deep, 6),
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
