#!/usr/bin/env python3
"""Event-aware forecast->truth verification for Fog Engine vNext.

Rules:
- only explicit forecast runs archived before valid time are evaluated;
- METAR/SPECI is primary truth, SYNOP only fallback/teacher;
- hours from one fog episode are never treated as independent events in the
  event-balanced metrics;
- FG/fog_truth, BR, MIFG, VIS thresholds, onset and dissipation are separate
  verification targets;
- ablations quantify the incremental skill of soil moisture, PBL and surface
  cooling;
- activation is blocked until both statistical gates and explicit promotion
  are satisfied.
"""
from __future__ import annotations

import json
import subprocess
from collections import defaultdict
from datetime import timedelta
from pathlib import Path

import model_verification as mv
import build_fog_event_learning_v2 as truth
import fog_vnext_model_archive as archive

OUT_DIR = mv.LEARNING / "fog-vnext-verification"
CASES_PATH = OUT_DIR / "cases.jsonl"
SUMMARY_PATH = OUT_DIR / "summary.json"
ACTIVATION_PATH = mv.LEARNING / "fog-vnext-activation.json"
PROMOTION_PATH = mv.LEARNING / "fog-vnext-promotion.json"
NODE_EVAL = Path(__file__).with_name("fog_vnext_eval.js")
LOW_ST_BASE_M = 300.0


def finite(v):
    return mv.finite(v)


def clamp(v, a=0.0, b=1.0):
    return max(a, min(b, v))


def weighted(rows, key):
    s = w = 0.0
    for r in rows:
        v = r.get(key)
        bw = r.get("base_weight")
        if finite(v) and finite(bw) and bw > 0:
            s += float(v) * float(bw)
            w += float(bw)
    return s / w if w else None


def load_full_rows():
    rows = []
    if archive.FULL_DIR.exists():
        for p in sorted(archive.FULL_DIR.glob("*.jsonl")):
            rows.extend(mv.load_jsonl(p))
    return rows


def row_time_map(rows):
    out = {}
    for r in rows:
        dt = mv.parse_dt(r.get("valid_time"))
        if dt:
            out[mv.iso(dt)] = r
    return out


def precip12(rows_by_time, valid):
    total = 0.0
    n = 0
    for h in range(12):
        r = rows_by_time.get(mv.iso(valid - timedelta(hours=h)))
        if r and finite(r.get("precipitation_mm")):
            total += max(0.0, float(r["precipitation_mm"]))
            n += 1
    return total if n else None


def consensus_hour(rows):
    return {
        "temperature_c": weighted(rows, "temperature_c"),
        "dew_point_c": weighted(rows, "dew_point_c"),
        "relative_humidity_pct": weighted(rows, "relative_humidity_pct"),
        "precipitation_mm": weighted(rows, "precipitation_mm"),
        "visibility_m": weighted(rows, "visibility_m"),
        "wind_speed_ms": weighted(rows, "wind_speed_ms"),
        "cloud_total_pct": weighted(rows, "cloud_total_pct"),
        "low_pct": weighted(rows, "low_pct"),
    }


def case_inputs(batch_rows):
    by_valid = defaultdict(list)
    for r in batch_rows:
        if r.get("valid_time"):
            by_valid[r["valid_time"]].append(r)
    consensus = {k: consensus_hour(v) for k, v in by_valid.items()}
    consensus_map = row_time_map([{"valid_time": k, **v} for k, v in consensus.items()])
    ecmwf_batch = {r.get("valid_time"): r for r in batch_rows if r.get("model") == "ecmwf_ifs"}
    icon_batch = {r.get("valid_time"): r for r in batch_rows if r.get("model") == "icon_d2"}
    out = []

    for valid_s, rows in sorted(by_valid.items()):
        valid = mv.parse_dt(valid_s)
        archive_time = mv.parse_dt(rows[0].get("archive_time") or rows[0].get("run_time"))
        if not valid or not archive_time or archive_time >= valid or valid > mv.utcnow():
            continue
        c = consensus.get(valid_s) or {}
        c1 = consensus_map.get(mv.iso(valid - timedelta(hours=1)))
        c3 = consensus_map.get(mv.iso(valid - timedelta(hours=3)))
        icon = next((r for r in rows if r.get("model") == "icon_d2"), None)
        ecmwf = next((r for r in rows if r.get("model") == "ecmwf_ifs"), None)
        dmi = next((r for r in rows if r.get("model") == "dmi_harmonie_arome_europe"), None)

        t, td = c.get("temperature_c"), c.get("dew_point_c")
        rh, ws = c.get("relative_humidity_pct"), c.get("wind_speed_ms")
        ts = (ecmwf or {}).get("surface_temperature_c")
        if not finite(ts):
            ts = (icon or {}).get("surface_temperature_c")
        ts1row = ecmwf_batch.get(mv.iso(valid - timedelta(hours=1))) or icon_batch.get(mv.iso(valid - timedelta(hours=1)))
        ts3row = ecmwf_batch.get(mv.iso(valid - timedelta(hours=3))) or icon_batch.get(mv.iso(valid - timedelta(hours=3)))
        ts1 = ts1row.get("surface_temperature_c") if ts1row else None
        ts3 = ts3row.get("surface_temperature_c") if ts3row else None

        sc = t - ts if finite(t) and finite(ts) else None
        sc1 = c1.get("temperature_c") - ts1 if c1 and finite(c1.get("temperature_c")) and finite(ts1) else None
        sc3 = c3.get("temperature_c") - ts3 if c3 and finite(c3.get("temperature_c")) and finite(ts3) else None

        pbl = (ecmwf or {}).get("boundary_layer_height_m")
        pbl1 = (ecmwf_batch.get(mv.iso(valid - timedelta(hours=1))) or {}).get("boundary_layer_height_m")
        pbl3 = (ecmwf_batch.get(mv.iso(valid - timedelta(hours=3))) or {}).get("boundary_layer_height_m")

        spread3 = None
        rh3 = None
        if c3 and finite(t) and finite(td) and finite(c3.get("temperature_c")) and finite(c3.get("dew_point_c")):
            spread3 = (t - td) - (c3["temperature_c"] - c3["dew_point_c"])
        if c3 and finite(rh) and finite(c3.get("relative_humidity_pct")):
            rh3 = rh - c3["relative_humidity_pct"]

        inv = None
        if dmi and finite(dmi.get("temperature_100m_c")) and finite(t):
            inv = dmi["temperature_100m_c"] - t

        base = {
            "t": t, "td": td, "rh": rh, "ws": ws,
            "visibility": c.get("visibility_m"),
            "soilIcon01": (icon or {}).get("soil_moisture_0_to_1cm"),
            "soilIcon13": (icon or {}).get("soil_moisture_1_to_3cm"),
            "soilEcmwf07": (ecmwf or {}).get("soil_moisture_0_to_7cm"),
            "precip12": precip12(consensus_map, valid),
            "pbl": pbl,
            "deltaPbl1": pbl - pbl1 if finite(pbl) and finite(pbl1) else None,
            "deltaPbl3": pbl - pbl3 if finite(pbl) and finite(pbl3) else None,
            "tsurface": ts,
            "deltaSurfaceCooling1": sc - sc1 if finite(sc) and finite(sc1) else None,
            "deltaSurfaceCooling3": sc - sc3 if finite(sc) and finite(sc3) else None,
            "deltaTsurface3": ts - ts3 if finite(ts) and finite(ts3) else None,
            "deltaSpread3": spread3,
            "deltaRh3": rh3,
            "inversion": inv,
            "isDay": (ecmwf or {}).get("is_day"),
            "shortwave": weighted(rows, "shortwave_radiation_wm2"),
            "cloudCover": c.get("cloud_total_pct"),
            "lowCloud": c.get("low_pct"),
            "cloud2m": (dmi or {}).get("cloud_cover_2m_pct"),
            "cbh": (dmi or {}).get("cloud_base_m"),
            "precip": c.get("precipitation_mm"),
        }
        out.append((valid_s, archive_time, rows, base))
    return out


def lowest_cloud_base(obs):
    vals = []
    for c in (obs or {}).get("clouds") or []:
        v = c.get("base_m_agl")
        if finite(v):
            vals.append(float(v))
    return min(vals) if vals else None


def obs_truth(valid_s, metar_by_hour, synop_by_hour):
    valid = mv.parse_dt(valid_s)
    if not valid:
        return None
    key = mv.iso(valid.replace(minute=0, second=0, microsecond=0))
    m = metar_by_hour.get(key)
    s = synop_by_hour.get(key)
    obs = m or s
    if not obs:
        return None
    cls = truth.classify(obs)
    vis = obs.get("visibility_m")
    known_vis = finite(vis)
    mifg = bool(cls["mifg"])
    fog = bool(cls["fog"])
    br_vis = known_vis and 1000 <= float(vis) <= 5000 and not fog and not mifg
    br = bool((cls["br"] or br_vis) and not fog and not mifg)
    cbh = lowest_cloud_base(obs)
    low_st = bool(not fog and finite(cbh) and cbh <= LOW_ST_BASE_M)
    fog_free = bool(known_vis and float(vis) > 5000 and not fog and not br and not mifg)
    true_clear = bool(fog_free and not low_st)
    if fog:
        state = "FG"
    elif mifg:
        state = "MIFG"
    elif br:
        state = "BR"
    elif low_st:
        state = "LOW_ST"
    elif true_clear:
        state = "CLEAR"
    else:
        state = "UNKNOWN"
    return {
        "source": "SPECI" if m and str(m.get("type") or "").upper() == "SPECI" else ("METAR" if m else "SYNOP"),
        "raw": obs.get("canonical_raw") or obs.get("raw"),
        "visibility_m": vis,
        "lowest_cloud_base_m": cbh,
        "state": state,
        "fog_truth": fog,
        "mifg_truth": mifg,
        "br_truth": br,
        "vis_lt_1000": bool(known_vis and float(vis) < 1000),
        "vis_lt_500": bool(known_vis and float(vis) < 500),
        "vis_lt_200": bool(known_vis and float(vis) < 200),
        "low_st_truth": low_st,
        "fog_free_truth": fog_free,
        "clear_truth": true_clear,
        "truth_known": bool(known_vis or fog or br or mifg),
    }


def build_truth_timeline(metar_by_hour, synop_by_hour):
    keys = sorted(set(metar_by_hour) | set(synop_by_hour))
    timeline = {}
    for k in keys:
        tr = obs_truth(k, metar_by_hour, synop_by_hour)
        if tr:
            timeline[k] = tr

    event_map = {}
    current_id = None
    current_last = None
    serial = 0
    for k in keys:
        dt = mv.parse_dt(k)
        tr = timeline.get(k)
        if not dt or not tr:
            continue
        obscured = tr["state"] in {"FG", "MIFG", "BR"}
        if obscured:
            if current_id is None or current_last is None or dt - current_last > timedelta(hours=2):
                serial += 1
                current_id = f"OBS-{dt:%Y%m%dT%HZ}-{serial:03d}"
            event_map[k] = current_id
            current_last = dt
        elif tr["state"] in {"CLEAR", "LOW_ST"}:
            current_id = None
            current_last = None
    return timeline, event_map


def attach_transition_truth(valid_s, tr, timeline, event_map):
    valid = mv.parse_dt(valid_s)
    if not valid:
        return tr
    next_key = mv.iso(valid + timedelta(hours=1))
    nxt = timeline.get(next_key)
    current_fog = bool(tr.get("fog_truth"))
    current_known = bool(tr.get("truth_known"))
    next_known = bool(nxt and nxt.get("truth_known"))
    tr = dict(tr)
    tr["event_id"] = event_map.get(valid_s) or (f"CONTROL-{valid:%Y%m%d}" if tr.get("state") in {"CLEAR", "LOW_ST"} else None)
    tr["onset_next_1h"] = bool(current_known and not current_fog and next_known and nxt.get("fog_truth"))
    tr["fog_exit_next_1h"] = bool(current_fog and next_known and not nxt.get("fog_truth"))
    tr["dissipation_next_1h"] = bool(current_fog and next_known and nxt.get("clear_truth"))
    tr["fog_to_low_st_next_1h"] = bool(current_fog and next_known and nxt.get("low_st_truth") and not nxt.get("fog_truth"))
    return tr


def evaluate_variants(inputs):
    variants = []
    for base in inputs:
        variants.extend([
            dict(base),
            {**base, "soilIcon01": None, "soilIcon13": None, "soilEcmwf07": None, "precip12": None},
            {**base, "pbl": None, "deltaPbl1": None, "deltaPbl3": None},
            {**base, "tsurface": None, "deltaSurfaceCooling1": None, "deltaSurfaceCooling3": None, "deltaTsurface3": None},
        ])
    proc = subprocess.run(["node", str(NODE_EVAL)], input=json.dumps(variants), text=True, capture_output=True, check=True)
    raw = json.loads(proc.stdout)
    return [raw[i:i + 4] for i in range(0, len(raw), 4)]


def auc(pairs):
    pos = [float(s) for s, y in pairs if y and finite(s)]
    neg = [float(s) for s, y in pairs if not y and finite(s)]
    if not pos or not neg:
        return None
    wins = ties = 0
    for p in pos:
        for n in neg:
            if p > n:
                wins += 1
            elif p == n:
                ties += 1
    return (wins + 0.5 * ties) / (len(pos) * len(neg))


def brier(pairs):
    vals = [(clamp(float(s)), 1.0 if y else 0.0) for s, y in pairs if finite(s)]
    if not vals:
        return None
    return sum((p - y) ** 2 for p, y in vals) / len(vals)


def binary_metrics(pairs):
    valid = [(float(s), bool(y)) for s, y in pairs if finite(s)]
    pos = sum(1 for _s, y in valid if y)
    neg = len(valid) - pos
    av = auc(valid)
    br = brier(valid)
    return {
        "n": len(valid),
        "positive": pos,
        "negative": neg,
        "auc": round(av, 4) if av is not None else None,
        "brier": round(br, 4) if br is not None else None,
        "mean_positive_score": round(sum(s for s, y in valid if y) / pos, 4) if pos else None,
        "mean_negative_score": round(sum(s for s, y in valid if not y) / neg, 4) if neg else None,
    }


def direct_visibility_risk(vis):
    if not finite(vis):
        return None
    return 1.0 - clamp((float(vis) - 700.0) / 9300.0)


def event_balanced_pairs(cases, score_getter, truth_key):
    grouped = defaultdict(list)
    for c in cases:
        event_id = c["truth"].get("event_id")
        if not event_id:
            continue
        grouped[(event_id, c.get("lead_bucket"))].append(c)
    out = []
    for rows in grouped.values():
        scores = [score_getter(c) for c in rows]
        scores = [s for s in scores if finite(s)]
        if not scores:
            continue
        y = any(bool(c["truth"].get(truth_key)) for c in rows)
        out.append((max(scores), y))
    return out


def target_metrics(cases, score_getter, truth_key):
    hourly = [(score_getter(c), c["truth"].get(truth_key)) for c in cases]
    event_pairs = event_balanced_pairs(cases, score_getter, truth_key)
    return {"hourly": binary_metrics(hourly), "event_balanced": binary_metrics(event_pairs)}


def per_lead_metrics(cases):
    out = {}
    for bucket in [x[2] for x in mv.LEAD_BUCKETS]:
        rows = [c for c in cases if c.get("lead_bucket") == bucket]
        out[bucket] = target_metrics(rows, lambda c: c["vnext"].get("physics_score", 0) / 100.0, "fog_truth")
    return out


def field_coverage(cases, key):
    if not cases:
        return 0.0
    return sum(1 for c in cases if finite(c["forecast"].get(key))) / len(cases)


def read_promotion():
    if not PROMOTION_PATH.exists():
        return {"approved": False, "reason": "promotion file missing"}
    try:
        data = json.loads(PROMOTION_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {"approved": False}
    except Exception:
        return {"approved": False, "reason": "promotion file invalid"}


def activation_gate(cases, metrics, ablation, lead_metrics):
    fog_event_ids = {c["truth"].get("event_id") for c in cases if c["truth"].get("fog_truth") and c["truth"].get("event_id")}
    onset_event_ids = {c["truth"].get("event_id") for c in cases if c["truth"].get("onset_next_1h") and c["truth"].get("event_id")}
    good_leads = 0
    for row in lead_metrics.values():
        m = row["event_balanced"]
        if m["positive"] >= 3 and m["negative"] >= 5:
            good_leads += 1

    full_auc = metrics["fog_truth"]["event_balanced"]["auc"]
    baseline_auc = metrics["direct_visibility_baseline"]["event_balanced"]["auc"]
    blockers = []
    if len(cases) < 300:
        blockers.append(f"cases {len(cases)}/300")
    fog_hours = metrics["fog_truth"]["hourly"]["positive"]
    if fog_hours < 30:
        blockers.append(f"fog-positive hours {fog_hours}/30")
    if len(fog_event_ids) < 8:
        blockers.append(f"independent fog events {len(fog_event_ids)}/8")
    if len(onset_event_ids) < 5:
        blockers.append(f"onset events {len(onset_event_ids)}/5")
    if good_leads < 3:
        blockers.append(f"lead buckets with positive+negative events {good_leads}/3")
    if full_auc is None or full_auc < 0.60:
        blockers.append(f"event-balanced fog AUC {full_auc} < 0.60")
    if full_auc is not None and baseline_auc is not None and full_auc + 0.02 < baseline_auc:
        blockers.append(f"vNext AUC {full_auc} trails direct-VIS baseline {baseline_auc}")

    for name, row in ablation.items():
        delta = row.get("delta_event_auc")
        if delta is not None and delta < -0.03:
            blockers.append(f"{name} degrades event AUC by {abs(delta):.3f}")

    coverage = {
        "soil": round(max(field_coverage(cases, "soil_moisture_icon_0_1"), field_coverage(cases, "soil_moisture_ecmwf_0_7")), 3),
        "pbl": round(field_coverage(cases, "pbl_m"), 3),
        "surface_temperature": round(field_coverage(cases, "surface_temperature_c"), 3),
    }
    for name, value in coverage.items():
        if value < 0.50:
            blockers.append(f"{name} coverage {value:.1%} < 50%")

    statistical_ready = not blockers
    promotion = read_promotion()
    approved = bool(promotion.get("approved"))
    operational_ready = bool(statistical_ready and approved)
    if statistical_ready and not approved:
        blockers.append("explicit promotion approval missing")

    return {
        "schema": "prognozaepir-fog-vnext-activation-v1",
        "generated_at": mv.iso(mv.utcnow()),
        "mode": "operational" if operational_ready else "shadow",
        "statistical_ready": statistical_ready,
        "operational_activation_ready": operational_ready,
        "promotion_approved": approved,
        "independent_fog_events": len(fog_event_ids),
        "independent_onset_events": len(onset_event_ids),
        "lead_buckets_ready": good_leads,
        "field_coverage": coverage,
        "blockers": blockers,
    }


def main():
    rows = load_full_rows()
    by_batch = defaultdict(list)
    for r in rows:
        if r.get("archive_time") and r.get("valid_time"):
            by_batch[r["archive_time"]].append(r)

    metar_by_hour, synop_by_hour = mv.build_observation_maps()
    timeline, event_map = build_truth_timeline(metar_by_hour, synop_by_hour)
    meta, inputs = [], []
    for batch_rows in by_batch.values():
        for valid_s, archive_time, source_rows, base in case_inputs(batch_rows):
            tr = obs_truth(valid_s, metar_by_hour, synop_by_hour)
            if not tr or not tr["truth_known"]:
                continue
            tr = attach_transition_truth(valid_s, tr, timeline, event_map)
            meta.append((valid_s, archive_time, source_rows, base, tr))
            inputs.append(base)

    evaluated = evaluate_variants(inputs) if inputs else []
    cases = []
    for (valid_s, archive_time, source_rows, base, tr), ev in zip(meta, evaluated):
        full, no_soil, no_pbl, no_sfc = ev
        valid = mv.parse_dt(valid_s)
        lead_h = (valid - archive_time).total_seconds() / 3600.0 if valid else None
        lead_bucket = mv.lead_bucket(lead_h) if finite(lead_h) else None
        case = {
            "schema": "prognozaepir-fog-vnext-verification-v2",
            "archive_time": mv.iso(archive_time),
            "valid_time": valid_s,
            "archive_lead_hours": round(lead_h, 2) if finite(lead_h) else None,
            "lead_bucket": lead_bucket,
            "models": sorted({r.get("model") for r in source_rows if r.get("model")}),
            "model_runs": {r.get("model"): r.get("model_run_time") for r in source_rows if r.get("model")},
            "forecast": {
                "temperature_c": base.get("t"), "dew_point_c": base.get("td"), "relative_humidity_pct": base.get("rh"),
                "visibility_m": base.get("visibility"), "low_cloud_pct": base.get("lowCloud"), "cloud_base_m": base.get("cbh"),
                "soil_moisture_icon_0_1": base.get("soilIcon01"), "soil_moisture_icon_1_3": base.get("soilIcon13"),
                "soil_moisture_ecmwf_0_7": base.get("soilEcmwf07"), "pbl_m": base.get("pbl"), "surface_temperature_c": base.get("tsurface"),
            },
            "vnext": full,
            "direct_visibility_baseline": direct_visibility_risk(base.get("visibility")),
            "ablation": {"no_soil": no_soil, "no_pbl": no_pbl, "no_surface_cooling": no_sfc},
            "truth": tr,
        }
        cases.append(case)

    def physics(c):
        v = c["vnext"].get("physics_score")
        return v / 100.0 if finite(v) else None

    def dissipation(c):
        v = c["vnext"].get("dissipation")
        return v / 100.0 if finite(v) else None

    def baseline(c):
        return c.get("direct_visibility_baseline")

    metrics = {
        "fog_truth": target_metrics(cases, physics, "fog_truth"),
        "vis_lt_1000": target_metrics(cases, physics, "vis_lt_1000"),
        "vis_lt_500": target_metrics(cases, physics, "vis_lt_500"),
        "vis_lt_200": target_metrics(cases, physics, "vis_lt_200"),
        "onset_next_1h": target_metrics(cases, physics, "onset_next_1h"),
        "dissipation_next_1h": target_metrics([c for c in cases if c["truth"].get("fog_truth")], dissipation, "dissipation_next_1h"),
        "direct_visibility_baseline": target_metrics(cases, baseline, "fog_truth"),
    }
    target_counts = {
        k: sum(1 for c in cases if c["truth"].get(k))
        for k in ("fog_truth", "br_truth", "mifg_truth", "vis_lt_1000", "vis_lt_500", "vis_lt_200", "onset_next_1h", "fog_exit_next_1h", "dissipation_next_1h", "fog_to_low_st_next_1h")
    }

    full_auc = metrics["fog_truth"]["event_balanced"]["auc"]
    ablation = {}
    for name, field in (("soil", "no_soil"), ("pbl", "no_pbl"), ("surface_cooling", "no_surface_cooling")):
        def getter(c, f=field):
            v = c["ablation"][f].get("physics_score")
            return v / 100.0 if finite(v) else None
        m = target_metrics(cases, getter, "fog_truth")
        a = m["event_balanced"]["auc"]
        ablation[name] = {
            "metrics": m,
            "delta_event_auc": round(full_auc - a, 4) if full_auc is not None and a is not None else None,
        }

    lead_metrics = per_lead_metrics(cases)
    activation = activation_gate(cases, metrics, ablation, lead_metrics)
    summary = {
        "schema": "prognozaepir-fog-vnext-verification-summary-v2",
        "generated_at": mv.iso(mv.utcnow()),
        "cases": len(cases),
        "batches": len(by_batch),
        "target_counts": target_counts,
        "metrics": metrics,
        "per_lead_fog_truth": lead_metrics,
        "ablation": ablation,
        "activation": activation,
        "method": "explicit forecast-run -> later METAR/SPECI truth; SYNOP fallback; event-balanced metrics prevent one long fog episode from dominating",
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    CASES_PATH.write_text("".join(json.dumps(c, ensure_ascii=False, separators=(",", ":")) + "\n" for c in cases), encoding="utf-8")
    SUMMARY_PATH.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    ACTIVATION_PATH.write_text(json.dumps(activation, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"cases": len(cases), "targets": target_counts, "activation": activation}, ensure_ascii=False))


if __name__ == "__main__":
    main()
