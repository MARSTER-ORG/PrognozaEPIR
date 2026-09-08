#!/usr/bin/env python3
"""Keep TAF verification on the live central MessageArchive.

The verifier is historical/verification-only, but for the current UTC day it
must see the same fresh EPIR TAF and METAR records as the generator. Railway is
the first archive transport; Pages/raw GitHub are fallbacks only.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "taf-verification.js"
LIVE_BASE = "https://central-ingestor-production.up.railway.app/data/messages/"
RAW_BASE = "https://raw.githubusercontent.com/MARSTER-ORG/PrognozaEPIR/main/data/messages/"


def main() -> int:
    s = TARGET.read_text(encoding="utf-8")
    before = s

    # Keep both bases explicit: Railway is live/authoritative transport, raw
    # GitHub is only a last-resort historical fallback.
    s = re.sub(
        r"  const CENTRAL_RAW_BASE='[^']*';",
        "  const LIVE_ARCHIVE_BASE='" + LIVE_BASE + "';\n"
        "  const CENTRAL_RAW_BASE='" + RAW_BASE + "';",
        s,
        count=1,
    )
    if "const LIVE_ARCHIVE_BASE=" not in s:
        raise SystemExit("TAF verification archive base anchor missing")

    # Older patch passes accidentally duplicated this function many times.
    # Replace the whole consecutive block with one deterministic implementation.
    block = re.compile(
        r"(?:  function centralDayUrls\(kind,day\)\{\n"
        r"    const \[y,m,d\]=day\.split\('-'\);\n"
        r"    return \[\n"
        r".*?"
        r"    \];\n"
        r"  \}\n)+",
        re.S,
    )
    canonical = """  function centralDayUrls(kind,day){
    const [y,m,d]=day.split('-'),stamp=Date.now();
    return [
      `${LIVE_ARCHIVE_BASE}${kind}/${y}/${m}/${d}.jsonl?live=${stamp}`,
      `data/messages/${kind}/${y}/${m}/${d}.jsonl?pages=${stamp}`,
      `${CENTRAL_RAW_BASE}${kind}/${y}/${m}/${d}.jsonl?raw=${stamp}`
    ];
  }
"""
    s, replaced = block.subn(lambda _m: canonical, s, count=1)
    if replaced != 1:
        raise SystemExit("TAF verification centralDayUrls block missing")

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

    # Day files remain the complete history. For the current day, merge the
    # explicit MessageArchive latest TAF so the running 12 h cycle cannot be
    # hidden by a lagging Pages/raw snapshot.
    tafs_fn = re.compile(
        r"  async function tafsForValidityDay\(day\)\{.*?\n"
        r"  \}\n"
        r"  function forecastText",
        re.S,
    )
    replacement = """  async function tafsForValidityDay(day){
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
  function forecastText"""
    s, n = tafs_fn.subn(lambda _m: replacement, s, count=1)
    if n != 1:
        raise SystemExit("TAF verification tafsForValidityDay hook missing")

    s = s.replace(
        "VERSION+' · auto 60 s · dane TAF tylko do weryfikacji'",
        "VERSION+' · LIVE Railway/MessageArchive · auto 60 s · dane TAF tylko do weryfikacji'",
    )

    # Guard the architectural contract.
    if s.count("function centralDayUrls(kind,day)") != 1:
        raise SystemExit("TAF verification has duplicated centralDayUrls")
    if LIVE_BASE not in s:
        raise SystemExit("live Railway archive base missing")
    if "A.getLatest('TAF','EPIR',true)" not in s:
        raise SystemExit("explicit current EPIR TAF MessageArchive read missing")
    if "`${LIVE_ARCHIVE_BASE}${kind}/" not in s:
        raise SystemExit("live day archive URL missing")

    if s != before:
        TARGET.write_text(s, encoding="utf-8")
        print("updated taf-verification.js for live central archive")
    else:
        print("taf-verification.js: live central archive already enforced")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
