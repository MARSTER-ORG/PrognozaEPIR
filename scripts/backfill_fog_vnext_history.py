#!/usr/bin/env python3
"""Backfill selected historical Fog vNext forecast batches from explicit runs.

This is evaluation-only. Every batch uses Open-Meteo Single Runs through
fog_vnext_model_archive; no reanalysis/final analysis is substituted.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone

import fog_vnext_model_archive as archive


def parse_batch(value: str):
    dt=datetime.fromisoformat(value.replace('Z','+00:00'))
    if dt.tzinfo is None:
        dt=dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).replace(minute=0,second=0,microsecond=0)


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--start',required=True,help='UTC batch, e.g. 2026-09-13T19:00Z')
    ap.add_argument('--end',default='',help='inclusive UTC batch; default=start')
    ap.add_argument('--step-hours',type=int,default=24)
    args=ap.parse_args()
    start=parse_batch(args.start)
    end=parse_batch(args.end) if args.end else start
    if end<start:
        raise SystemExit('end before start')
    if args.step_hours<1:
        raise SystemExit('step-hours must be >=1')
    cur=start
    while cur<=end:
        print(f'backfill batch {cur.isoformat()}')
        archive.archive(cur)
        cur+=timedelta(hours=args.step_hours)


if __name__=='__main__':
    main()
