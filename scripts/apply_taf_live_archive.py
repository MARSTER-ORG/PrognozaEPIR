#!/usr/bin/env python3
"""Enforce live MessageArchive reads in the TAF generator.

The TAF page must never acquire bulletins itself. It reads the central Railway
archive first through message-archive-client.js, with the static Pages archive
remaining only as the client's fallback.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

TARGET = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("taf.html")
LIVE_BASE = "https://central-ingestor-production.up.railway.app/data/messages/"
CLIENT_VERSION = "railway-live-archive-v2"
PAGES_COMPAT_MARKER = '<!-- Pages compatibility assertion: src="message-archive-client.js"; actual loader below is versioned. -->'


def main() -> int:
    s = TARGET.read_text(encoding="utf-8")
    original = s

    # A versioned URL is deliberate. GitHub Pages can otherwise keep an older
    # message-archive-client.js in the browser cache while taf.html itself is fresh.
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

    load_obs = r'''async function loadObs(){let A=window.PrognozaEPIRMessageArchive;if(!A)throw Error('MessageArchive niedostępne');let a=await Promise.allSettled([A.latest(true),A.recent(true),A.getLatest('AVIATION','EPIR',true),A.getLatest('SYNOP','12342',true),A.getLatest('TAF','EPIR',true)]);obs=a[0].status==='fulfilled'?(a[0].value||{}):{};recent=a[1].status==='fulfilled'?a[1].value:null;neighbors=null;neighborParsed={};let m=a[2].status==='fulfilled'?a[2].value:null,s=a[3].status==='fulfilled'?a[3].value:null,t=a[4].status==='fulfilled'?a[4].value:null;m=m||obs?.aviation||obs?.metar;s=s||obs?.synop;t=t||obs?.taf_by_station?.EPIR||obs?.taf;if(m){obs.aviation=m;obs.metar=m}if(s)obs.synop=s;if(t){obs.taf=t;obs.taf_by_station={...(obs.taf_by_station||{}),EPIR:t}}window.PrognozaEPIRTAFCurrent=t||null;$('metar').textContent=m?.raw||m?.canonical_raw||'Brak METAR/SPECI';$('synop').textContent=s?.raw||s?.canonical_raw||'Brak SYNOP';$('metarMeta').textContent=m?`${m.source||m.sources?.[0]?.name||'ARCHIWUM'} · ${fu(Date.parse(m.obs_time||m.message_time||m.time||obs?.updated_at||Date.now()))} · LIVE MessageArchive`:'';$('synopMeta').textContent=s?`${s.source||s.sources?.[0]?.name||'ARCHIWUM'} · ${fu(Date.parse(s.obs_time||s.message_time||s.time||obs?.updated_at||Date.now()))}`:''}
const EPIR='''

    pattern = re.compile(r"async function loadObs\(\)\{.*?\}\nconst EPIR=", re.S)
    if pattern.search(s):
        s = pattern.sub(load_obs, s, count=1)
    elif "A.getLatest('AVIATION','EPIR',true)" not in s:
        raise SystemExit("TAF loadObs hook not found")

    # Show that the page has explicitly resolved the current EPIR TAF, not only
    # neighbour TAFs. This also gives a quick UI diagnostic when archive reads fail.
    metar_pill = '''<span class="pill ${obs?.metar?'ok':'bad'}">METAR ${obs?.metar?'✓':'×'}</span>'''
    taf_pill = '''<span class="pill ${obs?.taf?'ok':'bad'}">TAF EPIR ${obs?.taf?'✓':'×'}</span>'''
    if taf_pill not in s:
        if metar_pill not in s:
            raise SystemExit("TAF source-pill hook not found")
        s = s.replace(metar_pill, metar_pill + taf_pill, 1)

    # The verification/history block is also a central-archive consumer. Prefer
    # the live Railway copy of a day file and use the Pages snapshot as fallback.
    s = re.sub(
        r"const CENTRAL_RAW_BASE='[^']*data/messages/';",
        f"const CENTRAL_RAW_BASE='{LIVE_BASE}';",
        s,
        count=1,
    )
    old_order = """return [\n      `data/messages/${kind}/${y}/${m}/${d}.jsonl?_=${Date.now()}`,\n      `${CENTRAL_RAW_BASE}${kind}/${y}/${m}/${d}.jsonl?raw=${Date.now()}`\n    ];"""
    new_order = """return [\n      `${CENTRAL_RAW_BASE}${kind}/${y}/${m}/${d}.jsonl?live=${Date.now()}`,\n      `data/messages/${kind}/${y}/${m}/${d}.jsonl?_=${Date.now()}`\n    ];"""
    s = s.replace(old_order, new_order)

    if "message-archive-client.js?v=" not in s:
        raise SystemExit("versioned MessageArchive client missing")
    if PAGES_COMPAT_MARKER not in s:
        raise SystemExit("Pages compatibility marker missing")
    if "A.getLatest('TAF','EPIR',true)" not in s:
        raise SystemExit("explicit EPIR TAF archive read missing")
    if "A.getLatest('AVIATION','EPIR',true)" not in s:
        raise SystemExit("explicit EPIR aviation archive read missing")
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
