#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    p = ROOT / path
    s = p.read_text(encoding="utf-8")
    n = s.count(old)
    if n != 1:
        raise SystemExit(f"{path}: expected exactly one match, got {n}: {old[:120]!r}")
    p.write_text(s.replace(old, new, 1), encoding="utf-8")


def replace_all_checked(path: str, old: str, new: str, expected: int) -> None:
    p = ROOT / path
    s = p.read_text(encoding="utf-8")
    n = s.count(old)
    if n != expected:
        raise SystemExit(f"{path}: expected {expected} matches, got {n}: {old[:120]!r}")
    p.write_text(s.replace(old, new), encoding="utf-8")


# --- TAF Engine 2.3: only the first PROB30 may appear in one TAF. ---
replace_once(
    "taf-engine-v2.js",
    "    maxChangeGroups:5,\n    prob30:{min:.30,maxExclusive:.50},",
    "    maxChangeGroups:5,\n    maxProb30Groups:1,\n    prob30:{min:.30,maxExclusive:.50},",
)
replace_once(
    "taf-engine-v2.js",
    "    const groups=[],reasons=[],skipped=[];let prevailing=base,activeProbFog='NONE';",
    "    const groups=[],reasons=[],skipped=[];let prevailing=base,prob30Used=false;",
)
replace_once(
    "taf-engine-v2.js",
    "      if(activeProbFog!=='NONE'&&(altFogFamily!==activeProbFog||fogAltProb>=.50))activeProbFog='NONE';\n\n",
    "",
)
replace_once(
    "taf-engine-v2.js",
    "      // FOG is an independent input. A continuous 30–49% onset is represented once by a 2 h PROB30 change window, not stretched by merging hourly windows.\n      if(newFogAlternative&&fogAltProb>=.30&&fogAltProb<.50){\n        if(activeProbFog===altFogFamily){skipped.push(`${code(target.t)} UTC: kontynuacja alternatywnego ${altFogFamily} 30–49% jest już objęta wcześniejszą grupą PROB30.`);continue;}\n        target=alternativeFogState(prevailing,target);fields=[...new Set([...fields,'visibility'])];\n        const w=twoHourWindow(target.t,start,end),g={kind:'PROB30',s:w.s,e:w.e,fields,payload:payload(prevailing,target,fields,'PROB30',msaFt),probability:fogAltProb};\n        if(g.payload&&!conflicts(groups,g)){g.text=`PROB30 ${period(g.s,g.e)} ${g.payload}`;groups.push(g);activeProbFog=altFogFamily;reasons.push(`${g.text}: alternatywne FG/BR ${Math.round(fogAltProb*100)}%; 2 h okno możliwej trwałej zmiany, bez TEMPO.`);}continue;\n      }",
    "      // Operational policy: use PROB30 at most once in one TAF and keep the first qualifying event.\n      if(newFogAlternative&&fogAltProb>=.30&&fogAltProb<.50){\n        if(prob30Used){skipped.push(`${code(target.t)} UTC: pominięto kolejne PROB30 (${altFogFamily}) — w jednym TAF zachowujemy pierwszą kwalifikującą się grupę PROB30.`);continue;}\n        target=alternativeFogState(prevailing,target);fields=[...new Set([...fields,'visibility'])];\n        const w=twoHourWindow(target.t,start,end),g={kind:'PROB30',s:w.s,e:w.e,fields,payload:payload(prevailing,target,fields,'PROB30',msaFt),probability:fogAltProb};\n        if(g.payload&&!conflicts(groups,g)){g.text=`PROB30 ${period(g.s,g.e)} ${g.payload}`;groups.push(g);prob30Used=true;reasons.push(`${g.text}: alternatywne FG/BR ${Math.round(fogAltProb*100)}%; pierwsza kwalifikująca się grupa PROB30, 2 h okno zmiany, bez TEMPO.`);}continue;\n      }",
)
replace_once(
    "taf-engine-v2.js",
    "      if(confidence<.50){\n        kind='PROB30';const w=twoHourWindow(target.t,start,end);s=w.s;e=w.e;\n      }else if(newFog){",
    "      if(confidence<.50){\n        if(prob30Used){skipped.push(`${code(target.t)} UTC: pominięto kolejne PROB30 — w jednym TAF zachowujemy pierwszą kwalifikującą się grupę PROB30.`);continue;}\n        kind='PROB30';const w=twoHourWindow(target.t,start,end);s=w.s;e=w.e;\n      }else if(newFog){",
)
replace_once(
    "taf-engine-v2.js",
    "      groups.push(g);reasons.push(`${g.text}: ${fields.join(', ')}; pewność ${Math.round(confidence*100)}%.`);\n      if(kind==='BECMG'||kind==='FM')prevailing=mergePrevailing(prevailing,target,fields);",
    "      groups.push(g);reasons.push(`${g.text}: ${fields.join(', ')}; pewność ${Math.round(confidence*100)}%.`);\n      if(kind==='PROB30')prob30Used=true;\n      if(kind==='BECMG'||kind==='FM')prevailing=mergePrevailing(prevailing,target,fields);",
)
replace_once(
    "taf-engine-v2.js",
    "    const count=(text.match(/\\b(?:BECMG|TEMPO|FM\\d{6}|PROB30(?:\\s+TEMPO)?)\\b/g)||[]).length;if(count>MAX_GROUPS)errors.push(`Liczba grup zmian ${count} > ${MAX_GROUPS}.`);",
    "    const count=(text.match(/\\b(?:BECMG|TEMPO|FM\\d{6}|PROB30(?:\\s+TEMPO)?)\\b/g)||[]).length;if(count>MAX_GROUPS)errors.push(`Liczba grup zmian ${count} > ${MAX_GROUPS}.`);\n    const prob30Count=(text.match(/\\bPROB30\\b/g)||[]).length;if(prob30Count>RULES.maxProb30Groups)errors.push(`PROB30 może wystąpić maksymalnie ${RULES.maxProb30Groups} raz w jednym TAF (polityka operacyjna EPIR).`);",
)
replace_once(
    "taf-engine-v2.js",
    "          checks:{...checks,noProb40:!taf.includes('PROB40'),noVV:!/\\bVV/.test(taf),max5:cg.groups.length<=5,periodHours:12,instructionLocked:true},",
    "          checks:{...checks,noProb40:!taf.includes('PROB40'),oneProb30:(taf.match(/\\bPROB30\\b/g)||[]).length<=RULES.maxProb30Groups,noVV:!/\\bVV/.test(taf),max5:cg.groups.length<=5,periodHours:12,instructionLocked:true},",
)
replace_once(
    "taf-engine-v2.js",
    "fogProbabilityPolicy:'operational 40→30%, 60→40%, 80→50%; continuous 30–49% FG/BR => one 2h PROB30 onset window'",
    "fogProbabilityPolicy:'operational 40→30%, 60→40%, 80→50%; max one PROB30 per TAF, first qualifying event, 2h window'",
)

# --- TAF regression: separated 36% episodes must not generate a second PROB30. ---
replace_once(
    "tests/taf-engine-v2.test.js",
    "assert.equal(E.RULES.prob40,false);assert.equal(E.RULES.verticalVisibility,false);assert.equal(E.RULES.maxChangeGroups,5);",
    "assert.equal(E.RULES.prob40,false);assert.equal(E.RULES.verticalVisibility,false);assert.equal(E.RULES.maxChangeGroups,5);assert.equal(E.RULES.maxProb30Groups,1);",
)
marker = "// Direct calibrated 30-49% probability must create PROB30 even with no deterministic threshold crossing.\n"
insert = """// Even separated 30–49% episodes may not create a second PROB30; keep the first one.\n{\n  const splitRows=Array.from({length:12},(_,i)=>row(i,{vis:6000,fogOperationalScore:(i===5||i===7)?52:0,fgOperationalScore:(i===5||i===7)?52:0,fogAltVisM:(i===5||i===7)?900:null,mv:[model({vis:6000}),model({vis:6500}),model({vis:7000})]}));\n  const q=gen(splitRows);\n  assert.match(q.taf,/PROB30\\s+1404\\/1406\\s+0900\\s+FG/,q.taf);\n  assert.equal((q.taf.match(/PROB30/g)||[]).length,1,q.taf);\n  assert.ok(!q.taf.includes('PROB30 1406/1408'),q.taf);\n}\nassert.equal(E.validateTaf('TAF EPIR 132300Z 1400/1412 22004KT 7000 NSC PROB30 1404/1406 0900 FG PROB30 1406/1408 0900 FG=',{issue,start,end}).ok,false);\n\n""" + marker
replace_once("tests/taf-engine-v2.test.js", marker, insert)

# --- FOG runtime: AUTO visibility <1000 m without precipitation is fog evidence even if AUTO omits FG. ---
replace_once(
    "fog-engine.js",
    "  function obsPhenomenon(o){\n    if(!o)return '—';\n    if(o.freezingFog)return 'FZFG';\n    if(o.fog)return 'FG';\n    if(o.mist)return 'BR';\n    return o.automatic?'bez FG/BR':'manualna';\n  }",
    "  function obsPhenomenon(o){\n    if(!o)return '—';\n    if(o.freezingFog)return 'FZFG';\n    if(o.fog)return 'FG';\n    if(o.mist)return 'BR';\n    const raw=String(o.raw||'').toUpperCase(),precip=/\\b(?:\\+|-)?(?:RA|DZ|SN|SG|PL|GR|GS|TS|TSRA|SHRA|SHSN)\\b/.test(raw);\n    if(o.automatic&&finite(o.visM)&&o.visM<1000&&!precip)return finite(o.T)&&o.T<=0?'FZFG':'FG';\n    return o.automatic?'bez FG/BR':'manualna';\n  }",
)

# --- Historical fog learning: classify non-precip visibility <1000 m as fog evidence. ---
replace_once(
    "scripts/build_fog_event_learning.py",
    "    fog_codes = sorted(tok & FOG_CODES)\n    mist = bool(tok & MIST_CODES) or bool(obs.get(\"mist\"))\n    fog = bool(fog_codes) or bool(obs.get(\"fog\")) or bool(obs.get(\"freezing_fog\"))",
    "    fog_codes = sorted(tok & FOG_CODES)\n    mist = bool(tok & MIST_CODES) or bool(obs.get(\"mist\"))\n    precip = any(fragment in raw for fragment in PRECIP_FRAGMENTS)\n    vis = obs.get(\"visibility_m\")\n    explicit_fog = bool(fog_codes) or bool(obs.get(\"fog\")) or bool(obs.get(\"freezing_fog\"))\n    visibility_fog = mv.finite(vis) and float(vis) < 1000.0 and not precip\n    fog = explicit_fog or visibility_fog",
)
replace_once(
    "scripts/build_fog_event_learning.py",
    "    precip = any(fragment in raw for fragment in PRECIP_FRAGMENTS)\n    return {\n        \"kind\": kind,\n        \"fog\": fog,",
    "    return {\n        \"kind\": kind,\n        \"fog\": fog,\n        \"visibility_fog\": bool(visibility_fog),",
)
replace_once(
    "scripts/build_fog_event_learning.py",
    '        "method": "METAR+exact-minute SPECI fog/mist event calibration; same-case peer Brier loss, recency weighting, positive-event emphasis, capped SPECI bursts and shrinkage",',
    '        "method": "METAR+exact-minute SPECI fog/mist event calibration; non-precip visibility <1000 m is fog evidence when AUTO omits FG; same-case peer Brier loss, recency weighting, positive-event emphasis, capped SPECI bursts and shrinkage",',
)
replace_once(
    "scripts/build_fog_event_learning.py",
    '        "codes": {"fog": sorted(FOG_CODES), "mist": sorted(MIST_CODES)},',
    '        "codes": {"fog": sorted(FOG_CODES), "mist": sorted(MIST_CODES), "visibility_fog_m": 1000},',
)
replace_once(
    "scripts/build_fog_event_learning.py",
    '            "fog": sum(1 for r in observations if r["_class"]["fog"]),\n            "br": sum(1 for r in observations if r["_class"]["br"]),',
    '            "fog": sum(1 for r in observations if r["_class"]["fog"]),\n            "fog_by_visibility": sum(1 for r in observations if r["_class"].get("visibility_fog")),\n            "br": sum(1 for r in observations if r["_class"]["br"]),',
)

# --- Keep the learning regression permanently in adaptive CI. ---
replace_once(
    ".github/workflows/adaptive-runtime-rollout.yml",
    "      - 'scripts/build_fog_event_learning.py'\n      - 'scripts/build_model_snapshot.py'",
    "      - 'scripts/build_fog_event_learning.py'\n      - 'tests/test_fog_event_learning.py'\n      - 'scripts/build_model_snapshot.py'",
)
replace_once(
    ".github/workflows/adaptive-runtime-rollout.yml",
    "            scripts/build_fog_event_learning.py \\\n            scripts/build_model_snapshot.py \\",
    "            scripts/build_fog_event_learning.py \\\n            tests/test_fog_event_learning.py \\\n            scripts/build_model_snapshot.py \\",
)
replace_once(
    ".github/workflows/adaptive-runtime-rollout.yml",
    "      - name: Rebuild learning from archive\n        run: |\n          python3 scripts/model_verification.py",
    "      - name: Validate fog event classification\n        run: python3 tests/test_fog_event_learning.py\n\n      - name: Rebuild learning from archive\n        run: |\n          python3 scripts/model_verification.py",
)

print("single-PROB30 + fog event learning patch applied")
