#!/usr/bin/env python3
"""Ensure taf.html uses MessageArchive natively, without compatibility fetch layers."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "taf.html"


def main() -> int:
    s = PATH.read_text(encoding="utf-8")
    before = s

    # The generator now calls PrognozaEPIRMessageArchive directly. The former
    # compatibility source is deliberately not loaded by the page anymore.
    s = s.replace('<script src="taf-archive-source.js"></script>\n', '')
    s = s.replace('\n<script src="taf-archive-source.js"></script>', '')

    if '<script src="message-archive-client.js"></script>' not in s:
        raise SystemExit('message-archive-client.js is missing from taf.html')

    marker = '/* TAF Verification v2.0 inline'
    primary = s.split(marker, 1)[0]
    required = ('PrognozaEPIRMessageArchive', 'loadObs()', 'loadNeighborArchive')
    missing = [x for x in required if x not in primary]
    if missing:
        raise SystemExit('native MessageArchive hooks missing: ' + ', '.join(missing))

    forbidden = (
        'taf-archive-source.js',
        'window.fetch=',
        'loadImgwLive(',
        'decodeMetarLive(',
        'latestStationReport(',
        'plainHtml(',
        'awiacja.imgw.pl',
        'aviationweather.gov',
        '/api/taf-proxy',
        'data/observations/latest.json',
        'data/observations/recent.json',
        'data/taf/neighbors.json',
    )
    bad = [x for x in forbidden if x in primary]
    if bad:
        raise SystemExit('legacy TAF acquisition remains: ' + ', '.join(bad))

    if s != before:
        PATH.write_text(s, encoding="utf-8")
        print('taf.html: removed compatibility source loader')
    else:
        print('taf.html: native MessageArchive already clean')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
