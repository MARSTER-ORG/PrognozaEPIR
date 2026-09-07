#!/usr/bin/env python3
"""One-shot probe of the exact public IMGW Aviation API calls used by the frontend."""
from __future__ import annotations

import json
import re
import urllib.error

import collect_epir_observations as c

URLS = (
    'https://aviation-api.imgw.pl/data/last?params=metar,taf&format=json&count=4',
    'https://aviation-api.imgw.pl/data/last?params=metar,taf&format=json&count=8',
    'https://aviation-api.imgw.pl/data/last?params=metar,taf&format=json&count=24',
    'https://aviation-api.imgw.pl/data/last?params=metar&format=json&count=24',
    'https://aviation-api.imgw.pl/data?params=metar&format=json&timeback=2',
    'https://aviation-api.imgw.pl/data?params=metar&format=json&timeback=12',
)


def raw_messages(value):
    text = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
    # JSON contains raw aviation messages as ordinary strings; stop at quote/JSON delimiter.
    pattern = re.compile(
        r'(?:(?:METAR|SPECI)\s+)?EPIR\s+\d{6}Z\s+[^"\\]{1,500}?\bQ\d{4}\b',
        flags=re.I,
    )
    return sorted(set(re.sub(r'\s+', ' ', m.group(0)).strip() for m in pattern.finditer(text)))


def main():
    for url in URLS:
        print('IMGW PROBE URL:', url)
        try:
            text = c.get_text(url, timeout=20)
            print('IMGW PROBE BYTES:', len(text.encode('utf-8', 'replace')))
            data = json.loads(text)
            print('IMGW PROBE TYPE:', type(data).__name__)
            if isinstance(data, dict):
                print('IMGW PROBE TOP KEYS:', list(data.keys())[:30])
                # Locate EPIR wherever the API nests it.
                epir_hits = []
                def walk(v, path='root'):
                    if isinstance(v, dict):
                        if any(str(x).upper() == 'EPIR' for x in v.keys()) or 'EPIR' in json.dumps(v, ensure_ascii=False):
                            if len(epir_hits) < 10:
                                epir_hits.append((path, v))
                        for k, x in v.items():
                            walk(x, f'{path}.{k}')
                    elif isinstance(v, list):
                        for i, x in enumerate(v[:200]):
                            walk(x, f'{path}[{i}]')
                walk(data)
                print('IMGW PROBE EPIR NODES:', len(epir_hits))
                for path, node in epir_hits[:3]:
                    print('IMGW PROBE EPIR PATH:', path)
                    print('IMGW PROBE EPIR JSON:', json.dumps(node, ensure_ascii=False)[:12000])
            msgs = raw_messages(data)
            print('IMGW PROBE RAW COUNT:', len(msgs))
            for msg in msgs[:40]:
                print('IMGW PROBE RAW:', msg)
        except urllib.error.HTTPError as exc:
            try:
                body = exc.read().decode('utf-8', 'replace')
            except Exception:
                body = ''
            print('IMGW PROBE HTTP ERROR:', exc.code, body[:1000])
        except Exception as exc:
            print('IMGW PROBE ERROR:', type(exc).__name__, exc)


if __name__ == '__main__':
    main()
