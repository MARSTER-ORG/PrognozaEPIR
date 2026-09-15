#!/usr/bin/env python3
"""Build forecast->truth verification cases for Fog Engine vNext.

Only forecasts archived before their valid time are used. Physical inputs from
one archive batch are fused similarly to the browser layer: ICON-D2 supplies
shallow soil moisture, ECMWF supplies PBL and secondary soil moisture, while
DMI/KNMI and the other available rows contribute atmospheric state. The script
runs the canonical JS physics module through Node and calculates simple AUC
ablations for soil moisture, PBL and surface cooling.
"""
from __future__ import annotations

import json
import math
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
NODE_EVAL = Path(__file__).with_name("fog_vnext_eval.js")


def finite(v):
    return mv.finite(v)


def weighted(rows, key):
    s = w = 0.0
    for r in rows:
        v = r.get(key)
        bw = r.get("base_weight")
        if finite(v) and finite(bw) and bw > 0:
            s += float(v) * float(bw)
            w += float(bw)
    return s / w if w else None


def first_finite(rows, key):
    for r in rows:
        if finite(r.get(key)):
            return r.get(key)
    return None


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
        k = mv.iso(valid - timedelta(hours=h))
        r = rows_by_time.get(k)
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
        by_valid[r.get("valid_time")].append(r)
    consensus = {k: consensus_hour(v) for k, v in by_valid.items() if k}
    consensus_maps = row_time_map([{"valid_time": k, **v} for k, v in consensus.items()])
    out = []

    for valid_s, rows in sorted(by_valid.items()):
        valid = mv.parse_dt(valid_s)
        archive_time = mv.parse_dt(rows[0].get("archive_time") or rows[0].get("run_time"))
        if not valid or not archive_time or archive_time >= valid or valid > mv.utcnow():
            continue
        c = consensus.get(valid_s) or {}
        c1 = consensus_maps.get(mv.iso(valid - timedelta(hours=1)))
        c3 = consensus_maps.get(mv.iso(valid - timedelta(hours=3)))
        icon = next((r for r in rows if r.get("model") == "icon_d2"), None)
        ecmwf = next((r for r in rows if r.get("model") == "ecmwf_ifs"), None)
        dmi = next((r for r in rows if r.get("model") == "dmi_harmonie_arome_europe"), None)

        t, td, rh, ws = c.get("temperature_c"), c.get("dew_point_c"), c.get("relative_humidity_pct"), c.get("wind_speed_ms")
        ts = (ecmwf or {}).get("surface_temperature_c")
        if not finite(ts):
            ts = (icon or {}).get("surface_temperature_c")
        ts1 = None
        ts3 = None
        ecmwf_batch = {r.get("valid_time"): r for r in batch_rows if r.get("model") == "ecmwf_ifs"}
        icon_batch = {r.get("valid_time"): r for r in batch_rows if r.get("model") == "icon_d2"}
        for delta, target in ((1, "ts1"), (3, "ts3")):
            k = mv.iso(valid - timedelta(hours=delta))
            rr = ecmwf_batch.get(k) or icon_batch.get(k)
            val = rr.get("surface_temperature_c") if rr else None
            if target == "ts1": ts1 = val
            else: ts3 = val

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
            "precip12": precip12(consensus_maps, valid),
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


def obs_truth(valid_s, metar_by_hour, synop_by_hour):
    valid = mv.parse_dt(valid_s)
    key = mv.iso(valid.replace(minute=0, second=0, microsecond=0))
    m = metar_by_hour.get(key)
    s = synop_by_hour.get(key)
    obs = m or s
    if not obs:
        return None
    cls = truth.classify(obs)
    vis = obs.get("visibility_m")
    known_vis = finite(vis)
    br_vis = known_vis and 1000 <= float(vis) <= 5000 and not cls["fog"]
    clear = known_vis and float(vis) > 5000 and not cls["fog"] and not cls["br"] and not cls["mifg"]
    return {
        "source": "SPECI" if m and str(m.get("type") or "").upper() == "SPECI" else ("METAR" if m else "SYNOP"),
        "raw": obs.get("canonical_raw") or obs.get("raw"),
        "visibility_m": vis,
        "fog_truth": bool(cls["fog"]),
        "mifg_truth": bool(cls["mifg"]),
        "br_truth": bool(cls["br"] or br_vis),
        "vis_lt_500": bool(known_vis and float(vis) < 500),
        "vis_lt_200": bool(known_vis and float(vis) < 200),
        "clear_truth": bool(clear),
        "truth_known": bool(known_vis or cls["fog"] or cls["br"] or cls["mifg"]),
    }


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
    pos = [s for s, y in pairs if y and finite(s)]
    neg = [s for s, y in pairs if not y and finite(s)]
    if not pos or not neg:
        return None
    wins = ties = 0
    for p in pos:
        for n in neg:
            if p > n: wins += 1
            elif p == n: ties += 1
    return (wins + 0.5 * ties) / (len(pos) * len(neg))


def main():
    rows = load_full_rows()
    by_batch = defaultdict(list)
    for r in rows:
        if r.get("archive_time") and r.get("valid_time"):
            by_batch[r["archive_time"]].append(r)
    metar_by_hour, synop_by_hour = mv.build_observation_maps()

    meta = []
    inputs = []
    for batch_rows in by_batch.values():
        for valid_s, archive_time, source_rows, base in case_inputs(batch_rows):
            truth_row = obs_truth(valid_s, metar_by_hour, synop_by_hour)
            if not truth_row or not truth_row["truth_known"]:
                continue
            meta.append((valid_s, archive_time, source_rows, base, truth_row))
            inputs.append(base)

    evaluated = evaluate_variants(inputs) if inputs else []
    cases = []
    for (valid_s, archive_time, source_rows, base, tr), ev in zip(meta, evaluated):
        full, no_soil, no_pbl, no_sfc = ev
        case = {
            "schema": "prognozaepir-fog-vnext-verification-v1",
            "archive_time": mv.iso(archive_time),
            "valid_time": valid_s,
            "models": sorted({r.get("model") for r in source_rows if r.get("model")}),
            "model_runs": {r.get("model"): r.get("model_run_time") for r in source_rows if r.get("model")},
            "forecast": {
                "temperature_c": base.get("t"), "dew_point_c": base.get("td"), "relative_humidity_pct": base.get("rh"),
                "visibility_m": base.get("visibility"), "low_cloud_pct": base.get("lowCloud"), "cloud_base_m": base.get("cbh"),
                "soil_moisture_icon_0_1": base.get("soilIcon01"), "soil_moisture_icon_1_3": base.get("soilIcon13"),
                "soil_moisture_ecmwf_0_7": base.get("soilEcmwf07"), "pbl_m": base.get("pbl"), "surface_temperature_c": base.get("tsurface"),
            },
            "vnext": full,
            "ablation": {"no_soil": no_soil, "no_pbl": no_pbl, "no_surface_cooling": no_sfc},
            "truth": tr,
        }
        cases.append(case)

    pairs = {
        "full": [(c["vnext"].get("physics_score"), c["truth"]["fog_truth"]) for c in cases],
        "no_soil": [(c["ablation"]["no_soil"].get("physics_score"), c["truth"]["fog_truth"]) for c in cases],
        "no_pbl": [(c["ablation"]["no_pbl"].get("physics_score"), c["truth"]["fog_truth"]) for c in cases],
        "no_surface_cooling": [(c["ablation"]["no_surface_cooling"].get("physics_score"), c["truth"]["fog_truth"]) for c in cases],
    }
    aucs = {k: auc(v) for k, v in pairs.items()}
    positives = sum(1 for c in cases if c["truth"]["fog_truth"])
    summary = {
        "schema": "prognozaepir-fog-vnext-verification-summary-v1",
        "generated_at": mv.iso(mv.utcnow()),
        "cases": len(cases),
        "fog_positive": positives,
        "fog_negative": len(cases) - positives,
        "auc": {k: round(v, 4) if v is not None else None for k, v in aucs.items()},
        "incremental_auc": {
            "soil": round(aucs["full"] - aucs["no_soil"], 4) if aucs["full"] is not None and aucs["no_soil"] is not None else None,
            "pbl": round(aucs["full"] - aucs["no_pbl"], 4) if aucs["full"] is not None and aucs["no_pbl"] is not None else None,
            "surface_cooling": round(aucs["full"] - aucs["no_surface_cooling"], 4) if aucs["full"] is not None and aucs["no_surface_cooling"] is not None else None,
        },
        "operational_activation_ready": bool(len(cases) >= 200 and positives >= 20 and aucs["full"] is not None),
        "note": "AUC is diagnostic only; activation additionally requires stable lead-time/event verification and no regression in VIS/TAF outcomes.",
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    CASES_PATH.write_text("".join(json.dumps(c, ensure_ascii=False, separators=(",", ":")) + "\n" for c in cases), encoding="utf-8")
    SUMMARY_PATH.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
