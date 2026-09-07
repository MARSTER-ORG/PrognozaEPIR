#!/usr/bin/env python3
"""One-shot diagnostic helper for tracing the IMGW Awiacja METAR API."""
from __future__ import annotations

import re
from collections import deque
from urllib.parse import urljoin

import collect_epir_observations as c

PAGE = 'https://awiacja.imgw.pl/metar-i-taf'
MAX_ASSETS = 80


def snippets(text, pattern, before=700, after=1100, limit=12):
    out = []
    for m in re.finditer(pattern, text, flags=re.I):
        a = max(0, m.start() - before)
        b = min(len(text), m.end() + after)
        out.append(re.sub(r'\s+', ' ', text[a:b]))
        if len(out) >= limit:
            break
    return out


def main():
    html = c.get_text(PAGE, timeout=15)
    print('IMGW diagnostic v2: html_bytes=', len(html.encode('utf-8', 'replace')))

    initial = [urljoin(PAGE, x) for x in re.findall(
        r'<script[^>]+src=["\']([^"\']+)["\']', html, flags=re.I
    )]
    # Lazy METAR page discovered in the previous diagnostic run.
    initial.append('https://awiacja.imgw.pl/chunk-A2BVJ3LU.js')

    queue = deque(initial)
    seen = set()
    assets = {}
    while queue and len(seen) < MAX_ASSETS:
        url = queue.popleft()
        if url in seen or not url.startswith('https://awiacja.imgw.pl/') and 'shared.imgw.pl/' not in url:
            continue
        seen.add(url)
        try:
            js = c.get_text(url, timeout=12)
        except Exception as exc:
            print('IMGW asset warning:', url, exc)
            continue
        assets[url] = js
        for rel in re.findall(r'(?:import\(|from\s*)["\'](\.\/[^"\']+\.js)["\']', js):
            queue.append(urljoin(url, rel))
        # Angular/esbuild lazy imports are often minified as import("./chunk-X.js").
        for rel in re.findall(r'import\(["\'](\.\/[^"\']+\.js)["\']\)', js):
            queue.append(urljoin(url, rel))

    print('IMGW diagnostic v2: fetched_assets=', len(assets))

    url_hints = set()
    service_hits = 0
    for url, js in assets.items():
        low = js.lower()
        relevant = any(k in low for k in ('getdata(', 'metar', '/api/', 'api.', 'baseurl', 'apiurl'))
        if not relevant:
            continue

        # Collect literal URLs and API-looking relative paths.
        for value in re.findall(r'https?://[^"\'`\\\s]+', js):
            if any(k in value.lower() for k in ('imgw', 'api', 'metar', 'taf')):
                url_hints.add(value.rstrip('),;'))
        for value in re.findall(r'["\'](/[A-Za-z0-9_./?&=%{}:-]{3,})["\']', js):
            if any(k in value.lower() for k in ('api', 'metar', 'taf', 'data', 'airport')):
                url_hints.add(value)

        patterns = (
            r'getData\s*\(',
            r'http\.(?:get|post)\s*\(',
            r'\.get\s*\([^)]*(?:api|metar|taf)',
            r'(?:baseUrl|apiUrl|apiURL|api_url)',
            r'/api/',
        )
        printed_header = False
        for pat in patterns:
            for snip in snippets(js, pat, limit=5):
                if not printed_header:
                    print('IMGW SERVICE ASSET:', url, 'bytes=', len(js.encode('utf-8', 'replace')))
                    printed_header = True
                print('IMGW SERVICE SNIPPET:', snip[:1900])
                service_hits += 1
                if service_hits >= 60:
                    break
            if service_hits >= 60:
                break
        if service_hits >= 60:
            break

    print('IMGW API/URL hints:')
    for item in sorted(url_hints):
        print('  ', item)


if __name__ == '__main__':
    main()
