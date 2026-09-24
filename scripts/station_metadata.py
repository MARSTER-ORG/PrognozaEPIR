#!/usr/bin/env python3
from __future__ import annotations
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
_DATA=json.loads((ROOT/'station-metadata.json').read_text(encoding='utf-8'))
EPIR=dict(_DATA['EPIR'])
ICAO=EPIR['icao']
SYNOP_ID=EPIR['synop']
WIGOS_ID=EPIR['wigos']
LAT=float(EPIR['lat'])
LON=float(EPIR['lon'])
