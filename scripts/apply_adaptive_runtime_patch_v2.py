#!/usr/bin/env python3
from pathlib import Path

import apply_adaptive_runtime_patch as base

ROOT = Path(__file__).resolve().parents[1]


def add_legacy_pages_marker():
    p = ROOT / 'index.html'
    s = p.read_text(encoding='utf-8')
    marker = '/* deploy-check compatibility: if(row)items.push({model:m,row,w:m.w,elevation:ds.elevation}) */'
    if marker not in s:
        needle = 'function compute(){'
        if needle not in s:
            raise SystemExit('compute marker missing')
        s = s.replace(needle, marker + '\n' + needle, 1)
    p.write_text(s, encoding='utf-8')


def main():
    base.patch_client()
    base.patch_index()
    base.patch_rh_axis()
    base.patch_cloud_learning()
    add_legacy_pages_marker()
    print('adaptive runtime patch v2 applied without modifying workflow files')


if __name__ == '__main__':
    main()
