#!/usr/bin/env python3
"""Architecture guard for neighboring METAR/SPECI context.

Neighbor observations are context only. Railway may acquire them while it
already fetches PilotHub TAF pages, but browser consumers read the mirrored
GitHub MessageArchive and the main EPIR operational archive counts remain
separate. The canonical TAF v2 app must preserve provenance when it bridges
consensus rows into the current TAF engine.
"""
from pathlib import Path
import re
import sys

errors=[]

def text(path):
    p=Path(path)
    if not p.is_file():
        errors.append(f'missing required file: {path}')
        return ''
    return p.read_text(encoding='utf-8',errors='ignore')

helper=text('scripts/neighbor_observations.py')
collector=text('scripts/collect_neighbor_tafs.py')
event=text('scripts/railway_ingestor_event_server.py')
context=text('neighbor-observation-context.js')
index=text('index.html')
tafapp=text('taf-app-v2.js')
mirror=text('.github/workflows/mirror-central-archive.yml')

for station in ('EPBY','EPPW','EPKS'):
    if f'"{station}"' not in helper:
        errors.append(f'neighbor helper must include {station}')
match=re.search(r'NEIGHBORS\s*=\s*\{(.*?)\n\}',helper,re.S)
if '"EPIR"' in (match.group(1) if match else ''):
    errors.append('EPIR must not be stored in neighbor context archive')
if 'ROOT = Path("data/messages/neighbors")' not in helper:
    errors.append('neighbor records must live below data/messages/neighbors')
if 'capture_pilothub_page' not in collector or 'neighbor_obs.capture_pilothub_page' not in collector:
    errors.append('neighbor TAF collector must capture observations from the already-fetched PilotHub page')
if 'neighbors/latest.json' not in event or 'neighbors/{station}/{day_rel}' not in event:
    errors.append('Railway bootstrap must restore neighbor latest/history from GitHub')
if "rel.startswith(('metar/','speci/','synop/','taf/','neighbors/'))" not in mirror:
    errors.append('GitHub archive mirror must include neighbors/')
if 'neighbor_observations' not in mirror:
    errors.append('archive status must document contextual neighbor observations')

if not re.search(r'<script\s+src=["\']message-archive-client\.js(?:\?[^"\']*)?["\']\s*></script>',index,re.I):
    errors.append('main consensus must load shared GitHub MessageArchive client')
if 'neighbor-observation-context.js' not in index or 'PrognozaEPIRNeighborObservations?.applySeries' not in index:
    errors.append('main consensus must load/apply neighboring observations')
if 'fetchText(' not in context or 'neighbors/latest.json' not in context:
    errors.append('neighbor context module must read neighbors/latest.json through MessageArchive')
if re.search(r'https?://[^\s"\']*(?:pilothub|imgw|railway)[^\s"\']*',context,re.I):
    errors.append('browser neighbor context must not contact PilotHub/IMGW/Railway directly')
if 'MAX_WEIGHT=.35' not in context:
    errors.append('neighbor observational correction must remain bounded to max 35%')
if 'r.visibility_m<10000' not in context:
    errors.append('neighbor visibility logic must preserve METAR 9999 right-censoring')

if 'neighborObsStation:z.neighborObsStation' not in tafapp:
    errors.append('canonical TAF app must preserve neighbor observation provenance')
if 'neighborObsAgeMin:z.neighborObsAgeMin' not in tafapp or 'neighborObsWeight:z.neighborObsWeight' not in tafapp:
    errors.append('canonical TAF app must preserve neighbor observation age/weight')
if 'OBS ${esc(neighborObsStations.join' not in tafapp:
    errors.append('canonical TAF UI must expose active neighbor observation signal')

# Neighbor history is intentionally outside the four authoritative EPIR counts.
count_folder_match=re.search(r"folders=\{(.*?)\n\s*\}",mirror,re.S)
if count_folder_match and 'neighbors' in count_folder_match.group(1):
    errors.append('neighbor context must not be counted as EPIR METAR/SPECI/TAF/SYNOP archive')

if errors:
    print('Neighbor observation architecture check FAILED:')
    for e in errors:
        print(' -',e)
    sys.exit(1)
print('Neighbor observation architecture check OK: EPBY/EPPW/EPKS context is server-acquired, GitHub-mirrored, bounded, provenance-preserving and separate from EPIR archive counts.')
