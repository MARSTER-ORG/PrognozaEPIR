#!/usr/bin/env python3
"""Armored EPIR METAR/SPECI collector.

Goals:
- METAR is independent from SYNOP/TAF/model workflows;
- multiple independent sources are merged, newest observation wins;
- HTTP calls get bounded retry/backoff instead of one-shot failure;
- canonical archive/latest/recent files are written atomically;
- a failed optional source never prevents saving data from another source;
- recent gaps can be repaired from the 12 h backfill window.

The existing decoder/fusion code remains the single schema authority. This
module only hardens transport, source redundancy and persistence around it.
"""
from __future__ import annotations

import gzip
import json
import os
import random
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import collect_epir_observations as c

# ---------------------------------------------------------------------------
# Resilient transport. Patch the shared module before importing the higher
# level collectors so IMGW, PilotHub, OGIMET and CZAD all use the same policy.
# ---------------------------------------------------------------------------
_ORIGINAL_GET_TEXT = c.get_text
HTTP_ATTEMPTS = 4
HTTP_TIMEOUT_S = 9
BACKOFF_S = (0.0, 0.8, 2.0, 4.0)
_http_health: dict[str, dict] = {}


def _host(url: str) -> str:
    try:
        return urllib.parse.urlparse(url).netloc or url
    except Exception:
        return url


def resilient_get_text(url: str, timeout: int = 30) -> str:
    host = _host(url)
    stat = _http_health.setdefault(host, {'ok': 0, 'fail': 0, 'attempts': 0, 'last_error': None})
    last_exc: Exception | None = None
    for attempt in range(1, HTTP_ATTEMPTS + 1):
        stat['attempts'] += 1
        if attempt > 1:
            time.sleep(BACKOFF_S[attempt - 1] + random.uniform(0.0, 0.35))
        try:
            text = _ORIGINAL_GET_TEXT(url, timeout=min(max(5, int(timeout)), HTTP_TIMEOUT_S))
            if text is None:
                raise RuntimeError('empty response object')
            stat['ok'] += 1
            stat['last_error'] = None
            return text
        except urllib.error.HTTPError as exc:
            # 204 is a valid "no data" response for some aviation APIs.
            if exc.code == 204:
                stat['ok'] += 1
                stat['last_error'] = None
                return ''
            last_exc = exc
            stat['last_error'] = f'HTTP {exc.code}'
            # Permanent client errors are not helped by retrying. 429 is
            # explicitly retryable.
            if exc.code in (400, 401, 403, 404) and exc.code != 429:
                break
        except (urllib.error.URLError, TimeoutError, socket.timeout, OSError, ValueError, RuntimeError) as exc:
            last_exc = exc
            stat['last_error'] = str(exc)
        except Exception as exc:  # keep one broken provider non-fatal upstream
            last_exc = exc
            stat['last_error'] = str(exc)
    stat['fail'] += 1
    raise RuntimeError(f'{host}: failed after {stat["attempts"]} attempts: {last_exc}')


c.get_text = resilient_get_text
c.get_json = lambda url: json.loads(resilient_get_text(url))

import refresh_epir_metar as refresh  # noqa: E402
import live_metar_collector as live  # noqa: E402

# NOAA/NWS Aviation Weather Center is a genuinely independent worldwide OPMET
# source. The normal endpoint is retained for historical backfill, while the
# documented once-per-minute cache is an additional latest-report recovery path.
AWC_URL = 'https://aviationweather.gov/api/data/metar?ids=EPIR&format=raw&hours=12'
AWC_CACHE_URL = 'https://aviationweather.gov/data/cache/metars.cache.csv.gz'
refresh.SOURCE_PRIORITY.setdefault('AWC_CACHE_METAR', 55)
refresh.SOURCE_PRIORITY.setdefault('AWC_METAR', 50)

# Keep one station-scoped IMGW HTML endpoint as a fallback because the public
# JSON endpoint has occasionally returned HTTP 400 while the Awiacja service
# itself still displayed current bulletins. Older legacy PHP/RSS probes remain
# disabled.
refresh.IMGW_ENDPOINTS = (
    ('IMGW-AERODROME-EPIR', 'https://awiacja.imgw.pl/metar-i-taf?aport=EPIR'),
)
refresh.LIVE_PAGES = (
    ('CZAD', 'https://metar.czad.org/', 'METAR_CZAD'),
)


def fetch_awc_cache_reports() -> list[dict]:
    host = _host(AWC_CACHE_URL)
    stat = _http_health.setdefault(host, {'ok': 0, 'fail': 0, 'attempts': 0, 'last_error': None})
    last_exc: Exception | None = None
    for attempt in range(1, 4):
        stat['attempts'] += 1
        if attempt > 1:
            time.sleep(0.8 * attempt + random.uniform(0.0, 0.3))
        try:
            req = urllib.request.Request(
                AWC_CACHE_URL,
                headers={
                    'User-Agent': 'PrognozaEPIR/1.0 (+central-ingestor)',
                    'Accept': 'application/gzip, application/octet-stream, */*',
                    'Cache-Control': 'no-cache',
                },
            )
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as response:
                payload = response.read()
            text = gzip.decompress(payload).decode('utf-8', errors='replace')
            rows = [
                r for r in refresh.extract_epir_reports(text, 'AWC_CACHE_METAR')
                if refresh.backfill_valid(r)
            ]
            stat['ok'] += 1
            stat['last_error'] = None
            print(
                'AWC METAR cache: backfill=', len(rows),
                ' newest=', (max(rows, key=refresh.rank).get('obs_time') if rows else None),
            )
            return rows
        except Exception as exc:
            last_exc = exc
            stat['last_error'] = str(exc)
    stat['fail'] += 1
    print('AWC METAR cache warning:', last_exc)
    return []


def fetch_awc_reports() -> list[dict]:
    try:
        text = resilient_get_text(AWC_URL, timeout=9)
    except Exception as exc:
        print('AWC METAR warning:', exc)
        return []
    rows = [r for r in refresh.extract_epir_reports(text, 'AWC_METAR') if refresh.backfill_valid(r)]
    print('AWC METAR: backfill=', len(rows), ' newest=', (max(rows, key=refresh.rank).get('obs_time') if rows else None))
    return rows


_live_fetch_candidates = live.fetch_candidates


def armored_fetch_candidates() -> list[dict]:
    rows: list[dict] = []
    try:
        rows.extend(_live_fetch_candidates())
    except Exception as exc:
        # The direct+fallback collector is expected to self-isolate providers,
        # but keep the extra guard so AWC can still rescue the run.
        print('live collector warning:', exc)
    rows.extend(fetch_awc_cache_reports())
    rows.extend(fetch_awc_reports())

    # Dedupe exact reports, preferring the most authoritative source.
    best: dict[tuple, dict] = {}
    for row in rows:
        if not row or not refresh.backfill_valid(row):
            continue
        ident = refresh.report_identity(row)
        old = best.get(ident)
        if old is None or refresh.SOURCE_PRIORITY.get(row.get('source'), 0) > refresh.SOURCE_PRIORITY.get(old.get('source'), 0):
            best[ident] = row
    out = sorted(best.values(), key=refresh.rank)
    if out:
        newest = out[-1]
        print('ARMORED newest:', newest.get('obs_time'), newest.get('source'), newest.get('raw'))
    else:
        print('ARMORED newest: none')
    return out


# ---------------------------------------------------------------------------
# Atomic persistence. Git is the long-term backup, but os.replace prevents a
# killed runner from leaving half-written JSON/JSONL in the working tree.
# ---------------------------------------------------------------------------

def _atomic_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f'.{path.name}.tmp-{os.getpid()}')
    try:
        with tmp.open('w', encoding='utf-8', newline='') as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except Exception:
            pass


def atomic_write(path: Path, obj, pretty: bool = False) -> bool:
    text = (
        json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True)
        if pretty else json.dumps(obj, ensure_ascii=False, separators=(',', ':'))
    ) + '\n'
    old = path.read_text(encoding='utf-8') if path.exists() else None
    if old == text:
        return False
    _atomic_text(path, text)
    return True


def atomic_archive(row: dict) -> bool:
    if not row or not row.get('obs_time'):
        return False
    t = refresh.obs_time(row)
    if not t:
        return False
    canonical = c.OUT / 'metar' / t.strftime('%Y') / t.strftime('%m') / f'{t:%d}.jsonl'
    ident = refresh.report_identity(row)
    existing = refresh.read_jsonl(canonical)

    changed = False
    found = False
    for i, old in enumerate(existing):
        if refresh.report_identity(old) != ident:
            continue
        found = True
        if refresh.SOURCE_PRIORITY.get(row.get('source'), 0) > refresh.SOURCE_PRIORITY.get(old.get('source'), 0):
            existing[i] = row
            changed = True
        break
    if not found:
        existing.append(row)
        changed = True
    if not changed:
        return False

    existing.sort(key=lambda r: (
        refresh.obs_time(r) or datetime(1970, 1, 1, tzinfo=timezone.utc),
        str(r.get('report_type') or ''),
        refresh.SOURCE_PRIORITY.get(r.get('source'), 0),
    ))
    _atomic_text(
        canonical,
        ''.join(json.dumps(x, ensure_ascii=False, separators=(',', ':')) + '\n' for x in existing),
    )
    return True


refresh.fetch_candidates = armored_fetch_candidates
refresh.archive = atomic_archive
c.write = atomic_write


def main() -> None:
    refresh.main()
    latest = json.loads((c.OUT / 'latest.json').read_text(encoding='utf-8'))
    metar = latest.get('metar') or {}
    freshness = latest.get('metar_freshness') or {}
    print(json.dumps({
        'armored_metar': True,
        'obs_time': metar.get('obs_time'),
        'source': metar.get('source'),
        'age_min': freshness.get('age_min'),
        'freshness': freshness.get('status'),
        'missing_slots': freshness.get('missing_routine_slots'),
        'http_health': _http_health,
    }, ensure_ascii=False, sort_keys=True))


if __name__ == '__main__':
    main()
