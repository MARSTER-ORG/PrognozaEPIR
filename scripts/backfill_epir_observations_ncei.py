#!/usr/bin/env python3
"""Acquire historical EPIR surface observations directly from NOAA/NCEI.

The script discovers EPIR in the official ISD station-history table and downloads
its Global Hourly CSV files year by year. It preserves the source CSV files and
creates compact normalized JSONL rows for CONSENSUS verification.

No reanalysis or model field is used as observation truth.
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
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "data" / "learning" / "observations" / "raw-ncei"
OUT_DIR = ROOT / "data" / "learning" / "observations"
STATE = ROOT / "data" / "learning" / "epir-observation-backfill-state.json"
STATION_HISTORY = "https://www.ncei.noaa.gov/pub/data/noaa/isd-history.csv"
GLOBAL_HOURLY = "https://www.ncei.noaa.gov/data/global-hourly/access/{year}/{station_id}.csv"
USER_AGENT = "PrognozaEPIR-ConsensusNCEI/1.0"
ICAO = "EPIR"
EXPECTED_USAF = "121052"
EXPECTED_WBAN = "99999"


def get_text(url: str, retries: int = 6, timeout: int = 180) -> str:
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/csv,text/plain,*/*",
                "Connection": "close",
            })
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                if not raw:
                    raise ValueError("empty response")
                return raw.decode("utf-8-sig", errors="replace")
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code not in {408, 425, 429} and not 500 <= exc.code <= 599:
                raise
        except (urllib.error.URLError, socket.timeout, TimeoutError, ValueError) as exc:
            last = exc
        if attempt + 1 < retries:
            time.sleep(min(25.0, 1.5 * (2 ** attempt)) + random.random())
    raise last


def clean(s):
    return "" if s is None else str(s).strip()


def fnum(v):
    s = clean(v)
    if not s or s.upper() in {"M", "NA", "NAN", "NULL"}:
        return None
    try:
        x = float(s)
        return x if math.isfinite(x) else None
    except Exception:
        return None


def parse_date_arg(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def parse_ncei_time(s: str):
    s = clean(s)
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    except Exception:
        return None


def first_part(raw, idx=0):
    parts = clean(raw).split(",")
    return parts[idx].strip() if idx < len(parts) else ""


def scaled(raw, missing: set[str], scale=10.0, idx=0):
    s = first_part(raw, idx)
    if not s or s in missing:
        return None
    try:
        return float(s) / scale
    except Exception:
        return None


def calc_rh(t_c, td_c):
    if t_c is None or td_c is None:
        return None
    try:
        a, b = 17.625, 243.04
        rh = 100.0 * math.exp((a * td_c) / (b + td_c) - (a * t_c) / (b + t_c))
        return max(0.0, min(100.0, rh))
    except Exception:
        return None


def discover_epir():
    text = get_text(STATION_HISTORY)
    rows = list(csv.DictReader(io.StringIO(text)))
    candidates = []
    for r in rows:
        icao = clean(r.get("ICAO")).upper()
        usaf = clean(r.get("USAF")).zfill(6)
        if icao == ICAO or usaf == EXPECTED_USAF:
            candidates.append(r)
    if not candidates:
        raise RuntimeError("EPIR/USAF 121052 not found in NCEI ISD station history")
    # Prefer exact ICAO + expected USAF. Latest row if metadata has duplicates.
    candidates.sort(key=lambda r: (
        clean(r.get("ICAO")).upper() == ICAO,
        clean(r.get("USAF")).zfill(6) == EXPECTED_USAF,
        clean(r.get("END")),
    ), reverse=True)
    r = candidates[0]
    usaf = clean(r.get("USAF")).zfill(6)
    wban = clean(r.get("WBAN")).zfill(5)
    if usaf != EXPECTED_USAF:
        raise RuntimeError(f"unexpected EPIR USAF: {usaf}")
    station_id = usaf + wban
    return {
        "station_id": station_id,
        "usaf": usaf,
        "wban": wban,
        "icao": clean(r.get("ICAO")).upper(),
        "name": clean(r.get("STATION NAME")),
        "country": clean(r.get("CTRY")),
        "latitude": fnum(r.get("LAT")),
        "longitude": fnum(r.get("LON")),
        "elevation_m": fnum(r.get("ELEV(M)")),
        "begin": clean(r.get("BEGIN")),
        "end": clean(r.get("END")),
    }


def parse_precip_aa1(raw):
    # AA1: period hours, depth (0.1 mm), condition, quality.
    parts = clean(raw).split(",")
    if len(parts) < 2:
        return None, None
    try:
        hours = int(parts[0]) if parts[0] and parts[0] != "99" else None
    except Exception:
        hours = None
    try:
        depth = None if parts[1] in {"", "9999"} else float(parts[1]) / 10.0
    except Exception:
        depth = None
    return hours, depth


def normalize(r: dict, meta: dict):
    valid = parse_ncei_time(r.get("DATE"))
    if not valid:
        return None

    tmp = scaled(r.get("TMP"), {"+9999", "-9999", "9999"})
    dew = scaled(r.get("DEW"), {"+9999", "-9999", "9999"})
    slp = scaled(r.get("SLP"), {"99999"})
    vis = scaled(r.get("VIS"), {"999999"}, scale=1.0)
    cig_m = scaled(r.get("CIG"), {"99999"}, scale=1.0)

    wnd = clean(r.get("WND")).split(",")
    wind_dir = None
    wind_speed = None
    if len(wnd) >= 4:
        try:
            wind_dir = None if wnd[0] in {"", "999"} else float(wnd[0])
        except Exception:
            pass
        try:
            wind_speed = None if wnd[3] in {"", "9999"} else float(wnd[3]) / 10.0
        except Exception:
            pass

    precip_h, precip_mm = parse_precip_aa1(r.get("AA1"))
    lat = fnum(r.get("LATITUDE"))
    lon = fnum(r.get("LONGITUDE"))
    elev = fnum(r.get("ELEVATION"))

    return {
        "schema": "prognozaepir-observation-v1",
        "station": ICAO,
        "ncei_station_id": meta["station_id"],
        "usaf": meta["usaf"],
        "wban": meta["wban"],
        "valid_time": valid,
        "source": "noaa-ncei-global-hourly",
        "report_type": clean(r.get("REPORT_TYPE")) or None,
        "call_sign": clean(r.get("CALL_SIGN")) or None,
        "latitude": lat if lat is not None else meta.get("latitude"),
        "longitude": lon if lon is not None else meta.get("longitude"),
        "elevation_m": elev if elev is not None else meta.get("elevation_m"),
        "temperature_c": tmp,
        "dew_point_c": dew,
        "relative_humidity_pct": calc_rh(tmp, dew),
        "wind_direction_deg": wind_dir,
        "wind_speed_ms": wind_speed,
        "visibility_m": vis,
        "ceiling_m": cig_m,
        "pressure_hpa": slp,
        "precipitation_mm": precip_mm,
        "precipitation_period_h": precip_h,
        "present_weather_manual": clean(r.get("MW1")) or None,
        "present_weather_auto": clean(r.get("AW1")) or None,
        "raw_wnd": clean(r.get("WND")) or None,
        "raw_cig": clean(r.get("CIG")) or None,
        "raw_vis": clean(r.get("VIS")) or None,
        "raw_tmp": clean(r.get("TMP")) or None,
        "raw_dew": clean(r.get("DEW")) or None,
        "raw_slp": clean(r.get("SLP")) or None,
        "raw_aa1": clean(r.get("AA1")) or None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2020-01-01")
    ap.add_argument("--end", default="2026-09-17", help="exclusive UTC date")
    args = ap.parse_args()
    start = parse_date_arg(args.start)
    end = parse_date_arg(args.end)
    if end <= start:
        raise SystemExit("end must be after start")

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    meta = discover_epir()
    print("NCEI station metadata:", json.dumps(meta, ensure_ascii=False))
    if meta["icao"] != ICAO:
        raise SystemExit(f"metadata ICAO mismatch: {meta['icao']}")

    all_rows = []
    per_year = {}
    failures = []
    for year in range(start.year, end.year + 1):
        if date(year + 1, 1, 1) <= start or date(year, 1, 1) >= end:
            continue
        url = GLOBAL_HOURLY.format(year=year, station_id=meta["station_id"])
        try:
            text = get_text(url)
            raw_path = RAW_DIR / f"EPIR-NCEI-{year}.csv"
            raw_path.write_text(text, encoding="utf-8")
            rows = []
            for r in csv.DictReader(io.StringIO(text)):
                n = normalize(r, meta)
                if not n:
                    continue
                t = datetime.fromisoformat(n["valid_time"].replace("Z", "+00:00")).date()
                if start <= t < end:
                    rows.append(n)
            rows.sort(key=lambda x: x["valid_time"])
            out_path = OUT_DIR / f"EPIR-NCEI-{year}.jsonl"
            out_path.write_text("".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in rows), encoding="utf-8")
            all_rows.extend(rows)
            per_year[str(year)] = {
                "rows": len(rows),
                "first": rows[0]["valid_time"] if rows else None,
                "last": rows[-1]["valid_time"] if rows else None,
                "raw_bytes": len(text.encode("utf-8")),
            }
            print(year, per_year[str(year)])
        except Exception as exc:
            failures.append({"year": year, "url": url, "error": f"{type(exc).__name__}: {exc}"})
            print("FAILED", year, failures[-1])

    fields = [
        "temperature_c", "dew_point_c", "relative_humidity_pct", "wind_direction_deg",
        "wind_speed_ms", "visibility_m", "ceiling_m", "pressure_hpa", "precipitation_mm",
        "present_weather_manual", "present_weather_auto"
    ]
    coverage = {k: sum(1 for r in all_rows if r.get(k) is not None) for k in fields}
    coords = sorted({(r.get("latitude"), r.get("longitude")) for r in all_rows if r.get("latitude") is not None})
    state = {
        "schema": "prognozaepir-epir-observation-backfill-v2",
        "generated_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "station": ICAO,
        "source": "NOAA/NCEI Global Hourly (ISD/GHCNh lineage)",
        "station_metadata_source": STATION_HISTORY,
        "station_metadata": meta,
        "period_start": start.isoformat(),
        "period_end_exclusive": end.isoformat(),
        "rows_total": len(all_rows),
        "years": per_year,
        "field_non_null_counts": coverage,
        "coordinates_seen": coords[:20],
        "failures": failures,
    }
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(state, ensure_ascii=False, indent=2))
    if not all_rows:
        raise SystemExit("no EPIR observations acquired from NCEI")


if __name__ == "__main__":
    main()
