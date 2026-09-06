#!/usr/bin/env python3
"""PilotHub fallback collector for EPIR METAR.

The main collector still prefers the official IMGW aviation page. This helper
adds PilotHub as an independent fallback/verification source and rebuilds the
observation files without replacing a newer METAR already collected directly.
"""
import html
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collect_epir_observations as c

PILOTHUB_URL = 'https://pilothub.pl/lotniska/inowroclaw-szpital'
MAX_PRIMARY_AGE_MIN = 90
MAX_PILOTHUB_AGE_MIN = 180


def read_latest():
    path = c.OUT / 'latest.json'
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return {}


def obs_time(row):
    return c.parse_dt((row or {}).get('obs_time'))


def is_fresh(row, max_age_min):
    dt = obs_time(row)
    if not dt:
        return False
    return 0 <= (c.now() - dt).total_seconds() <= max_age_min * 60


def fetch_pilothub_metar():
    text = c.get_text(PILOTHUB_URL)
    plain = html.unescape(re.sub(r'<[^>]+>', ' ', text))
    plain = re.sub(r'\s+', ' ', plain)
    # PilotHub currently exposes the raw report in the weather section, e.g.
    # METAR EPIR 061400Z AUTO ... Q1023=
    match = re.search(
        r'\bMETAR\s+(EPIR\s+\d{6}Z\s+.*?\bQ\d{4}\b)=?',
        plain,
        re.I,
    )
    if not match:
        # Keep a second pattern in case the visible "METAR" label changes.
        match = re.search(r'\b(EPIR\s+\d{6}Z\s+.*?\bQ\d{4}\b)=?', plain, re.I)
    if not match:
        return None
    metar = c.decode_metar(match.group(1), source='PILOTHUB_METAR_IMGW')
    return metar if metar and is_fresh(metar, MAX_PILOTHUB_AGE_MIN) else None


def same_report(a, b):
    return bool(a and b and a.get('obs_time') == b.get('obs_time') and a.get('raw') == b.get('raw'))


def newest_report(a, b):
    if not a:
        return b
    if not b:
        return a
    ta, tb = obs_time(a), obs_time(b)
    if not ta:
        return b
    if not tb:
        return a
    return b if tb > ta else a


def main():
    latest = read_latest()
    primary = latest.get('metar')

    # A fresh direct/primary METAR wins. PilotHub is queried when that path is
    # unavailable or stale, which avoids duplicate archive rows every 15 min.
    if is_fresh(primary, MAX_PRIMARY_AGE_MIN):
        print(json.dumps({
            'pilothub': 'not_needed',
            'metar_source': primary.get('source'),
            'metar_time': primary.get('obs_time'),
        }, ensure_ascii=False))
        return

    try:
        fallback = fetch_pilothub_metar()
    except Exception as exc:
        print('PilotHub METAR fallback warning:', exc)
        return
    if not fallback:
        print('PilotHub: no fresh EPIR METAR found')
        return

    chosen = newest_report(primary, fallback)
    if not same_report(primary, fallback):
        day = c.parse_dt(fallback['obs_time']).strftime('%Y-%m-%d')
        # Do not duplicate an identical report already archived from another source.
        existing = c.recent('metar')
        if not any(same_report(row, fallback) for row in existing):
            c.append(c.OUT / 'metar' / f'{day}.jsonl', fallback)

    metars = c.recent('metar')
    synops = c.recent('synop')
    hist = c.history(metars, synops)
    synop = latest.get('synop')
    fused = hist[-1] if hist else c.fuse(chosen, synop)
    station = {'icao': c.ICAO, 'synop': c.SYNOP_ID, 'wigos': c.WIGOS_ID, 'lat': c.LAT, 'lon': c.LON}

    latest.update({
        'schema': 'epir-observation-latest-v2',
        'station': station,
        'updated_at': fused.get('obs_time') if fused else chosen.get('obs_time'),
        'collected_at': c.iso(c.now()),
        'metar': chosen,
        'synop': synop,
        'fused': fused,
    })
    c.write(c.OUT / 'latest.json', latest, True)
    c.write(c.OUT / 'recent.json', {
        'schema': 'epir-observation-history-v2',
        'station': station,
        'hours': 30,
        'metar': metars,
        'synop': synops,
        'observations': hist,
    })
    print(json.dumps({
        'pilothub': 'used',
        'metar_source': chosen.get('source'),
        'metar_time': chosen.get('obs_time'),
        'metar_raw': chosen.get('raw'),
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
