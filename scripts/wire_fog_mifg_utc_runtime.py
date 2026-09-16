#!/usr/bin/env python3
"""Wire the deployed FOG/MIFG runtime and production Fog Engine vNext bridge.

Archive routing is owned solely by message-archive-client.js. This build step
normalizes FOG/MIFG display/input clock semantics to UTC and ensures the
validated Fog Engine vNext production bridge is present in the canonical Pages
artifact after prepare_pages.py has assembled the site.
"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "_site"
ASSET_V = os.environ.get("GITHUB_SHA", "dev")[:12]


def patch_fog() -> None:
    p = SITE / "fog-engine.js"
    s = p.read_text(encoding="utf-8")
    old_hour = """  function localHour(t){
    try{return new Intl.DateTimeFormat('pl-PL',{timeZone:PLACE.tz,hour:'2-digit',minute:'2-digit'}).format(new Date(t));}
    catch(_){return new Date(t).toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'});}
  }"""
    new_hour = """  function localHour(t){
    try{return new Intl.DateTimeFormat('pl-PL',{timeZone:'UTC',hour:'2-digit',minute:'2-digit'}).format(new Date(t))+' UTC';}
    catch(_){return String(new Date(t).getUTCHours()).padStart(2,'0')+':'+String(new Date(t).getUTCMinutes()).padStart(2,'0')+' UTC';}
  }"""
    old_dt = """  function localDateTime(t){
    try{return new Intl.DateTimeFormat('pl-PL',{timeZone:PLACE.tz,weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(t));}
    catch(_){return new Date(t).toLocaleString('pl-PL');}
  }"""
    new_dt = """  function localDateTime(t){
    try{return new Intl.DateTimeFormat('pl-PL',{timeZone:'UTC',weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(t))+' UTC';}
    catch(_){return new Date(t).toISOString().slice(0,16).replace('T',' ')+' UTC';}
  }"""
    if old_hour not in s or old_dt not in s:
        raise SystemExit("FOG UTC formatter markers not found")
    s = s.replace(old_hour, new_hour, 1).replace(old_dt, new_dt, 1)
    s = s.replace("timeZone:PLACE.tz,year:'numeric'", "timeZone:'UTC',year:'numeric'", 1)
    old_parse = "function parseLocalInput(v){return v?Date.parse(v):NaN;}"
    new_parse = "function parseLocalInput(v){return v?Date.parse(/[zZ]|[+-]\\d\\d:\\d\\d$/.test(v)?v:v+'Z'):NaN;}"
    if old_parse not in s:
        raise SystemExit("FOG datetime-local parser marker not found")
    s = s.replace(old_parse, new_parse, 1)
    p.write_text(s, encoding="utf-8")


def patch_mifg() -> None:
    p = SITE / "mifg-engine.js"
    s = p.read_text(encoding="utf-8")
    old = """  function localHour(t){
    try{return new Intl.DateTimeFormat('pl-PL',{timeZone:PLACE.tz,hour:'2-digit',minute:'2-digit'}).format(new Date(t));}
    catch(_){return new Date(t).toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'});}
  }"""
    new = """  function localHour(t){
    try{return new Intl.DateTimeFormat('pl-PL',{timeZone:'UTC',hour:'2-digit',minute:'2-digit'}).format(new Date(t))+' UTC';}
    catch(_){return String(new Date(t).getUTCHours()).padStart(2,'0')+':'+String(new Date(t).getUTCMinutes()).padStart(2,'0')+' UTC';}
  }"""
    if old not in s:
        raise SystemExit("MIFG UTC formatter marker not found")
    s = s.replace(old, new, 1)
    s = s.replace("timeZone:PLACE.tz,hour:'2-digit',hourCycle:'h23'", "timeZone:'UTC',hour:'2-digit',hourCycle:'h23'", 1)
    p.write_text(s, encoding="utf-8")


def patch_vnext() -> None:
    index = SITE / "index.html"
    bridge = SITE / "fog-summary-layout.js"
    physics = SITE / "fog-physics-vnext.js"
    probability = SITE / "fog-vnext-probability-layer.js"
    for p in (bridge, physics, probability):
        if not p.is_file() or p.stat().st_size == 0:
            raise SystemExit(f"Fog vNext production asset missing: {p.name}")

    s = index.read_text(encoding="utf-8")
    tag = f'<script src="fog-summary-layout.js?v={ASSET_V}"></script>'
    if 'fog-summary-layout.js?v=' not in s:
        marker = '</body>'
        if marker not in s:
            raise SystemExit("index.html body marker missing for Fog vNext bridge")
        s = s.replace(marker, tag + "\n" + marker, 1)
    index.write_text(s, encoding="utf-8")


def validate() -> None:
    fog = (SITE / "fog-engine.js").read_text(encoding="utf-8")
    mifg = (SITE / "mifg-engine.js").read_text(encoding="utf-8")
    index = (SITE / "index.html").read_text(encoding="utf-8")
    bridge = (SITE / "fog-summary-layout.js").read_text(encoding="utf-8")
    probability = (SITE / "fog-vnext-probability-layer.js").read_text(encoding="utf-8")
    if "function parseLocalInput(v){return v?Date.parse(/[zZ]|[+-]\\d\\d:\\d\\d$/.test(v)?v:v+'Z'):NaN;}" not in fog:
        raise SystemExit("FOG datetime-local is not UTC")
    if "timeZone:PLACE.tz" in fog or "timeZone:PLACE.tz" in mifg:
        raise SystemExit("local timezone reference remains in deployed FOG/MIFG")
    if "+' UTC'" not in fog or "+' UTC'" not in mifg:
        raise SystemExit("explicit UTC label missing in FOG/MIFG")
    if 'fog-summary-layout.js?v=' not in index:
        raise SystemExit("Fog vNext production bridge is not wired into deployed index.html")
    if "fogEngineMode:'vnext-production'" not in bridge or 'Probability.operationalScore' not in bridge:
        raise SystemExit("Fog vNext bridge is not in production mode")
    if "const VERSION='1.0.0-production'" not in probability or 'P_model_final' not in probability:
        raise SystemExit("Fog vNext production probability layer contract missing")


def main() -> int:
    patch_fog()
    patch_mifg()
    patch_vnext()
    validate()
    print("wired explicit UTC FOG/MIFG runtime and Fog vNext production bridge")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
