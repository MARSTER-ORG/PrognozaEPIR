from pathlib import Path


def read(path):
    return Path(path).read_text(encoding='utf-8')


def write(path, text):
    Path(path).write_text(text, encoding='utf-8')


def rep(text, old, new, label):
    if old not in text:
        raise SystemExit(f'{label}: marker not found')
    return text.replace(old, new, 1)


# TAF engine 2.2
p = 'taf-engine-v2.js'
s = read(p)
s = rep(s, "const VERSION='2.1.0';", "const VERSION='2.2.0';", 'engine version')
s = rep(s, "const NAME='TAF Engine 2.1 — Instruction First';", "const NAME='TAF Engine 2.2 — Instruction First + EPIR Operational Policy';", 'engine name')
s = rep(s, """    ordinaryCloudOperationalLimitFt:5000,
    cloudAmountChangeLimitFt:1500
""", """    ordinaryCloudOperationalLimitFt:5000,
    cloudAmountChangeLimitFt:1500,
    weakCloudObservationGateMin:.25,
    weakCloudObservationToleranceLowFt:700,
    weakCloudObservationToleranceFt:900,
    lowWindWholePeriodMinFraction:.75,
    lowWindRunMinHours:3,
    lowWindMaxOtherKt:10,
    baseFirstHoursEqualWeight:true
""", 'rules')

s = rep(s, r"""    const tm=raw.match(/\b(M?\d{2})\/(M?\d{2})\b/);
    const val=s=>s&&s[0]==='M'?-Number(s.slice(1)):Number(s);
""", r"""    const tm=raw.match(/\b(M?\d{2})\/(M?\d{2})\b/);
    const clouds=[...raw.matchAll(/\b(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?\b/g)].map(m=>({cover:m[1],ft:+m[2]*100,type:m[3]||'',okta:({FEW:2,SCT:4,BKN:6,OVC:8})[m[1]]}));
    const val=s=>s&&s[0]==='M'?-Number(s.slice(1)):Number(s);
""", 'observation cloud parser')
s = rep(s, """      T:num(o.temperature_c)?+o.temperature_c:(tm?val(tm[1]):null),
      Td:num(o.dew_point_c)?+o.dew_point_c:num(o.dewpoint_c)?+o.dewpoint_c:(tm?val(tm[2]):null)
""", """      T:num(o.temperature_c)?+o.temperature_c:(tm?val(tm[1]):null),
      Td:num(o.dew_point_c)?+o.dew_point_c:num(o.dewpoint_c)?+o.dewpoint_c:(tm?val(tm[2]):null),
      clouds,cavok:/\\bCAVOK\\b/.test(raw),nsc:/\\b(?:NSC|NCD)\\b/.test(raw)
""", 'observation cloud fields')
s = rep(s, """      const z={...r};const lead=Math.max(0,(+z.t-o.t)/HOUR),a=.78*Math.exp(-lead/4.5)*fresh;
      if(a<.02)return z;
""", """      const z={...r};const lead=Math.max(0,(+z.t-o.t)/HOUR),a=.78*Math.exp(-lead/4.5)*fresh;
      z.observationClouds=(o.clouds||[]).map(c=>({...c}));
      z.observationCavok=!!o.cavok;z.observationNsc=!!o.nsc;
      z.observationCloudWeight=Math.exp(-lead/6);
      if(a<.02)return z;
""", 'cloud anchor context')

marker = """  function cloudCandidates(row,p){
"""
add = """  function cloudCandidateCredible(row,c){
    if(!c||c.type==='CB'||c.type==='TCU')return true;
    if(c.cover!=='FEW'&&c.cover!=='SCT')return true;
    const w=+row?.observationCloudWeight||0;
    if(w<RULES.weakCloudObservationGateMin)return true;
    const obs=Array.isArray(row?.observationClouds)?row.observationClouds:[];
    if(!obs.length&&!row?.observationCavok&&!row?.observationNsc)return true;
    const tol=c.ft<1500?RULES.weakCloudObservationToleranceLowFt:RULES.weakCloudObservationToleranceFt;
    return obs.some(o=>finite(+o.ft)&&Math.abs(+o.ft-c.ft)<=tol&&amountRank(o.cover)>=amountRank(c.cover));
  }

""" + marker
s = rep(s, marker, add, 'cloud credibility helper')
s = rep(s, """    // Ceiling is authoritative for the lowest BKN/OVC. Ensure clouds and ceiling cannot contradict each other.
""", """    // Recent METAR/SPECI is a credibility gate for weak model-only FEW/SCT. Its influence decays with lead time.
    a=a.filter(c=>cloudCandidateCredible(row,c));
    // Ceiling is authoritative for the lowest BKN/OVC. Ensure clouds and ceiling cannot contradict each other.
""", 'cloud credibility application')

wind_marker = """  function windToken(s){
"""
wind_add = """  function applyWindPolicy(states){
    const out=(states||[]).map(s=>({...s}));
    if(!out.length)return out;
    const raw=s=>Math.max(0,+s.windKt||0),coded=s=>even(raw(s));
    const light=s=>raw(s)>=1&&coded(s)<=2;
    const dominant=out.filter(s=>coded(s)<=2).length>=Math.ceil(out.length*RULES.lowWindWholePeriodMinFraction)
      &&Math.max(...out.map(coded))<=RULES.lowWindMaxOtherKt;
    for(let i=0;i<out.length;){
      if(!light(out[i])){i++;continue;}
      let j=i+1;while(j<out.length&&light(out[j]))j++;
      if(j-i>=RULES.lowWindRunMinHours)for(let k=i;k<j;k++)out[k].forceVrb=true;
      i=j;
    }
    for(const s of out){s.periodVrbDominant=dominant;if(dominant&&light(s))s.forceVrb=true;}
    return out;
  }

""" + wind_marker
s = rep(s, wind_marker, wind_add, 'wind policy helper')
s = rep(s, """    const sp=even(raw),vrb=!finite(s.windDir)||(sp<3&&(+s.dirSpreadDeg||0)>=60),dir=vrb?'VRB':pad((((Math.round(+s.windDir/10)*10)%360)||360),3);
""", """    const sp=even(raw),vrb=s.forceVrb===true||!finite(s.windDir)||(sp<3&&(+s.dirSpreadDeg||0)>=60),dir=vrb?'VRB':pad((((Math.round(+s.windDir/10)*10)%360)||360),3);
""", 'wind token force VRB')

s = rep(s, """    const ww=z.map((x,i)=>1/(1+i*.35));
""", """    const ww=z.map(()=>1);
""", 'equal first-hour weights')
s = rep(s, """    s.clouds=z[0].clouds;s.ceilingFt=z[0].ceilingFt;
    return s;
""", """    s.clouds=z[0].clouds;s.ceilingFt=z[0].ceilingFt;
    if(states.some(x=>x.periodVrbDominant)){
      const allCalm=states.every(x=>(+x.windKt||0)<1);
      s.windKt=allCalm?0:2;s.windDir=null;s.gustKt=s.windKt;s.dirSpreadDeg=180;s.forceVrb=!allCalm;s.periodVrbDominant=true;
    }
    return s;
""", 'dominant base VRB')

s = rep(s, """        const anchored=input.rowsAlreadyAnchored?raw.map(r=>({...r})):anchorRows(raw,input.observation,start);
        const states=anchored.map(stateFromRow),base=baseState(states),msa=num(input.msaFt)&&+input.msaFt>0?+input.msaFt:null;
        const cg=buildChangeGroups(states,base,start,end,msa);
""", """        const anchored=input.rowsAlreadyAnchored?raw.map(r=>({...r})):anchorRows(raw,input.observation,start);
        const msa=num(input.msaFt)&&+input.msaFt>0?+input.msaFt:null;
        let states=anchored.map(stateFromRow);states=applyWindPolicy(states);
        const base=baseState(states),cg=buildChangeGroups(states,base,start,end,msa);
""", 'generation policy order')
s = rep(s, """          diagnostics:{instructionLocked:true,authority:AUTH,reasons:cg.reasons,msaMode:msa?'explicit':'fallback',msaFt:msa||NSC_FT,cloudPipeline:'profile→layers→ceiling→TAF/table',legacyMutators:false},
""", """          diagnostics:{instructionLocked:true,authority:AUTH,reasons:cg.reasons,msaMode:msa?'explicit':'fallback',msaFt:msa||NSC_FT,cloudPipeline:'profile→METAR credibility gate→instruction layer order→ceiling→TAF/table',windPolicy:'VRB02: 75%/12h dominant or sustained >=3h hourly; weak-direction change alone never creates BECMG',legacyMutators:false},
""", 'diagnostics')
s = s.replace('profileCloudCandidates,tempoAllowed,fogFamily', 'profileCloudCandidates,cloudCandidateCredible,applyWindPolicy,tempoAllowed,fogFamily')
write(p, s)

# Tests
p = 'tests/taf-engine-v2.test.js'
s = read(p)
s = s.replace("assert.equal(E.ENGINE_VERSION,'2.1.0');", "assert.equal(E.ENGINE_VERSION,'2.2.0');", 1)
s = rep(s, """const W=E.helpers.windToken;assert.equal(W({windKt:.4,windDir:220,gustKt:5,dirSpreadDeg:0}),'00000KT');assert.equal(W({windKt:13,windDir:274,gustKt:23,dirSpreadDeg:0}),'27014G24KT');assert.equal(W({windKt:2,windDir:220,gustKt:2,dirSpreadDeg:10}),'22002KT');
""", """const W=E.helpers.windToken;assert.equal(W({windKt:.4,windDir:220,gustKt:5,dirSpreadDeg:0}),'00000KT');assert.equal(W({windKt:13,windDir:274,gustKt:23,dirSpreadDeg:0}),'27014G24KT');assert.equal(W({windKt:2,windDir:220,gustKt:2,dirSpreadDeg:10}),'22002KT');assert.equal(W({windKt:2,windDir:220,gustKt:2,dirSpreadDeg:10,forceVrb:true}),'VRB02KT');
""", 'wind token test')
anchor = """// Hard gate basics.
"""
extra = """// Recent METAR/SPECI must reject unsupported model-only thin cloud layers while retaining a supported ceiling.
rows=Array.from({length:12},(_,i)=>row(i,{vis:9999,kt:6,dir:200,profile:[{agl:61,cc:6.25},{agl:457,cc:31.25},{agl:1067,cc:62.5},{agl:1500,cc:70}],ceiling:1067}));
const obs={raw:'EPIR 132100Z AUTO 17008KT 9999 FEW028 BKN035 BKN042 18/14 Q1017',obs_time:new Date(start-3*H).toISOString()};
r=gen(rows,{observation:obs,rowsAlreadyAnchored:false});
assert.match(r.base.text,/\\bBKN035\\b/,r.base.text);assert.ok(!/\\bFEW\\d{3}\\b/.test(r.base.text),r.base.text);assert.ok(!/\\bSCT\\d{3}\\b/.test(r.base.text),r.base.text);

// Sustained light-wind hours are displayed as VRB02KT, but weak wind changes alone must not invent BECMG.
rows=Array.from({length:12},(_,i)=>row(i,{kt:i<7?6:2,dir:[200,200,200,200,200,200,200,210,240,280,320,20][i]}));
r=gen(rows);for(let i=7;i<12;i++)assert.equal(r.hourly[i].tafDisplay.wind,'VRB02KT');assert.ok(!r.taf.includes('BECMG'),r.taf);

// Existing project rule: >=75% of the 12 h at <=02KT, with no remaining hour >10KT, makes the prevailing base VRB02KT.
rows=Array.from({length:12},(_,i)=>row(i,{kt:i<9?2:6,dir:(180+i*20)%360}));
r=gen(rows);assert.match(r.base.text,/^VRB02KT\\b/,r.base.text);

""" + anchor
s = rep(s, anchor, extra, 'new regression tests')
s = s.replace("html.includes('taf-engine-v2.js?v=2.1.0')", "html.includes('taf-engine-v2.js?v=2.2.0')")
s = s.replace("html.includes('taf-app-v2.js?v=2.1.0')", "html.includes('taf-app-v2.js?v=2.2.0')")
write(p, s)

# App source: version and source-level FG readiness
p = 'taf-app-v2.js'
s = read(p)
s = s.replace('__PROGNOZA_EPIR_TAF_APP_V21__', '__PROGNOZA_EPIR_TAF_APP_V22__')
s = s.replace('TAF ENGINE 2.1', 'TAF ENGINE 2.2')
s = s.replace('[TAF Engine 2.1]', '[TAF Engine 2.2]')
old = """    let fog=[],mifg=[];
    try{fog=w.PrognozaEPIRFogSeries||[];}catch(_){}
"""
new = """    let fog=[],mifg=[];
    try{
      const fogUntil=Date.now()+8000;
      do{
        fog=w.PrognozaEPIRFogSeries||[];
        if(fog.length)break;
        await new Promise(r=>setTimeout(r,250));
      }while(Date.now()<fogUntil);
    }catch(_){}
"""
s = rep(s, old, new, 'source fog wait')
write(p, s)

# HTML source
p = 'taf.html'
s = read(p)
s = s.replace('2.1.0', '2.2.0')
marker = '<meta name="prognozaepir-taf-engine-v2" content="2.2.0">'
if marker not in s:
    s = s.replace('<meta name="color-scheme" content="dark">', '<meta name="color-scheme" content="dark">\n  ' + marker, 1)
write(p, s)

# Canonical Pages v2 pipeline
p = '.github/workflows/pages-v2.yml'
s = read(p)
s = s.replace('2.1.0', '2.2.0')
old = """          if old not in s:
              raise SystemExit('Nie znaleziono odczytu PrognozaEPIRFogSeries')
          s=s.replace(old,new,1)
"""
new = """          if old in s:
              s=s.replace(old,new,1)
          elif 'fogUntil=Date.now()+8000' not in s:
              raise SystemExit('Nie znaleziono odczytu PrognozaEPIRFogSeries ani gotowego waitera')
"""
s = rep(s, old, new, 'idempotent FG deploy patch')
write(p, s)

# Disable obsolete competing Pages push deployment; pages-v2 remains authoritative.
p = '.github/workflows/pages.yml'
s = read(p)
s = rep(s, """on:
  push:
    branches: [main]
  workflow_dispatch:
""", """on:
  workflow_dispatch:
""", 'disable legacy pages push')
write(p, s)
