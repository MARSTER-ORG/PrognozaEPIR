#!/usr/bin/env python3
"""Authoritative live EPIR METAR/SPECI collector.

The official IMGW Aviation API is primary. PilotHub is fallback-only and is
parsed exclusively by supplement_metar_pilothub.py, which has a strict
telegram validator. Generic whole-page PilotHub scanning is deliberately
disabled: airport pages contain TAF prose, NOTAMs and other text and must never
be treated as a raw METAR source.

This module also removes legacy page-contaminated METAR rows from the working
observation/central archives before every fetch cycle.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import refresh_epir_metar as refresh
import supplement_metar_pilothub as pilothub

# IMGW changed the behaviour of aviation-api.imgw.pl and the formerly used
# cache-buster query parameter ("_=") now causes HTTP 400. Keep the last known
# supported request first, then progressively simpler METAR-only forms. A
# successful form is remembered for the life of the Railway process, so after
# recovery subsequent 5-minute cycles make only one IMGW request.
IMGW_API_CANDIDATES = (
    ('metar-taf-count4', 'https://aviation-api.imgw.pl/data/last?params=metar,taf&format=json&count=4'),
    ('metar-count4', 'https://aviation-api.imgw.pl/data/last?params=metar&format=json&count=4'),
    ('metar', 'https://aviation-api.imgw.pl/data/last?params=metar&format=json'),
)
_working_imgw_api: tuple[str, str] | None = None
ROOT = Path(__file__).resolve().parents[1]

# A valid EPIR METAR/SPECI after DDHHMMZ proceeds to wind (optionally AUTO).
# A TAF proceeds to a DDHH/DDHH validity group, so it is rejected here.
_METAR_BODY_RE = re.compile(
    r'^(?:(?:METAR|SPECI)\s+)?(?:COR\s+)?EPIR\s+\d{6}Z\s+'
    r'(?:AUTO\s+)?(?:VRB|\d{3})\d{2,3}(?:G\d{2,3})?KT\b',
    re.I,
)
_VALIDITY_RE = re.compile(r'\b\d{4}/\d{4}\b')
_QNH_RE = re.compile(r'\bQ\d{4}\b', re.I)
_PAGE_TEXT_RE = re.compile(
    r'\b(?:NOTAM|Pokaż zdekodowaną|Prognoza ważna|Źródła danych|Często zadawane pytania)\b',
    re.I,
)
MAX_METAR_RAW_LEN = 512

# IMPORTANT: do not insert PilotHub into refresh.LIVE_PAGES. The exact,
# guarded parser in supplement_metar_pilothub.py is the only PilotHub path.
_base_fetch_candidates = refresh.fetch_candidates
_base_archive = refresh.archive


def _normalise_raw(value: str) -> str:
    return re.sub(r'\s+', ' ', str(value or '')).strip().strip('"')


def structurally_valid_metar(row: dict | None) -> bool:
    """Accept only a bounded, self-contained EPIR METAR/SPECI telegram."""
    if not isinstance(row, dict):
        return False
    raw = _normalise_raw(row.get('raw'))
    if not raw or len(raw) > MAX_METAR_RAW_LEN:
        return False
    raw = raw.rstrip('=').strip()
    if '=' in raw:
        return False
    if _VALIDITY_RE.search(raw):
        return False
    if _PAGE_TEXT_RE.search(raw):
        return False
    if not _METAR_BODY_RE.search(raw):
        return False
    if not _QNH_RE.search(raw):
        return False
    return True


def _sanitize_jsonl(path: Path) -> tuple[int, int]:
    """Remove only structurally impossible EPIR METAR/SPECI rows."""
    try:
        original = path.read_text(encoding='utf-8')
    except OSError:
        return 0, 0

    kept = []
    removed = 0
    parse_errors = 0
    for line in original.splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except Exception:
            parse_errors += 1
            removed += 1
            continue

        station = str((row or {}).get('station') or '').upper()
        kind = str((row or {}).get('type') or (row or {}).get('report_type') or '').upper()
        if station == 'EPIR' and kind in {'METAR', 'SPECI'} and not structurally_valid_metar(row):
            removed += 1
            continue
        kept.append(row)

    if removed:
        text = ''.join(
            json.dumps(row, ensure_ascii=False, separators=(',', ':'), sort_keys=True) + '\n'
            for row in kept
        )
        tmp = path.with_name(f'.{path.name}.sanitize.tmp')
        tmp.write_text(text, encoding='utf-8')
        tmp.replace(path)
        print(
            f'METAR sanitizer: {path.relative_to(ROOT)} removed={removed} '
            f'parse_errors={parse_errors}',
            flush=True,
        )
    return removed, parse_errors


def sanitize_existing_archives() -> dict:
    """Clean legacy contamination before the central archive is rebuilt."""
    roots = (
        ROOT / 'data' / 'observations' / 'metar',
        ROOT / 'data' / 'messages' / 'metar',
        ROOT / 'data' / 'messages' / 'speci',
    )
    files = 0
    removed = 0
    parse_errors = 0
    seen = set()
    for root in roots:
        if not root.exists():
            continue
        for path in root.rglob('*.jsonl'):
            resolved = path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            files += 1
            r, p = _sanitize_jsonl(path)
            removed += r
            parse_errors += p

    if removed:
        print(
            f'METAR sanitizer summary: files={files} removed={removed} '
            f'parse_errors={parse_errors}',
            flush=True,
        )
    return {'files': files, 'removed': removed, 'parse_errors': parse_errors}


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


def _decode_imgw_payload(payload, query_name: str):
    epir = payload.get('EPIR') if isinstance(payload, dict) else None
    metars = (epir or {}).get('metars') if isinstance(epir, dict) else None
    if not metars:
        print(f'IMGW Aviation API {query_name}: EPIR.metars unavailable')
        return []

    rows = []
    seen = set()
    raw_records = 0
    rejected = 0
    for record in _walk_message_records(metars):
        raw = (record.get('message') or '').strip()
        if 'EPIR' not in raw.upper():
            continue
        raw_records += 1
        decoded_rows = refresh.extract_epir_reports(raw, 'IMGW_AVIATION_METAR')
        for row in decoded_rows:
            if not structurally_valid_metar(row):
                rejected += 1
                continue
            if not refresh.backfill_valid(row):
                continue
            row['imgw_api'] = 'aviation-api.imgw.pl'
            row['imgw_api_query'] = query_name
            row['imgw_api_date'] = record.get('date')
            row['imgw_api_file'] = record.get('file')
            row['imgw_api_message_type'] = record.get('messageType')
            ident = refresh.report_identity(row)
            if ident not in seen:
                seen.add(ident)
                rows.append(row)

    rows.sort(key=refresh.rank)
    print(
        f'IMGW Aviation API {query_name}: raw_records=', raw_records,
        ' decoded/backfill=', len(rows),
        ' rejected_shape=', rejected,
        ' newest=', (rows[-1].get('obs_time') if rows else None),
    )
    for row in rows:
        print('IMGW EPIR:', row.get('obs_time'), row.get('report_type'), row.get('raw'))
    return rows


def _imgw_candidates():
    if _working_imgw_api is not None:
        yield _working_imgw_api
    for item in IMGW_API_CANDIDATES:
        if item != _working_imgw_api:
            yield item


def fetch_imgw_api_reports():
    """Fetch IMGW METARs without undocumented cache-buster parameters."""
    global _working_imgw_api
    last_error = None
    for query_name, url in _imgw_candidates():
        try:
            payload = json.loads(refresh.c.get_text(url, timeout=20))
            rows = _decode_imgw_payload(payload, query_name)
            if rows:
                _working_imgw_api = (query_name, url)
                print(f'IMGW Aviation API selected query={query_name}')
                return rows
        except Exception as exc:
            last_error = exc
            print(f'IMGW Aviation API {query_name} warning:', exc)
            if _working_imgw_api == (query_name, url):
                _working_imgw_api = None
    if last_error:
        print('IMGW Aviation API exhausted all query forms:', last_error)
    return []


def fetch_candidates():
    sanitize_existing_archives()

    rows = list(fetch_imgw_api_reports())

    for row in _base_fetch_candidates():
        if structurally_valid_metar(row):
            rows.append(row)
        else:
            print('METAR generic candidate rejected:', (row or {}).get('source'), (row or {}).get('raw'))

    try:
        for row in pilothub.fetch_pilothub_reports():
            if structurally_valid_metar(row):
                rows.append(row)
            else:
                print('PilotHub candidate rejected after strict parser:', (row or {}).get('raw'))
    except Exception as exc:
        print('PilotHub exact parser warning:', exc)

    best = {}
    for row in rows:
        if not structurally_valid_metar(row):
            continue
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
    if not structurally_valid_metar(row):
        print('archive rejected structurally invalid METAR:', (row or {}).get('raw'))
        return False
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
