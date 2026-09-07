#!/usr/bin/env python3
"""Robust live EPIR METAR/SPECI collector with archive backfill.

The collector intentionally separates two concepts:
- BACKFILL_MAX_AGE_MIN: older reports may still be archived to repair gaps;
- LATEST_MAX_AGE_MIN: only a genuinely recent report may be marked fresh.

All visible EPIR METAR/SPECI reports are decoded and archived. There is no
fixed report-count limit: if IMGW exposes four routine METARs plus SPECI, all
of them are preserved. Source priority is only a tie-breaker for the same
observation time; the newest DDHHMMZ timestamp always wins.
"""
from __future__ import annotations

import html
import json
import re
from datetime import datetime, timedelta, timezone

import collect_epir_observations as c

# A long window is useful for repairing archive gaps after a delayed/dropped
# GitHub Actions run. It must never be confused with freshness of latest.json.
BACKFILL_MAX_AGE_MIN = 12 * 60
LATEST_MAX_AGE_MIN = 60
FUTURE_TOLERANCE_MIN = 10
GAP_DIAGNOSTIC_HOURS = 4

SOURCE_PRIORITY = {
    'IMGW_AVIATION_METAR': 60,
    'PILOTHUB_METAR_IMGW': 40,
    'OGIMET_METAR': 30,
    'METAR_CZAD': 20,
    'METEO_MIL_MANUAL_METAR': 10,
    'EPIR_BULK_ARCHIVE_METAR': 5,
}

# Keep the canonical IMGW entry first because live_metar_collector.py inserts
# the PilotHub EPIN page immediately after it.
LIVE_PAGES = (
    ('IMGW', 'https://awiacja.imgw.pl/metar-i-taf', 'IMGW_AVIATION_METAR'),
    ('PILOTHUB-SZPITAL', 'https://pilothub.pl/lotniska/inowroclaw-szpital', 'PILOTHUB_METAR_IMGW'),
    ('PILOTHUB-LATKOWO', 'https://pilothub.pl/lotniska/inowroclaw-latkowo-lotnisko-wojskowe', 'PILOTHUB_METAR_IMGW'),
    ('CZAD', 'https://metar.czad.org/', 'METAR_CZAD'),
)

# IMGW's current aviation page is client-driven, so the initial HTML can contain
# zero reports. The legacy IMGW METAR endpoints are also probed when available.
# Failures are non-fatal; all successful responses are merged and deduplicated.
IMGW_ENDPOINTS = (
    ('IMGW-MODULE', 'https://awiacja.imgw.pl/metar-i-taf'),
    ('IMGW-METAR00', 'https://awiacja.imgw.pl/metar00.php?airport=EPIR'),
    ('IMGW-METAR30', 'https://awiacja.imgw.pl/metar30.php?airport=EPIR'),
    ('IMGW-RSS00', 'https://awiacja.imgw.pl/rss/metar00.php?airport=EPIR'),
    ('IMGW-RSS30', 'https://awiacja.imgw.pl/rss/metar30.php?airport=EPIR'),
)


def report_identity(row):
    return (
        (row or {}).get('station'),
        (row or {}).get('obs_time'),
        (row or {}).get('raw') or (row or {}).get('visibility_report'),
    )


def obs_time(row):
    return c.parse_dt((row or {}).get('obs_time'))


def age_minutes(row):
    t = obs_time(row)
    if not t:
        return None
    return (c.now() - t).total_seconds() / 60.0


def valid(row, max_age_min=LATEST_MAX_AGE_MIN):
    age = age_minutes(row)
    return age is not None and -FUTURE_TOLERANCE_MIN <= age <= max_age_min


def backfill_valid(row):
    return valid(row, BACKFILL_MAX_AGE_MIN)


def latest_valid(row):
    return valid(row, LATEST_MAX_AGE_MIN)


def rank(row):
    t = obs_time(row) or datetime(1970, 1, 1, tzinfo=timezone.utc)
    return (t, SOURCE_PRIORITY.get((row or {}).get('source'), 0))


def _normalise_payload_text(text):
    """Make HTML/XML/JSON-ish responses searchable for raw METAR strings."""
    text = html.unescape(text or '')
    # Common JSON escaping used by client-rendered pages/API payloads.
    text = re.sub(r'\\u003[dD]', '=', text)
    text = re.sub(r'\\u002[fF]', '/', text)
    text = text.replace('\\n', ' ').replace('\\r', ' ').replace('\\t', ' ')
    text = text.replace('\\"', '"')
    text = re.sub(r'<[^>]+>', ' ', text)
    return re.sub(r'\s+', ' ', text)


def extract_epir_reports(text, source):
    """Decode every EPIR METAR/SPECI visible in a response, with no count cap."""
    plain = _normalise_payload_text(text)
    out = []
    seen = set()
    pattern = re.compile(
        r'\b(?:(METAR|SPECI)\s+)?(?:(COR)\s+)?'
        r'(EPIR\s+\d{6}Z\s+.*?\bQ\d{4}\b)=?',
        re.I,
    )
    for m in pattern.finditer(plain):
        prefix = (m.group(1) or '').upper()
        cor = (m.group(2) or '').upper()
        raw = re.sub(r'\s+', ' ', m.group(3)).strip()
        pieces = [x for x in (prefix, cor, raw) if x]
        row = c.decode_metar(' '.join(pieces), source=source)
        if not row:
            continue
        row['report_type'] = 'SPECI' if prefix == 'SPECI' else 'METAR'
        if cor:
            row['correction'] = True
        ident = report_identity(row)
        if ident not in seen:
            seen.add(ident)
            out.append(row)
    return out


def _dedupe(rows):
    best = {}
    for row in rows:
        if not row:
            continue
        ident = report_identity(row)
        old = best.get(ident)
        if old is None or SOURCE_PRIORITY.get(row.get('source'), 0) > SOURCE_PRIORITY.get(old.get('source'), 0):
            best[ident] = row
    return list(best.values())


def fetch_page_reports(label, url, source):
    try:
        rows = extract_epir_reports(c.get_text(url, timeout=12), source)
        rows = [r for r in rows if backfill_valid(r)]
        for r in rows:
            if source == 'PILOTHUB_METAR_IMGW':
                r['pilothub_page'] = label
                r['pilothub_url'] = url
        print(f'{label}: decoded/backfill={len(rows)}' + (
            f' newest={max(rows, key=rank).get("obs_time")}' if rows else ''))
        return rows
    except Exception as exc:
        print(f'{label}: source warning: {exc}')
        return []


def fetch_imgw_reports():
    """Merge every EPIR METAR/SPECI obtainable from official IMGW endpoints."""
    rows = []
    for label, url in IMGW_ENDPOINTS:
        try:
            decoded = extract_epir_reports(c.get_text(url, timeout=12), 'IMGW_AVIATION_METAR')
            decoded = [r for r in decoded if backfill_valid(r)]
            for r in decoded:
                r['imgw_endpoint'] = label
                r['imgw_url'] = url
            rows.extend(decoded)
            print(f'{label}: decoded/backfill={len(decoded)}' + (
                f' newest={max(decoded, key=rank).get("obs_time")}' if decoded else ''))
        except Exception as exc:
            print(f'{label}: source warning: {exc}')
    return _dedupe(rows)


def fetch_ogimet_reports():
    rows = []
    try:
        for t, raw in c.csv_rows(c.ogimet('metar', 12), c.ICAO):
            row = c.decode_metar(raw, t, source='OGIMET_METAR')
            if row:
                row['report_type'] = 'SPECI' if str(raw).lstrip().upper().startswith('SPECI') else 'METAR'
                if backfill_valid(row):
                    rows.append(row)
    except Exception as exc:
        print(f'OGIMET: source warning: {exc}')
    print(f'OGIMET: backfill={len(rows)}' + (f' newest={max(rows, key=rank).get("obs_time")}' if rows else ''))
    return rows


def fetch_candidates():
    rows = []
    rows.extend(fetch_imgw_reports())
    for label, url, source in LIVE_PAGES:
        if source == 'IMGW_AVIATION_METAR':
            continue
        rows.extend(fetch_page_reports(label, url, source))
    rows.extend(fetch_ogimet_reports())
    return _dedupe(rows)


def read_jsonl(path):
    out = []
    try:
        lines = path.read_text(encoding='utf-8').splitlines()
    except Exception:
        return out
    for line in lines:
        try:
            row = json.loads(line)
            if isinstance(row, dict):
                out.append(row)
        except Exception:
            pass
    return out


def recent_recursive(kind, hours=30):
    root = c.OUT / kind
    if not root.exists():
        return []
    cutoff = c.now() - timedelta(hours=hours)
    by_report = {}
    for path in root.rglob('*.jsonl'):
        for row in read_jsonl(path):
            t = obs_time(row)
            if not t or t < cutoff:
                continue
            ident = report_identity(row)
            old = by_report.get(ident)
            if old is None or SOURCE_PRIORITY.get(row.get('source'), 0) > SOURCE_PRIORITY.get(old.get('source'), 0):
                by_report[ident] = row
    return sorted(by_report.values(), key=lambda r: obs_time(r) or datetime(1970, 1, 1, tzinfo=timezone.utc))


def archive(row):
    if not row or not row.get('obs_time'):
        return False
    t = obs_time(row)
    if not t:
        return False
    canonical = c.OUT / 'metar' / t.strftime('%Y') / t.strftime('%m') / f'{t:%d}.jsonl'
    ident = report_identity(row)
    existing = read_jsonl(canonical)
    if any(report_identity(x) == ident for x in existing):
        return False
    canonical.parent.mkdir(parents=True, exist_ok=True)
    with canonical.open('a', encoding='utf-8') as f:
        f.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')
    return True


def missing_regular_slots(rows, hours=GAP_DIAGNOSTIC_HOURS):
    """Return missing routine :00/:30 EPIR METAR slots; SPECI is extra, never a substitute."""
    end = c.now().replace(second=0, microsecond=0)
    end = end.replace(minute=30 if end.minute >= 30 else 0)
    start = end - timedelta(hours=hours)
    observed = set()
    for row in rows:
        if (row or {}).get('report_type') == 'SPECI':
            continue
        t = obs_time(row)
        if t and t.minute in (0, 30):
            observed.add(t.replace(second=0, microsecond=0))
    missing = []
    slot = start
    while slot <= end:
        if slot not in observed:
            missing.append(c.iso(slot))
        slot += timedelta(minutes=30)
    return missing


def main():
    latest_path = c.OUT / 'latest.json'
    try:
        latest = json.loads(latest_path.read_text(encoding='utf-8'))
    except Exception:
        latest = {}

    fetched = [r for r in fetch_candidates() if backfill_valid(r)]
    archived_count = sum(1 for row in fetched if archive(row))

    recent_backfill = recent_recursive('metar', hours=12)
    archived_latest = recent_backfill[-1] if recent_backfill else None
    existing = latest.get('metar')

    candidates = [r for r in fetched if latest_valid(r)]
    if latest_valid(archived_latest):
        candidates.append(archived_latest)
    if latest_valid(existing):
        candidates.append(existing)

    freshness = 'ok'
    if candidates:
        chosen = max(candidates, key=rank)
    else:
        # Preserve the newest observation for transparency, but mark it stale.
        fallback = list(fetched)
        if backfill_valid(archived_latest):
            fallback.append(archived_latest)
        if backfill_valid(existing):
            fallback.append(existing)
        if not fallback:
            raise SystemExit('No EPIR METAR available from live sources or 12 h archive')
        chosen = max(fallback, key=rank)
        freshness = 'stale'

    archive(chosen)

    metars = recent_recursive('metar')
    if not any(report_identity(x) == report_identity(chosen) for x in metars):
        metars.append(chosen)
        metars.sort(key=lambda r: obs_time(r) or datetime(1970, 1, 1, tzinfo=timezone.utc))

    synops = recent_recursive('synop')
    synop = max(synops, key=lambda r: obs_time(r) or datetime(1970, 1, 1, tzinfo=timezone.utc)) if synops else latest.get('synop')
    hist = c.history(metars, synops)
    fused = hist[-1] if hist else c.fuse(chosen, synop)
    station = {'icao': c.ICAO, 'synop': c.SYNOP_ID, 'wigos': c.WIGOS_ID, 'lat': c.LAT, 'lon': c.LON}

    chosen_age = age_minutes(chosen)
    gaps = missing_regular_slots(metars)
    latest.update({
        'schema': 'epir-observation-latest-v2',
        'station': station,
        'updated_at': fused.get('obs_time') if fused else chosen.get('obs_time'),
        'collected_at': c.iso(c.now()),
        'metar': chosen,
        'metar_freshness': {
            'status': freshness,
            'age_min': round(chosen_age, 1) if chosen_age is not None else None,
            'fresh_limit_min': LATEST_MAX_AGE_MIN,
            'backfill_limit_min': BACKFILL_MAX_AGE_MIN,
            'missing_routine_slots_last_hours': GAP_DIAGNOSTIC_HOURS,
            'missing_routine_slots': gaps,
        },
        'synop': synop,
        'fused': fused,
    })
    c.write(latest_path, latest, True)
    c.write(c.OUT / 'recent.json', {
        'schema': 'epir-observation-history-v2',
        'station': station,
        'hours': 30,
        'metar': metars,
        'synop': synops,
        'observations': hist,
    })

    newest_fetched = max(fetched, key=rank) if fetched else None
    imgw_rows = [r for r in fetched if r.get('source') == 'IMGW_AVIATION_METAR']
    print(json.dumps({
        'fresh_guard': freshness,
        'latest_limit_min': LATEST_MAX_AGE_MIN,
        'backfill_limit_min': BACKFILL_MAX_AGE_MIN,
        'fetched_candidate_count': len(fetched),
        'imgw_candidate_count': len(imgw_rows),
        'new_live_archived': archived_count,
        'newest_fetched_source': (newest_fetched or {}).get('source'),
        'newest_fetched_time': (newest_fetched or {}).get('obs_time'),
        'chosen_source': chosen.get('source'),
        'chosen_time': chosen.get('obs_time'),
        'chosen_age_min': round(chosen_age, 1) if chosen_age is not None else None,
        'chosen_raw': chosen.get('raw'),
        'recent_metar_count': len(metars),
        'missing_routine_slots': gaps,
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
