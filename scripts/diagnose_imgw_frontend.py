#!/usr/bin/env python3
"""One-shot diagnostic helper for discovering IMGW Awiacja frontend data URLs."""
from __future__ import annotations

import re
from urllib.parse import urljoin

import collect_epir_observations as c

PAGE = 'https://awiacja.imgw.pl/metar-i-taf'


def main():
    text = c.get_text(PAGE, timeout=15)
    print('IMGW diagnostic: html_bytes=', len(text.encode('utf-8', 'replace')))

    srcs = re.findall(r'<script[^>]+src=["\']([^"\']+)["\']', text, flags=re.I)
    links = re.findall(r'<link[^>]+href=["\']([^"\']+)["\']', text, flags=re.I)
    assets = []
    seen = set()
    for item in srcs + links:
        url = urljoin(PAGE, item)
        if url not in seen and (url.endswith('.js') or '.js?' in url):
            seen.add(url)
            assets.append(url)

    print('IMGW diagnostic: script_src_count=', len(srcs), 'js_assets=', len(assets))
    for url in assets[:30]:
        print('IMGW asset:', url)

    url_re = re.compile(r'https?://[^"\'`\\\s]+|/[A-Za-z0-9_./?&=%{}:-]{4,}')
    hints = set()
    for url in assets[:20]:
        try:
            js = c.get_text(url, timeout=12)
        except Exception as exc:
            print('IMGW asset warning:', url, exc)
            continue
        low = js.lower()
        if 'metar' not in low and 'taf' not in low:
            continue
        print('IMGW candidate asset:', url, 'bytes=', len(js.encode('utf-8', 'replace')))
        for m in re.finditer(r'metar|taf', low):
            a = max(0, m.start() - 220)
            b = min(len(js), m.start() + 420)
            snippet = re.sub(r'\s+', ' ', js[a:b])
            print('IMGW hint snippet:', snippet[:700])
            for u in url_re.findall(js[a:b]):
                if any(k in u.lower() for k in ('metar', 'taf', 'api', 'airport', 'aerodrom')):
                    hints.add(u)
            if len(hints) >= 30:
                break
        if len(hints) >= 30:
            break

    print('IMGW URL hints:')
    for item in sorted(hints):
        print('  ', item)


if __name__ == '__main__':
    main()
