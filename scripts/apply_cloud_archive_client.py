#!/usr/bin/env python3
"""Route Cloud Learning's legacy observation bridge through MessageArchive."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "cloud-learning-client.js"
MARKER = "// Model snapshot + adaptive weights runtime -------------------------------"

PREFIX = r'''\'use strict\';

// Central observation bridge ------------------------------------------------
// Legacy callers of data/observations/latest.json and recent.json are mapped
// to the shared central MessageArchive. No bulletin provider is queried here.
(() => {
  const nativeFetch=window.fetch.bind(window);
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

  function obsKind(input){
    try{
      const raw=typeof input==='string'?input:(input?.url||'');
      const u=new URL(raw,location.href);
      if(u.pathname.endsWith('/data/observations/latest.json'))return 'latest';
      if(u.pathname.endsWith('/data/observations/recent.json'))return 'recent';
    }catch(_){ }
    return null;
  }

  window.fetch=async function(input,init){
    const kind=obsKind(input);
    if(!kind)return nativeFetch(input,init);
    try{
      const archive=await archiveClient();
      const body=kind==='latest'?await archive.latest(true):await archive.recent(true);
      return new Response(JSON.stringify(body),{
        status:200,
        headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, max-age=0','X-PrognozaEPIR-Source':'central-message-archive'}
      });
    }catch(e){
      console.warn('EPIR central MessageArchive bridge:',e);
      return nativeFetch(input,init);
    }
  };
})();

'''


def main() -> int:
    s = PATH.read_text(encoding="utf-8")
    if MARKER not in s:
        raise SystemExit("model runtime marker not found")
    if "Central observation bridge" in s and "aviation-api.imgw.pl" not in s:
        print("cloud-learning-client.js already uses central MessageArchive")
        return 0
    _, tail = s.split(MARKER, 1)
    out = PREFIX.replace("\\'", "'") + MARKER + tail
    if "aviation-api.imgw.pl" in out or "awiacja.imgw.pl" in out:
        raise SystemExit("direct bulletin source remains after Cloud Learning cutover")
    if "PrognozaEPIRMessageArchive" not in out:
        raise SystemExit("shared MessageArchive missing after Cloud Learning cutover")
    PATH.write_text(out, encoding="utf-8")
    print("cloud-learning-client.js routed through central MessageArchive")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
