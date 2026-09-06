#!/usr/bin/env python3
import csv
import html
import io
import json
import math
import re
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ICAO = "EPIR"
SYNOP_ID = "12342"
STATION_LAT = 52.83
STATION_LON = 18.33
OUT = Path("data/observations")
UA = "Mozilla/5.0 (compatible; PrognozaEPIR/1.0; +https://github.com/MARSTER-ORG/PrognozaEPIR)"


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


def fetch_text(url, timeout=30):
    req = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "text/plain,text/csv,text/html,application/json;q=0.9,*/*;q=0.5"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")


def fetch_json(url, timeout=30):
    return json.loads(fetch_text(url, timeout=timeout))


def fnum(v):
    try:
        x = float(v)
        return x if math.isfinite(x) else None
    except Exception:
        return None


def round_or_none(v, nd=1):
    return round(v, nd) if v is not None and math.isfinite(v) else None


def rh_from_t_td(t, td):
    if t is None or td is None:
        return None
    a, b = 17.625, 243.04
    rh = 100.0 * math.exp((a * td) / (b + td) - (a * t) / (b + t))
    return max(0.0, min(100.0, rh))


def parse_signed_tenths(group):
    if not group or len(group) != 5 or group[1] not in "01" or not group[2:].isdigit():
        return None
    v = int(group[2:]) / 10.0
    return -v if group[1] == "1" else v


def synop_pressure(group):
    if not group or len(group) != 5 or not group[1:].isdigit():
        return None
    v = int(group[1:]) / 10.0
    if v < 500:
        v += 1000.0
    return v


def synop_visibility(vv):
    """Decode WMO code table 4377 to metres.
    Returns (nominal metres, lower_bound, upper_bound, text).
    """
    try:
        c = int(vv)
    except Exception:
        return None, None, None, None
    if c == 0:
        return 50, False, True, "<100 m"
    if 1 <= c <= 50:
        return c * 100, False, False, f"{c * 100} m"
    if 51 <= c <= 55:
        return None, None, None, "kod niewykorzystywany"
    if 56 <= c <= 80:
        m = (c - 50) * 1000
        return m, False, False, f"{m} m"
    if 81 <= c <= 88:
        m = (c - 74) * 5000
        return m, False, False, f"{m} m"
    if c == 89:
        return 70000, True, False, ">70000 m"
    special = {
        90: (50, False, True, "<50 m"),
        91: (50, False, False, "50 m"),
        92: (200, False, False, "200 m"),
        93: (500, False, False, "500 m"),
        94: (1000, False, False, "1000 m"),
        95: (2000, False, False, "2000 m"),
        96: (4000, False, False, "4000 m"),
        97: (10000, False, False, "10000 m"),
        98: (20000, False, False, "20000 m"),
        99: (50000, True, False, "≥50000 m"),
    }
    return special.get(c, (None, None, None, None))


def synop_cloud_base(h):
    # WMO h code, returned as a representative AGL value for fog diagnostics.
    return {
        "0": 25, "1": 75, "2": 150, "3": 250, "4": 450,
        "5": 800, "6": 1250, "7": 1750, "8": 2250, "9": 3000,
    }.get(h)


def infer_weather(ww):
    if ww is None:
        return False, False, False, None
    try:
        w = int(ww)
    except Exception:
        return False, False, False, None
    fog = 40 <= w <= 49
    mist = w == 10
    freezing = w in (48, 49)
    if fog:
        desc = f"fog (ww={w:02d})"
    elif mist:
        desc = "mist (ww=10)"
    else:
        desc = f"ww={w:02d}"
    return fog, mist, freezing, desc


def parse_metar_time_from_raw(raw, fallback=None):
    m = re.search(r"\b(\d{2})(\d{2})(\d{2})Z\b", raw or "")
    if not m:
        return fallback
    day, hour, minute = map(int, m.groups())
    now = fallback or utcnow()
    candidates = []
    for shift in (-1, 0, 1):
        y, mo = now.year, now.month + shift
        while mo < 1:
            y -= 1; mo += 12
        while mo > 12:
            y += 1; mo -= 12
        try:
            candidates.append(datetime(y, mo, day, hour, minute, tzinfo=timezone.utc))
        except ValueError:
            pass
    return min(candidates, key=lambda d: abs((d - now).total_seconds())) if candidates else fallback


def metar_visibility(raw):
    raw = raw or ""
    if re.search(r"\bCAVOK\b", raw):
        return 10000, True, False, "CAVOK"
    # In European METAR a 4-digit prevailing visibility follows the wind/variation groups.
    tokens = raw.split()
    for i, tok in enumerate(tokens):
        if re.fullmatch(r"(?:\d{3}|VRB)\d{2,3}(?:G\d{2,3})?KT", tok):
            for z in tokens[i + 1:i + 4]:
                if re.fullmatch(r"\d{4}", z):
                    v = int(z)
                    if v == 9999:
                        return 10000, True, False, "9999"
                    return v, False, False, z
    return None, None, None, None


def decode_metar(raw, obs_time=None, source="OGIMET_METAR"):
    raw = html.unescape(re.sub(r"\s+", " ", raw or "")).strip().strip('"')
    raw = re.sub(r"^METAR\s*=\s*", "", raw, flags=re.I)
    raw = re.sub(r"^(METAR|SPECI)\s+", "", raw, flags=re.I)
    if not re.search(r"\bEPIR\b", raw):
        return None
    if re.search(r"\bNIL\b", raw):
        return None
    obs_time = parse_metar_time_from_raw(raw, obs_time)
    vis, vis_lb, vis_ub, vis_report = metar_visibility(raw)

    wind = re.search(r"\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b", raw)
    wd = None if not wind or wind.group(1) == "VRB" else int(wind.group(1))
    ws = int(wind.group(2)) * 0.514444 if wind else None
    gust = int(wind.group(3)) * 0.514444 if wind and wind.group(3) else None

    tt = re.search(r"\b(M?\d{2})/(M?\d{2})\b", raw)
    def metar_temp(s):
        if not s: return None
        return -int(s[1:]) if s.startswith("M") else int(s)
    temp = metar_temp(tt.group(1)) if tt else None
    dewp = metar_temp(tt.group(2)) if tt else None

    q = re.search(r"\bQ(\d{4})\b", raw)
    pressure = int(q.group(1)) if q else None
    codes = set(re.findall(r"(?<![A-Z])(FZFG|MIFG|BCFG|PRFG|FG|BR)(?![A-Z])", raw))

    clouds = []
    for cover, base_hundreds in re.findall(r"\b(FEW|SCT|BKN|OVC|VV)(\d{3})\b", raw):
        ft = int(base_hundreds) * 100
        clouds.append({"cover": cover, "base_ft_agl": ft, "base_m_agl": round(ft * 0.3048)})
    ceiling = next((c["base_m_agl"] for c in clouds if c["cover"] in ("BKN", "OVC", "VV")), None)

    return {
        "source": source,
        "station": ICAO,
        "obs_time": iso(obs_time),
        "temperature_c": round_or_none(temp, 1),
        "dew_point_c": round_or_none(dewp, 1),
        "relative_humidity_pct": round_or_none(rh_from_t_td(temp, dewp), 1),
        "visibility_m": vis,
        "visibility_lower_bound": vis_lb,
        "visibility_upper_bound": vis_ub,
        "visibility_report": vis_report,
        "wind_direction_deg": wd,
        "wind_speed_ms": round_or_none(ws, 2),
        "wind_gust_ms": round_or_none(gust, 2),
        "pressure_hpa": pressure,
        "weather": " ".join(sorted(codes)) or None,
        "fog": any(c.endswith("FG") for c in codes),
        "mist": "BR" in codes,
        "freezing_fog": "FZFG" in codes,
        "ceiling_m_agl": ceiling,
        "clouds": clouds,
        "raw": raw,
    }


def csv_reports(text, station):
    out = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 7 or row[0].strip().upper() != station.upper():
            continue
        try:
            dt = datetime(int(row[1]), int(row[2]), int(row[3]), int(row[4]), int(row[5]), tzinfo=timezone.utc)
        except Exception:
            continue
        out.append((dt, ",".join(row[6:]).strip()))
    out.sort(key=lambda x: x[0], reverse=True)
    return out


def ogimet_url(kind, station, hours=8):
    end = utcnow() + timedelta(minutes=5)
    begin = end - timedelta(hours=hours)
    base = "https://www.ogimet.com/cgi-bin/getmetar" if kind == "metar" else "https://www.ogimet.com/cgi-bin/getsynop"
    key = "icao" if kind == "metar" else "block"
    q = urllib.parse.urlencode({
        key: station,
        "begin": begin.strftime("%Y%m%d%H%M"),
        "end": end.strftime("%Y%m%d%H%M"),
        "header": "yes",
        "lang": "eng",
    })
    return base + "?" + q


def parse_metar_ogimet():
    text = fetch_text(ogimet_url("metar", ICAO, 6))
    for dt, raw in csv_reports(text, ICAO):
        r = decode_metar(raw, dt, "OGIMET_METAR")
        if r:
            return r
    return None


def parse_metar_czad():
    text = fetch_text("https://metar.czad.org/")
    m = re.search(r"METAR\s*=\s*(EPIR\s+[^<\r\n]+)", text, re.I)
    if not m:
        # Plain-text extraction can contain tags between label and report.
        stripped = re.sub(r"<[^>]+>", " ", text)
        stripped = html.unescape(stripped)
        m = re.search(r"METAR\s*=\s*(EPIR\s+[^\r\n]+)", stripped, re.I)
    return decode_metar(m.group(1), None, "METAR_CZAD") if m else None


def parse_metar_imgw():
    # Official aviation site is attempted first when its public HTML includes the report.
    text = fetch_text("https://awiacja.imgw.pl/metar-i-taf")
    stripped = html.unescape(re.sub(r"<[^>]+>", " ", text))
    m = re.search(r"(?:METAR\s+)?(EPIR\s+\d{6}Z\s+.*?)(?=\s*=|\s+TAF\b|\s+EP[A-Z]{2}\s+\d{6}Z|$)", stripped, re.I | re.S)
    if not m:
        return None
    raw = re.sub(r"\s+", " ", m.group(1)).strip()
    # Keep only one report if the page text after EPIR contains unrelated content.
    q = re.search(r"\bQ\d{4}\b", raw)
    if q:
        raw = raw[:q.end()]
    return decode_metar(raw, None, "IMGW_AVIATION_METAR")


def parse_metar():
    errors = []
    for fn in (parse_metar_imgw, parse_metar_ogimet, parse_metar_czad):
        try:
            r = fn()
            if r:
                return r
        except Exception as e:
            errors.append(f"{fn.__name__}: {e}")
    if errors:
        print("METAR source warnings:", " | ".join(errors))
    return None


def decode_synop(raw, obs_time):
    raw = re.sub(r"\s+", " ", (raw or "").strip().strip('"'))
    raw = re.sub(r"^SYNOP\s*=\s*", "", raw, flags=re.I)
    if "NIL" in raw.upper():
        return None
    tokens = raw.split()
    try:
        si = tokens.index(SYNOP_ID)
    except ValueError:
        return None
    before = tokens[:si]
    after = tokens[si + 1:]
    if not after:
        return None

    iw = None
    for tok in reversed(before):
        if re.fullmatch(r"\d{5}", tok):
            iw = int(tok[-1]); break

    g0 = after[0] if len(after) > 0 and re.fullmatch(r"[0-9/]{5}", after[0]) else None
    g1 = after[1] if len(after) > 1 and re.fullmatch(r"[0-9/]{5}", after[1]) else None
    visibility = (None, None, None, None)
    cloud_base = None
    if g0:
        visibility = synop_visibility(g0[-2:])
        cloud_base = synop_cloud_base(g0[2])

    wd = ws = None
    total_cloud_oktas = None
    if g1:
        total_cloud_oktas = int(g1[0]) if g1[0].isdigit() and int(g1[0]) <= 8 else None
        if g1[1:3].isdigit():
            dd = int(g1[1:3])
            wd = None if dd == 99 else dd * 10
        if g1[3:5].isdigit():
            ff = int(g1[3:5])
            if iw in (3, 4):
                ws = ff * 0.514444
            else:
                ws = float(ff)

    temp = dewp = station_p = mslp = None
    ww = None
    precip_groups = []
    section = 1
    for tok in after[2:]:
        if tok == "333":
            section = 3; continue
        if tok in ("222", "444", "555"):
            section = int(tok[0]); continue
        if not re.fullmatch(r"[0-9/]{5}", tok):
            continue
        if section != 1:
            continue
        if tok.startswith("1") and temp is None:
            temp = parse_signed_tenths(tok)
        elif tok.startswith("2") and dewp is None:
            dewp = parse_signed_tenths(tok)
        elif tok.startswith("3") and station_p is None:
            station_p = synop_pressure(tok)
        elif tok.startswith("4") and mslp is None:
            mslp = synop_pressure(tok)
        elif tok.startswith("6"):
            precip_groups.append(tok)
        elif tok.startswith("7") and tok[1:3].isdigit() and ww is None:
            ww = int(tok[1:3])

    fog, mist, freezing, weather_desc = infer_weather(ww)
    vis_m, vis_lb, vis_ub, vis_report = visibility
    return {
        "source": "OGIMET_SYNOP_RAW",
        "station": SYNOP_ID,
        "obs_time": iso(obs_time),
        "temperature_c": round_or_none(temp, 1),
        "dew_point_c": round_or_none(dewp, 1),
        "relative_humidity_pct": round_or_none(rh_from_t_td(temp, dewp), 1),
        "visibility_m": vis_m,
        "visibility_lower_bound": vis_lb,
        "visibility_upper_bound": vis_ub,
        "visibility_report": vis_report,
        "visibility_code_vv": g0[-2:] if g0 else None,
        "wind_direction_deg": wd,
        "wind_speed_ms": round_or_none(ws, 2),
        "pressure_hpa": round_or_none(mslp if mslp is not None else station_p, 1),
        "station_pressure_hpa": round_or_none(station_p, 1),
        "present_weather_code": ww,
        "present_weather": weather_desc,
        "fog": fog,
        "mist": mist,
        "freezing_fog": freezing,
        "cloud_base_m_agl": cloud_base,
        "total_cloud_oktas": total_cloud_oktas,
        "raw": raw,
    }


def parse_synop_ogimet():
    text = fetch_text(ogimet_url("synop", SYNOP_ID, 10))
    for dt, raw in csv_reports(text, SYNOP_ID):
        r = decode_synop(raw, dt)
        if r:
            return r
    return None


def parse_synop_imgw_reduced():
    # Backup source. This public endpoint can omit non-core stations and has no exact visibility.
    data = fetch_json("https://danepubliczne.imgw.pl/api/data/synop")
    if not isinstance(data, list):
        return None
    x = next((r for r in data if str(r.get("id_stacji")) == SYNOP_ID), None)
    if not x:
        return None
    dt = parse_dt(f"{x.get('data_pomiaru')}T{int(x.get('godzina_pomiaru') or 0):02d}:00:00+00:00")
    return {
        "source": "IMGW_PUBLIC_SYNOP_REDUCED",
        "station": SYNOP_ID,
        "obs_time": iso(dt),
        "temperature_c": fnum(x.get("temperatura")),
        "dew_point_c": None,
        "relative_humidity_pct": fnum(x.get("wilgotnosc_wzgledna")),
        "visibility_m": None,
        "visibility_lower_bound": None,
        "visibility_upper_bound": None,
        "visibility_report": None,
        "visibility_code_vv": None,
        "wind_direction_deg": fnum(x.get("kierunek_wiatru")),
        "wind_speed_ms": fnum(x.get("predkosc_wiatru")),
        "pressure_hpa": fnum(x.get("cisnienie")),
        "station_pressure_hpa": None,
        "present_weather_code": None,
        "present_weather": None,
        "fog": False,
        "mist": False,
        "freezing_fog": False,
        "cloud_base_m_agl": None,
        "total_cloud_oktas": None,
        "raw": None,
    }


def parse_synop():
    errors = []
    for fn in (parse_synop_ogimet, parse_synop_imgw_reduced):
        try:
            r = fn()
            if r:
                return r
        except Exception as e:
            errors.append(f"{fn.__name__}: {e}")
    if errors:
        print("SYNOP source warnings:", " | ".join(errors))
    return None


def age_minutes(record, now=None):
    if not record:
        return 10**9
    t = parse_dt(record.get("obs_time"))
    if not t:
        return 10**9
    return max(0.0, ((now or utcnow()) - t).total_seconds() / 60.0)


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

    # Exact/finer SYNOP visibility has priority whenever it is fresh. A METAR 9999/CAVOK is only >=10 km.
    vis = vis_source = None
    vis_lower = vis_upper = None
    if synop and synop.get("visibility_m") is not None and age_minutes(synop, now) <= 130:
        vis = synop["visibility_m"]
        vis_source = synop["source"]
        vis_lower = synop.get("visibility_lower_bound")
        vis_upper = synop.get("visibility_upper_bound")
    elif metar and metar.get("visibility_m") is not None and age_minutes(metar, now) <= 100:
        vis = metar["visibility_m"]
        vis_source = metar["source"]
        vis_lower = metar.get("visibility_lower_bound")
        vis_upper = metar.get("visibility_upper_bound")

    T, Tsrc = newest_value(records, "temperature_c")
    Td, Tdsrc = newest_value(records, "dew_point_c")
    RH, RHsrc = newest_value(records, "relative_humidity_pct")
    if RH is None:
        RH = rh_from_t_td(T, Td)
        RHsrc = "derived_T_Td" if RH is not None else None
    wd, wdsrc = newest_value(records, "wind_direction_deg")
    ws, wssrc = newest_value(records, "wind_speed_ms")
    press, psrc = newest_value(records, "pressure_hpa")
    cbh, cbhsrc = newest_value(records, "cloud_base_m_agl")
    if cbh is None:
        cbh, cbhsrc = newest_value(records, "ceiling_m_agl")
    times = [parse_dt(r.get("obs_time")) for r in records]
    times = [t for t in times if t]
    return {
        "obs_time": iso(max(times)) if times else None,
        "temperature_c": round_or_none(T, 1),
        "dew_point_c": round_or_none(Td, 1),
        "relative_humidity_pct": round_or_none(RH, 1),
        "visibility_m": round_or_none(vis, 0),
        "visibility_lower_bound": vis_lower,
        "visibility_upper_bound": vis_upper,
        "visibility_source": vis_source,
        "wind_direction_deg": round_or_none(wd, 0),
        "wind_speed_ms": round_or_none(ws, 2),
        "pressure_hpa": round_or_none(press, 1),
        "cloud_base_m_agl": round_or_none(cbh, 0),
        "fog": bool((metar and metar.get("fog")) or (synop and synop.get("fog"))),
        "mist": bool((metar and metar.get("mist")) or (synop and synop.get("mist"))),
        "freezing_fog": bool((metar and metar.get("freezing_fog")) or (synop and synop.get("freezing_fog"))),
        "sources": {
            "temperature": Tsrc, "dew_point": Tdsrc, "rh": RHsrc,
            "visibility": vis_source, "wind_direction": wdsrc,
            "wind_speed": wssrc, "pressure": psrc, "cloud_base": cbhsrc,
        },
    }


def record_key(r):
    return (r.get("source"), r.get("station"), r.get("obs_time"), r.get("raw") or r.get("visibility_report"))


def append_jsonl(path, record):
    if not record or not record.get("obs_time"):
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    key = record_key(record)
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                if record_key(json.loads(line)) == key:
                    return False
            except Exception:
                pass
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    return True


def read_recent(source, hours=30):
    cutoff = utcnow() - timedelta(hours=hours)
    rows = []
    base = OUT / source
    for p in sorted(base.glob("*.jsonl"))[-3:]:
        for line in p.read_text(encoding="utf-8").splitlines():
            try:
                r = json.loads(line)
                t = parse_dt(r.get("obs_time"))
                if t and t >= cutoff:
                    rows.append(r)
            except Exception:
                pass
    rows.sort(key=lambda r: parse_dt(r.get("obs_time")) or datetime(1970, 1, 1, tzinfo=timezone.utc))
    return rows


def nearest_record(records, t, max_minutes=40):
    best, bd = None, 10**9
    for r in records:
        rt = parse_dt(r.get("obs_time"))
        if not rt:
            continue
        d = abs((rt - t).total_seconds()) / 60.0
        if d < bd:
            bd, best = d, r
    return best if bd <= max_minutes else None


def build_fused_history(metars, synops):
    points, used_metar = [], set()
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
    points.sort(key=lambda z: parse_dt(z.get("obs_time")) or datetime(1970, 1, 1, tzinfo=timezone.utc))
    return points[-100:]


def write_if_changed(path, text):
    old = path.read_text(encoding="utf-8") if path.exists() else None
    if old == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return True


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    metar, synop = parse_metar(), parse_synop()
    if not metar and not synop:
        raise SystemExit("No EPIR METAR or SYNOP 12342 data available from any source")

    changed = False
    for kind, rec in (("metar", metar), ("synop", synop)):
        if rec and rec.get("obs_time"):
            day = parse_dt(rec["obs_time"]).strftime("%Y-%m-%d")
            changed |= append_jsonl(OUT / kind / f"{day}.jsonl", rec)

    metars = read_recent("metar")
    synops = read_recent("synop")
    history = build_fused_history(metars, synops)
    latest_fused = history[-1] if history else fuse(metar, synop)
    station = {"icao": ICAO, "synop": SYNOP_ID, "lat": STATION_LAT, "lon": STATION_LON}
    latest = {
        "schema": "epir-observation-latest-v2",
        "station": station,
        "updated_at": latest_fused.get("obs_time") if latest_fused else (metar or synop).get("obs_time"),
        "collected_at": iso(utcnow()),
        "metar": metar,
        "synop": synop,
        "fused": latest_fused,
    }
    recent = {
        "schema": "epir-observation-history-v2",
        "station": station,
        "hours": 30,
        "metar": metars,
        "synop": synops,
        "observations": history,
    }
    changed |= write_if_changed(OUT / "latest.json", json.dumps(latest, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    changed |= write_if_changed(OUT / "recent.json", json.dumps(recent, ensure_ascii=False, separators=(",", ":")) + "\n")

    print(json.dumps({
        "changed": changed,
        "metar_source": metar.get("source") if metar else None,
        "metar_time": metar.get("obs_time") if metar else None,
        "metar_raw": metar.get("raw") if metar else None,
        "synop_source": synop.get("source") if synop else None,
        "synop_time": synop.get("obs_time") if synop else None,
        "synop_raw": synop.get("raw") if synop else None,
        "synop_visibility_m": synop.get("visibility_m") if synop else None,
        "fused_visibility_m": latest_fused.get("visibility_m") if latest_fused else None,
        "fused_visibility_source": latest_fused.get("visibility_source") if latest_fused else None,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
