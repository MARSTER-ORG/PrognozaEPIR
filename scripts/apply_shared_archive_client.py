#!/usr/bin/env python3
"""Idempotently route observation-engine.js through the shared archive client."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "observation-engine.js"


def main() -> int:
    s = PATH.read_text(encoding="utf-8")
    if "PrognozaEPIRMessageArchive" in s and "const LATEST_URL = 'data/messages/latest.json';" not in s:
        print("observation-engine.js already uses shared MessageArchive")
        return 0

    s, n = re.subn(
        r"\n  const LATEST_URL = 'data/messages/latest\.json';\n  const RECENT_URL = 'data/messages/recent\.json';",
        "",
        s,
        count=1,
    )
    if n != 1:
        raise SystemExit("observation archive URL block not found")

    block = re.compile(
        r"\n  async function fetchJson\(url\)\{.*?\n  \}\n\n  function metarPhenomena\(m\)\{",
        re.S,
    )
    replacement = r'''

  let archiveClientPromise=null;
  function archiveClient(){
    if(window.PrognozaEPIRMessageArchive)return Promise.resolve(window.PrognozaEPIRMessageArchive);
    if(archiveClientPromise)return archiveClientPromise;
    archiveClientPromise=new Promise((resolve,reject)=>{
      const ready=()=>window.PrognozaEPIRMessageArchive?resolve(window.PrognozaEPIRMessageArchive):reject(new Error('MessageArchive niedostępne'));
      const existing=document.querySelector('script[data-prognozaepir-message-archive="1"]');
      if(existing){
        window.addEventListener('prognozaepir:message-archive-ready',ready,{once:true});
        setTimeout(ready,2500);
        return;
      }
      const script=document.createElement('script');
      script.src='message-archive-client.js';
      script.dataset.prognozaepirMessageArchive='1';
      script.onload=ready;
      script.onerror=()=>reject(new Error('Nie można załadować message-archive-client.js'));
      document.head.appendChild(script);
    });
    return archiveClientPromise;
  }
  async function archiveLatest(force=false){return (await archiveClient()).latest(force);}
  async function archiveRecent(force=false){return (await archiveClient()).recent(force);}

  function metarPhenomena(m){'''
    s, n = block.subn(replacement, s, count=1)
    if n != 1:
        raise SystemExit("observation fetchJson block not found")

    s = s.replace("fetchJson(LATEST_URL)", "archiveLatest(true)")
    s = s.replace("fetchJson(RECENT_URL)", "archiveRecent(true)")
    s = s.replace("refreshLiveMetar", "refreshArchive")

    if "fetchJson(" in s or "LATEST_URL" in s or "RECENT_URL" in s:
        raise SystemExit("legacy observation archive fetch remains after cutover")
    if "PrognozaEPIRMessageArchive" not in s:
        raise SystemExit("shared MessageArchive not installed")

    PATH.write_text(s, encoding="utf-8")
    print("observation-engine.js routed through shared MessageArchive")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
