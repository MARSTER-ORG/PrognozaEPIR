#!/usr/bin/env python3
"""Progressively enrich archived operational runs with pressure-level context.

Only Open-Meteo Single Runs is used. No reanalysis is substituted. Existing
forecast rows are updated in-place, preserving their original surface values.
"""
from __future__ import annotations

import argparse
import json
import random
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

import model_verification as mv
import synoptic_regime as sr

API = "https://single-runs-api.open-meteo.com/v1/forecast"
USER_AGENT = "PrognozaEPIR-SynopticContextEnrichment/1.0"
STATE = mv.LEARNING / "synoptic-context-enrichment-state.json"
PROFILE_VARS = tuple(
    f"{name}_{p}hPa"
    for p in sr.LEVELS
    for name in ("temperature", "relative_humidity", "wind_speed", "wind_direction", "geopotential_height")
)
MODEL_FORECAST_HOURS = {"chmi_aladin_central_europe_2km": 73, "icon_d2": 49}


def transient_http(code):
    return code in {408, 425, 429} or 500 <= code <= 599


def get_json(url, retries=5, timeout=80):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json", "Connection": "close"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            last = exc
            if not transient_http(exc.code) and exc.code != 400:
                raise
        except (urllib.error.URLError, socket.timeout, TimeoutError, json.JSONDecodeError, ValueError) as exc:
            last = exc
        if attempt + 1 < retries:
            time.sleep(min(18.0, 1.5 * (2 ** attempt)) + random.uniform(0, 0.8))
    raise last


def request(model_id, run, variables):
    params = {
        "latitude": mv.LAT,
        "longitude": mv.LON,
        "hourly": ",".join(variables),
        "models": model_id,
        "timezone": "UTC",
        "forecast_hours": MODEL_FORECAST_HOURS.get(model_id, 121),
        "wind_speed_unit": "ms",
        "run": run.strftime("%Y-%m-%dT%H:%M"),
    }
    return get_json(API + "?" + urllib.parse.urlencode(params))


def merge_payload(base, extra):
    if not extra:
        return base
    if base is None:
        base = {"hourly": {"time": (extra.get("hourly") or {}).get("time") or []}}
    bh = base.setdefault("hourly", {})
    eh = extra.get("hourly") or {}
    if not bh.get("time") and eh.get("time"):
        bh["time"] = eh["time"]
    for k, v in eh.items():
        if k != "time" and isinstance(v, list):
            bh[k] = v
    return base


def fetch_resilient(model_id, run, variables):
    failures = []

    def rec(chunk):
        if not chunk:
            return None
        try:
            return request(model_id, run, chunk)
        except urllib.error.HTTPError as exc:
            if exc.code != 400:
                raise
        except Exception as exc:
            raise exc
        if len(chunk) == 1:
            failures.append(chunk[0])
            return None
        mid = len(chunk) // 2
        return merge_payload(rec(chunk[:mid]), rec(chunk[mid:]))

    return rec(list(variables)), failures


def context_from_payload(payload):
    h = (payload or {}).get("hourly") or {}
    times = h.get("time") or []
    out = {}
    for i, ts in enumerate(times):
        valid = mv.parse_dt(ts)
        if not valid:
            continue
        row = {}
        for p in sr.LEVELS:
            mapping = {
                f"temperature_{p}hpa_c": f"temperature_{p}hPa",
                f"relative_humidity_{p}hpa_pct": f"relative_humidity_{p}hPa",
                f"wind_speed_{p}hpa_ms": f"wind_speed_{p}hPa",
                f"wind_direction_{p}hpa_deg": f"wind_direction_{p}hPa",
                f"geopotential_height_{p}hpa_m": f"geopotential_height_{p}hPa",
            }
            for dst, src in mapping.items():
                arr = h.get(src) or []
                row[dst] = arr[i] if i < len(arr) else None
        out[mv.iso(valid)] = row
    return out


def has_context(row):
    return any(mv.finite(row.get(k)) for k in (
        "wind_direction_850hpa_deg", "temperature_925hpa_c",
        "relative_humidity_925hpa_pct", "relative_humidity_850hpa_pct",
    ))


def load_files():
    files = {}
    if not mv.FORECAST_DIR.exists():
        return files
    for path in sorted(mv.FORECAST_DIR.rglob("*.jsonl")):
        files[path] = mv.load_jsonl(path)
    return files


def candidate_runs(files, now):
    groups = defaultdict(list)
    for path, rows in files.items():
        for idx, row in enumerate(rows):
            model = row.get("model")
            run = mv.parse_dt(row.get("run_time"))
            valid = mv.parse_dt(row.get("valid_time"))
            if model not in mv.MODEL_META or not run or not valid or run >= valid or valid > now:
                continue
            groups[(row.get("run_time"), model)].append((path, idx, row))
    pending = []
    for key, refs in groups.items():
        if not all(has_context(r) for _p, _i, r in refs):
            run = mv.parse_dt(key[0])
            pending.append((run, key[1], refs))
    pending.sort(key=lambda x: x[0], reverse=True)
    return pending


def fetch_one(run, model_id):
    payload, unsupported = fetch_resilient(model_id, run, PROFILE_VARS)
    context = context_from_payload(payload)
    if not context:
        raise RuntimeError("no pressure-level context returned")
    return context, unsupported


def write_jsonl(path, rows):
    path.write_text("".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in rows), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-runs", type=int, default=36)
    ap.add_argument("--workers", type=int, default=2)
    args = ap.parse_args()

    files = load_files()
    now = mv.utcnow()
    pending_all = candidate_runs(files, now)
    selected = pending_all[:max(0, args.max_runs)]
    changed = set()
    success = 0
    failures = []
    unsupported_total = defaultdict(int)

    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 3))) as pool:
        futs = {pool.submit(fetch_one, run, model): (run, model, refs) for run, model, refs in selected}
        for fut in as_completed(futs):
            run, model, refs = futs[fut]
            try:
                context, unsupported = fut.result()
                for var in unsupported:
                    unsupported_total[var] += 1
                updated = 0
                for path, idx, row in refs:
                    ctx = context.get(row.get("valid_time"))
                    if not ctx:
                        continue
                    new = dict(row)
                    new.update(ctx)
                    new["synoptic_context_version"] = sr.VERSION
                    new["synoptic_context_source"] = "open-meteo-single-runs"
                    files[path][idx] = new
                    changed.add(path)
                    updated += 1
                if updated:
                    success += 1
                else:
                    failures.append((mv.iso(run), model, "no matching valid times"))
            except Exception as exc:
                failures.append((mv.iso(run), model, str(exc)))

    for path in changed:
        write_jsonl(path, files[path])

    remaining = max(0, len(pending_all) - success)
    report = {
        "schema": "prognozaepir-synoptic-context-enrichment-v1",
        "generated_at": mv.iso(now),
        "regime_version": sr.VERSION,
        "source": "Open-Meteo Single Runs operational archive; no reanalysis substitution",
        "pending_before": len(pending_all),
        "attempted_runs": len(selected),
        "enriched_runs": success,
        "remaining_estimate": remaining,
        "changed_files": [str(p.relative_to(mv.ROOT)) for p in sorted(changed)],
        "unsupported_variables": dict(sorted(unsupported_total.items())),
        "failures": failures[:100],
    }
    STATE.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("synoptic context enrichment:", json.dumps({k: v for k, v in report.items() if k not in {"failures", "changed_files"}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
