#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def repl(path, old, new):
    p=ROOT/path
    s=p.read_text(encoding='utf-8')
    n=s.count(old)
    if n!=1:
        raise SystemExit(f'{path}: expected 1 match, got {n}: {old[:140]!r}')
    p.write_text(s.replace(old,new,1),encoding='utf-8')

# App: choose an observation that was actually available when the TAF was issued.
repl('taf-app-v2.js',
"  function newest(a){return a.filter(Boolean).sort((x,y)=>(itemTime(y)||0)-(itemTime(x)||0))[0]||null;}\n  function observationRows(recent){",
"  function newest(a){return a.filter(Boolean).sort((x,y)=>(itemTime(y)||0)-(itemTime(x)||0))[0]||null;}\n  function newestAtOrBefore(a,cutoff){return a.filter(Boolean).filter(x=>{const t=itemTime(x,cutoff);return finite(t)&&t<=cutoff;}).sort((x,y)=>itemTime(y,cutoff)-itemTime(x,cutoff))[0]||null;}\n  function observationRows(recent){")

repl('taf-app-v2.js',
"    activeResult=result;window.PrognozaEPIRTAFCurrentGenerated=result.taf;window.PrognozaEPIRTAFResultV2=result;\n    $('taf').textContent=result.taf;$('officialTaf').textContent=rawOf(data.currentTaf)||'Brak aktualnego TAF w archiwum';$('metar').textContent=rawOf(data.observation)||'Brak METAR/SPECI';$('metarMeta').textContent=data.observation?`Archiwum · ${fmtUtc(itemTime(data.observation))}`:'Brak obserwacji do zakotwiczenia';",
"    activeResult=result;window.PrognozaEPIRTAFCurrentGenerated=result.taf;window.PrognozaEPIRTAFResultV2=result;\n    $('taf').textContent=result.taf;$('officialTaf').textContent=rawOf(data.currentTaf)||'Brak aktualnego TAF w archiwum';$('metar').textContent=rawOf(data.observation)||'Brak METAR/SPECI';\n    const anchor=data.anchorObservation;$('metarMeta').textContent=data.observation?`Archiwum · ${fmtUtc(itemTime(data.observation))} · kotwica TAF: ${anchor?fmtUtc(itemTime(anchor,data.issueTime)):'brak obserwacji ≤ emisja'}`:'Brak obserwacji do zakotwiczenia';")

repl('taf-app-v2.js',
"    $('sources').innerHTML=`<span class=\"pill ${data.observation?'ok':'warn'}\">METAR/SPECI ${data.observation?'✓':'—'}</span>",
"    $('sources').innerHTML=`<span class=\"pill ${data.anchorObservation?'ok':'warn'}\">METAR/SPECI ${data.anchorObservation?'✓':'—'} · kotwica ${data.anchorObservation?esc(fmtUtc(itemTime(data.anchorObservation,data.issueTime),false)):'brak ≤ emisja'}</span>")

repl('taf-app-v2.js',
"    const [data,rows]=await Promise.all([loadArchive(),modelRows(period)]);if(rows.length<8)throw Error(`Niepełny okres modeli: ${rows.length} h`);\n    const api=window.PrognozaEPIRTAFEngine;if(!api?.createEngine)throw Error('taf-engine-v2.js nie został załadowany');const engine=api.createEngine({config:{station:'EPIR'}});\n    const result=engine.generate({station:'EPIR',issue:period.issue,start:period.start,end:period.end,rows,observation:data.observation,observations:data.history,msaFt:msaFt(),rowsAlreadyAnchored:false});render(result,data,rows);return result;",
"    const [data,rows]=await Promise.all([loadArchive(),modelRows(period)]);if(rows.length<8)throw Error(`Niepełny okres modeli: ${rows.length} h`);\n    const anchorObservation=newestAtOrBefore([data.observation,...(data.history||[])],period.issue);data.anchorObservation=anchorObservation;data.issueTime=period.issue;\n    const api=window.PrognozaEPIRTAFEngine;if(!api?.createEngine)throw Error('taf-engine-v2.js nie został załadowany');const engine=api.createEngine({config:{station:'EPIR'}});\n    const result=engine.generate({station:'EPIR',issue:period.issue,start:period.start,end:period.end,rows,observation:anchorObservation,observations:data.history,msaFt:msaFt(),rowsAlreadyAnchored:false});render(result,data,rows);return result;")

# Engine: defense in depth — never anchor with an observation from after issue time.
repl('taf-engine-v2.js',
"  function anchorRows(rows,observation,start){\n    const o=parseObservation(observation);if(!o)return rows.map(r=>({...r}));\n    const age=Math.max(0,(start-o.t)/HOUR);if(age>6)return rows.map(r=>({...r}));",
"  function anchorRows(rows,observation,start,cutoff=start){\n    const o=parseObservation(observation);if(!o)return rows.map(r=>({...r}));\n    if(finite(cutoff)&&o.t>cutoff)return rows.map(r=>({...r}));\n    const age=Math.max(0,(start-o.t)/HOUR);if(age>6)return rows.map(r=>({...r}));")

repl('taf-engine-v2.js',
"        const anchored=input.rowsAlreadyAnchored?raw.map(r=>({...r})):anchorRows(raw,input.observation,start);",
"        const anchored=input.rowsAlreadyAnchored?raw.map(r=>({...r})):anchorRows(raw,input.observation,start,issue);")

repl('taf-engine-v2.js',
"fogProbabilityPolicy:'operational 40→30%, 60→40%, 80→50%; max one PROB30 per TAF, first qualifying event, 2h window'",
"fogProbabilityPolicy:'operational 40→30%, 60→40%, 80→50%; max one PROB30 per TAF, first qualifying event, 2h window',observationPolicy:'METAR/SPECI anchor must be timestamp <= TAF issue time; future observations are rejected'")

# Regression: an observation four hours after issue must not rewrite the base state.
marker="// Recent METAR/SPECI must reject unsupported model-only thin cloud layers while retaining a supported ceiling.\n"
insert="""// Issue-time integrity: a later observation must never leak backwards into an already-issued TAF.\n{\n  const cleanRows=Array.from({length:12},(_,i)=>row(i,{vis:9000,kt:6,dir:220}));\n  const futureObs={raw:'EPIR 140300Z AUTO 00000KT 0400 FG OVC001 13/13 Q1018',obs_time:new Date(start+3*H).toISOString()};\n  const q=gen(cleanRows,{observation:futureObs,rowsAlreadyAnchored:false});\n  assert.ok(!/\\b(?:FG|FZFG)\\b/.test(q.base.text),q.base.text);\n  assert.ok(!/\\b0[0-9]{3}\\b/.test(q.base.text),q.base.text);\n}\n\n"""+marker
repl('tests/taf-engine-v2.test.js',marker,insert)

repl('tests/taf-engine-v2.test.js',
"assert.ok(app.includes('profile:Array.isArray(z.profile)'),'app must transfer vertical cloud profile into TAF engine');",
"assert.ok(app.includes('profile:Array.isArray(z.profile)'),'app must transfer vertical cloud profile into TAF engine');assert.ok(app.includes('newestAtOrBefore'),'app must select an issue-time-safe observation anchor');assert.ok(app.includes('observation:anchorObservation'),'app must pass the issue-time anchor, not the latest future METAR');")

print('TAF issue-time observation anchor fix applied')
