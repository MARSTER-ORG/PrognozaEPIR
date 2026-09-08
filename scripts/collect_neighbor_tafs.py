#!/usr/bin/env python3
from __future__ import annotations

import calendar
import html
import json
import re
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

STATIONS = ("EPIR", "EPBY", "EPPW", "EPKS")
OUT = Path("data/taf/neighbors.json")
IMGW_URL = "https://awiacja.imgw.pl/metar-i-taf"
IMGW_API_URL = "https://aviation-api.imgw.pl/data/last?params=taf&format=json&count=4"
AWC_BASE = "https://aviationweather.gov/api/data/taf"
PILOTHUB_PAGES = {
    "EPIR": (
        "https://pilothub.pl/lotniska/epin",
    ),
    "EPBY": (
        "https://pilothub.pl/lotniska/epby",
    ),
    "EPPW": (
        "https://pilothub.pl/lotniska/epfp?lang=en",
    ),
    "EPKS": (
        "https://pilothub.pl/lotniska/epze",
    ),
}
SOURCE_PRIORITY = {
    "IMGW Aviation API": 40,
    "IMGW Awiacja": 30,
    "PilotHub / IMGW": 20,
    "AWC": 10,
}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def with_cache_buster(url: str) -> str:
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}_={int(time.time() * 1000)}"


def fetch_text(url: str, accept: str = "text/plain", retries: int = 1) -> str:
    last: Exception | None = None
    for attempt in range(retries):
        req = urllib.request.Request(
            with_cache_buster(url),
            headers={
                "User-Agent": UA,
                "Accept": accept,
                "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.7",
                "Referer": "https://awiacja.imgw.pl/",
                "Cache-Control": "no-cache, no-store, max-age=0",
                "Pragma": "no-cache",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=8) as r:
                return r.read().decode("utf-8", errors="replace").strip()
        except Exception as exc:
            last = exc
            if attempt + 1 < retries:
                time.sleep(1.2 * (attempt + 1))
    assert last is not None
    raise last


def normalize_taf(raw: str) -> str:
    raw = html.unescape(raw)
    raw = re.sub(r"<[^>]+>", " ", raw)
    raw = re.sub(r"\s+", " ", raw).strip()
    raw = re.sub(r"\s*=\s*$", "=", raw)
    if raw and not raw.endswith("="):
        raw += "="
    return raw


def plain_text(page: str) -> str:
    plain = html.unescape(page)
    plain = re.sub(r"<script\b[^>]*>.*?</script>", " ", plain, flags=re.I | re.S)
    plain = re.sub(r"<style\b[^>]*>.*?</style>", " ", plain, flags=re.I | re.S)
    plain = re.sub(r"<noscript\b[^>]*>.*?</noscript>", " ", plain, flags=re.I | re.S)
    plain = re.sub(r"<[^>]+>", " ", plain)
    return re.sub(r"\s+", " ", plain).strip()


def parseable_text(page: str) -> str:
    raw = html.unescape(page)
    hydrated = (
        raw.replace(r"\u003c", "<")
           .replace(r"\u003e", ">")
           .replace(r"\u0026", "&")
           .replace(r"\n", " ")
           .replace(r"\r", " ")
           .replace(r"\/", "/")
    )
    visible = plain_text(raw)
    embedded = html.unescape(hydrated)
    embedded = re.sub(r"<style\b[^>]*>.*?</style>", " ", embedded, flags=re.I | re.S)
    embedded = re.sub(r"<[^>]+>", " ", embedded)
    embedded = re.sub(r"\s+", " ", embedded).strip()
    return re.sub(r"\s+", " ", f"{visible} {embedded}").strip()


def split_tafs(text: str) -> list[tuple[str, str]]:
    one = parseable_text(text)
    ids = "|".join(map(re.escape, STATIONS))
    pat = re.compile(rf"\bTAF(?:\s+(?:AMD|COR))?\s+({ids})\b", re.I)
    matches = list(pat.finditer(one))
    out: list[tuple[str, str]] = []
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(one)
        raw = normalize_taf(one[m.start():end])
        if "=" in raw:
            raw = raw.split("=", 1)[0].strip() + "="
        if raw:
            out.append((m.group(1).upper(), raw))
    return out


def extract_station_tafs(page: str, station: str) -> list[str]:
    plain = parseable_text(page)
    matches = re.findall(
        rf"\bTAF(?:\s+(?:AMD|COR))?\s+{re.escape(station)}\b.*?(?:=|(?=\bTAF\b)|$)",
        plain,
        flags=re.I | re.S,
    )
    return [normalize_taf(x) for x in matches if x.strip()]


def _walk_message_records(value):
    if isinstance(value, dict):
        if isinstance(value.get("message"), str):
            yield value
        for child in value.values():
            yield from _walk_message_records(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_message_records(child)


def extract_imgw_api_tafs(page: str) -> list[tuple[str, str]]:
    payload = json.loads(page)
    rows: list[tuple[str, str]] = []
    if not isinstance(payload, dict):
        return rows
    for station in STATIONS:
        node = payload.get(station)
        if not isinstance(node, dict):
            continue
        tafs = node.get("tafs")
        for record in _walk_message_records(tafs):
            raw = normalize_taf(record.get("message") or "")
            if re.search(rf"\bTAF(?:\s+(?:AMD|COR))?\s+{re.escape(station)}\b", raw, re.I):
                rows.append((station, raw))
    return rows


def month_shift(year: int, month: int, delta: int) -> tuple[int, int]:
    idx = year * 12 + (month - 1) + delta
    return idx // 12, idx % 12 + 1


def taf_issue_ts(raw: str, now: datetime | None = None) -> float:
    m = re.search(r"\b(\d{2})(\d{2})(\d{2})Z\b", raw)
    if not m:
        return 0.0
    now = now or datetime.now(timezone.utc)
    day, hour, minute = map(int, m.groups())
    best: datetime | None = None
    best_delta = float("inf")
    for dm in (-1, 0, 1):
        year, month = month_shift(now.year, now.month, dm)
        if day > calendar.monthrange(year, month)[1]:
            continue
        try:
            dt = datetime(year, month, day, hour, minute, tzinfo=timezone.utc)
        except ValueError:
            continue
        delta = abs((dt - now).total_seconds())
        if delta < best_delta:
            best, best_delta = dt, delta
    return best.timestamp() if best else 0.0


def is_current(raw: str, now: datetime | None = None) -> bool:
    now = now or datetime.now(timezone.utc)
    ts = taf_issue_ts(raw, now)
    if not ts:
        return False
    age_h = (now.timestamp() - ts) / 3600.0
    return -1.5 <= age_h <= 8.5


def load_existing() -> dict:
    if not OUT.exists():
        return {}
    try:
        return json.loads(OUT.read_text(encoding="utf-8"))
    except Exception:
        return {}


def add_candidate(store: dict[str, list[dict]], station: str, raw: str, source: str, url: str) -> None:
    if station not in STATIONS or not raw:
        return
    raw = normalize_taf(raw)
    if not re.search(rf"\bTAF(?:\s+(?:AMD|COR))?\s+{re.escape(station)}\b", raw, re.I):
        return
    if any(x["raw"] == raw and x["source"] == source and x["source_url"] == url for x in store[station]):
        return
    store[station].append({
        "raw": raw,
        "source": source,
        "source_url": url,
        "issue": taf_issue_ts(raw),
        "current": is_current(raw),
        "priority": SOURCE_PRIORITY.get(source, 0),
    })


def collect_candidates() -> dict[str, list[dict]]:
    store: dict[str, list[dict]] = defaultdict(list)
    jobs: list[tuple[str, str | None, str, str, str]] = []

    # Direct official IMGW Aviation API. This is the same backend used by the
    # client-rendered Awiacja page and does not depend on raw HTML containing TAFs.
    jobs.append(("imgw_api", None, IMGW_API_URL, "IMGW Aviation API", IMGW_API_URL))

    # Official Awiacja page remains an independent fallback. Try station-scoped
    # URLs as well as the combined page to reduce stale cached fragments.
    for url in [f"{IMGW_URL}?aport={sid}" for sid in STATIONS] + [IMGW_URL]:
        jobs.append(("multi", None, url, "IMGW Awiacja", IMGW_URL))

    # AWC independent fallback. Query stations separately: the endpoint may
    # reject a mixed list when one military identifier has no current record.
    for sid in STATIONS:
        url = AWC_BASE + "?" + urllib.parse.urlencode({"ids": sid, "format": "raw"})
        jobs.append(("multi", None, url, "AWC", AWC_BASE))

    # PilotHub exposes IMGW-fed TAFs and often has current military cycles when
    # a direct browser request is blocked by CORS.
    for sid in STATIONS:
        for url in PILOTHUB_PAGES.get(sid, ()):
            jobs.append(("station", sid, url, "PilotHub / IMGW", url))

    def worker(job: tuple[str, str | None, str, str, str]):
        mode, station, url, source, source_url = job
        if mode == "imgw_api":
            page = fetch_text(url, "application/json,text/plain,*/*;q=0.8", retries=2)
            rows = extract_imgw_api_tafs(page)
        else:
            accept = "text/plain,*/*;q=0.8" if source == "AWC" else "text/html,*/*;q=0.8"
            page = fetch_text(url, accept, retries=1)
            if mode == "multi":
                rows = split_tafs(page)
            else:
                assert station is not None
                rows = [(station, raw) for raw in extract_station_tafs(page, station)]
        return source, source_url, url, rows

    # Parallel requests keep the scheduled job fast even when one fallback site
    # is slow or unavailable. Candidate selection happens afterwards.
    with ThreadPoolExecutor(max_workers=12) as pool:
        future_map = {pool.submit(worker, job): job for job in jobs}
        for fut in as_completed(future_map):
            job = future_map[fut]
            try:
                source, source_url, _url, rows = fut.result()
                print(f"TAF source {source}: decoded={len(rows)}")
                for sid, raw in rows:
                    add_candidate(store, sid, raw, source, source_url)
            except Exception as exc:
                print(f"TAF source failed at {job[2]}: {exc}")

    return store


def source_url_rank(station: str, row: dict) -> int:
    if row.get("source") != "PilotHub / IMGW":
        return 0
    pages = PILOTHUB_PAGES.get(station, ())
    try:
        return len(pages) - pages.index(row.get("source_url"))
    except ValueError:
        return 0


def select_best(station: str, rows: list[dict]) -> dict | None:
    if not rows:
        return None
    return max(rows, key=lambda x: (
        bool(x.get("current")),
        float(x.get("issue") or 0),
        int(x.get("priority") or 0),
        source_url_rank(station, x),
        str(x.get("source_url") or ""),
    ))


def main() -> int:
    old = load_existing()
    old_st = old.get("stations") or {}
    candidates = collect_candidates()
    new_st: dict[str, dict] = {}
    changed = False

    for sid in STATIONS:
        best = select_best(sid, candidates.get(sid, []))
        prev = old_st.get(sid) or {}
        if best:
            raw = best["raw"]
            prev_raw = prev.get("raw")
            stamp = prev.get("updated_at") if raw == prev_raw else utcnow_iso()
            new_st[sid] = {
                "available": True,
                "raw": raw,
                "updated_at": stamp,
                "source": best["source"],
                "source_url": best["source_url"],
            }
            changed |= (
                raw != prev_raw
                or prev.get("source") != best["source"]
                or prev.get("source_url") != best["source_url"]
            )
        elif prev.get("raw"):
            # Preserve last successful message during total upstream outage.
            # Its issue time remains old, so the freshness gate detects it.
            new_st[sid] = prev
        else:
            new_st[sid] = {
                "available": False,
                "raw": None,
                "updated_at": None,
                "source": None,
                "source_url": None,
            }

    payload = {
        "schema": "prognozaepir-neighbor-tafs-v3",
        "source": "IMGW Aviation API + IMGW Awiacja + AWC + PilotHub/IMGW; newest-current selection",
        "source_url": IMGW_API_URL,
        "stations": new_st,
        "updated_at": utcnow_iso() if changed or not old.get("updated_at") else old.get("updated_at"),
    }

    comparable_old = {k: old.get(k) for k in ("schema", "source", "source_url", "stations")}
    comparable_new = {k: payload.get(k) for k in ("schema", "source", "source_url", "stations")}
    if old and comparable_old == comparable_new:
        print("TAF cache unchanged")
        return 0

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Updated", OUT)
    for sid in STATIONS:
        row = new_st[sid]
        current = "CURRENT" if row.get("raw") and is_current(row["raw"]) else "STALE"
        print(sid, current, row.get("source"), row.get("raw") or "NIL")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
