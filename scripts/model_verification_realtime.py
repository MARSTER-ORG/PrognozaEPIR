#!/usr/bin/env python3
"""Dense short-range archive + fast model-verification refresh.

The hourly learning job stores every model hour in the next six hours, so the
next METAR/SPECI can verify visibility/churn immediately after its valid time.
The observation collector can call this script with --summary-only to rebuild
scores without downloading all model forecasts again.
"""
from __future__ import annotations

import argparse
import json

import model_verification as mv

DENSE_HOURS = 6.25


def archive_dense_short_range():
    run = mv.utcnow()
    run_iso = mv.iso(run)
    path = mv.FORECAST_DIR / f"{run:%Y-%m-%d}.jsonl"
    existing = mv.load_jsonl(path)
    seen = {(r.get('run_time'), r.get('model'), r.get('valid_time')) for r in existing}
    added = 0

    for model_id, name, weight in mv.MODELS:
        try:
            rows = mv.fetch_model(model_id)
        except Exception as exc:
            print(f'dense verification forecast {model_id}: {exc}')
            continue

        for row in rows:
            valid = mv.parse_dt(row.get('valid_time'))
            if not valid:
                continue
            lead_h = (valid - run).total_seconds() / 3600.0
            if lead_h <= 0 or lead_h > DENSE_HOURS:
                continue
            bucket = mv.lead_bucket(lead_h) or '0-6h'
            key = (run_iso, model_id, row['valid_time'])
            if key in seen:
                continue
            mv.append_jsonl(path, {
                'schema': 'prognozaepir-model-forecast-v1',
                'run_time': run_iso,
                'model': model_id,
                'name': name,
                'base_weight': weight,
                'lead_hours': round(lead_h, 2),
                'lead_bucket': bucket,
                **row,
            })
            seen.add(key)
            added += 1

    print(f'dense short-range model forecasts archived: {added}')
    return added


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--summary-only', action='store_true')
    args = parser.parse_args()

    if not args.summary_only:
        archive_dense_short_range()
    mv.build_summary()

    try:
        summary = json.loads(mv.SUMMARY_PATH.read_text(encoding='utf-8'))
        brief = {
            k: {
                'score': v.get('score_pct'),
                'visibility': (v.get('components') or {}).get('visibility'),
                'cloud': (v.get('components') or {}).get('cloud'),
            }
            for k, v in (summary.get('models') or {}).items()
        }
        print('verification components:', json.dumps(brief, ensure_ascii=False))
    except Exception as exc:
        print('verification summary read warning:', exc)


if __name__ == '__main__':
    main()
