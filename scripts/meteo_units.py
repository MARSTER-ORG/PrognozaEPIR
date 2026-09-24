#!/usr/bin/env python3
from __future__ import annotations
import math

MPS_TO_KT=1.9438444924406
KT_TO_MPS=0.5144444444444445
M_TO_FT=3.2808398950131
FT_TO_M=0.3048

def _cv(value, factor):
    try:
        x=float(value)
    except (TypeError, ValueError):
        return None
    return x*factor if math.isfinite(x) else None

def mps_to_kt(value): return _cv(value,MPS_TO_KT)
def kt_to_mps(value): return _cv(value,KT_TO_MPS)
def m_to_ft(value): return _cv(value,M_TO_FT)
def ft_to_m(value): return _cv(value,FT_TO_M)
