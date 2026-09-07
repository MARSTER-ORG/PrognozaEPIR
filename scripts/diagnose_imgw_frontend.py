#!/usr/bin/env python3
"""One-shot probe of the public IMGW Aviation API used by the Awiacja frontend."""
from __future__ import annotations

import json
import re

import collect_epir_observations as c

URLS = (
    'https://aviation-api.imgw.pl/data?params=metar&airports=EPIR&format=json&timeback=12',
    'https://aviation-api.imgw.pl/data/last?params=metar&airports=EPIR&format=json&count=24',
    'https://aviation-api.imgw.pl/data/last?params=metar,taf&airports=EPIR&format=json&count=24',
)


def raw_messages(value):
    text = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
    return sorted(set(re.findall(
        r'(?:(?:METAR|SPECI)\\?\s+)?EPIR\\?\s+\d{6}Z.*?Q\d{4}',
        text,
        flags=re.I,
    )))


def main():
    for url in URLS:
        print('IMGW PROBE URL:', url)
        try:
            text = c.get_text(url, timeout=20)
            print('IMGW PROBE BYTES:', len(text.encode('utf-8', 'replace')))
            data = json.loads(text)
            if isinstance(data, dict):
                print('IMGW PROBE TOP KEYS:', list(data.keys())[:20])
                epir = data.get('EPIR') or data.get('epir')
                if epir is not None:
                    print('IMGW PROBE EPIR TYPE:', type(epir).__name__)
                    print('IMGW PROBE EPIR JSON:', json.dumps(epir, ensure_ascii=False)[:12000])
            elif isinstance(data, list):
                print('IMGW PROBE LIST LEN:', len(data))
                hits = [x for x in data if 'EPIR' in json.dumps(x, ensure_ascii=False)]
                print('IMGW PROBE EPIR LIST HITS:', len(hits))
                if hits:
                    print('IMGW PROBE EPIR JSON:', json.dumps(hits[:3], ensure_ascii=False)[:12000])
            msgs = raw_messages(data)
            print('IMGW PROBE RAW COUNT:', len(msgs))
            for msg in msgs[:30]:
                print('IMGW PROBE RAW:', msg)
        except Exception as exc:
            print('IMGW PROBE ERROR:', type(exc).__name__, exc)


if __name__ == '__main__':
    main()
