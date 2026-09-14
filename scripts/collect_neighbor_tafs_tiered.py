#!/usr/bin/env python3
"""Low-cost tiered TAF acquisition for the central archive.

Normal path:
  PilotHub/IMGW pages -> current TAFs + neighbour METAR/SPECI context.
Fallbacks are activated only for stations that still lack a current TAF:
  IMGW Aviation API -> IMGW Awiacja -> AWC.

The existing collect_neighbor_tafs module remains the parser/persistence authority;
this module replaces only source scheduling and tightens PilotHub extraction.
"""
from __future__ import annotations

import json
import re
import urllib.parse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

import collect_neighbor_tafs as legacy

_UI_STOP_RE = re.compile(
    r"\b(?:Pokaż\s+zdekodowaną\s+prognozę|Prognoza\s+ważna|Chmury\s+i\s+widoczność|"
    r"Pasy\s+i\s+wiatr|NOTAMy\b|Charty\s+i\s+dokumenty|Ruch\s+w\s+czasie|"
    r"GA\s+widziane|Zdarzenia\s+lotnicze|Źródła\s+danych|Często\s+zadawane\s+pytania)",
    re.I,
)
_TAF_START_RE_TEMPLATE = r"\bTAF(?:\s+(?:AMD|COR))?\s+{station}\b"


def _strict_station_tafs(page: str, station: str) -> list[str]:
    """Extract a station TAF without swallowing decoded page text/NOTAMs."""
    text = legacy.parseable_text(page)
    start_re = re.compile(_TAF_START_RE_TEMPLATE.format(station=re.escape(station)), re.I)
    starts = list(start_re.finditer(text))
    out: list[str] = []
    seen: set[str] = set()

    for idx, match in enumerate(starts):
        start = match.start()
        hard_end = starts[idx + 1].start() if idx + 1 < len(starts) else len(text)
        segment = text[start:hard_end]

        eq = segment.find("=")
        stop = _UI_STOP_RE.search(segment, match.end() - start)
        candidates = []
        if eq >= 0:
            candidates.append(eq + 1)
        if stop:
            candidates.append(stop.start())
        # A valid operational TAF is compact. This final guard prevents a web
        # page redesign from injecting many kilobytes of unrelated text.
        candidates.append(min(len(segment), 1800))
        segment = segment[: min(candidates)].strip()

        raw = legacy.normalize_taf(segment)
        if not raw or len(raw) > 1900:
            continue
        if _UI_STOP_RE.search(raw):
            continue
        if not start_re.search(raw):
            continue
        if raw not in seen:
            seen.add(raw)
            out.append(raw)
    return out


def _add_rows(store: dict[str, list[dict]], rows, source: str, source_url: str, allowed: set[str] | None = None) -> None:
    for sid, raw in rows:
        sid = str(sid or "").upper()
        if allowed is not None and sid not in allowed:
            continue
        legacy.add_candidate(store, sid, raw, source, source_url)


def _missing_current(store: dict[str, list[dict]]) -> set[str]:
    return {
        sid
        for sid in legacy.STATIONS
        if not any(bool(row.get("current")) for row in store.get(sid, []))
    }


def _pilot_worker(station: str, url: str):
    page = legacy.fetch_text(url, "text/html,*/*;q=0.8", retries=1)
    # Reuse the same HTTP response to collect neighbour METAR/SPECI context.
    legacy.neighbor_obs.capture_pilothub_page(station, page, url)
    rows = [(station, raw) for raw in _strict_station_tafs(page, station)]
    return station, url, rows


def _collect_pilothub(store: dict[str, list[dict]]) -> None:
    jobs = [
        (sid, url)
        for sid in legacy.STATIONS
        for url in legacy.PILOTHUB_PAGES.get(sid, ())
    ]
    with ThreadPoolExecutor(max_workers=max(1, min(4, len(jobs)))) as pool:
        future_map = {pool.submit(_pilot_worker, sid, url): (sid, url) for sid, url in jobs}
        for fut in as_completed(future_map):
            sid, url = future_map[fut]
            try:
                _sid, _url, rows = fut.result()
                print(f"TAF primary PilotHub/IMGW {sid}: decoded={len(rows)}")
                _add_rows(store, rows, "PilotHub / IMGW", url)
            except Exception as exc:
                print(f"TAF primary failed {sid} at {url}: {exc}")


def _fallback_imgw_api(store: dict[str, list[dict]], missing: set[str]) -> set[str]:
    if not missing:
        return missing
    try:
        page = legacy.fetch_text(
            legacy.IMGW_API_URL,
            "application/json,text/plain,*/*;q=0.8",
            retries=1,
        )
        rows = legacy.extract_imgw_api_tafs(page)
        _add_rows(store, rows, "IMGW Aviation API", legacy.IMGW_API_URL, missing)
        print(f"TAF fallback IMGW API: decoded={len(rows)} missing_before={sorted(missing)}")
    except Exception as exc:
        print(f"TAF fallback IMGW API failed: {exc}")
    return _missing_current(store)


def _fallback_imgw_page(store: dict[str, list[dict]], missing: set[str]) -> set[str]:
    if not missing:
        return missing

    # First make one combined request. Only if it does not fill every missing
    # station do we try station-scoped Awiacja pages.
    try:
        page = legacy.fetch_text(legacy.IMGW_URL, "text/html,*/*;q=0.8", retries=1)
        rows = legacy.split_tafs(page)
        _add_rows(store, rows, "IMGW Awiacja", legacy.IMGW_URL, missing)
        print(f"TAF fallback IMGW Awiacja combined: decoded={len(rows)}")
    except Exception as exc:
        print(f"TAF fallback IMGW Awiacja combined failed: {exc}")

    missing = _missing_current(store)
    if not missing:
        return missing

    def worker(sid: str):
        url = f"{legacy.IMGW_URL}?aport={urllib.parse.quote(sid)}"
        page = legacy.fetch_text(url, "text/html,*/*;q=0.8", retries=1)
        rows = legacy.split_tafs(page)
        return sid, url, rows

    with ThreadPoolExecutor(max_workers=max(1, len(missing))) as pool:
        future_map = {pool.submit(worker, sid): sid for sid in sorted(missing)}
        for fut in as_completed(future_map):
            sid = future_map[fut]
            try:
                _sid, url, rows = fut.result()
                _add_rows(store, rows, "IMGW Awiacja", legacy.IMGW_URL, {sid})
                print(f"TAF fallback IMGW Awiacja {sid}: decoded={len(rows)}")
            except Exception as exc:
                print(f"TAF fallback IMGW Awiacja {sid} failed: {exc}")
    return _missing_current(store)


def _walk_strings(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if isinstance(child, str) and key.lower() in {"rawtaf", "raw_text", "raw", "taf", "message"}:
                yield child
            else:
                yield from _walk_strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_strings(child)


def _fallback_awc(store: dict[str, list[dict]], missing: set[str]) -> set[str]:
    if not missing:
        return missing
    # Current AWC API documents JSON as a supported TAF format. One batched
    # request is cheaper than four station requests and avoids the old repeated
    # format=raw HTTP 400 failures.
    url = legacy.AWC_BASE + "?" + urllib.parse.urlencode({
        "ids": ",".join(sorted(missing)),
        "format": "json",
    })
    try:
        page = legacy.fetch_text(url, "application/json,text/plain,*/*;q=0.8", retries=1)
        payload = json.loads(page)
        rows: list[tuple[str, str]] = []
        for raw in _walk_strings(payload):
            norm = legacy.normalize_taf(raw)
            for sid in missing:
                if re.search(_TAF_START_RE_TEMPLATE.format(station=re.escape(sid)), norm, re.I):
                    rows.append((sid, norm))
                    break
        _add_rows(store, rows, "AWC", legacy.AWC_BASE, missing)
        print(f"TAF fallback AWC JSON: decoded={len(rows)} missing_before={sorted(missing)}")
    except Exception as exc:
        print(f"TAF fallback AWC failed: {exc}")
    return _missing_current(store)


def collect_candidates() -> dict[str, list[dict]]:
    store: dict[str, list[dict]] = defaultdict(list)

    _collect_pilothub(store)
    missing = _missing_current(store)
    if not missing:
        print("TAF fallback chain: skipped; PilotHub/IMGW supplied all current stations")
        return store

    print(f"TAF fallback chain activated for: {sorted(missing)}")
    missing = _fallback_imgw_api(store, missing)
    missing = _fallback_imgw_page(store, missing)
    missing = _fallback_awc(store, missing)
    if missing:
        print(f"TAF fallback chain exhausted; still missing current: {sorted(missing)}")
    else:
        print("TAF fallback chain completed; all current stations recovered")
    return store


def main() -> int:
    legacy.collect_candidates = collect_candidates
    return legacy.main()


if __name__ == "__main__":
    raise SystemExit(main())
