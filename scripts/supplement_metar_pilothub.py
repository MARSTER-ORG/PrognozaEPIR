#!/usr/bin/env python3
"""PilotHub verification/fallback collector for EPIR METAR.

PilotHub's EPIN page has no local METAR, but server-side HTML contains the
nearest station EPIR in a dedicated METAR section. Parse that section first,
then fall back to a whole-page scan and other known nearby PilotHub pages.
"""
import html
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collect_epir_observations as c

PILOTHUB_URLS = (
    # Confirmed from a saved PilotHub EPIN page: this page contains the nearest
    # station EPIR and its current METAR in <h3>METAR</h3> ... <code>...</code>.
    ('EPIN', 'https://pilothub.pl/lotniska/epin'),
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


def _metar_section_raw_reports(text):
    """Extract EPIR from PilotHub's dedicated METAR HTML section.

    The EPIN page renders e.g.:
      <h3>METAR</h3>
      <p><code>METAR EPIR 062100Z ... Q1025=</code></p>
    This is preferred over scanning arbitrary page text.
    """
    out = []
    seen = set()
    section_re = re.compile(
        r'<h3[^>]*>\s*METAR\s*</h3>\s*<p[^>]*>\s*<code[^>]*>(.*?)</code>',
        re.I | re.S,
    )
    report_re = re.compile(
        r'\b((?:METAR|SPECI)\s+EPIR\s+\d{6}Z\s+.*?\bQ\d{4}\b)=?',
        re.I,
    )
    for section in section_re.finditer(text or ''):
        value = html.unescape(re.sub(r'<[^>]+>', ' ', section.group(1)))
        value = re.sub(r'\s+', ' ', value).strip()
        for match in report_re.finditer(value):
            raw = re.sub(r'\s+', ' ', match.group(1)).strip()
            if raw not in seen:
                seen.add(raw)
                out.append(raw)
    return out


def _candidate_raw_reports(plain):
    """Return all plausible EPIR METAR/SPECI strings visible on PilotHub."""
    out = []
    seen = set()
    patterns = (
        r'\b((?:METAR|SPECI)\s+EPIR\s+\d{6}Z\s+.*?\bQ\d{4}\b)=?',
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
    decoded_ids = set()
    for label, url in PILOTHUB_URLS:
        try:
            text = c.get_text(url)
            plain = html.unescape(re.sub(r'<[^>]+>', ' ', text))
            plain = re.sub(r'\s+', ' ', plain)

            # Prefer the exact METAR block seen in the saved EPIN page, then
            # retain the generic whole-page parser as a compatibility fallback.
            raw_reports = _metar_section_raw_reports(text) + _candidate_raw_reports(plain)
            page_rows = []
            page_seen = set()
            for raw in raw_reports:
                try:
                    row = c.decode_metar(raw, source='PILOTHUB_METAR_IMGW')
                except Exception:
                    row = None
                if not row or not is_fresh(row, MAX_PILOTHUB_AGE_MIN):
                    continue
                ident = (row.get('station'), row.get('obs_time'), row.get('raw'))
                if ident in page_seen:
                    continue
                page_seen.add(ident)
                row['pilothub_page'] = label
                row['pilothub_url'] = url
                page_rows.append(row)
                if ident not in decoded_ids:
                    decoded_ids.add(ident)
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
