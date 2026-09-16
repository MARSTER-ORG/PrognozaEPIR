#!/usr/bin/env python3
"""Fog-event learning v2 policy wrapper.

Keeps the proven learning implementation, but installs the vNext target policy
and adds DMI/KNMI HARMONIE to the model inventory. This deliberately does not
change the conservative shrinkage/sample thresholds of the legacy learner.
"""
from __future__ import annotations

import json
from pathlib import Path

import model_verification as mv
import metar_wind_index
import build_fog_event_learning as legacy

EXTRA_MODELS = [
    ("dmi_harmonie_arome_europe", "DMI HARMONIE-AROME Europe 2 km", 0.10),
    ("knmi_harmonie_arome_europe", "KNMI HARMONIE-AROME Europe 5.5 km", 0.07),
]
FOG_CODES = {"FG", "BCFG", "PRFG", "FZFG"}
MIFG_CODES = {"MIFG"}
MIST_CODES = {"BR"}


def install_extra_models():
    known = {m[0] for m in mv.MODELS}
    for row in EXTRA_MODELS:
        if row[0] not in known:
            mv.MODELS.append(row)
    mv.MODEL_META = {m: (name, weight) for m, name, weight in mv.MODELS}


def classify(obs):
    raw = str(obs.get("canonical_raw") or obs.get("raw") or "").upper()
    tok = legacy.tokens(raw)
    explicit_codes = tok & FOG_CODES
    mifg = bool(tok & MIFG_CODES) or bool(obs.get("shallow_fog"))
    mist = bool(tok & MIST_CODES) or bool(obs.get("mist"))
    precip = any(fragment in raw for fragment in legacy.PRECIP_FRAGMENTS)
    vis = obs.get("visibility_m")

    # Project truth policy: MIFG is a separate target. Some upstream parsers use
    # a generic fog flag for any fog-family token, so that flag cannot promote a
    # standalone MIFG report to FG truth.
    generic_fog = bool(obs.get("fog")) and not mifg
    explicit_fog = bool(explicit_codes) or generic_fog or bool(obs.get("freezing_fog"))
    visibility_fog = mv.finite(vis) and float(vis) < 1000.0 and not precip
    fog = explicit_fog or visibility_fog

    if mifg:
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

    return {
        "kind": kind,
        "fog": fog,
        "mifg": mifg,
        "visibility_fog": bool(visibility_fog),
        "br": mist and not fog,
        "obscuration": fog or mist or mifg,
        "precip": precip,
    }


def postprocess_output():
    path = Path(legacy.OUT)
    data = json.loads(path.read_text(encoding="utf-8"))
    data["method"] = (
        "METAR+exact-minute SPECI fog/mist event calibration; canonical fog_truth = explicit FG/FZFG/BCFG/PRFG "
        "or non-precipitation visibility <1000 m; MIFG and BR remain separate targets; same-case peer Brier loss, "
        "recency weighting, positive-event emphasis, capped SPECI bursts and shrinkage"
    )
    data["codes"] = {
        "fog": sorted(FOG_CODES),
        "mifg": sorted(MIFG_CODES),
        "mist": sorted(MIST_CODES),
        "visibility_fog_m": 1000,
    }
    data["target_policy"] = {
        "fog_truth": "explicit fog code OR visibility<1000m without precipitation",
        "mifg_separate": True,
        "br_separate": True,
        "missing_night_auto_visibility": "UNKNOWN, never forced CLEAR",
    }
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    install_extra_models()
    metar_wind_index.install(mv)
    legacy.FOG_CODES = set(FOG_CODES)
    legacy.MIST_CODES = set(MIST_CODES)
    legacy.classify = classify
    legacy.main()
    postprocess_output()


if __name__ == "__main__":
    main()
