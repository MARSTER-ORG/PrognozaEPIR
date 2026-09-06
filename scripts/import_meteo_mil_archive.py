#!/usr/bin/env python3
"""Import manually captured EPIR METAR/SYNOP reports from meteo.mil.pl.

Input files:
  data/observations/manual/meteo_mil/*.tsv

Expected columns:
  timestamp_utc<TAB>report

The importer intentionally reuses decode_metar() and decode_synop() from
collect_epir_observations.py so historical backfill and live observations use
the same decoding rules. Imported rows replace older rows for the same
station/observation time to avoid double-counting one observation from several
sources during verification/learning.
"""
from __future__ import annotations

import csv
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import collect_epir_observations as c

ROOT = Path('data/observations')
MANUAL = ROOT / 'manual' / 'meteo_mil'


def parse_utc(value: str) -> datetime:
    value = value.strip()
    for fmt in ('%Y-%m-%d %H:%M', '%Y-%m-%dT%H:%M:%SZ', '%Y-%m-%dT%H:%M:%S%z'):
        try:
            dt = datetime.strptime(value, fmt)
            return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
        except ValueError:
            pass
    raise ValueError(f'Unsupported UTC timestamp: {value!r}')


def read_existing(path: Path):
    rows = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding='utf-8').splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def write_jsonl(path: Path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    text = ''.join(json.dumps(r, ensure_ascii=False, separators=(',', ':')) + '\n' for r in rows)
    old = path.read_text(encoding='utf-8') if path.exists() else None
    if text == old:
        return False
    path.write_text(text, encoding='utf-8')
    return True


def merge_by_observation(path: Path, imported):
    # One canonical observation per station + timestamp. Manual meteo.mil data
    # wins at the same timestamp because it preserves the original report.
    keys = {(r.get('station'), r.get('obs_time')) for r in imported}
    rows = [r for r in read_existing(path) if (r.get('station'), r.get('obs_time')) not in keys]
    rows.extend(imported)
    rows.sort(key=lambda r: (r.get('obs_time') or '', r.get('station') or '', r.get('source') or ''))
    return write_jsonl(path, rows)


def decode_files():
    grouped = {'metar': defaultdict(list), 'synop': defaultdict(list)}
    counts = {'metar': 0, 'synop': 0, 'rejected': 0}

    for path in sorted(MANUAL.glob('*.tsv')):
        with path.open('r', encoding='utf-8', newline='') as f:
            reader = csv.DictReader(f, delimiter='\t')
            for n, row in enumerate(reader, start=2):
                timestamp = (row.get('timestamp_utc') or '').strip()
                report = (row.get('report') or '').strip()
                if not timestamp or not report:
                    continue
                try:
                    dt = parse_utc(timestamp)
                    if report.upper().startswith(('METAR ', 'SPECI ')):
                        decoded = c.decode_metar(report, dt, source='METEO_MIL_MANUAL_METAR')
                        kind = 'metar'
                    elif report.upper().startswith('AAXX '):
                        decoded = c.decode_synop(report, dt)
                        kind = 'synop'
                        if decoded:
                            decoded['source'] = 'METEO_MIL_MANUAL_SYNOP_RAW'
                    else:
                        decoded = None
                        kind = None
                except Exception as exc:
                    print(f'{path}:{n}: decode error: {exc}')
                    decoded = None
                    kind = None

                if not decoded or not kind:
                    counts['rejected'] += 1
                    print(f'{path}:{n}: rejected: {report}')
                    continue

                day = dt.strftime('%Y-%m-%d')
                grouped[kind][day].append(decoded)
                counts[kind] += 1

    return grouped, counts


def main():
    grouped, counts = decode_files()
    changed = []

    for kind in ('metar', 'synop'):
        for day, rows in sorted(grouped[kind].items()):
            # Deduplicate the manual batch itself by station + time, last row wins.
            unique = {}
            for row in rows:
                unique[(row.get('station'), row.get('obs_time'))] = row
            rows = list(unique.values())
            rows.sort(key=lambda r: r.get('obs_time') or '')

            y, mo, d = day.split('-')
            flat = ROOT / kind / f'{day}.jsonl'
            canonical = ROOT / kind / y / mo / f'{d}.jsonl'
            if merge_by_observation(flat, rows):
                changed.append(str(flat))
            if merge_by_observation(canonical, rows):
                changed.append(str(canonical))

    print(json.dumps({
        'source': 'meteo.mil.pl manual archive',
        'decoded_metar': counts['metar'],
        'decoded_synop': counts['synop'],
        'rejected': counts['rejected'],
        'changed_files': changed,
    }, ensure_ascii=False, indent=2))

    if counts['rejected']:
        raise SystemExit('Some manual reports could not be decoded')


if __name__ == '__main__':
    main()
