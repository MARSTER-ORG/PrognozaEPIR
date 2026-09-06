#!/usr/bin/env python3
"""PilotHub verification/fallback collector for EPIR METAR.

PilotHub can expose the current EPIR report on more than one nearby-airport page.
Both known working pages are checked and the newest EPIR timestamp wins, so a
stale page cannot block a newer half-hour METAR visible on another PilotHub page.
"""
import html
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collect_epir_observations as c

PILOTHUB_URLS = (
    ('SZPITAL', 'https://pilothub.pl/lotniska/inowroclaw-szpital'),
    ('LATKOWO', 'https://pilothub.pl/lotniska/inowroclaw-latkowo-lotnisko-wojskowe'),
)
MAX_PILOTHUB_AGE_MIN = 240


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
    """Return all plausible EPIR METAR/SPECI strings visible on PilotHub."""
    out = []
    seen = set()
    patterns = (
        r'\b(?:METAR|SPECI)\s+(EPIR\s+\d{6}Z\s+.*?\bQ\d{4}\b)=?',
        r'\b(EPIR\s+\d{6}Z\s+.*?\bQ\d{4}\b)=?',
    )
    for pattern in patterns:
        for match in re.finditer(pattern, plain, re.I):
            raw = re.sub(r'\s+', ' ', match.group(1)).strip()
            if raw not in seen:
                seen.add(raw)
                out.append(raw)
    return out


def fetch_pilothub_reports():
    decoded = []
    for label, url in PILOTHUB_URLS:
        try:
            text = c.get_text(url)
            plain = html.unescape(re.sub(r'<[^>]+>', ' ', text))
            plain = re.sub(r'\s+', ' ', plain)
            page_rows = []
            for raw in _candidate_raw_reports(plain):
                try:
                    row = c.decode_metar(raw, source='PILOTHUB_METAR_IMGW')
                except Exception:
                    row = None
                if row and is_fresh(row, MAX_PILOTHUB_AGE_MIN):
                    row['pilothub_page'] = label
                    row['pilothub_url'] = url
                    page_rows.append(row)
                    decoded.append(row)
            print(f'PilotHub {label}: fresh={len(page_rows)}' + (
                f' newest={max(page_rows, key=lambda r: obs_time(r)).get("obs_time")}' if page_rows else ''))
        except Exception as exc:
            print(f'PilotHub {label} warning:', exc)
    return decoded


def fetch_pilothub_metar():
    decoded = fetch_pilothub_reports()
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

    fallback = fetch_pilothub_metar()
    if not fallback:
        print('PilotHub: no fresh EPIR METAR found on checked pages')
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
        'pilothub_pages': [u for _, u in PILOTHUB_URLS],
        'pilothub_page': fallback.get('pilothub_page'),
        'pilothub_time': fallback.get('obs_time'),
        'chosen_source': chosen.get('source'),
        'chosen_time': chosen.get('obs_time'),
        'chosen_raw': chosen.get('raw'),
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
