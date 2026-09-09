#!/usr/bin/env python3
from pathlib import Path

P = Path('taf-verification.js')
s = P.read_text(encoding='utf-8')

# Each missing element costs 10 points, then the total is normalized by the
# number of change groups in the TAF. Example: one group with missing
# VIS + WX + CLOUD => (10 * 3) / 1 = -30 points.
CONST = "  const GROUP_ELEMENT_PENALTY=10;\n"
if 'GROUP_ELEMENT_PENALTY=10' not in s:
    anchor = "  const LABELS={wind:'Wiatr',vis:'Widzialność',ceiling:'Pułap',wx:'Pogoda'};\n"
    if anchor not in s:
        raise SystemExit('TAF group penalty: LABELS anchor not found')
    s = s.replace(anchor, anchor + CONST, 1)

HELPERS = r'''  function groupElementKeys(f){
    const keys=[];
    if(finite(f.windKt))keys.push('WIND');
    if(Object.prototype.hasOwnProperty.call(f,'vis'))keys.push('VIS');
    if(Object.prototype.hasOwnProperty.call(f,'wxFamily'))keys.push('WX');
    if(Object.prototype.hasOwnProperty.call(f,'clouds'))keys.push('CLOUD');
    return keys;
  }
  function groupElementMatch(f,o,key){
    if(key==='WIND')return componentHits(f,o).wind===true;
    if(key==='VIS')return f.vis>=10000?finite(o.vis)&&o.vis>=10000:finite(o.vis)&&o.vis<10000&&o.vis<=f.vis;
    if(key==='WX'){
      const family=f.wxFamily??'NONE',forecastWx=wxTokens(f.wx||'');
      if(family==='NONE')return (o.wxFamily??'NONE')==='NONE';
      return forecastWx.length?forecastWx.every(x=>(o.wxTokens||[]).includes(x)):family===(o.wxFamily??'NONE');
    }
    if(key==='CLOUD'){
      const fc=f.clouds||[],oc=o.clouds||[],conv=fc.filter(c=>c.type==='CB'||c.type==='TCU');
      if(conv.length)return conv.every(c=>oc.some(x=>x.type===c.type&&coverRank(x.cover)>=coverRank(c.cover)&&Math.abs(x.ft-c.ft)<=1000));
      if(f.cavok)return !oc.some(c=>c.ft<4921)&&!oc.some(c=>c.type==='CB'||c.type==='TCU');
      if(f.nsc)return !oc.some(c=>c.ft<5000)&&!oc.some(c=>c.type==='CB'||c.type==='TCU');
      if(fc.some(c=>c.cover==='BKN'||c.cover==='OVC'))return componentHits(f,o).ceiling===true;
      if(fc.length)return fc.every(c=>oc.some(x=>coverRank(x.cover)>=coverRank(c.cover)&&Math.abs(x.ft-c.ft)<=1000));
      return true;
    }
    return false;
  }
  function groupElementPenalties(p,obs){
    const groups=[],byToken=new Map();let total=0;
    const changeCount=Math.max(1,p.events.length);
    for(const e of p.events){
      const relevant=obs.filter(o=>o.t>=e.s&&o.t<(e.e||p.ve));
      const keys=groupElementKeys(e.state);
      if(!relevant.length||!keys.length){
        const item={token:e.token,kind:e.kind,missing:[],penalty:0,elements:keys.length,verifiable:relevant.length>0};
        groups.push(item);byToken.set(e.token,item);continue;
      }
      const missing=keys.filter(k=>!relevant.some(o=>groupElementMatch(e.state,o,k)));
      // Each missing element costs 10 points, normalized by number of change groups.
      // Example: one group, VIS + WX + CLOUD all missing => (10 * 3) / 1 = -30.
      // With two change groups the same three misses contribute -15 points.
      const penalty=Math.round((GROUP_ELEMENT_PENALTY*missing.length/changeCount)*10)/10;
      total+=penalty;
      const item={token:e.token,kind:e.kind,missing,penalty,elements:keys.length,verifiable:true};
      groups.push(item);byToken.set(e.token,item);
    }
    return{total:Math.round(total*10)/10,groups,byToken};
  }
'''
helper_start = s.find('  function groupElementKeys(f){\n')
group_start = s.find('  function groupSummary(p,obs){\n', helper_start if helper_start >= 0 else 0)
if helper_start >= 0 and group_start > helper_start:
    s = s[:helper_start] + HELPERS + s[group_start:]
elif 'function groupElementPenalties(p,obs)' not in s:
    anchor = '  function groupSummary(p,obs){\n'
    if anchor not in s:
        raise SystemExit('TAF group penalty: groupSummary anchor not found')
    s = s.replace(anchor, HELPERS + anchor, 1)

START = s.find('  function groupSummary(p,obs){\n')
END = s.find('  async function evaluateEntry(entry){\n', START)
if START < 0 or END < 0:
    raise SystemExit('TAF group penalty: groupSummary block not found')
NEW_GROUP_SUMMARY = r'''  function groupSummary(p,obs){
    const out=[],penalties=groupElementPenalties(p,obs).byToken;
    for(const e of p.events){
      const relevant=obs.filter(o=>o.t>=e.s&&o.t<(e.e||p.ve));
      const gp=penalties.get(e.token)||{missing:[],penalty:0};
      const penaltyText=gp.penalty?` · nie wystąpiło: ${gp.missing.join(', ')} · -${gp.penalty} pkt`:'';
      if(!relevant.length){out.push({kind:e.kind,token:e.token,status:'brak METAR w okresie — bez kary',ok:null,penalty:0,missing:[]});continue}
      if(e.kind==='FM'||e.kind==='BECMG'){
        let good=0,total=0;
        for(const o of relevant){
          const h=componentHits(statesAt(p,o.t).base,o);
          for(const k of PARAMS)if(typeof h[k]==='boolean'){total++;if(h[k])good++}
        }
        out.push({kind:e.kind,token:e.token,status:(total?`${pct(good,total)}% zgodności po zmianie`:'brak danych')+penaltyText,ok:total?good/total>=.75:null,penalty:gp.penalty,missing:gp.missing});
      }else{
        let observed=false;
        for(const o of relevant){if(strictGroupMatch(e.state,o)){observed=true;break}}
        const prob=e.kind.startsWith('PROB30');
        let status=observed?'warunki grupy zaobserwowano':prob?'warunków grupy nie zaobserwowano':'grupy nie potwierdzono';
        status+=penaltyText;
        out.push({kind:e.kind,token:e.token,status,ok:prob?null:observed,penalty:gp.penalty,missing:gp.missing});
      }
    }
    return out;
  }
'''
s = s[:START] + NEW_GROUP_SUMMARY + s[END:]

OLD_SCORE = "    const rates=Object.fromEntries(PARAMS.map(k=>[k,pct(counts[k][0],counts[k][1])]));\n    const valid=Object.values(rates).filter(finite),overall=valid.length?Math.round(valid.reduce((a,b)=>a+b,0)/valid.length):null;\n    return{entry,p,obs:obs.length,expected:Math.round((p.ve-p.vs)/1800e3),counts,rates,covered,overall,speedMae:seN?se/seN:null,dirMae:deN?de/deN:null,misses,groups:groupSummary(p,obs),final:Date.now()>=p.ve};\n"
NEW_SCORE = "    const rates=Object.fromEntries(PARAMS.map(k=>[k,pct(counts[k][0],counts[k][1])]));\n    const valid=Object.values(rates).filter(finite),rawOverall=valid.length?Math.round(valid.reduce((a,b)=>a+b,0)/valid.length):null;\n    const groupPenalty=groupElementPenalties(p,obs).total;\n    const overall=finite(rawOverall)?Math.max(0,rawOverall-groupPenalty):null;\n    return{entry,p,obs:obs.length,expected:Math.round((p.ve-p.vs)/1800e3),counts,rates,covered,rawOverall,groupPenalty,overall,speedMae:seN?se/seN:null,dirMae:deN?de/deN:null,misses,groups:groupSummary(p,obs),final:Date.now()>=p.ve};\n"
if OLD_SCORE in s:
    s = s.replace(OLD_SCORE, NEW_SCORE, 1)
elif 'const groupPenalty=groupElementPenalties(p,obs).total;' not in s:
    raise SystemExit('TAF group penalty: evaluateEntry scoring anchor not found')

OLD_AGG = "    const rates=Object.fromEntries(PARAMS.map(k=>[k,pct(counts[k][0],counts[k][1])]));\n    const vals=Object.values(rates).filter(finite),overall=vals.length?Math.round(vals.reduce((a,b)=>a+b,0)/vals.length):null;\n    return{counts,rates,overall};\n"
NEW_AGG = "    const rates=Object.fromEntries(PARAMS.map(k=>[k,pct(counts[k][0],counts[k][1])]));\n    const vals=Object.values(rates).filter(finite),rawOverall=vals.length?Math.round(vals.reduce((a,b)=>a+b,0)/vals.length):null;\n    const ps=results.map(x=>x.groupPenalty).filter(finite),groupPenalty=ps.length?Math.round(ps.reduce((a,b)=>a+b,0)/ps.length):0;\n    const overall=finite(rawOverall)?Math.max(0,rawOverall-groupPenalty):null;\n    return{counts,rates,rawOverall,groupPenalty,overall};\n"
if OLD_AGG in s:
    s = s.replace(OLD_AGG, NEW_AGG, 1)
elif 'const ps=results.map(x=>x.groupPenalty)' not in s:
    raise SystemExit('TAF group penalty: aggregate scoring anchor not found')

required = [
    'GROUP_ELEMENT_PENALTY=10',
    'function groupElementPenalties(p,obs)',
    'const changeCount=Math.max(1,p.events.length);',
    'GROUP_ELEMENT_PENALTY*missing.length/changeCount',
    'Math.max(0,rawOverall-groupPenalty)',
    "brak METAR w okresie — bez kary",
]
for token in required:
    if token not in s:
        raise SystemExit(f'TAF group penalty: required token missing: {token}')

P.write_text(s, encoding='utf-8')
print('TAF verification: missing-element penalty enforced (10 * missing elements / change groups)')
