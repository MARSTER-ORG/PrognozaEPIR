#!/usr/bin/env python3
"""Authoritative live EPIR METAR/SPECI collector.

The primary aviation source is the same public IMGW Aviation API used by the
awiacja.imgw.pl frontend. IMGW currently accepts count=4 for the `last`
endpoint, which gives the routine ~90-minute repair buffer seen in the web UI.
The parser itself has no four-report limit: every METAR/SPECI message returned
anywhere below EPIR.metars is decoded, deduplicated and archived.

PilotHub, OGIMET and CZAD remain independent fallbacks. The newest observation
time always wins; source priority only breaks ties for the same report.
"""
from __future__ import annotations

import json
import time

import refresh_epir_metar as refresh
import supplement_metar_pilothub as pilothub

IMGW_API_URL = (
    'https://aviation-api.imgw.pl/data/last'
    '?params=metar,taf&format=json&count=4'
)
EPIN_PAGE = (
    'PILOTHUB-EPIN',
    'https://pilothub.pl/lotniska/epin',
    'PILOTHUB_METAR_IMGW',
)

# Make the generic scanner check the known-good PilotHub page directly too.
if not any(row[1] == EPIN_PAGE[1] for row in refresh.LIVE_PAGES):
    refresh.LIVE_PAGES = (refresh.LIVE_PAGES[0], EPIN_PAGE, *refresh.LIVE_PAGES[1:])

_base_fetch_candidates = refresh.fetch_candidates
_base_archive = refresh.archive


def _walk_message_records(value):
    """Yield every dict containing an aviation `message`, at any nesting level."""
    if isinstance(value, dict):
        if isinstance(value.get('message'), str):
            yield value
        for child in value.values():
            yield from _walk_message_records(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_message_records(child)


def _fresh_imgw_api_url() -> str:
    # The browser frontend can already show a new :00/:30 report while a shared
    # intermediary still serves an older `last` response. A harmless query
    # nonce makes every collector pass a fresh request to the same IMGW API.
    return f'{IMGW_API_URL}&_={int(time.time() * 1000)}'


def fetch_imgw_api_reports():
    """Fetch all EPIR METAR/SPECI messages exposed by the official IMGW frontend API."""
    try:
        payload = json.loads(refresh.c.get_text(_fresh_imgw_api_url(), timeout=20))
    except Exception as exc:
        print('IMGW Aviation API warning:', exc)
        return []

    epir = payload.get('EPIR') if isinstance(payload, dict) else None
    metars = (epir or {}).get('metars') if isinstance(epir, dict) else None
    if not metars:
        print('IMGW Aviation API: EPIR.metars unavailable')
        return []

    rows = []
    seen = set()
    raw_records = 0
    for record in _walk_message_records(metars):
        raw = (record.get('message') or '').strip()
        if 'EPIR' not in raw.upper():
            continue
        raw_records += 1
        decoded_rows = refresh.extract_epir_reports(raw, 'IMGW_AVIATION_METAR')
        for row in decoded_rows:
            if not refresh.backfill_valid(row):
                continue
            row['imgw_api'] = 'aviation-api.imgw.pl'
            row['imgw_api_date'] = record.get('date')
            row['imgw_api_file'] = record.get('file')
            row['imgw_api_message_type'] = record.get('messageType')
            ident = refresh.report_identity(row)
            if ident not in seen:
                seen.add(ident)
                rows.append(row)

    rows.sort(key=refresh.rank)
    print(
        'IMGW Aviation API: raw_records=', raw_records,
        ' decoded/backfill=', len(rows),
        ' newest=', (rows[-1].get('obs_time') if rows else None),
    )
    for row in rows:
        print('IMGW EPIR:', row.get('obs_time'), row.get('report_type'), row.get('raw'))
    return rows


def fetch_candidates():
    # The direct official API is authoritative. Keep the older scanner only as
    # an independent compatibility/fallback path; its obsolete IMGW HTML probes
    # returning zero do not affect the direct API result.
    rows = list(fetch_imgw_api_reports())
    rows.extend(_base_fetch_candidates())

    # Exact PilotHub parser: independent from the generic HTML extraction path.
    try:
        rows.extend(pilothub.fetch_pilothub_reports())
    except Exception as exc:
        print('PilotHub exact parser warning:', exc)

    best = {}
    for row in rows:
        ident = refresh.report_identity(row)
        old = best.get(ident)
        if old is None or refresh.SOURCE_PRIORITY.get(row.get('source'), 0) > refresh.SOURCE_PRIORITY.get(old.get('source'), 0):
            best[ident] = row

    out = list(best.values())
    if out:
        newest = max(out, key=refresh.rank)
        print('authoritative METAR candidate:', newest.get('obs_time'), newest.get('source'), newest.get('raw'))
    else:
        print('authoritative METAR candidate: none')
    return out


def archive_preferred(row):
    """Upgrade an identical archived report when a higher-priority source appears."""
    if not row or not row.get('obs_time'):
        return False
    t = refresh.obs_time(row)
    if not t:
        return False

    canonical = refresh.c.OUT / 'metar' / t.strftime('%Y') / t.strftime('%m') / f'{t:%d}.jsonl'
    ident = refresh.report_identity(row)
    existing = refresh.read_jsonl(canonical)
    for i, old in enumerate(existing):
        if refresh.report_identity(old) != ident:
            continue
        new_priority = refresh.SOURCE_PRIORITY.get(row.get('source'), 0)
        old_priority = refresh.SOURCE_PRIORITY.get(old.get('source'), 0)
        if new_priority <= old_priority:
            return False
        existing[i] = row
        canonical.parent.mkdir(parents=True, exist_ok=True)
        canonical.write_text(
            ''.join(json.dumps(x, ensure_ascii=False, separators=(',', ':')) + '\n' for x in existing),
            encoding='utf-8',
        )
        print('archive source upgraded:', row.get('obs_time'), old.get('source'), '->', row.get('source'))
        return True

    return _base_archive(row)


refresh.fetch_candidates = fetch_candidates
refresh.archive = archive_preferred


if __name__ == '__main__':
    refresh.main()
