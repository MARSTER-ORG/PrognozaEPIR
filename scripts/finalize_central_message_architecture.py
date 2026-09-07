#!/usr/bin/env python3
"""Finalize central bulletin policy and remove legacy TAF acquisition paths.

Policy:
- METAR/SPECI/SYNOP remain historical central streams.
- TAF history is retained only for EPIR, where it is used for verification.
- EPBY/EPPW/EPKS are current context only: one central snapshot, no history.
- taf.html reads operational bulletins through PrognozaEPIRMessageArchive.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "data" / "messages"
TAF_HISTORY = ARCHIVE / "taf"
NEIGHBOR_STAGING = ROOT / "data" / "taf" / "neighbors.json"
NEIGHBOR_SNAPSHOT = ARCHIVE / "taf-neighbors.json"
NEIGHBORS = ("EPBY", "EPPW", "EPKS")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | None) -> str | None:
    if not dt:
        return None
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_dt(value) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value or "").replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return None


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path: Path, value, pretty: bool = True) -> bool:
    text = json.dumps(
        value,
        ensure_ascii=False,
        indent=2 if pretty else None,
        separators=None if pretty else (",", ":"),
        sort_keys=True,
    ) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return True


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def write_jsonl(path: Path, rows: list[dict]) -> None:
    text = "".join(
        json.dumps(row, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"
        for row in rows
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def normalize_raw(raw: str) -> str:
    text = re.sub(r"\s+", " ", str(raw or "")).strip()
    if text and not text.endswith("="):
        text += "="
    return text


def resolve_issue(raw: str, ref: datetime) -> datetime | None:
    m = re.search(r"\b(\d{2})(\d{2})(\d{2})Z\b", raw)
    if not m:
        return None
    day, hour, minute = map(int, m.groups())
    candidates: list[datetime] = []
    for dm in (-1, 0, 1):
        year, month = ref.year, ref.month + dm
        if month < 1:
            year -= 1
            month += 12
        elif month > 12:
            year += 1
            month -= 12
        try:
            candidates.append(datetime(year, month, day, hour, minute, tzinfo=timezone.utc))
        except ValueError:
            pass
    return min(candidates, key=lambda x: abs((x - ref).total_seconds())) if candidates else None


def snapshot_record(station: str, row: dict) -> dict | None:
    raw = normalize_raw(row.get("raw"))
    if not raw or not re.search(rf"\bTAF(?:\s+(?:AMD|COR))?\s+{re.escape(station)}\b", raw, re.I):
        return None
    ref = parse_dt(row.get("updated_at")) or utcnow()
    issue = resolve_issue(raw, ref) or ref
    canonical = raw
    message_id = hashlib.sha256(f"TAF\n{station}\n{canonical}".encode()).hexdigest()
    return {
        "schema": "prognozaepir-message-v1",
        "message_id": message_id,
        "type": "TAF",
        "station": station,
        "message_time": iso(issue),
        "issue_time": iso(issue),
        "canonical_raw": canonical,
        "raw": raw,
        "source": row.get("source") or "NEIGHBOR_TAF_CURRENT",
        "source_url": row.get("source_url"),
        "available": bool(row.get("available", True)),
        "stale": bool(row.get("stale", False)),
        "snapshot_only": True,
        "sources": [{
            "name": row.get("source") or "NEIGHBOR_TAF_CURRENT",
            **({"url": str(row.get("source_url"))} if row.get("source_url") else {}),
        }],
    }


def prune_neighbor_taf_history() -> tuple[int, int]:
    removed = 0
    kept = 0
    if not TAF_HISTORY.exists():
        return removed, kept
    for path in sorted(TAF_HISTORY.rglob("*.jsonl")):
        rows = read_jsonl(path)
        keep = [r for r in rows if str(r.get("station") or "").upper() == "EPIR"]
        removed += len(rows) - len(keep)
        kept += len(keep)
        if keep:
            keep.sort(key=lambda r: (r.get("message_time", ""), r.get("message_id", "")))
            if keep != rows:
                write_jsonl(path, keep)
        elif path.exists():
            path.unlink()
    return removed, kept


def all_epir_tafs() -> list[dict]:
    rows: list[dict] = []
    if TAF_HISTORY.exists():
        for path in sorted(TAF_HISTORY.rglob("*.jsonl")):
            rows.extend(
                r for r in read_jsonl(path)
                if str(r.get("station") or "").upper() == "EPIR"
            )
    return sorted(rows, key=lambda r: (r.get("message_time", ""), r.get("message_id", "")))


def build_neighbor_snapshot() -> dict:
    old = read_json(NEIGHBOR_SNAPSHOT, {})
    staged = read_json(NEIGHBOR_STAGING, {})
    old_stations = old.get("stations") or {}
    staged_stations = staged.get("stations") or {}
    stations: dict[str, dict] = {}
    for station in NEIGHBORS:
        fresh = snapshot_record(station, staged_stations.get(station) or {})
        if fresh:
            stations[station] = fresh
        elif isinstance(old_stations.get(station), dict) and old_stations[station].get("raw"):
            stations[station] = old_stations[station]
    updated = staged.get("updated_at") or old.get("updated_at") or iso(utcnow())
    payload = {
        "schema": "prognozaepir-taf-neighbors-current-v1",
        "archive": "data/messages",
        "history": False,
        "purpose": "current directional context for EPIR generator; not learning data",
        "updated_at": updated,
        "stations": stations,
    }
    write_json(NEIGHBOR_SNAPSHOT, payload)
    return payload


def refresh_views(snapshot: dict) -> None:
    latest_path = ARCHIVE / "latest.json"
    recent_path = ARCHIVE / "recent.json"
    status_path = ARCHIVE / "status.json"
    latest = read_json(latest_path, {})
    recent = read_json(recent_path, {})
    status = read_json(status_path, {})

    epir = all_epir_tafs()
    epir_latest = epir[-1] if epir else None
    cutoff = utcnow() - timedelta(hours=72)
    epir_recent = [r for r in epir if (parse_dt(r.get("message_time")) or datetime.min.replace(tzinfo=timezone.utc)) >= cutoff]

    taf_by_station: dict[str, dict] = {}
    if epir_latest:
        taf_by_station["EPIR"] = epir_latest
    for station, row in (snapshot.get("stations") or {}).items():
        if row.get("raw"):
            taf_by_station[station] = row

    latest["taf"] = epir_latest
    latest["taf_by_station"] = taf_by_station
    latest["taf_neighbors_current"] = snapshot.get("stations") or {}

    candidates = [
        latest.get("aviation"),
        latest.get("synop"),
        epir_latest,
        *((snapshot.get("stations") or {}).values()),
    ]
    times = [r.get("message_time") for r in candidates if isinstance(r, dict) and r.get("message_time")]
    if times:
        latest["updated_at"] = max(times)

    recent["taf"] = epir_recent
    recent["taf_neighbors_current"] = snapshot.get("stations") or {}

    counts = dict(status.get("counts") or {})
    counts["taf"] = len(epir)
    last = dict(status.get("latest") or {})
    last["taf"] = epir_latest.get("message_time") if epir_latest else None
    status["counts"] = counts
    status["latest"] = last
    status["taf_history_scope"] = "EPIR only"
    status["taf_neighbors"] = "current snapshot only; not archived; not learning data"
    if latest.get("updated_at"):
        status["archive_updated_at"] = latest["updated_at"]

    write_json(latest_path, latest)
    write_json(recent_path, recent, pretty=False)
    write_json(status_path, status)


def patch_verifier(text: str) -> str:
    central_const = "const CENTRAL_RAW_BASE='https://raw.githubusercontent.com/MARSTER-ORG/PrognozaEPIR/main/data/messages/';"
    text = re.sub(
        r"\s*const METAR_RAW_BASE='[^']*';\s*const TAF_RAW_BASE='[^']*';",
        "\n  " + central_const,
        text,
        count=1,
    )
    fetch_block = re.compile(
        r"\s*async function fetchMetarDay\(day\)\{.*?\n\s*\}\n\s*async function fetchTafIssueDay\(day\)\{.*?\n\s*\}",
        re.S,
    )
    replacement = r'''
  function centralDayUrls(kind,day){
    const [y,m,d]=day.split('-');
    return [
      `data/messages/${kind}/${y}/${m}/${d}.jsonl?_=${Date.now()}`,
      `${CENTRAL_RAW_BASE}${kind}/${y}/${m}/${d}.jsonl?raw=${Date.now()}`
    ];
  }
  async function fetchMetarDay(day){
    const [metar,speci]=await Promise.all([
      fetchJsonl(centralDayUrls('metar',day)),
      fetchJsonl(centralDayUrls('speci',day))
    ]);
    return [...metar,...speci];
  }
  async function fetchTafIssueDay(day){
    return fetchJsonl(centralDayUrls('taf',day));
  }'''
    text, n = fetch_block.subn(replacement, text, count=1)
    if n != 1:
        raise RuntimeError("TAF verifier history fetch block not found")
    text = text.replace(
        "if(!r||r.station!=='EPIR'||r.kind!=='official'||!r.raw)return null;",
        "if(!r||r.station!=='EPIR'||String(r.type||'').toUpperCase()!=='TAF'||!r.raw)return null;",
    )
    text = text.replace("r.issue_time||r.source_updated_at||0", "r.issue_time||r.message_time||0")
    return text


def clean_taf_html() -> None:
    path = ROOT / "taf.html"
    s = path.read_text(encoding="utf-8")

    native_load = """async function loadObs(){let A=window.PrognozaEPIRMessageArchive;if(!A)throw Error('MessageArchive niedostępne');let a=await Promise.allSettled([A.latest(true),A.recent(true)]);obs=a[0].status==='fulfilled'?a[0].value:null;recent=a[1].status==='fulfilled'?a[1].value:null;neighbors=null;neighborParsed={};let m=obs?.aviation||obs?.metar,s=obs?.synop;$('metar').textContent=m?.raw||'Brak METAR/SPECI';$('synop').textContent=s?.raw||'Brak SYNOP';$('metarMeta').textContent=m?`${m.source||m.sources?.[0]?.name||'ARCHIWUM'} · ${fu(Date.parse(m.obs_time||m.message_time))}`:'';$('synopMeta').textContent=s?`${s.source||s.sources?.[0]?.name||'ARCHIWUM'} · ${fu(Date.parse(s.obs_time||s.message_time))}`:''}\nconst EPIR="""
    acquisition = re.compile(r"async function json\(u\)\{.*?\}const EPIR=", re.S)
    s, n = acquisition.subn(native_load, s, count=1)
    if n != 1 and "async function loadImgwLive" in s:
        raise RuntimeError("legacy TAF acquisition block not removed")

    neighbor_loader = """async function loadNeighborArchive(){let A=window.PrognozaEPIRMessageArchive;if(!A)throw Error('MessageArchive niedostępne');let l=obs||await A.latest(true);neighbors={schema:'prognozaepir-neighbor-tafs-central-v1',source:'CENTRAL_MESSAGE_ARCHIVE',stations:{},updated_at:l?.updated_at||new Date().toISOString()};neighborParsed={};for(const id of Object.keys(NSTA)){let row=l?.taf_by_station?.[id];if(!row?.raw){neighbors.stations[id]={available:false,raw:null,updated_at:null,source:null,source_url:'data/messages/latest.json',stale:true};continue}try{let p=parseTaf(row.raw),age=(Date.now()-p.issue)/36e5,current=age>=-1.5&&age<=10&&p.ve>Date.now()-36e5;neighbors.stations[id]={available:current,raw:row.raw,updated_at:row.message_time||row.issue_time||l?.updated_at||null,source:row.source||row.sources?.[0]?.name||'ARCHIWUM',source_url:'data/messages/latest.json',stale:!current,issue:p.issue};if(current)neighborParsed[id]=p}catch(e){neighbors.stations[id]={available:false,raw:row.raw,updated_at:row.message_time||null,source:row.source||'ARCHIWUM',source_url:'data/messages/latest.json',stale:true,error:e.message}}}return neighbors}function tafAt(p,t){"""
    if "async function loadNeighborArchive" not in s:
        if "function tafAt(p,t){" not in s:
            raise RuntimeError("TAF parser insertion point not found")
        s = s.replace("function tafAt(p,t){", neighbor_loader, 1)

    s = s.replace("TAF IMGW live ", "TAF sąsiednie ")
    s = s.replace(
        "$('st').textContent='IMGW live / SYNOP / modele';$('taf').textContent='Pobieranie świeżych METAR/TAF z IMGW…';await loadObs();await loadImgwLive();",
        "$('st').textContent='archiwum / modele';$('taf').textContent='Odczyt centralnego archiwum…';await loadObs();await loadNeighborArchive();",
    )
    s = s.replace(
        "Generator po kliknięciu „Odśwież i generuj” odczytuje METAR/SPECI, SYNOP i TAF wyłącznie z centralnego archiwum depesz,",
        "Generator po kliknięciu „Odśwież i generuj” odczytuje METAR/SPECI, SYNOP i bieżące TAF wyłącznie przez MessageArchive z centralnego archiwum depesz,",
    )

    # The inline TAF verifier must also use the central historical streams.
    marker = "/* TAF Verification v2.0 inline"
    if marker in s:
        head, tail = s.split(marker, 1)
        tail = patch_verifier(tail)
        s = head + marker + tail

    primary = s.split(marker, 1)[0]
    forbidden = (
        "async function json(",
        "plainHtml(",
        "latestStationReport(",
        "decodeMetarLive(",
        "loadImgwLive(",
        "awiacja.imgw.pl",
        "aviationweather.gov",
        "/api/taf-proxy",
    )
    bad = [x for x in forbidden if x in primary]
    if bad:
        raise RuntimeError("legacy acquisition remains in taf.html: " + ", ".join(bad))
    if "PrognozaEPIRMessageArchive" not in primary or "loadNeighborArchive" not in primary:
        raise RuntimeError("taf.html is not using MessageArchive natively")

    path.write_text(s, encoding="utf-8")


def patch_verifier_file() -> None:
    path = ROOT / "taf-verification.js"
    if not path.exists():
        return
    s = patch_verifier(path.read_text(encoding="utf-8"))
    path.write_text(s, encoding="utf-8")


def main() -> int:
    removed, kept = prune_neighbor_taf_history()
    snapshot = build_neighbor_snapshot()
    refresh_views(snapshot)
    clean_taf_html()
    patch_verifier_file()
    print(json.dumps({
        "taf_history_epir": kept,
        "neighbor_taf_history_removed": removed,
        "neighbor_snapshot_stations": sorted((snapshot.get("stations") or {}).keys()),
        "taf_html_native_message_archive": True,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
