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


def replace_section(text: str, start_marker: str, end_marker: str, replacement: str, name: str) -> str:
    start = text.find(start_marker)
    if start < 0:
        raise SystemExit(f"TAF verification section missing: {name} start")
    end = text.find(end_marker, start)
    if end < 0:
        raise SystemExit(f"TAF verification section missing: {name} end")
    return text[:start] + replacement + text[end:]


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
    # Everything between the first centralDayUrls and fetchMetarDay belongs to
    # old/duplicated URL helper copies. Replacing the whole section makes the
    # operation idempotent regardless of which older patch produced the file.
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

    # Missing metadata must not overwrite validity already parsed from raw TAF.
    # In particular this protects DD24 groups such as 0812/0824.
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

    # Guard the architectural contract.
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
        print("updated taf-verification.js for live central archive")
    else:
        print("taf-verification.js: live central archive already enforced")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
