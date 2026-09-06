#!/usr/bin/env python3
"""Select the freshest EPIR METAR from all available sources and rebuild recent history.

This is a final guard after the primary/fallback collectors. It prevents a stale
but technically valid upstream page from winning over a newer report and reads
both flat working files and the canonical YYYY/MM/DD archive layout.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import collect_epir_observations as c
import supplement_metar_pilothub as ph

MAX_AGE_MIN = 180
FUTURE_TOLERANCE_MIN = 10
SOURCE_PRIORITY = {
    'IMGW_AVIATION_METAR': 40,
    'PILOTHUB_METAR_IMGW': 30,
    'OGIMET_METAR': 20,
    'METAR_CZAD': 10,
}


def get_ogimet():
    rows = c.csv_rows(c.ogimet('metar', 6), c.ICAO)
    for t, raw in rows:
        row = c.decode_metar(raw, t, source='OGIMET_METAR')
        if row:
            return row
    return None


def valid(row):
    t = c.parse_dt((row or {}).get('obs_time'))
    if not t:
        return False
    delta = (c.now() - t).total_seconds() / 60
    return -FUTURE_TOLERANCE_MIN <= delta <= MAX_AGE_MIN


def fetch_candidates():
    calls = [
        ('IMGW', c.metar_imgw),
        ('OGIMET', get_ogimet),
        ('CZAD', c.metar_czad),
        ('PILOTHUB', ph.fetch_pilothub_metar),
    ]
    rows = []
    for label, fn in calls:
        try:
            row = fn()
            if valid(row):
                rows.append(row)
            elif row:
                print(f'{label}: rejected stale/future report {row.get("obs_time")}')
        except Exception as exc:
            print(f'{label}: source warning: {exc}')
    return rows


def rank(row):
    t = c.parse_dt(row.get('obs_time')) or datetime(1970, 1, 1, tzinfo=timezone.utc)
    return (t, SOURCE_PRIORITY.get(row.get('source'), 0))


def report_identity(row):
    return (
        (row or {}).get('station'),
        (row or {}).get('obs_time'),
        (row or {}).get('raw') or (row or {}).get('visibility_report'),
    )


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
            t = c.parse_dt(row.get('obs_time'))
            if not t or t < cutoff:
                continue
            ident = report_identity(row)
            old = by_report.get(ident)
            if old is None or SOURCE_PRIORITY.get(row.get('source'), 0) > SOURCE_PRIORITY.get(old.get('source'), 0):
                by_report[ident] = row
    return sorted(by_report.values(), key=lambda r: c.parse_dt(r.get('obs_time')) or datetime(1970, 1, 1, tzinfo=timezone.utc))


def archive(row):
    if not row or not row.get('obs_time'):
        return False
    t = c.parse_dt(row['obs_time'])
    canonical = c.OUT / 'metar' / t.strftime('%Y') / t.strftime('%m') / f'{t:%d}.jsonl'
    ident = report_identity(row)
    if any(report_identity(x) == ident for x in read_jsonl(canonical)):
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

    candidates = fetch_candidates()
    existing = latest.get('metar')
    if valid(existing):
        candidates.append(existing)
    if not candidates:
        raise SystemExit('No fresh EPIR METAR available from any source')

    chosen = max(candidates, key=rank)
    archive(chosen)

    metars = recent_recursive('metar')
    # Ensure the just-selected row participates even before/without archive migration.
    if not any(report_identity(x) == report_identity(chosen) for x in metars):
        metars.append(chosen)
        metars.sort(key=lambda r: c.parse_dt(r.get('obs_time')) or datetime(1970, 1, 1, tzinfo=timezone.utc))
    synops = recent_recursive('synop')
    synop = max(synops, key=lambda r: c.parse_dt(r.get('obs_time')) or datetime(1970, 1, 1, tzinfo=timezone.utc)) if synops else latest.get('synop')
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

    print(json.dumps({
        'fresh_guard': 'ok',
        'candidate_count': len(candidates),
        'chosen_source': chosen.get('source'),
        'chosen_time': chosen.get('obs_time'),
        'chosen_raw': chosen.get('raw'),
        'recent_metar_count': len(metars),
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
