#!/usr/bin/env python3
"""Authoritative live EPIR METAR collector.

Combines the generic multi-source scanner with the exact PilotHub METAR block
parser. The PilotHub EPIN page is explicitly checked because it server-renders
EPIR as the nearest weather station. All candidates are ranked by observation
time; source priority is used only for identical report times.
"""
from __future__ import annotations

import refresh_epir_metar as refresh
import supplement_metar_pilothub as pilothub

EPIN_PAGE = (
    'PILOTHUB-EPIN',
    'https://pilothub.pl/lotniska/epin',
    'PILOTHUB_METAR_IMGW',
)

# Make the final generic scanner check the known-good PilotHub page directly.
if not any(row[1] == EPIN_PAGE[1] for row in refresh.LIVE_PAGES):
    refresh.LIVE_PAGES = (refresh.LIVE_PAGES[0], EPIN_PAGE, *refresh.LIVE_PAGES[1:])

_base_fetch_candidates = refresh.fetch_candidates


def fetch_candidates():
    rows = list(_base_fetch_candidates())

    # The exact PilotHub parser reads <h3>METAR</h3> -> <code>METAR EPIR ...</code>.
    # Keep it independent from the generic HTML scan so a layout/text change in
    # one extraction path does not disable the other.
    try:
        rows.extend(pilothub.fetch_pilothub_reports())
    except Exception as exc:
        print('PilotHub exact parser warning:', exc)

    best = {}
    for row in rows:
        ident = refresh.report_identity(row)
        old = best.get(ident)
        if old is None or refresh.SOURCE_PRIORITY.get(row.get('source'), 0) > refresh.SOURCE_PRIORITY.get(old.get('source'), 0):
            best[ident] = row

    out = list(best.values())
    if out:
        newest = max(out, key=refresh.rank)
        print('authoritative METAR candidate:', newest.get('obs_time'), newest.get('source'), newest.get('raw'))
    else:
        print('authoritative METAR candidate: none')
    return out


refresh.fetch_candidates = fetch_candidates


if __name__ == '__main__':
    refresh.main()
