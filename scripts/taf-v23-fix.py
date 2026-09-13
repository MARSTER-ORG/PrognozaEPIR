from pathlib import Path
import re


def read(path):
    return Path(path).read_text(encoding='utf-8')


def write(path, text):
    Path(path).write_text(text, encoding='utf-8')


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f'{label}: marker not found')
    return text.replace(old, new, 1)


# 1. Stop the common archive client from loading the legacy TAF mutator stack on Engine 2 pages.
p = 'message-archive-client.js'
s = read(p)
old = """    (async()=>{\n      try{\n        await loadPolicy('taf-instruction-guard.js','20260909-7');\n        await loadPolicy('taf-verification-explain.js','20260910-1');\n      }catch(error){console.warn('TAF policy loader:',error);}\n    })();\n"""
new = """    if(!document.querySelector('meta[name=\"prognozaepir-taf-engine-v2\"]')){\n      (async()=>{\n        try{\n          await loadPolicy('taf-instruction-guard.js','20260909-7');\n          await loadPolicy('taf-verification-explain.js','20260910-1');\n        }catch(error){console.warn('TAF policy loader:',error);}\n      })();\n    }\n"""
if old in s:
    s = s.replace(old, new, 1)
elif 'prognozaepir-taf-engine-v2' not in s:
    raise SystemExit('legacy TAF loader guard: marker not found')
write(p, s)

# 2. TAF app: Engine 2.3, stronger FOG bridge, explicit FG/BR evidence.
p = 'taf-app-v2.js'
s = read(p)
s = s.replace('__PROGNOZA_EPIR_TAF_APP_V22__', '__PROGNOZA_EPIR_TAF_APP_V23__')
s = s.replace('TAF ENGINE 2.2', 'TAF ENGINE 2.3')
s = s.replace('[TAF Engine 2.2]', '[TAF Engine 2.3]')

old = """    try{\n      const fogUntil=Date.now()+8000;\n      do{\n        fog=w.PrognozaEPIRFogSeries||[];\n        if(fog.length)break;\n        await new Promise(r=>setTimeout(r,250));\n      }while(Date.now()<fogUntil);\n    }catch(_){}\n"""
new = """    try{\n      const fogUntil=Date.now()+15000;\n      do{\n        fog=w.PrognozaEPIRFogSeries||[];\n        if(fog.length)break;\n        await new Promise(r=>setTimeout(r,250));\n      }while(Date.now()<fogUntil);\n    }catch(_){}\n"""
if old in s:
    s=s.replace(old,new,1)

old = """      return {...z,\n        fogRisk:num(f?.score)?+f.score:0,\n        fgRisk:num(f?.vis1000)?+f.vis1000:null,\n        fogVis1500Risk:num(f?.vis1500)?+f.vis1500:null,\n        fogVis1000Risk:num(f?.vis1000)?+f.vis1000:null,\n        fogVis500Risk:num(f?.vis500)?+f.vis500:null,\n        fogVis200Risk:num(f?.vis200)?+f.vis200:null,\n        fogAltVisM:num(f?.vis)&&+f.vis<1000?Math.max(100,Math.min(900,+f.vis)):null,\n        mifgRisk:num(m?.score)?+m.score:null,\n        fogEngineConfidence:num(f?.confidence)?+f.confidence:null,\n        fogEngineType:f?.type?.text||f?.type||null\n      };\n"""
new = """      const fogScore=num(f?.score)?+f.score:0,vis1000=num(f?.vis1000)?+f.vis1000:null,vis1500=num(f?.vis1500)?+f.vis1500:null,vis500=num(f?.vis500)?+f.vis500:null;\n      const fogVis=num(f?.vis)?+f.vis:null;\n      const fgRisk=Math.max(fogScore,num(vis1000)?vis1000:0);\n      const brRisk=num(fogVis)&&fogVis>=1000&&fogVis<=5000?Math.max(fogScore,num(vis1500)?vis1500:0):null;\n      const fogAltVisM=num(fogVis)&&fogVis<1000?Math.max(100,Math.min(900,fogVis)):(fogScore>=30?(num(vis500)&&vis500>=50?500:(num(vis1000)&&vis1000>=50?800:900)):null);\n      return {...z,\n        fogRisk:fogScore,\n        fgRisk,\n        brRisk,\n        fogVis1500Risk:vis1500,\n        fogVis1000Risk:vis1000,\n        fogVis500Risk:vis500,\n        fogVis200Risk:num(f?.vis200)?+f.vis200:null,\n        fogAltVisM,\n        fogEngineVisM:fogVis,\n        mifgRisk:num(m?.score)?+m.score:null,\n        fogEngineConfidence:num(f?.confidence)?+f.confidence:null,\n        fogEngineType:f?.type?.text||f?.type||null\n      };\n"""
s = replace_once(s, old, new, 'FOG bridge')
write(p, s)

# 3. Engine 2.3: FOG score is direct FG evidence and >=50% prevailing FG/BR must be physically consistent with VIS.
p = 'taf-engine-v2.js'
s = read(p)
s = replace_once(s, "const VERSION='2.2.0';", "const VERSION='2.3.0';", 'engine version')
s = replace_once(s, "const NAME='TAF Engine 2.2 — Instruction First + EPIR Operational Policy';", "const NAME='TAF Engine 2.3 — Instruction First + EPIR Operational Policy';", 'engine name')

old = """    p.fog=Math.max(p.fog,prob(row?.fogRisk));\n    p.fg=Math.max(p.fg,prob(row?.fgRisk),prob(row?.fogVis1000Risk));\n    p.br=Math.max(p.br,prob(row?.brRisk));\n"""
new = """    const fogEngine=prob(row?.fogRisk);\n    p.fog=Math.max(p.fog,fogEngine);\n    // EPIR FOG ENGINE score is the event probability for FG. VIS thresholds refine severity, not whether the signal exists.\n    p.fg=Math.max(p.fg,fogEngine,prob(row?.fgRisk),prob(row?.fogVis1000Risk));\n    p.br=Math.max(p.br,prob(row?.brRisk));\n"""
s = replace_once(s, old, new, 'fog probability bridge')

old = """  function stateFromRow(row){\n    const p=probabilities(row),cs=cloudCandidates(row,p);\n    const ceiling=cs.filter(c=>!c.type&&(c.cover==='BKN'||c.cover==='OVC')).sort((a,b)=>a.ft-b.ft)[0]?.ft??(num(row?.ceiling)?+row.ceiling*FT:NaN);\n    const ws=num(row?.WS)?+row.WS*KT:0,g=num(row?.G)?+row.G*KT:ws;\n    return {\n      t:+row.t,windKt:ws,windDir:num(row.WD)?(+row.WD+360)%360:null,gustKt:g,dirSpreadDeg:num(row.dirSpread)?+row.dirSpread:0,\n      visM:num(row.VIS)?+row.VIS:10000,T:num(row.T)?+row.T:null,Td:num(row.Td)?+row.Td:null,RH:num(row.RH)?+row.RH:null,RR:num(row.RR)?+row.RR:0,\n      clouds:cs,ceilingFt:ceiling,prob:p,sourceRow:row\n    };\n  }\n"""
new = """  function stateFromRow(row){\n    const p=probabilities(row),cs=cloudCandidates(row,p);\n    const ceiling=cs.filter(c=>!c.type&&(c.cover==='BKN'||c.cover==='OVC')).sort((a,b)=>a.ft-b.ft)[0]?.ft??(num(row?.ceiling)?+row.ceiling*FT:NaN);\n    const ws=num(row?.WS)?+row.WS*KT:0,g=num(row?.G)?+row.G*KT:ws;\n    let visM=num(row.VIS)?+row.VIS:10000;\n    // A prevailing >=50% FG/BR forecast cannot coexist with a contradictory prevailing visibility.\n    if(p.fg>=.50&&p.fg>=p.br)visM=Math.min(visM,clamp(p.alt?.fgM||800,100,900));\n    else if(p.br>=.50&&p.br>p.fg)visM=Math.min(visM,clamp(p.alt?.brM||4000,1000,5000));\n    return {\n      t:+row.t,windKt:ws,windDir:num(row.WD)?(+row.WD+360)%360:null,gustKt:g,dirSpreadDeg:num(row.dirSpread)?+row.dirSpread:0,\n      visM,T:num(row.T)?+row.T:null,Td:num(row.Td)?+row.Td:null,RH:num(row.RH)?+row.RH:null,RR:num(row.RR)?+row.RR:0,\n      clouds:cs,ceilingFt:ceiling,prob:p,sourceRow:row\n    };\n  }\n"""
s = replace_once(s, old, new, 'prevailing fog physical consistency')

old = """    for(let i=1;i<states.length&&groups.length<MAX_GROUPS;i++){\n      let target=states[i],sig=significantFields(prevailing,target),fields=sig.fields;\n      if(!fields.length)continue;\n      let confidence=changeConfidence(target,fields),persist=persistenceFrom(states,i,target),returnH=returnsTo(states,i,prevailing);\n      const prevFog=fogFamily(prevailing,.5),targetFog=fogFamily(target,.5);\n      const fogAltProb=Math.max(target.prob?.fg||0,target.prob?.br||0);\n      const altFogFamily=(target.prob?.fg||0)>=.30&&(target.prob?.fg||0)>=(target.prob?.br||0)?'FG':(target.prob?.br||0)>=.30?'BR':'NONE';\n      const newFog=targetFog!=='NONE'&&targetFog!==prevFog;\n      const newFogAlternative=altFogFamily!=='NONE'&&altFogFamily!==prevFog;\n\n      // If fog/mist is an alternative 30–49%, encode it as PROB30 using the worst plausible FG/BR visibility.\n      if(newFogAlternative&&fogAltProb>=.30&&fogAltProb<.50){\n        target=alternativeFogState(prevailing,target);fields=[...new Set([...fields,'visibility'])];\n        const w=twoHourWindow(target.t,start,end),g={kind:'PROB30',s:w.s,e:w.e,fields,payload:payload(prevailing,target,fields,'PROB30',msaFt),probability:fogAltProb};\n        if(g.payload&&!conflicts(groups,g)){g.text=`PROB30 ${period(g.s,g.e)} ${g.payload}`;groups.push(g);reasons.push(`${g.text}: alternatywne FG/BR ${Math.round(fogAltProb*100)}%; TEMPO nie może służyć do prognozowania pojawienia się mgły/zamglenia.`);}continue;\n      }\n\n      if(confidence<.30){skipped.push(`${code(target.t)} UTC: zmiana <30% (${Math.round(confidence*100)}%).`);continue;}\n"""
new = """    for(let i=1;i<states.length&&groups.length<MAX_GROUPS;i++){\n      let target=states[i],sig=significantFields(prevailing,target),fields=sig.fields;\n      const prevFog=fogFamily(prevailing,.5),targetFog=fogFamily(target,.5);\n      const fogAltProb=Math.max(target.prob?.fg||0,target.prob?.br||0);\n      const altFogFamily=(target.prob?.fg||0)>=.30&&(target.prob?.fg||0)>=(target.prob?.br||0)?'FG':(target.prob?.br||0)>=.30?'BR':'NONE';\n      const newFog=targetFog!=='NONE'&&targetFog!==prevFog;\n      const newFogAlternative=altFogFamily!=='NONE'&&altFogFamily!==prevFog;\n\n      // FOG is an independent input. Do not discard a 30–49% FG/BR signal merely because the deterministic VIS/cloud/wind state did not cross a threshold first.\n      if(newFogAlternative&&fogAltProb>=.30&&fogAltProb<.50){\n        target=alternativeFogState(prevailing,target);fields=[...new Set([...fields,'visibility'])];\n        const w=twoHourWindow(target.t,start,end),g={kind:'PROB30',s:w.s,e:w.e,fields,payload:payload(prevailing,target,fields,'PROB30',msaFt),probability:fogAltProb};\n        if(g.payload&&!conflicts(groups,g)){g.text=`PROB30 ${period(g.s,g.e)} ${g.payload}`;groups.push(g);reasons.push(`${g.text}: alternatywne FG/BR ${Math.round(fogAltProb*100)}%; TEMPO nie może służyć do prognozowania pojawienia się mgły/zamglenia.`);}continue;\n      }\n\n      if(!fields.length)continue;\n      let confidence=changeConfidence(target,fields),persist=persistenceFrom(states,i,target),returnH=returnsTo(states,i,prevailing);\n      if(confidence<.30){skipped.push(`${code(target.t)} UTC: zmiana <30% (${Math.round(confidence*100)}%).`);continue;}\n"""
s = replace_once(s, old, new, 'independent fog trigger ordering')
write(p, s)

# 4. HTML cache/version bump.
p='taf.html'
s=read(p)
s=s.replace('content="2.2.0"','content="2.3.0"')
s=s.replace('TAF ENGINE 2.2.0 · INSTRUCTION FIRST','TAF ENGINE 2.3.0 · INSTRUCTION FIRST')
s=s.replace('TAF Engine 2.2.0','TAF Engine 2.3.0')
s=s.replace('taf-engine-v2.js?v=2.2.0','taf-engine-v2.js?v=2.3.0')
s=s.replace('taf-app-v2.js?v=2.2.0','taf-app-v2.js?v=2.3.0')
write(p,s)

# 5. Regression tests for the exact production failures.
p='tests/taf-engine-v2.test.js'
s=read(p)
s=s.replace("assert.equal(E.ENGINE_VERSION,'2.2.0');","assert.equal(E.ENGINE_VERSION,'2.3.0');")
s=s.replace("assert.ok(html.includes('taf-engine-v2.js?v=2.2.0'));assert.ok(html.includes('taf-app-v2.js?v=2.2.0'));","assert.ok(html.includes('taf-engine-v2.js?v=2.3.0'));assert.ok(html.includes('taf-app-v2.js?v=2.3.0'));")
s=s.replace("assert.ok(app.includes(\"fgRisk:num(f?.vis1000)\"),'fog engine FG probability must be passed separately');","assert.ok(app.includes('const fgRisk=Math.max(fogScore'),'FOG score must feed FG probability directly');")
s=s.replace("console.log('TAF Engine 2.1 tests: OK');","console.log('TAF Engine 2.3 tests: OK');")
anchor="""// PROB30 BR: one 2h probability window, never duplicate TEMPO/BECMG for the same event.\n"""
extra="""// FOG ENGINE >=50% is independent prevailing FG evidence even when deterministic VIS stays high.\nrows=Array.from({length:12},(_,i)=>row(i,{vis:8000,fogRisk:i>=4?65:0,fgRisk:i>=4?65:0,fogVis1000Risk:i>=4?55:0,fogAltVisM:800}));\nr=gen(rows);assert.ok(r.taf.includes('BECMG'),r.taf);assert.match(r.taf,/BECMG[^\\n]*0\\d{3} (?:FZ)?FG/,r.taf);\n\n// FOG ENGINE 30-49% must create PROB30 even with no deterministic threshold crossing.\nrows=Array.from({length:12},(_,i)=>row(i,{vis:8000,fogRisk:i===5?40:0,fgRisk:i===5?40:0,fogVis1000Risk:i===5?35:0,fogAltVisM:900}));\nr=gen(rows);assert.match(r.taf,/PROB30\\s+1404\\/1406\\s+0900\\s+(?:FZ)?FG/,r.taf);\n\n"""+anchor
s=replace_once(s,anchor,extra,'fog regressions')
write(p,s)

# 6. Canonical Pages deployment version and source guard verification.
p='.github/workflows/pages-v2.yml'
s=read(p)
s=s.replace('2.2.0','2.3.0')
# The source archive client now contains the guard; deployment must verify it, not wrap it a second time.
pattern=re.compile(r"\n          # Common archive client remains the data source, but legacy TAF mutators must not load on Engine 2\.\n          p=Path\('_site/message-archive-client\.js'\).*?          p\.write_text\(s,encoding='utf-8'\)\n",re.S)
replacement="""
          # Common archive client is source-guarded: Engine 2 must never load the legacy hybrid/mutator stack.
          p=Path('_site/message-archive-client.js')
          s=p.read_text(encoding='utf-8')
          if 'prognozaepir-taf-engine-v2' not in s:
              raise SystemExit('Brak source guard dla legacy TAF runtime')
"""
s,n=pattern.subn(replacement,s,count=1)
if n!=1:
    raise SystemExit('pages-v2 legacy guard block not found')
s=s.replace('fogUntil=Date.now()+8000','fogUntil=Date.now()+15000')
write(p,s)

# 7. Retire the competing legacy automatic Pages deploy. It remains manual only for emergency use.
p='.github/workflows/pages.yml'
s=read(p)
s=s.replace("on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n","on:\n  workflow_dispatch:\n",1)
write(p,s)
