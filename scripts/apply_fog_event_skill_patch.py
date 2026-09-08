#!/usr/bin/env python3
"""Feed fog-event learning factors into the browser fog ensemble.

Run after apply_fog_learning_upgrade.py. The patch is idempotent and leaves DMI
and KNMI on conservative fixed priors until enough archived forecasts for those
models exist in the event-learning dataset.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
P = ROOT / "fog-engine.js"
PATCH_VERSION = "1.1"


def repl(s, old, new, label):
    if new in s:
        return s
    if old not in s:
        raise SystemExit(f"fog-event patch marker missing: {label}")
    return s.replace(old, new, 1)


def main():
    s = P.read_text(encoding="utf-8")

    s = repl(
        s,
        "  const ADAPTIVE_WEIGHTS_URL = 'data/learning/adaptive-weights.json';\n",
        "  const ADAPTIVE_WEIGHTS_URL = 'data/learning/adaptive-weights.json';\n  const FOG_EVENT_SKILL_URL = 'data/learning/fog-event-skill.json';\n",
        "skill url",
    )
    s = repl(
        s,
        "  let adaptiveWeights = null;\n  let supplements = new Map();",
        "  let adaptiveWeights = null;\n  let fogEventSkill = null;\n  let supplements = new Map();",
        "skill state",
    )

    marker = r'''  async function fetchAdaptiveWeights(){
    const sep=ADAPTIVE_WEIGHTS_URL.includes('?')?'&':'?';
    const r=await fetch(ADAPTIVE_WEIGHTS_URL+sep+'_='+Date.now(),{cache:'no-store'});
    const j=await r.json().catch(()=>null);
    if(!r.ok||j?.schema!=='prognozaepir-adaptive-weights-v1')throw new Error('adaptive weights unavailable');
    adaptiveWeights=j;
  }
'''
    replacement = marker + r'''
  async function fetchFogEventSkill(){
    const sep=FOG_EVENT_SKILL_URL.includes('?')?'&':'?';
    const r=await fetch(FOG_EVENT_SKILL_URL+sep+'_='+Date.now(),{cache:'no-store'});
    const j=await r.json().catch(()=>null);
    if(!r.ok||j?.schema!=='prognozaepir-fog-event-skill-v1')throw new Error('fog event skill unavailable');
    fogEventSkill=j;
  }
'''
    if "async function fetchFogEventSkill()" not in s:
        if marker not in s:
            raise SystemExit("fog-event patch marker missing: adaptive fetch")
        s = s.replace(marker, replacement, 1)

    s = repl(
        s,
        "        fetchAdaptiveWeights().catch(e=>{adaptiveWeights=null;console.warn('fog adaptive weights:',e)})\n      ]);",
        "        fetchAdaptiveWeights().catch(e=>{adaptiveWeights=null;console.warn('fog adaptive weights:',e)}),\n        fetchFogEventSkill().catch(e=>{fogEventSkill=null;console.warn('fog event skill:',e)})\n      ]);",
        "refresh skill",
    )

    s = repl(
        s,
        "    const factor=weightedAvailable(parts).v??n(row?.weight_factor)??1;\n    return clip(base*factor,.015,.25);",
        "    const factor=weightedAvailable(parts).v??n(row?.weight_factor)??1;\n    const eventFactor=n(fogEventSkill?.models?.[modelId]?.lead_buckets?.[bucket]?.weight_factor)??1;\n    return clip(base*factor*eventFactor,.015,.25);",
        "runtime event factor",
    )

    s = s.replace(
        "DMI fog 2 m aktywne · KNMI HARMONIE aktywne gdy dostępne",
        "DMI fog 2 m · KNMI HARMONIE · lokalna kalibracja METAR/SPECI",
    )

    P.write_text(s, encoding="utf-8")
    print(f"fog METAR/SPECI event skill runtime patch {PATCH_VERSION} applied")


if __name__ == "__main__":
    main()
