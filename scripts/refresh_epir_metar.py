#!/usr/bin/env python3
"""Robust live EPIR METAR/SPECI collector and freshness guard.

Every live source is scanned for all visible EPIR reports, not only the first
match. All fresh reports are decoded, archived and ranked by observation time.
This prevents an older IMGW/PilotHub row from blocking a newer half-hour METAR.
"""
from __future__ import annotations

import html
import json
import re
from datetime import datetime, timedelta, timezone

import collect_epir_observations as c

MAX_AGE_MIN = 360
FUTURE_TOLERANCE_MIN = 10
SOURCE_PRIORITY = {
    'IMGW_AVIATION_METAR': 50,
    'PILOTHUB_METAR_IMGW': 40,
    'OGIMET_METAR': 30,
    'METAR_CZAD': 20,
    'METEO_MIL_MANUAL_METAR': 10,
}

LIVE_PAGES = (
    ('IMGW', 'https://awiacja.imgw.pl/metar-i-taf', 'IMGW_AVIATION_METAR'),
    ('PILOTHUB', 'https://pilothub.pl/lotniska/inowroclaw-szpital', 'PILOTHUB_METAR_IMGW'),
    ('CZAD', 'https://metar.czad.org/', 'METAR_CZAD'),
)


def report_identity(row):
    return (
        (row or {}).get('station'),
        (row or {}).get('obs_time'),
        (row or {}).get('raw') or (row or {}).get('visibility_report'),
    )


def obs_time(row):
    return c.parse_dt((row or {}).get('obs_time'))


def valid(row):
    t = obs_time(row)
    if not t:
        return False
    delta = (c.now() - t).total_seconds() / 60.0
    return -FUTURE_TOLERANCE_MIN <= delta <= MAX_AGE_MIN


def rank(row):
    t = obs_time(row) or datetime(1970, 1, 1, tzinfo=timezone.utc)
    return (t, SOURCE_PRIORITY.get((row or {}).get('source'), 0))


def extract_epir_reports(text, source):
    """Decode every EPIR METAR/SPECI visible in a text/HTML response."""
    plain = html.unescape(re.sub(r'<[^>]+>', ' ', text or ''))
    plain = re.sub(r'\s+', ' ', plain)
    out = []
    seen = set()
    pattern = re.compile(
        r'\b(?:(METAR|SPECI)\s+)?(EPIR\s+\d{6}Z\s+.*?\bQ\d{4}\b)=?',
        re.I,
    )
    for m in pattern.finditer(plain):
        prefix = (m.group(1) or '').upper()
        raw = re.sub(r'\s+', ' ', m.group(2)).strip()
        if prefix:
            raw_for_decode = prefix + ' ' + raw
        else:
            raw_for_decode = raw
        row = c.decode_metar(raw_for_decode, source=source)
        if not row:
            continue
        # Preserve report class for verification statistics even though the base
        # decoder normalizes the raw string by removing METAR/SPECI prefix.
        row['report_type'] = 'SPECI' if prefix == 'SPECI' else 'METAR'
        ident = report_identity(row)
        if ident not in seen:
            seen.add(ident)
            out.append(row)
    return out


def fetch_page_reports(label, url, source):
    try:
        rows = extract_epir_reports(c.get_text(url), source)
        fresh = [r for r in rows if valid(r)]
        print(f'{label}: decoded={len(rows)} fresh={len(fresh)}' + (
            f' newest={max(fresh, key=rank).get("obs_time")}' if fresh else ''))
        return fresh
    except Exception as exc:
        print(f'{label}: source warning: {exc}')
        return []


def fetch_ogimet_reports():
    rows = []
    try:
        for t, raw in c.csv_rows(c.ogimet('metar', 8), c.ICAO):
            row = c.decode_metar(raw, t, source='OGIMET_METAR')
            if row:
                row['report_type'] = 'SPECI' if str(raw).lstrip().upper().startswith('SPECI') else 'METAR'
                if valid(row):
                    rows.append(row)
    except Exception as exc:
        print(f'OGIMET: source warning: {exc}')
    print(f'OGIMET: fresh={len(rows)}' + (f' newest={max(rows, key=rank).get("obs_time")}' if rows else ''))
    return rows


def fetch_candidates():
    rows = []
    for label, url, source in LIVE_PAGES:
        rows.extend(fetch_page_reports(label, url, source))
    rows.extend(fetch_ogimet_reports())

    # De-duplicate identical reports but keep the higher-priority source for the
    # same station/time/raw payload.
    best = {}
    for row in rows:
        ident = report_identity(row)
        old = best.get(ident)
        if old is None or SOURCE_PRIORITY.get(row.get('source'), 0) > SOURCE_PRIORITY.get(old.get('source'), 0):
            best[ident] = row
    return list(best.values())


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


def main():
    latest_path = c.OUT / 'latest.json'
    try:
        latest = json.loads(latest_path.read_text(encoding='utf-8'))
    except Exception:
        latest = {}

    live = fetch_candidates()
    archived_count = sum(1 for row in live if archive(row))

    candidates = list(live)
    archived = recent_recursive('metar', hours=6)
    archived_latest = archived[-1] if archived else None
    if valid(archived_latest):
        candidates.append(archived_latest)

    existing = latest.get('metar')
    if valid(existing):
        candidates.append(existing)

    if not candidates:
        raise SystemExit('No fresh EPIR METAR available from live sources or archive')

    chosen = max(candidates, key=rank)
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

    latest.update({
        'schema': 'epir-observation-latest-v2',
        'station': station,
        'updated_at': fused.get('obs_time') if fused else chosen.get('obs_time'),
        'collected_at': c.iso(c.now()),
        'metar': chosen,
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

    newest_live = max(live, key=rank) if live else None
    print(json.dumps({
        'fresh_guard': 'ok',
        'live_candidate_count': len(live),
        'new_live_archived': archived_count,
        'newest_live_source': (newest_live or {}).get('source'),
        'newest_live_time': (newest_live or {}).get('obs_time'),
        'chosen_source': chosen.get('source'),
        'chosen_time': chosen.get('obs_time'),
        'chosen_raw': chosen.get('raw'),
        'recent_metar_count': len(metars),
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
