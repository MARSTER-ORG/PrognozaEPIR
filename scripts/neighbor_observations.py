#!/usr/bin/env python3
"""Neighbor METAR/SPECI context captured while PilotHub pages are already fetched.

This is intentionally separate from the authoritative EPIR METAR/SPECI history.
It stores contextual observations for EPBY/EPPW/EPKS under data/messages/neighbors
for short-range advection analysis and consensus anchoring.
"""
from __future__ import annotations

import calendar
import hashlib
import html
import json
import math
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("data/messages/neighbors")
LATEST = ROOT / "latest.json"
SOURCE = "PilotHub / IMGW"
NEIGHBORS = {
    "EPBY": {"name": "Bydgoszcz", "lat": 53.0968, "lon": 17.9777},
    "EPPW": {"name": "Powidz", "lat": 52.3792, "lon": 17.8539},
    "EPKS": {"name": "Krzesiny", "lat": 52.3317, "lon": 16.9664},
}
_LOCK = threading.Lock()
_MAX_HISTORY_AGE_H = 12.0
_MAX_FUTURE_H = 1.5
_MAX_RAW_LEN = 512

_WIND_RE = re.compile(r"\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b", re.I)
_VALIDITY_RE = re.compile(r"\b\d{4}/\d{4}\b")
_WX_RE = re.compile(
    r"(?<![A-Z])(?:\+|-)?(?:FZFG|MIFG|BCFG|PRFG|FG|BR|HZ|TSRA|TSGR|TS|SHRA|SHSN|RASN|SNRA|FZRA|FZDZ|RA|DZ|SN|GR|GS|SQ)(?![A-Z])",
    re.I,
)


def _utc_iso(dt: datetime | None = None) -> str:
    dt = dt or datetime.now(timezone.utc)
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _atomic_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _plain(page: str) -> str:
    raw = html.unescape(page or "")
    hydrated = (
        raw.replace(r"\u003c", "<")
        .replace(r"\u003e", ">")
        .replace(r"\u0026", "&")
        .replace(r"\n", " ")
        .replace(r"\r", " ")
        .replace(r"\/", "/")
    )
    hydrated = re.sub(r"<style\b[^>]*>.*?</style>", " ", hydrated, flags=re.I | re.S)
    hydrated = re.sub(r"<[^>]+>", " ", hydrated)
    return re.sub(r"\s+", " ", html.unescape(hydrated)).strip()


def _normalise(raw: str) -> str:
    raw = html.unescape(re.sub(r"<[^>]+>", " ", raw or ""))
    raw = re.sub(r"\s+", " ", raw).strip().strip('"')
    raw = re.sub(r"\s*=\s*$", "=", raw)
    return raw


def _report_time(code: str, now: datetime | None = None) -> datetime | None:
    m = re.fullmatch(r"(\d{2})(\d{2})(\d{2})Z", code or "")
    if not m:
        return None
    day, hour, minute = map(int, m.groups())
    now = now or datetime.now(timezone.utc)
    best = None
    best_delta = float("inf")
    for dm in (-1, 0, 1):
        idx = now.year * 12 + now.month - 1 + dm
        year, month = idx // 12, idx % 12 + 1
        if day > calendar.monthrange(year, month)[1]:
            continue
        try:
            dt = datetime(year, month, day, hour, minute, tzinfo=timezone.utc)
        except ValueError:
            continue
        delta = abs((dt - now).total_seconds())
        if delta < best_delta:
            best, best_delta = dt, delta
    return best


def _temp(token: str | None) -> float | None:
    if not token:
        return None
    try:
        return float((-1 if token.startswith("M") else 1) * int(token.lstrip("M")))
    except Exception:
        return None


def _rh(t: float | None, td: float | None) -> float | None:
    if t is None or td is None:
        return None
    a, b = 17.625, 243.04
    try:
        value = 100 * math.exp(a * td / (b + td) - a * t / (b + t))
        return round(max(0.0, min(100.0, value)), 1)
    except Exception:
        return None


def _visibility(raw: str):
    if re.search(r"\bCAVOK\b", raw, re.I):
        return 10000, True, "CAVOK"
    wind = _WIND_RE.search(raw)
    if not wind:
        return None, None, None
    tail = raw[wind.end():].split()
    for token in tail[:5]:
        if re.fullmatch(r"\d{4}", token):
            value = int(token)
            return (10000, True, "9999") if value == 9999 else (value, False, token)
    return None, None, None


def _canonical(kind: str, raw: str) -> str:
    core = raw.rstrip("=").strip()
    if re.match(r"^(METAR|SPECI)\s+", core, re.I):
        core = re.sub(r"^(METAR|SPECI)\s+", kind + " ", core, count=1, flags=re.I)
    else:
        core = f"{kind} {core}"
    return core + "="


def _parse(raw: str, station: str, source_url: str) -> dict | None:
    raw = _normalise(raw)
    if not raw or len(raw) > _MAX_RAW_LEN or _VALIDITY_RE.search(raw):
        return None
    kind_match = re.match(r"^(METAR|SPECI)\s+", raw, re.I)
    kind = kind_match.group(1).upper() if kind_match else "METAR"
    core = re.sub(r"^(METAR|SPECI)\s+", "", raw, count=1, flags=re.I)
    if not re.match(rf"^(?:COR\s+)?{re.escape(station)}\s+\d{{6}}Z\s+(?:AUTO\s+)?(?:VRB|\d{{3}})\d{{2,3}}(?:G\d{{2,3}})?KT\b", core, re.I):
        return None
    if not re.search(r"\bQ\d{4}\b", core):
        return None

    tm = re.search(rf"\b{re.escape(station)}\s+(\d{{6}}Z)\b", core, re.I)
    dt = _report_time(tm.group(1)) if tm else None
    if not dt:
        return None
    age_h = (datetime.now(timezone.utc) - dt).total_seconds() / 3600.0
    if age_h > _MAX_HISTORY_AGE_H or age_h < -_MAX_FUTURE_H:
        return None

    wind = _WIND_RE.search(core)
    wd = None if not wind or wind.group(1).upper() == "VRB" else int(wind.group(1))
    ws = round(int(wind.group(2)) * 0.514444, 2) if wind else None
    gust = round(int(wind.group(3)) * 0.514444, 2) if wind and wind.group(3) else None
    temp_pair = re.search(r"\b(M?\d{2})/(M?\d{2})\b", core)
    temp = _temp(temp_pair.group(1)) if temp_pair else None
    dew = _temp(temp_pair.group(2)) if temp_pair else None
    pressure = re.search(r"\bQ(\d{4})\b", core)
    visibility, vis_lb, vis_report = _visibility(core)

    clouds = []
    for cover, height, conv in re.findall(r"\b(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?\b", core, re.I):
        ft = int(height) * 100
        clouds.append({
            "cover": cover.upper(),
            "base_ft_agl": ft,
            "base_m_agl": round(ft * 0.3048),
            "type": (conv or "").upper() or None,
        })
    ceiling = next((c["base_m_agl"] for c in clouds if c["cover"] in {"BKN", "OVC", "VV"}), None)
    weather_tokens = [x.upper() for x in _WX_RE.findall(core)]
    weather = " ".join(dict.fromkeys(weather_tokens)) or None

    canonical = _canonical(kind, raw)
    message_id = hashlib.sha256(f"{kind}|{station}|{canonical}".encode("utf-8")).hexdigest()
    return {
        "schema": "prognozaepir-neighbor-observation-v1",
        "type": kind,
        "station": station,
        "message_id": message_id,
        "message_time": _utc_iso(dt),
        "obs_time": _utc_iso(dt),
        "canonical_raw": canonical,
        "raw": core.rstrip("=").strip(),
        "source": SOURCE,
        "source_url": source_url,
        "sources": [{"name": SOURCE, "url": source_url}],
        "temperature_c": temp,
        "dew_point_c": dew,
        "relative_humidity_pct": _rh(temp, dew),
        "visibility_m": visibility,
        "visibility_lower_bound": vis_lb,
        "visibility_report": vis_report,
        "wind_direction_deg": wd,
        "wind_speed_ms": ws,
        "wind_gust_ms": gust,
        "pressure_hpa": int(pressure.group(1)) if pressure else None,
        "weather": weather,
        "fog": bool(weather and re.search(r"(?:^|\s)(?:FZFG|MIFG|BCFG|PRFG|FG)(?:\s|$)", weather)),
        "mist": bool(weather and re.search(r"(?:^|\s)BR(?:\s|$)", weather)),
        "freezing_fog": bool(weather and re.search(r"(?:^|\s)FZFG(?:\s|$)", weather)),
        "clouds": clouds,
        "ceiling_m_agl": ceiling,
    }


def _extract(page: str, station: str, source_url: str) -> list[dict]:
    text = _plain(page)
    pattern = re.compile(
        rf"\b((?:(?:METAR|SPECI)\s+)?(?:COR\s+)?{re.escape(station)}\s+\d{{6}}Z\s+(?:AUTO\s+)?(?:VRB|\d{{3}})\d{{2,3}}(?:G\d{{2,3}})?KT\b.*?\bQ\d{{4}}\b)=?",
        re.I | re.S,
    )
    out = []
    seen = set()
    for match in pattern.finditer(text):
        row = _parse(match.group(1), station, source_url)
        if not row or row["message_id"] in seen:
            continue
        seen.add(row["message_id"])
        out.append(row)
    return out


def _read_jsonl(path: Path) -> list[dict]:
    try:
        rows = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                value = json.loads(line)
                if isinstance(value, dict):
                    rows.append(value)
        return rows
    except Exception:
        return []


def _append_record(row: dict) -> bool:
    dt = datetime.fromisoformat(row["message_time"].replace("Z", "+00:00"))
    path = ROOT / row["station"].lower() / f"{dt:%Y}" / f"{dt:%m}" / f"{dt:%d}.jsonl"
    rows = _read_jsonl(path)
    if any(x.get("message_id") == row["message_id"] for x in rows):
        return False
    rows.append(row)
    rows.sort(key=lambda x: (x.get("message_time") or "", x.get("message_id") or ""))
    _atomic_text(path, "".join(json.dumps(x, ensure_ascii=False, separators=(",", ":")) + "\n" for x in rows))
    return True


def _update_latest(records: list[dict]) -> bool:
    payload = _load_json(LATEST, {})
    if not isinstance(payload, dict):
        payload = {}
    stations = dict(payload.get("stations") or {})
    changed = False
    for row in records:
        sid = row["station"]
        old = stations.get(sid) or {}
        old_time = str(old.get("message_time") or "")
        new_time = str(row.get("message_time") or "")
        if not old or new_time > old_time or (new_time == old_time and old.get("message_id") != row.get("message_id")):
            stations[sid] = row
            changed = True
    if not changed and LATEST.exists():
        return False
    newest = max((str(x.get("message_time") or "") for x in stations.values() if isinstance(x, dict)), default=None)
    meta = {sid: dict(info) for sid, info in NEIGHBORS.items()}
    out = {
        "schema": "prognozaepir-neighbor-observations-latest-v1",
        "scope": "context-only; excluded from EPIR operational archive counts",
        "stations_meta": meta,
        "stations": stations,
        "updated_at": newest,
    }
    _atomic_text(LATEST, json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    return True


def capture_pilothub_page(station: str, page: str, source_url: str) -> dict:
    """Extract and persist neighbor METAR/SPECI from an already-fetched page."""
    station = str(station or "").upper()
    if station not in NEIGHBORS:
        return {"station": station, "decoded": 0, "added": 0, "latest_changed": False}
    records = _extract(page, station, source_url)
    added = 0
    with _LOCK:
        for row in records:
            if _append_record(row):
                added += 1
        latest_changed = _update_latest(records) if records else False
    newest = max((r.get("message_time") or "" for r in records), default=None)
    print(f"Neighbor OBS {station}: decoded={len(records)} added={added} newest={newest or 'none'}")
    return {"station": station, "decoded": len(records), "added": added, "latest_changed": latest_changed, "newest": newest}
