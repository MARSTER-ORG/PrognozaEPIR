#!/usr/bin/env python3
"""PilotHub verification/fallback collector for EPIR METAR.

The main collector prefers official IMGW, but PilotHub is always checked as an
independent source. The newest timestamp wins, so a still-fresh but older IMGW
report cannot block a newer half-hour EPIR report published by PilotHub.
"""
import html
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collect_epir_observations as c

PILOTHUB_URL = 'https://pilothub.pl/lotniska/inowroclaw-szpital'
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


def _candidate_raw_reports(plain):
    """Return all plausible EPIR METAR strings visible on the PilotHub page."""
    out = []
    seen = set()
    patterns = (
        r'\bMETAR\s+(EPIR\s+\d{6}Z\s+.*?\bQ\d{4}\b)=?',
        r'\b(EPIR\s+\d{6}Z\s+.*?\bQ\d{4}\b)=?',
    )
    for pattern in patterns:
        for match in re.finditer(pattern, plain, re.I):
            raw = re.sub(r'\s+', ' ', match.group(1)).strip()
            if raw not in seen:
                seen.add(raw)
                out.append(raw)
    return out


def fetch_pilothub_metar():
    text = c.get_text(PILOTHUB_URL)
    plain = html.unescape(re.sub(r'<[^>]+>', ' ', text))
    plain = re.sub(r'\s+', ' ', plain)

    decoded = []
    for raw in _candidate_raw_reports(plain):
        try:
            row = c.decode_metar(raw, source='PILOTHUB_METAR_IMGW')
        except Exception:
            row = None
        if row and is_fresh(row, MAX_PILOTHUB_AGE_MIN):
            decoded.append(row)

    if not decoded:
        return None
    return max(decoded, key=lambda row: obs_time(row) or c.parse_dt('1970-01-01T00:00:00Z'))


def same_report(a, b):
    return bool(a and b and a.get('obs_time') == b.get('obs_time') and a.get('raw') == b.get('raw'))


def newest_report(a, b):
    """Return the newer report; for equal timestamps prefer PilotHub (b)."""
    if not a:
        return b
    if not b:
        return a
    ta, tb = obs_time(a), obs_time(b)
    if not ta:
        return b
    if not tb:
        return a
    return b if tb >= ta else a


def main():
    latest = read_latest()
    primary = latest.get('metar')

    # Always check PilotHub. A primary report can still be within the freshness
    # window while being one or more half-hour EPIR cycles behind.
    try:
        fallback = fetch_pilothub_metar()
    except Exception as exc:
        print('PilotHub METAR verification warning:', exc)
        return
    if not fallback:
        print('PilotHub: no fresh EPIR METAR found')
        return

    chosen = newest_report(primary, fallback)
    if not same_report(primary, fallback):
        day = c.parse_dt(fallback['obs_time']).strftime('%Y-%m-%d')
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
        'pilothub': 'checked',
        'pilothub_time': fallback.get('obs_time'),
        'chosen_source': chosen.get('source'),
        'chosen_time': chosen.get('obs_time'),
        'chosen_raw': chosen.get('raw'),
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
