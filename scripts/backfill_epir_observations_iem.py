#!/usr/bin/env python3
"""Acquire historical EPIR METAR/ASOS observations for CONSENSUS verification.

Source: Iowa Environmental Mesonet ASOS/METAR archive (PL__ASOS / EPIR).
The IEM archive combines operational feeds including Unidata IDD and NCEI ISD.
Raw source rows are preserved and a compact normalized JSONL is produced.

No model/reanalysis values are used as observations.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import random
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "data" / "learning" / "observations" / "raw"
OUT_DIR = ROOT / "data" / "learning" / "observations"
STATE = ROOT / "data" / "learning" / "epir-observation-backfill-state.json"
API = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py"
NETWORK = "PL__ASOS"
STATION = "EPIR"
USER_AGENT = "PrognozaEPIR-ConsensusObs/1.0"


def parse_day(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def fnum(v):
    if v is None:
        return None
    s = str(v).strip()
    if not s or s.upper() in {"M", "NULL", "NONE", "NA", "NAN"}:
        return None
    try:
        x = float(s)
        return x if math.isfinite(x) else None
    except Exception:
        return None


def iso_utc(s: str):
    s = (s or "").strip()
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
        except Exception:
            pass
    return None


def f_to_c(v):
    x = fnum(v)
    return None if x is None else (x - 32.0) * 5.0 / 9.0


def kt_to_ms(v):
    x = fnum(v)
    return None if x is None else x * 0.514444


def mi_to_m(v):
    x = fnum(v)
    return None if x is None else x * 1609.344


def inhg_to_hpa(v):
    x = fnum(v)
    return None if x is None else x * 33.8638866667


def get_text(url: str, retries: int = 6, timeout: int = 120):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/plain,text/csv,*/*",
                "Connection": "close",
            })
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                if not raw:
                    raise ValueError("empty response")
                return raw.decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code not in {408, 425, 429} and not 500 <= exc.code <= 599:
                raise
        except (urllib.error.URLError, socket.timeout, TimeoutError, ValueError) as exc:
            last = exc
        if attempt + 1 < retries:
            time.sleep(min(20.0, 1.5 * (2 ** attempt)) + random.random())
    raise last


def request_year(start: date, end: date):
    params = [
        ("station", STATION),
        ("network", NETWORK),
        ("data", "all"),
        ("year1", str(start.year)), ("month1", str(start.month)), ("day1", str(start.day)),
        ("year2", str(end.year)), ("month2", str(end.month)), ("day2", str(end.day)),
        ("tz", "Etc/UTC"),
        ("format", "onlycomma"),
        ("latlon", "yes"), ("elev", "yes"),
        ("missing", "M"), ("trace", "T"), ("direct", "no"),
        ("report_type", "3"), ("report_type", "4"),
    ]
    url = API + "?" + urllib.parse.urlencode(params)
    return get_text(url), url


def normalize(r: dict):
    valid = iso_utc(r.get("valid"))
    if not valid:
        return None
    station = (r.get("station") or "").strip().upper()
    if station != STATION:
        return None
    mslp = fnum(r.get("mslp"))
    alti_hpa = inhg_to_hpa(r.get("alti"))
    return {
        "schema": "prognozaepir-observation-v1",
        "station": STATION,
        "network": NETWORK,
        "valid_time": valid,
        "source": "iem-asos-metar",
        "source_provenance": "IEM archive; operational feeds include NCEI ISD/Unidata IDD",
        "latitude": fnum(r.get("lat")),
        "longitude": fnum(r.get("lon")),
        "elevation_m": fnum(r.get("elevation")),
        "temperature_c": f_to_c(r.get("tmpf")),
        "dew_point_c": f_to_c(r.get("dwpf")),
        "relative_humidity_pct": fnum(r.get("relh")),
        "wind_direction_deg": fnum(r.get("drct")),
        "wind_speed_ms": kt_to_ms(r.get("sknt")),
        "wind_gust_ms": kt_to_ms(r.get("gust")),
        "visibility_m": mi_to_m(r.get("vsby")),
        "pressure_hpa": mslp if mslp is not None else alti_hpa,
        "pressure_kind": "mslp" if mslp is not None else ("altimeter" if alti_hpa is not None else None),
        "sky_cover_1": r.get("skyc1") if r.get("skyc1") not in (None, "M", "") else None,
        "cloud_base_1_ft": fnum(r.get("skyl1")),
        "sky_cover_2": r.get("skyc2") if r.get("skyc2") not in (None, "M", "") else None,
        "cloud_base_2_ft": fnum(r.get("skyl2")),
        "sky_cover_3": r.get("skyc3") if r.get("skyc3") not in (None, "M", "") else None,
        "cloud_base_3_ft": fnum(r.get("skyl3")),
        "sky_cover_4": r.get("skyc4") if r.get("skyc4") not in (None, "M", "") else None,
        "cloud_base_4_ft": fnum(r.get("skyl4")),
        "weather_codes": r.get("wxcodes") if r.get("wxcodes") not in (None, "M", "") else None,
        "raw_metar": r.get("metar") if r.get("metar") not in (None, "M", "") else None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2020-01-01")
    ap.add_argument("--end", default="2026-09-12", help="end date is exclusive")
    args = ap.parse_args()
    start, end = parse_day(args.start), parse_day(args.end)
    if end <= start:
        raise SystemExit("end must be after start")

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    all_norm = []
    per_year = {}
    failures = []

    for year in range(start.year, end.year + 1):
        ys = max(start, date(year, 1, 1))
        ye = min(end, date(year + 1, 1, 1))
        if ys >= ye:
            continue
        try:
            text, url = request_year(ys, ye)
            raw_path = RAW_DIR / f"EPIR-IEM-{year}.csv"
            raw_path.write_text(text, encoding="utf-8")
            reader = csv.DictReader(io.StringIO(text))
            rows = []
            for r in reader:
                n = normalize(r)
                if n:
                    rows.append(n)
            rows.sort(key=lambda x: x["valid_time"])
            out_path = OUT_DIR / f"EPIR-{year}.jsonl"
            out_path.write_text("".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in rows), encoding="utf-8")
            all_norm.extend(rows)
            per_year[str(year)] = {
                "rows": len(rows),
                "first": rows[0]["valid_time"] if rows else None,
                "last": rows[-1]["valid_time"] if rows else None,
                "raw_bytes": len(text.encode("utf-8")),
            }
            print(year, per_year[str(year)])
        except Exception as exc:
            failures.append({"year": year, "error": f"{type(exc).__name__}: {exc}"})
            print("FAILED", year, failures[-1])

    fields = [
        "temperature_c","dew_point_c","relative_humidity_pct","wind_direction_deg","wind_speed_ms",
        "wind_gust_ms","visibility_m","pressure_hpa","cloud_base_1_ft","weather_codes","raw_metar"
    ]
    coverage = {k: sum(1 for r in all_norm if r.get(k) is not None) for k in fields}
    state = {
        "schema": "prognozaepir-epir-observation-backfill-v1",
        "generated_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "station": STATION,
        "network": NETWORK,
        "period_start": start.isoformat(),
        "period_end_exclusive": end.isoformat(),
        "source": "Iowa Environmental Mesonet ASOS/METAR archive",
        "rows_total": len(all_norm),
        "years": per_year,
        "field_non_null_counts": coverage,
        "failures": failures,
    }
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(state, ensure_ascii=False, indent=2))
    if not all_norm:
        raise SystemExit("no EPIR observations acquired")


if __name__ == "__main__":
    main()
