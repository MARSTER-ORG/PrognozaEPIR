#!/usr/bin/env python3
"""Keep TAF verification on the live central MessageArchive and make group checks strict.

The verifier is historical/verification-only. For the current UTC day it must
see the same fresh EPIR TAF and METAR records as the generator. Railway is the
first archive transport; Pages/raw GitHub are fallbacks only.

TEMPO/PROB30 group verification is deliberately stricter than the broad score:
a group is reported as observed only when one valid METAR/SPECI inside the
period satisfies every parameter explicitly present in that group. This avoids
calling 9999/CAVOK a hit for forecast 6000, plain RA a hit for SHRA, or ordinary
cloud a hit for a CB/TCU group.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "taf-verification.js"
LIVE_BASE = "https://central-ingestor-production.up.railway.app/data/messages/"
RAW_BASE = "https://raw.githubusercontent.com/MARSTER-ORG/PrognozaEPIR/main/data/messages/"


def replace_section(text: str, start_marker: str, end_marker: str, replacement: str, name: str) -> str:
    start = text.find(start_marker)
    if start < 0:
        raise SystemExit(f"TAF verification section missing: {name} start")
    end = text.find(end_marker, start)
    if end < 0:
        raise SystemExit(f"TAF verification section missing: {name} end")
    return text[:start] + replacement + text[end:]


def must_replace(text: str, old: str, new: str, name: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise SystemExit(f"TAF verification strict anchor missing: {name}")
    return text.replace(old, new, 1)


def enforce_strict_group_verification(s: str) -> str:
    # Keep the display version explicit so a screenshot immediately tells us
    # whether strict group semantics are present.
    s = s.replace("const VERSION='TAF Verification v2.0';", "const VERSION='TAF Verification v2.1';", 1)

    helpers = r'''  function strictObservationRecord(o){
    const raw=String(o?.canonical_raw||o?.raw||'').replace(/\s+/g,' ').trim();
    return /^(?:(?:METAR|SPECI)\s+)?(?:COR\s+)?EPIR\s+\d{6}Z(?:\s+AUTO)?\s+(?:\d{3}|VRB)\d{2,3}(?:G(?:P99|\d{2,3}))?KT\b/i.test(raw);
  }
  function wxTokens(raw){
    return (String(raw||'').toUpperCase().match(/\b(?:\+|-)?(?:MIFG|FZFG|FG|BR|HZ|TSRA|TSGR|TS|SHRA|SHSN|RASN|SNRA|FZRA|FZDZ|RA|DZ|SN|GR|GS|SQ)\b/g)||[]).map(x=>x.replace(/^[+-]/,''));
  }
  function coverRank(c){return({FEW:1,SCT:2,BKN:3,OVC:4})[String(c||'').toUpperCase()]||0}
  function strictGroupMatch(f,o){
    const checks=[];
    if(finite(f.windKt))checks.push(componentHits(f,o).wind===true);
    if(Object.prototype.hasOwnProperty.call(f,'vis')){
      checks.push(f.vis>=10000?finite(o.vis)&&o.vis>=10000:finite(o.vis)&&o.vis<10000&&o.vis<=f.vis);
    }
    if(Object.prototype.hasOwnProperty.call(f,'wxFamily')){
      const family=f.wxFamily??'NONE',forecastWx=wxTokens(f.wx||'');
      if(family==='NONE')checks.push((o.wxFamily??'NONE')==='NONE');
      else checks.push(forecastWx.length?forecastWx.every(x=>(o.wxTokens||[]).includes(x)):family===(o.wxFamily??'NONE'));
    }
    if(Object.prototype.hasOwnProperty.call(f,'clouds')){
      const fc=f.clouds||[],conv=fc.filter(c=>c.type==='CB'||c.type==='TCU');
      if(conv.length){
        checks.push(conv.every(c=>(o.clouds||[]).some(x=>x.type===c.type&&coverRank(x.cover)>=coverRank(c.cover)&&Math.abs(x.ft-c.ft)<=1000)));
      }else if(f.cavok||f.nsc){
        checks.push(!(o.clouds||[]).some(c=>c.ft<4921));
      }else if(fc.some(c=>c.cover==='BKN'||c.cover==='OVC')){
        checks.push(componentHits(f,o).ceiling===true);
      }
    }
    return checks.length>0&&checks.every(Boolean);
  }
'''
    if "function strictObservationRecord(o)" not in s:
        marker = "  function part(txt){\n"
        if marker not in s:
            raise SystemExit("TAF verification strict helper insertion anchor missing")
        s = s.replace(marker, helpers + marker, 1)

    s = must_replace(
        s,
        "    const clouds=[...raw.matchAll(/\\b(FEW|SCT|BKN|OVC)(\\d{3})/g)].map(m=>({cover:m[1],ft:+m[2]*100}));",
        "    const clouds=[...raw.matchAll(/\\b(FEW|SCT|BKN|OVC)(\\d{3})(CB|TCU)?\\b/g)].map(m=>({cover:m[1],ft:+m[2]*100,type:m[3]||''}));",
        "METAR cloud type parser",
    )
    s = must_replace(
        s,
        "wxFamily:wxFamily(raw),raw};",
        "wxFamily:wxFamily(raw),wxTokens:wxTokens(raw),clouds,raw};",
        "METAR exact weather/cloud export",
    )

    old_obs = """    for(const o of chunks.flat()){
      const t=Date.parse(o.obs_time||0);
      if(t>=p.vs&&t<p.ve)map.set(o.obs_time,o);
    }
"""
    new_obs = """    for(const o of chunks.flat()){
      if(!strictObservationRecord(o))continue;
      const t=Date.parse(o.obs_time||0);
      if(t>=p.vs&&t<p.ve)map.set(o.obs_time,o);
    }
"""
    s = must_replace(s, old_obs, new_obs, "strict central METAR record filter")

    old_group = """        for(const o of relevant){
          const base=statesAt(p,o.t).base,alt=merge(base,e.state),h=componentHits(alt,o);
          const keys=[];
          if(finite(e.state.windKt))keys.push('wind');
          if(finite(e.state.vis))keys.push('vis');
          if(Object.prototype.hasOwnProperty.call(e.state,'ceilingFt'))keys.push('ceiling');
          if(Object.prototype.hasOwnProperty.call(e.state,'wxFamily'))keys.push('wx');
          const used=keys.length?keys:PARAMS.filter(k=>typeof h[k]==='boolean');
          if(used.length&&used.every(k=>h[k]===true)){observed=true;break}
        }
"""
    new_group = """        for(const o of relevant){
          if(strictGroupMatch(e.state,o)){observed=true;break}
        }
"""
    # The proportional group-penalty layer may compact this loop to one line.
    # Treat either formatting as the same already-enforced strict invariant.
    if "if(strictGroupMatch(e.state,o))" not in s:
        s = must_replace(s, old_group, new_group, "strict TEMPO/PROB30 occurrence test")

    old_note = "TEMPO/PROB30 może pokryć obserwowane odchylenie. PROB30 nie jest oceniane jako „trafione/nietrafione” na podstawie jednego przypadku."
    new_note = "TEMPO/PROB30 może pokryć obserwowane odchylenie. Status „warunki grupy zaobserwowano” wymaga jednego METAR/SPECI w okresie, który jednocześnie spełnia wszystkie jawnie prognozowane elementy grupy: VIS, dokładny rodzaj WX oraz CB/TCU z ilością i podstawą. PROB30 nie jest oceniane jako „trafione/nietrafione” na podstawie jednego przypadku."
    s = s.replace(old_note, new_note, 1)

    required = (
        "function strictObservationRecord(o)",
        "function strictGroupMatch(f,o)",
        "wxTokens:wxTokens(raw),clouds,raw",
        "if(!strictObservationRecord(o))continue",
        "if(strictGroupMatch(e.state,o))",
        "TAF Verification v2.1",
    )
    for token in required:
        if token not in s:
            raise SystemExit(f"strict TAF verification invariant missing: {token}")
    return s


def main() -> int:
    s = TARGET.read_text(encoding="utf-8")
    before = s

    # Keep both archive bases deterministic and never duplicate their constants
    # when this fixer runs repeatedly from GitHub Actions.
    live_line = f"  const LIVE_ARCHIVE_BASE='{LIVE_BASE}';"
    raw_line = f"  const CENTRAL_RAW_BASE='{RAW_BASE}';"
    if "const LIVE_ARCHIVE_BASE=" in s:
        s = re.sub(r"  const LIVE_ARCHIVE_BASE='[^']*';", live_line, s, count=1)
    else:
        anchor = re.search(r"  const CENTRAL_RAW_BASE='[^']*';", s)
        if not anchor:
            raise SystemExit("TAF verification archive base anchor missing")
        s = s[:anchor.start()] + live_line + "\n" + s[anchor.start():]
    s = re.sub(r"  const CENTRAL_RAW_BASE='[^']*';", raw_line, s, count=1)

    canonical_urls = """  function centralDayUrls(kind,day){
    const [y,m,d]=day.split('-'),stamp=Date.now();
    return [
      `${LIVE_ARCHIVE_BASE}${kind}/${y}/${m}/${d}.jsonl?live=${stamp}`,
      `data/messages/${kind}/${y}/${m}/${d}.jsonl?pages=${stamp}`,
      `${CENTRAL_RAW_BASE}${kind}/${y}/${m}/${d}.jsonl?raw=${stamp}`
    ];
  }
"""
    s = replace_section(
        s,
        "  function centralDayUrls(kind,day){\n",
        "  async function fetchMetarDay(day){\n",
        canonical_urls,
        "centralDayUrls",
    )

    current_reader = """  async function fetchCurrentTaf(){
    try{
      const A=window.PrognozaEPIRMessageArchive;
      if(A?.getLatest)return await A.getLatest('TAF','EPIR',true);
      const latest=A?.latest?await A.latest(true):null;
      return latest?.taf_by_station?.EPIR||latest?.taf||null;
    }catch(_){return null}
  }
"""
    if "async function fetchCurrentTaf()" not in s:
        anchor = "  function normalizeRecord(r){\n"
        if anchor not in s:
            raise SystemExit("TAF verification normalizeRecord anchor missing")
        s = s.replace(anchor, current_reader + anchor, 1)

    old_dates = "    const issue=Date.parse(r.issue_time||0),vs=Date.parse(r.valid_start||0),ve=Date.parse(r.valid_end||0);"
    new_dates = "    const issue=r.issue_time?Date.parse(r.issue_time):NaN,vs=r.valid_start?Date.parse(r.valid_start):NaN,ve=r.valid_end?Date.parse(r.valid_end):NaN;"
    if old_dates in s:
        s = s.replace(old_dates, new_dates, 1)
    elif new_dates not in s:
        raise SystemExit("TAF verification stored validity parser anchor missing")

    canonical_tafs = r"""  async function tafsForValidityDay(day){
    const target=dayStart(day),end=target+864e5;
    const issueDays=[shiftDay(day,-1),day];
    const [chunks,current]=await Promise.all([Promise.all(issueDays.map(fetchTafIssueDay)),fetchCurrentTaf()]);
    const entries=chunks.flat().map(normalizeRecord).filter(Boolean).filter(e=>e.p.ve>target&&e.p.vs<end);
    const live=normalizeRecord(current);
    if(live&&live.p.ve>target&&live.p.vs<end)entries.push(live);
    const seen=new Set(),unique=[];
    for(const e of entries.sort((a,b)=>a.p.issue-b.p.issue)){
      const key=e.raw.replace(/\s+/g,' ').trim();
      if(seen.has(key))continue;seen.add(key);unique.push(e);
    }
    return unique.sort((a,b)=>a.p.vs-b.p.vs||a.p.issue-b.p.issue);
  }
"""
    s = replace_section(
        s,
        "  async function tafsForValidityDay(day){\n",
        "  function forecastText(f){\n",
        canonical_tafs,
        "tafsForValidityDay",
    )

    s = s.replace(
        "VERSION+' · auto 60 s · dane TAF tylko do weryfikacji'",
        "VERSION+' · LIVE Railway/MessageArchive · auto 60 s · dane TAF tylko do weryfikacji'",
    )

    s = enforce_strict_group_verification(s)

    if s.count("const LIVE_ARCHIVE_BASE=") != 1:
        raise SystemExit("TAF verification has duplicated LIVE_ARCHIVE_BASE")
    if s.count("function centralDayUrls(kind,day)") != 1:
        raise SystemExit("TAF verification has duplicated centralDayUrls")
    if LIVE_BASE not in s:
        raise SystemExit("live Railway archive base missing")
    if "A.getLatest('TAF','EPIR',true)" not in s:
        raise SystemExit("explicit current EPIR TAF MessageArchive read missing")
    if "`${LIVE_ARCHIVE_BASE}${kind}/" not in s:
        raise SystemExit("live day archive URL missing")
    if new_dates not in s:
        raise SystemExit("null-safe TAF validity parser missing")

    if s != before:
        TARGET.write_text(s, encoding="utf-8")
        print("updated taf-verification.js for live archive + strict group verification")
    else:
        print("taf-verification.js: live archive + strict group verification already enforced")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
