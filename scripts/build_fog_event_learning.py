#!/usr/bin/env python3
"""Build EPIR-specific fog/mist skill factors from archived forecasts and METAR/SPECI.

SPECI are retained as exact-minute event observations instead of being rounded
away. Multiple observations around one hourly model valid time are allowed but
their combined weight is capped, preventing a burst of convective SPECI from
dominating the calibration.
"""
from __future__ import annotations

import bisect
import json
import math
import re
from collections import defaultdict
from statistics import median

import model_verification as mv

OUT = mv.LEARNING / "fog-event-skill.json"
WINDOW_MIN = 35
SPECI_MULT = 1.7
POSITIVE_MULT = 3.0
CASE_WEIGHT_CAP = 2.8
HALF_LIFE_DAYS = 45.0
MIN_SAMPLES = 12
FULL_SAMPLES = 70
FACTOR_MIN = 0.82
FACTOR_MAX = 1.18
MIN_PEERS = 3

FOG_CODES = {"FG", "MIFG", "BCFG", "PRFG", "FZFG"}
MIST_CODES = {"BR"}
PRECIP_FRAGMENTS = ("RA", "DZ", "SN", "SG", "PL", "GR", "GS", "TS")


def clip(v, a=0.0, b=1.0):
    return max(a, min(b, v))


def recency_weight(valid, now):
    age_days = max(0.0, (now - valid).total_seconds() / 86400.0)
    return 0.5 ** (age_days / HALF_LIFE_DAYS)


def tokens(raw):
    return set(re.findall(r"[A-Z]{2,}", str(raw or "").upper()))


def classify(obs):
    raw = str(obs.get("canonical_raw") or obs.get("raw") or "").upper()
    tok = tokens(raw)
    fog_codes = sorted(tok & FOG_CODES)
    mist = bool(tok & MIST_CODES) or bool(obs.get("mist"))
    fog = bool(fog_codes) or bool(obs.get("fog")) or bool(obs.get("freezing_fog"))
    if "MIFG" in tok:
        kind = "MIFG"
    elif "FZFG" in tok:
        kind = "FZFG"
    elif "BCFG" in tok:
        kind = "BCFG"
    elif "PRFG" in tok:
        kind = "PRFG"
    elif fog:
        kind = "FG"
    elif mist:
        kind = "BR"
    else:
        kind = "NONE"
    precip = any(fragment in raw for fragment in PRECIP_FRAGMENTS)
    return {
        "kind": kind,
        "fog": fog,
        "br": mist and not fog,
        "obscuration": fog or mist,
        "precip": precip,
    }


def sat_signal(f):
    t, td, rh = f.get("temperature_c"), f.get("dew_point_c"), f.get("relative_humidity_pct")
    parts = []
    if mv.finite(t) and mv.finite(td):
        dd = max(-0.5, t - td)
        parts.append((clip((3.2 - dd) / 3.2), 0.65))
    if mv.finite(rh):
        parts.append((clip((rh - 84.0) / 16.0), 0.35))
    if not parts:
        return None
    sw = sum(w for _v, w in parts)
    return sum(v * w for v, w in parts) / sw


def vis_signal(vis):
    if not mv.finite(vis):
        return None
    if vis <= 500:
        return 1.0
    if vis <= 1000:
        return 0.92
    if vis <= 3000:
        return 0.92 - (vis - 1000.0) / 2000.0 * 0.47
    if vis <= 5000:
        return 0.45 - (vis - 3000.0) / 2000.0 * 0.25
    if vis <= 10000:
        return 0.20 - (vis - 5000.0) / 5000.0 * 0.20
    return 0.0


def model_probabilities(f):
    sat = sat_signal(f)
    vis = vis_signal(f.get("visibility_m"))
    low = clip(float(f["low_pct"]) / 100.0) if mv.finite(f.get("low_pct")) else None
    ws = f.get("wind_speed_ms")
    wind = clip((7.0 - float(ws)) / 6.0) if mv.finite(ws) else None
    precip = f.get("precipitation_mm")

    terms = [(sat, 0.39), (vis, 0.34), (low, 0.17), (wind, 0.10)]
    usable = [(v, w) for v, w in terms if mv.finite(v)]
    if not usable:
        return None
    p = sum(v * w for v, w in usable) / sum(w for _v, w in usable)

    # Convective/heavy precipitation can reduce visibility without fog. Keep
    # only a small penalty because DZ/RA may coexist with genuine fog.
    if mv.finite(precip) and precip >= 1.0:
        p *= 0.88
    elif mv.finite(precip) and precip >= 0.3:
        p *= 0.94

    p_any = clip(p)
    v = f.get("visibility_m")
    dense_vis = vis_signal(v)
    p_fog = clip(0.63 * p_any + 0.37 * (dense_vis or 0.0) - 0.12)

    # BR is most plausible in the intermediate restriction regime and should
    # not be called automatically just because RH is high.
    if mv.finite(v):
        br_vis = 1.0 if 1200 <= v <= 5000 else (0.55 if 500 < v < 7000 else 0.15)
    else:
        br_vis = 0.35
    p_br = clip(0.50 * p_any + 0.50 * br_vis - 0.16)
    return {"obscuration": p_any, "fog": p_fog, "br": p_br}


def loss(probs, cls):
    if not probs:
        return None
    y_any = 1.0 if cls["obscuration"] else 0.0
    y_fog = 1.0 if cls["fog"] else 0.0
    y_br = 1.0 if cls["br"] else 0.0
    return (
        0.50 * (probs["obscuration"] - y_any) ** 2
        + 0.32 * (probs["fog"] - y_fog) ** 2
        + 0.18 * (probs["br"] - y_br) ** 2
    )


def load_observations():
    rows = []
    seen = set()
    for source, directory in (("METAR", mv.METAR_DIR), ("SPECI", mv.SPECI_DIR)):
        for r in mv.all_jsonl(directory):
            dt = mv.parse_dt(r.get("obs_time") or r.get("message_time"))
            if not dt:
                continue
            raw = str(r.get("canonical_raw") or r.get("raw") or "")
            key = (mv.iso(dt), raw)
            if key in seen:
                continue
            seen.add(key)
            rr = dict(r)
            rr["_dt"] = dt
            rr["_source"] = "SPECI" if str(r.get("type") or r.get("report_type") or "").upper() == "SPECI" or source == "SPECI" else "METAR"
            rr["_class"] = classify(r)
            rows.append(rr)
    rows.sort(key=lambda r: r["_dt"])
    return rows


def confidence(n, effective_n):
    if n < MIN_SAMPLES or effective_n < 7:
        return 0.0
    x = clip((effective_n - 7.0) / (FULL_SAMPLES - 7.0))
    return x * x * (3.0 - 2.0 * x)


def factor_from_delta(delta, conf):
    # Lower Brier loss than peers is better, hence negative delta -> >1.
    raw = math.exp(-delta / 0.12)
    raw = max(FACTOR_MIN, min(FACTOR_MAX, raw))
    return 1.0 + (raw - 1.0) * conf


def weighted_mean(rows):
    sw = sum(w for _v, w in rows if w > 0)
    return sum(v * w for v, w in rows if w > 0) / sw if sw else None


def main():
    now = mv.utcnow()
    forecasts = mv.load_forecasts()
    observations = load_observations()
    obs_times = [r["_dt"].timestamp() for r in observations]

    cases = defaultdict(list)  # (run,valid,bucket,obs_time) -> [(model,loss,w,kind,source)]
    counts = defaultdict(lambda: defaultdict(int))

    for f in forecasts:
        model = f.get("model")
        if model not in mv.MODEL_META:
            continue
        valid = mv.parse_dt(f.get("valid_time"))
        run = mv.parse_dt(f.get("run_time"))
        if not valid or not run or valid > now or run >= valid:
            continue
        bucket = f.get("lead_bucket") or mv.lead_bucket((valid - run).total_seconds() / 3600.0)
        if not bucket:
            continue
        probs = model_probabilities(f)
        if not probs:
            continue

        center = valid.timestamp()
        span = WINDOW_MIN * 60
        lo = bisect.bisect_left(obs_times, center - span)
        hi = bisect.bisect_right(obs_times, center + span)
        nearby = observations[lo:hi]
        if not nearby:
            continue

        raw_weights = []
        for obs in nearby:
            cls = obs["_class"]
            l = loss(probs, cls)
            if l is None:
                continue
            time_factor = 1.0 - 0.35 * min(1.0, abs((obs["_dt"] - valid).total_seconds()) / span)
            event_factor = POSITIVE_MULT if cls["obscuration"] else 1.0
            source_factor = SPECI_MULT if obs["_source"] == "SPECI" else 1.0
            w = recency_weight(valid, now) * time_factor * event_factor * source_factor
            raw_weights.append((obs, l, w))

        total = sum(w for _o, _l, w in raw_weights)
        scale = min(1.0, CASE_WEIGHT_CAP / total) if total > 0 else 1.0
        for obs, l, w in raw_weights:
            w *= scale
            ckey = (f.get("run_time"), f.get("valid_time"), bucket, mv.iso(obs["_dt"]))
            cases[ckey].append((model, l, w, obs["_class"]["kind"], obs["_source"]))
            counts[(model, bucket)][obs["_class"]["kind"]] += 1
            counts[(model, bucket)][obs["_source"]] += 1

    rel = defaultdict(list)
    absolute = defaultdict(list)
    positive = defaultdict(int)
    speci_used = defaultdict(int)

    for (_run, _valid, bucket, _obs), rows in cases.items():
        best = {}
        for model, l, w, kind, source in rows:
            old = best.get(model)
            if old is None or w > old[1]:
                best[model] = (l, w, kind, source)
        if len(best) < MIN_PEERS:
            continue
        for model, (l, w, kind, source) in best.items():
            absolute[(model, bucket)].append((l, w))
            if kind != "NONE":
                positive[(model, bucket)] += 1
            if source == "SPECI":
                speci_used[(model, bucket)] += 1
            peers = [x[0] for m2, x in best.items() if m2 != model]
            if len(peers) >= 2:
                rel[(model, bucket)].append((l - median(peers), w))

    buckets = [b for _a, _z, b, _t in mv.LEAD_BUCKETS]
    out = {
        "schema": "prognozaepir-fog-event-skill-v1",
        "generated_at": mv.iso(now),
        "method": "METAR+exact-minute SPECI fog/mist event calibration; same-case peer Brier loss, recency weighting, positive-event emphasis, capped SPECI bursts and shrinkage",
        "codes": {"fog": sorted(FOG_CODES), "mist": sorted(MIST_CODES)},
        "window_minutes": WINDOW_MIN,
        "speci_multiplier": SPECI_MULT,
        "positive_event_multiplier": POSITIVE_MULT,
        "models": {},
        "observation_inventory": {
            "total": len(observations),
            "speci": sum(1 for r in observations if r["_source"] == "SPECI"),
            "fog": sum(1 for r in observations if r["_class"]["fog"]),
            "br": sum(1 for r in observations if r["_class"]["br"]),
            "mifg": sum(1 for r in observations if r["_class"]["kind"] == "MIFG"),
        },
    }

    for model, name, _base in mv.MODELS:
        mout = {"name": name, "lead_buckets": {}}
        for bucket in buckets:
            a = absolute[(model, bucket)]
            r = rel[(model, bucket)]
            mean_loss = weighted_mean(a)
            mean_delta = weighted_mean(r)
            eff = sum(w for _v, w in r)
            conf = confidence(len(r), eff)
            factor = factor_from_delta(mean_delta, conf) if mean_delta is not None else 1.0
            mout["lead_buckets"][bucket] = {
                "n": len(a),
                "effective_n": round(eff, 2),
                "positive_events": positive[(model, bucket)],
                "speci_samples": speci_used[(model, bucket)],
                "brier_loss": round(mean_loss, 4) if mean_loss is not None else None,
                "peer_delta_loss": round(mean_delta, 5) if mean_delta is not None else None,
                "confidence": round(conf, 3),
                "weight_factor": round(max(FACTOR_MIN, min(FACTOR_MAX, factor)), 4),
                "event_counts": dict(counts[(model, bucket)]),
            }
        out["models"][model] = mout

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("fog event learning:", json.dumps(out["observation_inventory"], ensure_ascii=False))
    print("fog factors:", json.dumps({m: {b: x["weight_factor"] for b, x in row["lead_buckets"].items()} for m, row in out["models"].items()}, ensure_ascii=False))


if __name__ == "__main__":
    main()
