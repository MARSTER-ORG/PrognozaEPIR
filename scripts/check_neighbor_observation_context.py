#!/usr/bin/env python3
"""Architecture guard for neighboring METAR/SPECI context.

Neighbor observations are bounded context only. Railway acquires them while
collecting neighboring TAF pages, mirrors them into MessageArchive, the main
consensus applies the bounded upwind correction, and TAF Engine 2.3 preserves
that provenance when it reads the consensus from the hidden meteogram iframe.
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
taf_app=text('taf-app-v2.js')
mirror=text('.github/workflows/mirror-central-archive.yml')

for station in ('EPBY','EPPW','EPKS'):
    if f'"{station}"' not in helper:
        errors.append(f'neighbor helper must include {station}')
if '"EPIR"' in re.search(r'NEIGHBORS\s*=\s*\{(.*?)\n\}',helper,re.S).group(1) if re.search(r'NEIGHBORS\s*=\s*\{(.*?)\n\}',helper,re.S) else '':
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

if not re.search(r'<script\b[^>]*src=["\']message-archive-client\.js(?:\?[^"\']*)?["\']',index,re.I):
    errors.append('main consensus must load the shared MessageArchive client')
if 'neighbor-observation-context.js' not in index:
    errors.append('main consensus must load neighboring observation context')
if 'PrognozaEPIRNeighborObservations?.refresh?.(true)' not in index:
    errors.append('main consensus must refresh neighboring observations before computing final context')
if 'PrognozaEPIRNeighborObservations?.applySeries?.(consensus)' not in index:
    errors.append('main consensus must apply bounded neighboring observations')
if 'fetchText(' not in context or "neighbors/latest.json" not in context:
    errors.append('neighbor context module must read neighbors/latest.json through MessageArchive')
if re.search(r'https?://[^\s"\']*(?:pilothub|imgw|railway)[^\s"\']*',context,re.I):
    errors.append('browser neighbor context must not contact PilotHub/IMGW/Railway directly')
if 'MAX_WEIGHT=.35' not in context:
    errors.append('neighbor observational correction must remain bounded to max 35%')
if 'r.visibility_m<10000' not in context:
    errors.append('neighbor visibility logic must preserve METAR 9999 right-censoring')

for field in ('neighborObsStation','neighborObsScore','neighborObsWeightPct','neighborObsLagH','neighborObsAgeMin','neighborObsWeather','neighborObsRaw'):
    if f'{field}:z.{field}' not in taf_app:
        errors.append(f'TAF Engine 2.3 bridge must preserve {field}')
if 'OBS sąsiednie' not in taf_app or 'neighborObsStation' not in taf_app:
    errors.append('TAF Engine 2.3 UI must expose active neighbor observation signal')

# Neighbor history is intentionally outside the four authoritative EPIR counts.
count_folder_match=re.search(r"folders=\{(.*?)\n\s*\}",mirror,re.S)
if count_folder_match and 'neighbors' in count_folder_match.group(1):
    errors.append('neighbor context must not be counted as EPIR METAR/SPECI/TAF/SYNOP archive')

if errors:
    print('Neighbor observation architecture check FAILED:')
    for e in errors:
        print(' -',e)
    sys.exit(1)
print('Neighbor observation architecture check OK: EPBY/EPPW/EPKS are server-acquired, MessageArchive-backed, bounded, applied to consensus and preserved in TAF 2.3 provenance.')
