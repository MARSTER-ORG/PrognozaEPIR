#!/usr/bin/env python3
"""Fallback collector for Inowrocław SYNOP 12342.

Ogimet documents `block` as a prefix filter, but some current responses do not
contain 12342 for the narrow request. This fallback asks for Poland and then
selects WMO 12342 exactly. It reuses the FM-12 decoder and archive/fusion code
from collect_epir_observations.py.
"""
import json
import sys
import urllib.parse
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collect_epir_observations as c


def fetch_synop_poland(hours=18):
    end = c.now() + timedelta(minutes=5)
    begin = end - timedelta(hours=hours)
    params = {
        'state': 'Pol',
        'begin': begin.strftime('%Y%m%d%H%M'),
        'end': end.strftime('%Y%m%d%H%M'),
        'header': 'yes',
        'lang': 'eng',
    }
    url = 'https://www.ogimet.com/cgi-bin/getsynop?' + urllib.parse.urlencode(params)
    text = c.get_text(url)
    rows = c.csv_rows(text, c.SYNOP_ID)
    for dt, raw in rows:
        decoded = c.decode_synop(raw, dt)
        if decoded:
            decoded['source'] = 'OGIMET_SYNOP_RAW_POLAND'
            return decoded
    return None


def main():
    try:
        synop = fetch_synop_poland()
    except Exception as exc:
        print('SYNOP Poland fallback warning:', exc)
        return
    if not synop:
        print('SYNOP 12342 not present in the current Poland-wide Ogimet window')
        return

    day = c.parse_dt(synop['obs_time']).strftime('%Y-%m-%d')
    c.append(c.OUT / 'synop' / f'{day}.jsonl', synop)

    metars = c.recent('metar')
    synops = c.recent('synop')
    hist = c.history(metars, synops)
    fused = hist[-1] if hist else c.fuse(metars[-1] if metars else None, synop)

    latest_path = c.OUT / 'latest.json'
    try:
        latest = json.loads(latest_path.read_text(encoding='utf-8'))
    except Exception:
        latest = {}
    latest.update({
        'schema': 'epir-observation-latest-v2',
        'station': {'icao': c.ICAO, 'synop': c.SYNOP_ID, 'wigos': c.WIGOS_ID, 'lat': c.LAT, 'lon': c.LON},
        'updated_at': fused.get('obs_time') if fused else synop.get('obs_time'),
        'collected_at': c.iso(c.now()),
        'metar': latest.get('metar'),
        'synop': synop,
        'fused': fused,
    })
    c.write(latest_path, latest, True)
    c.write(c.OUT / 'recent.json', {
        'schema': 'epir-observation-history-v2',
        'station': latest['station'],
        'hours': 30,
        'metar': metars,
        'synop': synops,
        'observations': hist,
    })
    print(json.dumps({
        'synop_time': synop.get('obs_time'),
        'synop_visibility_m': synop.get('visibility_m'),
        'raw': synop.get('raw'),
        'fused_visibility_m': fused.get('visibility_m') if fused else None,
        'fused_visibility_source': fused.get('visibility_source') if fused else None,
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
