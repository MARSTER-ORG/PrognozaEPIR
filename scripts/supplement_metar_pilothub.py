#!/usr/bin/env python3
"""PilotHub verification/fallback collector for EPIR METAR/SPECI.

PilotHub is a fallback only.  Its airport pages also contain TAF text, decoded
forecast prose, NOTAMs and other page content, so whole-page extraction is
accepted only when the candidate has the structural shape of a METAR/SPECI.
This prevents a TAF beginning with ``EPIR DDHHMMZ DDHH/DDHH ...`` from being
misclassified as a METAR and swallowing the rest of the HTML page up to a later
QNH token.
"""
from __future__ import annotations

import html
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collect_epir_observations as c

PILOTHUB_URLS = (
    ('EPIN', 'https://pilothub.pl/lotniska/epin'),
    ('SZPITAL', 'https://pilothub.pl/lotniska/inowroclaw-szpital'),
    ('LATKOWO', 'https://pilothub.pl/lotniska/inowroclaw-latkowo-lotnisko-wojskowe'),
)
MAX_PILOTHUB_AGE_MIN = 240
MAX_RAW_LEN = 512

# After DDHHMMZ a normal EPIR METAR/SPECI must proceed to the wind group
# (optionally preceded by AUTO).  A TAF proceeds to DDHH/DDHH instead.
_METAR_START_RE = re.compile(
    r'^(?:(?:METAR|SPECI)\s+)?(?:COR\s+)?EPIR\s+\d{6}Z\s+'
    r'(?:AUTO\s+)?(?:VRB|\d{3})\d{2,3}(?:G\d{2,3})?KT\b',
    re.I,
)
_VALIDITY_RE = re.compile(r'\b\d{4}/\d{4}\b')
_REPORT_RE = re.compile(
    r'\b((?:(?:METAR|SPECI)\s+)?(?:COR\s+)?EPIR\s+\d{6}Z\s+.*?\bQ\d{4}\b)=?',
    re.I,
)


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


def _normalise(value):
    value = html.unescape(re.sub(r'<[^>]+>', ' ', value or ''))
    return re.sub(r'\s+', ' ', value).strip()


def _plausible_metar_raw(raw):
    """Reject cross-bulletin/page captures before they reach decode_metar()."""
    raw = _normalise(raw)
    if not raw or len(raw) > MAX_RAW_LEN:
        return False
    # A trailing '=' is a bulletin terminator.  Any earlier '=' proves that the
    # regex crossed a previous bulletin boundary and continued through page text.
    core = raw[:-1].rstrip() if raw.endswith('=') else raw
    if '=' in core:
        return False
    if _VALIDITY_RE.search(core):
        return False
    if not _METAR_START_RE.search(core):
        return False
    if not re.search(r'\bQ\d{4}\b', core, re.I):
        return False
    return True


def _extract_raw_reports(value):
    value = _normalise(value)
    out = []
    seen = set()
    for match in _REPORT_RE.finditer(value):
        raw = re.sub(r'\s+', ' ', match.group(1)).strip()
        if not _plausible_metar_raw(raw) or raw in seen:
            continue
        seen.add(raw)
        out.append(raw)
    return out


def _metar_section_raw_reports(text):
    """Extract reports from PilotHub's dedicated METAR <code> section."""
    out = []
    seen = set()
    section_re = re.compile(
        r'<h3[^>]*>\s*METAR\s*</h3>\s*<p[^>]*>\s*<code[^>]*>(.*?)</code>',
        re.I | re.S,
    )
    for section in section_re.finditer(text or ''):
        for raw in _extract_raw_reports(section.group(1)):
            if raw not in seen:
                seen.add(raw)
                out.append(raw)
    return out


def _candidate_raw_reports(plain):
    """Compatibility fallback, guarded against TAF/page-text contamination."""
    return _extract_raw_reports(plain)


def fetch_pilothub_reports():
    decoded = []
    decoded_ids = set()
    for label, url in PILOTHUB_URLS:
        try:
            text = c.get_text(url)
            plain = _normalise(text)

            # Prefer the dedicated METAR block.  Whole-page fallback is allowed
            # only through the strict structural validator above.
            raw_reports = _metar_section_raw_reports(text)
            for raw in _candidate_raw_reports(plain):
                if raw not in raw_reports:
                    raw_reports.append(raw)

            page_rows = []
            page_seen = set()
            for raw in raw_reports:
                try:
                    row = c.decode_metar(raw, source='PILOTHUB_METAR_IMGW')
                except Exception:
                    row = None
                if not row or not is_fresh(row, MAX_PILOTHUB_AGE_MIN):
                    continue
                row['report_type'] = 'SPECI' if raw.lstrip().upper().startswith('SPECI ') else 'METAR'
                if re.match(r'^(?:METAR|SPECI)\s+COR\b', raw, re.I):
                    row['correction'] = True
                ident = (row.get('station'), row.get('obs_time'), row.get('raw'), row.get('report_type'))
                if ident in page_seen:
                    continue
                page_seen.add(ident)
                row['pilothub_page'] = label
                row['pilothub_url'] = url
                page_rows.append(row)
                if ident not in decoded_ids:
                    decoded_ids.add(ident)
                    decoded.append(row)
            print(
                f'PilotHub {label}: fresh={len(page_rows)}' +
                (f' newest={max(page_rows, key=lambda r: obs_time(r)).get("obs_time")}' if page_rows else '')
            )
        except Exception as exc:
            print(f'PilotHub {label} warning:', exc)
    return decoded


def fetch_pilothub_metar():
    decoded = fetch_pilothub_reports()
    if not decoded:
        return None
    return max(decoded, key=lambda row: obs_time(row) or c.parse_dt('1970-01-01T00:00:00Z'))


def same_report(a, b):
    return bool(
        a and b and
        a.get('obs_time') == b.get('obs_time') and
        a.get('raw') == b.get('raw') and
        a.get('report_type', 'METAR') == b.get('report_type', 'METAR')
    )


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
        print('PilotHub: no fresh structurally valid EPIR METAR/SPECI found')
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
