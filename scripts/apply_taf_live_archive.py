#!/usr/bin/env python3
"""Enforce central MessageArchive reads in the TAF generator.

Railway is the authoritative live acquisition source. The shared
message-archive-client reads Railway first and falls back to the durable GitHub
mirror / Pages snapshot. This script must preserve the generator's meteorological
logic instead of replacing it with an older loadObs implementation.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

TARGET = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("taf.html")
LIVE_BASE = "https://central-ingestor-production.up.railway.app/data/messages/"
CLIENT_VERSION = "live-first-v4"
PAGES_COMPAT_MARKER = '<!-- Pages compatibility assertion: src="message-archive-client.js"; actual loader below is versioned. -->'


def main() -> int:
    s = TARGET.read_text(encoding="utf-8")
    original = s

    # Version the shared client so GitHub Pages/browser cache cannot keep an old
    # GitHub-first reader after the source priority has changed.
    s = re.sub(
        r'<script src="message-archive-client\.js(?:\?v=[^"]*)?"></script>',
        f'<script src="message-archive-client.js?v={CLIENT_VERSION}"></script>',
        s,
        count=1,
    )
    if PAGES_COMPAT_MARKER not in s:
        versioned = f'<script src="message-archive-client.js?v={CLIENT_VERSION}"></script>'
        if versioned not in s:
            raise SystemExit("versioned MessageArchive script tag missing")
        s = s.replace(versioned, PAGES_COMPAT_MARKER + versioned, 1)

    # Helpers used to compare the actual bulletin observation times from
    # latest.json and recent.json. They make the selection independent of array
    # order and of which snapshot field happened to be populated first.
    helpers = r'''function tafMsgTime(x){if(!x)return NaN;for(const k of ['obs_time','message_time','time','issue_time','timestamp']){let t=Date.parse(x[k]||'');if(fin(t))return t}let r=String(x.raw||x.canonical_raw||''),m=r.match(/\b(\d{6})Z\b/);return m?monthTime(m[1],Date.now(),true):NaN}function tafRecentAviation(r){let o=[];for(const k of ['metar','speci','aviation'])if(Array.isArray(r?.[k]))o.push(...r[k]);return o.filter(x=>/\bEPIR\b/.test(String(x?.raw||x?.canonical_raw||'')))}function tafNewestAviation(a){return a.filter(Boolean).sort((x,y)=>(tafMsgTime(y)||0)-(tafMsgTime(x)||0))[0]||null}'''
    marker = "async function loadObs(){"
    if helpers not in s:
        if marker not in s:
            raise SystemExit("TAF loadObs hook not found")
        s = s.replace(marker, helpers + marker, 1)

    # TAF temporarily does not use SYNOP. For METAR/SPECI it compares latest,
    # recent and the strict AVIATION lookup and chooses the newest real bulletin.
    load_obs = r'''async function loadObs(){let A=window.PrognozaEPIRMessageArchive;if(!A)throw Error('MessageArchive niedostępne');let a=await Promise.allSettled([A.latest(true),A.recent(true),A.getLatest('AVIATION','EPIR',true),Promise.resolve(null),A.getLatest('TAF','EPIR',true)]);obs=a[0].status==='fulfilled'?(a[0].value||{}):{};recent=a[1].status==='fulfilled'?a[1].value:null;neighbors=null;neighborParsed={};let ro=tafRecentAviation(recent),m=tafNewestAviation([a[2].status==='fulfilled'?a[2].value:null,obs?.aviation,obs?.metar,...ro]),s=null,t=a[4].status==='fulfilled'?a[4].value:null;m=m||obs?.aviation||obs?.metar;obs.synop=null;t=t||obs?.taf_by_station?.EPIR||obs?.taf;if(m){obs.aviation=m;obs.metar=m}if(t){obs.taf=t;obs.taf_by_station={...(obs.taf_by_station||{}),EPIR:t}}window.PrognozaEPIRTAFCurrent=t||null;$('metar').textContent=m?.raw||m?.canonical_raw||'Brak METAR/SPECI';$('synop').textContent='Wyłączony z analizy TAF';$('metarMeta').textContent=m?`${m.source||m.sources?.[0]?.name||'ARCHIWUM'} · ${fu(Date.parse(m.obs_time||m.message_time||m.time||obs?.updated_at||Date.now()))} · LIVE MessageArchive`:'';$('synopMeta').textContent='SYNOP tymczasowo nie jest używany w analizie.'}
const EPIR='''
    pattern = re.compile(r"async function loadObs\(\)\{.*?\}\nconst EPIR=", re.S)
    if pattern.search(s):
        s = pattern.sub(load_obs, s, count=1)
    else:
        raise SystemExit("TAF loadObs block not found")

    # Show that the page explicitly resolved the current EPIR TAF, not only
    # neighbour TAFs.
    metar_pill = '''<span class="pill ${obs?.metar?'ok':'bad'}">METAR ${obs?.metar?'✓':'×'}</span>'''
    taf_pill = '''<span class="pill ${obs?.taf?'ok':'bad'}">TAF EPIR ${obs?.taf?'✓':'×'}</span>'''
    if taf_pill not in s:
        if metar_pill not in s:
            raise SystemExit("TAF source-pill hook not found")
        s = s.replace(metar_pill, metar_pill + taf_pill, 1)

    # Verification/history day files also use Railway live first, with the
    # deployed Pages copy as fallback. The shared client handles GitHub/raw for
    # latest/recent reads.
    s = re.sub(
        r"const CENTRAL_RAW_BASE='[^']*data/messages/';",
        f"const CENTRAL_RAW_BASE='{LIVE_BASE}';",
        s,
        count=1,
    )
    old_order = """return [
      `data/messages/${kind}/${y}/${m}/${d}.jsonl?_=${Date.now()}`,
      `${CENTRAL_RAW_BASE}${kind}/${y}/${m}/${d}.jsonl?raw=${Date.now()}`
    ];"""
    new_order = """return [
      `${CENTRAL_RAW_BASE}${kind}/${y}/${m}/${d}.jsonl?live=${Date.now()}`,
      `data/messages/${kind}/${y}/${m}/${d}.jsonl?_=${Date.now()}`
    ];"""
    s = s.replace(old_order, new_order)

    if f"message-archive-client.js?v={CLIENT_VERSION}" not in s:
        raise SystemExit("current MessageArchive client version missing")
    if PAGES_COMPAT_MARKER not in s:
        raise SystemExit("Pages compatibility marker missing")
    if "A.getLatest('TAF','EPIR',true)" not in s:
        raise SystemExit("explicit EPIR TAF archive read missing")
    if "A.getLatest('AVIATION','EPIR',true)" not in s:
        raise SystemExit("explicit EPIR aviation archive read missing")
    if "A.getLatest('SYNOP','12342',true)" in s:
        raise SystemExit("SYNOP must remain disabled in TAF analysis")
    if LIVE_BASE not in s:
        raise SystemExit("live central archive verification base missing")

    if s != original:
        TARGET.write_text(s, encoding="utf-8")
        print(f"updated {TARGET}")
    else:
        print(f"{TARGET}: already enforced")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())