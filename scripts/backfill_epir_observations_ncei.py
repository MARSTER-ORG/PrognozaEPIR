#!/usr/bin/env python3
"""Acquire historical EPIR surface observations directly from NOAA/NCEI.

Identity is anchored to NOAA USAF 121052 / WBAN 99999 (INOWROCLAW, PL).
The NCEI station-history row currently has a blank ICAO field, so project alias
EPIR is assigned only after USAF/name/country/location validation.
"""
from __future__ import annotations

import argparse, csv, io, json, math, random, socket, time
import urllib.error, urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "data" / "learning" / "observations" / "raw-ncei"
OUT_DIR = ROOT / "data" / "learning" / "observations"
STATE = ROOT / "data" / "learning" / "epir-observation-backfill-state.json"
STATION_HISTORY = "https://www.ncei.noaa.gov/pub/data/noaa/isd-history.csv"
GLOBAL_HOURLY = "https://www.ncei.noaa.gov/data/global-hourly/access/{year}/{station_id}.csv"
USER_AGENT = "PrognozaEPIR-ConsensusNCEI/1.1"
PROJECT_ICAO = "EPIR"
EXPECTED_USAF = "121052"
EXPECTED_WBAN = "99999"
EXPECTED_NAME = "INOWROCLAW"
EXPECTED_COUNTRY = "PL"
ARP_LAT = 52.828611
ARP_LON = 18.330278


def get_text(url: str, retries: int = 6, timeout: int = 180) -> str:
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/csv,text/plain,*/*", "Connection": "close"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                if not raw:
                    raise ValueError("empty response")
                return raw.decode("utf-8-sig", errors="replace")
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code == 404:
                raise
            if exc.code not in {408, 425, 429} and not 500 <= exc.code <= 599:
                raise
        except (urllib.error.URLError, socket.timeout, TimeoutError, ValueError) as exc:
            last = exc
        if attempt + 1 < retries:
            time.sleep(min(25.0, 1.5 * (2 ** attempt)) + random.random())
    raise last


def clean(v): return "" if v is None else str(v).strip()

def fnum(v):
    s = clean(v)
    if not s or s.upper() in {"M", "NA", "NAN", "NULL"}: return None
    try:
        x = float(s); return x if math.isfinite(x) else None
    except Exception: return None


def parse_day(s): return datetime.strptime(s, "%Y-%m-%d").date()

def parse_time(s):
    try:
        dt = datetime.fromisoformat(clean(s).replace("Z", "+00:00"))
        if dt.tzinfo is None: dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception: return None


def first(raw, idx=0):
    parts = clean(raw).split(",")
    return parts[idx].strip() if idx < len(parts) else ""


def scaled(raw, missing, scale=10.0, idx=0):
    s = first(raw, idx)
    if not s or s in missing: return None
    try: return float(s) / scale
    except Exception: return None


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2-lat1), math.radians(lon2-lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2*r*math.asin(math.sqrt(a))


def discover_epir():
    rows = list(csv.DictReader(io.StringIO(get_text(STATION_HISTORY))))
    candidates = [r for r in rows if clean(r.get("USAF")).zfill(6) == EXPECTED_USAF]
    if not candidates: raise RuntimeError("USAF 121052 not found in NCEI station history")
    candidates.sort(key=lambda r: clean(r.get("END")), reverse=True)
    r = candidates[0]
    usaf, wban = clean(r.get("USAF")).zfill(6), clean(r.get("WBAN")).zfill(5)
    name, country = clean(r.get("STATION NAME")).upper(), clean(r.get("CTRY")).upper()
    lat, lon = fnum(r.get("LAT")), fnum(r.get("LON"))
    if usaf != EXPECTED_USAF or wban != EXPECTED_WBAN: raise RuntimeError(f"unexpected NCEI id {usaf}-{wban}")
    if EXPECTED_NAME not in name or country != EXPECTED_COUNTRY: raise RuntimeError(f"unexpected station identity {name}/{country}")
    if lat is None or lon is None or haversine_km(lat, lon, ARP_LAT, ARP_LON) > 10.0:
        raise RuntimeError(f"NCEI station too far from EPIR ARP: {lat},{lon}")
    return {
        "station_id": usaf + wban, "usaf": usaf, "wban": wban,
        "source_icao": clean(r.get("ICAO")).upper() or None,
        "project_icao": PROJECT_ICAO, "name": clean(r.get("STATION NAME")), "country": country,
        "latitude": lat, "longitude": lon, "elevation_m": fnum(r.get("ELEV(M)")),
        "distance_to_arp_km": round(haversine_km(lat, lon, ARP_LAT, ARP_LON), 3),
        "begin": clean(r.get("BEGIN")), "end": clean(r.get("END")),
        "identity_basis": "NCEI USAF 121052 + WBAN 99999 + INOWROCLAW/PL + <=10 km from official EPIR ARP",
    }


def calc_rh(t, td):
    if t is None or td is None: return None
    a,b=17.625,243.04
    try: return max(0.0, min(100.0, 100.0*math.exp((a*td)/(b+td)-(a*t)/(b+t))))
    except Exception: return None


def parse_precip(raw):
    p = clean(raw).split(",")
    if len(p) < 2: return None, None
    try: hours = None if p[0] in {"", "99"} else int(p[0])
    except Exception: hours = None
    try: depth = None if p[1] in {"", "9999"} else float(p[1])/10.0
    except Exception: depth = None
    return hours, depth


def normalize(r, meta):
    dt = parse_time(r.get("DATE"))
    if not dt: return None
    tmp = scaled(r.get("TMP"), {"+9999","-9999","9999"})
    dew = scaled(r.get("DEW"), {"+9999","-9999","9999"})
    slp = scaled(r.get("SLP"), {"99999"})
    vis = scaled(r.get("VIS"), {"999999"}, 1.0)
    cig = scaled(r.get("CIG"), {"99999"}, 1.0)
    wnd = clean(r.get("WND")).split(",")
    wd = ws = None
    if len(wnd) >= 4:
        try: wd = None if wnd[0] in {"", "999"} else float(wnd[0])
        except Exception: pass
        try: ws = None if wnd[3] in {"", "9999"} else float(wnd[3])/10.0
        except Exception: pass
    ph, pm = parse_precip(r.get("AA1"))
    return {
        "schema":"prognozaepir-observation-v1", "station":PROJECT_ICAO,
        "ncei_station_id":meta["station_id"], "usaf":meta["usaf"], "wban":meta["wban"],
        "valid_time":dt.replace(microsecond=0).isoformat().replace("+00:00","Z"),
        "source":"noaa-ncei-global-hourly", "report_type":clean(r.get("REPORT_TYPE")) or None,
        "call_sign":clean(r.get("CALL_SIGN")) or None,
        "latitude":fnum(r.get("LATITUDE")) if fnum(r.get("LATITUDE")) is not None else meta["latitude"],
        "longitude":fnum(r.get("LONGITUDE")) if fnum(r.get("LONGITUDE")) is not None else meta["longitude"],
        "elevation_m":fnum(r.get("ELEVATION")) if fnum(r.get("ELEVATION")) is not None else meta["elevation_m"],
        "temperature_c":tmp, "dew_point_c":dew, "relative_humidity_pct":calc_rh(tmp,dew),
        "wind_direction_deg":wd, "wind_speed_ms":ws, "visibility_m":vis, "ceiling_m":cig,
        "pressure_hpa":slp, "precipitation_mm":pm, "precipitation_period_h":ph,
        "present_weather_manual":clean(r.get("MW1")) or None, "present_weather_auto":clean(r.get("AW1")) or None,
        "raw_wnd":clean(r.get("WND")) or None, "raw_cig":clean(r.get("CIG")) or None,
        "raw_vis":clean(r.get("VIS")) or None, "raw_tmp":clean(r.get("TMP")) or None,
        "raw_dew":clean(r.get("DEW")) or None, "raw_slp":clean(r.get("SLP")) or None,
        "raw_aa1":clean(r.get("AA1")) or None,
    }


def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--start",default="2020-01-01"); ap.add_argument("--end",default="2026-09-17")
    args=ap.parse_args(); start,end=parse_day(args.start),parse_day(args.end)
    if end<=start: raise SystemExit("end must be after start")
    RAW_DIR.mkdir(parents=True,exist_ok=True); OUT_DIR.mkdir(parents=True,exist_ok=True)
    meta=discover_epir(); print("NCEI station metadata:",json.dumps(meta,ensure_ascii=False))
    all_rows=[]; per_year={}; failures=[]
    for year in range(start.year,end.year+1):
        if date(year+1,1,1)<=start or date(year,1,1)>=end: continue
        url=GLOBAL_HOURLY.format(year=year,station_id=meta["station_id"])
        try:
            text=get_text(url); (RAW_DIR/f"EPIR-NCEI-{year}.csv").write_text(text,encoding="utf-8")
            rows=[]
            for src in csv.DictReader(io.StringIO(text)):
                n=normalize(src,meta)
                if not n: continue
                d=datetime.fromisoformat(n["valid_time"].replace("Z","+00:00")).date()
                if start<=d<end: rows.append(n)
            rows.sort(key=lambda x:x["valid_time"])
            (OUT_DIR/f"EPIR-NCEI-{year}.jsonl").write_text("".join(json.dumps(x,ensure_ascii=False,separators=(",",":"))+"\n" for x in rows),encoding="utf-8")
            all_rows.extend(rows); per_year[str(year)]={"rows":len(rows),"first":rows[0]["valid_time"] if rows else None,"last":rows[-1]["valid_time"] if rows else None,"raw_bytes":len(text.encode("utf-8"))}
            print(year,per_year[str(year)])
        except urllib.error.HTTPError as exc:
            failures.append({"year":year,"url":url,"error":f"HTTPError: {exc.code}"}); print("MISSING",year,failures[-1])
        except Exception as exc:
            failures.append({"year":year,"url":url,"error":f"{type(exc).__name__}: {exc}"}); print("FAILED",year,failures[-1])
    fields=["temperature_c","dew_point_c","relative_humidity_pct","wind_direction_deg","wind_speed_ms","visibility_m","ceiling_m","pressure_hpa","precipitation_mm","present_weather_manual","present_weather_auto"]
    coverage={k:sum(1 for r in all_rows if r.get(k) is not None) for k in fields}
    state={"schema":"prognozaepir-epir-observation-backfill-v3","generated_at_utc":datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00","Z"),"station":PROJECT_ICAO,"source":"NOAA/NCEI Global Hourly","station_metadata_source":STATION_HISTORY,"station_metadata":meta,"period_start":start.isoformat(),"period_end_exclusive":end.isoformat(),"rows_total":len(all_rows),"years":per_year,"field_non_null_counts":coverage,"failures":failures}
    STATE.write_text(json.dumps(state,ensure_ascii=False,indent=2)+"\n",encoding="utf-8"); print(json.dumps(state,ensure_ascii=False,indent=2))
    if not all_rows: raise SystemExit("no EPIR observations acquired from NCEI")

if __name__=="__main__": main()
