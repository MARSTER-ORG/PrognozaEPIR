#!/usr/bin/env python3
"""Adaptive weights v2 wrapper adding DMI/KNMI HARMONIE.

The underlying learner already performs same-case peer comparison, recency
weighting, sample-size shrinkage and conservative clipping. This wrapper only
extends the model inventory; it intentionally preserves those safeguards.
"""
from __future__ import annotations

import model_verification as mv

EXTRA_MODELS = [
    ("dmi_harmonie_arome_europe", "DMI HARMONIE-AROME Europe 2 km", 0.10),
    ("knmi_harmonie_arome_europe", "KNMI HARMONIE-AROME Europe 5.5 km", 0.07),
]


def install_extra_models():
    known = {m[0] for m in mv.MODELS}
    for row in EXTRA_MODELS:
        if row[0] not in known:
            mv.MODELS.append(row)
    mv.MODEL_META = {m: (name, weight) for m, name, weight in mv.MODELS}


def main():
    install_extra_models()
    import build_adaptive_weights as legacy
    legacy.main()


if __name__ == "__main__":
    main()
