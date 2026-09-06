#!/usr/bin/env python3
"""NOAA WIS2 / WMO BUFR fallback for Inowroclaw SYNOP 12342.

The legacy FM-12 text stream is increasingly incomplete. NOAA's public WIS2
node exposes decoded SYNOP BUFR observations through OGC API - Features. This
collector queries the EPIR/Inowroclaw area, selects station 12342 and converts
key BUFR descriptors to the common PrognozaEPIR observation schema.
"""
from __future__ import annotations

import json
import sys
import urllib.parse
from collections import defaultdict
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collect_epir_observations as c

BASE = 'https://wis2node.globaldata.nws.noaa.gov/collections/synop_features/items'
# Tight box around WMO 12342 (52.8333N, 18.3333E).
BBOX = '18.28,52.78,18.39,52.89'
MAX_AGE_HOURS = 18


def station_matches(value):
    s = str(value or '').strip()
    return s == c.SYNOP_ID or s.endswith('-' + c.SYNOP_ID) or s.endswith('_' + c.SYNOP_ID)


def fetch_features():
    start = c.now() - timedelta(hours=MAX_AGE_HOURS)
    end = c.now() + timedelta(minutes=10)
    dt_range = f"{c.iso(start)}/{c.iso(end)}"
    attempts = [
        {'f': 'json', 'limit': '5000', 'station_identifier': c.SYNOP_ID, 'datetime': dt_range},
        {'f': 'json', 'limit': '5000', 'bbox': BBOX, 'datetime': dt_range},
    ]
    last_error = None
    for params in attempts:
        try:
            data = c.get_json(BASE + '?' + urllib.parse.urlencode(params))
            feats = data.get('features', []) if isinstance(data, dict) else []
            matched = [f for f in feats if station_matches((f.get('properties') or {}).get('station_identifier'))]
            if matched:
                return matched
        except Exception as exc:
            last_error = exc
    if last_error:
        raise last_error
    return []


def values_for_time(features):
    grouped = defaultdict(list)
    for f in features:
        p = f.get('properties') or {}
        t = c.parse_dt(p.get('phenomenonTime') or p.get('resultTime'))
        if t:
            grouped[c.iso(t)].append(f)
    if not grouped:
        return None, []
    latest_time = max(grouped, key=lambda x: c.parse_dt(x))
    return latest_time, grouped[latest_time]


def descriptor_rows(features):
    out = defaultdict(list)
    for f in features:
        p = f.get('properties') or {}
        name = str(p.get('fxxyyy') or p.get('name') or '').zfill(6)
        if name:
            out[name].append({
                'value': p.get('value'),
                'units': p.get('units'),
                'description': p.get('description'),
                'parent_bufr': p.get('parent_bufr'),
                'origin': p.get('origin'),
                'metadata': p.get('metadata') or [],
            })
    return out


def num(rows, *codes):
    for code in codes:
        for r in rows.get(code, []):
            v = c.fnum(r.get('value'))
            if v is not None:
                return v
    return None


def pressure_hpa(rows, code):
    for r in rows.get(code, []):
        v = c.fnum(r.get('value'))
        if v is None:
            continue
        units = str(r.get('units') or '').lower()
        if units in ('pa', 'pascal', 'pascals') or v > 2000:
            v /= 100.0
        return c.rnd(v, 1)
    return None


def lowest(rows, code):
    vals = [c.fnum(r.get('value')) for r in rows.get(code, [])]
    vals = [v for v in vals if v is not None and v >= 0]
    return min(vals) if vals else None


def decode(features):
    obs_time, current = values_for_time(features)
    if not obs_time or not current:
        return None
    rows = descriptor_rows(current)

    T = num(rows, '012101')
    Td = num(rows, '012103')
    RH = num(rows, '013003')
    vis = num(rows, '020001')
    wd = num(rows, '011011', '011001')
    ws = num(rows, '011012', '011002')
    gust = num(rows, '011041')
    pmsl = pressure_hpa(rows, '010051')
    pstation = pressure_hpa(rows, '010004')
    ww = num(rows, '020003')
    ww = int(ww) if ww is not None else None
    cloud_pct = num(rows, '020010')
    cloud_base = lowest(rows, '020013')

    fog, mist, freezing_fog, present = c.wx_decode(ww)
    total_oktas = None
    if cloud_pct is not None:
        total_oktas = max(0, min(8, int(round(cloud_pct / 12.5))))

    parents = sorted({str((f.get('properties') or {}).get('parent_bufr') or '') for f in current if (f.get('properties') or {}).get('parent_bufr')})
    origin = sorted({str((f.get('properties') or {}).get('origin') or '') for f in current if (f.get('properties') or {}).get('origin')})
    raw_ref = parents[0] if parents else (origin[0] if origin else f'WIS2-12342-{obs_time}')

    return {
        'source': 'NOAA_WIS2_SYNOP_BUFR',
        'station': c.SYNOP_ID,
        'wigos': c.WIGOS_ID,
        'obs_time': obs_time,
        'temperature_c': c.rnd(T, 1),
        'dew_point_c': c.rnd(Td, 1),
        'relative_humidity_pct': c.rnd(RH if RH is not None else c.rh(T, Td), 1),
        'visibility_m': c.rnd(vis, 0),
        'visibility_lower_bound': False if vis is not None else None,
        'visibility_upper_bound': False if vis is not None else None,
        'visibility_report': f'{int(vis)} m' if vis is not None else None,
        'visibility_code_vv': None,
        'wind_direction_deg': c.rnd(wd, 0),
        'wind_speed_ms': c.rnd(ws, 2),
        'wind_gust_ms': c.rnd(gust, 2),
        'pressure_hpa': pmsl if pmsl is not None else pstation,
        'station_pressure_hpa': pstation,
        'present_weather_code': ww,
        'present_weather': present,
        'fog': fog,
        'mist': mist,
        'freezing_fog': freezing_fog,
        'cloud_base_m_agl': c.rnd(cloud_base, 0),
        'total_cloud_oktas': total_oktas,
        'raw': raw_ref,
        'wis2_parent_bufr': parents,
        'wis2_origin': origin,
        'wis2_descriptor_count': len(current),
    }


def newer(a, b):
    ta = c.parse_dt((a or {}).get('obs_time'))
    tb = c.parse_dt((b or {}).get('obs_time'))
    if not ta:
        return b
    if not tb:
        return a
    return b if tb >= ta else a


def main():
    try:
        features = fetch_features()
        synop = decode(features)
    except Exception as exc:
        print('NOAA WIS2 SYNOP warning:', exc)
        return
    if not synop:
        print('NOAA WIS2: station 12342 not found in current window')
        return

    if (c.now() - c.parse_dt(synop['obs_time'])).total_seconds() > MAX_AGE_HOURS * 3600:
        print('NOAA WIS2: latest 12342 report is stale:', synop['obs_time'])
        return

    day = c.parse_dt(synop['obs_time']).strftime('%Y-%m-%d')
    c.append(c.OUT / 'synop' / f'{day}.jsonl', synop)

    latest_path = c.OUT / 'latest.json'
    try:
        latest = json.loads(latest_path.read_text(encoding='utf-8'))
    except Exception:
        latest = {}
    chosen = newer(latest.get('synop'), synop)

    metars = c.recent('metar')
    synops = c.recent('synop')
    hist = c.history(metars, synops)
    fused = hist[-1] if hist else c.fuse(metars[-1] if metars else None, chosen)
    station = {'icao': c.ICAO, 'synop': c.SYNOP_ID, 'wigos': c.WIGOS_ID, 'lat': c.LAT, 'lon': c.LON}

    latest.update({
        'schema': 'epir-observation-latest-v2',
        'station': station,
        'updated_at': fused.get('obs_time') if fused else chosen.get('obs_time'),
        'collected_at': c.iso(c.now()),
        'metar': latest.get('metar'),
        'synop': chosen,
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
        'wis2': 'used',
        'synop_time': synop.get('obs_time'),
        'descriptor_count': synop.get('wis2_descriptor_count'),
        'temperature_c': synop.get('temperature_c'),
        'dew_point_c': synop.get('dew_point_c'),
        'visibility_m': synop.get('visibility_m'),
        'present_weather_code': synop.get('present_weather_code'),
        'cloud_base_m_agl': synop.get('cloud_base_m_agl'),
        'raw_ref': synop.get('raw'),
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
