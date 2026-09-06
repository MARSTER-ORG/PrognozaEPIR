#!/usr/bin/env python3
"""Maintain canonical year/month/day archives for EPIR METAR and SYNOP.

Collectors keep a small flat working cache for backward compatibility with the
30-hour observation fusion code. Every dated flat JSONL is also merged into the
canonical hierarchy:

  data/observations/metar/YYYY/MM/DD.jsonl
  data/observations/synop/YYYY/MM/DD.jsonl

Flat daily files older than KEEP_FLAT_DAYS are removed after they have been
safely copied to the canonical archive.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

OUT = Path('data/observations')
KEEP_FLAT_DAYS = 3
DATE_RE = re.compile(r'^(\d{4})-(\d{2})-(\d{2})\.jsonl$')


def row_key(row):
    return (
        row.get('source'),
        row.get('station'),
        row.get('obs_time'),
        row.get('raw') or row.get('visibility_report'),
    )


def read_rows(path: Path):
    rows = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding='utf-8').splitlines():
        try:
            row = json.loads(line)
            if isinstance(row, dict):
                rows.append(row)
        except Exception:
            pass
    return rows


def write_rows(path: Path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    text = ''.join(json.dumps(r, ensure_ascii=False, separators=(',', ':')) + '\n' for r in rows)
    old = path.read_text(encoding='utf-8') if path.exists() else None
    if old == text:
        return False
    path.write_text(text, encoding='utf-8')
    return True


def merge_file(src: Path, dst: Path):
    merged = []
    seen = set()
    for row in read_rows(dst) + read_rows(src):
        key = row_key(row)
        if key in seen:
            continue
        seen.add(key)
        merged.append(row)
    merged.sort(key=lambda r: r.get('obs_time') or '')
    return write_rows(dst, merged)


def organize_kind(kind: str):
    root = OUT / kind
    if not root.exists():
        return 0, 0
    today = datetime.now(timezone.utc).date()
    keep_from = today - timedelta(days=KEEP_FLAT_DAYS - 1)
    copied = removed = 0
    for src in sorted(root.glob('*.jsonl')):
        m = DATE_RE.match(src.name)
        if not m:
            continue
        y, mo, d = m.groups()
        try:
            day = datetime(int(y), int(mo), int(d), tzinfo=timezone.utc).date()
        except ValueError:
            continue
        dst = root / y / mo / f'{d}.jsonl'
        if merge_file(src, dst):
            copied += 1
        if day < keep_from:
            src.unlink()
            removed += 1
    return copied, removed


def main():
    stats = {}
    for kind in ('metar', 'synop'):
        copied, removed = organize_kind(kind)
        stats[kind] = {'canonical_updated': copied, 'flat_removed': removed}
    print(json.dumps({'archive_layout': 'YYYY/MM/DD.jsonl', 'keep_flat_days': KEEP_FLAT_DAYS, **stats}, ensure_ascii=False))


if __name__ == '__main__':
    main()
