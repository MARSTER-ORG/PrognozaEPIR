#!/usr/bin/env python3
import json
import math
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ICAO = "EPIR"
SYNOP_ID = "12342"
WIGOS_ID = "0-20000-0-12342"
STATION_LAT = 52.83
STATION_LON = 18.33
OUT = Path("data/observations")
UA = "PrognozaEPIR/1.0 (+https://github.com/MARSTER-ORG/PrognozaEPIR)"
WIS2_COLLECTION = "urn:wmo:md:pl-imgw:surface-based-observations.synop"


def utcnow():
    return datetime.now(timezone.utc)


def iso(dt):
    if not dt:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_dt(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(float(v), timezone.utc)
    s = str(v).strip().replace(" ", "T")
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def fetch_json(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        if getattr(r, "status", 200) == 204:
            return None
        return json.loads(r.read().decode("utf-8"))


def fnum(v):
    try:
        x = float(v)
        return x if math.isfinite(x) else None
    except Exception:
        return None


def rh_from_t_td(t, td):
    if t is None or td is None:
        return None
    a, b = 17.625, 243.04
    rh = 100.0 * math.exp((a * td) / (b + td) - (a * t) / (b + t))
    return max(0.0, min(100.0, rh))


def round_or_none(v, nd=1):
    return round(v, nd) if v is not None and math.isfinite(v) else None


def metar_visibility(raw, api_visib):
    raw = raw or ""
    # International METAR: CAVOK or four-digit metres. 9999 means 10 km or more.
    m = re.search(r"(?:\b(?:\d{3}|VRB)\d{2,3}(?:G\d{2,3})?KT\b)\s+(CAVOK|\d{4})\b", raw)
    if m:
        token = m.group(1)
        if token == "CAVOK" or token == "9999":
            return 10000, True, token
        return int(token), False, token
    if " CAVOK " in f" {raw} ":
        return 10000, True, "CAVOK"

    s = str(api_visib or "").strip()
    if s:
        lower = s.endswith("+")
        try:
            sm = float(s.rstrip("+"))
            metres = int(round(sm * 1609.344))
            return metres, lower, s + "SM"
        except Exception:
            pass
    return None, None, None


def parse_metar():
    q = urllib.parse.urlencode({"ids": ICAO, "format": "json", "hours": 3})
    data = fetch_json("https://aviationweather.gov/api/data/metar?" + q)
    if not isinstance(data, list) or not data:
        return None
    rows = [x for x in data if str(x.get("icaoId", "")).upper() == ICAO]
    if not rows:
        return None
    rows.sort(key=lambda x: fnum(x.get("obsTime")) or 0, reverse=True)
    x = rows[0]
    obs_time = parse_dt(x.get("obsTime")) or parse_dt(x.get("reportTime"))
    raw = x.get("rawOb") or ""
    vis_m, vis_lb, vis_raw = metar_visibility(raw, x.get("visib"))
    temp = fnum(x.get("temp"))
    dewp = fnum(x.get("dewp"))
    wspd_kt = fnum(x.get("wspd"))
    wgst_kt = fnum(x.get("wgst"))
    weather = str(x.get("wxString") or "").strip()
    raw_codes = set(re.findall(r"(?<![A-Z])(FZFG|MIFG|BCFG|PRFG|FG|BR)(?![A-Z])", raw))
    if weather:
        raw_codes.update(re.findall(r"FZFG|MIFG|BCFG|PRFG|FG|BR", weather))
    clouds = []
    for c in x.get("clouds") or []:
        base_ft = fnum(c.get("base"))
        clouds.append({
            "cover": c.get("cover"),
            "base_ft_agl": round_or_none(base_ft, 0),
            "base_m_agl": round_or_none(base_ft * 0.3048, 0) if base_ft is not None else None,
        })
    ceiling = next((c["base_m_agl"] for c in clouds if c.get("cover") in ("BKN", "OVC", "VV") and c.get("base_m_agl") is not None), None)
    return {
        "source": "AWC_METAR",
        "station": ICAO,
        "obs_time": iso(obs_time),
        "receipt_time": iso(parse_dt(x.get("receiptTime"))),
        "temperature_c": round_or_none(temp, 1),
        "dew_point_c": round_or_none(dewp, 1),
        "relative_humidity_pct": round_or_none(rh_from_t_td(temp, dewp), 1),
        "visibility_m": vis_m,
        "visibility_lower_bound": vis_lb,
        "visibility_report": vis_raw,
        "wind_direction_deg": fnum(x.get("wdir")),
        "wind_speed_ms": round_or_none(wspd_kt * 0.514444, 2) if wspd_kt is not None else None,
        "wind_gust_ms": round_or_none(wgst_kt * 0.514444, 2) if wgst_kt is not None else None,
        "pressure_hpa": round_or_none(fnum(x.get("altim")), 1),
        "weather": weather or None,
        "fog": any(c.endswith("FG") for c in raw_codes),
        "mist": "BR" in raw_codes,
        "freezing_fog": "FZFG" in raw_codes,
        "ceiling_m_agl": ceiling,
        "clouds": clouds,
        "raw": raw,
    }


def feature_props(feature):
    p = dict(feature.get("properties") or {})
    for k in ("id", "name", "description", "value", "units", "reportId", "reportTime", "phenomenonTime", "wigos_station_identifier"):
        if k not in p and k in feature:
            p[k] = feature[k]
    return p


def wis2_features():
    now = utcnow()
    start = now - timedelta(hours=8)
    end = now + timedelta(minutes=10)
    coll = urllib.parse.quote(WIS2_COLLECTION, safe="")
    base = f"https://wis2-pilot.imgw.pl/oapi/collections/{coll}/items"
    dt = f"{iso(start)}/{iso(end)}"
    attempts = [
        {"f": "json", "limit": 1000, "datetime": dt, "wigos_station_identifier": WIGOS_ID},
        {"f": "json", "limit": 1000, "datetime": dt, "bbox": f"{STATION_LON-0.04},{STATION_LAT-0.04},{STATION_LON+0.04},{STATION_LAT+0.04}"},
    ]
    last_error = None
    for params in attempts:
        try:
            data = fetch_json(base + "?" + urllib.parse.urlencode(params, safe=",/:"))
            feats = data.get("features", []) if isinstance(data, dict) else []
            selected = []
            for feat in feats:
                p = feature_props(feat)
                if str(p.get("wigos_station_identifier") or "") == WIGOS_ID:
                    selected.append(p)
            if selected:
                return selected
        except Exception as e:
            last_error = e
    if last_error:
        raise last_error
    return []


def norm_name(v):
    return re.sub(r"[^a-z0-9]+", "_", str(v or "").lower()).strip("_")


def choose_param(props, exact=(), contains=()):
    candidates = []
    for p in props:
        name = norm_name(p.get("name"))
        if name in exact or any(s in name for s in contains):
            candidates.append(p)
    return candidates[0] if candidates else None


def param_value(p):
    if not p:
        return None
    return fnum(p.get("value"))


def param_desc(p):
    if not p:
        return None
    d = str(p.get("description") or "").strip()
    return d or None


def convert_pressure(v, units):
    if v is None:
        return None
    u = str(units or "").lower()
    if "pa" in u and "hpa" not in u and v > 2000:
        return v / 100.0
    if v > 2000:
        return v / 100.0
    return v


def parse_synop_wis2():
    feats = wis2_features()
    if not feats:
        return None
    groups = {}
    for p in feats:
        rid = str(p.get("reportId") or "")
        if not rid:
            continue
        groups.setdefault(rid, []).append(p)
    if not groups:
        return None
    def group_time(items):
        times = [parse_dt(p.get("reportTime") or p.get("phenomenonTime")) for p in items]
        times = [t for t in times if t]
        return max(times) if times else datetime(1970,1,1,tzinfo=timezone.utc)
    rid, props = max(groups.items(), key=lambda kv: group_time(kv[1]))
    obs_time = group_time(props)

    t_p = choose_param(props, exact=("air_temperature",), contains=("air_temperature",))
    td_p = choose_param(props, exact=("dew_point_temperature",), contains=("dew_point",))
    rh_p = choose_param(props, exact=("relative_humidity",), contains=("relative_humidity",))
    vis_p = choose_param(props, exact=("horizontal_visibility",), contains=("horizontal_visibility", "visibility"))
    wd_p = choose_param(props, exact=("wind_direction",), contains=("wind_direction",))
    ws_p = choose_param(props, exact=("wind_speed",), contains=("wind_speed",))
    pmsl_p = choose_param(props, contains=("pressure_reduced_to_mean_sea_level", "mean_sea_level_pressure", "sea_level_pressure"))
    p_p = pmsl_p or choose_param(props, exact=("pressure", "station_pressure"), contains=("station_pressure",))
    wx_p = choose_param(props, exact=("present_weather",), contains=("present_weather",))
    cbh_p = choose_param(props, exact=("height_of_base_of_cloud",), contains=("height_of_base_of_cloud", "cloud_base"))
    precip_p = choose_param(props, contains=("precipitation", "total_precipitation", "water_equivalent"))

    temp = param_value(t_p)
    dewp = param_value(td_p)
    rh = param_value(rh_p)
    if rh is None:
        rh = rh_from_t_td(temp, dewp)
    weather_desc = param_desc(wx_p)
    weather_upper = (weather_desc or "").upper()
    pressure = convert_pressure(param_value(p_p), p_p.get("units") if p_p else None)
    return {
        "source": "IMGW_WIS2_SYNOP",
        "station": SYNOP_ID,
        "wigos": WIGOS_ID,
        "report_id": rid,
        "obs_time": iso(obs_time),
        "temperature_c": round_or_none(temp, 1),
        "dew_point_c": round_or_none(dewp, 1),
        "relative_humidity_pct": round_or_none(rh, 1),
        "visibility_m": round_or_none(param_value(vis_p), 0),
        "visibility_lower_bound": False if vis_p else None,
        "wind_direction_deg": round_or_none(param_value(wd_p), 0),
        "wind_speed_ms": round_or_none(param_value(ws_p), 2),
        "pressure_hpa": round_or_none(pressure, 1),
        "precipitation": round_or_none(param_value(precip_p), 2),
        "present_weather": weather_desc,
        "fog": "FOG" in weather_upper,
        "mist": "MIST" in weather_upper,
        "freezing_fog": "FREEZING FOG" in weather_upper,
        "cloud_base_m_agl": round_or_none(param_value(cbh_p), 0),
        "parameter_names": sorted({norm_name(p.get("name")) for p in props if p.get("name")}),
    }


def parse_synop_fallback():
    # Reduced IMGW JSON endpoint. It is a fallback only; it usually lacks exact visibility.
    data = fetch_json("https://danepubliczne.imgw.pl/api/data/synop")
    if not isinstance(data, list):
        return None
    x = next((r for r in data if str(r.get("id_stacji")) == SYNOP_ID), None)
    if not x:
        return None
    dt = parse_dt(f"{x.get('data_pomiaru')}T{int(x.get('godzina_pomiaru') or 0):02d}:00:00+00:00")
    temp = fnum(x.get("temperatura"))
    rh = fnum(x.get("wilgotnosc_wzgledna"))
    return {
        "source": "IMGW_PUBLIC_SYNOP_REDUCED",
        "station": SYNOP_ID,
        "wigos": WIGOS_ID,
        "obs_time": iso(dt),
        "temperature_c": round_or_none(temp, 1),
        "dew_point_c": None,
        "relative_humidity_pct": round_or_none(rh, 1),
        "visibility_m": None,
        "visibility_lower_bound": None,
        "wind_direction_deg": fnum(x.get("kierunek_wiatru")),
        "wind_speed_ms": fnum(x.get("predkosc_wiatru")),
        "pressure_hpa": fnum(x.get("cisnienie")),
        "precipitation": fnum(x.get("suma_opadu")),
        "present_weather": None,
        "fog": False,
        "mist": False,
        "freezing_fog": False,
        "cloud_base_m_agl": None,
        "parameter_names": [],
    }


def parse_synop():
    try:
        x = parse_synop_wis2()
        if x:
            return x
    except Exception as e:
        print("WIS2 SYNOP warning:", e)
    try:
        return parse_synop_fallback()
    except Exception as e:
        print("IMGW reduced SYNOP warning:", e)
        return None


def age_minutes(record, now=None):
    if not record:
        return 10**9
    t = parse_dt(record.get("obs_time"))
    if not t:
        return 10**9
    now = now or utcnow()
    return max(0.0, (now - t).total_seconds() / 60.0)


def newest_value(records, key, max_age_min=150):
    now = utcnow()
    cand = []
    for r in records:
        if not r or r.get(key) is None or age_minutes(r, now) > max_age_min:
            continue
        t = parse_dt(r.get("obs_time"))
        cand.append((t, r.get(key), r.get("source")))
    if not cand:
        return None, None
    cand.sort(reverse=True, key=lambda z: z[0])
    return cand[0][1], cand[0][2]


def fuse(metar, synop):
    now = utcnow()
    records = [r for r in (metar, synop) if r]
    if not records:
        return None
    # Visibility: prefer the exact SYNOP visibility when it is fresh; METAR 9999/CAVOK is only a lower bound.
    vis = None
    vis_source = None
    if synop and synop.get("visibility_m") is not None and age_minutes(synop, now) <= 120:
        vis, vis_source = synop["visibility_m"], synop["source"]
    elif metar and metar.get("visibility_m") is not None and age_minutes(metar, now) <= 120:
        vis, vis_source = metar["visibility_m"], metar["source"]

    T, Tsrc = newest_value(records, "temperature_c")
    Td, Tdsrc = newest_value(records, "dew_point_c")
    RH, RHsrc = newest_value(records, "relative_humidity_pct")
    if RH is None:
        RH = rh_from_t_td(T, Td)
        RHsrc = "derived_T_Td" if RH is not None else None
    wd, wdsrc = newest_value(records, "wind_direction_deg")
    ws, wssrc = newest_value(records, "wind_speed_ms")
    press, psrc = newest_value(records, "pressure_hpa")
    times = [parse_dt(r.get("obs_time")) for r in records]
    times = [t for t in times if t]
    return {
        "obs_time": iso(max(times)) if times else None,
        "temperature_c": round_or_none(T, 1),
        "dew_point_c": round_or_none(Td, 1),
        "relative_humidity_pct": round_or_none(RH, 1),
        "visibility_m": round_or_none(vis, 0),
        "visibility_source": vis_source,
        "wind_direction_deg": round_or_none(wd, 0),
        "wind_speed_ms": round_or_none(ws, 2),
        "pressure_hpa": round_or_none(press, 1),
        "fog": bool((metar and metar.get("fog")) or (synop and synop.get("fog"))),
        "mist": bool((metar and metar.get("mist")) or (synop and synop.get("mist"))),
        "freezing_fog": bool((metar and metar.get("freezing_fog")) or (synop and synop.get("freezing_fog"))),
        "sources": {"temperature": Tsrc, "dew_point": Tdsrc, "rh": RHsrc, "visibility": vis_source, "wind_direction": wdsrc, "wind_speed": wssrc, "pressure": psrc},
    }


def record_key(r):
    return (r.get("source"), r.get("station"), r.get("obs_time"), r.get("report_id") or r.get("raw"))


def append_jsonl(path, record):
    if not record or not record.get("obs_time"):
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    key = record_key(record)
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                old = json.loads(line)
            except Exception:
                continue
            if record_key(old) == key:
                return False
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    return True


def read_recent(source, hours=30):
    cutoff = utcnow() - timedelta(hours=hours)
    out = []
    base = OUT / source
    for p in sorted(base.glob("*.jsonl"))[-3:]:
        for line in p.read_text(encoding="utf-8").splitlines():
            try:
                r = json.loads(line)
            except Exception:
                continue
            t = parse_dt(r.get("obs_time"))
            if t and t >= cutoff:
                out.append(r)
    out.sort(key=lambda r: parse_dt(r.get("obs_time")) or datetime(1970,1,1,tzinfo=timezone.utc))
    return out


def nearest_record(records, t, max_minutes=40):
    best = None
    bd = 10**9
    for r in records:
        rt = parse_dt(r.get("obs_time"))
        if not rt:
            continue
        d = abs((rt - t).total_seconds()) / 60.0
        if d < bd:
            bd, best = d, r
    return best if bd <= max_minutes else None


def build_fused_history(metars, synops):
    points = []
    used_metar = set()
    for s in synops:
        st = parse_dt(s.get("obs_time"))
        if not st:
            continue
        m = nearest_record(metars, st, 40)
        if m:
            used_metar.add(record_key(m))
        z = fuse(m, s)
        if z:
            z["metar_obs_time"] = m.get("obs_time") if m else None
            z["synop_obs_time"] = s.get("obs_time")
            points.append(z)
    for m in metars:
        if record_key(m) in used_metar:
            continue
        z = fuse(m, None)
        if z:
            z["metar_obs_time"] = m.get("obs_time")
            z["synop_obs_time"] = None
            points.append(z)
    points.sort(key=lambda z: parse_dt(z.get("obs_time")) or datetime(1970,1,1,tzinfo=timezone.utc))
    return points[-80:]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    metar = None
    synop = None
    try:
        metar = parse_metar()
    except Exception as e:
        print("METAR warning:", e)
    try:
        synop = parse_synop()
    except Exception as e:
        print("SYNOP warning:", e)

    if not metar and not synop:
        raise SystemExit("No EPIR METAR or SYNOP data available")

    changed = False
    for kind, rec in (("metar", metar), ("synop", synop)):
        if rec and rec.get("obs_time"):
            day = parse_dt(rec["obs_time"]).strftime("%Y-%m-%d")
            changed |= append_jsonl(OUT / kind / f"{day}.jsonl", rec)

    metars = read_recent("metar")
    synops = read_recent("synop")
    history = build_fused_history(metars, synops)
    latest_fused = history[-1] if history else fuse(metar, synop)
    latest = {
        "schema": "epir-observation-latest-v1",
        "station": {"icao": ICAO, "synop": SYNOP_ID, "wigos": WIGOS_ID, "lat": STATION_LAT, "lon": STATION_LON},
        "updated_at": latest_fused.get("obs_time") if latest_fused else (metar or synop).get("obs_time"),
        "metar": metar,
        "synop": synop,
        "fused": latest_fused,
    }
    recent = {
        "schema": "epir-observation-history-v1",
        "station": latest["station"],
        "hours": 30,
        "metar": metars,
        "synop": synops,
        "observations": history,
    }
    latest_text = json.dumps(latest, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    recent_text = json.dumps(recent, ensure_ascii=False, separators=(",", ":")) + "\n"
    for p, text in ((OUT / "latest.json", latest_text), (OUT / "recent.json", recent_text)):
        old = p.read_text(encoding="utf-8") if p.exists() else None
        if old != text:
            p.write_text(text, encoding="utf-8")
            changed = True

    print(json.dumps({
        "changed": changed,
        "metar_time": metar.get("obs_time") if metar else None,
        "synop_time": synop.get("obs_time") if synop else None,
        "synop_visibility_m": synop.get("visibility_m") if synop else None,
        "fused_visibility_m": latest_fused.get("visibility_m") if latest_fused else None,
        "fused_visibility_source": latest_fused.get("visibility_source") if latest_fused else None,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
